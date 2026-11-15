#!/usr/bin/env bash
# Live capture check: asks the agent to reply with a random word, then waits up to 60 s
# for a final (non-provisional) assistant row with that word. Spends one model call.
# Usage: scripts/capture-check.sh claude|codex
set -euo pipefail
TOOL="${1:?claude or codex}"
PSQL="/Applications/Postgres 18.app/Contents/Versions/latest/bin/psql"
URL="${AGENT_HISTORY_READER_URL:-postgresql://agent_history_reader@localhost:5432/agent_history}"
WORD="capture$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
PROMPT="Reply with exactly this one word and nothing else: ${WORD}"

if [ "$TOOL" = claude ]; then claude -p "$PROMPT" >/dev/null; else codex exec "$PROMPT" >/dev/null; fi
start=$(date +%s)
while :; do
  found=$("$PSQL" --dbname="$URL" -X -At -c "SELECT m.session_id || ' ' || m.ts FROM messages m WHERE m.role = 'assistant' AND m.kind = 'text' AND NOT m.provisional AND m.text LIKE '%${WORD}%' AND m.session_id LIKE '${TOOL}:%' LIMIT 1")
  if [ -n "$found" ]; then echo "PASS after $(( $(date +%s) - start )) s: $found"; exit 0; fi
  if [ $(( $(date +%s) - start )) -ge 60 ]; then echo "FAIL: ${WORD} not captured as a final assistant row within 60 s"; exit 1; fi
  sleep 2
done
