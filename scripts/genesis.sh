#!/usr/bin/env bash
# One-time setup: create the genesis world and push the demo app (which carries canon.json) into it.
# The referee builds a Preview of genesis and makes it canon once every fact in its canon.json holds.
#   CANON_URL=https://canon-referee.<you>.workers.dev ./scripts/genesis.sh
# To start from an existing repo instead (it must contain canon.json at its root):
#   CANON_URL=... IMPORT_URL=https://github.com/<you>/<repo>.git ./scripts/genesis.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CANON_URL:?set CANON_URL to the referee origin}"
PROJECT="${CANON_PROJECT:-farmstand}"

body="$(node -e 'process.stdout.write(JSON.stringify(process.env.IMPORT_URL ? { importUrl: process.env.IMPORT_URL } : {}))')"
resp="$(curl -sf -X POST -H 'content-type: application/json' --data "$body" "$CANON_URL/p/$PROJECT/genesis")"
if [ -n "${IMPORT_URL:-}" ]; then
  echo "Imported $IMPORT_URL as genesis. Watch $CANON_URL/?p=$PROJECT until its facts go green."
  exit 0
fi
remote="$(node -e 'const r=JSON.parse(process.argv[1]); const u=new URL(r.remote); u.username="x"; u.password=r.token; console.log(u.toString())' "$resp")"

work="$(mktemp -d)"
cp -R demo-app/. "$work/"
rm -rf "$work/node_modules" "$work/.wrangler"
git -C "$work" init -q -b main
git -C "$work" add -A
git -C "$work" -c user.name=canon -c user.email=canon@canon.local commit -qm "genesis: farmstand"
git -C "$work" push -q "$remote" main
echo "Pushed genesis. Watch $CANON_URL/?p=$PROJECT until its facts go green."
