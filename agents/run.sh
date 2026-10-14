#!/usr/bin/env bash
# Starts real coding agents in parallel (one per agents/prompts/*.md, twelve), each speaking the Canon protocol.
#   ./agents/run.sh   (CANON_URL defaults to your referee, see scripts/env.sh)
# Uses Claude Code headless (`claude -p`). GROK_AGENTS="agent-5" runs those agents on Grok Build (`grok -p`) instead,
# with the same allow-list, to show any coding agent can play. For opencode, use `opencode run "$PROMPT"`.
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
    agent-1-* | agent-2-* | agent-7-*) echo sonnet ;; # agent-1 also writes a revision; 2 and 7 race their rivals on another model
    *) echo haiku ;;
  esac
}

# Agents may run only the protocol, Git, the app's toolchain and read-only shell commands.
TOOLS=(Read Edit Write Glob Grep "Bash(canon:*)" "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(pwd)" "Bash(sleep:*)")

for prompt in $(ls agents/prompts/*.md | sort -V); do # agent-2 before agent-10
  name="$(basename "$prompt" .md)"           # agent-1-discount
  [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $(echo "$name" | cut -d- -f1-2) "* ]] && continue   # ONLY="agent-4 agent-9" runs those
  agent="$(echo "$name" | cut -d- -f1-2)"     # agent-1
  dir="runs/$name"
  [ -d "$dir" ] && chmod -R u+w "$dir" # the claims copy is read-only
  rm -rf "$dir" && mkdir -p "$dir"
  # Each agent gets its own read-only copy of the claim files, so no agent can rewrite a fact for the others.
  cp -R "$ROOT/agents/claims" "$dir/claims" && chmod -R a-w "$dir/claims"
  (
    cd "$dir"
    # Agents get the agent key: it can claim but never accept, and the owner's key never reaches them.
    PROMPT="$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md" "$ROOT/$prompt")"
    if [[ " ${GROK_AGENTS:-} " == *" $agent "* ]]; then
      # Grok Build, headless: only the allow-listed tools; anything else is refused without asking.
      CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" CANON_CLAIMS="$PWD/claims" grok -p "$PROMPT" \
        --allow "${TOOLS[@]}" --permission-mode dontAsk --disable-web-search \
        --output-format streaming-messages-json \
        > agent.log 2>&1 && echo "$agent done (grok)" || echo "$agent exited non-zero (see $dir/agent.log)"
    else
      # The overlap hook (agents/hooks): after each edit, other agents changing the same files show up in the session.
      CANON_ROOT="$ROOT" CANON_KEY="$CANON_AGENT_KEY" CANON_AGENT="$agent" CANON_CLAIMS="$PWD/claims" claude -p "$PROMPT" \
        --model "$(model_for "$name")" \
        --settings "$ROOT/agents/hooks/settings.json" \
        --allowedTools "${TOOLS[@]}" \
        --strict-mcp-config --disable-slash-commands \
        --output-format stream-json --verbose \
        > agent.log 2>&1 && echo "$agent done" || echo "$agent exited non-zero (see $dir/agent.log)"
    fi
    # The attempts' installed dependencies are hundreds of MB each and come back with npm ci: keep the transcript and the code.
    find . -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
  ) &
  sleep 3 # stagger so claims land on the board one at a time
done
wait
