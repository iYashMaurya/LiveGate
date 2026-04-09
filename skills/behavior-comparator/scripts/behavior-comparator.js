import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { lyzrChat, parseLyzrJson } from '../../../lyzr/lyzr-adapter.js';

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

async function enrichBodyAnomaliesWithLyzr(anomalies, probeResults, baseline) {
  const hashAnomalies = anomalies.filter(a => a.type === 'response_body_change');
  if (hashAnomalies.length === 0) return anomalies;

  const enriched = [...anomalies];

  for (const anomaly of hashAnomalies) {
    const result = (probeResults.results || []).find(r => r.probe_id === anomaly.probe_id);
    const base = baseline[anomaly.probe_id];

    const basePreview = base?.response_body_preview;
    const currPreview = result?.response_body_preview;
    if (!basePreview || !currPreview) continue;

    try {
      const lyzrResult = await lyzrChat({
        message: `Compare these two API responses for probe ${anomaly.probe_id}.

BEFORE deployment:
${basePreview}

AFTER deployment:
${currPreview}

Return ONLY a JSON object:
{
  "semantic_change": "one sentence describing exactly what changed in the data",
  "is_regression": true,
  "regression_reason": "why this is a regression, or null if it is an expected/benign change"
}`,
        userId: 'livegate_comparator',
      });

      if (!lyzrResult) continue;

      const parsed = parseLyzrJson(lyzrResult.text);
      const idx = enriched.findIndex(a => a.probe_id === anomaly.probe_id && a.type === 'response_body_change');
      if (idx !== -1) {
        enriched[idx] = {
          ...enriched[idx],
          semantic_change: parsed.semantic_change,
          is_regression: parsed.is_regression,
          regression_reason: parsed.regression_reason,
          detail: `${enriched[idx].detail} | Lyzr: ${parsed.semantic_change}`,
        };
      }

      process.stderr.write(`[lyzr] Enriched ${anomaly.probe_id}: ${parsed.semantic_change}\n`);
    } catch (err) {
      process.stderr.write(`[lyzr] Enrichment failed for ${anomaly.probe_id}: ${err.message}\n`);
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
    const enrichedAnomalies = await enrichBodyAnomaliesWithLyzr(anomalies, probeResults, baseline);

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
