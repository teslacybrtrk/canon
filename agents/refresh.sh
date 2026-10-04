#!/usr/bin/env bash
# After a fact is accepted, tell agents whose worlds are now behind canon to refresh them.
#   CANON_URL=https://canon.rodeo ./agents/refresh.sh agent-3 agent-4 agent-5
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CANON_URL:?set CANON_URL to the referee origin}"
export CANON_PROJECT="${CANON_PROJECT:-farmstand}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")
PROMPT="Canon has moved since you finished: another fact was accepted. Your world in ./worlds is now behind canon.
cd into your world, run \`canon refresh\`, then cd into the new world it prints, resolve any conflict,
push, and run \`canon verdict --wait\`. When resolving conflicts, keep your own fact's behaviour as well as
canon's. Then follow the protocol for the verdict you get."

for agent in "$@"; do
  dir="$(ls -d runs/"$agent"-* 2>/dev/null | head -1)"
  [ -n "$dir" ] || { echo "no run directory for $agent"; continue; }
  (
    cd "$dir"
    CANON_AGENT="$agent" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md")

$PROMPT" \
      --model haiku --allowedTools "${TOOLS[@]}" --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose > refresh.log 2>&1 && echo "$agent refreshed" || echo "$agent exited non-zero"
  ) &
  sleep 2
done
wait
