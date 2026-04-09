# LiveGate

**Deployment intelligence powered by real user behavior.**

> LiveGate is an AI agent that mines real production logs, replays real traffic patterns against your staging environment, and delivers a Go/No-Go deployment verdict — with evidence, not guesswork.

[![gitagent spec](https://img.shields.io/badge/gitagent-v0.1.0-blue)](https://github.com/open-gitagent/gitagent)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Core Philosophy

1. **Real environment, not mocks.** Every probe hits your actual staging infrastructure — real database, real services, real latency.
2. **Log mining, not imagination.** Test inputs come from what real users actually send, extracted from your production access logs.
3. **Behavioral delta, not pass/fail.** Instead of brittle assertions, LiveGate compares new behavior against a known-good baseline to detect regressions.

---

## How It Works

```
PR opened → LiveGate activates
    │
    ▼
┌─────────────────┐
│  1. DIFF READER  │ ← Parses git diff, finds changed routes
└────────┬────────┘
         ▼
┌─────────────────┐
│  2. LOG MINER    │ ← Mines 24h of real access logs for those routes
└────────┬────────┘
         ▼
┌─────────────────┐
│  3. PROBE GEN    │ ← Builds probe set from real traffic patterns
└────────┬────────┘
         ▼
┌─────────────────┐
│  4. ENV PROBER   │ ← Fires probes against real staging (role: prober)
└────────┬────────┘
         ▼
┌─────────────────┐
│  5. COMPARATOR   │ ← Compares responses against known-good baseline
└────────┬────────┘
         ▼
┌─────────────────┐
│  6. VERDICT      │ ← Writes Go/No-Go verdict on the PR (role: auditor)
└─────────────────┘
```

**Segregation of Duties**: The agent that fires probes (probe-executor) is a different agent from the one that writes verdicts (verdict-auditor). This prevents any single agent from both running tests and approving deployments.

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/user/livegate.git
cd livegate
npm install
cd demo/sample-app && npm install && cd ../..
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your values:
#   STAGING_BASE_URL=http://localhost:3001
#   GITHUB_TOKEN=ghp_... (optional, for PR comments)
```

### 3. Validate

```bash
npx gitagent validate --compliance
```

### 4. Run the Demo

```bash
# Start the demo staging server
node demo/sample-app/server.js &

# Run LiveGate against the demo
node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001

# Or run the full two-pass demo (normal + regression):
bash demo/run-demo.sh
```

---

## Architecture

```
livegate/
├── agent.yaml              # gitagent manifest (spec v0.1.0)
├── SOUL.md                 # Agent identity
├── RULES.md                # Operational rules
├── DUTIES.md               # Segregation of duties policy
├── skills/
│   ├── diff-reader/        # Parse git diffs → change manifest
│   ├── log-miner/          # Mine access logs → traffic patterns
│   ├── probe-generator/    # Build real-traffic probe set
│   ├── env-prober/         # Fire probes against staging
│   ├── behavior-comparator/# Compare against baseline
│   └── verdict-writer/     # Write Go/No-Go verdict
├── tools/
│   ├── github-comment.yaml # Post PR comments
│   ├── http-probe.yaml     # Fire HTTP requests
│   └── log-fetch.yaml      # Fetch access logs
├── agents/
│   ├── probe-executor/     # Sub-agent: fires probes (role: prober)
│   └── verdict-auditor/    # Sub-agent: writes verdicts (role: auditor)
├── workflows/
│   └── pre-deploy-check.yaml  # Master orchestration workflow
├── runtime/
│   └── index.js            # CLI entry point and orchestrator
├── hooks/
│   └── scripts/            # Bootstrap + audit logging
├── memory/
│   ├── memory.yaml         # Memory layer configuration
│   ├── MEMORY.md           # Working memory
│   └── runtime/            # Probe results, baselines, verdicts
├── knowledge/
│   └── real-env-testing-guide.md
├── demo/
│   ├── sample-app/         # Express.js demo API
│   ├── sample-logs/        # 500-line nginx access log
│   ├── sample-diff/        # Sample git diff
│   └── run-demo.sh         # Full end-to-end demo script
└── .github/
    └── workflows/
        └── livegate.yml    # GitHub Actions CI integration
```

### Standards & Runtime

- **[gitagent](https://github.com/open-gitagent/gitagent)** — Open standard for AI agents in git repositories (spec v0.1.0)
- **[gitclaw](https://github.com/open-gitagent/gitclaw)** — Runtime engine for gitagent-compliant agents
- **Segregation of Duties** — Probe execution and verdict writing are handled by separate sub-agents with distinct roles and permissions

---

## GitHub Actions Integration

LiveGate runs automatically on every pull request:

```yaml
# .github/workflows/livegate.yml runs on:
#   - PR opened/updated to main, master, or staging
#   - Manual workflow_dispatch with custom staging URL

# Required secrets:
#   ANTHROPIC_API_KEY — for AI-powered analysis
#   GITHUB_TOKEN — automatically provided by Actions

# Required variables:
#   STAGING_BASE_URL — your staging environment URL
#   LOG_SOURCE — file | cloudwatch | datadog
#   LOG_PATH — path or ARN for access logs
```

**Merge protection**: LiveGate blocks merge on `NO-GO` verdicts and warns on `ESCALATE`. Results are uploaded as artifacts for every run.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STAGING_BASE_URL` | Yes | — | Base URL of staging environment |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key (for AI analysis) |
| `GITHUB_TOKEN` | No | — | GitHub token for PR comments |
| `GITHUB_REPO` | No | — | GitHub repo (owner/repo format) |
| `PR_NUMBER` | No | — | Pull request number |
| `LOG_SOURCE` | No | `file` | Log source: `file`, `cloudwatch`, `datadog` |
| `LOG_PATH` | Yes | — | Path or ARN for access logs |
| `LYZR_API_KEY` | No | — | Lyzr API key (optional integration) |

---

## Why Not Mocks?

Every mock is a developer's guess about what production looks like. Mocked responses return what we imagined users would send — not what they actually send. A mocked database returns the rows we thought to include, not the 5-million-row table with null values in the `priority` column that nobody expected. The gap between mocked behavior and real behavior is where production incidents live.

LiveGate eliminates this gap. Instead of inventing test cases, it mines your access logs to extract what real users actually send. The top 300 requests to `GET /api/orders` in the last 24 hours tell you more about real-world usage than any test matrix. By comparing the new deployment's response signatures against a stored baseline of known-good responses, LiveGate catches regressions that pass/fail tests miss — like a query that returns correct data but takes 3x longer because an index was dropped.

---

## Verdict Types

| Verdict | Meaning | Exit Code | Merge |
|---------|---------|-----------|-------|
| **GO ✓** | Safe to deploy. High confidence, no critical anomalies. | 0 | Allowed |
| **ESCALATE ⚠** | Human review required. Uncertain or new baselines. | 2 | Warning |
| **NO-GO ✗** | Do not deploy. Critical regressions detected. | 1 | Blocked |

---

## Built With

- **[gitagent](https://github.com/open-gitagent/gitagent)** — Open standard for AI agents in git repos
- **[gitclaw](https://github.com/open-gitagent/gitclaw)** — gitagent runtime engine
- **[Claude claude-sonnet-4-6](https://anthropic.com)** — AI model for analysis and verdict generation
- **[Node.js](https://nodejs.org)** — Runtime environment
- **[Express](https://expressjs.com)** — Demo staging server
- **[Axios](https://axios-http.com)** — HTTP client for probe execution

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>LiveGate</strong> — Because your users deserve better than "the tests passed."
</p>
