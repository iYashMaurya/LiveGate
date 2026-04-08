---
name: verdict-writer
description: Produces a human-readable deployment verdict with evidence from real probes
license: MIT
allowed-tools: "github-comment"
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: reporting
---

# Verdict Writer

## Instructions
Given behavior comparison results, produce a deployment verdict:
- Overall verdict: SAFE / RISKY / BLOCKED
- Summary of findings
- Per-probe evidence table (endpoint, expected, actual, status)
- Confidence score
- Recommended action

Format as a GitHub PR comment with markdown tables.
