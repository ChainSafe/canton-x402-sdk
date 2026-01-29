#!/usr/bin/env bash
# Start all 3 example servers concurrently.
# Press Ctrl-C to stop all.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping all servers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "All servers stopped."
}
trap cleanup EXIT INT TERM

echo "Starting example servers..."
echo ""

npx tsx "$SCRIPT_DIR/token-gated-docs/src/server.ts" &
PIDS+=($!)

npx tsx "$SCRIPT_DIR/cc-transfer-service/src/server.ts" &
PIDS+=($!)

npx tsx "$SCRIPT_DIR/balance-inquiry/src/server.ts" &
PIDS+=($!)

echo ""
echo "All servers starting:"
echo "  Token-Gated Docs:    http://localhost:4010"
echo "  CC Transfer Service: http://localhost:4020"
echo "  Balance Inquiry:     http://localhost:4030"
echo ""
echo "Press Ctrl-C to stop all servers."

wait
