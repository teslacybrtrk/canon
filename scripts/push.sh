#!/usr/bin/env bash
# Push main to both remotes: Cloudflare Artifacts (canon-src/canon, the main remote) and the GitHub mirror.
# The Artifacts write token is minted for 10 minutes, used once, and never stored or printed.
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE="https://2d9aba350caa70abf3ce6c910950ffd0.artifacts.cloudflare.net/git/canon-src/canon.git"
token="$(cd referee && npx wrangler artifacts repos issue-token canon --namespace canon-src --scope write --ttl 600 --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(String(j.plaintext??"").split("?expires=")[0])})')"
[ -n "$token" ] || { echo "could not mint an Artifacts token"; exit 1; }
git -c http.extraHeader="Authorization: Bearer $token" push -q "$REMOTE" main && echo "pushed to Artifacts (canon-src/canon)"
git push -q github main && echo "pushed to GitHub mirror"
