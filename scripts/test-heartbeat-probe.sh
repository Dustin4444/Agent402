#!/usr/bin/env bash
# Offline test for scripts/heartbeat-probe.sh — the shared heartbeat probe.
#
# The risky logic is record_observation()'s FAILS -> per-component mapping. Get
# it wrong and /status silently reports the wrong component down (or worse,
# reports a broken component as operational), which is the one thing a status
# page must never do. Everything here runs against a stubbed curl, so no
# request ever reaches production.
set -u

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; echo "       $2"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Stub curl: capture the POST body instead of sending it.
cat > "$TMP/curl" <<'EOF'
#!/usr/bin/env bash
body=""
while [ $# -gt 0 ]; do
  case "$1" in -d) body="$2"; shift 2;; *) shift;; esac
done
[ -n "$body" ] && printf '%s' "$body" > "$CAPTURE"
exit 0
EOF
chmod +x "$TMP/curl"
export PATH="$TMP:$PATH"
export CAPTURE="$TMP/body.json"
export PROD="https://example.invalid" RUN_URL="https://run" OP_TOKEN="test-token"

# shellcheck source=/dev/null
. "$(dirname "$0")/heartbeat-probe.sh"

field() { jq -r ".components[\"$1\"].ok" < "$CAPTURE"; }

echo "heartbeat probe — component mapping"

rm -f "$CAPTURE"; record_observation up "" >/dev/null
for c in api catalog mcp paywall rails paid-call; do
  v=$(field "$c")
  [ "$v" = "true" ] && ok "up: $c is operational" || bad "up: $c is operational" "got $v"
done

rm -f "$CAPTURE"; record_observation down "/mcp" >/dev/null
[ "$(field mcp)" = "false" ] && ok "down(/mcp): mcp marked down" || bad "down(/mcp): mcp marked down" "got $(field mcp)"
for c in api catalog paywall rails paid-call; do
  v=$(field "$c")
  [ "$v" = "true" ] && ok "down(/mcp): $c stays operational" || bad "down(/mcp): $c stays operational" "got $v"
done

# A failing check must never drag unrelated components down with it.
rm -f "$CAPTURE"; record_observation down "catalog(12) rails(base-missing:)" >/dev/null
[ "$(field catalog)" = "false" ] && ok "multi: catalog down" || bad "multi: catalog down" "got $(field catalog)"
[ "$(field rails)" = "false" ]   && ok "multi: rails down"   || bad "multi: rails down"   "got $(field rails)"
[ "$(field api)" = "true" ]      && ok "multi: api unaffected" || bad "multi: api unaffected" "got $(field api)"
[ "$(field mcp)" = "true" ]      && ok "multi: mcp unaffected" || bad "multi: mcp unaffected" "got $(field mcp)"

rm -f "$CAPTURE"; record_observation down "pow-paid-call" >/dev/null
[ "$(field paid-call)" = "false" ] && ok "paid-call failure maps to paid-call" || bad "paid-call failure maps to paid-call" "got $(field paid-call)"
[ "$(field paywall)" = "true" ]    && ok "paid-call failure leaves paywall up" || bad "paid-call failure leaves paywall up" "got $(field paywall)"

# The retired-converter checks share the substring "paywall(" with the real
# paywall check. They must not be confused for each other.
rm -f "$CAPTURE"; record_observation down "retired-convert-paywall(200)" >/dev/null
v=$(field paywall)
[ "$v" = "false" ] && ok "retired-convert failure flags the paywall component" \
  || bad "retired-convert failure flags the paywall component" "got $v (a free-serving regression must show somewhere)"

# The observation carries a source and a timestamp, or the store cannot order it.
rm -f "$CAPTURE"; record_observation up "" >/dev/null
[ "$(jq -r .source < "$CAPTURE")" = "heartbeat" ] && ok "observation names its source" || bad "observation names its source" "missing"
ts=$(jq -r .ts < "$CAPTURE")
[ "$ts" -gt 1700000000000 ] 2>/dev/null && ok "observation carries a ms timestamp" || bad "observation carries a ms timestamp" "got $ts"

# Without a token it must no-op rather than POST unauthenticated.
rm -f "$CAPTURE"; OP_TOKEN="" record_observation up "" >/dev/null
[ ! -f "$CAPTURE" ] && ok "no token: records nothing" || bad "no token: records nothing" "posted anyway"

echo
if [ "$FAIL" -eq 0 ]; then echo "all passed ($PASS)"; else echo "FAILED ($FAIL of $((PASS+FAIL)))"; fi
[ "$FAIL" -eq 0 ]
