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

## The OTel Advantage: Why Traces Beat Logs

Nginx access logs were LiveGate's first data source — and they're
fundamentally broken for production probe generation. Four failure modes:

1. **No request bodies.** POST/PUT payloads are invisible in access logs.
   LiveGate can see that `POST /api/orders` was called 40 times, but has no
   idea what the request body looked like. Every POST probe fires with an
   empty body and gets 400 Bad Request.

2. **Dead auth tokens.** Logs contain the exact `Authorization` header from
   production. That token is expired, scoped to production, or tied to a
   user that doesn't exist on staging. Every authenticated route returns 401.

3. **Production IDs don't exist on staging.** `GET /api/orders/84729` in
   the logs refers to a real production order. Staging has never seen that ID.
   Every ID-based probe returns 404.

4. **Lost request sequences.** Logs show individual requests, not sessions.
   You can't tell that `POST /api/cart` was followed by `POST /api/checkout`
   — the stateful flow is invisible.

OpenTelemetry traces solve each of these:

- **Body schema extraction.** OTel span tags and events carry the request
  body structure. LiveGate extracts the *schema* — `{user_id: "number",
  total: "number", priority: "string"}` — and generates probe bodies from
  the schema with placeholder values. No production data is replayed. The
  probe body conforms to the contract without needing a real token or ID.

- **Causal chains.** Jaeger stores the full trace graph. You can reconstruct
  that `POST /api/cart → POST /api/checkout → POST /api/payment` is a single
  user flow. Session-aware probe generation becomes possible.

- **Accurate latency.** Span durations are measured in microseconds by the
  instrumentation library, not approximated from nginx timestamps that have
  second-level granularity at best.

- **Span tags as data contracts.** The tags on a span (`http.method`,
  `http.route`, `http.status_code`, `db.statement`) are the actual data
  contract your service uses. They're more reliable than parsing free-text
  log lines.

### When to still use file mode

- Local dev without OTel infrastructure
- Quick demos (the sample access.log works out of the box)
- Repos that haven't added OTel instrumentation yet
- CI environments where standing up Jaeger is impractical

### Migration path

Adding OTel to any Node.js app takes 3 lines of config and zero code changes:

```bash
npm install @opentelemetry/auto-instrumentations-node
```

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
OTEL_SERVICE_NAME=my-service
```

```bash
node --require @opentelemetry/auto-instrumentations-node/register server.js
```

That's it. Jaeger starts receiving traces. LiveGate starts mining them.
