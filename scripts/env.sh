# Shared by the scripts (source it from the repo root): where the referee is, and how to read the keys.
# CANON_URL defaults to the referee's custom domain in referee/wrangler.jsonc, or else its workers.dev address.
if [ -z "${CANON_URL:-}" ]; then
  CANON_URL="$(node -e '
    const s = require("fs").readFileSync("referee/wrangler.jsonc", "utf8");
    const domain = s.match(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/);
    const name = s.match(/"name":\s*"([^"]+)"/)[1];
    const sub = s.match(/"PRODUCTION_URL":\s*"https:\/\/\{project\}\.([^"]+)"/)[1];
    console.log(domain ? `https://${domain[1]}` : `https://${name}.${sub}`);')"
fi
export CANON_URL
# wrangler runs in demo-app too, whose config names no account: use the referee's, never whichever account is logged in.
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(node -e 'console.log(require("fs").readFileSync("referee/wrangler.jsonc","utf8").match(/"account_id":\s*"([0-9a-f]{32})"/)?.[1] ?? "")')"
  export CLOUDFLARE_ACCOUNT_ID
fi
# A key that scripts/keys.sh made: from the macOS Keychain, or elsewhere from ~/.config/canon (readable only by you).
keychain() {
  if command -v security >/dev/null; then security find-generic-password -a canon -s "$1" -w 2>/dev/null || true
  elif [ -r "$HOME/.config/canon/$1" ]; then cat "$HOME/.config/canon/$1"; fi
}
