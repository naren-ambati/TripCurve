// `demo-fixed/` is the after-fix state kept as a second tree. This test keeps it honest: the documented
// fix (the three documented steps, then the `tripcurve.yaml` declarations) applied to a copy of `demo/`
// must equal `demo-fixed/` file for file, and it must also run to the after-fix expected output.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AFTER_FIX,
  applyFixEdits,
  copyOfDemo,
  DEMO_FIXED,
  FIX_EDITS,
  replaceOnce,
  TRIPCURVE_YAML,
  treeContents,
} from '../support/demo.js';
import { runBuilt } from '../support/e2e.js';
import type { Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});
const fixedCopy = (): Tree => {
  const t = copyOfDemo();
  trees.push(t);
  applyFixEdits(t);
  t.write('tripcurve.yaml', TRIPCURVE_YAML);
  return t;
};

describe('demo-fixed/ equals demo/ plus the documented fix', () => {
  it('has the same files with the same bytes', () => {
    const t = fixedCopy();
    expect(treeContents(DEMO_FIXED)).toEqual(treeContents(t.root));
  });

  it('the copy with the fix applied prints the after-fix expected file and exits 0', () => {
    const t = fixedCopy();
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toBe(readFileSync(AFTER_FIX, 'utf8'));
    expect(run.status).toBe(0);
  });

  it('the fix is four edits, one per step, and each matches exactly once in demo/', () => {
    expect(FIX_EDITS.map((e) => e.step)).toEqual([
      '1: Node keepAliveTimeout',
      '2: gunicorn --keep-alive 75',
      '2: preStop sleep 10 on api',
      '2: visibility 190',
    ]);
    const t = copyOfDemo();
    trees.push(t);
    for (const e of FIX_EDITS) {
      expect(
        () => replaceOnce(readFileSync(`${t.root}/${e.file}`, 'utf8'), e.from, e.to),
        e.step,
      ).not.toThrow();
    }
  });

  it('can fail: one changed value in a copy of demo-fixed/ makes the trees differ', () => {
    const t = fixedCopy();
    t.write(
      'infra/queue.tf',
      readFileSync(`${t.root}/infra/queue.tf`, 'utf8').replace('= 190', '= 191'),
    );
    expect(treeContents(DEMO_FIXED)).not.toEqual(treeContents(t.root));
  });
});
