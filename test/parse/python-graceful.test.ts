// uvicorn's `--timeout-graceful-shutdown` (bolt B4): read from the command line only. Every near-form and
// every other place that could set it is an unresolved contribution, never skipped; the environment form
// was not measured, so a value there is never used.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKERFILE_ENV_NAMES,
  REASON_ENV_FILE,
  REASON_ENV_FROM_UVICORN_GRACEFUL,
  REASON_EXPANSION,
  REASON_FLAG_FORM,
  REASON_NO_VALUE,
  REASON_NOT_WHOLE_NUMBER,
  REASON_UVICORN_GRACEFUL_ENV,
  readDockerfileEnv,
  readPythonCommand,
  type UvicornCommandReading,
} from '../../src/parse/python/index.js';
import { cleanupPythonTrees, containerFrom, dockerfile, showAll } from '../support/python.js';

afterEach(cleanupPythonTrees);

function uvicorn(words: string[], extra = ''): UvicornCommandReading {
  const body = `          command: [${words.map((w) => JSON.stringify(w)).join(', ')}]${extra === '' ? '' : `\n${extra}`}`;
  const reading = readPythonCommand(containerFrom(body));
  if (reading?.program !== 'uvicorn') throw new Error('not uvicorn');
  return reading;
}
const graceful = (r: UvicornCommandReading): string[] => showAll(r.gracefulShutdown);

describe('the flag', () => {
  it.each([
    [['uvicorn', 'a:b'], []],
    [['uvicorn', 'a:b', '--timeout-graceful-shutdown', '5'], ['command:5s@app.yaml:14']],
    [['uvicorn', 'a:b', '--timeout-graceful-shutdown=5'], ['command:5s@app.yaml:14']],
    [['uvicorn', 'a:b', '--timeout-graceful-shutdown', '0'], ['command:0s@app.yaml:14']],
    [['uvicorn', 'a:b', '--timeout-keep-alive', '5'], []],
  ])('%j', (words, expected) => {
    expect(graceful(uvicorn(words))).toEqual(expected);
  });

  it('keeps the keep-alive reading unchanged when both flags are given', () => {
    const r = uvicorn([
      'uvicorn',
      'a:b',
      '--timeout-keep-alive',
      '7',
      '--timeout-graceful-shutdown',
      '5',
    ]);
    expect(showAll(r.keepalive)).toEqual(['command:7s@app.yaml:14']);
    expect(graceful(r)).toEqual(['command:5s@app.yaml:14']);
  });

  it.each([
    ['no value', ['uvicorn', 'a:b', '--timeout-graceful-shutdown'], REASON_NO_VALUE],
    [
      'a flag instead of a value',
      ['uvicorn', 'a:b', '--timeout-graceful-shutdown', '--reload'],
      REASON_NO_VALUE,
    ],
    [
      'a value that is not a whole number',
      ['uvicorn', 'a:b', '--timeout-graceful-shutdown', '5.5'],
      REASON_NOT_WHOLE_NUMBER,
    ],
    [
      'a negative value',
      ['uvicorn', 'a:b', '--timeout-graceful-shutdown', '-5'],
      REASON_NOT_WHOLE_NUMBER,
    ],
    ['an expansion', ['uvicorn', 'a:b', '--timeout-graceful-shutdown', '$(T)'], REASON_EXPANSION],
    ['an abbreviated flag', ['uvicorn', 'a:b', '--timeout-grace', '5'], REASON_FLAG_FORM],
    [
      'an abbreviation of both timeout flags',
      ['uvicorn', 'a:b', '--timeout-', '5'],
      REASON_FLAG_FORM,
    ],
    ['an env file', ['uvicorn', 'a:b', '--env-file', '.env'], REASON_ENV_FILE],
    ['an expansion that could be any flag', ['uvicorn', 'a:b', '$(FLAG)'], REASON_EXPANSION],
    ['a name that expands', ['uvicorn', 'a:b', '--timeout-$(X)', '5'], REASON_EXPANSION],
  ])('%s is unresolved, not skipped', (_name, words, reason) => {
    const out = graceful(uvicorn(words));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((l) => l.includes(reason))).toBe(true);
  });
});

describe('the environment', () => {
  it('UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN in the manifest is unresolved: the environment form was not measured', () => {
    const r = uvicorn(
      ['uvicorn', 'a:b', '--timeout-graceful-shutdown', '5'],
      '          env:\n            - name: UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN\n              value: "9"',
    );
    expect(graceful(r)).toEqual([
      'command:5s@app.yaml:14',
      `cmd-args-env:?${REASON_UVICORN_GRACEFUL_ENV}`,
    ]);
  });

  it('an envFrom could set it: unresolved', () => {
    const r = uvicorn(
      ['uvicorn', 'a:b'],
      '          envFrom:\n            - configMapRef:\n                name: c',
    );
    expect(graceful(r)).toEqual([`cmd-args-env:?${REASON_ENV_FROM_UVICORN_GRACEFUL}`]);
  });

  it('UVICORN_ENV_FILE names a file that is not read: unresolved', () => {
    const r = uvicorn(
      ['uvicorn', 'a:b'],
      '          env:\n            - name: UVICORN_ENV_FILE\n              value: .env',
    );
    expect(graceful(r)).toEqual([`cmd-args-env:?${REASON_ENV_FILE}`]);
  });

  it('a linked Dockerfile ENV of the variable is unresolved too', () => {
    const r = readPythonCommand(
      containerFrom('          command: ["uvicorn", "a:b"]'),
      readDockerEnv('FROM python:3\nENV UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN=7\n'),
    );
    if (r?.program !== 'uvicorn') throw new Error('not uvicorn');
    expect(showAll(r.gracefulShutdown)).toEqual([`dockerfile-env:?${REASON_UVICORN_GRACEFUL_ENV}`]);
  });
});

function readDockerEnv(text: string) {
  return readDockerfileEnv(dockerfile(text), DOCKERFILE_ENV_NAMES);
}
