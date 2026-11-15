// Regression (review finding on B1 code): a Node source file with very many imports, or very many
// assignments to a server setting, took superlinear time (ts-morph's getStartLineNumber rescans
// the text from the start for every node). Work must grow linearly with the file.
import { afterEach, describe, expect, it } from 'vitest';
import { intake, readNodeServer } from '../../src/parse/index.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function read(source: string) {
  const t = makeTree();
  trees.push(t);
  t.write('server.ts', source);
  const result = intake({ root: t.root });
  const entry = result.files.find((f) => f.class === 'node-source');
  if (entry === undefined) throw new Error('no entry');
  return readNodeServer(result, entry);
}

const imports = (n: number) =>
  `${Array.from({ length: n }, (_, i) => `import './m${i % 5}.js';`).join('\n')}\nimport http from 'http';\nhttp.createServer(() => {}).listen(8080);\n`;
const assignments = (n: number) =>
  `import http from 'http';\nconst s = http.createServer(() => {});\n${Array.from({ length: n }, (_, i) => `s.keepAliveTimeout = x${i};`).join('\n')}\ns.listen(8080);\n`;

// B3: the listen-order check compared every assignment with every `listen` call,
// so n assignments and n listen calls took n x n steps (8000 of each took 37 s).
const manyListens = (n: number) =>
  `import http from 'http';\nconst s = http.createServer(() => {});\n${Array.from({ length: n }, () => 's.keepAliveTimeout = 7000;').join('\n')}\n${Array.from({ length: n }, () => 's.listen(8080);').join('\n')}\n`;

describe('the listen-order check is linear in assignments and listen calls', () => {
  it(
    '4x the assignments and the listen calls take about 4x the time',
    () => {
      expect(scalingRatio((n) => read(manyListens(n)), 500)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

describe('the Node source reader is linear in the file', () => {
  it(
    'imports: 4x the import lines take about 4x the time',
    () => {
      expect(scalingRatio((n) => read(imports(n)), 2000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'assignments: 4x the assignments take about 4x the time',
    () => {
      expect(scalingRatio((n) => read(assignments(n)), 2000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('the lines it reports are still right (the line of a late import and a late setting)', () => {
    const r = read(
      `${'\n'.repeat(99)}const a = 1;\nimport http from 'http';\nconst s = http.createServer(() => {});\ns.keepAliveTimeout = 7000;\n`,
    );
    expect(r.constructionSite).toBeDefined();
    const ka = r.keepAliveTimeout;
    expect(ka && 'source' in ka ? (ka.source as { line: number }).line : -1).toBe(103);
  });
});
