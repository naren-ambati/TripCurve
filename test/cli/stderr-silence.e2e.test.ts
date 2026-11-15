// Review finding N7. The YAML library prints its own warnings (for example for a collection
// used as a key, which an unquoted Helm `{{ .Release.Name }}` becomes) through the process warning
// channel to stderr; `logLevel: 'silent'` in `src/parse/intake/yaml-documents.ts` stops that.
// Mutating it to `'warn'` makes the Helm test fail with "Keys with collection values will be
// stringified" on stderr (run again 2026-11-11). The unknown-tag test does NOT depend on that
// option (the library prints nothing for it either way): it only proves such a manifest writes
// nothing to stderr and does not crash.
import { afterEach, describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function runOn(file: string, text: string) {
  const t = makeTree();
  trees.push(t);
  t.write(file, text);
  return runBuilt(['.'], { cwd: t.root });
}

describe('nothing from the YAML library reaches stderr', () => {
  it('a Helm-style unquoted {{ .Release.Name }} manifest', () => {
    const r = runOn(
      'k8s/web.yaml',
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n',
    );
    expect(r.stderr).toBe('');
  });
  it('a manifest with an unknown tag', () => {
    const r = runOn(
      'k8s/web.yaml',
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: !unknown-tag web\n',
    );
    expect(r.stderr).toBe('');
  });
});
