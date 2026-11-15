// The built command on the Python servers fixture (bolt B2): the golden text of `api` and `admin`,
// and rendered Helm output on standard input.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'python', 'api-admin');
const GOLDEN = readFileSync(join(ROOT, 'test', 'golden', 'api-admin-t1.txt'), 'utf8');
const WEB_GOLDEN = readFileSync(join(ROOT, 'test', 'golden', 'web-t1.txt'), 'utf8');
const read = (f: string): string => readFileSync(join(FIXTURE, 'k8s', f), 'utf8');

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

describe('golden: tripcurve . on the api and admin fixture (written before the readers)', () => {
  const run = runBuilt(['.'], { cwd: FIXTURE });

  it('prints exactly the golden text, exit 1, nothing on stderr', () => {
    expect(run.stdout).toBe(GOLDEN);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('prints the sync worker as N/A with its reason and its source, and never flags it', () => {
    expect(GOLDEN).toContain('  N/A  T1  gunicorn sync worker closes after every response');
    expect(GOLDEN).toContain('("k8s/admin.yaml":18, no -k given)');
    const admin = GOLDEN.slice(GOLDEN.indexOf('Workload "admin"'), GOLDEN.indexOf('Assumptions'));
    expect(admin).not.toMatch(/FAIL/);
  });

  it('prints T2 and T3 (bolt B4) and nothing about T4', () => {
    expect(run.stdout).toMatch(/\bT2\b/);
    expect(run.stdout).toMatch(/\bT3\b/);
    expect(run.stdout).not.toMatch(/\bT4\b/);
  });

  it('is plain ASCII, at most 80 columns, and the web golden is untouched', () => {
    for (const line of GOLDEN.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
    const web = runBuilt(['.'], { cwd: join(ROOT, 'test', 'fixtures', 'link', 'web-demo') });
    expect(web.stdout).toBe(WEB_GOLDEN);
  });
});

describe('standard input: rendered Helm output', () => {
  /** Helm writes `---` and `# Source: <chart path>` before every object. */
  const doc = (source: string | undefined, body: string): string =>
    `---\n${source === undefined ? '' : `# Source: ${source}\n`}${body}`;
  const split = (services: string): string[] =>
    services.split('---\n').filter((s) => s.trim() !== '');
  const [svcApi, svcAdmin] = split(read('services.yaml'));
  const input = [
    doc('chart/templates/ingress.yaml', read('ingress.yaml')),
    doc('chart/templates/service-api.yaml', svcApi as string),
    doc(undefined, svcAdmin as string),
    doc('chart/templates/api.yaml', read('api.yaml')),
    doc('chart/templates/admin.yaml', read('admin.yaml')),
  ].join('');
  const lineOf = (needle: string, nth = 1): number => {
    const lines = input.split('\n');
    let seen = 0;
    for (const [i, line] of lines.entries()) {
      if (line.includes(needle)) {
        seen += 1;
        if (seen === nth) return i + 1;
      }
    }
    throw new Error(needle);
  };

  it('reads several documents from `-`, names sources <stdin> document n, line m, and shows the Helm comment only quoted after its label', () => {
    const run = runBuilt(['-'], { input });
    const expected = [
      'tripcurve 0.1.0   checked <stdin>   1 stream, 5 documents read',
      '',
      'Workload "api" (Deployment) in <stdin> document 4',
      '           (Helm source comment "chart/templates/api.yaml")',
      '  FAIL T2  no drain delay before SIGTERM',
      `           target-type ip   <stdin> document 1, line ${lineOf('alb.ingress.kubernetes.io/target-type: ip')}`,
      '           preStop none     in <stdin> document 4',
      '           drain none       in-process drains are read for Node source only;',
      '                            none declared',
      '  UNRESOLVED T1  idle close not established: no gunicorn version in the files',
      `           worker uvicorn   <stdin> document 4, line ${lineOf('uvicorn_worker.UvicornWorker')}`,
      '           version          no gunicorn version in the files',
      `           LB idle 60 s     <stdin> document 1, line ${lineOf('idle_timeout.timeout_seconds=60')}`,
      '           declare runtime.gunicorn for this workload in tripcurve.yaml',
      '  NOT EVALUATED T3  T2 failed for this workload',
      '',
      'Workload "admin" (Deployment) in <stdin> document 5',
      '           (Helm source comment "chart/templates/admin.yaml")',
      '  UNRESOLVED T3  no gunicorn version in the files',
      `           grace 45 s       <stdin> document 5, line ${lineOf('terminationGracePeriodSeconds: 45')}`,
      `           preStop 10 s     <stdin> document 5, line ${lineOf('command: ["sleep", "10"]')}`,
      '           declare runtime.gunicorn for this workload in tripcurve.yaml',
      '           declare longest_request_s for this workload in tripcurve.yaml',
      '  N/A  T1  gunicorn sync worker closes after every response (<stdin> document 5,',
      `           line ${lineOf('command: ["gunicorn", "admin:app"')}, no -k given)`,
      `  PASS T2  preStop sleep 10 s (<stdin> document 5, line ${lineOf('command: ["sleep", "10"]')})`,
      '',
      'Assumptions',
      "  - Endpoint removal needs time to propagate; AWS's EKS guide suggests a preStop",
      '    of 10 s. tripcurve checks a delay exists, not that it is enough.',
      '  - Green never means zero-downtime: the SIGTERM race and the deregistration',
      '    delay are outside these rules.',
      '',
      'Summary: 1 failed, 2 unresolved, 1 not evaluated, 1 not applicable, 1 passed;',
      'not a clean result',
      '',
    ].join('\n');
    expect(run.stdout).toBe(expected);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('a Helm comment is never a source: a document with none prints no Helm line, and no path appears as a source', () => {
    const run = runBuilt(['-'], { input: input.replaceAll(/# Source: .*\n/g, '') });
    expect(run.stdout).not.toContain('Helm source comment');
    expect(run.stdout).toContain('Workload "api" (Deployment) in <stdin> document 4\n  FAIL T2');
  });

  it('a hostile comment is quoted: control characters escaped, a quote escaped, a very long one cut, no line starts with it', () => {
    const evil = `chart/x"\u001b[31m\u0007 PASS T1 all good ${'z'.repeat(400)}`;
    const hostile = input.replace('chart/templates/api.yaml', evil);
    const run = runBuilt(['-'], { input: hostile });
    expect(run.status).toBe(1);
    for (const line of run.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      expect(line.startsWith('"')).toBe(false);
      expect(line).not.toMatch(/^ *PASS T1/);
    }
    expect(run.stdout).toContain('(Helm source comment "chart/x\\"\\x1b[31m\\x07 PASS T1 all go');
    expect(run.stdout).toContain('...');
  });

  it('with `-` and no --config no tripcurve.yaml is looked up, even one in the working directory', () => {
    const t = makeTree();
    trees.push(t);
    t.write('tripcurve.yaml', 'version: 1\nthis is: [not valid\n');
    const run = runBuilt(['-'], { input, cwd: t.root });
    expect(run.stdout).toContain('Workload "api"');
    expect(run.stdout).not.toContain('Config error');
    expect(run.status).toBe(1);
  });

  it('a malformed document among good ones: the good ones are read and the bad one is counted', () => {
    const broken = `${input}---\n# Source: chart/templates/broken.yaml\napiVersion: v1\nkind: Pod\nmetadata: [unclosed\n`;
    const run = runBuilt(['-'], { input: broken });
    expect(run.stdout).toContain('Workload "admin"');
    expect(run.stdout).toContain('Workload "api"');
    expect(run.stdout).toContain(
      'Files not checked\n  UNRESOLVED (file)  could not parse <stdin>: YAML syntax error at line',
    );
    expect(run.stdout).toContain(
      'Summary: 1 failed, 3 unresolved (1 file not checked), 1 not evaluated, 1 not\napplicable, 1 passed; run incomplete, not a clean result',
    );
    expect(run.status).toBe(1);
  });

  it('a Helm template with {{ }} left in a name is named, not silently dropped', () => {
    const run = runBuilt(['-'], {
      input: `${input}---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: {{ .Release.Name }}\n`,
    });
    expect(run.stdout).toContain('skipped <stdin>: a Kubernetes object could not be');
    expect(run.stdout).toMatch(
      /run incomplete,\s+not a clean result|run\s+incomplete, not a clean result/,
    );
  });
});

describe('pin files through the built command', () => {
  const tree = (requirements: string): string => {
    const t = makeTree();
    trees.push(t);
    for (const f of ['ingress.yaml', 'services.yaml', 'api.yaml', 'admin.yaml']) {
      t.write(`k8s/${f}`, read(f));
    }
    t.write('requirements.txt', requirements);
    return t.root;
  };

  it('a 4 MB requirements.txt of other packages, then the pin, finishes with the FAIL form', () => {
    const lines = `${'flask-extension-package==1.2.3 ; python_version >= "3.9"\n'.repeat(70_000)}gunicorn==26.2.0\nuvicorn==0.54.0\n`;
    expect(lines.length).toBeLessThan(5_000_000);
    const out = runBuilt(['.'], { cwd: tree(lines) });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('  FAIL T1  idle close 2 s is not longer than LB idle 60 s');
    expect(out.stdout).toContain(
      '  - The gunicorn and uvicorn versions are taken from "requirements.txt".',
    );
  }, 120_000);

  it('a hostile requirements.txt (control characters, huge line) is a named UNRESOLVED, never a crash', () => {
    const out = runBuilt(['.'], {
      cwd: tree(`gunicorn==26.2.0\u001b[31m\n${'gunicorn=='.repeat(100_000)}\n`),
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain(
      'UNRESOLVED T1  idle close not established: a gunicorn pin in the',
    );
  });

  it('two files pinning different versions: UNRESOLVED with the declare line', () => {
    const root = tree('gunicorn==26.2.0\n');
    const t = trees[trees.length - 1] as Tree;
    t.write('uv.lock', '[[package]]\nname = "gunicorn"\nversion = "27.0.0"\n');
    const out = runBuilt(['.'], { cwd: root });
    expect(out.stdout).toContain('the repository pins different gunicorn versions');
    expect(out.stdout).toContain('declare runtime.gunicorn for this workload in tripcurve.yaml');
  });
});
