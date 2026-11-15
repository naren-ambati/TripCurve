#!/usr/bin/env bash
# tripcurve GitHub Action: all shell logic. action.yml only calls this file, so it can be
# tested without GitHub. Two modes:
#   run.sh build   install (lockfile, no scripts) and build the CLI from the Action's own checkout
#   run.sh check   run the CLI for the log, run it again for SARIF, set the outputs, fail on any non-zero
#
# Inputs arrive only as environment variables (never as ${{ }} text in a script body), so no input can
# become shell code. They reach the CLI as separate argv entries, after `--` for the path.
#   TRIPCURVE_PATH        default "."
#   TRIPCURVE_CONFIG      optional
#   TRIPCURVE_FORMAT      human | json | sarif (default human)
#   TRIPCURVE_SARIF_FILE  default tripcurve.sarif, relative to the workspace
# Set by the runner: GITHUB_ACTION_PATH, GITHUB_WORKSPACE, GITHUB_OUTPUT.
# Test hook: TRIPCURVE_CLI replaces the built CLI file (a workflow author controls it, as every env).
#
# Honesty: the script never exits 0 unless both CLI runs exited 0 and the SARIF file is valid JSON
# with version 2.1.0. `exit-code` is always written, as an integer. A crash (3), a signal, a missing
# `node` or CLI, a failed build and an unusable SARIF file are each reported as what they are.

set -uo pipefail

MODE="${1:-}"
OUT="${GITHUB_OUTPUT:-/dev/null}"

say() { printf 'tripcurve action: %s\n' "$*" >&2; }

# Input text is data: printable ASCII only (no newline, so no forged log line or workflow
# command), no quote or backslash, at most 80 characters.
quote() {
  local clean
  clean=$(printf '%s' "$1" | LC_ALL=C tr -c ' -~' '?' | LC_ALL=C tr '"\\' '??' | cut -c1-80)
  printf '"%s"' "$clean"
}

# Only integers and validated paths are ever written to the outputs file.
set_output() { printf '%s=%s\n' "$1" "$2" >> "$OUT"; }

usage_fail() {
  say "$1"
  set_output exit-code 2
  exit 2
}

case "$MODE" in
  build)
    cd "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is not set}" || { say "cannot enter the Action checkout"; set_output exit-code 3; exit 3; }
    if ! npm ci --ignore-scripts; then
      say "build failed: npm ci --ignore-scripts exited non-zero. Nothing was checked."
      set_output exit-code 3
      exit 3
    fi
    if ! npm run build; then
      say "build failed: npm run build exited non-zero. Nothing was checked."
      set_output exit-code 3
      exit 3
    fi
    exit 0
    ;;
  check) ;;
  *) usage_fail "unknown mode $(quote "$MODE")" ;;
esac

# ---- check mode ------------------------------------------------------------------------------

path="${TRIPCURVE_PATH:-.}"
config="${TRIPCURVE_CONFIG:-}"
format="${TRIPCURVE_FORMAT:-human}"
sarif="${TRIPCURVE_SARIF_FILE:-tripcurve.sarif}"
workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is not set}"

case "$format" in
  human | json | sarif) ;;
  *) usage_fail "format must be one of human, json, sarif; got $(quote "$format")" ;;
esac

# The SARIF file is written inside the workspace only: not absolute, no `..` component, no control
# character, not empty, and (checked below) no symlink on the way out.
bad_sarif() { usage_fail "sarif-file must be a relative path inside the workspace; got $(quote "$sarif")"; }
[ -n "$sarif" ] || bad_sarif
case "$sarif" in /*) bad_sarif ;; esac
# (a control character becomes "?", so the text changes; not grep, which works line by line, and not
# tr -d, whose output loses a trailing newline in $(...))
if [ "$(printf '%s' "$sarif" | LC_ALL=C tr -c ' -~' '?')" != "$sarif" ]; then bad_sarif; fi
case "/$sarif/" in */../*) bad_sarif ;; esac
case "$sarif" in */) bad_sarif ;; esac

cd "$workspace" || usage_fail "cannot enter the workspace"
ws_real=$(pwd -P)
target_dir="$(dirname -- "$sarif")"
# Walk the folder part one component at a time. Each existing component is resolved with `pwd -P` and must
# stay inside the workspace (a symlink inside it is fine, one that leaves it is not); a missing component is
# created only under a folder already shown to be inside. So nothing is ever created outside the workspace.
cur="$ws_real"
rest="$target_dir"
while [ -n "$rest" ] && [ "$rest" != "." ]; do
  comp="${rest%%/*}"
  if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
  [ -z "$comp" ] || [ "$comp" = "." ] && continue
  next="$cur/$comp"
  if [ -e "$next" ] || [ -L "$next" ]; then
    next=$(cd -- "$next" 2> /dev/null && pwd -P) || bad_sarif
  else
    mkdir -- "$next" 2> /dev/null || bad_sarif
  fi
  case "$next/" in "$ws_real"/*) ;; *) bad_sarif ;; esac
  cur="$next"
done
dir_real="$cur"
final="$dir_real/$(basename -- "$sarif")"
if [ -L "$final" ] || [ -d "$final" ]; then bad_sarif; fi

cli="${TRIPCURVE_CLI:-${GITHUB_ACTION_PATH:-}/dist/cli/main.js}"
fail_now() { # code, message
  say "$2"
  set_output exit-code "$1"
  exit "$1"
}
command -v node > /dev/null 2>&1 || fail_now 127 "node was not found. Nothing was checked."
[ -f "$cli" ] || fail_now 127 "the tripcurve CLI was not found (was it built?). Nothing was checked."

args=()
if [ -n "$config" ]; then args+=(--config "$config"); fi

tmp=$(mktemp "$dir_real/.tripcurve-sarif.XXXXXX") || fail_now 3 "cannot create a temporary file for the SARIF output. Nothing was checked."
trap 'rm -f -- "$tmp"' EXIT

# Run 1: the report in the chosen format, for the log. stdin is closed so `-` never blocks.
node "$cli" --format "$format" ${args[@]+"${args[@]}"} -- "$path" < /dev/null
rc1=$?
# Run 2: SARIF, into a temporary file next to its final place.
node "$cli" --format sarif ${args[@]+"${args[@]}"} -- "$path" < /dev/null > "$tmp"
rc2=$?

explain() { # label, code
  case "$2" in
    0) ;;
    1) say "$1: failures were found (exit 1). See the report above." ;;
    2) say "$1: nothing was checked, or the command line or configuration was refused (exit 2)." ;;
    3) say "$1: tripcurve hit an internal error (exit 3). Nothing was verified; this is not a list of failures." ;;
    127) say "$1: the command was not found (exit 127). Nothing was verified." ;;
    *)
      if [ "$2" -gt 128 ]; then
        say "$1: tripcurve was stopped by signal $(($2 - 128)) (exit $2). Nothing was verified."
      else
        say "$1: tripcurve exited with the unexpected code $2. Nothing was verified."
      fi
      ;;
  esac
}
explain "report run" "$rc1"
if [ "$rc2" -ne "$rc1" ]; then explain "SARIF run" "$rc2"; fi

# The SARIF file must be a JSON document with version 2.1.0 whenever the CLI says it produced a
# report (exit 0 or 1). An empty or broken file after exit 0 is not a pass.
sarif_ok=1
if [ "$rc2" -eq 0 ] || [ "$rc2" -eq 1 ]; then
  if ! node -e '
    const t = require("node:fs").readFileSync(process.argv[1], "utf8");
    const d = JSON.parse(t);
    if (d === null || typeof d !== "object" || d.version !== "2.1.0" || !Array.isArray(d.runs) || d.runs.length < 1) process.exit(1);
  ' "$tmp" 2> /dev/null; then
    sarif_ok=0
    say "the SARIF output is empty or is not a SARIF 2.1.0 document. It was not trusted."
  fi
fi

if [ "$sarif_ok" -eq 1 ] && { [ "$rc2" -eq 0 ] || [ "$rc2" -eq 1 ]; }; then
  mv -f -- "$tmp" "$final" || fail_now 3 "the SARIF file could not be moved into place. Nothing was trusted."
  set_output sarif-file "$sarif"
fi

# First non-zero code wins; a SARIF file that cannot be trusted after two clean runs is an internal error.
code=0
if [ "$rc1" -ne 0 ]; then
  code=$rc1
elif [ "$rc2" -ne 0 ]; then
  code=$rc2
elif [ "$sarif_ok" -ne 1 ]; then
  code=3
fi
set_output exit-code "$code"
if [ "$code" -eq 0 ]; then exit 0; fi
say "failing: exit code $code."
exit "$code"
