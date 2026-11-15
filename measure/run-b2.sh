#!/bin/sh
# B2 measurement: gunicorn worker model and setting precedence, three runs per
# case and per version, one JSON line per run on stdout; any failed run is
# reported on stderr and makes the exit code 1.
# Usage: sh measure/run-b2.sh <cache-dir> > measure/results/<date>-b2.jsonl
# <cache-dir> holds node/node-v22.23.2-darwin-arm64/ and the virtualenvs py-g26
# (gunicorn 26.2.0) and py-g27 (gunicorn 27.0.0), each with uvicorn 0.54.0 and
# uvicorn-worker 0.4.0 (see measure/README.md). Every script runs with a clean
# environment; py-b2.mjs sets GUNICORN_CMD_ARGS itself only where a case needs it.
set -u
C="${1:?usage: run-b2.sh <cache-dir>}"
D="$(dirname "$0")"
failed=0
N="$C/node/node-v22.23.2-darwin-arm64/bin/node"
clean() { env -i PATH=/usr/bin:/bin HOME="$HOME" "$@"; }
for venv in py-g26 py-g27; do
  for mode in threads threads-env sync; do
    for i in 1 2 3; do clean "$N" "$D/py-b2.mjs" "$C/$venv" "$mode" || { echo "failed: $venv $mode run $i (exit $?)" >&2; failed=1; }; done
  done
  for combo in none cli env file default emptyfile emptyfile,default \
      cli,env cli,file cli,default env,file env,default file,default \
      cli,env,file cli,env,default cli,file,default env,file,default cli,env,file,default; do
    for i in 1 2 3; do clean "$N" "$D/py-b2.mjs" "$C/$venv" precedence "$combo" || { echo "failed: $venv precedence $combo run $i (exit $?)" >&2; failed=1; }; done
  done
done
exit $failed
