// Reads gunicorn and uvicorn command-line flags from a list of words (a container
// command and args, or the words of GUNICORN_CMD_ARGS). Pure; nothing is executed.
//
// A flag is read only in the forms below. Every other form that could be one of the
// flags read here is recorded as an UNRESOLVED contribution to the setting it could be,
// never skipped:
//   - an abbreviation of a long flag (argparse accepts unambiguous prefixes), such as
//     `--keep`;
//   - a short flag written `-k=x`, or clustered with other short flags (`-Dk x`);
//   - a flag whose name or value holds a `$(...)` reference, which Kubernetes expands
//     from an environment variable that is not read;
//   - a flag with no value.
// A word with a `$(` before any text that rules out a flag (`$(FLAG)`, `--$(X)`) could be
// ANY flag after expansion, so every setting of that origin is unresolved.

import { makeSourcedValue, makeUnresolved, type SourceRef } from '../../core/index.js';
import {
  GUNICORN_SETTING_NAMES,
  type GunicornConfigArg,
  type GunicornSettingName,
  type PyContribution,
  type PyOrigin,
  type PyValue,
  REASON_CLASS_UNKNOWN,
  REASON_ENV_FILE,
  REASON_EXPANSION,
  REASON_FLAG_FORM,
  REASON_NO_VALUE,
  REASON_NOT_WHOLE_NUMBER,
  type UvicornHttpSetting,
} from './model.js';

export interface Word {
  readonly text: string;
  readonly source: SourceRef;
}

type Target = GunicornSettingName | 'config' | 'chdir';

const GUNICORN_LONG: ReadonlyArray<readonly [string, Target]> = [
  ['--worker-class', 'workerClass'],
  ['--threads', 'threads'],
  ['--keep-alive', 'keepalive'],
  ['--graceful-timeout', 'gracefulTimeout'],
  ['--workers', 'workers'],
  ['--config', 'config'],
  ['--chdir', 'chdir'],
];
const GUNICORN_SHORT: Readonly<Record<string, Target>> = {
  k: 'workerClass',
  w: 'workers',
  c: 'config',
};
/** gunicorn's other short flags that take a value (kept only so a value is not read as a flag). */
const OTHER_VALUE_SHORT = new Set(['b', 't', 'p', 'u', 'g', 'm', 'n', 'e']);

/**
 * The worker classes gunicorn is run with that this release knows. Each spelling is
 * matched exactly; what comes out is tripcurve's own word (never the input's string).
 * `uvicorn.workers.UvicornWorker` and `uvicorn_worker.UvicornWorker` are the uvicorn
 * worker. Anything else, including a bare `uvicorn`, is not a class
 * name gunicorn accepts and is unknown.
 */
const WORKER_CLASS_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['sync', 'sync'],
  ['gthread', 'gthread'],
  ['gevent', 'gevent'],
  ['eventlet', 'eventlet'],
  ['tornado', 'tornado'],
  ['uvicorn.workers.UvicornWorker', 'uvicorn'],
  ['uvicorn_worker.UvicornWorker', 'uvicorn'],
];

export function workerClassOf(text: string): string | undefined {
  return WORKER_CLASS_SPELLINGS.find(([spelling]) => spelling === text)?.[1];
}

const WHOLE_NUMBER = /^[0-9]+$/;

export function wholeNumberOf(text: string): number | undefined {
  if (!WHOLE_NUMBER.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The value of one setting as text from a flag, or from a config literal, as a sourced or unresolved value. */
export function settingValue(name: GunicornSettingName, text: string, source: SourceRef): PyValue {
  if (text.includes('$(')) return makeUnresolved(REASON_EXPANSION);
  if (name === 'workerClass') {
    const word = workerClassOf(text);
    return word === undefined
      ? makeUnresolved(REASON_CLASS_UNKNOWN)
      : makeSourcedValue({ value: word, unit: 'none', source, basis: 'declared' });
  }
  const n = wholeNumberOf(text);
  if (n === undefined) return makeUnresolved(REASON_NOT_WHOLE_NUMBER);
  const unit = name === 'keepalive' || name === 'gracefulTimeout' ? 's' : 'none';
  return makeSourcedValue({ value: n, unit, source, basis: 'declared' });
}

export function emptyContributions(): Record<GunicornSettingName, PyContribution[]> {
  return { workerClass: [], threads: [], keepalive: [], gracefulTimeout: [], workers: [] };
}

export interface GunicornAcc {
  readonly settings: Record<GunicornSettingName, PyContribution[]>;
  configArg?: GunicornConfigArg;
  /** Where `--chdir` is written: it changes the folder gunicorn looks for its config file in. */
  chdir?: SourceRef;
}

export function newGunicornAcc(): GunicornAcc {
  return { settings: emptyContributions() };
}

/** Every setting of an origin is unresolved: a place that could set any of them was not read. */
export function markAllGunicorn(acc: GunicornAcc, origin: PyOrigin, reason: string): void {
  for (const name of GUNICORN_SETTING_NAMES) {
    acc.settings[name].push({ origin, value: makeUnresolved(reason) });
  }
}

/** True when a word could become a flag once Kubernetes expands its `$(...)` references. */
function couldExpandToFlag(text: string): boolean {
  const at = text.indexOf('$(');
  if (at < 0) return false;
  return /^[A-Za-z-]*$/.test(text.slice(0, at));
}

function configArgOf(text: string | undefined, source: SourceRef): GunicornConfigArg {
  if (text === undefined) return { kind: 'no-value', source };
  // `python:module.name` is a module, not a path; `file:` is not a form this release reads.
  if (text === '' || text.includes('$(') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    return { kind: 'not-a-path', source };
  }
  return { kind: 'path', path: text, source };
}

function recordGunicorn(
  acc: GunicornAcc,
  origin: PyOrigin,
  target: Target,
  value: string | undefined,
  source: SourceRef,
): void {
  if (target === 'chdir') {
    acc.chdir ??= source;
    return;
  }
  if (target === 'config') {
    // two `-c` flags: which one gunicorn uses is not measured
    acc.configArg =
      acc.configArg === undefined ? configArgOf(value, source) : { kind: 'not-a-path', source };
    return;
  }
  acc.settings[target].push({
    origin,
    value:
      value === undefined ? makeUnresolved(REASON_NO_VALUE) : settingValue(target, value, source),
  });
}

function unresolvedTarget(acc: GunicornAcc, origin: PyOrigin, target: Target, source: SourceRef) {
  if (target === 'chdir') {
    acc.chdir ??= source;
    return;
  }
  if (target === 'config') {
    acc.configArg = { kind: 'not-a-path', source };
    return;
  }
  acc.settings[target].push({ origin, value: makeUnresolved(REASON_FLAG_FORM) });
}

const looksLikeFlag = (text: string): boolean =>
  text.startsWith('-') && text.length > 1 && !/^-[0-9]/.test(text);

/** Reads the gunicorn flags of `words` (the program word already removed) into `acc`. */
export function readGunicornFlags(
  words: readonly Word[],
  origin: PyOrigin,
  acc: GunicornAcc,
): void {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Word;
    const text = word.text;
    i += 1;
    if (text === '--') return;
    if (!text.startsWith('-') || text === '-') {
      if (couldExpandToFlag(text)) markAllGunicorn(acc, origin, REASON_EXPANSION);
      continue;
    }
    const takeValue = (
      inline: string | undefined,
    ): { text: string | undefined; source: SourceRef } => {
      if (inline !== undefined) return { text: inline, source: word.source };
      const next = words[i];
      if (next === undefined || looksLikeFlag(next.text))
        return { text: undefined, source: word.source };
      i += 1;
      return { text: next.text, source: next.source };
    };
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq < 0 ? text : text.slice(0, eq);
      const inline = eq < 0 ? undefined : text.slice(eq + 1);
      if (name.includes('$(')) {
        markAllGunicorn(acc, origin, REASON_EXPANSION);
        continue;
      }
      const exact = GUNICORN_LONG.find(([long]) => long === name);
      if (exact !== undefined) {
        const v = takeValue(inline);
        recordGunicorn(acc, origin, exact[1], v.text, v.source);
        continue;
      }
      if (name.length >= 3) {
        // argparse accepts any unambiguous prefix of a long flag: a prefix of one read here is not read.
        for (const [long, target] of GUNICORN_LONG) {
          if (long.startsWith(name)) unresolvedTarget(acc, origin, target, word.source);
        }
      }
      continue;
    }
    // a short flag
    const letter = text[1] as string;
    const rest = text.slice(2);
    if (
      letter === '$' ||
      (!Object.hasOwn(GUNICORN_SHORT, letter) &&
        !OTHER_VALUE_SHORT.has(letter) &&
        rest.includes('$('))
    ) {
      // `-$(X)` or `-D$(X)`: the expanded text could be any flag
      markAllGunicorn(acc, origin, REASON_EXPANSION);
      continue;
    }
    const target = GUNICORN_SHORT[letter];
    if (target !== undefined) {
      if (rest.startsWith('=')) unresolvedTarget(acc, origin, target, word.source);
      else {
        const v = takeValue(rest === '' ? undefined : rest);
        recordGunicorn(acc, origin, target, v.text, v.source);
      }
    } else if (OTHER_VALUE_SHORT.has(letter)) {
      if (rest === '') takeValue(undefined);
    } else if (rest !== '') {
      // clustered short flags: which one takes the value is not known here
      for (const l of rest) {
        const t = GUNICORN_SHORT[l];
        if (t !== undefined) unresolvedTarget(acc, origin, t, word.source);
      }
    }
  }
}

// ---- uvicorn ----------------------------------------------------------------------------

const UVICORN_KEEPALIVE_FLAG = '--timeout-keep-alive';
const UVICORN_GRACEFUL_FLAG = '--timeout-graceful-shutdown';
const UVICORN_ENV_FILE_FLAG = '--env-file';
const UVICORN_HTTP_FLAG = '--http';

export function uvicornValue(text: string, source: SourceRef): PyValue {
  if (text.includes('$(')) return makeUnresolved(REASON_EXPANSION);
  const n = wholeNumberOf(text);
  return n === undefined
    ? makeUnresolved(REASON_NOT_WHOLE_NUMBER)
    : makeSourcedValue({ value: n, unit: 's', source, basis: 'declared' });
}

/** Reads `--timeout-keep-alive` from uvicorn's command line (click: `--flag value` or `--flag=value`). */
export function readUvicornFlags(
  words: readonly Word[],
  origin: PyOrigin,
): { keepalive: PyContribution[]; gracefulShutdown: PyContribution[]; http: UvicornHttpSetting[] } {
  const out: PyContribution[] = [];
  const graceful: PyContribution[] = [];
  const http: UvicornHttpSetting[] = [];
  const unresolved = (reason: string): void => {
    out.push({ origin, value: makeUnresolved(reason) });
  };
  /** A flag that could be either setting (an expansion, an abbreviation) is unresolved for both. */
  const unresolvedBoth = (reason: string): void => {
    unresolved(reason);
    graceful.push({ origin, value: makeUnresolved(reason) });
  };
  let i = 0;
  while (i < words.length) {
    const word = words[i] as Word;
    const text = word.text;
    i += 1;
    if (text === '--') break;
    if (!text.startsWith('-') || text === '-') {
      if (couldExpandToFlag(text)) unresolvedBoth(REASON_EXPANSION);
      continue;
    }
    if (!text.startsWith('--')) continue;
    const eq = text.indexOf('=');
    const name = eq < 0 ? text : text.slice(0, eq);
    const inline = eq < 0 ? undefined : text.slice(eq + 1);
    if (name.includes('$(')) {
      unresolvedBoth(REASON_EXPANSION);
      continue;
    }
    if (name === UVICORN_GRACEFUL_FLAG) {
      let value = inline;
      let source = word.source;
      if (value === undefined) {
        const next = words[i];
        if (next !== undefined && !looksLikeFlag(next.text)) {
          value = next.text;
          source = next.source;
          i += 1;
        }
      }
      if (value === undefined) graceful.push({ origin, value: makeUnresolved(REASON_NO_VALUE) });
      else graceful.push({ origin, value: uvicornValue(value, source) });
    } else if (name === UVICORN_KEEPALIVE_FLAG) {
      let value = inline;
      let source = word.source;
      if (value === undefined) {
        const next = words[i];
        if (next !== undefined && !looksLikeFlag(next.text)) {
          value = next.text;
          source = next.source;
          i += 1;
        }
      }
      if (value === undefined) unresolved(REASON_NO_VALUE);
      else out.push({ origin, value: uvicornValue(value, source) });
    } else if (name === UVICORN_HTTP_FLAG) {
      let value = inline;
      if (value === undefined) {
        const next = words[i];
        if (next !== undefined && !looksLikeFlag(next.text)) {
          value = next.text;
          i += 1;
        }
      }
      http.push({ origin, text: value === undefined || value.includes('$(') ? undefined : value });
    } else if (name.length >= 3 && UVICORN_HTTP_FLAG.startsWith(name)) {
      // `--htt`: a prefix of `--http` (argparse-style abbreviations are not read)
      http.push({ origin, text: undefined });
      if (inline === undefined) i += 1;
    } else if (name === UVICORN_ENV_FILE_FLAG) {
      unresolvedBoth(REASON_ENV_FILE);
      if (inline === undefined) i += 1;
    } else if (name.length >= 3 && UVICORN_KEEPALIVE_FLAG.startsWith(name)) {
      unresolved(REASON_FLAG_FORM);
      // `--timeout-` is a prefix of both flags: it could be either one
      if (UVICORN_GRACEFUL_FLAG.startsWith(name)) {
        graceful.push({ origin, value: makeUnresolved(REASON_FLAG_FORM) });
      }
    } else if (name.length >= 3 && UVICORN_GRACEFUL_FLAG.startsWith(name)) {
      graceful.push({ origin, value: makeUnresolved(REASON_FLAG_FORM) });
    } else if (name.length >= 3 && UVICORN_ENV_FILE_FLAG.startsWith(name)) {
      unresolvedBoth(REASON_ENV_FILE);
    }
  }
  return { keepalive: out, gracefulShutdown: graceful, http };
}
