// Through the built command: Node source files near the 5 MB limit with very many imports or
// assignments finish with a named result. No wall-clock assertion: a hang ends at the test timeout.
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_FILES } from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function run(server: string) {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries({ ...DEMO_FILES, 'src/server.ts': server })) {
    t.write(path, text);
  }
  return runBuilt(['.'], { cwd: t.root });
}

describe('hostile Node source near the file limit', () => {
  it('200,000 relative imports of files that are not there (3.6 MB)', () => {
    const source = `${Array.from({ length: 200_000 }, (_, i) => `import './m${i % 5}.js';`).join('\n')}\nimport http from 'http';\nhttp.createServer(() => {}).listen(8080);\n`;
    expect(source.length).toBeLessThan(5_000_000);
    const out = run(source);
    expect(out.status).toBe(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('UNRESOLVED T1');
    expect(out.stdout).not.toContain('internal error');
  }, 120_000);

  it('150,000 assignments of a non-literal to keepAliveTimeout (3.9 MB)', () => {
    const source = `import http from 'http';\nconst s = http.createServer(() => {});\n${Array.from({ length: 150_000 }, (_, i) => `s.keepAliveTimeout = x${i};`).join('\n')}\ns.listen(8080);\n`;
    expect(source.length).toBeLessThan(5_000_000);
    const out = run(source);
    expect(out.status).toBe(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('UNRESOLVED T1');
  }, 120_000);
});
