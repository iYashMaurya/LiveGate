---
name: behavior-comparator
description: "Compares the probe results from the current deployment against the stored baseline of known-good responses in memory/runtime/baseline.json. Computes behavioral delta: status code changes, latency regressions, response body changes, error rate increases. Produces an anomaly report."
allowed-tools: Bash Read Write
metadata:
  category: analysis
  version: "1.0.0"
  author: livegate
---

# Behavior Comparator

## Purpose
Compare new deployment behavior against known-good baseline to find regressions.

## Instructions

Given probe-results.json and baseline.json:

1. For each probe result, find the matching baseline entry by probe_id
2. Compute delta for:
   - status_code: flag if changed (200→500 is CRITICAL, 200→404 is HIGH)
   - latency_ms: flag if increased >50% (MEDIUM) or >300% (HIGH)
   - response_body_hash: flag if changed (could be intentional or regression)
   - error rate: flag if went from 0 to any errors (HIGH)
3. Classify each anomaly:
   - CRITICAL: 5xx responses where baseline was 2xx
   - HIGH: 4xx on existing routes, latency >300%, auth failures
   - MEDIUM: latency 50-300%, response body changes on known routes
   - LOW: minor latency changes (<50%), new fields in response
4. Compute overall confidence score:
   - Start at 1.0
   - Subtract 0.3 per CRITICAL anomaly
   - Subtract 0.1 per HIGH anomaly
   - Subtract 0.05 per MEDIUM anomaly
   - Floor at 0.0
5. Write anomaly report to memory/runtime/anomaly-report.json

## Baseline Update Logic
If no baseline exists for a probe: mark as "new_baseline" (cannot compare).
After a successful GO verdict: update baseline with new response signatures.

## Output (memory/runtime/anomaly-report.json)
```json
{
  "comparison_id": "uuid",
  "compared_at": "ISO8601",
  "probes_compared": 13,
  "new_baseline_entries": 0,
  "confidence_score": 0.85,
  "anomalies": [
    {
      "probe_id": "probe_001",
      "severity": "MEDIUM",
      "type": "latency_regression",
      "detail": "Latency increased from 145ms to 312ms (+115%)",
      "baseline_value": 145,
      "current_value": 312
    }
  ],
  "summary": {
    "critical": 0,
    "high": 0,
    "medium": 1,
    "low": 2
  }
}
```
