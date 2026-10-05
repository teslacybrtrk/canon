#!/usr/bin/env bash
# Makes Canon's two keys once, keeps them in your macOS Keychain, and sets them on the referee.
# The values are never printed. genesis.sh and the agent scripts read them from the Keychain.
#   ./scripts/keys.sh
# To paste the owner key into the board's Accept prompt:
#   security find-generic-password -a canon -s canon-owner-key -w | pbcopy
set -euo pipefail
cd "$(dirname "$0")/.."
command -v security >/dev/null || { echo "keys.sh uses the macOS Keychain. Elsewhere, set CANON_KEY and CANON_AGENT_KEY with wrangler secret put and export them."; exit 1; }
key() { security find-generic-password -a canon -s "$1" -w 2>/dev/null; }
for item in canon-owner-key canon-agent-key; do
  key "$item" >/dev/null || security add-generic-password -a canon -s "$item" -w "$(openssl rand -hex 24)"
done
cd referee
printf %s "$(key canon-owner-key)" | npx wrangler secret put CANON_KEY >/dev/null
printf %s "$(key canon-agent-key)" | npx wrangler secret put CANON_AGENT_KEY >/dev/null
echo "Keys are in your Keychain (canon-owner-key, canon-agent-key) and set on the referee."
