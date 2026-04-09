import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const RISK_WEIGHTS = { critical: 1.0, high: 0.75, medium: 0.5, low: 0.25 };

function computePriority(frequencyRank, totalPatterns, riskLevel) {
  const frequencyWeight = totalPatterns > 0 ? 1 - (frequencyRank / totalPatterns) : 0.5;
  const riskWeight = RISK_WEIGHTS[riskLevel] || 0.25;
  return Math.round((frequencyWeight * 0.6 + riskWeight * 0.4) * 100) / 100;
}

function main() {
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

      // Find matching patterns from logs
      const matchingPatterns = patterns.filter(p =>
        p.method === targetMethod && (p.path === targetPath || p.path.startsWith(targetPath))
      );

      if (matchingPatterns.length > 0) {
        // Top 10 most frequent real patterns
        const topPatterns = matchingPatterns.slice(0, 10);
        for (const p of topPatterns) {
          probeCounter++;
          probes.push({
            id: `probe_${String(probeCounter).padStart(3, '0')}`,
            priority: computePriority(p.frequency_rank, patterns.length, riskLevel),
            method: p.method,
            path: p.path,
            query_params: p.query_params || {},
            headers: { Accept: 'application/json' },
            body: null,
            source: 'real_traffic',
            frequency_rank: p.frequency_rank,
            risk_level: riskLevel,
            expected_status: p.baseline_status || 200,
            baseline_latency_ms: p.baseline_latency_ms || null,
          });
        }

        // 2 edge-case patterns (lowest frequency — unusual but real)
        const edgeCases = matchingPatterns.slice(-2);
        for (const p of edgeCases) {
          // Avoid duplicates
          if (probes.some(pr => pr.path === p.path && pr.method === p.method && JSON.stringify(pr.query_params) === JSON.stringify(p.query_params))) continue;
          probeCounter++;
          probes.push({
            id: `probe_${String(probeCounter).padStart(3, '0')}`,
            priority: computePriority(p.frequency_rank, patterns.length, riskLevel),
            method: p.method,
            path: p.path,
            query_params: p.query_params || {},
            headers: { Accept: 'application/json' },
            body: null,
            source: 'real_traffic',
            frequency_rank: p.frequency_rank,
            risk_level: riskLevel,
            expected_status: p.baseline_status || 200,
            baseline_latency_ms: p.baseline_latency_ms || null,
          });
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
        // No log patterns — synthetic probe
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
