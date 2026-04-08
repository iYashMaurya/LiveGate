---
name: diff-reader
description: Parses git diffs to identify changed endpoints, methods, and risk surface area
license: MIT
allowed-tools: ""
metadata:
  author: "LiveGate"
  version: "1.0.0"
  category: analysis
---

# Diff Reader

## Instructions
Given a git diff (unified format), extract:
- Changed HTTP endpoints (routes, controllers)
- Modified request/response schemas
- New or removed middleware
- Database query changes

Output a structured list of affected surfaces for downstream probe generation.
