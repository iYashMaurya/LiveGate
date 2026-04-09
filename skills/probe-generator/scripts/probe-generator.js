import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { lyzrChat, parseLyzrJson } from '../../../lyzr/lyzr-adapter.js';

const RISK_WEIGHTS = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };

function computePriority(frequencyRank, totalPatterns, riskLevel) {
  const frequencyWeight = totalPatterns > 0 ? 1 - (frequencyRank / totalPatterns) : 0.5;
  const riskWeight = RISK_WEIGHTS[riskLevel] || 0.25;
  return Math.round((frequencyWeight * 0.6 + riskWeight * 0.4) * 100) / 100;
}

const FIELD_PLACEHOLDERS = {
  userId: 1, user_id: 1, id: 1, orderId: 'order_001', order_id: 'order_001',
  email: 'user@example.com', name: 'Test User', username: 'testuser',
  status: 'pending', priority: 'normal', type: 'default',
  title: 'Test', description: 'Test description', message: 'Test message',
  amount: 100, total: 100, price: 9.99, quantity: 1, count: 1,
  url: 'https://example.com', path: '/test',
};

function generateBodyFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const body = {};
  for (const [key, type] of Object.entries(schema)) {
    if (FIELD_PLACEHOLDERS[key] !== undefined) {
      body[key] = FIELD_PLACEHOLDERS[key];
    } else if (type === 'string') body[key] = 'test';
    else if (type === 'number') body[key] = 1;
    else if (type === 'boolean') body[key] = true;
    else if (type === 'array') body[key] = [];
    else if (type === 'object') body[key] = {};
    else body[key] = null;
  }
  return body;
}

function buildProbeFromPattern(p, probeCounter, totalPatterns, riskLevel) {
  const hasBodySchema = p.request_body_schema && typeof p.request_body_schema === 'object' && Object.keys(p.request_body_schema).length > 0;
  const body = hasBodySchema ? generateBodyFromSchema(p.request_body_schema) : null;
  const headers = { Accept: 'application/json' };
  if (body && ['POST', 'PUT', 'PATCH'].includes(p.method)) {
    headers['Content-Type'] = 'application/json';
  }

  const source = p.source === 'no_traces' ? 'synthetic'
    : p.source === 'nginx_file' ? 'real_traffic'
    : p.source === 'otel_trace' ? 'real_traffic'
    : 'real_traffic';

  return {
    id: `probe_${String(probeCounter).padStart(3, '0')}`,
    priority: computePriority(p.frequency_rank, totalPatterns, riskLevel),
    method: p.method,
    path: p.path,
    query_params: p.query_params || {},
    headers,
    body,
    source,
    frequency_rank: p.frequency_rank,
    risk_level: riskLevel,
    expected_status: p.baseline_status || 200,
    baseline_latency_ms: p.baseline_latency_ms || null,
  };
}

async function generateEdgeCasesWithLyzr(changeManifest, existingProbes) {
  try {
    const result = await lyzrChat({
      message: `You are generating HTTP test probes for a deployment gate.

The deployment changed these routes:
${JSON.stringify(changeManifest.affected_routes || changeManifest.probe_targets, null, 2)}

Change summary: ${changeManifest.change_description || 'No description available'}

Already-generated probes cover:
${existingProbes.slice(0, 5).map(p => `${p.method} ${p.path} params=${JSON.stringify(p.query_params)}`).join('\n')}

Generate 3-5 additional edge-case probes that specifically target the changed behavior.
Focus on: boundary values, null/empty inputs, the specific field or param that changed.

Return ONLY a JSON array:
[{
  "method": "GET",
  "path": "/api/orders",
  "query_params": {"priority": ""},
  "body": null,
  "headers": {"Accept": "application/json"},
  "source": "lyzr_generated",
  "risk_level": "high",
  "rationale": "Tests empty priority string against new filter logic"
}]`,
      userId: 'livegate_probe_generator',
    });

    if (!result) return [];

    const edgeProbes = parseLyzrJson(result.text);
    process.stderr.write(`[lyzr] Generated ${edgeProbes.length} edge-case probes\n`);

    return edgeProbes.map((p, i) => ({
      id: `probe_lyzr_${String(i + 1).padStart(3, '0')}`,
      priority: 0.88,
      expected_status: 200,
      baseline_latency_ms: null,
      frequency_rank: null,
      ...p,
    }));
  } catch (err) {
    process.stderr.write(`[lyzr] Edge case generation failed: ${err.message}\n`);
    return [];
  }
}

async function main() {
  try {
    const changeManifestPath = process.argv[2];
    const logPatternsPath = process.argv[3];

    if (!changeManifestPath || !logPatternsPath) {
      throw new Error('Usage: probe-generator.js <change-manifest.json> <log-patterns.json>');
    }

    const changeManifest = JSON.parse(readFileSync(changeManifestPath, 'utf-8'));
    const logPatterns = JSON.parse(readFileSync(logPatternsPath, 'utf-8'));

    const probeTargets = changeManifest.probe_targets || [];
    const patterns = logPatterns.patterns || [];
    const routeRisk = {};

    // Build risk map from affected routes
    for (const route of (changeManifest.affected_routes || [])) {
      const key = `${route.method} ${route.path}`;
      routeRisk[key] = route.risk_level || 'low';
    }

    const probes = [];
    let probeCounter = 0;

    // For each probe target, find matching log patterns
    for (const target of probeTargets) {
      const [targetMethod, ...pathParts] = target.split(' ');
      const targetPath = pathParts.join(' ');
      const riskLevel = routeRisk[target] || 'medium';

      // Find matching patterns from logs/traces
      const matchingPatterns = patterns.filter(p =>
        p.method === targetMethod && (p.path === targetPath || p.path.startsWith(targetPath))
      );

      // Filter out "no_traces" patterns from matching — treat them like no patterns
      const realPatterns = matchingPatterns.filter(p => p.source !== 'no_traces');

      if (realPatterns.length > 0) {
        // Top 10 most frequent real patterns
        const topPatterns = realPatterns.slice(0, 10);
        for (const p of topPatterns) {
          probeCounter++;
          probes.push(buildProbeFromPattern(p, probeCounter, patterns.length, riskLevel));
        }

        // 2 edge-case patterns (lowest frequency — unusual but real)
        const edgeCases = realPatterns.slice(-2);
        for (const p of edgeCases) {
          if (probes.some(pr => pr.path === p.path && pr.method === p.method && JSON.stringify(pr.query_params) === JSON.stringify(p.query_params))) continue;
          probeCounter++;
          probes.push(buildProbeFromPattern(p, probeCounter, patterns.length, riskLevel));
        }

        // 1 baseline health check (simplest valid request)
        probeCounter++;
        probes.push({
          id: `probe_${String(probeCounter).padStart(3, '0')}`,
          priority: computePriority(1, patterns.length, riskLevel),
          method: targetMethod,
          path: targetPath,
          query_params: {},
          headers: { Accept: 'application/json' },
          body: null,
          source: 'real_traffic',
          frequency_rank: 0,
          risk_level: riskLevel,
          expected_status: 200,
          baseline_latency_ms: null,
        });
      } else {
        // No real patterns — synthetic probe
        probeCounter++;
        probes.push({
          id: `probe_${String(probeCounter).padStart(3, '0')}`,
          priority: computePriority(0, 1, riskLevel),
          method: targetMethod,
          path: targetPath,
          query_params: {},
          headers: { Accept: 'application/json' },
          body: null,
          source: 'synthetic',
          frequency_rank: null,
          risk_level: riskLevel,
          expected_status: 200,
          baseline_latency_ms: null,
        });
      }
    }

    // Generate Lyzr edge-case probes if configured
    try {
      const edgeCases = await generateEdgeCasesWithLyzr(changeManifest, probes);
      probes.push(...edgeCases);
    } catch (err) {
      process.stderr.write(`[lyzr] Edge case generation failed: ${err.message}\n`);
    }

    // Sort by priority descending
    probes.sort((a, b) => b.priority - a.priority);

    const output = {
      probe_set_id: randomUUID(),
      generated_at: new Date().toISOString(),
      total_probes: probes.length,
      probes,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      error: err.message,
      probes: [],
    }, null, 2));
    process.exit(1);
  }
}

main();
