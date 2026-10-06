#!/usr/bin/env bash
# The judge re-applies attempts left behind by an accept on its own. This is for the ones it hands back: a text conflict
# with the new canon, which the agent resolves.
#   ./agents/refresh.sh agent-3   (CANON_URL defaults to your referee, see scripts/env.sh)
# MODEL=sonnet for an agent that haiku keeps answering with a summary instead of refreshing.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
# The agents' key: from the environment, or from the Keychain where scripts/keys.sh keeps it.
CANON_AGENT_KEY="${CANON_AGENT_KEY:-$(keychain canon-agent-key)}"
: "${CANON_AGENT_KEY:?set CANON_AGENT_KEY to the agent key, or run ./scripts/keys.sh}"
export CANON_PROJECT="${CANON_PROJECT:-farmstand}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")
PROMPT="Canon has moved since you finished: another fact was accepted, and your change conflicts with the new canon's code.
cd into your attempt in ./attempts, run \`canon refresh\`, then cd into the new attempt it prints, resolve the conflict,
push, and run \`canon verdict --wait\`. When resolving conflicts, keep both canon's code and your own change
working together. Before pushing, run \`npm ci\`, then \`npx tsc --noEmit -p tsconfig.json\` and \`npx biome lint src\` in the attempt
and fix what they report. Refresh at most once: push, read the verdict once, and stop. If it contradicts canon,
report the contradiction in one line."

for agent in "$@"; do
  dir="$(ls -d runs/"$agent"-* 2>/dev/null | head -1)"
  [ -n "$dir" ] || { echo "no run directory for $agent"; continue; }
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" CANON_CLAIMS="$PWD/claims" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md")

$PROMPT" \
      --model "${MODEL:-haiku}" --allowedTools "${TOOLS[@]}" --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose > refresh.log 2>&1 && echo "$agent refreshed" || echo "$agent exited non-zero"
  ) &
  sleep 2
done
wait
