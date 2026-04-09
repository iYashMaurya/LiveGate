# LiveGate Demo

## Run This First

```bash
# 1. Install all dependencies
npm install && cd demo/sample-app && npm install && cd ../..

# 2. Run the full end-to-end demo
bash demo/run-demo.sh
```

That's it. The demo script handles everything: starts the staging server, runs LiveGate twice (normal + regression), and shows both verdicts.

---

## What You'll See in the Terminal

### Step 1: Demo app starts
```
╔══════════════════════════════════════╗
║         === LiveGate Demo ===        ║
║   Real-environment CI/CD testing     ║
╚══════════════════════════════════════╝

▶ Starting demo app (normal mode)...
Demo app listening on http://localhost:3001
▶ Health check...
{"status":"ok","uptime":2.1}
```

### Step 2: LiveGate pipeline runs (normal — no regression)
```
▶ [1/6] Running diff-reader...
  ✓ diff-reader complete: 1 file(s), 2 target(s), risk: medium
▶ [2/6] Running log-miner...
  ✓ log-miner complete: 500 requests analyzed, 52 pattern(s)
▶ [3/6] Running probe-generator...
  ✓ probe-generator complete: 14 probe(s) generated
▶ [4/6] Running env-prober (probe-executor agent)...
  [1/14] Firing GET /api/orders/:id...
  ...
  ✓ env-prober complete: 14 probe(s) fired
▶ [5/6] Running behavior-comparator...
  ✓ behavior-comparator complete: confidence=0.95, anomalies=1
▶ [6/6] Running verdict-writer (verdict-auditor agent)...
  ✓ verdict-writer complete: GO

✅ VERDICT: GO — Safe to deploy (confidence: 0.95)
```

### Step 3: Demo app restarts with latency regression (SIMULATE_SLOW=true)
```
▶ Restarting demo app with SIMULATE_SLOW=true...
⚠ SIMULATE_SLOW=true — GET /api/orders has 800ms latency
```

### Step 4: LiveGate detects the regression
```
▶ [5/6] Running behavior-comparator...
  ✓ behavior-comparator complete: confidence=0.75, anomalies=3

⚠️  VERDICT: ESCALATE — Manual review required (confidence: 0.75)
```

### Step 5: Summary
```
╔══════════════════════════════════════╗
║           Demo Summary               ║
╠══════════════════════════════════════╣
║  Run 1 (normal):     GO              ║
║  Run 2 (slow):       ESCALATE        ║
╚══════════════════════════════════════╝
```

---

## What the GitHub PR Comment Looks Like

When LiveGate posts to a PR, the comment looks like this:

---

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

---

## Recording Your Submission Video

### Recommended flow (2–3 minutes):

1. **Show the README** (10 sec) — scroll through to show architecture and philosophy
2. **Run `npx gitagent info`** (5 sec) — show the agent summary
3. **Run `npx gitagent validate --compliance`** (5 sec) — show it passes
4. **Run the demo** (60 sec) — `bash demo/run-demo.sh`, let it run to completion
5. **Show the verdict files** (15 sec) — `cat memory/runtime/verdict.json`
6. **Show the anomaly report** (15 sec) — `cat memory/runtime/anomaly-report.json`
7. **Show the GitHub Actions workflow** (10 sec) — open `.github/workflows/livegate.yml`
8. **Show the Lyzr integration** (10 sec) — open `lyzr/lyzr-agent.json`

### Key points to mention:
- Every probe comes from **real access logs** — not synthetic test cases
- LiveGate uses **behavioral delta** — comparing new vs old, not pass/fail
- **Segregation of Duties** — the agent that fires probes cannot write verdicts
- Built on the **gitagent open standard** with full compliance validation
- **GitHub Actions integration** blocks merges on NO-GO verdicts
