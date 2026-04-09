#!/usr/bin/env bash
# Generates realistic traffic against the demo app so Jaeger has traces to mine.
# Usage: bash demo/traffic-generator.sh [base_url] [num_requests]

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
NUM="${2:-100}"

echo "▶ Generating $NUM requests against $BASE_URL ..."

for i in $(seq 1 "$NUM"); do
  # Mix of request types matching the demo access.log distribution
  RAND=$((RANDOM % 100))

  if [ "$RAND" -lt 60 ]; then
    # 60% — GET /api/orders?status=pending&limit=100
    curl -s "$BASE_URL/api/orders?status=pending&limit=100" > /dev/null &
  elif [ "$RAND" -lt 76 ]; then
    # 16% — GET /api/orders?status=completed&limit=50
    curl -s "$BASE_URL/api/orders?status=completed&limit=50" > /dev/null &
  elif [ "$RAND" -lt 86 ]; then
    # 10% — GET /api/orders/:id (random ID)
    ID=$((RANDOM % 9000 + 1000))
    curl -s "$BASE_URL/api/orders/$ID" > /dev/null &
  elif [ "$RAND" -lt 94 ]; then
    # 8% — POST /api/orders
    curl -s -X POST "$BASE_URL/api/orders" \
      -H "Content-Type: application/json" \
      -d "{\"user_id\": $((RANDOM % 100 + 1)), \"total\": $((RANDOM % 500 + 10)).99, \"priority\": \"normal\"}" > /dev/null &
  elif [ "$RAND" -lt 98 ]; then
    # 4% — GET /api/users/:id/orders
    UID_VAL=$((RANDOM % 200 + 1))
    curl -s "$BASE_URL/api/users/$UID_VAL/orders" > /dev/null &
  else
    # 2% — GET /health
    curl -s "$BASE_URL/health" > /dev/null &
  fi

  # Rate limit: ~20 req/sec
  if (( i % 20 == 0 )); then
    wait
    echo "  [$i/$NUM] requests sent"
  fi
done

wait
echo "✓ All $NUM requests sent to $BASE_URL"
