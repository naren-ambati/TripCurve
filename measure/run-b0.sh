#!/bin/sh
# B0 day-1 measurement: every seed three times, one JSON line per run on
# stdout; any failed run is reported on stderr and makes the exit code 1.
# Usage: sh measure/run-b0.sh <cache-dir> > measure/results/<date>-b0.jsonl
# <cache-dir> holds node/node-v<version>-darwin-arm64/ (official tarballs)
# and the virtualenvs py-g26 (gunicorn 26.2.0) and py-g27 (gunicorn 27.0.0),
# each with uvicorn 0.54.0 and uvicorn-worker 0.4.0 (see measure/README.md).
# Every script runs with a clean environment.
set -u
C="${1:?usage: run-b0.sh <cache-dir>}"
D="$(dirname "$0")"
failed=0
clean() { env -i PATH=/usr/bin:/bin HOME="$HOME" "$@"; }
for v in 22.23.2 22.23.5 24.22.3 26.13.1; do
  bin="$C/node/node-v$v-darwin-arm64/bin/node"
  for i in 1 2 3; do clean "$bin" "$D/node-idle-close.mjs" || { echo "failed: node $v run $i (exit $?)" >&2; failed=1; }; done
done
for venv in py-g26 py-g27; do
  for k in gunicorn-uvicorn uvicorn; do
    for i in 1 2 3; do clean "$C/node/node-v22.23.2-darwin-arm64/bin/node" "$D/py-idle-close.mjs" "$C/$venv" "$k" || { echo "failed: $venv $k run $i (exit $?)" >&2; failed=1; }; done
  done
done
exit $failed
