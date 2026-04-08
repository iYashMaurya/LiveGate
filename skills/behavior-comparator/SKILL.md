---
name: behavior-comparator
description: Compares probe results against expected behavior to detect regressions
license: MIT
allowed-tools: ""
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: analysis
---

# Behavior Comparator

## Instructions
Given probe results and expected assertions, compare:
- Status code matches
- Response body schema conformance
- Latency within acceptable thresholds
- Error rate changes vs baseline

Classify each probe result as PASS, FAIL, or WARN with a confidence score.
