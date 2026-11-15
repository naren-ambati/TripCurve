import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type InputText, inputText, inputTextEquals } from '../../src/core/index.js';
import { type InputFile, type IntakeResult, intake } from '../../src/parse/intake/index.js';
import {
  LABEL_AMBIGUOUS,
  type NodeServerSettings,
  readNodeServer,
  readNodeSourceFile,
} from '../../src/parse/node/index.js';
import { val } from '../support/k8s-summary.js';
import { txt } from '../support/render.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function fileNamed(result: IntakeResult, path: string): InputFile {
  const f = result.files.find((x) => inputTextEquals(x.canonicalPath, inputText(path)));
  if (!f) throw new Error(`no file ${path}`);
  return f;
}
function readFixture(
  dir: string,
  entry: string,
  root = join(FIXTURES, 'node'),
): NodeServerSettings {
  const r = intake({ root: join(root, dir) });
  return readNodeServer(r, fileNamed(r, entry));
}
function readText(files: Record<string, string>, entry: string): NodeServerSettings {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const r = intake({ root: t.root });
  return readNodeServer(r, fileNamed(r, entry));
}
const names = (list: readonly InputText[]) => list.map((p) => txt(p));

describe('the demo web server: no setting found', () => {
  const s = readFixture('web', 'src/server.ts', join(FIXTURES, 'k8s'));
  it('finds no setting, finds the construction site, and counts the file read', () => {
    expect(s.keepAliveTimeout).toBeUndefined();
    expect(s.keepAliveTimeoutBuffer).toBeUndefined();
    expect(s.headersTimeout).toBeUndefined();
    expect(s.requestTimeout).toBeUndefined();
    expect(s.constructionSite).toMatchObject({ type: 'file', line: 3 });
    expect(names(s.filesRead)).toEqual(['src/server.ts']);
    expect(s.searchComplete).toBe(true);
    expect(s.unresolved).toEqual([]);
  });
});

describe('literal settings in each supported form', () => {
  it('reads assignments, with digit separators, a product and a quoted key', () => {
    const s = readFixture('assign-literal', 'server.ts'.replace('.ts', '.js'));
    expect(val(s.keepAliveTimeout)).toBe('65000@server.js:4');
    expect(val(s.headersTimeout)).toBe('66000@server.js:5');
    expect(val(s.requestTimeout)).toBe('30000@server.js:6');
    expect(val(s.keepAliveTimeoutBuffer)).toBe('2000@server.js:7');
    expect(s.constructionSite).toMatchObject({ line: 3 });
    expect(s.searchComplete).toBe(true);
  });
  it('reads the createServer options object, with a type wrapper and parentheses', () => {
    const s = readFixture('options-literal', 'server.js');
    expect(val(s.keepAliveTimeout)).toBe('65000@server.js:4');
    expect(val(s.headersTimeout)).toBe('66000@server.js:4');
    expect(val(s.requestTimeout)).toBe('60000@server.js:4');
  });
  it('reads an assignment to the value that listen returns (Express)', () => {
    const s = readFixture('express-listen', 'app.js');
    expect(val(s.keepAliveTimeout)).toBe('61000@app.js:5');
    expect(s.constructionSite).toMatchObject({ line: 4 });
  });
  it('follows an options identifier to a const object literal', () => {
    const s = readFixture('identifier-options', 'server.js');
    expect(val(s.keepAliveTimeout)).toBe('70000@server.js:3');
  });
  it('reads Object.assign with an object literal', () => {
    const s = readText(
      { 'a.js': 'const s = http.createServer(h);\nObject.assign(s, { headersTimeout: 7000 });\n' },
      'a.js',
    );
    expect(val(s.headersTimeout)).toBe('7000@a.js:2');
  });
  it('reads hex, exponent and a literal with a zero value as written', () => {
    const s = readText(
      {
        'a.js':
          'const s = http.createServer(h);\ns.keepAliveTimeout = 0x10;\ns.headersTimeout = 1e3;\ns.requestTimeout = 0;\n',
      },
      'a.js',
    );
    expect(val(s.keepAliveTimeout)).toBe('16@a.js:2');
    expect(val(s.headersTimeout)).toBe('1000@a.js:3');
    expect(val(s.requestTimeout)).toBe('0@a.js:4');
  });
  it('parses JSX and an angle-bracket assertion in TypeScript', () => {
    const jsx = readText(
      {
        'a.js': 'const x = <div/>;\nconst s = http.createServer(h);\ns.keepAliveTimeout = 5000;\n',
      },
      'a.js',
    );
    expect(val(jsx.keepAliveTimeout)).toBe('5000@a.js:3');
    const ts = readText(
      {
        'a.ts':
          'const y = <number>z;\nconst s = http.createServer(h);\ns.keepAliveTimeout = 5000;\n',
      },
      'a.ts',
    );
    expect(val(ts.keepAliveTimeout)).toBe('5000@a.ts:3');
  });
});

describe('values that are not a literal are unresolved with a fixed reason', () => {
  it('marks a variable, a call and a sum as non-literal, never a number', () => {
    const s = readFixture('non-literal', 'server.js');
    for (const v of [s.keepAliveTimeout, s.headersTimeout, s.requestTimeout]) {
      expect(v).toMatchObject({ unresolved: true });
    }
    expect(val(s.keepAliveTimeout)).toBe(
      '?keepAliveTimeout is set from something other than a number written in the code',
    );
    expect(s.unresolved.map((u) => u.what)).toEqual(['non-literal', 'non-literal', 'non-literal']);
    expect(s.searchComplete).toBe(true);
  });
  it('marks a shorthand property, a compound assignment and a negative number', () => {
    const s = readText(
      {
        'a.js':
          'import http from "node:http";\nconst keepAliveTimeout = 1;\nconst s = http.createServer({ keepAliveTimeout }, h);\ns.headersTimeout += 5;\ns.requestTimeout = -5;\n',
      },
      'a.js',
    );
    expect(s.unresolved.map((u) => u.what)).toEqual([
      'non-literal',
      'unsupported-form',
      'unsupported-form',
    ]);
    expect(s.keepAliveTimeout).toMatchObject({ unresolved: true });
    expect(s.headersTimeout).toMatchObject({ unresolved: true });
    expect(s.requestTimeout).toMatchObject({ unresolved: true });
  });
  it('a spread in the options is not an allowed form: no setting is read and the search is incomplete', () => {
    const s = readFixture('spread-options', 'server.js');
    expect(s.gaps).toEqual(['createserver-args']);
    // ./base.js is not in the input either
    expect(names(s.unreadImports)).toEqual(['./base.js']);
    expect(s.searchComplete).toBe(false);
  });
  it('an unknown first argument followed by another is not an allowed form: the search is incomplete', () => {
    const s = readText(
      {
        'a.js':
          'import http from "http";\nimport { opts } from "x";\nhttp.createServer(opts, handler);\n',
      },
      'a.js',
    );
    expect(s.gaps).toEqual(['createserver-args']);
    expect(s.searchComplete).toBe(false);
  });
  it('a sole identifier from elsewhere is NOT assumed to be the handler (allow-list)', () => {
    const s = readText(
      {
        'a.js':
          'import http from "http";\nimport { app } from "x";\nhttp.createServer(app).listen(80);\n',
      },
      'a.js',
    );
    expect(s.keepAliveTimeout).toBeUndefined();
    expect(s.gaps).toEqual(['createserver-args']);
    expect(s.searchComplete).toBe(false);
  });
  it('says ambiguous when two places set different values, and keeps equal values', () => {
    const diff = readText(
      { 'a.js': 'http.createServer(h);\nx.keepAliveTimeout = 1000;\ny.keepAliveTimeout = 2000;\n' },
      'a.js',
    );
    expect(diff.keepAliveTimeout).toMatchObject({ unresolved: true });
    expect(
      diff.unresolved.some((u) => u.what === 'ambiguous' && u.label.includes(LABEL_AMBIGUOUS)),
    ).toBe(true);
    const same = readText(
      {
        'a.js':
          'http.createServer(h);\nx.keepAliveTimeout = 1000;\ny.keepAliveTimeout = 1 * 1000;\n',
      },
      'a.js',
    );
    expect(val(same.keepAliveTimeout)).toBe('1000@a.js:2');
    const mixed = readText(
      { 'a.js': 'http.createServer(h);\nx.keepAliveTimeout = 1000;\ny.keepAliveTimeout = f();\n' },
      'a.js',
    );
    expect(mixed.keepAliveTimeout).toMatchObject({ unresolved: true });
  });
});

describe('the search for the setting', () => {
  it('follows local imports, once each, through a cycle, and skips packages', () => {
    const s = readFixture('imports', 'main.js');
    expect(names(s.filesRead)).toEqual(['main.js', 'boot.js', 'util/logger.js', 'tuning.js']);
    expect(names(s.imports)).toEqual(['boot.js', 'util/logger.js', 'tuning.js']);
    expect(s.constructionSite).toMatchObject({ line: 5 });
    expect(s.unreadImports).toEqual([]);
    expect(s.searchComplete).toBe(true);
  });
  it('is not complete when the import depth is cut', () => {
    const r = intake({ root: join(FIXTURES, 'node', 'imports') });
    const s = readNodeServer(r, fileNamed(r, 'main.js'), { maxImportDepth: 0 });
    expect(names(s.filesRead)).toEqual(['main.js']);
    expect(s.constructionSite).toBeUndefined();
    expect(s.searchComplete).toBe(false);
  });
  it('is not complete with no construction site, so the default is not established', () => {
    const s = readFixture('no-site', 'lib.js');
    expect(s.constructionSite).toBeUndefined();
    expect(names(s.filesRead)).toEqual(['lib.js']);
    expect(s.searchComplete).toBe(false);
  });
  it('maps a .js import to the .ts file and finds a directory index', () => {
    const s = readText(
      {
        'a.ts': "import './b.js';\nimport './dir';\n",
        'b.ts': 'http.createServer(h);\nx.keepAliveTimeout = 3000;\n',
        'dir/index.ts': 'export {};\n',
      },
      'a.ts',
    );
    expect(names(s.filesRead)).toEqual(['a.ts', 'b.ts', 'dir/index.ts']);
    expect(val(s.keepAliveTimeout)).toBe('3000@b.ts:2');
  });
  it('does not climb out of the input and ignores data imports', () => {
    const s = readText(
      { 'a.js': "import '../../etc/x';\nimport './data.json';\nhttp.createServer(h);\n" },
      'a.js',
    );
    expect(names(s.unreadImports)).toEqual(['../../etc/x']);
    expect(s.searchComplete).toBe(false);
  });
  it('sees require and dynamic import of a local file', () => {
    const s = readText(
      {
        'a.js': "require('./b');\nimport('./c');\n",
        'b.js': 'http.createServer(h);\n',
        'c.js': 'x.headersTimeout = 9000;\n',
      },
      'a.js',
    );
    expect(names(s.filesRead)).toEqual(['a.js', 'b.js', 'c.js']);
    expect(val(s.headersTimeout)).toBe('9000@c.js:1');
  });
});

describe('hostile source never crashes and never reads as a pass', () => {
  it('reports a syntax error as source-parse-error (with its line) and reads nothing from the file', () => {
    const s = readFixture('syntax-error', 'server.js');
    expect(s.unchecked).toHaveLength(1);
    expect(s.unchecked[0]).toMatchObject({ path: s.entryFile, reasonCode: 'source-parse-error' });
    expect(s.unchecked[0]?.line).toBeGreaterThan(0);
    expect(s.keepAliveTimeout).toBeUndefined();
    expect(s.filesRead).toEqual([]);
    expect(s.searchComplete).toBe(false);
  });
  it('catches deep nesting at the file boundary as over-depth', () => {
    for (const body of [
      `s.keepAliveTimeout = ${'('.repeat(100_000)}1${')'.repeat(100_000)};`,
      `s.keepAliveTimeout = ${'1*'.repeat(100_000)}1;`,
      `${'['.repeat(100_000)}${']'.repeat(100_000)};`,
    ]) {
      const s = readText({ 'a.js': `http.createServer(h);\n${body}\n` }, 'a.js');
      expect(s.unchecked.map((u) => u.reasonCode)).toEqual(['over-depth']);
      expect(s.keepAliveTimeout).toBeUndefined();
      expect(s.searchComplete).toBe(false);
    }
  });
  it('a deep file reached by import is unchecked and the rest still reads', () => {
    const s = readText(
      {
        'a.js': "import './deep.js';\nhttp.createServer(h);\nx.keepAliveTimeout = 1000;\n",
        'deep.js': `x = ${'('.repeat(100_000)}1${')'.repeat(100_000)};\n`,
      },
      'a.js',
    );
    expect(s.unchecked.map((u) => u.reasonCode)).toEqual(['over-depth']);
    expect(val(s.keepAliveTimeout)).toBe('1000@a.js:3');
    expect(s.searchComplete).toBe(false);
  });
  it('never runs anything in the file', () => {
    const g = globalThis as { __tripcurveRan?: boolean };
    g.__tripcurveRan = undefined;
    readText(
      {
        'a.js':
          'globalThis.__tripcurveRan = true;\nhttp.createServer(h);\nprocess.exit(3);\nrequire("child_process").execSync("false");\n',
      },
      'a.js',
    );
    expect(g.__tripcurveRan).toBeUndefined();
  });
  it('readNodeSourceFile never throws on odd text', () => {
    const t = makeTree();
    trees.push(t);
    t.write('a.js', '\u0000￿`${`${');
    const r = intake({ root: t.root });
    const f = r.files[0];
    if (f) expect(() => readNodeSourceFile(f)).not.toThrow();
  });
});
