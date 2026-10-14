#!/usr/bin/env bash
# Checks everything Canon needs before (or after) ./scripts/setup.sh, and says exactly how to fix what's missing.
# Read-only: it changes nothing on your machine or your Cloudflare account.
#   ./scripts/doctor.sh
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0; warn=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n      fix: %s\n' "$1" "$2"; fail=$((fail + 1)); }
note() { printf '  \033[33m!\033[0m %s\n      %s\n' "$1" "$2"; warn=$((warn + 1)); }

echo "Your machine"
if command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  ok "Node $(node -v) (22.18 or newer runs Canon's TypeScript directly)"
else
  bad "Node 22.18 or newer is needed (found: $(node -v 2>/dev/null || echo none))" "install a current Node from nodejs.org, or: nvm install 22"
fi
command -v git >/dev/null && ok "git $(git --version | awk '{print $3}')" || bad "git is missing" "install git (agents push with plain Git)"
if [ -d referee/node_modules/wrangler ]; then ok "the referee's dependencies are installed"; else bad "the referee's dependencies aren't installed" "(cd referee && npm install)"; fi
command -v claude >/dev/null && ok "Claude Code is installed (for ./agents/run.sh)" || note "Claude Code (claude) isn't installed" "only needed to run the demo's agents: npm install -g @anthropic-ai/claude-code"

echo "Your Cloudflare account"
WHO="$(cd referee && npx wrangler whoami 2>&1)"
if echo "$WHO" | grep -qi "not authenticated\|You are not logged in"; then
  bad "wrangler isn't logged in" "npx wrangler login"
else
  ok "wrangler is logged in"
  ACCOUNT="$(node -e 'const s=require("fs").readFileSync("referee/wrangler.jsonc","utf8");const m=s.match(/"account_id":\s*"([0-9a-f]{32})"/);process.stdout.write(m?m[1]:"")')"
  # A login that can see several accounts makes some wrangler commands ask which one: name it.
  [ -n "$ACCOUNT" ] && export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
  if [ -z "$ACCOUNT" ]; then bad "referee/wrangler.jsonc has no account_id" "./scripts/setup.sh writes it"
  elif echo "$WHO" | grep -q "$ACCOUNT"; then ok "referee/wrangler.jsonc's account ($ACCOUNT) is one you're logged in to"
  else bad "referee/wrangler.jsonc names account $ACCOUNT, which this login can't see" "./scripts/setup.sh with your own account, or log in to the right one"; fi
  if (cd referee && npx wrangler r2 bucket list 2>/dev/null | grep -q canon-ci-snapshots); then ok "R2 bucket canon-ci-snapshots exists (CI snapshots)"
  else bad "R2 bucket canon-ci-snapshots is missing (or R2 isn't enabled)" "enable R2 in the dashboard, then: (cd referee && npx wrangler r2 bucket create canon-ci-snapshots)"; fi
  if (cd referee && npx wrangler artifacts repos list --namespace canon >/dev/null 2>&1); then ok "Artifacts is enabled on this account"
  else bad "Artifacts isn't reachable on this account" "Artifacts is in open beta on Workers Paid: enable it in the dashboard (Workers & Pages > Artifacts)"; fi
  SECRETS="$(cd referee && npx wrangler secret list 2>/dev/null)"
  for s in CF_TOKEN R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    echo "$SECRETS" | grep -q "\"$s\"" && ok "secret $s is set on the referee" || bad "secret $s isn't set on the referee" "(cd referee && npx wrangler secret put $s)  (setup.sh says which token each is)"
  done
fi

echo "Canon itself"
source scripts/env.sh >/dev/null 2>&1 || true
if [ -n "${CANON_URL:-}" ] && curl -sf "$CANON_URL/meta" >/dev/null; then ok "the referee answers at $CANON_URL"
else bad "the referee doesn't answer${CANON_URL:+ at $CANON_URL}" "deploy it: (cd referee && npx wrangler deploy), or run ./scripts/setup.sh"; fi
if [ -n "$(keychain canon-owner-key 2>/dev/null)" ] && [ -n "$(keychain canon-agent-key 2>/dev/null)" ]; then ok "the owner and agent keys are stored (Keychain or ~/.config/canon)"
else bad "Canon's keys aren't stored" "./scripts/keys.sh"; fi

echo
if [ "$fail" -eq 0 ]; then echo "All set: $pass checks passed$([ "$warn" -gt 0 ] && echo ", $warn note(s)"). Next: ./scripts/genesis.sh"; else echo "$fail problem(s) to fix, $pass checks passed. Fix them in order, then run ./scripts/doctor.sh again."; fi
exit $((fail > 0))
