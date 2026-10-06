#!/usr/bin/env bash
# Makes Canon's two keys once, keeps them in your macOS Keychain (elsewhere: ~/.config/canon, readable only by you),
# and sets them on the referee. The values are never printed. genesis.sh and the agent scripts read them from there.
#   ./scripts/keys.sh
# To paste the owner key into the board's Accept prompt (macOS):
#   security find-generic-password -a canon -s canon-owner-key -w | pbcopy
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v security >/dev/null; then
  key() { security find-generic-password -a canon -s "$1" -w 2>/dev/null; }
  make() { security add-generic-password -a canon -s "$1" -w "$(openssl rand -hex 24)"; }
  where="your Keychain"
else
  key() { cat "$HOME/.config/canon/$1" 2>/dev/null; }
  make() { mkdir -p "$HOME/.config/canon" && (umask 077 && openssl rand -hex 24 > "$HOME/.config/canon/$1"); }
  where="$HOME/.config/canon"
fi
for item in canon-owner-key canon-agent-key; do
  key "$item" >/dev/null || make "$item"
done
cd referee
printf %s "$(key canon-owner-key)" | npx wrangler secret put CANON_KEY >/dev/null
printf %s "$(key canon-agent-key)" | npx wrangler secret put CANON_AGENT_KEY >/dev/null
echo "Keys are in $where (canon-owner-key, canon-agent-key) and set on the referee."
