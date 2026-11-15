// Hardcore local testing (2026-11-14): a 400 KB `.ts` file of `var a = 1;` lines took 4 s and a 4.8 MB
// one never finished. Cause: `collectExports` called ts-morph's `isExported()` on every variable statement, which asks
// the TypeScript binder for the symbol; the binder appends each of the 30 000 declarations of `a` to one symbol's
// declaration list with a linear "is it already there" scan, so binding is quadratic in the number of statements.
// The export keyword is now read from the syntax. These tests pin linear growth for repeated and for distinct names.
import { Node } from 'ts-morph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { intake, readNodeServer } from '../../src/parse/index.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function read(source: string, name: string) {
  const t = makeTree();
  trees.push(t);
  t.write(name, source);
  const result = intake({ root: t.root });
  const entry = result.files.find((f) => f.class === 'node-source');
  if (entry === undefined) throw new Error('no entry');
  return readNodeServer(result, entry);
}

const head = 'const http = require("http");\nhttp.createServer(() => {}).listen(8080);\n';
const same = (n: number) => `${head}${'var a = 1;\n'.repeat(n)}`;
const distinct = (n: number) =>
  `${head}${Array.from({ length: n }, (_, i) => `var a${i} = ${i};`).join('\n')}\n`;
const exported = (n: number) =>
  `${head}${Array.from({ length: n }, (_, i) => `export const e${i} = ${i};`).join('\n')}\n`;

describe('reading a source file never asks the TypeScript binder for a symbol', () => {
  // The scaling tests below take minutes to fail on the old code; this one fails at once and says why.
  it('no symbol is requested while a file of repeated and exported declarations is read', () => {
    const spy = vi.spyOn(Node.prototype, 'getSymbol');
    try {
      read(
        `${head}${'var a = 1;\n'.repeat(50)}export const e = 1;\nexport { a };\nexport default a;\n`,
        'server.ts',
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// Imports of files that do not exist: each distinct specifier was compared with every earlier one (quadratic).
const missingImports = (n: number) =>
  `${head}${Array.from({ length: n }, (_, i) => `import { a${i} } from './x${i}.js';`).join('\n')}\n`;

describe('reading a source file is linear in its imports of missing files', () => {
  for (const name of ['server.ts', 'server.js']) {
    it(
      `${name}: 4x the imports take about 4x the time`,
      () => {
        expect(scalingRatio((n) => read(missingImports(n), name), 20_000)).toBeLessThan(
          LINEAR_RATIO_LIMIT,
        );
      },
      SCALING_TEST_TIMEOUT_MS,
    );
  }
  it('a repeated specifier is still listed once, and distinct ones each once', () => {
    const r = read(`${head}import './a.js';\nimport './a.js';\nimport './b.js';\n`, 'server.ts');
    expect(r.unreadImports).toHaveLength(2);
  });
});

describe('reading a source file is linear in its statements', () => {
  for (const name of ['server.ts', 'server.js']) {
    it(
      `${name}: 4x the repeated-name statements take about 4x the time`,
      () => {
        expect(scalingRatio((n) => read(same(n), name), 40_000)).toBeLessThan(LINEAR_RATIO_LIMIT);
      },
      SCALING_TEST_TIMEOUT_MS,
    );
    it(
      `${name}: 4x the distinct-name statements take about 4x the time`,
      () => {
        expect(scalingRatio((n) => read(distinct(n), name), 40_000)).toBeLessThan(
          LINEAR_RATIO_LIMIT,
        );
      },
      SCALING_TEST_TIMEOUT_MS,
    );
  }
  it(
    'server.ts: 4x the exported statements take about 4x the time',
    () => {
      expect(scalingRatio((n) => read(exported(n), 'server.ts'), 40_000)).toBeLessThan(
        LINEAR_RATIO_LIMIT,
      );
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

// Guard for the export change: an options object that the file hands to other code (`export`, `export { opts }`,
// `export default opts`) is not followed to its literal, as before; one that stays private is.
describe('an exported options object is not followed', () => {
  const source = (exportLine: string, decl = 'const') =>
    `const http = require("http");\n${decl} opts = { keepAliveTimeout: 5000 };\n${exportLine}\nhttp.createServer(opts, () => {}).listen(8080);\n`;
  const keepAlive = (src: string) => {
    const r = read(src, 'server.ts');
    return r.keepAliveTimeout !== undefined && 'source' in r.keepAliveTimeout ? 'read' : 'not read';
  };
  it('a private const object is read', () => {
    expect(keepAlive(source(''))).toBe('read');
  });
  it.each([
    ['export const', source('', 'export const')],
    ['export { opts }', source('export { opts };')],
    ['export { opts as other }', source('export { opts as other };')],
    ['export default opts', source('export default opts;')],
  ])('%s is not followed', (_label, src) => {
    expect(keepAlive(src)).toBe('not read');
  });
});

// a syntax error in a linked source was not named: T1 said "no server construction found" and nothing was
// listed under "Files not checked". It is now listed, with the line of the first error, and T1 says why.
describe('a source that does not parse is listed and named', () => {
  it('readNodeServer lists the file with the line of the first syntax error', () => {
    const r = read(
      'const http = require("http");\n\nfunction (((\nhttp.createServer(h).listen(1);\n',
      'server.ts',
    );
    expect(r.unchecked).toHaveLength(1);
    expect(r.unchecked[0]?.reasonCode).toBe('source-parse-error');
    expect(r.unchecked[0]?.line).toBe(3);
    expect(r.searchComplete).toBe(false);
  });
});
