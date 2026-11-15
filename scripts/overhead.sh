#!/usr/bin/env bash
# Hook cost diagnostics.
#   default: (a) shell-spawn diagnostic: bash backgrounding the hook argv (NOT the agent's dispatch path; unbudgeted)
#            (b) worker latency: the hook command run to completion (runs in the background; unbudgeted)
#   --dispatch (Claude, spends <runs> model calls): answer-to-probe-start diagnostic, unbudgeted: a probe sync Stop hook
#            records its start time; delay = probe start - timestamp of the final assistant record. It includes work before
#            dispatch and the probe's own startup, and ends before dispatch returns, so it does NOT measure the foreground
#            dispatch/return cost of the installed async hook; that acceptance check stays open.
#   --e2e    (spends 2 x <runs> model calls): claude -p medians with hooks on vs off, observation only.
# Usage: scripts/overhead.sh <transcript.jsonl> [runs] [--dispatch|--e2e]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
TRANSCRIPT="${1:?transcript path}"
RUNS="${2:-10}"
MODE="${3:-}"
PAYLOAD="$(printf '{"session_id":"overhead-check","transcript_path":"%s"}' "$TRANSCRIPT")"
HOOK=("$NODE" --max-old-space-size=192 "$REPO/bin/agent-history" ingest)

ms() { perl -MTime::HiRes=time -e 'printf "%.1f\n", time*1000'; }
median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }

echo "a. shell-spawn diagnostic (bash & of the hook argv; not the agent's dispatch path, unbudgeted), $RUNS runs:"
for _ in $(seq "$RUNS"); do
  t0=$(ms); printf '%s' "$PAYLOAD" | "${HOOK[@]}" >/dev/null 2>&1 & t1=$(ms); wait
  echo "$t1 - $t0" | bc
done | median | xargs -I{} echo "   median {} ms"

echo "b. worker latency (run to completion, in the background; unbudgeted), $RUNS runs:"
for _ in $(seq "$RUNS"); do
  t0=$(ms); printf '%s' "$PAYLOAD" | "${HOOK[@]}"; t1=$(ms)
  echo "$t1 - $t0" | bc
done | median | xargs -I{} echo "   median {} ms"

if [ "$MODE" = "--dispatch" ]; then
  WORK="$(mktemp -d)"; PROBE="$WORK/probe.txt"
  cat > "$WORK/settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"perl -MTime::HiRes=time -e 'printf \"%.1f\\\\n\", time*1000' >> $PROBE"}]}]}}
JSON
  echo "c. answer-to-probe-start diagnostic (unbudgeted; not the foreground dispatch cost), $RUNS runs:"
  for _ in $(seq "$RUNS"); do
    uuid="$("$NODE" -e 'console.log(crypto.randomUUID())')"
    : > "$PROBE"
    claude -p "Reply with OK" --session-id "$uuid" --settings "$WORK/settings.json" >/dev/null
    file="$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$uuid".jsonl 2>/dev/null | head -1)"
    [ -n "$file" ] && [ -s "$PROBE" ] || { echo "   (run skipped: transcript or probe missing)" >&2; continue; }
    answered="$("$NODE" -e '
      const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      const last = lines.filter((r) => r.type === "assistant").pop();
      console.log(new Date(last.timestamp).getTime());' "$file")"
    echo "$(head -1 "$PROBE") - $answered" | bc
  done | median | xargs -I{} echo "   median {} ms"
  rm -rf "$WORK"
fi

if [ "$MODE" = "--e2e" ]; then
  echo "d. observation only: claude -p medians, hooks on vs off ($RUNS runs each)"
  OFF="$(mktemp)"; echo '{"disableAllHooks": true}' > "$OFF"
  for mode in on off; do
    for _ in $(seq "$RUNS"); do
      t0=$(ms)
      if [ "$mode" = off ]; then claude -p "Reply with OK" --settings "$OFF" >/dev/null; else claude -p "Reply with OK" >/dev/null; fi
      t1=$(ms); echo "$t1 - $t0" | bc
    done | median | xargs -I{} echo "   hooks $mode: median {} ms"
  done
  rm -f "$OFF"
fi
