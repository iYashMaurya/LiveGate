---
name: log-miner
description: Mines production access logs to extract real request patterns and traffic signatures
license: MIT
allowed-tools: "log-fetch"
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: analysis
---

# Log Miner

## Instructions
Given raw access logs (nginx, Apache, or structured JSON), extract:
- Frequent request paths and methods
- Query parameter patterns
- Header signatures
- Status code distributions
- Latency percentiles

Output real-world request templates that can be replayed against staging.
