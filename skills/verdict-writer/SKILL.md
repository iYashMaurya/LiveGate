---
name: verdict-writer
description: "Reads the anomaly report produced by behavior-comparator and writes a structured Go/No-Go deployment verdict. This skill is owned by the verdict-auditor sub-agent (role: auditor). It posts the verdict as a GitHub PR comment in human-readable markdown, or opens a human-review branch when confidence is below threshold."
allowed-tools: Bash Read Write
metadata:
  category: output
  version: "1.0.0"
  author: livegate
  role: auditor
---

# Verdict Writer

## Purpose
Transform the anomaly report into a human-readable deployment verdict.
This skill is owned by verdict-auditor (role: auditor). It never fires probes.

## Instructions

Given memory/runtime/anomaly-report.json:

1. Read the anomaly report
2. Determine verdict:
   - GO ✓: confidence >= 0.7 AND no CRITICAL anomalies AND no HIGH anomalies
   - ESCALATE ⚠: confidence >= 0.5 AND (HIGH anomalies exist OR new endpoints with no baseline)
   - NO-GO ✗: confidence < 0.5 OR any CRITICAL anomalies
3. Write verdict to memory/runtime/verdict.json
4. Compose GitHub PR comment in markdown (see format below)
5. If ESCALATE or NO-GO: also write to memory/runtime/escalation.md with full detail

## PR Comment Format (≤2000 chars summary)

```markdown
## LiveGate Deployment Report ✓/✗/⚠

**Verdict: [GO ✓ | NO-GO ✗ | ESCALATE ⚠]**
**Confidence:** [0.0–1.0] | **Probes fired:** N | **Anomalies:** N

### What was tested
Probes derived from [N] real traffic patterns from the last 24h of logs.
Affected routes: METHOD /path, METHOD /path

### Findings

| Severity | Count | Top finding |
|----------|-------|-------------|
| CRITICAL | N     | ...         |
| HIGH     | N     | ...         |
| MEDIUM   | N     | ...         |

### Recommendation
[1–3 sentences. Evidence-based. Cite specific probe IDs and deltas.]

---
*LiveGate v0.1.0 | Real-environment testing | [N] log patterns analyzed*
```
