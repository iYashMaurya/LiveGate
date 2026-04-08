---
name: diff-reader
description: "Parses a git diff to extract changed API endpoints, modified database queries, altered function signatures, and affected route handlers. Outputs a structured JSON manifest of what changed and where, used by downstream skills to target probes precisely."
allowed-tools: Bash Read
metadata:
  category: analysis
  version: "1.0.0"
  author: livegate
---

# Diff Reader

## Purpose
Analyze a git diff and produce a structured change manifest that downstream
skills can use to target probes precisely against only what changed.

## Instructions

When executing this skill:

1. Read the git diff from stdin or from the path provided
2. Parse all changed files and identify:
   - Modified API route handlers (Express, Fastify, Koa, Flask, FastAPI, etc.)
   - Changed database queries (SQL, ORM calls, MongoDB operations)
   - Altered function signatures in service layers
   - Modified middleware or authentication logic
   - Changed environment variable usage
3. For each change, extract:
   - file_path: string
   - change_type: "modified" | "added" | "deleted"
   - affected_routes: string[] (HTTP method + path patterns)
   - affected_db_operations: string[] (table/collection + operation type)
   - risk_level: "low" | "medium" | "high" | "critical"
   - risk_reason: string (why this risk level)
4. Output structured JSON to stdout

## Risk Classification
- critical: auth/session logic, payment handlers, data deletion
- high: database schema changes, query modifications, external API calls
- medium: business logic changes, response format changes
- low: logging, comment changes, config updates

## Output Format
```json
{
  "diff_summary": "string",
  "changed_files": 3,
  "affected_routes": [
    {
      "method": "GET",
      "path": "/api/orders",
      "file": "src/routes/orders.js",
      "risk_level": "medium",
      "risk_reason": "Query filter logic changed"
    }
  ],
  "affected_db_operations": [],
  "overall_risk": "medium",
  "probe_targets": ["GET /api/orders", "POST /api/orders"]
}
```
