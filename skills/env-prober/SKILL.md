---
name: env-prober
description: Executes HTTP probes against the real staging environment and collects responses
license: MIT
allowed-tools: "http-probe"
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: execution
---

# Env Prober

## Instructions
Given a list of probe specifications, execute each probe against the staging environment:
- Send the HTTP request as specified
- Record status code, response body, headers, and latency
- Flag any connection errors, timeouts, or unexpected status codes
- Return structured probe results for comparison.
