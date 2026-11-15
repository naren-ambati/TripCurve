// Where a gunicorn or uvicorn version comes from (maintainer decision 2026-11-11): a runtime.gunicorn or
// runtime.uvicorn declaration, else an EXACT pin in the repository nearest the manifest. Different
// pins are UNRESOLVED unless a declaration exists. The default knowledge base is used throughout.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees, t1Of } from '../support/analyse.js';
import { cleanupPythonTrees, pythonApp, reviewFiles, t1Summary } from '../support/python.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

/** The uvicorn worker needs a plain uvicorn pin to count as measured: this adds one beside the files. */
const app = (cmd: string, files: Record<string, string | null> = {}) =>
  pythonApp(cmd, { 'requirements-uvicorn.txt': 'uvicorn==0.54.0\n', ...files });
/** The uvicorn pin the helper adds, as the Assumption names it (the worker uses a uvicorn version too). */
const UVA = 'The uvicorn version is taken from "requirements-uvicorn.txt".';
const UV = '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"]';
const SYNC = '          command: ["gunicorn", "app:app"]';
const UVICORN = '          command: ["uvicorn", "app:app"]';
const DECLARE = (key: string) => `declare runtime.${key} for this workload in tripcurve.yaml`;
const YAML = (runtime: string) =>
  `version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    runtime:\n${runtime}`;
const CITE26 =
  'idle close: 2 s @ default: gunicorn keepalive, uvicorn worker (gunicorn 26.x; measured on 26.2.0)';
const LB = 'LB idle: 60 s @ "k8s/ingress.yaml":9';
const assumptions = (r: ReturnType<typeof pythonApp>) => r.assumptions.map((a) => a.text);

describe('an exact pin gives the release (`api` of the demo)', () => {
  it('requirements.txt gunicorn==26.2.0: FAIL T1 with the exact citation and an Assumption naming the file', () => {
    const r = app(UV, { 'requirements.txt': 'gunicorn==26.2.0\n' });
    expect(t1Summary(r)).toEqual({
      kind: 'FAIL',
      headline: 'idle close 2 s is not longer than LB idle 60 s',
      chain: [CITE26, 'worker: uvicorn @ "k8s/app.yaml":20', LB],
    });
    expect(assumptions(r)).toEqual(['The gunicorn version is taken from "requirements.txt".', UVA]);
  });

  it('gunicorn 27.0.0 gives the 27.x citation', () => {
    const r = app(UV, { 'requirements.txt': 'gunicorn==27.0.0\n' });
    expect(t1Summary(r).chain[0]).toBe(
      'idle close: 2 s @ default: gunicorn keepalive, uvicorn worker (gunicorn 27.x; measured on 27.0.0)',
    );
  });

  it('a later release of the measured line is covered; an older one or a later major is not', () => {
    expect(t1Of(app(UV, { 'requirements.txt': 'gunicorn==26.2.2\n' })).kind).toBe('FAIL');
    for (const v of ['26.1.0', '25.0.0', '28.0.0']) {
      const t = t1Summary(app(UV, { 'requirements.txt': `gunicorn==${v}\n` }));
      expect(t.kind, v).toBe('UNRESOLVED');
      expect(t.headline, v).toBe(
        `idle close not established: gunicorn ${v} is not covered by a measured default`,
      );
    }
  });

  it('gthread with a pin uses the gthread entry', () => {
    const r = pythonApp('          command: ["gunicorn", "app:app", "--threads", "2"]', {
      'requirements.txt': 'gunicorn==26.2.0\n',
    });
    expect(t1Summary(r).chain[0]).toBe(
      'idle close: 2 s @ default: gunicorn keepalive, gthread worker (gunicorn 26.x; measured on 26.2.0)',
    );
  });

  it('uvicorn alone reads the uvicorn pin: FAIL with its own citation', () => {
    const r = pythonApp(UVICORN, { 'requirements.txt': 'uvicorn==0.54.0\n' });
    expect(t1Summary(r)).toMatchObject({
      kind: 'FAIL',
      chain: [
        'idle close: 5 s @ default: uvicorn keepalive (uvicorn 0.54.x; measured on 0.54.0)',
        LB,
      ],
    });
    expect(assumptions(r)).toEqual(['The uvicorn version is taken from "requirements.txt".']);
  });

  it('the gunicorn worker case reads the gunicorn pin, not the uvicorn one', () => {
    const r = app(UV, { 'requirements.txt': 'uvicorn==0.54.0\n' });
    expect(t1Of(r).kind).toBe('UNRESOLVED');
  });

  it('the sync worker needs no version: N/A, and no Assumption about one', () => {
    const r = pythonApp(SYNC, { 'requirements.txt': 'gunicorn==26.2.0\n' });
    expect(t1Of(r).kind).toBe('N/A');
    expect(assumptions(r)).toEqual([]);
  });

  it.each([
    ['pyproject.toml', '[project]\ndependencies = ["gunicorn==26.2.0"]\n'],
    ['poetry.lock', '[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n'],
    ['uv.lock', '[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n'],
  ])('%s is read', (name, text) => {
    const r = app(UV, { [name]: text });
    expect(t1Of(r).kind).toBe('FAIL');
    expect(assumptions(r)).toEqual([`The gunicorn version is taken from "${name}".`, UVA]);
  });
});

describe('a declaration wins', () => {
  it('runtime.gunicorn beats a different pin, with no conflict, and is a chain step, not an Assumption', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==27.0.0\n',
      'uv.lock': '[[package]]\nname = "gunicorn"\nversion = "25.0.0"\n',
      'tripcurve.yaml': YAML('      gunicorn: "26.2.0"\n'),
    });
    const t = t1Summary(r);
    expect(t.kind).toBe('FAIL');
    expect(t.chain).toEqual([
      CITE26,
      'worker: uvicorn @ "k8s/app.yaml":20',
      'gunicorn 26.2.0 declared: "26.2.0" @ "tripcurve.yaml":6',
      LB,
    ]);
    // the gunicorn declaration is a chain line; the uvicorn pin the helper adds is an Assumption
    expect(assumptions(r)).toEqual([UVA]);
  });

  it('runtime.uvicorn for uvicorn alone', () => {
    const r = pythonApp(UVICORN, { 'tripcurve.yaml': YAML('      uvicorn: "0.54.1"\n') });
    expect(t1Of(r).kind).toBe('FAIL');
  });

  it('a declaration that is not a version is UNRESOLVED, whatever the pins say', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'tripcurve.yaml': YAML('      gunicorn: "latest"\n'),
    });
    const t = t1Summary(r);
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(
      'idle close not established: the declared gunicorn version is not a version',
    );
  });

  it('a declared range of releases the entries do not all cover is UNRESOLVED (a declared "26" includes 26.0)', () => {
    const r = app(UV, { 'tripcurve.yaml': YAML('      gunicorn: "26"\n') });
    expect(t1Of(r).kind).toBe('UNRESOLVED');
  });
});

describe('no pin, several pins, pins that are not exact', () => {
  it.each([
    ['no file', {}, 'no gunicorn version in the files'],
    [
      'another package only',
      { 'requirements.txt': 'flask==3.0.0\n' },
      'no gunicorn version in the files',
    ],
    [
      'an unpinned name',
      { 'requirements.txt': 'gunicorn\n' },
      'gunicorn is not pinned to an exact version in the files',
    ],
    [
      '>=',
      { 'requirements.txt': 'gunicorn>=26\n' },
      'gunicorn is not pinned to an exact version in the files',
    ],
    [
      '~=',
      { 'requirements.txt': 'gunicorn~=26.2\n' },
      'gunicorn is not pinned to an exact version in the files',
    ],
    [
      'a Poetry caret',
      { 'pyproject.toml': '[tool.poetry.dependencies]\ngunicorn = "^26.2"\n' },
      'gunicorn is not pinned to an exact version in the files',
    ],
  ])('%s: UNRESOLVED, with the declare line', (_l, files, reason) => {
    const r = app(UV, files);
    const f = t1Of(r);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${reason}`);
    expect(f.declare).toEqual([DECLARE('gunicorn')]);
    expect(assumptions(r)).toEqual([]);
  });

  it('uvicorn alone names runtime.uvicorn in its declare line', () => {
    expect(t1Of(pythonApp(UVICORN)).declare).toEqual([DECLARE('uvicorn')]);
  });

  it('files in one folder that pin different versions: UNRESOLVED, the repository pins different versions', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'poetry.lock': '[[package]]\nname = "gunicorn"\nversion = "27.0.0"\n',
    });
    const f = t1Of(r);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'idle close not established: the repository pins different gunicorn versions',
    );
  });

  it('two pins in one file conflict the same way', () => {
    const r = app(UV, { 'requirements.txt': 'gunicorn==26.2.0\ngunicorn==27.0.0\n' });
    expect(t1Of(r).headline).toBe(
      'idle close not established: the repository pins different gunicorn versions',
    );
  });

  it('the same pin in two files is one version, the file named is the first by path', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'pyproject.toml': '[project]\ndependencies = ["gunicorn==26.2.0"]\n',
    });
    expect(t1Of(r).kind).toBe('FAIL');
    expect(assumptions(r)).toEqual(['The gunicorn version is taken from "pyproject.toml".', UVA]);
  });

  it('a pin tripcurve cannot read is UNRESOLVED, never skipped for another file', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0rc1\n',
      'poetry.lock': '[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n',
    });
    expect(t1Of(r).headline).toBe(
      'idle close not established: a gunicorn pin in the repository is not in a form tripcurve reads',
    );
  });
});

describe('which file belongs to the workload: the nearest one from the manifest up', () => {
  it('a file beside the manifest beats one at the root, and the Assumption names it', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==27.0.0\n',
      'k8s/requirements.txt': 'gunicorn==26.2.0\n',
    });
    expect(t1Summary(r).chain[0]).toBe(CITE26);
    expect(assumptions(r)).toEqual([
      'The gunicorn version is taken from "k8s/requirements.txt".',
      UVA,
    ]);
  });

  it('a nearer folder with no pin of the package does not hide a farther one', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': 'flask==3.0.0\n',
    });
    expect(t1Of(r).kind).toBe('FAIL');
    expect(assumptions(r)).toEqual(['The gunicorn version is taken from "requirements.txt".', UVA]);
  });

  it('a file in a folder that is not on the way up is not a candidate', () => {
    const r = app(UV, { 'services/other/requirements.txt': 'gunicorn==26.2.0\n' });
    expect(t1Of(r).kind).toBe('UNRESOLVED');
  });

  it('a requirements-dev.txt next to the manifest counts like requirements.txt', () => {
    expect(t1Of(app(UV, { 'requirements-prod.txt': 'gunicorn==26.2.0\n' })).kind).toBe('FAIL');
  });
});

describe('review fixes: a file that cannot be read for the package, or that names it without an exact pin, is the answer', () => {
  const FORM =
    'idle close not established: a gunicorn pin in the repository is not in a form tripcurve reads';
  const NOT_PINNED =
    'idle close not established: gunicorn is not pinned to an exact version in the files';
  const MARKER =
    'idle close not established: the gunicorn pin applies only under an environment marker';

  it.each(['pins-p3', 'pins-p10', 'pins-p11', 'pins-p7'])(
    'reviewer fixture %s: UNRESOLVED, never the exact pin of another file',
    (name) => {
      const r = app(UV, reviewFiles(name));
      const f = t1Of(r);
      expect(f.kind, name).toBe('UNRESOLVED');
      expect(f.headline, name).toBe(FORM);
      expect(assumptions(r), name).toEqual([]);
    },
  );

  it('-c constraints.txt next to the pin leaves the pin unread (P3)', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n-c constraints.txt\n',
      'constraints.txt': 'gunicorn==20.1.0\n',
    });
    expect(t1Of(r).headline).toBe(FORM);
  });

  it('a nearer file that names the package without an exact pin stops the search: no fall-through to the root pin', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': 'gunicorn>=20\n',
    });
    expect(t1Of(r).headline).toBe(NOT_PINNED);
  });

  it('a nearer unreadable file stops it too', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': '-r ../base.txt\n',
    });
    expect(t1Of(r).headline).toBe(FORM);
  });

  it('a nearer file that does not mention the package does not stop it', () => {
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': 'flask==3.0.0\n',
    });
    expect(t1Of(r).kind).toBe('FAIL');
  });

  it('an environment marker on the pin: UNRESOLVED, whatever else says', () => {
    const cases: Array<Record<string, string>> = [
      { 'requirements.txt': "gunicorn==26.2.0; python_version<'3'\n" },
      {
        'pyproject.toml': `[project]\ndependencies = ["gunicorn==26.2.0; sys_platform == 'win32'"]\n`,
      },
      {
        'requirements.txt': "gunicorn==26.2.0; python_version<'3'\n",
        'uv.lock': '[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n',
      },
    ];
    for (const files of cases) {
      const r = app(UV, files);
      expect(t1Of(r).headline).toBe(MARKER);
      expect(assumptions(r)).toEqual([]);
    }
  });

  it('a pin file the reader skipped (over 5 MB) in the nearest folder: UNRESOLVED with that reason (m2)', () => {
    const big = `gunicorn==26.2.0\n${'# x\n'.repeat(1_400_000)}`;
    const r = app(UV, { 'requirements.txt': big });
    expect(t1Of(r).headline).toBe(
      'idle close not established: a gunicorn pin file was skipped: larger than the 5 MB limit',
    );
  });

  it('a skipped pin file in a nearer folder beats an exact pin farther up', () => {
    const big = `gunicorn==27.0.0\n${'# x\n'.repeat(1_400_000)}`;
    const r = app(UV, {
      'requirements.txt': 'gunicorn==26.2.0\n',
      'k8s/requirements.txt': big,
    });
    expect(t1Of(r).headline).toContain('a gunicorn pin file was skipped');
  });
});
