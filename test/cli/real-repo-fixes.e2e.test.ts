// The built command on the synthetic regression fixtures of bolt B17 (the real-repository fixes): a Terraform
// module split across the files of one folder, a subfolder module that must not link, an override file, a duplicate
// address across files, integer arithmetic on literals, and a Python image with no command. Each expected output
// is exact and was read against its files before it was saved (test/golden/README.md, B17).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const GOLDEN = join(import.meta.dirname, '..', 'golden');

const CASES = [
  { dir: 'terraform/folder-split', golden: 'folder-split-t4.txt', exit: 1 },
  { dir: 'terraform/folder-override', golden: 'folder-override-t4.txt', exit: 1 },
  { dir: 'terraform/folder-duplicate', golden: 'folder-duplicate-t4.txt', exit: 1 },
  { dir: 'terraform/folder-arith', golden: 'folder-arith-t4.txt', exit: 0 },
  { dir: 'link/python-no-command', golden: 'python-no-command-t1.txt', exit: 1 },
] as const;

describe.each(CASES)('$dir', ({ dir, golden, exit }) => {
  const cwd = join(FIXTURES, dir);
  const run = runBuilt(['.'], { cwd });

  it('prints exactly the judged output, exits as judged and writes nothing to stderr', () => {
    expect(run.stdout).toBe(readFileSync(join(GOLDEN, golden), 'utf8'));
    expect(run.status).toBe(exit);
    expect(run.stderr).toBe('');
  });
});

describe('what the fixtures show', () => {
  const out = (golden: string) => readFileSync(join(GOLDEN, golden), 'utf8');

  it('a folder split across three files links, and the subfolder module does not', () => {
    const text = out('folder-split-t4.txt');
    expect(text).toContain('FAIL T4  visibility 60 s is less than 6 x 30 s = 180 s;');
    expect(text).toContain('"queue.tf":2');
    expect(text).toContain('"function.tf":2');
    expect(text).toContain('Workload "child" (event source mapping) in "modules/child/mapping.tf"');
    expect(text.replace(/\s+/g, ' ')).toContain(
      'the aws_sqs_queue the mapping names is not in the same folder',
    );
  });

  it('an override file and a duplicate address are UNRESOLVED, never a verdict', () => {
    expect(out('folder-override-t4.txt')).toContain('an override file changes this resource');
    expect(out('folder-duplicate-t4.txt')).toContain('more than one aws_sqs_queue');
    for (const g of ['folder-override-t4.txt', 'folder-duplicate-t4.txt']) {
      expect(out(g)).not.toMatch(/\b(PASS|FAIL) T4/);
    }
  });

  it('the arithmetic PASS shows the computation in the verbose chain and in JSON', () => {
    const cwd = join(FIXTURES, 'terraform/folder-arith');
    const verbose = runBuilt(['.', '--verbose'], { cwd });
    expect(verbose.stdout).toContain('visibility 240 s = "60 + (30 * 6)" at "queue.tf":2');
    const json = JSON.parse(runBuilt(['.', '--format', 'json'], { cwd }).stdout);
    const chain = json.workloads[0].results[0].chain;
    expect(chain[0]).toMatchObject({
      label: 'visibility',
      value: 240,
      expression: '60 + (30 * 6)',
    });
    expect(chain[1].expression).toBeUndefined();
  });

  it('the Python image gets the neutral hint, and no Node-only step', () => {
    const text = out('python-no-command-t1.txt').replace(/\s+/g, ' ');
    expect(text).toContain(
      'name the program in the container command or args (node, npm, gunicorn or uvicorn)',
    );
    expect(text).not.toContain('pin the image');
  });
});
