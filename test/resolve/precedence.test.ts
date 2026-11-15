// The one seam for setting precedence. `keepalive` follows the order measured in
// bolt B2 (command line, then GUNICORN_CMD_ARGS, then the config file); every other setting, and
// every form that was not measured, stays UNRESOLVED when sources disagree.
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileSource,
  inputText,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
} from '../../src/core/index.js';
import type { PyContribution, PyOrigin } from '../../src/parse/python/index.js';
import {
  REASON_PRECEDENCE,
  REASON_UVICORN_PRECEDENCE,
  resolveSettingPrecedence,
} from '../../src/resolve/gunicorn-precedence.js';
import { cleanupTrees } from '../support/analyse.js';
import { cleanupPythonTrees, pythonApp, starKb, t1Summary } from '../support/python.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const at = (n: number) => fileSource(inputText('f'), n);
const num = (origin: PyOrigin, value: number, line = 1): PyContribution => ({
  origin,
  value: makeSourcedValue({ value, unit: 's', source: at(line), basis: 'declared' }),
});
const bad = (origin: PyOrigin, reason = 'not read'): PyContribution => ({
  origin,
  value: makeUnresolved(reason),
});
const shown = (c: ReturnType<typeof resolveSettingPrecedence>) =>
  c === undefined
    ? 'none'
    : isUnresolved(c)
      ? `?${c.reason}`
      : `${c.value}@${(c.source as { line: number }).line}`;

describe('keepalive: the measured order, command line > GUNICORN_CMD_ARGS > config file', () => {
  it('nothing sets it: undefined', () => {
    expect(resolveSettingPrecedence('gunicorn', 'keepalive', [])).toBeUndefined();
  });

  it.each([
    [
      'cli + env + file + default',
      [num('command', 3, 1), num('cmd-args-env', 5, 2), num('config-file', 7, 3)],
      '3@1',
    ],
    ['cli + env', [num('command', 3, 1), num('cmd-args-env', 5, 2)], '3@1'],
    ['cli + file', [num('command', 3, 1), num('config-file', 7, 3)], '3@1'],
    ['env + file', [num('cmd-args-env', 5, 2), num('config-file', 7, 3)], '5@2'],
    [
      'the Dockerfile ENV is the env level',
      [num('dockerfile-env', 5, 2), num('config-file', 7, 3)],
      '5@2',
    ],
    ['file alone', [num('config-file', 7, 3)], '7@3'],
  ])('%s', (_l, list, expected) => {
    expect(shown(resolveSettingPrecedence('gunicorn', 'keepalive', list))).toBe(expected);
  });

  it('a lower place that is not read cannot change a higher one', () => {
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          num('command', 3, 1),
          bad('config-file'),
        ]),
      ),
    ).toBe('3@1');
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          num('command', 3, 1),
          bad('cmd-args-env'),
          bad('config-file'),
        ]),
      ),
    ).toBe('3@1');
  });

  it('a higher place that is not read leaves the setting unread, whatever is below it', () => {
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          bad('command', 'cmd gap'),
          num('config-file', 7),
        ]),
      ),
    ).toBe('?cmd gap');
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          bad('cmd-args-env', 'env gap'),
          num('config-file', 7),
        ]),
      ),
    ).toBe('?env gap');
  });

  it('the same flag twice with different values is not measured: unresolved, fixed reason', () => {
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          num('command', 3, 1),
          num('command', 5, 2),
        ]),
      ),
    ).toBe(`?${REASON_PRECEDENCE}`);
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', 'keepalive', [
          num('command', 3, 1),
          num('command', 3, 2),
        ]),
      ),
    ).toBe('3@1');
  });
});

describe('every other setting: any disagreement is UNRESOLVED, "not yet measured for this setting"', () => {
  it.each(['threads', 'workerClass', 'gracefulTimeout', 'workers'])('%s', (name) => {
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', name, [num('command', 1), num('cmd-args-env', 4)]),
      ),
    ).toBe(`?${REASON_PRECEDENCE}`);
    expect(
      shown(resolveSettingPrecedence('gunicorn', name, [num('command', 4), num('config-file', 4)])),
    ).toBe('4@1');
    expect(
      shown(
        resolveSettingPrecedence('gunicorn', name, [
          num('command', 4),
          bad('config-file', 'conf gap'),
        ]),
      ),
    ).toBe('?conf gap');
    expect(shown(resolveSettingPrecedence('gunicorn', name, [num('command', 4, 9)]))).toBe('4@9');
  });

  it('the reason says "for this setting" and names the measurement as not done', () => {
    expect(REASON_PRECEDENCE).toBe('gunicorn setting precedence not yet measured for this setting');
  });

  it('uvicorn: its flag and its env disagreeing is unresolved (not measured)', () => {
    expect(
      shown(
        resolveSettingPrecedence('uvicorn', 'keepalive', [
          num('command', 3),
          num('cmd-args-env', 5),
        ]),
      ),
    ).toBe(`?${REASON_UVICORN_PRECEDENCE}`);
  });

  it('keepalive on uvicorn alone does not borrow the gunicorn order', () => {
    expect(
      shown(
        resolveSettingPrecedence('uvicorn', 'keepalive', [
          num('command', 3),
          num('config-file', 5),
        ]),
      ),
    ).toBe(`?${REASON_UVICORN_PRECEDENCE}`);
  });
});

describe('through the pipeline', () => {
  const UV = '"-k", "uvicorn_worker.UvicornWorker"';
  const env = (text: string) =>
    `\n          env:\n            - name: GUNICORN_CMD_ARGS\n              value: "${text}"`;

  it('cli beats env: the chain shows the command-line value (the winning source)', () => {
    const t = t1Summary(
      pythonApp(
        `          command: ["gunicorn", ${UV}, "--keep-alive", "3"]${env('--keep-alive 5')}`,
        { 'requirements.txt': 'gunicorn==26.2.0\n' },
      ),
    );
    expect(t.chain.find((c) => c.startsWith('keepalive'))).toBe(
      'keepalive: 3 s @ "k8s/app.yaml":20',
    );
  });

  it('env beats the linked config file', () => {
    const t = t1Summary(
      pythonApp(
        `          command: ["gunicorn", ${UV}, "-c", "gunicorn.conf.py"]${env('--keep-alive 5')}`,
        { 'gunicorn.conf.py': 'keepalive = 7\n', 'requirements.txt': 'gunicorn==26.2.0\n' },
      ),
    );
    expect(t.chain.find((c) => c.startsWith('keepalive'))).toBe(
      'keepalive: 5 s @ "k8s/app.yaml":22',
    );
  });

  it('an unlinked repository gunicorn.conf.py still leaves the worker class unresolved, even when the command sets it (class precedence is not measured)', () => {
    const t = t1Summary(
      pythonApp(
        `          command: ["gunicorn", ${UV}, "--keep-alive", "3"]`,
        { 'gunicorn.conf.py': 'keepalive = 9\n' },
        starKb(),
      ),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(
      'idle close not established: gunicorn.conf.py may be loaded from the working directory; link it in tripcurve.yaml',
    );
  });

  it('--threads in two places that disagree is unresolved for the worker model', () => {
    const t = t1Summary(
      pythonApp(
        `          command: ["gunicorn", "app:app", "--threads", "1"]${env('--threads 4')}`,
        {},
        starKb(),
      ),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(`idle close not established: ${REASON_PRECEDENCE}`);
  });

  it('-k in two places that disagree is unresolved', () => {
    const t = t1Summary(
      pythonApp(`          command: ["gunicorn", "-k", "sync"]${env('-k gthread')}`, {}, starKb()),
    );
    expect(t.headline).toBe(`idle close not established: ${REASON_PRECEDENCE}`);
  });

  it('-k in two places that agree is that class', () => {
    const t = t1Summary(
      pythonApp(`          command: ["gunicorn", "-k", "sync"]${env('-k sync')}`, {}, starKb()),
    );
    expect(t.kind).toBe('N/A');
  });

  it('-c in GUNICORN_CMD_ARGS and two -c flags stay unresolved (not measured)', () => {
    expect(
      t1Summary(
        pythonApp(`          command: ["gunicorn", "app:app"]${env('-c other.py')}`, {}, starKb()),
      ).kind,
    ).toBe('UNRESOLVED');
    expect(
      t1Summary(
        pythonApp(
          '          command: ["gunicorn", "-c", "a.py", "-c", "b.py"]',
          { 'a.py': 'x=1\n' },
          starKb(),
        ),
      ).headline,
    ).toContain('not a file path');
  });

  it('a python: config is not read', () => {
    const t = t1Summary(
      pythonApp('          command: ["gunicorn", "-c", "python:my.settings"]', {}, starKb()),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toContain('not a file path');
  });
});
