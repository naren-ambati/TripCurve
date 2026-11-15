// Regressions for the B2 adversarial review. Each test failed
// before its fix; the review's own fixtures are under test/fixtures/python/review/.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees, t1Of } from '../support/analyse.js';
import { cleanupPythonTrees, pythonApp, reviewFiles, t1Summary } from '../support/python.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const CODING =
  'idle close not established: gunicorn.conf.py declares a source encoding that tripcurve does not read';
const LINKED = '          command: ["gunicorn", "app:app", "-c", "gunicorn.conf.py"]';
const LINK_YAML =
  'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    gunicorn_config: gunicorn.conf.py\n';

describe('a coding cookie that changes how the file decodes', () => {
  it.each(['coding-unicode-escape', 'coding-utf7', 'coding-utf7-shebang'])(
    'reviewer fixture %s, named by -c: UNRESOLVED, not N/A',
    (name) => {
      const t = t1Summary(pythonApp(LINKED, reviewFiles(name)));
      expect(t.kind, name).toBe('UNRESOLVED');
      expect(t.headline, name).toBe(CODING);
    },
  );

  it.each(['coding-unicode-escape', 'coding-utf7', 'coding-utf7-shebang'])(
    'reviewer fixture %s, linked in tripcurve.yaml: UNRESOLVED',
    (name) => {
      const t = t1Summary(
        pythonApp('          command: ["gunicorn", "app:app"]', {
          ...reviewFiles(name),
          'tripcurve.yaml': LINK_YAML,
        }),
      );
      expect(t.headline, name).toBe(CODING);
    },
  );

  it('the default gunicorn.conf.py (no -c, no link) stays UNRESOLVED as before', () => {
    const t = t1Summary(
      pythonApp('          command: ["gunicorn", "app:app"]', reviewFiles('coding-utf7')),
    );
    expect(t.kind).toBe('UNRESOLVED');
  });

  it('an ordinary utf-8 cookie does not stop a literal sync worker from being N/A', () => {
    const t = t1Summary(
      pythonApp(LINKED, { 'gunicorn.conf.py': '# -*- coding: utf-8 -*-\nworker_class = "sync"\n' }),
    );
    expect(t.kind).toBe('N/A');
  });
});

describe('two guards that had no test', () => {
  const UVW75 =
    '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker", "--keep-alive", "75"]';
  const NOT_MEASURED =
    'idle close not established: the effect of an explicit keepalive on the idle close is not measured yet';

  it('a declared runtime.gunicorn "26" is only partly covered (26.0 and 26.1 were not measured): an explicit keepalive is UNRESOLVED', () => {
    const t = t1Summary(
      pythonApp(UVW75, {
        'requirements.txt': 'uvicorn==0.54.0\n',
        'tripcurve.yaml':
          'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n      gunicorn: "26"\n',
      }),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(NOT_MEASURED);
  });

  it('the same keepalive with the exact release the entry starts at is a verdict', () => {
    const t = t1Summary(
      pythonApp(UVW75, {
        'requirements.txt': 'uvicorn==0.54.0\n',
        'tripcurve.yaml':
          'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n      gunicorn: "26.2.0"\n',
      }),
    );
    expect(t.kind).toBe('PASS');
  });

  it.each([
    ['a link to a file that is not a Dockerfile', 'docker/dockerfile'],
    ['a link outside the root', '../Dockerfile'],
    ['a link to a file that is not there', 'nope/Dockerfile'],
  ])('%s: the Dockerfile ENV is not read (the default sync worker applies, N/A)', (_l, target) => {
    const r = pythonApp('          command: ["gunicorn", "app:app"]', {
      Dockerfile: 'FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads 3"\n',
      'docker/dockerfile': 'FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads 3"\n',
      'tripcurve.yaml': `version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    dockerfile: ${target}\n`,
    });
    expect(t1Summary(r).kind).toBe('N/A');
  });
});

describe('m1 and m2: a gunicorn.conf.py that intake skipped keeps its real reason, and is never "no -k given"', () => {
  const BIG = `worker_class = "sync"\n${'# x\n'.repeat(1_400_000)}`;
  const SKIPPED =
    'idle close not established: the config file was skipped: larger than the 5 MB limit';
  const DEFAULT_SKIPPED =
    'idle close not established: a gunicorn.conf.py that may be loaded was skipped: larger than the 5 MB limit';
  const base = '          command: ["gunicorn", "app:app"]';

  it('-c names an over-size file: the reason says so, not "not named gunicorn.conf.py" (m1)', () => {
    const t = t1Summary(pythonApp(LINKED, { 'gunicorn.conf.py': BIG }));
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(SKIPPED);
  });

  it('a tripcurve.yaml link to an over-size file: the same (m1)', () => {
    const t = t1Summary(pythonApp(base, { 'gunicorn.conf.py': BIG, 'tripcurve.yaml': LINK_YAML }));
    expect(t.headline).toBe(SKIPPED);
  });

  it('no -c, no link, and the default gunicorn.conf.py was skipped: UNRESOLVED, not N/A (m2)', () => {
    const t = t1Summary(pythonApp(base, { 'gunicorn.conf.py': BIG }));
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(DEFAULT_SKIPPED);
  });

  it('a file that is simply not named gunicorn.conf.py still says so', () => {
    const t = t1Summary(
      pythonApp('          command: ["gunicorn", "app:app", "-c", "settings.py"]', {
        'settings.py': 'workers = 1\n',
      }),
    );
    expect(t.headline).toContain('is not named gunicorn.conf.py');
  });
});

describe('the uvicorn version, not the protocol, decides (httptools is measured: identical to h11)', () => {
  const UVW = (flags = '') =>
    `          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"${flags}]`;
  const UVW_OLD =
    '          command: ["gunicorn", "app:app", "-k", "uvicorn.workers.UvicornWorker"]';
  const UVI = (flags = '') => `          command: ["uvicorn", "app:app"${flags}]`;
  const G = 'gunicorn==26.2.0\n';
  const KA75 = ', "--keep-alive", "75"';
  const decl = (text: string) =>
    `version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n${text}`;
  const NO_UVICORN =
    'idle close not established: uvicorn version not in the files; declare runtime.uvicorn';
  const NOT_READ = 'idle close not established: HTTP protocol implementation not read';

  describe('review fixtures: extras that bring httptools in without naming it', () => {
    it.each(['fastapi-standard', 'litestar-standard'])(
      '%s with uvicorn==0.54.0 pinned: the verdicts are the measured values (default FAIL, --keep-alive 75 PASS)',
      (name) => {
        expect(t1Of(pythonApp(UVW(), reviewFiles(name))).kind, name).toBe('FAIL');
        const r = pythonApp(UVW(KA75), reviewFiles(name));
        expect(t1Of(r).kind, name).toBe('PASS');
        expect(t1Summary(r).headline).toBe('idle close 75 s is longer than LB idle 60 s');
      },
    );
  });

  it.each([
    ['uvicorn[standard] pinned', `${G}uvicorn[standard]==0.54.0\n`],
    ['uvicorn with another extra', `${G}uvicorn[speedups]==0.54.0\n`],
    ['httptools pinned beside it', `${G}uvicorn==0.54.0\nhttptools==0.9.0\nuvloop==0.23.0\n`],
  ])('%s: the same verdicts (no protocol gate)', (_l, requirements) => {
    expect(t1Of(pythonApp(UVW(), { 'requirements.txt': requirements })).kind).toBe('FAIL');
    expect(t1Of(pythonApp(UVW(KA75), { 'requirements.txt': requirements })).kind).toBe('PASS');
    expect(t1Of(pythonApp(UVW_OLD, { 'requirements.txt': requirements })).kind).toBe('FAIL');
  });

  describe('the worker needs an established, covered uvicorn version (a gunicorn pin is not enough)', () => {
    it.each([
      ['no uvicorn pin', G, NO_UVICORN],
      ['no pin file for uvicorn at all', `${G}flask==3.0.0\n`, NO_UVICORN],
      [
        'uvicorn without an exact pin',
        `${G}uvicorn>=0.30\n`,
        'idle close not established: uvicorn is not pinned to an exact version in the files',
      ],
      [
        'uvicorn under a marker',
        `${G}uvicorn==0.54.0; python_version>"3.9"\n`,
        'idle close not established: the uvicorn pin applies only under an environment marker',
      ],
      [
        'different uvicorn pins',
        `${G}uvicorn==0.54.0\nuvicorn==0.53.0\n`,
        'idle close not established: the repository pins different uvicorn versions',
      ],
      [
        'uvicorn 0.55.0 (past the measured line)',
        `${G}uvicorn==0.55.0\n`,
        'idle close not established: uvicorn 0.55.0 is not covered by a measured default',
      ],
      [
        'uvicorn 0.53.1 (before it)',
        `${G}uvicorn==0.53.1\n`,
        'idle close not established: uvicorn 0.53.1 is not covered by a measured default',
      ],
    ])('%s: UNRESOLVED, default and explicit alike', (_l, requirements, reason) => {
      for (const flags of ['', KA75]) {
        const t = t1Summary(pythonApp(UVW(flags), { 'requirements.txt': requirements }));
        expect(t.kind, flags).toBe('UNRESOLVED');
        expect(t.headline, flags).toBe(reason);
      }
    });

    it('a -r include makes the pin file unreadable: UNRESOLVED, however the file looks', () => {
      const t = t1Summary(
        pythonApp(UVW(KA75), { 'requirements.txt': `${G}uvicorn==0.54.0\n-r base.txt\n` }),
      );
      expect(t.kind).toBe('UNRESOLVED');
      expect(t.headline).toContain('is not in a form tripcurve reads');
    });

    it('a runtime.uvicorn declaration is the uvicorn version, with a gunicorn pin alone', () => {
      const files = {
        'requirements.txt': G,
        'tripcurve.yaml': decl('      uvicorn: "0.54.0"\n'),
      };
      expect(t1Of(pythonApp(UVW(), files)).kind).toBe('FAIL');
      expect(t1Of(pythonApp(UVW(KA75), files)).kind).toBe('PASS');
    });

    it('a declaration beats a pin that cannot be read, and covers a -r include', () => {
      const files = {
        'requirements.txt': `${G}uvicorn==0.54.0\n-r base.txt\n`,
        'tripcurve.yaml': decl('      gunicorn: "26.2.0"\n      uvicorn: "0.54.0"\n'),
      };
      expect(t1Of(pythonApp(UVW(KA75), files)).kind).toBe('PASS');
    });

    it('a declared uvicorn version that is partly covered ("0") or not a version is UNRESOLVED', () => {
      for (const v of ['0', 'latest']) {
        const t = t1Summary(
          pythonApp(UVW(), {
            'requirements.txt': G,
            'tripcurve.yaml': decl(`      uvicorn: "${v}"\n`),
          }),
        );
        expect(t.kind, v).toBe('UNRESOLVED');
      }
    });

    it('gthread and the sync worker do not need a uvicorn version', () => {
      expect(
        t1Of(
          pythonApp('          command: ["gunicorn", "app:app", "--threads", "2"]', {
            'requirements.txt': G,
          }),
        ).kind,
      ).toBe('FAIL');
    });
  });

  describe('uvicorn alone: the declaration and the protocol', () => {
    it('us: a declared runtime.uvicorn 0.54.0 with --timeout-keep-alive 75 is PASS (inside 7 to 300 s)', () => {
      const r = pythonApp(UVI(', "--timeout-keep-alive", "75"'), {
        'tripcurve.yaml': decl('      uvicorn: "0.54.0"\n'),
      });
      expect(t1Of(r).kind).toBe('PASS');
    });

    it.each([
      ['--http httptools', UVI(', "--http", "httptools"')],
      ['--http auto', UVI(', "--http", "auto"')],
      ['--http=auto', UVI(', "--http=auto"')],
      ['--http h11', UVI(', "--http", "h11"')],
      [
        'UVICORN_HTTP=httptools',
        `${UVI()}\n          env:\n            - name: UVICORN_HTTP\n              value: httptools`,
      ],
    ])('%s: the verdict is the measured value (7 s FAIL, 75 s PASS)', (_l, cmd) => {
      const pins = { 'requirements.txt': 'uvicorn==0.54.0\n' };
      expect(t1Of(pythonApp(cmd.replace(']', ', "--timeout-keep-alive", "7"]'), pins)).kind).toBe(
        'FAIL',
      );
      expect(t1Of(pythonApp(cmd.replace(']', ', "--timeout-keep-alive", "75"]'), pins)).kind).toBe(
        'PASS',
      );
    });

    it('uvicorn[standard] pinned and the default idle close: FAIL as for h11 (5 s)', () => {
      const t = t1Summary(pythonApp(UVI(), { 'requirements.txt': 'uvicorn[standard]==0.54.0\n' }));
      expect(t.kind).toBe('FAIL');
    });

    it.each([
      ['a custom class path', UVI(', "--http", "mypkg.proto.Impl"')],
      ['an abbreviated --htt', UVI(', "--htt", "h11"')],
      ['--http with a reference', UVI(', "--http", "$(PROTO)"')],
      ['--http=', UVI(', "--http="')],
      [
        'UVICORN_HTTP=custom',
        `${UVI()}\n          env:\n            - name: UVICORN_HTTP\n              value: mypkg.Impl`,
      ],
      [
        'UVICORN_HTTP from a reference',
        `${UVI()}\n          env:\n            - name: UVICORN_HTTP\n              valueFrom:\n                configMapKeyRef: {name: c, key: k}`,
      ],
    ])('%s: UNRESOLVED, HTTP protocol implementation not read', (_l, cmd) => {
      for (const flags of ['', ', "--timeout-keep-alive", "75"']) {
        const t = t1Summary(
          pythonApp(cmd.replace(']', flags === '' ? ']' : `${flags}]`).replace(']\n', ']\n'), {
            'requirements.txt': 'uvicorn==0.54.0\n',
          }),
        );
        expect(t.kind, flags).toBe('UNRESOLVED');
        expect(t.headline, flags).toBe(NOT_READ);
      }
    });

    it('a linked Dockerfile with ENV UVICORN_HTTP=custom is caught the same way (minor C)', () => {
      const r = pythonApp(UVI(), {
        'requirements.txt': 'uvicorn==0.54.0\n',
        Dockerfile: 'FROM python:3.12\nENV UVICORN_HTTP=mypkg.Impl\n',
        'tripcurve.yaml':
          'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    dockerfile: Dockerfile\n',
      });
      expect(t1Summary(r).headline).toBe(NOT_READ);
      // not linked: the Dockerfile is not read
      const unlinked = pythonApp(UVI(), {
        'requirements.txt': 'uvicorn==0.54.0\n',
        Dockerfile: 'FROM python:3.12\nENV UVICORN_HTTP=mypkg.Impl\n',
      });
      expect(t1Of(unlinked).kind).toBe('FAIL');
    });
  });
});

describe('the uvicorn version taken from a pin file is an assumption too', () => {
  const UVW = '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"]';
  const texts = (r: ReturnType<typeof pythonApp>) => r.assumptions.map((a) => a.text);

  it('both versions from one file: one line', () => {
    const r = pythonApp(UVW, { 'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n' });
    expect(texts(r)).toEqual([
      'The gunicorn and uvicorn versions are taken from "requirements.txt".',
    ]);
  });

  it('from different files: one line each, gunicorn first', () => {
    const r = pythonApp(UVW, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': 'uvicorn==0.54.0\n',
    });
    expect(texts(r)).toEqual([
      'The gunicorn version is taken from "requirements.txt".',
      'The uvicorn version is taken from "k8s/requirements.txt".',
    ]);
  });

  it('the same holds with an explicit keepalive', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "-k", "uvicorn_worker.UvicornWorker", "--keep-alive", "75"]',
      { 'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n' },
    );
    expect(t1Of(r).kind).toBe('PASS');
    expect(texts(r)).toEqual([
      'The gunicorn and uvicorn versions are taken from "requirements.txt".',
    ]);
  });

  it('a declared uvicorn version is a chain line, not an assumption; the gunicorn pin still is', () => {
    const r = pythonApp(UVW, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'tripcurve.yaml':
        'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n      uvicorn: "0.54.0"\n',
    });
    expect(t1Of(r).kind).toBe('FAIL');
    expect(texts(r)).toEqual(['The gunicorn version is taken from "requirements.txt".']);
    expect(t1Summary(r).chain).toContain('uvicorn 0.54.0 declared: "0.54.0" @ "tripcurve.yaml":6');
  });

  it('both declared: no assumption at all', () => {
    const r = pythonApp(UVW, {
      'tripcurve.yaml':
        'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n      gunicorn: "26.2.0"\n      uvicorn: "0.54.0"\n',
    });
    expect(t1Of(r).kind).toBe('FAIL');
    expect(texts(r)).toEqual([]);
  });

  it('gthread and uvicorn alone list only the version they use', () => {
    const g = pythonApp('          command: ["gunicorn", "app:app", "--threads", "2"]', {
      'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n',
    });
    expect(texts(g)).toEqual(['The gunicorn version is taken from "requirements.txt".']);
    const u = pythonApp('          command: ["uvicorn", "app:app"]', {
      'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n',
    });
    expect(texts(u)).toEqual(['The uvicorn version is taken from "requirements.txt".']);
  });
});
