#!/usr/bin/env bash
# Hook cost, measured three separate ways:
#   1. dispatch: fork/exec of the exact hook command in the background and return (what an async hook costs the session);
#      this is the number compared with the 50 ms budget
#   2. worker latency: the hook command run to completion (happens in the background; reported, not budgeted)
#   3. --e2e only, observation: `claude -p` medians with hooks on vs off (spends 2 x runs model calls; model/network noise
#      dominates, so this cannot verify the budget)
# Usage: scripts/overhead.sh <transcript.jsonl> [runs] [--e2e]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
TRANSCRIPT="${1:?transcript path}"
RUNS="${2:-10}"
E2E="${3:-}"
PAYLOAD="$(printf '{"session_id":"overhead-check","transcript_path":"%s"}' "$TRANSCRIPT")"
HOOK=("$NODE" --max-old-space-size=192 "$REPO/bin/agent-history" ingest)

ms() { perl -MTime::HiRes=time -e 'printf "%.1f\n", time*1000'; }
median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }

echo "1. dispatch (background fork/exec + return), $RUNS runs:"
for _ in $(seq "$RUNS"); do
  t0=$(ms); printf '%s' "$PAYLOAD" | "${HOOK[@]}" >/dev/null 2>&1 & t1=$(ms); wait
  echo "$t1 - $t0" | bc
done | median | xargs -I{} echo "   median {} ms (budget 50 ms)"

echo "2. worker latency (run to completion, background), $RUNS runs:"
for _ in $(seq "$RUNS"); do
  t0=$(ms); printf '%s' "$PAYLOAD" | "${HOOK[@]}"; t1=$(ms)
  echo "$t1 - $t0" | bc
done | median | xargs -I{} echo "   median {} ms (not on the foreground path)"

if [ "$E2E" = "--e2e" ]; then
  echo "3. observation only: claude -p medians, hooks on vs off ($RUNS runs each)"
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
