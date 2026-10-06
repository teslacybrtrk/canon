#!/usr/bin/env bash
# Starts five real coding agents in parallel, each speaking the Canon protocol.
#   CANON_URL=https://canon-referee.<you>.workers.dev ./agents/run.sh
# Uses Claude Code headless (`claude -p`). For opencode, replace the claude line with `opencode run "$PROMPT"`.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
# The agents' key: from the environment, or from the Keychain where scripts/keys.sh keeps it.
CANON_AGENT_KEY="${CANON_AGENT_KEY:-$(keychain canon-agent-key)}"
: "${CANON_AGENT_KEY:?set CANON_AGENT_KEY to the agent key, or run ./scripts/keys.sh}"
export CANON_PROJECT="${CANON_PROJECT:-farmstand}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"

# Cheap by default. The two reservation racers get different models so their attempts differ.
model_for() {
  case "$1" in
    agent-1-* | agent-2-*) echo sonnet ;; # agent-1 also writes a revision, the trickiest move
    *) echo haiku ;;
  esac
}

# Agents may run only the protocol, Git, the app's toolchain and read-only shell commands.
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")

for prompt in agents/prompts/*.md; do
  name="$(basename "$prompt" .md)"           # agent-1-discount
  [ -n "${ONLY:-}" ] && [[ "$name" != "$ONLY"* ]] && continue   # ONLY=agent-4 runs one agent
  agent="$(echo "$name" | cut -d- -f1-2)"     # agent-1
  dir="runs/$name"
  [ -d "$dir" ] && chmod -R u+w "$dir" # the claims copy is read-only
  rm -rf "$dir" && mkdir -p "$dir"
  # Each agent gets its own read-only copy of the claim files, so no agent can rewrite a fact for the others.
  cp -R "$ROOT/agents/claims" "$dir/claims" && chmod -R a-w "$dir/claims"
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" CANON_CLAIMS="$PWD/claims" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md" "$ROOT/$prompt")" \
      --model "$(model_for "$name")" \
      --allowedTools "${TOOLS[@]}" \
      --strict-mcp-config --disable-slash-commands \
      --output-format stream-json --verbose \
      > agent.log 2>&1 && echo "$agent done" || echo "$agent exited non-zero (see $dir/agent.log)"
  ) &
  sleep 3 # stagger so claims land on the board one at a time
done
wait
