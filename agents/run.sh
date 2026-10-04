#!/usr/bin/env bash
# Starts five real coding agents in parallel, each speaking the Canon protocol.
#   CANON_URL=https://canon-referee.<you>.workers.dev ./agents/run.sh
# Uses Claude Code headless (`claude -p`). For opencode, replace the claude line with `opencode run "$PROMPT"`.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CANON_URL:?set CANON_URL to the referee origin}"
export CANON_PROJECT="${CANON_PROJECT:-farmstand}"
export PATH="$PWD/cli:$PATH"
ROOT="$PWD"

# Cheap by default. The two reservation racers get different models so their worlds differ.
model_for() {
  case "$1" in
    agent-2-*) echo sonnet ;;
    *) echo haiku ;;
  esac
}

for prompt in agents/prompts/*.md; do
  name="$(basename "$prompt" .md)"           # agent-1-discount
  agent="$(echo "$name" | cut -d- -f1-2)"     # agent-1
  dir="runs/$name"
  rm -rf "$dir" && mkdir -p "$dir"
  ln -s "$ROOT/agents/claims" "$dir/claims"
  (
    cd "$dir"
    CANON_AGENT="$agent" claude -p "$(cat "$ROOT/agents/PROTOCOL_FOR_AGENTS.md" "$ROOT/$prompt")" \
      --model "$(model_for "$name")" \
      --allowedTools "Bash,Read,Edit,Write,Glob,Grep" \
      > agent.log 2>&1 && echo "$agent done" || echo "$agent exited non-zero (see $dir/agent.log)"
  ) &
  sleep 3 # stagger so claims land on the board one at a time
done
wait
