#!/usr/bin/env bash
# Fire N real x402 payments to a merchant so its portal Activity/Payments have
# data — every one is a genuine /v2/verify + /v2/settle on Canton, NOT seeded.
#
# Drives the mortgage example end to end: bootstraps a funded payer on LocalNet,
# points the credit-bureau (the x402 "merchant") at YOUR merchant party + API
# key + facilitator, then POSTs /apply N times (each: 402 → payer signs 0.05 CC
# → facilitator settles → merchant_id = your project).
#
# Prereq: the multi-tenant facilitator + LocalNet running
#   (canton-x402-facilitator/scripts/dev-multitenant-up.sh), and an API key you
#   created in the portal for the project whose payout party is --party.
#
# Usage:
#   scripts/populate-settlements.sh --party <payout-party> --api-key <sk_…> \
#       [--count 10] [--facilitator http://localhost:8402]
#
# macOS/BSD sed (`-i ''`). LOCAL DEV ONLY.
set -euo pipefail

PARTY=""; API_KEY=""; COUNT=10; FACILITATOR="http://localhost:8402"
while [ $# -gt 0 ]; do case "$1" in
  --party)       PARTY="$2"; shift 2;;
  --api-key)     API_KEY="$2"; shift 2;;
  --count)       COUNT="$2"; shift 2;;
  --facilitator) FACILITATOR="$2"; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
[ -n "$PARTY" ] && [ -n "$API_KEY" ] || {
  echo "usage: $0 --party <payout-party> --api-key <sk_…> [--count N] [--facilitator URL]" >&2; exit 2; }

MORT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # examples/mortgage
SDK_ROOT="$(cd "$MORT_DIR/../.." && pwd)"                     # repo root
ENV_FILE="$MORT_DIR/.env"
cd "$SDK_ROOT"

log(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# 1. The example imports @chainsafe/x402-* — make sure they're built.
[ -f packages/x402-client/dist/index.mjs ] || { log "building workspace packages…"; pnpm -r --filter "./packages/*" build; }

# 2. Fresh funded payer + current network config (re-discovers the synchronizer,
#    so this is safe after a LocalNet reset). Writes examples/mortgage/.env.
log "bootstrapping a funded payer on LocalNet…"
node "$MORT_DIR/scripts/bootstrap-localnet.mjs"

# 3. Point the bureau (merchant) at YOUR party + key + facilitator.
sed -i '' "s|^FACILITATOR_URL=.*|FACILITATOR_URL=${FACILITATOR}|"   "$ENV_FILE"
sed -i '' "s|^FACILITATOR_API_KEY=.*|FACILITATOR_API_KEY=${API_KEY}|" "$ENV_FILE"
sed -i '' "s|^BUREAU_PARTY=.*|BUREAU_PARTY=${PARTY}|"               "$ENV_FILE"

# 4. Start bureau (:4001) + backend (:4002) fresh; stop them on exit.
log "starting credit-bureau + mortgage-backend…"
lsof -ti:4001,4002 2>/dev/null | xargs kill -9 2>/dev/null || true
pnpm --filter @chainsafe/x402-example-mortgage-bureau  dev >/tmp/populate-bureau.log  2>&1 &
pnpm --filter @chainsafe/x402-example-mortgage-backend dev >/tmp/populate-backend.log 2>&1 &
cleanup(){ lsof -ti:4001,4002 2>/dev/null | xargs kill -9 2>/dev/null || true; }
trap cleanup EXIT
# Wait for BOTH: the bureau's 402 (:4001) and the backend actually listening
# (:4002) — the backend (wallet-sdk payer init) is slower, and firing before it
# binds gives a connection-refused that would otherwise abort the run.
for i in $(seq 1 40); do
  # `|| true`: a connection-refused curl exits non-zero (would trip set -e on the
  # assignment) but still prints 000 via -w, which is exactly the "not up" sentinel.
  bu=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:4001/v1/credit-score?subject=probe" 2>/dev/null || true)
  be=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:4002/" 2>/dev/null || true)  # any non-000 = listening
  { [ "$bu" = 402 ] && [ "$be" != 000 ]; } && break
  sleep 2
  [ "$i" = 40 ] && { echo "apps did not come up — see /tmp/populate-{bureau,backend}.log" >&2; exit 1; }
done

# 5. Fire N payments. Individual payments may transiently fail on a fresh ledger
# (the payer's just-funded CC needs a mining round to become spendable), so
# disable errexit here and retry each payment a few times before giving up.
set +e
log "firing $COUNT payment(s) → $PARTY"
ok=0
for i in $(seq 1 "$COUNT"); do
  ssn=$(printf "888-77-%04d" $((1000 + i)))
  line=""
  for attempt in 1 2 3 4; do
    resp=$(curl -s --max-time 60 -XPOST localhost:4002/apply -H 'content-type: application/json' \
      -d "{\"name\":\"Applicant $i\",\"ssn\":\"$ssn\",\"propertyPrice\":500000,\"loanAmount\":400000}")
    line=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const p=j.payment;console.log(p&&p.settled?("settled "+String(p.updateId).slice(0,20)):("NOT settled — "+(j.error||JSON.stringify(j).slice(0,90))))}catch{console.log("bad response: "+d.slice(0,90))}})')
    case "$line" in settled*) break;; esac
    sleep 8   # let a mining round advance, then retry
  done
  printf '  [%s/%s] %s\n' "$i" "$COUNT" "$line"
  case "$line" in settled*) ok=$((ok + 1));; esac
done
set -e

printf '\n\033[1;32m✓ %s/%s settled to %s\033[0m\n' "$ok" "$COUNT" "$PARTY"
