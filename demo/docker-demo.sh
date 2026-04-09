#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
#  LiveGate Docker Demo — One command, full story
#  
#  What this does:
#  1. Starts Jaeger + demo app (with OTel instrumentation)
#  2. Generates traffic → traces appear in Jaeger
#  3. Runs LiveGate mining real OTel traces → GO verdict
#  4. Restarts demo app with latency regression
#  5. Runs LiveGate again → ESCALATE verdict
#  6. Shows both verdicts + links to Jaeger UI
# ═══════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    === LiveGate Docker Demo ===          ║"
echo "║    OTel traces • Jaeger • Real probes    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Preflight checks ────────────────────────────────────────

if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info &> /dev/null 2>&1; then
  echo "❌ Docker daemon is not running. Start Docker Desktop first."
  exit 1
fi

# ─── Cleanup on exit ─────────────────────────────────────────

cleanup() {
  echo ""
  echo "▶ Cleaning up containers..."
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose --profile regression down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ─── Step 1: Start Jaeger + demo app ─────────────────────────

echo "▶ Step 1: Starting Jaeger + demo app..."
docker compose up -d --build --wait
echo "  ✓ Jaeger UI:  http://localhost:16686"
echo "  ✓ Demo app:   http://localhost:3001"
echo ""

# Verify services
echo "▶ Health checks..."
curl -sf http://localhost:3001/health | node -e "process.stdin.on('data',d=>console.log('  Demo app:',JSON.parse(d).status))"
curl -sf http://localhost:16686/api/services > /dev/null && echo "  Jaeger:   ok"
echo ""

# ─── Step 2: Generate traffic (creates OTel traces) ──────────

echo "▶ Step 2: Generating traffic (100 requests → OTel traces)..."
bash demo/traffic-generator.sh http://localhost:3001 100
echo ""

# Give Jaeger a moment to index traces
sleep 3

# Verify traces exist
TRACE_COUNT=$(curl -sf "http://localhost:16686/api/traces?service=livegate-demo-app&limit=5&lookback=1h" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log((j.data||[]).length)})" 2>/dev/null || echo "0")
echo "  ✓ Jaeger has $TRACE_COUNT trace(s) from demo app"
echo ""

# ─── Step 3: Reset LiveGate state ────────────────────────────

rm -rf memory/runtime
mkdir -p memory/runtime
echo '{}' > memory/runtime/baseline.json

# ─── Step 4: Bootstrap baseline ──────────────────────────────

echo "═══════════════════════════════════════"
echo "  Bootstrap: Establishing baseline..."
echo "═══════════════════════════════════════"
echo ""

LOG_SOURCE=file \
STAGING_BASE_URL=http://localhost:3001 \
node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-source file \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001 || true

# Save as baseline
node -e "
  import { readFileSync, writeFileSync } from 'fs';
  const results = JSON.parse(readFileSync('memory/runtime/probe-results.json','utf-8'));
  const baseline = {};
  for (const r of results.results) { baseline[r.probe_id] = r; }
  writeFileSync('memory/runtime/baseline.json', JSON.stringify(baseline, null, 2));
  console.log('✓ Baseline established with ' + Object.keys(baseline).length + ' entries');
"
echo ""

# ─── Step 5: Run LiveGate (normal — should be GO) ────────────

echo "═══════════════════════════════════════"
echo "  Run 1: Normal behavior"
echo "═══════════════════════════════════════"
echo ""

LOG_SOURCE=file \
STAGING_BASE_URL=http://localhost:3001 \
node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-source file \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001 || true

VERDICT_1=$(cat memory/runtime/verdict.json 2>/dev/null || echo '{"verdict":"ERROR"}')
echo ""
echo "Run 1 verdict: $(echo "$VERDICT_1" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo ""

# Save Run 1 as baseline for regression comparison
node -e "
  import { readFileSync, writeFileSync } from 'fs';
  const results = JSON.parse(readFileSync('memory/runtime/probe-results.json','utf-8'));
  const baseline = {};
  for (const r of results.results) { baseline[r.probe_id] = r; }
  writeFileSync('memory/runtime/baseline.json', JSON.stringify(baseline, null, 2));
"

# ─── Step 6: Restart with regression ─────────────────────────

echo "═══════════════════════════════════════"
echo "  Run 2: Simulated regression"
echo "  (restarting demo app with SIMULATE_SLOW=true)"
echo "═══════════════════════════════════════"
echo ""

# Stop normal app, start slow one on same port
docker compose stop demo-app
docker compose --profile regression up -d --build --wait demo-app-slow
sleep 2

echo "▶ Health check (slow app on port 3002)..."
curl -sf http://localhost:3002/health | node -e "process.stdin.on('data',d=>console.log('  Slow app:',JSON.parse(d).status))"
echo ""

# Run LiveGate against the slow app
LOG_SOURCE=file \
STAGING_BASE_URL=http://localhost:3002 \
node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-source file \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3002 || true

VERDICT_2=$(cat memory/runtime/verdict.json 2>/dev/null || echo '{"verdict":"ERROR"}')
echo ""
echo "Run 2 verdict: $(echo "$VERDICT_2" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo ""

# ─── Summary ──────────────────────────────────────────────────

echo "╔══════════════════════════════════════════╗"
echo "║           Docker Demo Summary            ║"
echo "╠══════════════════════════════════════════╣"
printf "║  Run 1 (normal):     %-19s ║\n" "$(echo "$VERDICT_1" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
printf "║  Run 2 (slow):       %-19s ║\n" "$(echo "$VERDICT_2" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Jaeger UI:  http://localhost:16686       ║"
echo "║  Demo app:   http://localhost:3001        ║"
echo "║  Slow app:   http://localhost:3002        ║"
echo "║                                          ║"
echo "║  memory/runtime/verdict.json              ║"
echo "║  memory/runtime/anomaly-report.json       ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Containers are still running. Open Jaeger UI to see traces."
echo "Press Ctrl+C to stop and clean up."
echo ""

# Keep alive so user can explore Jaeger UI
read -r -p "Press Enter to stop containers..." || true
