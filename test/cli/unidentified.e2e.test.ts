// through the built command: a Helm-templated name must not
// exit 0, print a green line, or leak the yaml library's own warning to stderr.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_FILES } from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const HOSTILE = join(import.meta.dirname, '..', 'fixtures', 'hostile');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

describe('an unidentifiable object through the built command', () => {
  it('the Helm-name fixture: not exit 0, no green line, empty stderr, the file listed', () => {
    const run = runBuilt(['.'], { cwd: join(HOSTILE, 'helm-name') });
    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain('All checks passed');
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('Files not checked');
    expect(run.stdout).toContain('"deployment.yaml"');
    expect(run.stdout.replace(/\s+/g, ' ')).toContain(
      'a Kubernetes object could not be identified',
    );
  });

  it('beside a working demo it makes the run Incomplete, not NotClean', () => {
    const t = makeTree();
    trees.push(t);
    for (const [p, text] of Object.entries(DEMO_FILES)) t.write(p, text);
    t.write('k8s/odd.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: {{ .Values.n }}\n');
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('1 file not checked');
    expect(run.status).toBe(1);
  });
});
