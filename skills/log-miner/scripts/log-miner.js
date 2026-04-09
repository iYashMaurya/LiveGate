import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import axios from 'axios';
import 'dotenv/config';

// ─── Shared helpers ──────────────────────────────────────────

const NGINX_REGEX = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) \S+" (\d+)/;
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const LONG_ID_REGEX = /\b\d{10,}\b/g;

function anonymize(str) {
  return str
    .replace(EMAIL_REGEX, 'user@example.com')
    .replace(LONG_ID_REGEX, '<ID_REDACTED>');
}

function parseQueryParams(pathWithQuery) {
  const qIndex = pathWithQuery.indexOf('?');
  if (qIndex === -1) return { path: pathWithQuery, params: {} };
  const path = pathWithQuery.substring(0, qIndex);
  const params = {};
  const searchParams = new URLSearchParams(pathWithQuery.substring(qIndex + 1));
  for (const [key, value] of searchParams) {
    params[anonymize(key)] = anonymize(value);
  }
  return { path: anonymize(path), params };
}

function matchesTarget(path, method, targets) {
  return targets.some(t => {
    const parts = t.split(' ');
    const tMethod = parts[0];
    const tPath = parts.slice(1).join(' ');
    const pathMatch = path === tPath || path.startsWith(tPath);
    return method ? (tMethod === method && pathMatch) : pathMatch;
  });
}

function extractJsonSchema(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return 'array';
  if (typeof obj !== 'object') return typeof obj;
  const schema = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) schema[key] = 'array';
    else if (value !== null && typeof value === 'object') schema[key] = 'object';
    else schema[key] = typeof value;
  }
  return schema;
}

// ─── MODE A: OpenTelemetry / Jaeger ──────────────────────────

async function mineFromJaeger(jaegerUrl, probeTargets) {
  const groups = new Map();
  let totalTraces = 0;

  // Step 1: Get services
  const servicesResp = await axios.get(`${jaegerUrl}/api/services`, { timeout: 5000 });
  const services = servicesResp.data.data || [];
  if (services.length === 0) {
    throw new Error('No services found in Jaeger');
  }

  // Pick the most relevant service (prefer non-jaeger services)
  const service = services.find(s => !s.includes('jaeger')) || services[0];
  process.stderr.write(`[otel] Using service: ${service}\n`);

  // Step 2: Fetch traces for this service
  const tracesResp = await axios.get(`${jaegerUrl}/api/traces`, {
    params: { service, limit: 100, lookback: '1h' },
    timeout: 10000,
  });
  const traces = tracesResp.data.data || [];
  totalTraces = traces.length;
  process.stderr.write(`[otel] Fetched ${totalTraces} traces\n`);

  // Step 3: Parse spans
  for (const trace of traces) {
    for (const span of (trace.spans || [])) {
      const tags = {};
      for (const tag of (span.tags || [])) {
        tags[tag.key] = tag.value;
      }

      const method = tags['http.method'] || tags['http.request.method'];
      const rawUrl = tags['http.url'] || tags['http.target'] || tags['http.route'] || tags['url.path'];
      if (!method || !rawUrl) continue;

      // Parse URL to get path and query
      let urlPath, queryParams;
      try {
        const parsed = new URL(rawUrl, 'http://dummy');
        urlPath = parsed.pathname;
        queryParams = {};
        for (const [k, v] of parsed.searchParams) {
          queryParams[k] = typeof v;
        }
      } catch {
        const { path, params } = parseQueryParams(rawUrl);
        urlPath = path;
        queryParams = {};
        for (const [k] of Object.entries(params)) {
          queryParams[k] = 'string';
        }
      }

      // Filter to probe targets
      if (probeTargets.length > 0 && !matchesTarget(urlPath, method.toUpperCase(), probeTargets)) {
        continue;
      }

      const statusCode = parseInt(tags['http.status_code'] || tags['http.response.status_code'] || 200, 10);
      const durationMs = Math.round((span.duration || 0) / 1000);

      // Extract request body schema from span logs/events
      let bodySchema = null;
      const bodyTag = tags['request.body'] || tags['http.request.body'];
      if (bodyTag) {
        try {
          const bodyObj = typeof bodyTag === 'string' ? JSON.parse(bodyTag) : bodyTag;
          bodySchema = extractJsonSchema(bodyObj);
        } catch { /* ignore */ }
      }
      // Also check span logs for request body
      if (!bodySchema) {
        for (const log of (span.logs || [])) {
          for (const field of (log.fields || [])) {
            if (field.key === 'request.body' || field.key === 'http.request.body') {
              try {
                const bodyObj = typeof field.value === 'string' ? JSON.parse(field.value) : field.value;
                bodySchema = extractJsonSchema(bodyObj);
              } catch { /* ignore */ }
            }
          }
        }
      }

      const key = `${method.toUpperCase()} ${urlPath}`;
      if (!groups.has(key)) {
        groups.set(key, {
          method: method.toUpperCase(),
          path: urlPath,
          count: 0,
          query_schemas: new Map(),
          body_schemas: [],
          statuses: [],
          latencies: [],
        });
      }

      const group = groups.get(key);
      group.count++;
      group.statuses.push(statusCode);
      group.latencies.push(durationMs);
      if (bodySchema) group.body_schemas.push(bodySchema);

      // Track query param schemas (types, not values)
      const schemaKey = JSON.stringify(queryParams);
      group.query_schemas.set(schemaKey, (group.query_schemas.get(schemaKey) || 0) + 1);
    }
  }

  // Build patterns
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);

  const patterns = sorted.map((g, index) => {
    // Most common query param schema
    const topQuerySchema = [...g.query_schemas.entries()]
      .sort((a, b) => b[1] - a[1])[0];
    const queryParams = topQuerySchema ? JSON.parse(topQuerySchema[0]) : {};

    // Most common body schema
    const bodySchema = g.body_schemas.length > 0 ? g.body_schemas[0] : null;

    const modeStatus = g.statuses.sort((a, b) =>
      g.statuses.filter(v => v === b).length - g.statuses.filter(v => v === a).length
    )[0] || 200;

    const avgLatency = g.latencies.length > 0
      ? Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length)
      : null;

    return {
      method: g.method,
      path: g.path,
      query_params: queryParams,
      request_body_schema: bodySchema,
      frequency: g.count,
      frequency_rank: index + 1,
      baseline_status: modeStatus,
      baseline_latency_ms: avgLatency,
      source: 'otel_trace',
    };
  });

  // Add "no_traces" entries for targets with no matches
  for (const target of probeTargets) {
    const [tMethod, ...tPathParts] = target.split(' ');
    const tPath = tPathParts.join(' ');
    if (!patterns.some(p => p.method === tMethod && p.path === tPath)) {
      patterns.push({
        method: tMethod,
        path: tPath,
        query_params: {},
        request_body_schema: null,
        frequency: 0,
        frequency_rank: patterns.length + 1,
        baseline_status: 200,
        baseline_latency_ms: null,
        source: 'no_traces',
      });
    }
  }

  return {
    log_window: '1h',
    total_requests_analyzed: totalTraces,
    trace_source: 'jaeger',
    patterns,
  };
}

// ─── MODE B: Nginx / file logs (fallback) ────────────────────

function parseLine(line) {
  const nginxMatch = line.match(NGINX_REGEX);
  if (nginxMatch) {
    const [, , , method, rawPath, status] = nginxMatch;
    const { path, params } = parseQueryParams(rawPath);
    return { method, path, query_params: params, status: parseInt(status, 10) };
  }

  try {
    const obj = JSON.parse(line);
    if (obj.method && obj.path) {
      const { path, params } = parseQueryParams(obj.path);
      return {
        method: obj.method.toUpperCase(),
        path,
        query_params: params,
        status: parseInt(obj.status || obj.status_code || 200, 10),
        latency_ms: obj.latency_ms || obj.latency || null,
      };
    }
  } catch {
    // Not JSON, skip
  }

  return null;
}

async function mineFromFile(logPath, probeTargets) {
  statSync(logPath);

  const groups = new Map();
  let totalLines = 0;

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalLines++;

    const parsed = parseLine(line);
    if (!parsed) continue;

    if (probeTargets.length > 0 && !matchesTarget(parsed.path, null, probeTargets)) {
      continue;
    }

    const key = `${parsed.method} ${parsed.path}`;
    if (!groups.has(key)) {
      groups.set(key, {
        method: parsed.method,
        path: parsed.path,
        count: 0,
        query_combos: new Map(),
        statuses: [],
        latencies: [],
      });
    }

    const group = groups.get(key);
    group.count++;
    group.statuses.push(parsed.status);
    if (parsed.latency_ms) group.latencies.push(parsed.latency_ms);

    const paramKey = JSON.stringify(parsed.query_params);
    if (group.query_combos.size < 50) {
      const existing = group.query_combos.get(paramKey) || 0;
      group.query_combos.set(paramKey, existing + 1);
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);

  const patterns = sorted.map((g, index) => {
    const topParams = [...g.query_combos.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([k]) => JSON.parse(k));

    const modeStatus = g.statuses.sort((a, b) =>
      g.statuses.filter(v => v === b).length - g.statuses.filter(v => v === a).length
    )[0] || 200;

    const avgLatency = g.latencies.length > 0
      ? Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length)
      : null;

    return {
      method: g.method,
      path: g.path,
      query_params: topParams[0] || {},
      request_body_schema: null,
      frequency: g.count,
      frequency_rank: index + 1,
      baseline_status: modeStatus,
      baseline_latency_ms: avgLatency,
      source: 'nginx_file',
    };
  });

  return {
    log_window: '24h',
    total_requests_analyzed: totalLines,
    trace_source: 'nginx_file',
    patterns,
  };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  try {
    const sourceArg = process.argv[2];
    const probeTargetsRaw = process.argv[3];
    const probeTargets = probeTargetsRaw ? JSON.parse(probeTargetsRaw) : [];

    if (!sourceArg) {
      throw new Error('Usage: log-miner.js <log-path-or-jaeger-url> <probe-targets-json>');
    }

    const logSource = process.env.LOG_SOURCE || 'file';

    if (logSource === 'otel') {
      // MODE A: OTel/Jaeger
      const jaegerUrl = sourceArg.startsWith('http') ? sourceArg : (process.env.JAEGER_URL || 'http://localhost:16686');
      try {
        const output = await mineFromJaeger(jaegerUrl, probeTargets);
        console.log(JSON.stringify(output, null, 2));
      } catch (otelErr) {
        process.stderr.write(`[otel] Jaeger unreachable (${otelErr.message}), falling back to file mode\n`);
        // Fall back to file mode if sourceArg is a file path
        const fallbackPath = process.env.LOG_PATH || sourceArg;
        const output = await mineFromFile(fallbackPath, probeTargets);
        console.log(JSON.stringify(output, null, 2));
      }
    } else {
      // MODE B: file (nginx/json logs)
      const output = await mineFromFile(sourceArg, probeTargets);
      console.log(JSON.stringify(output, null, 2));
    }
  } catch (err) {
    console.log(JSON.stringify({
      error: err.message,
      patterns: [],
    }, null, 2));
    process.exit(1);
  }
}

main();
