# LIVEGATE

```text
  ██╗     ██╗██╗   ██╗███████╗ ██████╗  █████╗ ████████╗███████╗
  ██║     ██║██║   ██║██╔════╝██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝
  ██║     ██║██║   ██║█████╗  ██║  ███╗███████║   ██║   █████╗  
  ██║     ██║╚██╗ ██╔╝██╔══╝  ██║   ██║██╔══██║   ██║   ██╔══╝  
  ███████╗██║ ╚████╔╝ ███████╗╚██████╔╝██║  ██║   ██║   ███████╗
  ╚══════╝╚═╝  ╚═══╝  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝  ╚═╝   ╚══════╝
```

> **"Your test suite is green. Production is on fire. These are not contradictions."**

⚠️ **STATUS: SHIPS REAL VERDICTS**

---

## `whoami` (The Project)

LiveGate is not a test framework.

> Think **GitOps** meets **chaos engineering**, but the chaos is your users — and they've been your QA team the whole time.

You pushed a change. Somewhere in your nginx logs, 47,000 real requests are sitting there, quietly telling you exactly how your users will hit that new endpoint. You're about to deploy without reading them.

**LiveGate reads them.**

It mines your production traffic patterns, replays the top ones against your real staging environment (live database, real dependencies, actual infrastructure), and tells you whether your change broke anything that was actually working.

Not a mock. Not a synthetic assertion. Real signals.

---

## The Problem with Your Current Tests

```yaml
your_test_suite:
  what_it_tests: "what you imagined"
  what_breaks_in_prod: "what users actually do"
  gap_between_them: "where your 3am pagerduty calls live"
  
livegate:
  what_it_tests: "the top 300 real requests from the last 24h"
  confidence: "we literally replayed your traffic"
  your_sleep: "undisturbed"
```

---

## How It Works

```
git push → PR opened → LiveGate wakes up
│
▼
┌─────────────────┐
│  diff-reader    │  What changed? (routes, queries, handlers)
└────────┬────────┘
         ▼
┌─────────────────┐
│  log-miner      │  Who hit those routes in the last 24h? (real traffic)
│                 │  ← OTel traces (primary) or nginx logs (fallback)
└────────┬────────┘
         ▼
┌─────────────────┐
│  probe-generator│  Build the probe set from real patterns
└────────┬────────┘
         ▼
┌─────────────────┐
│  env-prober     │  Fire probes at REAL staging. No mocks.
│  [probe-executor│  role: prober — cannot write verdict]
└────────┬────────┘
         ▼
┌─────────────────┐
│  comparator     │  Old behavior vs new behavior. Find the delta.
└────────┬────────┘
         ▼
┌─────────────────┐
│  verdict-writer │  GO ✓  NO-GO ✗  ESCALATE ⚠
│  [verdict-auditor  role: auditor — cannot fire probes]
└─────────────────┘
         │
         ▼
   GitHub PR comment
     (with receipts)
```

Two agents. Two roles. The agent that fires probes **cannot** write the verdict.  
That's not a feature — that's **Segregation of Duties**, enforced in code.

---

## Verdicts

| Verdict | Means | Exit Code | PR |
|---------|-------|-----------|-----|
| **GO ✓** | Replayed real traffic. Behavior unchanged. Ship it. | `0` | ✅ merge allowed |
| **ESCALATE ⚠** | Something changed. Not sure if it matters. Human eyes needed. | `2` | ⚠️ warning |
| **NO-GO ✗** | Regression detected. Latency spiked. Status codes broke. Do not merge. | `1` | 🚫 blocked |

---

## 🧠 How AI Is Used

Four surgical Claude calls. Each one has a fallback. The pipeline works without an API key.

```
diff-reader       → Claude reads the full diff semantically, extracts routes
                    and risk levels that regex misses. Falls back to regex.

probe-generator   → Claude generates 3-5 edge-case probes targeting the specific
                    change (boundary values, null inputs, the exact param that
                    changed). Falls back to traffic-only probes.

behavior-comparator → Claude explains what changed in response bodies — not just
                      "hash mismatch" but "response now returns an empty array
                      instead of 3 orders." Falls back to hash comparison.

verdict-writer    → Claude writes the PR comment with specific, actionable
                    language. Falls back to template-based comment.
```

> **The GO/NO-GO/ESCALATE verdict itself is deterministic (not AI-generated)** because you don't want a probabilistic model as a deployment gate. AI is used where explanation and creativity help — not where reliability is critical.

---

## 🛠 Tech Stack

```
Skills (6)       ██████████  diff-reader, log-miner, probe-gen, prober, comparator, verdict
Sub-agents (2)   ██████████  probe-executor (prober), verdict-auditor (auditor)
Standard         ██████████  gitagent spec v0.1.0 + gitclaw runtime
Trace backend    █████████░  OpenTelemetry / Jaeger (primary), nginx logs (fallback)
CI/CD            ██████████  GitHub Actions, PR comments, merge blocking
Model            █████████░  claude-sonnet-4-6 (verdict) + claude-haiku-4-5 (probes)
Guilt            █░░░░░░░░░  Minimal. Tests are finally honest.
```

---

## 🏗️ Architecture

Two agents that enforce auditable separation:

```
LiveGate (orchestrator)
├── probe-executor/        ← fires probes, records results, STOPS
│   ├── role: prober
│   └── CANNOT write verdicts (enforced)
└── verdict-auditor/       ← reads results, writes verdict, posts to PR
    ├── role: auditor
    └── CANNOT fire probes (enforced)
```

```
livegate/
├── agent.yaml                  # gitagent manifest (spec v0.1.0)
├── SOUL.md / RULES.md / DUTIES.md
├── DEMO.md                     # demo instructions + recording guide
├── docker-compose.yml          # Jaeger + demo app (OTel mode)
├── skills/
│   ├── diff-reader/            # parse git diffs → change manifest
│   ├── log-miner/              # OTel traces or nginx logs → traffic patterns
│   ├── probe-generator/        # build real-traffic probe set
│   ├── env-prober/             # fire probes against staging
│   ├── behavior-comparator/    # compare against baseline
│   └── verdict-writer/         # write Go/No-Go verdict
├── tools/                      # github-comment, http-probe, log-fetch
├── agents/
│   ├── probe-executor/         # sub-agent: role=prober (agent.yaml + SOUL.md + DUTIES.md)
│   └── verdict-auditor/        # sub-agent: role=auditor (agent.yaml + SOUL.md + DUTIES.md)
├── workflows/
│   └── pre-deploy-check.yaml   # 7-step orchestration workflow
├── runtime/
│   └── index.js                # CLI orchestrator entry point
├── hooks/
│   ├── hooks.yaml              # on_session_start + pre_tool_use
│   └── scripts/                # bootstrap.js, audit-log.js
├── memory/
│   ├── memory.yaml             # 3-layer memory config
│   ├── MEMORY.md               # working memory
│   └── runtime/                # baselines, verdicts, probe results, audit log
├── knowledge/
│   └── real-env-testing-guide.md
├── examples/                   # good-outputs.md, bad-outputs.md
├── compliance/                 # regulatory-map, risk-assessment, validation-schedule
├── config/                     # default.yaml
├── lyzr/                       # Lyzr Studio integration + adapter
├── demo/
│   ├── sample-app/             # Express API + Dockerfile + OTel instrumentation
│   ├── sample-logs/            # 500-line nginx access.log
│   ├── sample-diff/            # sample git diff (orders query change)
│   └── run-demo.sh             # full end-to-end demo (auto-detects Jaeger)
└── .github/workflows/
    └── livegate.yml            # runs on every PR, blocks merge on NO-GO
```

---

## 🚀 Run It

### Option A: 30-second demo (nginx logs, no infra needed)

```bash
git clone https://github.com/iYashMaurya/livegate.git
cd livegate
npm install && cd demo/sample-app && npm install && cd ../..
bash demo/run-demo.sh
```

You'll see LiveGate run twice:
- **Run 1**: normal staging → `GO ✓` 
- **Run 2**: simulated latency regression → `ESCALATE ⚠` 

### Option B: Full production setup (OTel traces + Jaeger)

```bash
# Spin up Jaeger + instrumented demo app
docker-compose up

# Run LiveGate against real traces
STAGING_BASE_URL=http://localhost:3001 \
LOG_SOURCE=otel \
JAEGER_URL=http://localhost:16686 \
node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001
```

### Option C: On your actual CI (GitHub Actions)

Add `.github/workflows/livegate.yml` to your repo.  
Set `STAGING_BASE_URL` and `ANTHROPIC_API_KEY` in secrets.  
Every PR now gets a deployment verdict. That's it.

---

## 📊 What a Verdict Looks Like on a PR

```markdown
## LiveGate Deployment Report ✓

**Verdict: GO ✓**
**Confidence:** 0.92 | **Probes fired:** 47 | **Anomalies:** 1 LOW

### What was tested
Probes derived from 47 real traffic patterns — last 24h of logs.
Affected routes: GET /api/orders, POST /api/orders

### Findings
| Severity | Count | Top finding |
|----------|-------|-------------|
| LOW      | 1     | Latency: 145ms → 162ms (+12%) on GET /api/orders |

### Recommendation
Safe to deploy. +12% latency within threshold. No status regressions
across 47 real traffic patterns. Baseline updated.

---
*LiveGate v0.1.0 | gitagent standard | 47 probes from real traffic*
```

---

## Why OTel, Not Just Nginx Logs

Nginx logs tell you what URL was hit. That's it.  
They don't tell you what was in the POST body. They don't tell you what downstream services were called. They definitely don't give you the request schema you need to replay a mutation on staging.

```
nginx logs:
  127.0.0.1 - - [09/Apr/2026] "POST /api/orders HTTP/1.1" 201 342
  ↑ the body is gone. the auth token is dead. the IDs are prod-only.

otel trace:
  span.http.method = "POST"
  span.http.target = "/api/orders"
  span.http.request.body_schema = {"userId": "number", "items": "array", "total": "number"}
  span.http.status_code = 201
  span.duration = 145ms
  ↑ body schema (not values), real latency, no credential leakage
```

Four reasons nginx log mining fails in production:
1. **No bodies** — POST payloads are invisible in combined format
2. **Dead tokens** — production auth tokens are useless on staging
3. **Missing IDs** — `GET /api/orders/84729` returns 404 on staging (that order doesn't exist)
4. **No sequences** — login → get token → fetch orders looks like 3 unrelated requests

OTel solves all four. LiveGate uses traces when Jaeger is available, falls back to file logs for demos.

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `STAGING_BASE_URL` | Yes | Your real staging environment |
| `ANTHROPIC_API_KEY` | No | For AI-assisted analysis |
| `GITHUB_TOKEN` | No | PR comments |
| `GITHUB_REPO` | No | GitHub repo in `owner/repo` format (for PR comments) |
| `PR_NUMBER` | No | Pull request number (for PR comments) |
| `LOG_SOURCE` | No | `otel` (production) or `file` (demo). Default: `otel` |
| `LOG_PATH` | No | Nginx log path (file mode fallback) |
| `OTEL_BACKEND` | No | Trace backend. Default: `jaeger` |
| `JAEGER_URL` | No | Jaeger HTTP API. Default: `http://localhost:16686` |
| `LYZR_API_KEY` | No | Lyzr Studio API key (for managed agent hosting) |

---

## 🗺 What's Next

- [ ] **Playwright session recording** — replay full browser sessions, not just HTTP calls
- [ ] **Datadog + Honeycomb adapters** — read traces from wherever you already have them
- [ ] **Schema drift detection** — alert when response shapes change across deploys
- [ ] **Multi-service graphs** — probe downstream dependencies, not just the changed service
- [ ] **Baseline aging** — automatically flag baselines older than N days as stale

---

## Built With

```
gitagent        open standard for AI agents in git repos (spec v0.1.0)
gitclaw         gitagent runtime engine
Claude          claude-sonnet-4-6 (verdict) + claude-haiku-4-5 (probes)
Node.js 20      runtime
OpenTelemetry   trace instrumentation + OTLP export
Jaeger          distributed trace backend (docker, free, local)
Express         demo staging server
axios           HTTP probe client
Lyzr Studio     managed agent hosting (optional)
```

---

```
                      /\_/\
                     ( -.-)   < "Probes fired. Verdict written." >
                      > ^ <
                    LiveGate
           Because "it works on my machine"
              is not a deployment strategy.
```
