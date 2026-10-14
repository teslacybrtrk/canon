#!/usr/bin/env bash
# The final autonomous run: three Claude Code agents, each preassigned one backlog fact of agents/canon.trio.json, on
# autopilot (no person accepts anything). The setup is controlled on purpose and disclosed: the two discount facts were
# written so that each holds alone and a naive combination breaks the bulk-discount fact (they stack); the third needs a
# change to stored data. Each agent is told only its own fact and the Canon protocol; every line of code is its own.
#   CANON_PROJECT=trio ./agents/trio.sh   (genesis first: CANON_PROJECT=trio CANON_FILE=agents/canon.trio.json CANON_PUBLIC=1 ./scripts/genesis.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
CANON_AGENT_KEY="${CANON_AGENT_KEY:-$(keychain canon-agent-key)}"
: "${CANON_AGENT_KEY:?set CANON_AGENT_KEY to the agent key, or run ./scripts/keys.sh}"
export CANON_PROJECT="${CANON_PROJECT:-trio}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"
MODEL="${MODEL:-sonnet}"
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")
goal() {
  echo "Goal: make the backlog fact \`$1\` true. Run \`canon read\` first. Join it with
\`canon claim --join $1 --why \"<one sentence>\"\`, implement it in your attempt, push, and run \`canon verdict --wait\`.
This project is on autopilot: a READY attempt lands on its own, and you don't need a person.
Other agents are working on other facts at the same time. When canon moves, the judge re-applies your change on the
current canon and judges the combined code: every fact that is canon then must hold together with yours. If a verdict
says your change breaks one, read its check and the failure in the verdict, and fix your change so that all of them
hold. Once \`canon read\` shows your fact as canon, stop. Push budget for this run: 6 pushes. Stop after 30 minutes."
}
i=0
for fact in bulk-discount order-discount stall-hours; do
  i=$((i + 1))
  agent="agent-$i"
  dir="runs/trio/$agent"
  rm -rf "$dir" && mkdir -p "$dir"
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md")

$(goal "$fact")" \
      --model "$MODEL" --allowedTools "${TOOLS[@]}" --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose > agent.log 2>&1 && echo "$agent done" || echo "$agent exited non-zero"
  ) &
  sleep 5
done
wait
