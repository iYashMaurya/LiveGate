# Why Real-Environment Testing Beats Mocks

## The Problem with Mocks

Every mock is a developer's guess about what production looks like. Mocked
responses return what we imagined users would send — not what they actually
send. A mocked database returns the rows we thought to include, not the
5-million-row table with null values in the `priority` column that nobody
expected.

The gap between mocked behavior and real behavior is where production
incidents live. Mocks pass. Production breaks. The test suite is green while
the on-call engineer is paged at 3am.

This isn't a knock on unit tests — they verify logic. But when the question
is "will this deploy break something?", the answer must come from the real
environment, not from an in-memory simulation.

## Log Mining: Capturing Real User Intent

Instead of inventing test cases, LiveGate mines access logs to extract what
real users actually send. The top 300 requests to `GET /api/orders` in the
last 24 hours tell you more about real-world usage than any test matrix.

Log mining captures:
- The actual query parameter combinations users send
- The frequency distribution — which routes carry traffic
- The status code baseline — what "normal" looks like
- Edge cases that exist in the long tail of real traffic

When you replay these patterns against staging, you're not testing a
developer's imagination. You're testing against real user intent.

## Behavioral Delta Over Pass/Fail

Traditional tests assert: "this endpoint returns 200." That's binary and
fragile. Behavioral delta asks a better question: "does this endpoint behave
differently than it did before the change?"

By comparing the new deployment's response signatures against a stored
baseline of known-good responses, LiveGate detects:
- Status code regressions (200 → 500)
- Latency increases (145ms → 312ms, a 115% regression)
- Response body changes (hash mismatch)
- New errors where none existed before

This approach catches regressions that pass/fail tests miss — like a query
that returns correct data but takes 3x longer because an index was dropped.

## When to Trust a GO Verdict

A GO verdict is trustworthy when:
- Confidence score is ≥0.7
- A meaningful number of probes were fired (not just 2)
- The baseline is established from prior successful runs
- No CRITICAL or HIGH anomalies were detected
- Probes came from real traffic patterns, not synthetic generation

The more runs LiveGate completes, the more robust the baseline becomes.
First-run verdicts should always be treated with caution.

## When to Escalate

Escalation is appropriate when:
- New endpoints exist with no baseline (cannot compare)
- Low-frequency routes were changed (small probe sample)
- This is the first run — no baseline exists at all
- Confidence is between 0.5 and 0.7 (uncertain territory)
- HIGH anomalies exist but no CRITICAL ones

Escalation isn't failure. It's the system saying "I need a human to look at
this because my confidence is limited." That honesty is more valuable than a
false green checkmark.
