// Rule T3 end to end: grace >= preStop + in-process drain + L + 1 s, with every
// outcome, the NOT EVALUATED chain from T2, and the honesty rules: a term that is
// not established makes the result UNRESOLVED, never PASS and never FAIL.
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyseFiles,
  cleanupTrees,
  lineOf,
  renderChain,
  ruleOf,
  sleepLifecycle,
  webManifest,
} from '../support/analyse.js';
import { pythonApp } from '../support/python.js';

afterEach(cleanupTrees);

const run = (files: Record<string, string | null>) => analyseFiles(files).result;
const T3 = (files: Record<string, string | null>) => ruleOf(run(files), 'T3');
const grace = (n: number | string): string => `      terminationGracePeriodSeconds: ${n}`;
const longest = (seconds: number): string =>
  [
    'version: 1',
    'workloads:',
    '  - name: web',
    '    namespace: shop',
    `    longest_request_s: ${seconds}`,
    '',
  ].join('\n');
const SERVER_HEAD = [
  "import http from 'node:http';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
  '',
].join('\n');
const DECLARE_L = 'declare longest_request_s for this workload in tripcurve.yaml';

describe('T2 failed', () => {
  it('NOT EVALUATED, with the reason and no chain', () => {
    const f = T3({});
    expect(lineOf(f)).toBe('NOT EVALUATED T2 failed for this workload');
    expect(f.chain).toEqual([]);
  });
});

describe('no ceiling and no declaration', () => {
  it('a Node server: UNRESOLVED, with what to declare (the expected report layout, web)', () => {
    const f = T3({
      'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10), pod: grace(45) }),
    });
    expect(lineOf(f)).toBe('UNRESOLVED no graceful-timeout ceiling known for a Node server');
    expect(renderChain(f)).toEqual([
      'grace: 45 s @ "k8s/web.yaml":26',
      'preStop: 10 s @ "k8s/web.yaml":25',
    ]);
    expect(f.declare).toEqual([DECLARE_L]);
  });
});

describe('a declared longest_request_s', () => {
  const web = (g: number, pre = 10) => ({
    'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(pre), pod: grace(g) }),
    'tripcurve.yaml': longest(5),
  });

  it('PASS with the arithmetic shown (the expected report layout, web)', () => {
    const f = T3(web(45));
    expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 0 s + 5 s + 1 s');
    expect(renderChain(f)).toEqual([
      'grace: 45 s @ "k8s/web.yaml":26',
      'preStop: 10 s @ "k8s/web.yaml":25',
      'longest req: 5 s @ "tripcurve.yaml":5',
    ]);
  });

  it('exactly enough is PASS (>=), one second short is FAIL', () => {
    expect(lineOf(T3(web(16)))).toBe('PASS grace 16 s covers 10 s + 0 s + 5 s + 1 s');
    expect(lineOf(T3(web(15)))).toBe('FAIL grace 15 s is less than 10 s + 0 s + 5 s + 1 s');
  });

  it('a fractional L is added exactly (whole milliseconds, no float error)', () => {
    const files = { ...web(12), 'tripcurve.yaml': longest(0.3) };
    expect(lineOf(T3(files))).toBe('PASS grace 12 s covers 10 s + 0 s + 0.3 s + 1 s');
    const tight = {
      'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(0), pod: grace(1) }),
      'tripcurve.yaml': longest(0.1),
    };
    // T2 fails first (no drain), so declare a drain too: 0 + 0.7 + 0.2 + 0.1 + 1 = 2 exactly
    const f = T3({
      ...tight,
      'tripcurve.yaml': [
        'version: 1',
        'workloads:',
        '  - name: web',
        '    namespace: shop',
        '    longest_request_s: 0.2',
        '    drain:',
        '      in_process_s: 0.7',
        '',
      ].join('\n'),
      'k8s/web.yaml': webManifest({ pod: grace(2) }),
    });
    expect(lineOf(f)).toBe('PASS grace 2 s covers 0 s + 0.7 s + 0.2 s + 1 s');
  });

  it('with the default grace period: the documented 30 s, cited as the deciding source', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10) }),
      'tripcurve.yaml': longest(5),
    });
    const f = ruleOf(result, 'T3');
    expect(lineOf(f)).toBe('PASS grace 30 s covers 10 s + 0 s + 5 s + 1 s');
    expect(renderChain(f)[0]).toBe(
      'grace: 30 s @ default: Kubernetes terminationGracePeriodSeconds (documented)',
    );
  });

  it('with the default grace period and a long request: FAIL', () => {
    const files = {
      'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10) }),
      'tripcurve.yaml': longest(25),
    };
    expect(lineOf(T3(files))).toBe('FAIL grace 30 s is less than 10 s + 0 s + 25 s + 1 s');
  });

  it('a declared longest request overrides a ceiling', () => {
    const r = pythonApp(
      [
        '          command: ["gunicorn", "app:app"]',
        '          lifecycle: {preStop: {exec: {command: ["sleep", "10"]}}}',
        grace(45),
      ].join('\n'),
      {
        'requirements.txt': 'gunicorn==26.2.0\n',
        'tripcurve.yaml': [
          'version: 1',
          'workloads:',
          '  - name: app',
          '    namespace: shop',
          '    longest_request_s: 5',
          '',
        ].join('\n'),
      },
    );
    expect(lineOf(ruleOf(r, 'T3'))).toBe('PASS grace 45 s covers 10 s + 0 s + 5 s + 1 s');
  });

  it('an absurd value is UNRESOLVED, not a crash and not a verdict', () => {
    const f = T3({ ...web(45), 'tripcurve.yaml': longest(1e300) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('the declared longest request is not a number of seconds');
  });
});

describe('a ceiling and no declaration', () => {
  const app = (container: string, pins = 'gunicorn==26.2.0\nuvicorn==0.54.0\n') =>
    pythonApp(container, { 'requirements.txt': pins });
  const sleep10 = '          lifecycle: {preStop: {exec: {command: ["sleep", "10"]}}}';

  it('PASS when grace covers the bound (the expected report layout, admin): the ceiling is the measured 30 s', () => {
    const r = app(
      ['          command: ["gunicorn", "app:app", "-w", "2"]', sleep10, grace(45)].join('\n'),
    );
    const f = ruleOf(r, 'T3');
    expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 0 s + 30 s + 1 s');
    expect(renderChain(f)).toEqual([
      'grace: 45 s @ "k8s/app.yaml":22',
      'preStop: 10 s @ "k8s/app.yaml":21',
      'ceiling: 30 s @ default: gunicorn graceful_timeout (gunicorn 26.x; measured on 26.2.0)',
    ]);
    expect(r.assumptions.map((a) => a.text)).toContain(
      'The gunicorn version is taken from "requirements.txt".',
    );
  });

  it('WARN when it does not, saying how long a request may still run', () => {
    const r = app(['          command: ["gunicorn", "app:app"]', sleep10].join('\n'));
    const f = ruleOf(r, 'T3');
    expect(f.kind).toBe('WARN');
    expect(f.headline).toBe(
      'worst case: grace 30 s is less than preStop 10 s + drain 0 s + graceful timeout 30 s + 1 s; workers are killed only if a request is still running 20 s after SIGTERM',
    );
    expect(f.declare).toEqual([
      'declare longest_request_s for this workload in tripcurve.yaml, for a pass or a fail',
    ]);
    expect(renderChain(f)[0]).toMatch(/^grace: 30 s @ default: Kubernetes/);
  });

  it('WARN when preStop alone uses the whole grace period: nothing is left for a request', () => {
    const r = app(
      [
        '          command: ["gunicorn", "app:app"]',
        '          lifecycle: {preStop: {exec: {command: ["sleep", "30"]}}}',
      ].join('\n'),
    );
    const f = ruleOf(r, 'T3');
    expect(f.kind).toBe('WARN');
    expect(f.headline).toContain('the grace period ends before the server can stop');
    expect(f.headline).not.toContain('still running');
  });

  it.each([
    ['gthread', '["gunicorn", "app:app", "--threads", "2"]', 'gunicorn==26.2.0\n'],
    ['the sync worker on 27.x', '["gunicorn", "app:app"]', 'gunicorn==27.0.0\n'],
    [
      'the uvicorn worker',
      '["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"]',
      'gunicorn==26.2.0\nuvicorn==0.54.0\n',
    ],
  ])('%s: the measured 30 s', (_name, command, pins) => {
    const r = app([`          command: ${command}`, sleep10, grace(45)].join('\n'), pins);
    expect(lineOf(ruleOf(r, 'T3'))).toBe('PASS grace 45 s covers 10 s + 0 s + 30 s + 1 s');
  });

  it('an explicit --graceful-timeout 10 on the sync worker is the measured 10 s, cited from the file', () => {
    const r = app(
      [
        '          command: ["gunicorn", "app:app", "--graceful-timeout", "10"]',
        sleep10,
        grace(30),
      ].join('\n'),
    );
    const f = ruleOf(r, 'T3');
    expect(lineOf(f)).toBe('PASS grace 30 s covers 10 s + 0 s + 10 s + 1 s');
    expect(renderChain(f).slice(2)).toEqual([
      'graceful: 10 s @ "k8s/app.yaml":20',
      'ceiling: 10 s @ explicit graceful timeout (gunicorn 26.x; measured at 10 s on 26.2.0)',
    ]);
  });

  it.each([
    [
      'another value (only 10 was measured)',
      '["gunicorn", "app:app", "--graceful-timeout", "20"]',
      'gunicorn==26.2.0\n',
      'the explicit graceful timeout is not the value that was measured (10 s)',
    ],
    [
      'the gevent worker',
      '["gunicorn", "app:app", "-k", "gevent"]',
      'gunicorn==26.2.0\n',
      'no measured graceful timeout for the gevent worker',
    ],
    [
      'a release no entry covers (28.x)',
      '["gunicorn", "app:app"]',
      'gunicorn==28.0.0\n',
      'no measured graceful timeout for gunicorn 28.0.0 with the sync worker',
    ],
    [
      'a release before the measured one (26.1)',
      '["gunicorn", "app:app"]',
      'gunicorn==26.1.0\n',
      'no measured graceful timeout for gunicorn 26.1.0 with the sync worker',
    ],
    [
      'no gunicorn version in the files',
      '["gunicorn", "app:app"]',
      'flask==3.0.0\n',
      'no gunicorn version in the files',
    ],
  ])('%s: UNRESOLVED', (_name, command, pins, reason) => {
    const r = app([`          command: ${command}`, sleep10, grace(45)].join('\n'), pins);
    const f = ruleOf(r, 'T3');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(reason);
    expect(f.declare).toContain(DECLARE_L);
  });

  it('the uvicorn worker needs a uvicorn release too: UNRESOLVED without one', () => {
    const r = app(
      [
        `          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"]`,
        sleep10,
        grace(45),
      ].join('\n'),
      'gunicorn==26.2.0\n',
    );
    const f = ruleOf(r, 'T3');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('uvicorn version not in the files; declare runtime.uvicorn');
  });

  it('a graceful timeout that is not a literal is not read: UNRESOLVED', () => {
    const r = app(
      [
        '          command: ["gunicorn", "app:app", "--graceful-timeout", "$(T)"]',
        sleep10,
        grace(45),
      ].join('\n'),
    );
    expect(ruleOf(r, 'T3').kind).toBe('UNRESOLVED');
  });
});

describe('uvicorn alone has no ceiling by default', () => {
  const app = (command: string, pins = 'uvicorn==0.54.0\n', extra = '') =>
    pythonApp(
      [
        `          command: ${command}`,
        extra,
        '          lifecycle: {preStop: {exec: {command: ["sleep", "10"]}}}',
        grace(45),
      ]
        .filter((l) => l !== '')
        .join('\n'),
      { 'requirements.txt': pins },
    );

  it('no flag: UNRESOLVED, with what to declare (measured: a request in flight is waited for however long)', () => {
    const f = ruleOf(app('["uvicorn", "app:app"]'), 'T3');
    expect(lineOf(f)).toBe(
      'UNRESOLVED no graceful-timeout ceiling is known for uvicorn without --timeout-graceful-shutdown',
    );
    expect(f.declare).toEqual([DECLARE_L]);
  });

  it('--timeout-graceful-shutdown 5 is the measured ceiling of 5 s', () => {
    const f = ruleOf(app('["uvicorn", "app:app", "--timeout-graceful-shutdown", "5"]'), 'T3');
    expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 0 s + 5 s + 1 s');
    expect(renderChain(f).slice(2)).toEqual([
      'graceful: 5 s @ "k8s/app.yaml":20',
      'ceiling: 5 s @ explicit graceful shutdown timeout, uvicorn (uvicorn 0.54.x; measured at 5 s on 0.54.0)',
    ]);
  });

  it('the = form is the same flag', () => {
    expect(ruleOf(app('["uvicorn", "app:app", "--timeout-graceful-shutdown=5"]'), 'T3').kind).toBe(
      'PASS',
    );
  });

  it.each([
    [
      'another value (only 5 was measured)',
      '["uvicorn", "app:app", "--timeout-graceful-shutdown", "6"]',
      '',
      'the explicit graceful timeout is not the value that was measured (5 s)',
    ],
    [
      'the environment form (not measured)',
      '["uvicorn", "app:app"]',
      '          env:\n            - name: UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN\n              value: "5"',
      'the graceful shutdown timeout is not read: UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN is set in the environment, a form that was not measured',
    ],
    [
      'an envFrom that could set it',
      '["uvicorn", "app:app", "--timeout-graceful-shutdown", "5"]',
      '          envFrom:\n            - configMapRef: {name: c}',
      'the graceful shutdown timeout is not read: envFrom may set UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN from a source that is not read',
    ],
    [
      'an abbreviated flag',
      '["uvicorn", "app:app", "--timeout-grace", "5"]',
      '',
      'the graceful shutdown timeout is not read: the flag is written in a form that is not read',
    ],
    [
      'an env file',
      '["uvicorn", "app:app", "--env-file", ".env", "--timeout-graceful-shutdown", "5"]',
      '',
      'the graceful shutdown timeout is not read: an env file is named and is not read',
    ],
    [
      'a variable',
      '["uvicorn", "app:app", "--timeout-graceful-shutdown", "$(T)"]',
      '',
      'the graceful shutdown timeout is not read: a $(...) reference in the command is expanded by Kubernetes',
    ],
  ])('%s: UNRESOLVED', (_name, command, extra, headline) => {
    const f = ruleOf(app(command, 'uvicorn==0.54.0\n', extra), 'T3');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(headline);
  });

  it('a release no entry covers: UNRESOLVED', () => {
    const f = ruleOf(
      app('["uvicorn", "app:app", "--timeout-graceful-shutdown", "5"]', 'uvicorn==0.60.0\n'),
      'T3',
    );
    expect(f.kind).toBe('UNRESOLVED');
  });
});

describe('the terms that must be established (never PASS, never FAIL)', () => {
  const web = (
    files: Record<string, string> = {},
    lifecycle = sleepLifecycle(10),
    pod = grace(45),
  ) => ({
    'k8s/web.yaml': webManifest({ lifecycle, pod }),
    'tripcurve.yaml': longest(5),
    ...files,
  });

  it('a preStop hook: UNRESOLVED, because its time is part of the sum', () => {
    const hook = [
      '          lifecycle:',
      '            preStop:',
      '              httpGet:',
      '                path: /drain',
      '                port: 8080',
    ].join('\n');
    const f = T3(web({}, hook));
    expect(lineOf(f)).toBe('UNRESOLVED preStop hook of unknown duration; grace cannot be checked');
  });

  it('a terminus beforeShutdown of unresolved duration: UNRESOLVED T3 too, with what to declare', () => {
    const src = `${SERVER_HEAD}import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => sleep(5000) });\n`;
    const r = run(web({ 'src/server.ts': src }));
    expect(lineOf(ruleOf(r, 'T2'))).toBe(
      'UNRESOLVED drain of unknown duration in terminus beforeShutdown',
    );
    const f = ruleOf(r, 'T3');
    expect(lineOf(f)).toBe('UNRESOLVED drain duration unknown; grace cannot be checked');
    expect(renderChain(f)[0]).toBe('grace: 45 s @ "k8s/web.yaml":26');
    expect(f.declare).toEqual(['declare drain.in_process_s for this workload in tripcurve.yaml']);
  });

  it('a declared drain settles it, and is part of the sum', () => {
    const src = `${SERVER_HEAD}import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => sleep(5000) });\n`;
    const files = web({
      'src/server.ts': src,
      'tripcurve.yaml': [
        'version: 1',
        'workloads:',
        '  - name: web',
        '    namespace: shop',
        '    longest_request_s: 5',
        '    drain:',
        '      in_process_s: 20',
        '',
      ].join('\n'),
    });
    expect(lineOf(T3(files))).toBe('PASS grace 45 s covers 10 s + 20 s + 5 s + 1 s');
    expect(
      lineOf(
        T3({
          ...files,
          'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10), pod: grace(35) }),
        }),
      ),
    ).toBe('FAIL grace 35 s is less than 10 s + 20 s + 5 s + 1 s');
  });

  it('a read in-process drain is part of the sum: a literal terminus delay', () => {
    const src = `${SERVER_HEAD}import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 8000)) });\n`;
    const f = T3(web({ 'src/server.ts': src }));
    expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 8 s + 5 s + 1 s');
    expect(renderChain(f)[2]).toBe('drain: 8 s @ "src/server.ts":5');
  });

  it('a lightship default drain of 5 s, with its release and Kubernetes assumptions', () => {
    const src = `${SERVER_HEAD}import { createLightship } from 'lightship';\nawait createLightship();\n`;
    const { result } = analyseFiles(
      web({ 'src/server.ts': src, 'package.json': '{"dependencies":{"lightship":"9.1.0"}}' }),
    );
    const f = ruleOf(result, 'T3');
    expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 5 s + 5 s + 1 s');
    expect(f.assumptions?.map((a) => a.text)).toEqual([
      'The lightship version is taken from "package.json".',
      'lightship detects Kubernetes at run time; assumed true because the workload is a Kubernetes manifest.',
    ]);
  });

  describe('a declared drain and a drain the code shows: the larger counts, a declaration cannot lower it', () => {
    const src = `${SERVER_HEAD}import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 8000)) });\n`;
    const decl = (seconds: number): string =>
      [
        'version: 1',
        'workloads:',
        '  - name: web',
        '    namespace: shop',
        '    longest_request_s: 5',
        '    drain:',
        `      in_process_s: ${seconds}`,
        '',
      ].join('\n');

    it('a smaller declaration (1 s) does not lower the 8 s the code shows', () => {
      const f = T3(web({ 'src/server.ts': src, 'tripcurve.yaml': decl(1) }));
      expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 8 s + 5 s + 1 s');
      expect(renderChain(f).filter((l) => l.startsWith('drain'))).toEqual([
        'drain: 1 s @ "tripcurve.yaml":7',
        'drain: 8 s @ "src/server.ts":5',
      ]);
    });

    it('a declaration of 0 does not hide it either: T2 passes on the code, and T3 adds 8 s', () => {
      const r = run(web({ 'src/server.ts': src, 'tripcurve.yaml': decl(0) }, ''));
      expect(lineOf(ruleOf(r, 'T2'))).toBe('PASS in-process drain 8 s (terminus beforeShutdown)');
      expect(lineOf(ruleOf(r, 'T3'))).toBe('PASS grace 45 s covers 0 s + 8 s + 5 s + 1 s');
    });

    it('a larger declaration (20 s) counts: the user knows more than the files show', () => {
      const f = T3(web({ 'src/server.ts': src, 'tripcurve.yaml': decl(20) }));
      expect(lineOf(f)).toBe('PASS grace 45 s covers 10 s + 20 s + 5 s + 1 s');
    });
  });

  it('a Node search that is not complete: the drain term is not known, so UNRESOLVED', () => {
    const f = T3(web({ 'src/server.ts': `${SERVER_HEAD}require(process.env.PLUGIN);\n` }));
    expect(lineOf(f)).toBe('UNRESOLVED drain not established; grace cannot be checked');
  });

  it('a Node source that is not linked, with a preStop: T2 passes, T3 cannot add the drain', () => {
    const files = web({}, sleepLifecycle(10));
    files['k8s/web.yaml'] = webManifest({
      command: '["node"]',
      lifecycle: sleepLifecycle(10),
      pod: grace(45),
    });
    const r = run(files);
    expect(ruleOf(r, 'T2').kind).toBe('PASS');
    expect(lineOf(ruleOf(r, 'T3'))).toBe(
      'UNRESOLVED drain not known: source not linked; link it or declare a drain',
    );
  });

  it.each([
    ['a string', '"45"'],
    ['a negative number', '-5'],
    ['a fraction', '4.5'],
  ])('a grace period that is %s: UNRESOLVED, never the default', (_name, value) => {
    const f = T3(
      web({ 'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10), pod: grace(value) }) }),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/^grace period not established: /);
  });

  it('the knowledge base has no grace default: UNRESOLVED (a custom base without the entry)', async () => {
    const { loadKnowledgeBase } = await import('../../src/kb/index.js');
    const { result } = analyseFiles(
      {
        'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10) }),
        'tripcurve.yaml': longest(5),
      },
      { kb: loadKnowledgeBase([{ schemaVersion: 1, entries: [] }]) },
    );
    expect(lineOf(ruleOf(result, 'T3'))).toBe(
      'UNRESOLVED grace period not established: no knowledge-base default for the grace period',
    );
  });
});
