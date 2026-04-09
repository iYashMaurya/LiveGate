#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         === LiveGate Demo ===        ║"
echo "║   Real-environment CI/CD testing     ║"
echo "╚══════════════════════════════════════╝"
echo ""

cleanup() {
  echo ""
  echo "Cleaning up..."
  if [ -n "${DEMO_PID:-}" ]; then
    kill "$DEMO_PID" 2>/dev/null || true
    wait "$DEMO_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─── Run 1: Normal behavior ───────────────────────────────────

echo "▶ Starting demo app (normal mode)..."
cd "$SCRIPT_DIR/sample-app"
PORT=3001 node server.js &
DEMO_PID=$!
cd "$ROOT_DIR"
sleep 2

echo "▶ Health check..."
curl -s http://localhost:3001/health
echo ""
echo ""

echo "═══════════════════════════════════════"
echo "  Run 1: Normal behavior (no regression)"
echo "═══════════════════════════════════════"
echo ""

export STAGING_BASE_URL="http://localhost:3001"

node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-source file \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001 || true

VERDICT_1=$(cat memory/runtime/verdict.json 2>/dev/null || echo '{"verdict":"ERROR"}')
echo ""
echo "Run 1 verdict: $(echo "$VERDICT_1" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo ""

# ─── Stop normal server ───────────────────────────────────────

kill "$DEMO_PID" 2>/dev/null || true
wait "$DEMO_PID" 2>/dev/null || true
sleep 1

# ─── Run 2: Simulated regression ─────────────────────────────

echo "═══════════════════════════════════════"
echo "  Run 2: Simulated regression (SIMULATE_SLOW=true)"
echo "═══════════════════════════════════════"
echo ""

echo "▶ Restarting demo app with SIMULATE_SLOW=true..."
cd "$SCRIPT_DIR/sample-app"
PORT=3001 SIMULATE_SLOW=true node server.js &
DEMO_PID=$!
cd "$ROOT_DIR"
sleep 2

echo "▶ Health check..."
curl -s http://localhost:3001/health
echo ""
echo ""

# Save Run 1 baseline so Run 2 can compare
if [ -f memory/runtime/probe-results.json ]; then
  # Convert probe results to baseline format
  node -e "
    import { readFileSync, writeFileSync } from 'fs';
    const results = JSON.parse(readFileSync('memory/runtime/probe-results.json','utf-8'));
    const baseline = {};
    for (const r of results.results) {
      baseline[r.probe_id] = r;
    }
    writeFileSync('memory/runtime/baseline.json', JSON.stringify(baseline, null, 2));
  "
  echo "✓ Baseline saved from Run 1"
  echo ""
fi

node runtime/index.js \
  --diff demo/sample-diff/change.diff \
  --log-source file \
  --log-path demo/sample-logs/access.log \
  --staging http://localhost:3001 || true

VERDICT_2=$(cat memory/runtime/verdict.json 2>/dev/null || echo '{"verdict":"ERROR"}')
echo ""
echo "Run 2 verdict: $(echo "$VERDICT_2" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo ""

# ─── Summary ──────────────────────────────────────────────────

echo "╔══════════════════════════════════════╗"
echo "║           Demo Summary               ║"
echo "╠══════════════════════════════════════╣"
printf "║  Run 1 (normal):     %-15s ║\n" "$(echo "$VERDICT_1" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
printf "║  Run 2 (slow):       %-15s ║\n" "$(echo "$VERDICT_2" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).verdict))")"
echo "╚══════════════════════════════════════╝"
echo ""
echo "See memory/runtime/ for full reports."
