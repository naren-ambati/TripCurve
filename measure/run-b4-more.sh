#!/bin/bash
# B4-more runs -> measure/results/2026-11-11-b4-more.jsonl (gunicorn 26.2.0 and 27.0.0 in two parallel lanes)
set -u
cd "$(dirname "$0")/.."
OUT=measure/results/2026-11-11-b4-more.jsonl
CACHE="$(pwd)/.cache" # the script has cd-ed to the repository root above
TMPD=$(mktemp -d)
lane() { for c in sync-w2 sync-w2-graceful10 sync-env-graceful10 sync-conf-graceful10 uvicorn-worker-graceful10 gthread-graceful10; do
  for i in 1 2 3; do node measure/shutdown-b4-more.mjs "$1" $c long >> "$2" || echo "FAILED: $1 $c run $i" >&2; done; done; }
lane "$CACHE/py-g26" "$TMPD/1" &
lane "$CACHE/py-g27" "$TMPD/2" &
wait
cat "$TMPD/1" "$TMPD/2" > "$OUT"; rm -rf "$TMPD"; wc -l "$OUT"
