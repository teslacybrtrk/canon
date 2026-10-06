#!/usr/bin/env bash
# Your own Canon referee on your Cloudflare account, in one go. Run it once from a fresh clone:
#   ./scripts/setup.sh
# You need Workers Paid with Artifacts (open beta), R2 and Containers enabled, Node 22.18+, and `npx wrangler login` done.
# It writes your account into referee/wrangler.jsonc, creates the CI snapshot bucket, deploys the referee,
# asks for three Cloudflare secrets, and makes Canon's two keys (scripts/keys.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' || { echo "Canon needs Node 22.18 or newer (it runs TypeScript directly)."; exit 1; }
(cd referee && npm install --no-audit --no-fund >/dev/null)

echo "Your Cloudflare accounts:"
(cd referee && npx wrangler whoami 2>/dev/null | grep "│" || true)
read -rp "Account ID: " ACCOUNT
read -rp "Your workers.dev subdomain (the part before .workers.dev): " SUB
read -rp "A custom domain for the board, if you have one on this account (Enter to skip): " DOMAIN
read -rp "Your app's Worker name, from its wrangler config [farmstand, the demo]: " APP
APP="${APP:-farmstand}"
[[ "$ACCOUNT" =~ ^[0-9a-f]{32}$ ]] || { echo "That isn't an account ID (32 hex characters)."; exit 1; }
[[ "$SUB" =~ ^[a-z0-9-]+$ ]] || { echo "Just the subdomain, e.g. my-team for my-team.workers.dev."; exit 1; }

node - "$ACCOUNT" "$SUB" "$DOMAIN" "$APP" <<'EOF'
const fs = require("fs");
const [account, sub, domain, app] = process.argv.slice(2);
const file = "referee/wrangler.jsonc";
let s = fs.readFileSync(file, "utf8");
const set = (re, value) => { if (!re.test(s)) throw new Error(`referee/wrangler.jsonc: no match for ${re}`); s = s.replace(re, value); };
set(/"account_id": "[^"]*"/, `"account_id": "${account}"`);
set(/"CLOUDFLARE_ACCOUNT_ID": "[^"]*"/, `"CLOUDFLARE_ACCOUNT_ID": "${account}"`);
set(/"PREVIEW_URL_TEMPLATE": "[^"]*"/, `"PREVIEW_URL_TEMPLATE": "https://{name}-${app}.${sub}.workers.dev"`);
set(/"PRODUCTION_URL": "[^"]*"/, `"PRODUCTION_URL": "https://{project}.${sub}.workers.dev"`);
// Re-runnable: the routes line may already be gone. Without a domain, the board lives on workers.dev.
s = s.replace(/  "routes": \[.*\],\n/, "");
s = s.replace(/  "workers_dev": (true|false),\n/, `${domain ? `  "routes": [{ "pattern": "${domain}", "custom_domain": true }],\n` : ""}  "workers_dev": ${!domain},\n`);
// canon.rodeo serves Canon's own source from a namespace your account doesn't have.
set(/"SOURCE_PUBLIC": "[^"]*"/, `"SOURCE_PUBLIC": "false"`);
fs.writeFileSync(file, s);
EOF
echo "Wrote your account into referee/wrangler.jsonc."

cd referee
npx wrangler r2 bucket create canon-ci-snapshots >/dev/null 2>&1 && echo "Created the R2 bucket canon-ci-snapshots." || echo "R2 bucket canon-ci-snapshots is already there."
npx wrangler deploy
echo
echo "Three secrets for CI. CF_TOKEN is an API token that can edit Workers scripts on this account"
echo "(dashboard: My Profile > API Tokens). The R2 pair is an R2 API token (R2 > Manage API tokens)."
npx wrangler secret put CF_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
cd ..
./scripts/keys.sh
source scripts/env.sh
echo
echo "Done. Your board is at $CANON_URL"
echo "Try the demo:        ./scripts/genesis.sh"
echo "Or your own app:     CANON_PROJECT=myapp IMPORT_URL=https://github.com/<you>/<repo>.git ./scripts/genesis.sh"
echo "The guide:           docs/USING.md"
