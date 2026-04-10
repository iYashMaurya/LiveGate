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

// ─── MODE C: Datadog Log Analytics API ───────────────────────

async function mineFromDatadog(probeTargets) {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  const site = process.env.DD_SITE || 'datadoghq.com';

  if (!apiKey || !appKey) {
    throw new Error('Datadog requires DD_API_KEY and DD_APP_KEY env vars');
  }

  process.stderr.write(`[datadog] Querying logs from ${site}...\n`);

  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const groups = new Map();
  let totalLogs = 0;

  // Query for each probe target route
  for (const target of probeTargets) {
    const [method, ...pathParts] = target.split(' ');
    const path = pathParts.join(' ');

    const query = `@http.method:${method} @http.url_details.path:${path}*`;
    try {
      const resp = await axios.post(`https://api.${site}/api/v2/logs/events/search`, {
        filter: { query, from: new Date(oneHourAgo).toISOString(), to: new Date(now).toISOString() },
        sort: '-timestamp',
        page: { limit: 500 },
      }, {
        headers: {
          'DD-API-KEY': apiKey,
          'DD-APPLICATION-KEY': appKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const logs = resp.data?.data || [];
      totalLogs += logs.length;

      for (const log of logs) {
        const attrs = log.attributes?.attributes || log.attributes || {};
        const logMethod = attrs['http.method'] || method;
        const logPath = attrs['http.url_details.path'] || path;
        const status = parseInt(attrs['http.status_code'] || 200, 10);
        const duration = parseFloat(attrs['duration'] || 0) / 1000000; // ns to ms

        const key = `${logMethod} ${logPath}`;
        if (!groups.has(key)) {
          groups.set(key, { method: logMethod, path: logPath, count: 0, statuses: [], latencies: [], query_schemas: new Map() });
        }
        const g = groups.get(key);
        g.count++;
        g.statuses.push(status);
        if (duration > 0) g.latencies.push(Math.round(duration));

        const qp = attrs['http.url_details.queryString'] || {};
        const schemaKey = JSON.stringify(Object.fromEntries(Object.keys(qp).map(k => [k, 'string'])));
        g.query_schemas.set(schemaKey, (g.query_schemas.get(schemaKey) || 0) + 1);
      }
    } catch (err) {
      process.stderr.write(`[datadog] Query failed for ${target}: ${err.message}\n`);
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  const patterns = sorted.map((g, index) => {
    const topSchema = [...g.query_schemas.entries()].sort((a, b) => b[1] - a[1])[0];
    const modeStatus = g.statuses.sort((a, b) => g.statuses.filter(v => v === b).length - g.statuses.filter(v => v === a).length)[0] || 200;
    const avgLatency = g.latencies.length > 0 ? Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length) : null;

    return {
      method: g.method, path: g.path,
      query_params: topSchema ? JSON.parse(topSchema[0]) : {},
      request_body_schema: null,
      frequency: g.count, frequency_rank: index + 1,
      baseline_status: modeStatus, baseline_latency_ms: avgLatency,
      source: 'datadog',
    };
  });

  return { log_window: '1h', total_requests_analyzed: totalLogs, trace_source: 'datadog', patterns };
}

// ─── MODE D: AWS CloudWatch Logs Insights ────────────────────

async function mineFromCloudWatch(probeTargets) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const logGroup = process.env.CW_LOG_GROUP;

  if (!logGroup) {
    throw new Error('CloudWatch requires CW_LOG_GROUP env var');
  }

  process.stderr.write(`[cloudwatch] Querying ${logGroup} in ${region}...\n`);

  // Use AWS SDK v3 via dynamic import (available in Node 18+)
  let CWL;
  try {
    CWL = await import('@aws-sdk/client-cloudwatch-logs');
  } catch {
    throw new Error('CloudWatch adapter requires @aws-sdk/client-cloudwatch-logs. Run: npm install @aws-sdk/client-cloudwatch-logs');
  }

  const cwClient = new CWL.CloudWatchLogsClient({ region });

  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;

  const query = `fields @timestamp, @message
    | filter @message like /HTTP/
    | parse @message '"* * HTTP/*" *' as method, path, proto, status
    | stats count(*) as freq by method, path, status
    | sort freq desc
    | limit 200`;

  const startCmd = new CWL.StartQueryCommand({
    logGroupName: logGroup,
    startTime: oneHourAgo,
    endTime: now,
    queryString: query,
  });

  const { queryId } = await cwClient.send(startCmd);
  process.stderr.write(`[cloudwatch] Query started: ${queryId}\n`);

  // Poll for results
  let results = [];
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const getCmd = new CWL.GetQueryResultsCommand({ queryId });
    const resp = await cwClient.send(getCmd);
    if (resp.status === 'Complete') {
      results = resp.results || [];
      break;
    }
  }

  process.stderr.write(`[cloudwatch] Got ${results.length} result rows\n`);

  const patterns = [];
  let totalAnalyzed = 0;

  for (const row of results) {
    const fields = {};
    for (const f of row) { fields[f.field] = f.value; }
    const method = fields.method || 'GET';
    const path = fields.path || '/';
    const status = parseInt(fields.status || 200, 10);
    const freq = parseInt(fields.freq || 1, 10);
    totalAnalyzed += freq;

    if (probeTargets.length > 0 && !matchesTarget(path, method, probeTargets)) continue;

    patterns.push({
      method, path,
      query_params: {},
      request_body_schema: null,
      frequency: freq, frequency_rank: patterns.length + 1,
      baseline_status: status, baseline_latency_ms: null,
      source: 'cloudwatch',
    });
  }

  return { log_window: '1h', total_requests_analyzed: totalAnalyzed, trace_source: 'cloudwatch', patterns };
}

// ─── MODE E: Multi-service OTel with service routing ─────────

async function mineFromJaegerMultiService(jaegerUrl, probeTargets) {
  process.stderr.write(`[otel-multi] Discovering services from ${jaegerUrl}...\n`);

  const servicesResp = await axios.get(`${jaegerUrl}/api/services`, { timeout: 5000 });
  const allServices = (servicesResp.data.data || []).filter(s => !s.includes('jaeger'));

  if (allServices.length === 0) {
    throw new Error('No services found in Jaeger');
  }

  process.stderr.write(`[otel-multi] Found ${allServices.length} services: ${allServices.join(', ')}\n`);

  // Mine traces from ALL services, build a service → routes map
  const serviceRouteMap = new Map(); // service → [patterns]
  let totalTraces = 0;

  for (const service of allServices.slice(0, 10)) {
    try {
      const tracesResp = await axios.get(`${jaegerUrl}/api/traces`, {
        params: { service, limit: 50, lookback: '1h' },
        timeout: 10000,
      });
      const traces = tracesResp.data.data || [];
      totalTraces += traces.length;

      for (const trace of traces) {
        for (const span of (trace.spans || [])) {
          const tags = {};
          for (const tag of (span.tags || [])) { tags[tag.key] = tag.value; }
          const method = tags['http.method'] || tags['http.request.method'];
          const rawUrl = tags['http.url'] || tags['http.target'] || tags['http.route'];
          if (!method || !rawUrl) continue;

          let urlPath;
          try { urlPath = new URL(rawUrl, 'http://d').pathname; } catch { urlPath = rawUrl.split('?')[0]; }

          if (probeTargets.length > 0 && !matchesTarget(urlPath, method.toUpperCase(), probeTargets)) continue;

          const key = `${service}:${method.toUpperCase()} ${urlPath}`;
          if (!serviceRouteMap.has(key)) {
            serviceRouteMap.set(key, {
              service, method: method.toUpperCase(), path: urlPath,
              count: 0, statuses: [], latencies: [],
            });
          }
          const g = serviceRouteMap.get(key);
          g.count++;
          g.statuses.push(parseInt(tags['http.status_code'] || 200, 10));
          g.latencies.push(Math.round((span.duration || 0) / 1000));
        }
      }
    } catch (err) {
      process.stderr.write(`[otel-multi] Service ${service} failed: ${err.message}\n`);
    }
  }

  const sorted = [...serviceRouteMap.values()].sort((a, b) => b.count - a.count);
  const patterns = sorted.map((g, index) => {
    const modeStatus = g.statuses.sort((a, b) => g.statuses.filter(v => v === b).length - g.statuses.filter(v => v === a).length)[0] || 200;
    const avgLatency = g.latencies.length > 0 ? Math.round(g.latencies.reduce((a, b) => a + b, 0) / g.latencies.length) : null;
    return {
      method: g.method, path: g.path,
      query_params: {},
      request_body_schema: null,
      frequency: g.count, frequency_rank: index + 1,
      baseline_status: modeStatus, baseline_latency_ms: avgLatency,
      source: 'otel_trace', service: g.service,
    };
  });

  return { log_window: '1h', total_requests_analyzed: totalTraces, trace_source: 'jaeger_multi', services: allServices, patterns };
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
    let output;

    switch (logSource) {
      case 'otel': {
        const jaegerUrl = sourceArg.startsWith('http') ? sourceArg : (process.env.JAEGER_URL || 'http://localhost:16686');
        try {
          output = await mineFromJaegerMultiService(jaegerUrl, probeTargets);
        } catch (otelErr) {
          process.stderr.write(`[otel] Jaeger unreachable (${otelErr.message}), falling back to file\n`);
          output = await mineFromFile(process.env.LOG_PATH || sourceArg, probeTargets);
        }
        break;
      }
      case 'datadog': {
        try {
          output = await mineFromDatadog(probeTargets);
        } catch (ddErr) {
          process.stderr.write(`[datadog] Failed (${ddErr.message}), falling back to file\n`);
          output = await mineFromFile(process.env.LOG_PATH || sourceArg, probeTargets);
        }
        break;
      }
      case 'cloudwatch': {
        try {
          output = await mineFromCloudWatch(probeTargets);
        } catch (cwErr) {
          process.stderr.write(`[cloudwatch] Failed (${cwErr.message}), falling back to file\n`);
          output = await mineFromFile(process.env.LOG_PATH || sourceArg, probeTargets);
        }
        break;
      }
      default: {
        output = await mineFromFile(sourceArg, probeTargets);
      }
    }

    // Sampling: if too many patterns, keep top 100 by frequency
    if (output.patterns.length > 100) {
      process.stderr.write(`[sampling] ${output.patterns.length} patterns found, sampling top 100\n`);
      output.patterns = output.patterns.slice(0, 100);
      output.patterns.forEach((p, i) => { p.frequency_rank = i + 1; });
    }

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      error: err.message,
      patterns: [],
    }, null, 2));
    process.exit(1);
  }
}

main();
