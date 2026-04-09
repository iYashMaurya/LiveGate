---
name: log-miner
description: "Mines real traffic patterns from OpenTelemetry traces (Jaeger) or access logs (nginx, JSON). OTel mode extracts request body schemas, latency distributions, and downstream service graphs. File mode extracts path + query patterns as fallback."
allowed-tools: Bash Read
metadata:
  category: analysis
  version: "2.0.0"
  author: livegate
---

# Log Miner

## Purpose
Extract real user traffic patterns for the routes that changed.
These patterns become the probe inputs — what real users actually send.

## Trace Source Support

### OTel/Jaeger (primary mode, `LOG_SOURCE=otel`)
- Queries Jaeger HTTP API for recent traces matching affected routes
- Extracts request body **schema** (keys + types, never values) from span tags/events
- Captures accurate latency from span durations (microsecond precision)
- Discovers downstream service dependencies from trace graphs
- Auth-agnostic: schema-based probe generation doesn't need live tokens

### Nginx file (fallback mode, `LOG_SOURCE=file`)
- Parses nginx combined format or JSON structured logs
- Extracts path + query parameters only (no request body)
- Approximates latency from log timestamps (less accurate)
- Suitable for demos, local dev, or repos without OTel instrumentation

### Why OTel beats nginx logs
- **Body schema**: traces carry the request body structure — logs don't
- **Downstream deps**: traces show the causal chain of service calls
- **Accurate timing**: span durations are precise, not approximated from log timestamps
- **No dead credentials**: schema-based probes don't replay auth tokens that are expired on staging

## Instructions

### OTel mode
Given a Jaeger URL and a list of probe_targets from diff-reader:

1. Query `GET /api/services` to discover available services
2. For each service, query `GET /api/traces?service={svc}&limit=100&lookback=1h`
3. Parse span tags for: `http.method`, `http.url`, `http.target`, `http.route`
4. Extract request body schema from `request.body` / `http.request.body` tags
5. Convert span durations (μs) to milliseconds
6. Build frequency-ranked patterns with body schemas
7. On Jaeger failure: fall back to file mode automatically

### File mode
Given a log file path and a list of probe_targets from diff-reader:

1. Read the access log (nginx combined, Apache, or JSON structured)
2. Filter to probe_targets routes
3. Extract path, query params, status code, frequency
4. Anonymize PII: emails, long IDs, tokens
5. Output structured patterns (no body schema available)

## PII Anonymization Rules
- Email addresses → `user@example.com`
- Numeric IDs > 10 digits → `<ID_REDACTED>`
- JWT tokens → `<TOKEN_REDACTED>`
- IP addresses → retained for counting only, stripped from output
- OTel mode: only schema keys are extracted, never production values

## Output Format
```json
{
  "log_window": "1h",
  "total_requests_analyzed": 100,
  "trace_source": "jaeger",
  "patterns": [
    {
      "method": "POST",
      "path": "/api/orders",
      "query_params": {},
      "request_body_schema": {"user_id": "number", "total": "number", "priority": "string"},
      "frequency": 34,
      "frequency_rank": 1,
      "baseline_status": 201,
      "baseline_latency_ms": 45,
      "source": "otel_trace"
    }
  ]
}
```
