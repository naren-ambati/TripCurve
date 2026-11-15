#!/bin/sh
# B2 follow-up round 3: explicit keep-alive 300 s, two runs per case, cap 400 s.
# The five cases run in parallel (each run has its own ephemeral port and
# process group; py-b2.mjs stops its server on exit or interrupt); each case
# writes its own file, and the files are joined in a fixed order at the end.
# Usage: sh measure/run-b2-explicit-300.sh <cache-dir> > measure/results/<date>-b2-explicit-300.jsonl
set -u
C="${1:?usage: run-b2-explicit-300.sh <cache-dir>}"
D="$(dirname "$0")"
N="$C/node/node-v22.23.2-darwin-arm64/bin/node"
T="$(mktemp -d)"
case_() { # <name> <venv> <mode>
  for i in 1 2; do
    env -i PATH=/usr/bin:/bin HOME="$HOME" "$N" "$D/py-b2.mjs" "$C/$2" "$3" 300 400 >> "$T/$1" || { echo "failed: $1 run $i (exit $?)" >&2; echo 1 > "$T/$1.failed"; }
  done
}
case_ 1-g26-gthread py-g26 gthread-keepalive &
case_ 2-g27-gthread py-g27 gthread-keepalive &
case_ 3-g26-worker py-g26 uvicorn-worker-keepalive &
case_ 4-g27-worker py-g27 uvicorn-worker-keepalive &
case_ 5-uvicorn py-g26 uvicorn-flag &
wait
for f in 1-g26-gthread 2-g27-gthread 3-g26-worker 4-g27-worker 5-uvicorn; do cat "$T/$f" 2>/dev/null; done
failed=0; ls "$T"/*.failed >/dev/null 2>&1 && failed=1
rm -rf "$T"
exit $failed
