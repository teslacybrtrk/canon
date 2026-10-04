#!/usr/bin/env bash
# Reset a project after a rehearsal: delete its world repos and their Previews, put
# production back to the local demo app, then bump REFEREE_EPOCH and redeploy the referee
# so the board starts empty. Afterwards run scripts/genesis.sh again.
#   ./scripts/reset-project.sh farmstand
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${1:?usage: reset-project.sh <project>}"
NAMESPACE=canon
CANON_URL="${CANON_URL:-https://canon.rodeo}"

# Every Preview the referee judged (one per pushed commit), before the board is reset.
previews="$(curl -sf "$CANON_URL/p/$PROJECT/previews" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const n of JSON.parse(s))console.log(n)}catch{}})')"
for name in $previews; do
  (cd demo-app && npx wrangler preview delete --name "$name" >/dev/null 2>&1) && echo "deleted preview $name" || true
done

repos="$(cd referee && npx wrangler artifacts repos list --namespace "$NAMESPACE" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));for(const x of j)if(x.name.startsWith(process.argv[1]+"-"))console.log(x.name)})' "$PROJECT")"
for repo in $repos; do
  (cd referee && npx wrangler artifacts repos delete "$repo" --namespace "$NAMESPACE" --force >/dev/null 2>&1) && echo "deleted repo $repo"
  (cd demo-app && npx wrangler preview delete --name "$repo" >/dev/null 2>&1) && echo "deleted preview $repo" || true
done

(cd demo-app && npx wrangler deploy >/dev/null 2>&1) && echo "production reset to the local demo app"

epoch="$(node -e 'const s=require("fs").readFileSync("referee/wrangler.jsonc","utf8");console.log(Number(s.match(/"REFEREE_EPOCH": "(\d+)"/)[1])+1)')"
sed -i '' -E "s/\"REFEREE_EPOCH\": \"[0-9]+\"/\"REFEREE_EPOCH\": \"$epoch\"/" referee/wrangler.jsonc
(cd referee && npx wrangler deploy >/dev/null 2>&1) && echo "referee redeployed with REFEREE_EPOCH=$epoch (empty board)"
echo "Next: CANON_URL=https://canon.rodeo ./scripts/genesis.sh"
