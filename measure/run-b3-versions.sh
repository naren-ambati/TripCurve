#!/bin/sh
# B3 Node versions: default idle close, explicit keepAliveTimeout 7000, and
# explicit 7000 with keepAliveTimeoutBuffer 0 (only where the property exists),
# 3 runs each, per Node version. One JSON line per run on stdout; a failed run
# goes to stderr and makes the exit code 1. Slow (about 10 minutes).
# Usage: sh measure/run-b3-versions.sh <cache-dir> > measure/results/<date>-b3-versions.jsonl
# <cache-dir> holds node/node-v<version>-darwin-arm64/ (official tarballs).
set -u
C="${1:?usage: run-b3-versions.sh <cache-dir>}"
D="$(dirname "$0")"
failed=0
for v in 18.20.8 20.20.2 22.12.0 22.18.0 22.19.0 24.0.0 24.5.0 24.6.0 26.0.0; do
  bin="$C/node/node-v$v-darwin-arm64/bin/node"
  for c in default explicit7000 buffer0; do
    for i in 1 2 3; do
      env -i PATH=/usr/bin:/bin HOME="$HOME" "$bin" "$D/node-b3-case.mjs" "$c"
      rc=$?
      [ $rc -eq 0 ] && continue
      [ $rc -eq 3 ] && { echo "skipped: node $v $c (property missing)" >&2; break; }
      echo "failed: node $v $c run $i (exit $rc)" >&2; failed=1
    done
  done
done
exit $failed
