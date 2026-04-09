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

async function analyzeAnomaliesWithLyzr(anomalies, changeManifest, probeResults) {
  if (anomalies.length === 0) return anomalies;

  const probeContext = (probeResults.results || []).map(r => ({
    id: r.probe_id,
    status: r.status_code,
    latency: r.latency_ms,
    body_preview: r.response_body_preview?.slice(0, 200) || null,
  }));

  const result = await lyzrChat({
    message: `You are analyzing deployment anomalies for a behavioral regression detector.

The deployment changed:
${changeManifest?.change_description || 'Unknown change'}

Anomalies detected:
${JSON.stringify(anomalies, null, 2)}

Probe results (what the new deployment returned):
${JSON.stringify(probeContext, null, 2)}

For EACH anomaly, explain:
1. Is this likely caused by the change described, or is it unexpected?
2. What specifically changed in plain English?
3. Is it a regression (bad) or an expected change (acceptable)?

Return ONLY a JSON array — one object per anomaly in the same order:
[{
  "probe_id": "probe_001",
  "ai_explanation": "The orders endpoint now filters by priority but the index was not created, causing a full table scan. This explains the 340% latency increase.",
  "is_expected_change": false,
  "severity_recommendation": "high",
  "suggested_action": "Add index on orders.priority before deploying"
}]`,
  });

  if (!result?.text) return anomalies;

  try {
    const analyses = parseLyzrJson(result.text);
    return anomalies.map((anomaly, i) => ({
      ...anomaly,
      ...(analyses[i] || {}),
      detail: analyses[i]?.ai_explanation
        ? `${anomaly.detail} | Lyzr: ${analyses[i].ai_explanation}`
        : anomaly.detail,
    }));
  } catch {
    return anomalies;
  }
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

    // Load change manifest for Lyzr context
    let changeManifest = null;
    try {
      const manifestPath = `${outputDir}/change-manifest.json`;
      if (existsSync(manifestPath)) {
        changeManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      }
    } catch { /* continue */ }

    // Lyzr analyzes ALL anomalies with full pipeline context
    const enrichedAnomalies = await analyzeAnomaliesWithLyzr(anomalies, changeManifest, probeResults);

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
