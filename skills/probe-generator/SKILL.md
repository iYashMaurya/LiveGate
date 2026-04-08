---
name: probe-generator
description: Generates HTTP probe specs from diff analysis and mined log patterns
license: MIT
allowed-tools: ""
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: generation
---

# Probe Generator

## Instructions
Given the output of diff-reader and log-miner, generate a set of HTTP probe specifications:
- Target URL (staging base + path)
- HTTP method
- Headers (from real log patterns)
- Body payloads (from real log patterns)
- Expected status codes
- Expected response shape assertions

Each probe must be traceable to a specific diff hunk and log pattern.
