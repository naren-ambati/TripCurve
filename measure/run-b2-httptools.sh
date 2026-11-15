#!/bin/sh
# B2 round 4: the httptools protocol. Needs the [standard] virtualenvs py-g26-std
# and py-g27-std next to the plain ones (see measure/README.md). Three runs per
# case, two for the 300 s cases. Independent streams run in parallel (each run
# has its own ephemeral port and process group); each case writes its own file
# and the files are joined in a fixed order at the end. Every line carries the
# protocol class the app saw serving the request.
# Usage: sh measure/run-b2-httptools.sh <cache-dir> > measure/results/<date>-b2-httptools.jsonl
set -u
C="${1:?usage: run-b2-httptools.sh <cache-dir>}"
D="$(dirname "$0")"
N="$C/node/node-v22.23.2-darwin-arm64/bin/node"
T="$(mktemp -d)"
# job <name> <runs> <venv> <args...>
job() {
  name=$1; runs=$2; venv=$3; shift 3
  i=1
  while [ "$i" -le "$runs" ]; do
    env -i PATH=/usr/bin:/bin HOME="$HOME" "$N" "$D/py-b2-httptools.mjs" "$C/$venv" "$@" >> "$T/$name" || { echo "failed: $name run $i (exit $?)" >&2; echo 1 > "$T/$name.failed"; }
    i=$((i + 1))
  done
}
# short cases, one after the other
( job 01-g26-worker-default 3 py-g26-std worker
  job 02-g26-worker-3 3 py-g26-std worker 3
  job 03-g27-worker-default 3 py-g27-std worker
  job 04-g27-worker-3 3 py-g27-std worker 3
  job 08-uvicorn-httptools-default 3 py-g26-std uvicorn httptools
  job 09-uvicorn-httptools-7 3 py-g26-std uvicorn httptools 7
  job 11-uvicorn-auto-default 3 py-g26-std uvicorn auto
  job 12-control-plain-auto 3 py-g26 uvicorn auto ) &
# 75 s
job 05-g26-worker-75 3 py-g26-std worker 75 &
job 06-g27-worker-75 3 py-g27-std worker 75 &
# 300 s
job 07a-g26-worker-300 2 py-g26-std worker 300 &
job 07b-g27-worker-300 2 py-g27-std worker 300 &
job 10-uvicorn-httptools-300 2 py-g26-std uvicorn httptools 300 &
wait
for f in $(ls "$T" | grep -v '\.failed$' | sort); do cat "$T/$f"; done
failed=0; ls "$T"/*.failed >/dev/null 2>&1 && failed=1
rm -rf "$T"
exit $failed
