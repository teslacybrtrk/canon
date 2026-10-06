#!/usr/bin/env bash
# Reset a project after a rehearsal: delete its attempt repos and their Previews, put
# production back to the local demo app, then bump REFEREE_EPOCH and redeploy the referee
# so the board starts empty. Afterwards run scripts/genesis.sh again.
#   ./scripts/reset-project.sh farmstand rodeo
# REFEREE_EPOCH is global, so every project's board empties; list every project you use.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: reset-project.sh <project> [project...]"; exit 1; }
NAMESPACE=canon
source scripts/env.sh
for PROJECT in "$@"; do

# Every Preview the referee judged (one per pushed commit), before the board is reset.
previews="$(curl -sf "$CANON_URL/p/$PROJECT/previews" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const n of JSON.parse(s))console.log(n)}catch{}})')"
# Deletions run 8 at a time: each one is a separate wrangler call that takes a few seconds.
printf '%s\n' $previews | xargs -P 8 -I{} sh -c 'cd demo-app && npx wrangler preview delete --name "$1" >/dev/null 2>&1 && echo "deleted preview $1" || true' _ {}

repos="$(cd referee && npx wrangler artifacts repos list --namespace "$NAMESPACE" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));for(const x of j)if(x.name.startsWith(process.argv[1]+"-"))console.log(x.name)})' "$PROJECT")"
printf '%s\n' $repos | xargs -P 8 -I{} sh -c '
  (cd referee && npx wrangler artifacts repos delete "$1" --namespace "$2" --force >/dev/null 2>&1) && echo "deleted repo $1"
  (cd demo-app && npx wrangler preview delete --name "$1" >/dev/null 2>&1) && echo "deleted preview $1" || true' _ {} "$NAMESPACE"

done

# Each project's production is its own Worker (see PRODUCTION_URL); put every one back to the demo app.
for PROJECT in "$@"; do
  (cd demo-app && npx wrangler deploy --name "$PROJECT" >/dev/null 2>&1) && echo "production for $PROJECT reset to the local demo app"
done

epoch="$(node -e 'const s=require("fs").readFileSync("referee/wrangler.jsonc","utf8");console.log(Number(s.match(/"REFEREE_EPOCH": "(\d+)"/)[1])+1)')"
node -e 'const f="referee/wrangler.jsonc",fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/"REFEREE_EPOCH": "\d+"/,`"REFEREE_EPOCH": "${process.argv[1]}"`))' "$epoch"
(cd referee && npx wrangler deploy >/dev/null 2>&1) && echo "referee redeployed with REFEREE_EPOCH=$epoch (empty board)"
echo "Next: ./scripts/genesis.sh"
