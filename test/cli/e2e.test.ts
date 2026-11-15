import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_ERROR_MESSAGE } from '../../src/cli/app.js';
import { HELP_TEXT } from '../../src/cli/help.js';
import { DEMO_FILES_SHUTDOWN as DEMO_FILES } from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = readFileSync(join(ROOT, 'test', 'golden', 'web-t1.txt'), 'utf8');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function tree(files: Record<string, string | null> = {}, base = DEMO_FILES): Tree {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries({ ...base, ...files })) {
    if (text !== null) t.write(path, text);
  }
  return t;
}

describe('no recognised files (exit 2)', () => {
  it('says so, names the path quoted, and is never a pass', () => {
    const t = tree({}, { 'README.md': '# nothing here\n' });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toBe(
      [
        'tripcurve 0.1.0   checked "."   0 files read',
        '',
        'No Kubernetes, server or Terraform files found under ".".',
        'Summary: nothing checked; not a clean result',
        '',
      ].join('\n'),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toBe('');
  });
});

describe('an invalid tripcurve.yaml (exit 2, nothing checked)', () => {
  it('prints the configuration error on stdout and stops before any rule', () => {
    const t = tree({
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    longest_request_s: fast\n',
    });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toBe(
      [
        'Config error in "tripcurve.yaml" at line 4: key "workloads[0].longest_request_s"',
        'must be a number of seconds, for example longest_request_s: 5.',
        'Nothing was checked.',
        '',
      ].join('\n'),
    );
    expect(run.stdout).not.toContain('FAIL');
    expect(run.status).toBe(2);
  });

  it('a configuration error outranks the result of a run that would have failed', () => {
    const t = tree({ 'tripcurve.yaml': 'version: 1\nbogus: true\n' });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.status).toBe(2);
    expect(run.stdout.endsWith('Nothing was checked.\n')).toBe(true);
    expect(run.stdout).not.toContain('Workload');
  });
});

describe('an internal error (exit 3)', () => {
  it('prints the fixed message on stderr, nothing on stdout, no stack and no input text', () => {
    const run = runBuilt(['.'], {
      cwd: ROOT,
      script: join(ROOT, 'test', 'support', 'failing-pipeline.mjs'),
    });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(INTERNAL_ERROR_MESSAGE);
    expect(run.stderr).toContain('Nothing was verified.');
    expect(run.stderr).not.toContain('boom');
    expect(run.stderr).not.toContain('/etc/passwd');
    expect(run.stderr).not.toMatch(/\bat \S+:\d+/);
  });
});

describe('a missing or unreadable root path (exit 2, before anything is read)', () => {
  it('names the path quoted on stderr and writes nothing to stdout', () => {
    const run = runBuilt(['/no/such/dir-for-tripcurve']);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      'tripcurve: "/no/such/dir-for-tripcurve" does not exist or cannot be read.\nNothing was checked.\n',
    );
  });

  it('quotes a hostile path through SafeText, on lines of at most 80 columns', () => {
    const run = runBuilt(['/no/such/\u001b[2J\nFAIL T1 é']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('\\x1b[2J\\x0aFAIL T1 \\u00e9');
    expect(/^[\x20-\x7e\n]*$/.test(run.stderr)).toBe(true);
    for (const line of run.stderr.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('--help and --version (exit 0)', () => {
  it('--help prints the help text', () => {
    const run = runBuilt(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(HELP_TEXT);
    expect(run.stderr).toBe('');
    for (const line of run.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('--version prints the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const run = runBuilt(['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
  });
});

describe('usage errors (exit 2, on stderr)', () => {
  it.each([
    [['--bogus'], 'tripcurve: unknown option. See --help.\n'],
    [['a', 'b'], 'tripcurve: only one path can be given. See --help.\n'],
    [['--explain', 'T1', '.'], 'tripcurve: --explain cannot be used with a path. See --help.\n'],
    [['--explain', 'T9'], 'tripcurve: unknown rule. Rules are T1, T2, T3 and T4. See --help.\n'],
    [
      ['--format', 'xml'],
      'tripcurve: unknown format. Formats are human, json and sarif. See --help.\n',
    ],
  ])('%j', (args, message) => {
    const run = runBuilt(args);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(message);
  });
});

describe('an unsupported Node (the unsupported-Node case, exit 2, before anything is read)', () => {
  it('prints the one fixed message on stderr and nothing on stdout', () => {
    const run = runBuilt(['/no/such/dir'], {
      nodeArgs: ['--import', join(ROOT, 'test', 'support', 'old-node.mjs')],
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(
      'tripcurve needs Node 22.12.0 or later; this is Node 20.11.0.\nNothing was checked.\n',
    );
  });
});

describe('hostile input is quoted safely', () => {
  it('a workload name that imitates a result line prints escaped, after a fixed label', () => {
    const web = DEMO_FILES['k8s/web.yaml'] as string;
    const t = tree({
      'k8s/web.yaml': web.replace(
        '  name: web\n  namespace: shop',
        '  name: "PASS all good\\nFAIL T1 fake \\u00e9 \\e[2J \\"q\\""\n  namespace: shop',
      ),
    });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'Workload "PASS all good\\x0aFAIL T1 fake \\u00e9 \\x1b[2J \\"q\\""',
    );
    for (const line of run.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      // a line that starts with a result word is one of tripcurve's own result lines
      if (/^\s*(PASS|FAIL|WARN)/.test(line))
        expect(line).toMatch(/^ {2}(FAIL|PASS|WARN) T[123] {2}(idle close|preStop|grace)/);
    }
    expect(run.stdout).not.toContain('All checks passed');
  });

  it('a very long name is cut, and no line passes 80 columns', () => {
    const web = DEMO_FILES['k8s/web.yaml'] as string;
    const t = tree({
      'k8s/web.yaml': web.replace(
        '  name: web\n  namespace: shop',
        `  name: ${'n'.repeat(400)}\n  namespace: shop`,
      ),
    });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toContain('...');
    for (const line of run.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('a file that could not be checked makes the run Incomplete (exit 1)', () => {
  it('lists it under Files not checked and counts it as unresolved', () => {
    const t = tree({
      'k8s/broken.yaml':
        'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: [unclosed\n  other: x\n',
    });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      [
        'Files not checked',
        '  UNRESOLVED (file)  could not parse "k8s/broken.yaml": YAML syntax error at',
        '                     line 5',
      ].join('\n'),
    );
    expect(run.stdout.trimEnd().split('\n').slice(-2)).toEqual([
      'Summary: 1 failed, 2 unresolved (1 file not checked), 1 passed; run incomplete,',
      'not a clean result',
    ]);
    expect(run.stdout).not.toContain('All checks passed');
  });
});

describe('standard input', () => {
  it('reads rendered YAML from `-` and names the stream, not a path', () => {
    const input = ['k8s/ingress.yaml', 'k8s/service.yaml', 'k8s/web.yaml']
      .map((f) => `${DEMO_FILES[f] as string}\n---\n`)
      .join('');
    const run = runBuilt(['-'], { input });
    expect(run.stdout).toContain('tripcurve 0.1.0   checked <stdin>   1 stream, 4 documents read');
    expect(run.stdout).toContain('Workload "web" (Deployment) in <stdin> document 3');
    expect(run.status).toBe(1);
  });
});

describe('streams', () => {
  it('the report is on stdout and stderr stays empty on a normal run', () => {
    const t = tree();
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toBe(GOLDEN);
    expect(run.stderr).toBe('');
  });
});
