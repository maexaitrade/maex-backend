#!/usr/bin/env bash
# End-to-end demo of the MAEX Trade API. Assumes the server is running on :4000
# and an admin exists (admin@maex.test / admin123).
#
# Flow: Alice -> Bob -> Carol referral chain. Alice & Bob fund and buy packages
# so they are "active" earners, then Carol deposits and buys — which pays
# referral up the chain, checks the booster, and recomputes ranks. Finally we
# run the daily ROI job.
set -e
B=localhost:4000/api
g() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

login()    { curl -s $B/auth/login    -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
register() { curl -s "$B/auth/register${3:+?ref=$3}" -H 'content-type: application/json' -d "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"secret1\"}"; }
deposit()  { curl -s $B/deposits -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"amount\":$2,\"tx_hash\":\"0x$3\"}"; }
confirm()  { curl -s -X PATCH $B/admin/deposits/$2 -H "authorization: Bearer $1" -H 'content-type: application/json' -d '{"action":"confirm"}'; }
buy()      { curl -s $B/packages/buy -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"amount\":$2}"; }

ADMIN=$(login admin@maex.test admin123 | g "['token']")

# register chain
A=$(register Alice alice@t.com);        AID=$(echo "$A"|g "['user']['id']"); AT=$(echo "$A"|g "['token']")
Bo=$(register Bob   bob@t.com   "$AID"); BID=$(echo "$Bo"|g "['user']['id']"); BT=$(echo "$Bo"|g "['token']")
C=$(register Carol carol@t.com "$BID");  CID=$(echo "$C"|g "['user']['id']"); CT=$(echo "$C"|g "['token']")
echo "Registered: Alice=$AID Bob=$BID Carol=$CID"

# Alice funds $2000 and buys a $2000 package (active earner)
confirm "$ADMIN" "$(deposit "$AT" 2000 ALICE | g "['id']")" >/dev/null
buy "$AT" 2000 >/dev/null
# Bob funds $1000 and buys (active earner). This deposit pays Alice L1 referral.
confirm "$ADMIN" "$(deposit "$BT" 1000 BOB | g "['id']")" >/dev/null
buy "$BT" 1000 >/dev/null
# Carol funds $1000, buys. Her deposit pays Bob L1 + Alice L2 referral.
confirm "$ADMIN" "$(deposit "$CT" 1000 CAROL | g "['id']")" >/dev/null
buy "$CT" 1000 >/dev/null
echo "All three funded and bought packages."

# Run daily ROI
echo; echo "== Daily ROI =="
( cd "$(dirname "$0")/.." && node scripts/runRoi.js )

echo "$ADMIN" > /tmp/maex_admin_token
