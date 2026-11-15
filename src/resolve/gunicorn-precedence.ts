// THE SEAM for gunicorn (and uvicorn) setting precedence.
//
// One setting can be written in several places: the command line, GUNICORN_CMD_ARGS (the
// manifest's literal env, or a linked Dockerfile's ENV), and the config file. Which one wins
// is relied on ONLY where a script has measured it.
//
// MEASURED (bolt B2, 2026-11-11, gunicorn 26.2.0 and 27.0.0, darwin-arm64, 126 runs in
// `measure/results/2026-11-11-b2.jsonl` and the table in `measure/README.md`): for `keepalive`,
// every single source, all 6 pairs, all 4 triples and the quadruple agree with the order
//   command line  >  GUNICORN_CMD_ARGS  >  config file
// where the config file is the `-c` file, or `./gunicorn.conf.py` from the working directory
// only when no `-c` is given (`-c` stops the default file from being loaded). It was measured
// with the uvicorn worker and literal integer values. Applying it to every worker class is an
// INFERENCE (precedence is settled in gunicorn's configuration layer before a worker exists), not a
// measurement: docs/limits.md.
//
// NOT MEASURED, so never relied on: any other setting (`--threads`, `-k`, `--graceful-timeout`,
// `-w`), the same flag twice, `-c` inside GUNICORN_CMD_ARGS, two `-c` sources, `--chdir`, `python:`
// configs. A conflict there is UNRESOLVED, "gunicorn setting precedence not yet measured for this
// setting".
//
// Rules, for contributions listed in the order: command, cmd-args-env, dockerfile-env, config-file:
//   - no place sets it                         -> undefined (the caller applies the default only
//                                                  because every place was read);
//   - `keepalive`: only the highest-ranked place counts (command, then env, then file); the lower
//     places cannot change it;
//   - any other setting: every place counts;
//   - among the places that count: one value -> it; all the same value -> it; one not read -> that
//     unresolved value (its own reason); different values -> UNRESOLVED, the fixed reason.
// To change what is relied on, edit THIS function only.

import { isUnresolved, makeUnresolved } from '../core/index.js';
import type { PyContribution, PyOrigin, PyValue } from '../parse/index.js';

export const REASON_PRECEDENCE = 'gunicorn setting precedence not yet measured for this setting';
export const REASON_UVICORN_PRECEDENCE = 'uvicorn setting precedence not yet measured';

/** Higher wins. `cmd-args-env` and `dockerfile-env` are the same variable (a manifest value replaces the image's). */
const MEASURED_RANK: Readonly<Record<PyOrigin, number>> = {
  command: 3,
  'cmd-args-env': 2,
  'dockerfile-env': 2,
  'config-file': 1,
};

function combine(
  program: 'gunicorn' | 'uvicorn',
  counted: readonly PyContribution[],
): PyValue | undefined {
  const [first] = counted;
  if (first === undefined) return undefined;
  if (counted.length === 1) return first.value;
  const unresolved = counted.find((c) => isUnresolved(c.value));
  if (unresolved !== undefined) return unresolved.value;
  const same = counted.every(
    (c) =>
      !isUnresolved(c.value) &&
      !isUnresolved(first.value) &&
      c.value.value === first.value.value &&
      c.value.unit === first.value.unit,
  );
  if (same) return first.value;
  return makeUnresolved(program === 'gunicorn' ? REASON_PRECEDENCE : REASON_UVICORN_PRECEDENCE);
}

export function resolveSettingPrecedence(
  program: 'gunicorn' | 'uvicorn',
  setting: string,
  contributions: readonly PyContribution[],
): PyValue | undefined {
  if (program === 'gunicorn' && setting === 'keepalive' && contributions.length > 0) {
    // not Math.max(...ranks): a spread of a huge array into a call overflows the stack
    const top = contributions.reduce((best, c) => Math.max(best, MEASURED_RANK[c.origin]), 0);
    return combine(
      program,
      contributions.filter((c) => MEASURED_RANK[c.origin] === top),
    );
  }
  return combine(program, contributions);
}
