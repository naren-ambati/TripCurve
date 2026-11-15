#!/bin/sh
# B3: does Node add keepAliveTimeoutBuffer to an explicit keepAliveTimeout?
# Five cases x 3 runs x 4 Node versions; one JSON line per run on stdout; a
# failed run is reported on stderr and makes the exit code 1. Slow (65 s cases).
# Usage: sh measure/run-b3.sh <cache-dir> > measure/results/<date>-b3.jsonl
# <cache-dir> holds node/node-v<version>-darwin-arm64/ (official tarballs).
set -u
C="${1:?usage: run-b3.sh <cache-dir>}"
D="$(dirname "$0")"
failed=0
for v in 22.23.2 22.23.5 24.22.3 26.13.1; do
  bin="$C/node/node-v$v-darwin-arm64/bin/node"
  for case in "7000" "12000" "65000 --cap-ms=120000" "7000 --buffer=0" "7000 --form=options"; do
    for i in 1 2 3; do
      # word splitting of $case is intended
      env -i PATH=/usr/bin:/bin HOME="$HOME" "$bin" "$D/node-explicit.mjs" $case || { echo "failed: node $v $case run $i (exit $?)" >&2; failed=1; }
    done
  done
done
exit $failed
