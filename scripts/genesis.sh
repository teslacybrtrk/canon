#!/usr/bin/env bash
# One-time setup: create the genesis world and push the demo app (which carries canon.json) into it.
# The referee builds a Preview of genesis and makes it canon once every fact in its canon.json holds.
#   CANON_URL=https://canon-referee.<you>.workers.dev ./scripts/genesis.sh   (with CANON_KEY, the owner key, exported)
# A different canon.json for this project (e.g. a backlog with autopilot):
#   CANON_PROJECT=rodeo CANON_FILE=agents/canon.autopilot.json ./scripts/genesis.sh
# To start from an existing repo instead (it must contain canon.json at its root):
#   CANON_URL=... IMPORT_URL=https://github.com/<you>/<repo>.git ./scripts/genesis.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CANON_URL="${CANON_URL:-https://canon.rodeo}"
# The owner key: from the environment, or from the Keychain where scripts/keys.sh keeps it.
CANON_KEY="${CANON_KEY:-$(security find-generic-password -a canon -s canon-owner-key -w 2>/dev/null || true)}"
: "${CANON_KEY:?set CANON_KEY to the owner key, or run ./scripts/keys.sh}"
PROJECT="${CANON_PROJECT:-farmstand}"

body="$(node -e 'process.stdout.write(JSON.stringify(process.env.IMPORT_URL ? { importUrl: process.env.IMPORT_URL } : {}))')"
# The key goes in on stdin, so it never shows up in the process list.
if ! resp="$(printf 'authorization: Bearer %s\n' "$CANON_KEY" | curl -sS --fail-with-body -X POST -H @- -H 'content-type: application/json' --data "$body" "$CANON_URL/p/$PROJECT/genesis")"; then
  echo "genesis failed: $resp" >&2
  exit 1
fi
if [ -n "${IMPORT_URL:-}" ]; then
  echo "Imported $IMPORT_URL as genesis. Watch $CANON_URL/?p=$PROJECT until its facts go green."
  exit 0
fi
remote="$(node -e 'const r=JSON.parse(process.argv[1]); const u=new URL(r.remote); u.username="x"; u.password=r.token; console.log(u.toString())' "$resp")"

work="$(mktemp -d)"
cp -R demo-app/. "$work/"
rm -rf "$work/node_modules" "$work/.wrangler"
[ -n "${CANON_FILE:-}" ] && cp "$CANON_FILE" "$work/canon.json"
git -C "$work" init -q -b main
git -C "$work" add -A
git -C "$work" -c user.name=canon -c user.email=canon@canon.local commit -qm "genesis: farmstand"
git -C "$work" push -q "$remote" main
echo "Pushed genesis. Watch $CANON_URL/?p=$PROJECT until its facts go green."
