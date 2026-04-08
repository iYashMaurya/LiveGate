# Duties — Segregation of Duties Policy

## System-Wide Policy

LiveGate enforces a strict two-role separation between the agent that executes
probes and the agent that writes the deployment verdict. No single agent may hold
both roles simultaneously.

## Role Definitions

| Role | Agent | Permissions | Description |
|------|-------|-------------|-------------|
| prober | probe-executor | execute, probe | Fires HTTP probes against real staging env |
| auditor | verdict-auditor | review, approve, reject, report | Reviews probe results, writes Go/No-Go |

## Conflict Matrix

| Role A | Role B | Conflict |
|--------|--------|----------|
| prober | auditor | CONFLICT — same agent cannot probe AND audit |

## Handoff Workflow: deployment_verdict

1. `probe-executor` fires all probes and records raw results to memory/runtime/
2. `probe-executor` signals completion — it does NOT interpret results
3. `verdict-auditor` reads raw results from memory/runtime/
4. `verdict-auditor` writes verdict to PR comment or escalation report
5. If verdict-auditor confidence < 0.7 → opens human-review PR branch

## Isolation Policy
- Each sub-agent reads from its own section of memory/runtime/
- Credentials for staging environment are only available to probe-executor
- Verdict-auditor has read-only access to probe results

## Enforcement: strict
Violations of this SOD policy cause the pipeline to halt and alert.
