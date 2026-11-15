#!/usr/bin/env bash
# Live capture check for the installed hooks, in a real interactive session.
# One-shot `claude -p` / `codex exec` runs cancel unfinished async hooks at exit, so they cannot prove hook capture.
# Usage: scripts/capture-check.sh claude|codex   (then send the printed prompt in a normal session of that tool)
set -euo pipefail
TOOL="${1:?claude or codex}"
PSQL="/Applications/Postgres 18.app/Contents/Versions/latest/bin/psql"
URL="${AGENT_HISTORY_READER_URL:-postgresql://agent_history_reader@localhost:5432/agent_history}"
WORD="capture$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "In an interactive ${TOOL} session, send exactly:"
echo
echo "  Reply with exactly this one word and nothing else: ${WORD}"
echo
echo "Waiting up to 5 minutes for a final, non-provisional answer of exactly '${WORD}' in a ${TOOL} session updated after ${STARTED}..."
deadline=$(( $(date +%s) + 300 ))
SQL="SELECT m.session_id || ' ' || to_char(m.ts, 'HH24:MI:SS')
       FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.tool = '${TOOL}' AND s.updated_at >= '${STARTED}'
        AND m.role = 'assistant' AND m.kind = 'text' AND NOT m.provisional
        AND coalesce(m.phase, 'final_answer') = 'final_answer'
        AND btrim(m.text) = '${WORD}'
      LIMIT 1"
while :; do
  found="$("$PSQL" --dbname="$URL" -X -At -c "$SQL")"
  if [ -n "$found" ]; then echo "PASS: captured in ${found}"; exit 0; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "FAIL: no final answer '${WORD}' captured within 5 minutes"; exit 1; fi
  sleep 2
done
