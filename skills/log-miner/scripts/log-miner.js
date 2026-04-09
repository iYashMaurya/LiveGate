import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import 'dotenv/config';

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

function parseLine(line) {
  // Try nginx combined format first
  const nginxMatch = line.match(NGINX_REGEX);
  if (nginxMatch) {
    const [, , , method, rawPath, status] = nginxMatch;
    const { path, params } = parseQueryParams(rawPath);
    return { method, path, query_params: params, status: parseInt(status, 10) };
  }

  // Try JSON structured logs
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

function matchesTarget(path, targets) {
  return targets.some(t => {
    const targetPath = t.includes(' ') ? t.split(' ').slice(1).join(' ') : t;
    return path === targetPath || path.startsWith(targetPath);
  });
}

async function main() {
  try {
    const logPath = process.argv[2];
    const probeTargetsRaw = process.argv[3];

    if (!logPath) {
      throw new Error('Usage: log-miner.js <log-file-path> <probe-targets-json>');
    }

    const probeTargets = probeTargetsRaw ? JSON.parse(probeTargetsRaw) : [];

    // Verify file exists
    statSync(logPath);

    const groups = new Map(); // key: "METHOD /path" -> { count, query_combos, statuses, latencies }
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

      // Filter to probe targets if provided
      if (probeTargets.length > 0 && !matchesTarget(parsed.path, probeTargets)) {
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

      // Track unique query param combos (top 50)
      const paramKey = JSON.stringify(parsed.query_params);
      if (group.query_combos.size < 50) {
        const existing = group.query_combos.get(paramKey) || 0;
        group.query_combos.set(paramKey, existing + 1);
      }
    }

    // Sort by frequency and build output
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
        frequency: g.count,
        frequency_rank: index + 1,
        baseline_status: modeStatus,
        baseline_latency_ms: avgLatency,
      };
    });

    const output = {
      log_window: '24h',
      total_requests_analyzed: totalLines,
      patterns,
    };

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
