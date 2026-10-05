#!/usr/bin/env bash
# After a fact is accepted, tell agents whose worlds are now behind canon to refresh them.
#   CANON_URL=https://canon.rodeo ./agents/refresh.sh agent-3 agent-4 agent-5
set -euo pipefail
cd "$(dirname "$0")/.."
export CANON_URL="${CANON_URL:-https://canon.rodeo}"
# The agents' key: from the environment, or from the Keychain where scripts/keys.sh keeps it.
CANON_AGENT_KEY="${CANON_AGENT_KEY:-$(security find-generic-password -a canon -s canon-agent-key -w 2>/dev/null || true)}"
: "${CANON_AGENT_KEY:?set CANON_AGENT_KEY to the agent key, or run ./scripts/keys.sh}"
export CANON_PROJECT="${CANON_PROJECT:-farmstand}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")
PROMPT="Canon has moved since you finished: another fact was accepted. Your world in ./worlds is now behind canon.
cd into your world, run \`canon refresh\`, then cd into the new world it prints, resolve any conflict,
push, and run \`canon verdict --wait\`. When resolving conflicts, keep both canon's code and your own change
working together. Before pushing, run \`npm ci\`, then \`npx tsc --noEmit -p tsconfig.json\` and \`npx biome lint src\` in the world
and fix what they report. Refresh at most once: push, read the verdict once, and stop. If it contradicts canon,
report the contradiction in one line."

for agent in "$@"; do
  dir="$(ls -d runs/"$agent"-* 2>/dev/null | head -1)"
  [ -n "$dir" ] || { echo "no run directory for $agent"; continue; }
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md")

$PROMPT" \
      --model haiku --allowedTools "${TOOLS[@]}" --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose > refresh.log 2>&1 && echo "$agent refreshed" || echo "$agent exited non-zero"
  ) &
  sleep 2
done
wait
