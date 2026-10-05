#!/usr/bin/env bash
# Autopilot: N agents work through a backlog of facts written by people. With "autoAccept": "backlog"
# in canon.json, the first world that keeps every canon fact and makes a backlog fact true lands on its own.
#   CANON_URL=https://canon.rodeo CANON_PROJECT=rodeo AGENTS=8 ./agents/autopilot.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CANON_URL:?set CANON_URL to the referee origin}"
: "${CANON_AGENT_KEY:?set CANON_AGENT_KEY to the agents' key (the referee's CANON_AGENT_KEY secret)}"
export CANON_PROJECT="${CANON_PROJECT:-rodeo}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"
N="${AGENTS:-8}"
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")
GOAL='Goal: work through the backlog. Run `canon read` and pick the BACKLOG fact with the fewest claims
(prefer one nobody has claimed). Join it with `canon claim --join <id> --why "<one sentence>"`, implement it,
push, and run `canon verdict --wait`. A READY world lands on its own (autopilot): you do not need anyone.
If your world is BEHIND, run `canon refresh` and continue in the new world. Once your fact is canon (check
with `canon read`), pick another backlog fact. Stop after two of your facts became canon, or when the
backlog is empty, or after 20 minutes.'

for i in $(seq 1 "$N"); do
  agent="agent-$i"
  dir="runs/autopilot/$agent"
  rm -rf "$dir" && mkdir -p "$dir"
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md")

$GOAL" \
      --model haiku --allowedTools "${TOOLS[@]}" --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose > agent.log 2>&1 && echo "$agent done" || echo "$agent exited non-zero"
  ) &
  sleep 4
done
wait
