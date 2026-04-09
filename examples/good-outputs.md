# Good Outputs

## Example 1: Clean GO verdict

**Scenario**: GET /api/orders query filter changed, 312 real probes from logs.

**Expected LiveGate output**:

```markdown
## LiveGate Deployment Report ✓

**Verdict: GO ✓**
**Confidence:** 0.92 | **Probes fired:** 312 | **Anomalies:** 2 (LOW)

### What was tested
Probes derived from 312 real traffic patterns from the last 24h of logs.
Affected routes: GET /api/orders, POST /api/orders

### Findings

| Severity | Count | Top finding |
|----------|-------|-------------|
| LOW      | 2     | Minor latency increase: 145ms → 162ms on GET /api/orders (+12%) |

### Recommendation
Safe to deploy. The 12% latency increase on GET /api/orders is within
acceptable bounds (under 50% threshold). No status code regressions detected
across 312 real traffic patterns.

---
*LiveGate v0.1.0 | Real-environment testing | 312 log patterns analyzed*
```

**Why this is good**: High confidence, many probes from real traffic, specific latency delta cited with percentage, clear threshold reasoning.

---

## Example 2: NO-GO verdict (regression detected)

**Scenario**: Same diff, but staging has a latency regression (450ms vs 120ms baseline).

**Expected LiveGate output**:

```json
{
  "verdict": "NO-GO",
  "confidence": 0.40,
  "timestamp": "2025-04-09T14:45:00Z",
  "anomaly_counts": {
    "critical": 0,
    "high": 2,
    "medium": 3,
    "low": 1
  },
  "pr_comment_markdown": "## LiveGate Deployment Report ✗\n\n**Verdict: NO-GO ✗**\n**Confidence:** 0.40 | **Probes fired:** 312 | **Anomalies:** 6\n\n### What was tested\nProbes derived from 312 real traffic patterns from the last 24h of logs.\nAffected routes: GET /api/orders, GET /api/orders/:id\n\n### Findings\n\n| Severity | Count | Top finding |\n|----------|-------|-------------|\n| CRITICAL | 0     | —           |\n| HIGH     | 2     | Latency increased from 120ms to 450ms (+275%) on GET /api/orders |\n| MEDIUM   | 3     | Response body hash changed |\n\n### Recommendation\nDeployment blocked. 2 high-severity latency regressions detected on probe_001, probe_002. GET /api/orders latency increased 275% above baseline. Do not deploy until investigated.\n\n---\n*LiveGate v0.1.0 | Real-environment testing | 312 log patterns analyzed*"
}
```

**Why this is good**: Clear NO-GO with specific probe IDs cited, percentage deltas, and actionable recommendation.

---

## Example 3: ESCALATE verdict (first run, no baseline)

**Scenario**: First LiveGate run on a repo. No baseline.json exists.

**Expected LiveGate output**:

```json
{
  "verdict": "ESCALATE",
  "confidence": 0.70,
  "timestamp": "2025-04-09T15:00:00Z",
  "anomaly_counts": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0
  },
  "note": "First run — all probes recorded as new baselines. No comparison possible.",
  "pr_comment_markdown": "## LiveGate Deployment Report ⚠\n\n**Verdict: ESCALATE ⚠**\n**Confidence:** 0.70 | **Probes fired:** 15 | **Anomalies:** 0\n\n### What was tested\nProbes derived from 15 real traffic patterns from the last 24h of logs.\nAffected routes: GET /api/orders\n\n### Findings\n\n| Severity | Count | Top finding |\n|----------|-------|-------------|\n| CRITICAL | 0     | —           |\n| HIGH     | 0     | —           |\n| MEDIUM   | 0     | —           |\n\n### Recommendation\nFirst run — no baseline exists for comparison. All 15 probe responses have been recorded as the new baseline. Manual review recommended for this deployment.\n\n---\n*LiveGate v0.1.0 | Real-environment testing | 15 log patterns analyzed*"
}
```

**Why this is good**: Honest about the limitation. Doesn't falsely claim GO. Records baselines for next run.
