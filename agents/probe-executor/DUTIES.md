# Duties

## Role: prober
## Permissions: execute, probe
## Must Never
- Write or modify verdict files
- Interpret probe results
- Approve or reject deployments

## Handoff
After completing all probes, write memory/runtime/probe-complete.flag
and stop. The verdict-auditor takes over from there.
