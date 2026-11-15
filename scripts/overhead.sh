#!/usr/bin/env bash
# Times the agent-history hook command, and optionally end-to-end `claude -p` runs with hooks on vs off.
# Usage: scripts/overhead.sh <transcript.jsonl> [runs] [--e2e]
# --e2e spends model quota: it runs `claude -p` 2 x runs times.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
TRANSCRIPT="${1:?transcript path}"
RUNS="${2:-10}"
E2E="${3:-}"
PAYLOAD="$(printf '{"session_id":"overhead-check","transcript_path":"%s"}' "$TRANSCRIPT")"

ms() { perl -MTime::HiRes=time -e 'printf "%.0f\n", time*1000'; }
median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }

echo "hook command (full run, synchronous): $RUNS runs"
for _ in $(seq "$RUNS"); do
  t0=$(ms); printf '%s' "$PAYLOAD" | "$NODE" --max-old-space-size=192 "$REPO/bin/agent-history" ingest; t1=$(ms)
  echo $((t1 - t0))
done | median | xargs -I{} echo "  median {} ms (runs in the background when the hook is async)"

if [ "$E2E" = "--e2e" ]; then
  OFF="$(mktemp)"; echo '{"disableAllHooks": true}' > "$OFF"
  for mode in on off; do
    for _ in $(seq "$RUNS"); do
      t0=$(ms)
      if [ "$mode" = off ]; then claude -p "Reply with OK" --settings "$OFF" >/dev/null; else claude -p "Reply with OK" >/dev/null; fi
      t1=$(ms); echo $((t1 - t0))
    done | median | xargs -I{} echo "  claude -p hooks $mode: median {} ms"
  done
  rm -f "$OFF"
  echo "  foreground overhead = (on - off); budget 50 ms. Model/network time varies, repeat if noisy."
fi
