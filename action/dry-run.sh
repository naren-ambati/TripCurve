#!/usr/bin/env bash
# A local dry run of the Action's steps (B9 expected demo): the same two steps action.yml runs
# (`run.sh build`, then `run.sh check` with the inputs as environment variables), against a
# fixture repo, in a throwaway workspace. Differences from a hosted run, all deliberate:
#   - actions/setup-node is skipped (the Node on PATH is used);
#   - `npm ci` is stubbed, so nothing is downloaded (the checkout already has node_modules);
#   - the upload step is NEVER run: uploading is an external write to GitHub code scanning, so it cannot
#     be simulated. The script only evaluates the step's condition (upload-sarif is the exact string
#     "true" and the check step set a sarif-file output) and prints whether the step would run.
# Environment: DRY_RUN_UPLOAD_SARIF (the upload-sarif input, default false), DRY_RUN_SARIF_FILE (the
# sarif-file input, default tripcurve.sarif).
# Usage: action/dry-run.sh [fixture-dir]   (default: test/fixtures/report/demo, which fails)
# Exits with the code the Action step would have: 0, or the CLI's first non-zero code.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
fixture=${1:-$root/test/fixtures/report/demo}
[ -d "$fixture" ] || { echo "dry-run: not a directory: $fixture" >&2; exit 2; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/tripcurve-dry-run.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/workspace"
cp -R "$fixture/." "$tmp/workspace/"
real_npm=$(command -v npm) || { echo "dry-run: npm not found" >&2; exit 2; }
cat > "$tmp/bin/npm" <<STUB
#!/bin/sh
if [ "\$1" = "ci" ]; then
  echo "[dry-run] npm \$* (stubbed: nothing downloaded)"
  exit 0
fi
exec "$real_npm" "\$@"
STUB
chmod +x "$tmp/bin/npm"

export PATH="$tmp/bin:$PATH"
export GITHUB_ACTION_PATH="$root" GITHUB_WORKSPACE="$tmp/workspace" GITHUB_OUTPUT="$tmp/output"
: > "$GITHUB_OUTPUT"

echo "[dry-run] step build"
bash "$root/action/run.sh" build || { echo "[dry-run] build step failed; outputs:"; cat "$GITHUB_OUTPUT"; exit 3; }

upload=${DRY_RUN_UPLOAD_SARIF:-false}
sarif_input=${DRY_RUN_SARIF_FILE:-tripcurve.sarif}
echo "[dry-run] step check (path=. config= format=human sarif-file=$sarif_input upload-sarif=$upload), fixture $(basename "$fixture")"
TRIPCURVE_PATH=. TRIPCURVE_CONFIG= TRIPCURVE_FORMAT=human TRIPCURVE_SARIF_FILE=$sarif_input \
  bash "$root/action/run.sh" check
code=$?

echo "[dry-run] step check exited $code; outputs:"
cat "$GITHUB_OUTPUT"
if [ -f "$tmp/workspace/$sarif_input" ]; then
  node -e 'const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log("[dry-run] " + require("node:path").basename(process.argv[1]) + ": version " + d.version + ", " + d.runs[0].results.length + " results")' "$tmp/workspace/$sarif_input"
fi
# The condition of the upload step in action.yml, evaluated here (always() is true in a dry run).
if [ "$upload" != "true" ]; then
  echo "[dry-run] upload-sarif is not \"true\": the upload step is skipped"
elif ! grep -q '^sarif-file=.' "$GITHUB_OUTPUT"; then
  echo "[dry-run] upload-sarif is \"true\" but no SARIF file was written: the upload step is skipped"
else
  echo "[dry-run] upload-sarif is \"true\" and a SARIF file was written: the upload step would run here. NOT SIMULATED: it is an external write to GitHub code scanning"
fi
exit "$code"
