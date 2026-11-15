#!/bin/bash
# B4 measurement runs -> measure/results/2026-11-11-b4.jsonl
# Lane 1 (gunicorn 26.2.0 + uvicorn alone), lane 2 (gunicorn 27.0.0) and lane 3 (lightship)
# run side by side (different ports); each lane runs its cases one after another.
# Needs: .cache/py-g26, .cache/py-g27 (gunicorn, uvicorn 0.54.0, uvicorn-worker) and
# .cache/lightship (npm install --ignore-scripts lightship@9.1.0).
set -u
cd "$(dirname "$0")/.."
OUT=measure/results/2026-11-11-b4.jsonl
CACHE=$(cd ../.. 2>/dev/null && pwd)/.cache
[ -d "$CACHE" ] || CACHE="$(pwd)/.cache" # the script has cd-ed to the repository root
TMPD=$(mktemp -d)
RUNS=3
lane_gunicorn() { # venv, outfile
  for kind in long short; do
    for c in sync sync-graceful10 sync-timeout120 uvicorn-worker gthread; do
      for i in $(seq $RUNS); do node measure/shutdown-b4.mjs "$1" $c $kind >> "$2" || echo "FAILED: $1 $c $kind run $i" >&2; done
    done
  done
}
lane_uvicorn() {
  for spec in "uvicorn long" "uvicorn short" "uvicorn-graceful5 long"; do
    for i in $(seq $RUNS); do node measure/shutdown-b4.mjs "$CACHE/py-g26" $spec >> "$1" || echo "FAILED: uvicorn $spec run $i" >&2; done
  done
}
lane_lightship() {
  for m in k8s local; do for i in $(seq $RUNS); do node measure/lightship-b4.mjs "$CACHE/lightship" $m >> "$1" || echo "FAILED: lightship $m run $i" >&2; done; done
}
lane_gunicorn "$CACHE/py-g26" "$TMPD/1" & 
lane_gunicorn "$CACHE/py-g27" "$TMPD/2" &
( lane_uvicorn "$TMPD/3"; lane_lightship "$TMPD/4" ) &
wait
cat "$TMPD"/1 "$TMPD"/2 "$TMPD"/3 "$TMPD"/4 > "$OUT"
rm -rf "$TMPD"
wc -l "$OUT"
