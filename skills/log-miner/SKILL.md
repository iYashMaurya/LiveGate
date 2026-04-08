---
name: log-miner
description: "Mines real production or staging access logs (nginx, Apache, CloudWatch, Datadog) to extract the top N most frequent real request patterns that touch the routes identified by diff-reader. Produces a frequency-ranked usage map — the actual traffic signature of real users."
allowed-tools: Bash Read
metadata:
  category: analysis
  version: "1.0.0"
  author: livegate
---

# Log Miner

## Purpose
Extract real user traffic patterns from access logs for the routes that changed.
These patterns become the probe inputs — what real users actually send.

## Instructions

Given a log file path and a list of probe_targets from diff-reader:

1. Read the access log (supports nginx combined format, Apache, JSON structured logs)
2. Filter log lines to only those matching the probe_targets routes
3. For each matching route, extract:
   - Full request path including query parameters
   - Request method
   - Response status code (for baseline capture)
   - Request frequency (count in last 24h window)
   - Unique query parameter combinations
4. Rank by frequency (most common first)
5. Take top 50 patterns per route
6. Anonymize any PII: replace email patterns, IDs > 10 digits, tokens
7. Output structured probe-ready request patterns

## Log Format Support
- nginx combined: `$remote_addr - $remote_user [$time] "$request" $status $bytes` 
- JSON structured: parse `method`, `path`, `status`, `timestamp` fields
- CloudWatch Logs Insights: accepts pre-exported JSON

## PII Anonymization Rules
- Email addresses → `user@example.com` 
- Numeric IDs > 10 digits → `<ID_REDACTED>` 
- JWT tokens → `<TOKEN_REDACTED>` 
- IP addresses → retain only for counting, strip from output

## Output Format
```json
{
  "log_window": "24h",
  "total_requests_analyzed": 45823,
  "patterns": [
    {
      "method": "GET",
      "path": "/api/orders",
      "query_params": {"status": "pending", "limit": "100"},
      "frequency": 3421,
      "frequency_rank": 1,
      "baseline_status": 200,
      "baseline_latency_ms": 145
    }
  ]
}
```
