#!/bin/sh
# B3 extra points. Versions run in parallel (each run has its own port);
# cases and runs within a version are sequential. Output order is fixed.
# Usage: sh measure/run-b3-points.sh <cache-dir> > measure/results/<date>-b3-points.jsonl
# Failures and skips go to stderr; any failure makes the exit code 1.
set -u
C="${1:?usage: run-b3-points.sh <cache-dir>}"
D="$(dirname "$0")"
T="$(mktemp -d)"
VERSIONS="18.20.8 20.20.2 22.12.0 22.18.0 22.19.0 22.23.5 24.0.0 24.5.0 24.6.0 24.22.3 26.0.0 26.13.1"
one() {
  v=$1; bin="$C/node/node-v$v-darwin-arm64/bin/node"
  cases="explicit12000 explicit65000"
  case " 22.12.0 22.23.5 24.0.0 26.0.0 " in *" $v "*) cases="$cases options65000";; esac
  case " 22.19.0 22.23.5 24.6.0 24.22.3 26.0.0 26.13.1 " in *" $v "*) cases="$cases buffer1000-k7000 buffer0-k65000";; esac
  case " 22.23.5 24.22.3 26.13.1 " in *" $v "*) cases="explicit12000 explicit65000 $(echo "$cases" | sed 's/explicit12000 explicit65000//')";; esac
  # 22.23.5, 24.22.3, 26.13.1 only need the cases listed for them: drop the
  # all-nine cases there (they were measured in the earlier B3 run).
  case " 22.23.5 24.22.3 26.13.1 " in *" $v "*) cases=$(echo "$cases" | sed 's/explicit12000//; s/explicit65000//');; esac
  for c in $cases; do
    for i in 1 2 3; do
      env -i PATH=/usr/bin:/bin HOME="$HOME" "$bin" "$D/node-b3-points.mjs" "$c" >> "$T/$v.jsonl" 2>> "$T/$v.err"
      rc=$?; [ $rc -eq 0 ] && continue
      echo "failed: node $v $c run $i (exit $rc)" >> "$T/$v.err"; echo 1 > "$T/$v.failed"
    done
  done
}
for v in $VERSIONS; do one "$v" & done
wait
failed=0
for v in $VERSIONS; do cat "$T/$v.jsonl" 2>/dev/null; [ -s "$T/$v.err" ] && cat "$T/$v.err" >&2; [ -f "$T/$v.failed" ] && failed=1; done
rm -rf "$T"
exit $failed
