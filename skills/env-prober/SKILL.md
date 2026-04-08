---
name: env-prober
description: "Fires the generated probe set against the real staging environment — live database, real service dependencies, actual infrastructure. Captures full response signatures including status code, latency, response body hash, and headers. Respects rate limits and timeout budgets."
allowed-tools: Bash
metadata:
  category: execution
  version: "1.0.0"
  author: livegate
  role: prober
---

# Env Prober

## Purpose
Fire probes against the real staging environment and capture response signatures.
This skill is owned by the probe-executor sub-agent (role: prober).
It MUST NOT interpret or judge results — only capture and record.

## Instructions

Given a probe set from probe-generator and STAGING_BASE_URL from environment:

1. Fire each probe in priority order
2. For each probe:
   - Send HTTP request with 10 second timeout
   - Capture: status_code, latency_ms, response_body_hash (SHA256 of body),
     content_type, response_size_bytes, error (if any)
   - Wait 100ms between probes (rate limit: max 10/sec)
3. If a probe fails with network error: retry once after 2s, then mark as error
4. Write ALL results to memory/runtime/probe-results.json
5. Do NOT write verdict. Do NOT interpret. Record only.
6. Signal completion by writing memory/runtime/probe-complete.flag

## Rate Limiting
- Maximum 10 requests per second
- Respect Retry-After headers if staging returns 429
- Stop immediately if staging returns 503 (environment unstable, escalate)

## Output (memory/runtime/probe-results.json)
```json
{
  "probe_set_id": "uuid",
  "environment": "staging",
  "base_url": "http://staging.example.com",
  "executed_at": "ISO8601",
  "probes_fired": 13,
  "results": [
    {
      "probe_id": "probe_001",
      "status_code": 200,
      "latency_ms": 162,
      "response_body_hash": "sha256:abc123",
      "content_type": "application/json",
      "response_size_bytes": 1842,
      "error": null
    }
  ]
}
```
