# Bad Outputs (What LiveGate Must Never Do)

## Anti-pattern 1: Verdict without evidence
BAD: "Tests passed. Safe to deploy."
WHY: No probe count, no anomaly list, no confidence score. Useless.

## Anti-pattern 2: Using synthetic data as primary signal
BAD: "I generated 10 test cases covering the changed routes."
WHY: Test cases you generate are not real user behavior.

## Anti-pattern 3: Approving despite 5xx responses
BAD: Posting GO verdict when any probe returned 500.
WHY: A 500 on any real traffic pattern is a hard NO-GO.
