---
name: probe-generator
description: "Combines the diff-reader change manifest and the log-miner usage patterns to generate a precise, real-traffic probe set. Each probe is a real HTTP request derived from actual user behavior — not a synthetic test case invented by a developer."
allowed-tools: Bash Read Write
metadata:
  category: generation
  version: "1.0.0"
  author: livegate
---

# Probe Generator

## Purpose
Build the final probe set by combining what changed (from diff-reader) with
how real users hit those routes (from log-miner). Every probe is real.

## Instructions

Given diff-reader output and log-miner output:

1. Cross-reference probe_targets with log patterns
2. For each affected route with log patterns:
   - Take the top 10 most frequent real patterns
   - Add 2 edge-case patterns (lowest frequency from logs — unusual but real)
   - Add 1 baseline health check (simplest valid request)
3. For each affected route with NO log patterns (new endpoint):
   - Generate minimal synthetic probes from the route signature only
   - Mark these as `source: "synthetic"` — not from real traffic
   - Flag these with higher uncertainty in the verdict
4. Build the probe set with metadata for each probe

## Probe Priority Scoring
Score = (frequency_rank_weight × 0.6) + (risk_level_weight × 0.4)
Higher score = probe fires first.

## Output Format
```json
{
  "probe_set_id": "uuid",
  "generated_at": "ISO8601",
  "total_probes": 13,
  "probes": [
    {
      "id": "probe_001",
      "priority": 0.95,
      "method": "GET",
      "path": "/api/orders",
      "query_params": {"status": "pending", "limit": "100"},
      "headers": {"Accept": "application/json"},
      "body": null,
      "source": "real_traffic",
      "frequency_rank": 1,
      "risk_level": "medium",
      "expected_status": 200,
      "baseline_latency_ms": 145
    }
  ]
}
```
