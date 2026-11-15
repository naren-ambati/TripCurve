// Through the whole pipeline: a source file that is too large to read safely, one that does not parse,
// and 4.8 MB files in several shapes. Never a hang, never a PASS, always listed under "Files not checked".
import { afterEach, describe, expect, it } from 'vitest';
import { intake, MAX_SOURCE_NODES } from '../../src/parse/index.js';
import { assembleReport, renderHuman } from '../../src/report/index.js';
import { analyseFiles, cleanupTrees, ruleOf, t1Of, webManifest } from '../support/analyse.js';
import { txt } from '../support/render.js';

afterEach(cleanupTrees);

const HEAD =
  'import http from "node:http";\nconst server = http.createServer(() => {});\nserver.keepAliveTimeout = 65000;\nserver.listen(8080);\n';

function report(files: Record<string, string>) {
  const { result, tree } = analyseFiles(files);
  return {
    result,
    report: assembleReport({ checked: '.', intake: intake({ root: tree.root }), analysis: result }),
  };
}
const listed = (r: ReturnType<typeof report>['report']) =>
  r.unchecked.map(
    (u) => `${txt(u.path as never)}|${u.reasonCode}${u.line === undefined ? '' : `@${u.line}`}`,
  );

describe('the node-count limit of one source file', () => {
  it('is a fixed number, 500000 syntax nodes', () => {
    expect(MAX_SOURCE_NODES).toBe(500_000);
  });

  it('a file over the limit is listed unchecked as source-too-large, T1 is UNRESOLVED and never PASS', () => {
    // `a;` is two nodes (a statement and an identifier): this is just over the limit
    const big = `${HEAD}${'a;\n'.repeat(MAX_SOURCE_NODES / 2)}`;
    const { result, report: r } = report({ 'src/server.ts': big });
    expect(listed(r)).toContain('src/server.ts|source-too-large');
    const t1 = t1Of(result);
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('source too large to read safely');
    expect(r.summary.clean).toBe(false);
    expect(r.summary.exitCode).toBe(1);
    // nothing in the file counted: no PASS anywhere for the web workload's T1
    expect(
      result.results.flatMap((w) => w.findings).filter((f) => f.rule === 'T1' && f.kind === 'PASS'),
    ).toEqual([]);
  });

  it('with no preStop, a file over the limit leaves T2 UNRESOLVED, never FAIL: "no drain found" needs the whole source read', () => {
    const big = `${HEAD}${'a;\n'.repeat(MAX_SOURCE_NODES / 2)}`;
    const { result } = report({ 'src/server.ts': big, 'k8s/web.yaml': webManifest() });
    expect(ruleOf(result, 'T2').kind).toBe('UNRESOLVED');
  });

  it('a file under the limit is read in full (the limit is on syntax nodes, not bytes)', () => {
    const ok = `${HEAD}${'a;\n'.repeat(MAX_SOURCE_NODES / 2 - 100)}`;
    const { result, report: r } = report({ 'src/server.ts': ok });
    expect(listed(r).filter((l) => l.startsWith('src/server.ts'))).toEqual([]);
    expect(t1Of(result).kind).not.toBe('UNRESOLVED');
  });

  it('a file under the limit by bytes but over it by nodes is still too large (one node per two bytes)', () => {
    const dense = `${HEAD}var a = [${'1,'.repeat(MAX_SOURCE_NODES)}];\n`;
    const { report: r } = report({ 'src/server.ts': dense });
    expect(listed(r)).toContain('src/server.ts|source-too-large');
  });

  it('an imported file over the limit makes the search incomplete, so no absence claim is made', () => {
    const files = {
      'src/server.ts': `import './big.js';\n${HEAD.replace('server.keepAliveTimeout = 65000;\n', '')}`,
      'src/big.js': 'a;\n'.repeat(MAX_SOURCE_NODES / 2 + 1),
    };
    const { result, report: r } = report(files);
    expect(listed(r)).toContain('src/big.js|source-too-large');
    expect(t1Of(result).kind).toBe('UNRESOLVED');
    expect(r.summary.clean).toBe(false);
  });
});

describe('a source that does not parse', () => {
  it('is listed with its first error line and T1 says the source could not be parsed', () => {
    const { result, report: r } = report({
      'src/server.ts': `${HEAD}\n}}} @@@ let = = ;\nfunction (((\n`,
    });
    const entry = listed(r).find((l) => l.startsWith('src/server.ts|'));
    expect(entry).toMatch(/^src\/server\.ts\|source-parse-error@\d+$/);
    const t1 = t1Of(result);
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('the source could not be parsed');
    expect(t1.headline).not.toContain('no server construction');
    expect(r.summary.clean).toBe(false);
  });
});

describe('what the person is told about a source that could not be read', () => {
  it('a syntax error: the human line carries the line, and the hint is to fix it, not to link an entry file', () => {
    const { result, report: r } = report({ 'src/server.ts': `${HEAD}\nfunction (((\n` });
    expect(renderHuman(r).replace(/\s+/g, ' ')).toMatch(
      /could not parse "src\/server\.ts": syntax error in a source file at line \d+/,
    );
    const declare = (t1Of(result).declare ?? []).join(' ');
    expect(declare).toContain('fix the syntax error');
    expect(declare).not.toContain('link an entry file');
  });

  it('too large: the hint is to split the file, not to link an entry file', () => {
    const { result } = report({ 'src/server.ts': `${HEAD}${'a;\n'.repeat(MAX_SOURCE_NODES / 2)}` });
    const declare = (t1Of(result).declare ?? []).join(' ');
    expect(declare).toContain('split the file');
    expect(declare).not.toContain('link an entry file');
  });
});

describe('4.8 MB sources finish and say what they could not read', () => {
  const MB48 = 4_800_000;
  const shapes: Record<string, [string, string]> = {
    'statements in a .ts file': ['src/server.ts', 'var a = 1;\n'.repeat(Math.floor(MB48 / 11))],
    'statements in a .js file': ['src/server.js', 'var a = 1;\n'.repeat(Math.floor(MB48 / 11))],
    'an array literal in a .ts file': ['src/server.ts', `var a = [${'1,'.repeat(MB48 / 2)}];\n`],
  };
  for (const [what, [path, body]] of Object.entries(shapes)) {
    it(what, () => {
      const { result, report: r } = report({
        // the demo's web workload runs `node src/server.ts`; for the .js shape it runs the .js file instead
        'k8s/web.yaml': webManifest({ command: `["node", "${path}"]` }),
        [path]: `${HEAD}${body}`,
      });
      expect(listed(r)).toContain(`${path}|source-too-large`);
      expect(t1Of(result).kind).toBe('UNRESOLVED');
      expect(t1Of(result).headline).toContain('source too large to read safely');
      expect(r.summary.clean).toBe(false);
    }, 120_000);
  }
});
