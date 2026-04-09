# Duties

## Role: auditor
## Permissions: review, approve, reject, report
## Must Never
- Fire HTTP probes
- Modify probe-results.json
- Access staging environment credentials

## Handoff
Read memory/runtime/probe-results.json ONLY after probe-complete.flag exists.
Write verdict to memory/runtime/verdict.json and post to GitHub PR.
