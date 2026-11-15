// Regression tests for the B4 adversarial review (each written first and seen red): a drain found while
// the search is incomplete, an unread Python drain counted as 0 s without saying so, shutdown
// libraries and side-effect imports, guards that no test killed, and the minor findings.
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText, makeSourcedValue } from '../../src/core/index.js';
import { valueMs } from '../../src/evaluate/shutdown-common.js';
import albKb from '../../src/kb/data/alb.json' with { type: 'json' };
import shutdownKb from '../../src/kb/data/shutdown.json' with { type: 'json' };
import { loadKnowledgeBase } from '../../src/kb/index.js';
import {
  analyseFiles,
  cleanupTrees,
  DEMO_FILES,
  lineOf,
  renderChain,
  ruleOf,
  sleepLifecycle,
  webManifest,
} from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { pythonApp } from '../support/python.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  cleanupTrees();
  for (const t of trees.splice(0)) t.cleanup();
});

const HEAD = [
  "import http from 'node:http';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
  '',
].join('\n');
const TERMINUS_8S = `import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 8000)) });\n`;
const GRACE = '      terminationGracePeriodSeconds: 45';
const LONGEST = [
  'version: 1',
  'workloads:',
  '  - name: web',
  '    namespace: shop',
  '    longest_request_s: 5',
  '',
].join('\n');
const run = (files: Record<string, string | null>) => analyseFiles(files).result;
const web = (extra: Record<string, string | null> = {}, lifecycle = '') => ({
  'k8s/web.yaml': webManifest({ lifecycle, pod: GRACE }),
  'tripcurve.yaml': LONGEST,
  ...extra,
});
const INCOMPLETE = 'const name = process.env.PLUGIN;\nrequire(name);\n';

describe('a drain found while the search is incomplete is not established', () => {
  it('case A: a terminus delay and an unread dynamic require, no preStop: T2 and T3 are UNRESOLVED', () => {
    const r = run(web({ 'src/server.ts': `${HEAD}${TERMINUS_8S}${INCOMPLETE}` }));
    expect(lineOf(ruleOf(r, 'T2'))).toBe('UNRESOLVED the search for a drain is not complete');
    expect(ruleOf(r, 'T3').kind).toBe('UNRESOLVED');
  });

  it('case B: T1 is UNRESOLVED (incomplete) and T2 must not PASS on the same source', () => {
    const r = run(web({ 'src/server.ts': `${HEAD}${TERMINUS_8S}${INCOMPLETE}` }));
    expect(ruleOf(r, 'T1').kind).toBe('UNRESOLVED');
    expect(ruleOf(r, 'T2').kind).not.toBe('PASS');
  });

  it('a preStop delay alone still gives T2 PASS, but T3 cannot add the drain: UNRESOLVED', () => {
    const r = run(
      web({ 'src/server.ts': `${HEAD}${TERMINUS_8S}${INCOMPLETE}` }, sleepLifecycle(10)),
    );
    expect(ruleOf(r, 'T2').kind).toBe('PASS');
    expect(lineOf(ruleOf(r, 'T3'))).toBe(
      'UNRESOLVED drain not established; grace cannot be checked',
    );
  });

  it('a declared drain settles both (the user states the drain)', () => {
    const decl = [
      'version: 1',
      'workloads:',
      '  - name: web',
      '    namespace: shop',
      '    longest_request_s: 5',
      '    drain:',
      '      in_process_s: 8',
      '',
    ].join('\n');
    const r = run(
      web(
        { 'src/server.ts': `${HEAD}${TERMINUS_8S}${INCOMPLETE}`, 'tripcurve.yaml': decl },
        sleepLifecycle(10),
      ),
    );
    expect(ruleOf(r, 'T2').kind).toBe('PASS');
    expect(lineOf(ruleOf(r, 'T3'))).toBe('PASS grace 45 s covers 10 s + 8 s + 5 s + 1 s');
  });
});

describe('an unread Python drain counted as 0 s is an assumption, listed', () => {
  const sleep10 = '          lifecycle: {preStop: {exec: {command: ["sleep", "10"]}}}';
  const LINE = 'In-process drains of Python servers are not read; counted as 0 s.';

  it('a T3 PASS on gunicorn lists it', () => {
    const r = pythonApp(['          command: ["gunicorn", "app:app"]', sleep10, GRACE].join('\n'), {
      'requirements.txt': 'gunicorn==26.2.0\n',
    });
    expect(ruleOf(r, 'T3').kind).toBe('PASS');
    expect(r.assumptions.map((a) => a.text)).toContain(LINE);
  });

  it('a T3 WARN and a T3 FAIL list it too, and a declared drain does not need it', () => {
    const warn = pythonApp(['          command: ["gunicorn", "app:app"]', sleep10].join('\n'), {
      'requirements.txt': 'gunicorn==26.2.0\n',
    });
    expect(ruleOf(warn, 'T3').kind).toBe('WARN');
    expect(warn.assumptions.map((a) => a.text)).toContain(LINE);
    const decl = [
      'version: 1',
      'workloads:',
      '  - name: app',
      '    namespace: shop',
      '    drain:',
      '      in_process_s: 2',
      '',
    ].join('\n');
    const declared = pythonApp(
      ['          command: ["gunicorn", "app:app"]', sleep10, GRACE].join('\n'),
      { 'requirements.txt': 'gunicorn==26.2.0\n', 'tripcurve.yaml': decl },
    );
    expect(ruleOf(declared, 'T3').kind).toBe('PASS');
    expect(declared.assumptions.map((a) => a.text)).not.toContain(LINE);
  });

  it('a Node workload does not need it (its source was read)', () => {
    const r = run(web({}, sleepLifecycle(10)));
    expect(ruleOf(r, 'T3').kind).toBe('PASS');
    expect(r.assumptions.map((a) => a.text)).not.toContain(LINE);
  });

  it('a T3 that was not evaluated or is UNRESOLVED did not use it', () => {
    const none = pythonApp('          command: ["gunicorn", "app:app"]', {
      'requirements.txt': 'gunicorn==26.2.0\n',
    });
    expect(ruleOf(none, 'T3').kind).toBe('NOT EVALUATED');
    expect(none.assumptions.map((a) => a.text)).not.toContain(LINE);
  });
});

describe('a shutdown library, or an import for side effects, makes the drain search incomplete', () => {
  const REASON = 'a shutdown library is imported whose drain tripcurve does not read';
  const t2 = (src: string) => ruleOf(run(web({ 'src/server.ts': `${HEAD}${src}` })), 'T2');

  it.each([
    'close-with-grace',
    'http-terminator',
    'stoppable',
    'http-graceful-shutdown',
    'fastify-graceful-shutdown',
    'graceful-shutdown',
    'node-graceful-shutdown',
    'death',
    'signal-exit',
    'exit-hook',
    'async-exit-hook',
  ])(
    '%s: a static import, a require, a dynamic import and a subpath are all UNRESOLVED, never FAIL',
    (lib) => {
      for (const src of [
        `import x from '${lib}';\nx(server);\n`,
        `const x = require('${lib}');\n`,
        `await import('${lib}');\n`,
        `import { y } from '${lib}/dist/index.js';\n`,
      ]) {
        const f = t2(src);
        expect(f.kind, src).toBe('UNRESOLVED');
        expect(f.headline).toBe('the search for a drain is not complete');
        expect(renderChain(f).at(-1)).toBe(`drain: ? ${REASON}`);
      }
    },
  );

  it('an import for its side effects only (a non-local package) is the same, in both forms', () => {
    for (const src of ["import 'some-pkg/register';\n", "require('some-pkg');\n"]) {
      const f = t2(src);
      expect(f.kind, src).toBe('UNRESOLVED');
      expect(renderChain(f).at(-1)).toBe(
        'drain: ? a package is imported only for its side effects, which may include signal handlers',
      );
    }
  });

  it('a local side-effect import is read, and a built-in one is harmless: FAIL as before', () => {
    expect(t2("import 'node:fs';\n").kind).toBe('FAIL');
    const r = run(
      web({ 'src/server.ts': `${HEAD}import './init.js';\n`, 'src/init.js': 'export {};\n' }),
    );
    expect(ruleOf(r, 'T2').kind).toBe('FAIL');
  });

  it('an ordinary named import of another package is a gap too since the second review (N1: any package runs code)', () => {
    expect(t2("import { z } from 'zod';\n").kind).toBe('UNRESOLVED');
  });

  it('T1 is not affected (the drain search is a separate question): the default still applies', () => {
    const r = run(
      web({
        'src/server.ts': `${HEAD}import 'dotenv/config';\nimport x from 'close-with-grace';\n`,
      }),
    );
    expect(ruleOf(r, 'T1').kind).toBe('FAIL');
  });

  it('with a preStop delay T2 is PASS, with a declared drain too', () => {
    const r = run(
      web({ 'src/server.ts': `${HEAD}import 'close-with-grace';\n` }, sleepLifecycle(10)),
    );
    expect(ruleOf(r, 'T2').kind).toBe('PASS');
  });
});

describe('every guard of the drain search is killed by an end-to-end test', () => {
  const big = `${'// '.padEnd(80, 'x')}\n`.repeat(Math.ceil(5_000_001 / 81) + 1);
  const cases: [string, Record<string, string>, string][] = [
    ['eval in a file read (settings.gaps)', { 'src/server.ts': `${HEAD}eval('1');\n` }, ''],
    [
      'an import that names no file (settings.unreadImports)',
      { 'src/server.ts': `${HEAD}import './missing.js';\n` },
      '',
    ],
    [
      'an imported file with a syntax error (settings.unchecked)',
      { 'src/server.ts': `${HEAD}import './bad.js';\n`, 'src/bad.js': 'const = = ;\n' },
      '',
    ],
    [
      'an imported file over the size limit (settings.unchecked or unread)',
      { 'src/server.ts': `${HEAD}import './huge.js';\n`, 'src/huge.js': big },
      '',
    ],
    [
      'a dynamic import with a computed name (settings.gaps)',
      { 'src/server.ts': `${HEAD}await import(process.env.X);\n` },
      '',
    ],
  ];
  it.each(cases)('%s: T2 and T3 are UNRESOLVED, not FAIL, not PASS', (_name, files) => {
    const r = run(web(files));
    expect(ruleOf(r, 'T2').kind).toBe('UNRESOLVED');
    expect(ruleOf(r, 'T3').kind).toBe('UNRESOLVED');
  });

  it('the propagation assumption is listed for each PASS path of T2 (preStop, declared drain, in-process drain)', () => {
    const PROP =
      "Endpoint removal needs time to propagate; AWS's EKS guide suggests a preStop of 10 s. tripcurve checks a delay exists, not that it is enough.";
    const decl = [
      'version: 1',
      'workloads:',
      '  - name: web',
      '    namespace: shop',
      '    drain:',
      '      in_process_s: 3',
      '',
    ].join('\n');
    const paths = [
      web({}, sleepLifecycle(10)),
      web({ 'tripcurve.yaml': decl }),
      web({ 'src/server.ts': `${HEAD}${TERMINUS_8S}` }),
    ];
    for (const files of paths) {
      const r = run(files);
      expect(ruleOf(r, 'T2').kind).toBe('PASS');
      expect(r.assumptions.map((a) => a.text)).toContain(PROP);
    }
  });

  it('T2: when a drain is declared and another is read, the larger decides the headline', () => {
    const decl = (n: number) =>
      [
        'version: 1',
        'workloads:',
        '  - name: web',
        '    namespace: shop',
        '    drain:',
        `      in_process_s: ${n}`,
        '',
      ].join('\n');
    const src = `${HEAD}${TERMINUS_8S}`;
    expect(
      lineOf(ruleOf(run(web({ 'src/server.ts': src, 'tripcurve.yaml': decl(2) })), 'T2')),
    ).toBe('PASS in-process drain 8 s (terminus beforeShutdown)');
    expect(
      lineOf(ruleOf(run(web({ 'src/server.ts': src, 'tripcurve.yaml': decl(20) })), 'T2')),
    ).toBe('PASS declared drain 20 s');
  });

  it('lightship: a default that is `to be measured` is never a drain (the supportsPass guard)', () => {
    const entries = (shutdownKb.entries as Record<string, unknown>[]).map((e) => {
      if (e.id !== 'lightship-shutdown-delay-9x') return e;
      const { measuredOn: _a, measuredVersions: _b, ...rest } = e as Record<string, unknown>;
      return { ...rest, basis: 'to-be-measured' };
    });
    const kb = loadKnowledgeBase([albKb, { schemaVersion: 1, entries }]);
    const src = `${HEAD}import { createLightship } from 'lightship';\nawait createLightship();\n`;
    const { result } = analyseFiles(
      web({ 'src/server.ts': src, 'package.json': '{"dependencies":{"lightship":"9.1.0"}}' }),
      { kb },
    );
    const f = ruleOf(result, 'T2');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.chain.at(-1)).toMatchObject({
      label: 'reason',
      value: { note: 'the lightship shutdownDelay default is not measured yet' },
    });
  });

  it('valueMs: a negative, fractional-millisecond or non-number value is not a count (unreachable from files; guarded for models)', () => {
    const at = fileSource(inputText('x.yaml'), 1);
    const v = (value: number | string, unit: 's' | 'ms') =>
      makeSourcedValue({ value, unit, source: at, basis: 'declared' });
    expect(valueMs(v(-1, 's'))).toBeUndefined();
    expect(valueMs(v(-5, 'ms'))).toBeUndefined();
    expect(valueMs(v(1.5, 'ms'))).toBeUndefined();
    expect(valueMs(v('x', 's'))).toBeUndefined();
    expect(valueMs(v(5, 'ms'))).toBe(5);
  });
});

describe('minor 1: a drain that was found and is 0 s is not "none read for Node only"', () => {
  it('the FAIL says a drain of 0 s was found, at its place', () => {
    const r = run(
      web({ 'src/server.ts': `${HEAD}process.on('SIGTERM', () => server.close());\n` }),
    );
    const f = ruleOf(r, 'T2');
    expect(f.kind).toBe('FAIL');
    const text = JSON.stringify(f.chain);
    expect(text).toContain('a drain of 0 s was found at');
    expect(text).not.toContain('read for Node source only');
    expect(text).not.toContain('no lightship, terminus or SIGTERM drain found');
  });
});

describe('minor 2: sub-millisecond precision rounds the required sum UP', () => {
  const files = (l: number) => ({
    'k8s/web.yaml': webManifest({
      lifecycle: sleepLifecycle(10),
      pod: '      terminationGracePeriodSeconds: 26',
    }),
    'tripcurve.yaml': [
      'version: 1',
      'workloads:',
      '  - name: web',
      '    namespace: shop',
      `    longest_request_s: ${l}`,
      '',
    ].join('\n'),
  });
  it('15.0004 s needs 26.0004 s: 26 s is not enough (it was PASS)', () => {
    expect(ruleOf(run(files(15.0004)), 'T3').kind).toBe('FAIL');
  });
  it('15 s needs exactly 26 s: PASS', () => {
    expect(ruleOf(run(files(15)), 'T3').kind).toBe('PASS');
  });
});

describe('minor 5: a top-level process.exit or throw before listen makes what follows a dead path', () => {
  const DEAD = [
    ['process.exit(1)', 'process.exit(1);\n'],
    ['throw', "throw new Error('stop');\n"],
  ] as const;
  it.each(DEAD)('%s: a terminus drain after it is not established', (_n, stmt) => {
    const src = `import http from 'node:http';\nimport { createTerminus } from '@godaddy/terminus';\nconst server = http.createServer((_q, r) => { r.end('ok'); });\n${stmt}server.listen(8080);\n${TERMINUS_8S.split('\n')[1]}\n`;
    const f = ruleOf(run(web({ 'src/server.ts': src })), 'T2');
    expect(f.kind).toBe('UNRESOLVED');
  });

  it.each(DEAD)('%s: a T1 setting written after it is not shown to run', (_n, stmt) => {
    const src = `import http from 'node:http';\nconst server = http.createServer((_q, r) => { r.end('ok'); });\n${stmt}server.keepAliveTimeout = 65000;\nserver.listen(8080);\n`;
    expect(ruleOf(run({ 'src/server.ts': src }), 'T1').kind).toBe('UNRESOLVED');
  });

  it('process.exit after listen is not a dead path before it', () => {
    const src = `import http from 'node:http';\nconst server = http.createServer((_q, r) => { r.end('ok'); });\nserver.keepAliveTimeout = 65000;\nserver.listen(8080);\nprocess.exit(0);\n`;
    expect(ruleOf(run({ 'src/server.ts': src }), 'T1').kind).toBe('PASS');
  });
});

describe('minor 6: configuration errors', () => {
  const cfg = (lines: string[]) => ['version: 1', 'workloads:', ...lines, ''].join('\n');
  it('a declaration for an unknown workload quotes its name and its line', () => {
    const t = makeTree();
    trees.push(t);
    for (const [p, x] of Object.entries(DEMO_FILES)) t.write(p, x);
    t.write('tripcurve.yaml', cfg(['  - name: ghost', '    longest_request_s: 5']));
    const out = runBuilt(['.'], { cwd: t.root });
    expect(out.status).toBe(2);
    expect(out.stdout.replace(/\s+/g, ' ')).toContain(
      'Config error in "tripcurve.yaml" at line 4: no workload named "ghost" for "longest_request_s".',
    );
  });

  it('two entries naming one workload are an error, not a silent merge', () => {
    const t = makeTree();
    trees.push(t);
    for (const [p, x] of Object.entries(DEMO_FILES)) t.write(p, x);
    t.write(
      'tripcurve.yaml',
      cfg([
        '  - name: web',
        '    namespace: shop',
        '    longest_request_s: 5',
        '  - name: web',
        '    namespace: shop',
        '    drain:',
        '      in_process_s: 8',
      ]),
    );
    const out = runBuilt(['.'], { cwd: t.root });
    expect(out.status).toBe(2);
    expect(out.stdout.replace(/\s+/g, ' ')).toContain(
      'Config error in "tripcurve.yaml" at line 6: two entries name the same workload "web".',
    );
    expect(out.stdout).toContain('Nothing was checked.');
  });
});

describe('minor 7: the explicit graceful timeout in the forms and classes that were measured', () => {
  const sleep10 = '          lifecycle: {preStop: {exec: {command: ["sleep", "10"]}}}';
  const PIN = { 'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n' };
  const app = (lines: string[], extra: Record<string, string | null> = {}) =>
    pythonApp([...lines, sleep10, GRACE].join('\n'), { ...PIN, ...extra });
  const T3 = (r: ReturnType<typeof app>) => ruleOf(r, 'T3');
  const OK = 'PASS grace 45 s covers 10 s + 0 s + 10 s + 1 s';
  const env = (v: string) => [
    '          env:',
    '            - name: GUNICORN_CMD_ARGS',
    `              value: "${v}"`,
  ];

  it.each([
    ['sync, flag', ['          command: ["gunicorn", "app:app", "--graceful-timeout", "10"]']],
    [
      'sync, flag, any worker count',
      ['          command: ["gunicorn", "app:app", "-w", "2", "--graceful-timeout", "10"]'],
    ],
    [
      'gthread, flag',
      ['          command: ["gunicorn", "app:app", "--threads", "2", "--graceful-timeout", "10"]'],
    ],
    [
      'the uvicorn worker, flag',
      [
        '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker", "--graceful-timeout", "10"]',
      ],
    ],
    [
      'sync, GUNICORN_CMD_ARGS',
      ['          command: ["gunicorn", "app:app"]', ...env('--graceful-timeout 10')],
    ],
    [
      'sync, the same value in the flag and in GUNICORN_CMD_ARGS',
      [
        '          command: ["gunicorn", "app:app", "--graceful-timeout", "10"]',
        ...env('--graceful-timeout 10'),
      ],
    ],
  ])('%s: the measured 10 s', (_n, lines) => {
    expect(lineOf(T3(app(lines)))).toBe(OK);
  });

  it('sync, a -c file with graceful_timeout = 10: the measured 10 s', () => {
    const r = app(['          command: ["gunicorn", "app:app", "-c", "gunicorn.conf.py"]'], {
      'gunicorn.conf.py': 'graceful_timeout = 10\n',
    });
    expect(lineOf(T3(r))).toBe(OK);
  });

  it('the default is 30 s with any worker count (-w 2 was run)', () => {
    const r = app(['          command: ["gunicorn", "app:app", "-w", "2"]']);
    expect(lineOf(T3(r))).toBe('PASS grace 45 s covers 10 s + 0 s + 30 s + 1 s');
  });

  it.each([
    [
      'gthread, GUNICORN_CMD_ARGS (only sync was measured there)',
      [
        '          command: ["gunicorn", "app:app", "--threads", "2"]',
        ...env('--graceful-timeout 10'),
      ],
      'an explicit graceful timeout from GUNICORN_CMD_ARGS was not measured for the gthread worker',
    ],
    [
      'the uvicorn worker, GUNICORN_CMD_ARGS',
      [
        '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"]',
        ...env('--graceful-timeout 10'),
      ],
      'an explicit graceful timeout from GUNICORN_CMD_ARGS was not measured for the uvicorn worker',
    ],
    [
      'two sources that disagree (precedence was measured for keepalive only)',
      [
        '          command: ["gunicorn", "app:app", "--graceful-timeout", "10"]',
        ...env('--graceful-timeout 20'),
      ],
      'gunicorn setting precedence not yet measured for this setting',
    ],
    [
      'another value from GUNICORN_CMD_ARGS',
      ['          command: ["gunicorn", "app:app"]', ...env('--graceful-timeout 20')],
      'the explicit graceful timeout is not the value that was measured (10 s)',
    ],
  ])('%s: UNRESOLVED', (_n, lines, headline) => {
    const f = T3(app(lines));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(headline);
  });

  it('gthread with a -c file is UNRESOLVED (the file was measured for sync only)', () => {
    const r = app(
      ['          command: ["gunicorn", "app:app", "--threads", "2", "-c", "gunicorn.conf.py"]'],
      { 'gunicorn.conf.py': 'graceful_timeout = 10\n' },
    );
    const f = T3(r);
    expect(f.headline).toBe(
      'an explicit graceful timeout from a config file was not measured for the gthread worker',
    );
  });
});
