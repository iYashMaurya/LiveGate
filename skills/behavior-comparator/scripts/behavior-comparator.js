import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import 'dotenv/config';

function classifyAnomaly(probeId, field, baselineVal, currentVal) {
  if (field === 'status_code') {
    if (baselineVal >= 200 && baselineVal < 300 && currentVal >= 500) {
      return { severity: 'CRITICAL', type: 'status_regression', detail: `Status changed from ${baselineVal} to ${currentVal} (5xx)` };
    }
    if (baselineVal >= 200 && baselineVal < 300 && currentVal >= 400) {
      return { severity: 'HIGH', type: 'status_regression', detail: `Status changed from ${baselineVal} to ${currentVal} (4xx)` };
    }
    if (baselineVal !== currentVal) {
      return { severity: 'MEDIUM', type: 'status_change', detail: `Status changed from ${baselineVal} to ${currentVal}` };
    }
  }

  if (field === 'latency_ms' && baselineVal != null && currentVal != null) {
    const pctChange = ((currentVal - baselineVal) / baselineVal) * 100;
    if (pctChange > 300) {
      return { severity: 'HIGH', type: 'latency_regression', detail: `Latency increased from ${baselineVal}ms to ${currentVal}ms (+${Math.round(pctChange)}%)` };
    }
    if (pctChange > 50) {
      return { severity: 'MEDIUM', type: 'latency_regression', detail: `Latency increased from ${baselineVal}ms to ${currentVal}ms (+${Math.round(pctChange)}%)` };
    }
    if (pctChange < -50) {
      return { severity: 'LOW', type: 'latency_improvement', detail: `Latency decreased from ${baselineVal}ms to ${currentVal}ms (${Math.round(pctChange)}%)` };
    }
  }

  if (field === 'response_body_hash' && baselineVal !== currentVal) {
    return { severity: 'MEDIUM', type: 'response_body_change', detail: `Response body hash changed from ${baselineVal} to ${currentVal}` };
  }

  if (field === 'error' && !baselineVal && currentVal) {
    return { severity: 'HIGH', type: 'new_error', detail: `New error appeared: ${currentVal}` };
  }

  return null;
}

async function enrichHashAnomalies(anomalies, probeResults, baseline) {
  if (!process.env.ANTHROPIC_API_KEY) return anomalies;

  const hashAnomalies = anomalies.filter(a => a.type === 'response_body_change');
  if (hashAnomalies.length === 0) return anomalies;

  const enriched = [...anomalies];

  for (const anomaly of hashAnomalies) {
    const result = (probeResults.results || []).find(r => r.probe_id === anomaly.probe_id);
    const base = baseline[anomaly.probe_id];
    if (!result?.response_body_preview || !base?.response_body_preview) continue;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: 'You compare API responses. Return ONLY valid JSON, no markdown.',
          messages: [{
            role: 'user',
            content: `Compare these two API responses for probe ${anomaly.probe_id}.

BASELINE (before deploy):
${base.response_body_preview}

CURRENT (after deploy):
${result.response_body_preview}

Return JSON:
{
  "semantic_change": "one sentence describing what actually changed in the data",
  "is_regression": true/false,
  "regression_reason": "why this is a regression, or null if not a regression"
}`,
          }],
        }),
      });

      const data = await response.json();
      const parsed = JSON.parse(data.content[0].text.trim().replace(/```json|```/g, ''));

      const idx = enriched.findIndex(a => a.probe_id === anomaly.probe_id && a.type === anomaly.type);
      if (idx !== -1) {
        enriched[idx] = {
          ...anomaly,
          semantic_change: parsed.semantic_change,
          is_regression: parsed.is_regression,
          regression_reason: parsed.regression_reason,
          detail: `${anomaly.detail} | AI: ${parsed.semantic_change}`,
        };
      }

      process.stderr.write(`[comparator] AI enriched ${anomaly.probe_id}: ${parsed.semantic_change}\n`);
    } catch (err) {
      process.stderr.write(`[comparator] AI enrichment failed for ${anomaly.probe_id}: ${err.message}\n`);
    }
  }

  return enriched;
}

async function main() {
  try {
    const outputDir = 'memory/runtime';
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const probeResultsPath = process.argv[2] || `${outputDir}/probe-results.json`;
    const baselinePath = process.argv[3] || `${outputDir}/baseline.json`;

    // Read probe results
    const probeResults = JSON.parse(readFileSync(probeResultsPath, 'utf-8'));

    // Read or create baseline
    let baseline = {};
    if (existsSync(baselinePath)) {
      try {
        baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      } catch {
        baseline = {};
      }
    }

    const anomalies = [];
    const newBaselines = [];
    let confidenceScore = 1.0;

    for (const result of (probeResults.results || [])) {
      const baselineEntry = baseline[result.probe_id];

      if (!baselineEntry) {
        newBaselines.push(result.probe_id);
        continue;
      }

      // Compare fields
      const fields = [
        ['status_code', baselineEntry.status_code, result.status_code],
        ['latency_ms', baselineEntry.latency_ms, result.latency_ms],
        ['response_body_hash', baselineEntry.response_body_hash, result.response_body_hash],
        ['error', baselineEntry.error, result.error],
      ];

      for (const [field, bVal, cVal] of fields) {
        const anomaly = classifyAnomaly(result.probe_id, field, bVal, cVal);
        if (anomaly) {
          anomalies.push({
            probe_id: result.probe_id,
            severity: anomaly.severity,
            type: anomaly.type,
            detail: anomaly.detail,
            baseline_value: bVal,
            current_value: cVal,
          });
        }
      }
    }

    // Enrich hash anomalies with AI semantic comparison
    const enrichedAnomalies = await enrichHashAnomalies(anomalies, probeResults, baseline);

    // Compute confidence score
    const summary = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of enrichedAnomalies) {
      const sev = a.severity.toLowerCase();
      summary[sev] = (summary[sev] || 0) + 1;
    }

    confidenceScore -= summary.critical * 0.3;
    confidenceScore -= summary.high * 0.1;
    confidenceScore -= summary.medium * 0.05;
    confidenceScore = Math.max(0, Math.round(confidenceScore * 100) / 100);

    const report = {
      comparison_id: randomUUID(),
      compared_at: new Date().toISOString(),
      probes_compared: (probeResults.results || []).length,
      new_baseline_entries: newBaselines.length,
      confidence_score: confidenceScore,
      anomalies: enrichedAnomalies,
      summary,
    };

    writeFileSync(`${outputDir}/anomaly-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message, anomalies: [] }, null, 2));
    process.exit(1);
  }
}

main();
