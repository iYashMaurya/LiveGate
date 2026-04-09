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

## 🤖 Powered by Lyzr Studio (Required)

Lyzr Studio is not optional. It **is** the intelligence layer.

Without Lyzr, LiveGate refuses to start. Every AI call in the pipeline routes through
a single Lyzr agent with a **shared session** — meaning the diff analysis context is
available when the verdict is written. It's one agent reasoning across the whole pipeline.

```
diff-reader       → Lyzr reads the diff semantically
                    "Added priority filter using >= instead of === on string field"

probe-generator   → Lyzr generates edge-case probes for the specific change
                    "Test ?priority= (empty), ?priority=9 (string comparison edge)"

comparator        → Lyzr explains every anomaly in plain English
                    "Orders endpoint returns wrong results because >= on strings
                     doesn't match intended numeric priority ordering"

verdict-writer    → Lyzr writes a specific, actionable PR comment
                    "Fix: change o.priority >= req.query.priority to
                     o.priority >= Number(req.query.priority)"
```

The GO/NO-GO/ESCALATE verdict itself is **deterministic** (not AI-generated).
You don't want a probabilistic model deciding whether to block your deploy.
Lyzr is used where understanding and explanation matter — not where reliability is critical.

All calls are logged in the [Lyzr Studio dashboard](https://studio.lyzr.ai) with full
session history, token usage, and inference traces.

### Setup (5 min)
1. Go to [studio.lyzr.ai](https://studio.lyzr.ai) and create an account
2. Create a **Single Agent** named `LiveGate` (see `lyzr/README.md` for exact config)
3. Copy your API key + agent ID into `.env`:
   ```
   LYZR_API_KEY=sk-...
   LYZR_AGENT_ID=69d80...
   ```
4. Run `bash demo/run-demo.sh`

---

## 🛠 Tech Stack

```
Skills (6)       ██████████  diff-reader, log-miner, probe-gen, prober, comparator, verdict
Sub-agents (2)   ██████████  probe-executor (prober), verdict-auditor (auditor)
Standard         ██████████  gitagent spec v0.1.0 + gitclaw runtime
Trace backend    █████████░  OpenTelemetry / Jaeger (primary), nginx logs (fallback)
CI/CD            ██████████  GitHub Actions, PR comments, merge blocking
AI inference    ██████████  Lyzr Studio → claude-sonnet-4-6 (mandatory, shared session)
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

### Option A: Full demo (requires Lyzr API key)

```bash
git clone https://github.com/iYashMaurya/livegate.git
cd livegate
npm install && cd demo/sample-app && npm install && cd ../..
cp .env.example .env
# Edit .env → add your LYZR_API_KEY and LYZR_AGENT_ID
bash demo/run-demo.sh
```

You'll see LiveGate run three times:
- **Run 1**: normal staging → `GO ✓`
- **Run 2**: simulated latency regression (800ms) → `ESCALATE ⚠`
- **Run 3**: priority filter bug (BUG_MODE) → `ESCALATE ⚠` or `NO-GO ✗`

Lyzr analyzes the diff, generates targeted edge-case probes, and writes a specific
PR comment explaining exactly what's wrong and how to fix it. 

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
Set `LYZR_API_KEY`, `LYZR_AGENT_ID`, and `STAGING_BASE_URL` in secrets.  
Every PR now gets a deployment verdict. That's it.

---

## 📊 What a Verdict Looks Like (Real Output)

This is an actual verdict from LiveGate with Lyzr Studio (not a template):

> ⚠️ **Deployment escalated for human review — static code risk not cleared by runtime probes alone.**
>
> All 19 probes returned expected status codes and no runtime anomalies were detected.
> However, the priority filter added to `GET /api/orders` uses `o.priority >= req.query.priority`
> — a direct comparison between a numeric field and a raw query string — which means
> `GET /api/orders?priority=9` may silently return wrong results: orders with numeric
> priority 10 will be excluded because `'10' >= '9'` is `false` under JavaScript string
> comparison, even though 10 > 9 numerically.
>
> **Action required:** Change `o.priority >= req.query.priority` to
> `o.priority >= Number(req.query.priority)` and add a guard to reject non-numeric values.
>
> *Powered by Lyzr Studio | 19 probes | gitagent v0.1.0*

Lyzr didn't just say "body changed." It read the diff, understood the `>=` bug,
and told the developer exactly what to fix.

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
| `LYZR_API_KEY` | Yes | Lyzr Studio API key (from studio.lyzr.ai) |
| `LYZR_AGENT_ID` | Yes | Lyzr Studio agent ID (after creating the LiveGate agent) |
| `STAGING_BASE_URL` | Yes | Your real staging environment |
| `LOG_SOURCE` | No | `otel` (production) or `file` (demo). Default: `file` |
| `LOG_PATH` | No | Nginx log path (file mode fallback) |
| `JAEGER_URL` | No | Jaeger HTTP API. Default: `http://localhost:16686` |
| `GITHUB_TOKEN` | No | PR comments |
| `GITHUB_REPO` | No | GitHub repo in `owner/repo` format |
| `PR_NUMBER` | No | Pull request number |

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
Lyzr Studio     AI inference platform (REQUIRED — all reasoning routes through here)
gitagent        open standard for AI agents in git repos (spec v0.1.0)
gitclaw         gitagent runtime engine
Claude          claude-sonnet-4-6 via Lyzr Studio
Node.js 20      runtime
OpenTelemetry   trace instrumentation + OTLP export
Jaeger          distributed trace backend (docker, free, local)
Express         demo staging server
axios           HTTP probe client
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
