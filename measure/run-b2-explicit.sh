#!/bin/sh
# B2 follow-up: does an explicit keep-alive setting map one-to-one to the idle
# close? Three runs per case; one JSON line per run on stdout; a failed run is
# reported on stderr and makes the exit code 1. The 75 s cases make this slow.
# Usage: sh measure/run-b2-explicit.sh <cache-dir> > measure/results/<date>-b2-explicit.jsonl
set -u
C="${1:?usage: run-b2-explicit.sh <cache-dir>}"
D="$(dirname "$0")"
failed=0
N="$C/node/node-v22.23.2-darwin-arm64/bin/node"
run() { env -i PATH=/usr/bin:/bin HOME="$HOME" "$N" "$D/py-b2.mjs" "$@"; }
try3() { for i in 1 2 3; do run "$@" || { echo "failed: $* run $i (exit $?)" >&2; failed=1; }; done; }
for venv in py-g26 py-g27; do
  try3 "$C/$venv" gthread-keepalive 7
  try3 "$C/$venv" gthread-keepalive 75
done
try3 "$C/py-g27" uvicorn-worker-keepalive 75
try3 "$C/py-g26" uvicorn-flag 7
try3 "$C/py-g26" uvicorn-env 7
try3 "$C/py-g27" uvicorn-flag 7
try3 "$C/py-g27" uvicorn-env 7
exit $failed
