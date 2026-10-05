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
# A key from the macOS Keychain, where scripts/keys.sh keeps them (empty elsewhere: export the keys instead).
keychain() { command -v security >/dev/null && security find-generic-password -a canon -s "$1" -w 2>/dev/null || true; }
