#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
#   BASE_URL=https://app12.breakthruventures.ai ./scripts/smoke.sh
#
# Customer side (always): public menu, sign-up of customers A and B, same-origin and auth checks, an order placed
# twice with one idempotency key (one order), prices the client sends are ignored, B can't see A's order (404), a
# customer can't use staff endpoints or become staff through sign-up.
# Staff side (only with SMOKE_STAFF_EMAIL and SMOKE_STAFF_PASSWORD, seeded in CI by `pnpm db:seed`): the allergen
# confirmation at checkout, an allergy-alert order can't be accepted before the acknowledgment (409), the staff
# acknowledge, then accept; the allergen PUT needs verified: true.
# Not covered yet: A's live stream (issue 12.2) and the menu assistant (issue 12.3); they add their own checks.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_C="$(mktemp)"; JAR_S="$(mktemp)"; OUT="$(mktemp)"
CLEANUP_ITEMS=()
trap 'rm -f "$JAR_A" "$JAR_B" "$JAR_C" "$JAR_S" "$OUT"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# req METHOD PATH JAR [JSON_BODY]: sets STATUS and BODY. Mutations carry our own Origin, as a browser would.
req() {
  local method=$1 path=$2 jar=$3 body=${4-}
  local args=(-s -o "$OUT" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar" -H "origin: $BASE_URL")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  STATUS=$(curl "${args[@]}" "$BASE_URL$path") || fail "$method $path: curl failed"
  BODY=$(cat "$OUT")
}
expect() { # expect STATUS WHAT
  [ "$STATUS" = "$1" ] || fail "$2: expected $1, got $STATUS ($BODY)"
}
# json 'expression on j': print a value from $BODY.
json() { node -e 'const j = JSON.parse(process.argv[1]); const v = eval(process.argv[2]); console.log(v === undefined ? "" : v)' "$BODY" "$1"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

# --- Public menu ------------------------------------------------------------------------------------------------
STATUS=$(curl -s -o "$OUT" -w '%{http_code}' "$BASE_URL/api/menu"); BODY=$(cat "$OUT")
expect 200 "public menu"
[ "$(json 'Array.isArray(j.categories) && typeof j.acceptingOrders === "boolean"')" = "true" ] || fail "menu has no categories/acceptingOrders: $BODY"
echo "$BODY" | grep -Eq '"(version|allergensVerifiedBy|archivedAt)"' && fail "public menu leaks staff fields"
if [ "$(json 'j.categories.some((c) => c.items.length > 0)')" = "true" ]; then
  [ "$(json 'j.categories.flatMap((c) => c.items).every((i) => Array.isArray(i.allergens) && "allergensCheck" in i)')" = "true" ] || fail "menu items lack allergen declarations"
fi
MENU="$BODY"
pass "public menu loads with structured allergen declarations and no staff fields"

# --- Accounts -----------------------------------------------------------------------------------------------------
signup() {
  local jar=$1 email=$2 extra=${3-}
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"$extra}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}
signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "customers A and B signed up"

# --- Boundary rules -------------------------------------------------------------------------------------------------
KEY=$(uuid)
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/orders")
[ "$code" = "401" ] || fail "anonymous order should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$BASE_URL/api/orders")
[ "$code" = "403" ] || fail "cross-origin order should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -d '{}' "$BASE_URL/api/orders")
[ "$code" = "403" ] || fail "order without an Origin should be 403, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/orders")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/orders")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
req POST /api/orders "$JAR_A" '{"lines":[],"pickupName":"x","allergy":{"has":false},"idempotencyKey":"'"$KEY"'"}'
expect 400 "empty order"
pass "anonymous, cross-origin, malformed, oversized and invalid orders refused"

# --- Customers can't use staff endpoints or become staff ------------------------------------------------------------
req PATCH /api/settings "$JAR_A" '{"acceptingOrders":false}'
expect 403 "customer closing the restaurant"
req POST /api/menu/categories "$JAR_A" '{"name":"Nope"}'
expect 403 "customer creating a category"
req GET /api/menu/items "$JAR_A"
expect 403 "customer reading the staff menu"
req GET /api/admin/stats "$JAR_A"
expect 403 "customer reading admin stats"
# Sign-up can't choose a role: whether it ignores the field or refuses it, the new account isn't staff.
curl -s -c "$JAR_C" -b "$JAR_C" -o /dev/null -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d "{\"email\":\"smoke-c-$RUN_ID@example.test\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\",\"role\":\"staff\"}" "$BASE_URL/api/auth/sign-up/email" || true
if [ -s "$JAR_C" ] && grep -q session "$JAR_C"; then
  req PATCH /api/settings "$JAR_C" '{"acceptingOrders":false}'
  expect 403 "sign-up with role staff must not give staff powers"
fi
pass "customers refused on staff endpoints; sign-up with a role stays a customer"

# --- Staff setup (optional) -----------------------------------------------------------------------------------------
HAVE_STAFF=no
if [ -n "${SMOKE_STAFF_EMAIL:-}" ] && [ -n "${SMOKE_STAFF_PASSWORD:-}" ]; then
  curl -fsS -c "$JAR_S" -b "$JAR_S" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$SMOKE_STAFF_EMAIL\",\"password\":\"$SMOKE_STAFF_PASSWORD\"}" "$BASE_URL/api/auth/sign-in/email" >/dev/null || fail "staff sign-in failed"
  HAVE_STAFF=yes
  req GET /api/menu/items "$JAR_S"
  expect 200 "staff reading the menu editor list"
  CAT=$(json 'j.categories[0]?.id')
  if [ -z "$CAT" ]; then
    req POST /api/menu/categories "$JAR_S" '{"name":"Smoke tests"}'
    expect 201 "staff creating a category"
    CAT=$(json 'j.category.id')
  fi
  req PATCH /api/settings "$JAR_S" '{"acceptingOrders":true}'
  expect 200 "staff opening the restaurant"
  # A dish that declares peanuts, so the allergy flow has something to match.
  req POST /api/menu/items "$JAR_S" '{"categoryId":"'"$CAT"'","name":"Smoke peanut noodles '"$RUN_ID"'","priceCents":1250}'
  expect 201 "staff creating an item"
  ITEM=$(json 'j.item.id'); IVER=$(json 'j.item.version'); CLEANUP_ITEMS+=("$ITEM")
  req PUT "/api/menu/items/$ITEM/allergens" "$JAR_S" '{"version":'"$IVER"',"allergens":[{"allergen":"peanuts","level":"contains"}]}'
  expect 400 "allergen PUT without verified: true"
  req PUT "/api/menu/items/$ITEM/allergens" "$JAR_S" '{"version":'"$IVER"',"verified":true,"allergens":[{"allergen":"peanuts","level":"contains"}]}'
  expect 200 "allergen PUT with verified: true"
  req PUT "/api/menu/items/$ITEM/allergens" "$JAR_A" '{"version":1,"verified":true,"allergens":[]}'
  expect 403 "customer editing allergens"
  pass "staff set up a dish with a verified peanut declaration (and the PUT refuses without verified: true)"
  UNIT=1250
else
  # No staff credentials (a live URL): order the first dish that is on the menu and not sold out.
  ITEM=$(MENU_JSON="$MENU" node -e 'const j = JSON.parse(process.env.MENU_JSON); const i = j.categories.flatMap((c) => c.items).find((i) => !i.soldOut); console.log(i ? i.id : "")')
  UNIT=$(MENU_JSON="$MENU" node -e 'const j = JSON.parse(process.env.MENU_JSON); const i = j.categories.flatMap((c) => c.items).find((i) => !i.soldOut); console.log(i ? i.priceCents : "")')
  [ -n "$ITEM" ] || fail "the menu has no orderable dish: load the demo (admin button) or set SMOKE_STAFF_EMAIL and SMOKE_STAFF_PASSWORD"
  echo "note - no SMOKE_STAFF_* set: staff steps skipped"
fi

# --- Ordering: idempotency, server-side prices, privacy --------------------------------------------------------------
ORDER='{"lines":[{"itemId":"'"$ITEM"'","qty":2,"unitPriceCents":1,"priceCents":1}],"pickupName":"Smoke","allergy":{"has":false},"subtotalCents":1,"idempotencyKey":"'"$KEY"'"}'
req POST /api/orders "$JAR_A" "$ORDER"
expect 201 "first order"
OID=$(json 'j.order.id'); OVER=$(json 'j.order.version')
[ "$(json 'j.order.subtotalCents')" = "$((UNIT * 2))" ] || fail "client-sent prices must be ignored: expected $((UNIT * 2)) cents, got $BODY"
pass "A placed an order; the total came from the menu, not from the client"

req POST /api/orders "$JAR_A" "$ORDER"
expect 200 "same idempotency key"
[ "$(json 'j.order.id')" = "$OID" ] || fail "same idempotency key returned a different order"
req GET /api/orders "$JAR_A"
expect 200 "A's order list"
[ "$(json 'j.orders.filter((o) => o.id === "'"$OID"'").length')" = "1" ] || fail "the same key created more than one order"
pass "the same idempotency key yields one order"

req GET "/api/orders/$OID" "$JAR_B"
expect 404 "B reading A's order"
req GET /api/orders "$JAR_B"
expect 200 "B's order list"
echo "$BODY" | grep -q "$OID" && fail "B's list contains A's order"
req POST "/api/orders/$OID/transition" "$JAR_B" '{"to":"cancelled","version":'"$OVER"'}'
expect 404 "B cancelling A's order"
req GET "/api/orders/$OID" "$JAR_A"
expect 200 "A reading their own order"
req POST "/api/orders/$OID/transition" "$JAR_A" '{"to":"accepted","version":'"$OVER"'}'
expect 403 "customer accepting their own order"
pass "B gets 404 on A's order; a customer can't accept an order"

if [ "$HAVE_STAFF" = yes ]; then
  # --- The allergy flow --------------------------------------------------------------------------------------------------
  AKEY=$(uuid)
  ALLERGY_ORDER() { echo '{"lines":[{"itemId":"'"$ITEM"'","qty":1}],"pickupName":"Smoke","allergy":{"has":true,"allergens":["peanuts"],"note":"smoke test","confirmWithStaff":'"$1"'},"idempotencyKey":"'"$AKEY"'"}'; }
  req POST /api/orders "$JAR_B" "$(ALLERGY_ORDER false)"
  expect 409 "an order with a matching dish needs the customer's confirmation"
  [ "$(json 'j.details.code')" = "allergy_confirmation_required" ] || fail "409 should carry allergy_confirmation_required: $BODY"
  req POST /api/orders "$JAR_B" "$(ALLERGY_ORDER true)"
  expect 201 "allergy order with confirmation"
  AID=$(json 'j.order.id'); AVER=$(json 'j.order.version')
  [ "$(json 'j.order.allergy.alert')" = "true" ] || fail "allergy alert missing: $BODY"
  pass "the allergy question: matching dish refused until B confirms, then the alert is stored"

  req POST "/api/orders/$AID/transition" "$JAR_S" '{"to":"accepted","version":'"$AVER"'}'
  expect 409 "accepting an unacknowledged allergy alert"
  req POST "/api/orders/$AID/allergy-ack" "$JAR_B" '{}'
  expect 403 "customer acknowledging their own alert"
  req POST "/api/orders/$AID/allergy-ack" "$JAR_S" '{}'
  expect 200 "staff acknowledging the alert"
  AVER=$(json 'j.order.version')
  req POST "/api/orders/$AID/transition" "$JAR_S" '{"to":"accepted","version":'"$AVER"'}'
  expect 200 "accepting after the acknowledgment"
  pass "an allergy-alert order can't be accepted before the acknowledgment (409); after it, it can"

  req POST "/api/orders/$AID/transition" "$JAR_S" '{"to":"cancelled","version":'"$(json 'j.order.version')"',"reason":"smoke test cleanup"}'
  expect 200 "staff cancelling the smoke allergy order"
  req POST "/api/orders/$OID/transition" "$JAR_S" '{"to":"cancelled","version":'"$OVER"',"reason":"smoke test cleanup"}'
  expect 200 "staff cancelling the smoke order"
  for id in "${CLEANUP_ITEMS[@]}"; do
    req DELETE "/api/menu/items/$id" "$JAR_S"
    expect 204 "archiving the smoke dish"
  done
else
  req POST "/api/orders/$OID/transition" "$JAR_A" '{"to":"cancelled","version":'"$OVER"'}'
  expect 200 "customer cancelling while placed"
  pass "A cancelled their order while it was placed"
fi

echo "SMOKE PASS"
