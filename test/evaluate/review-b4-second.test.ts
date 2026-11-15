// B4 second review (written first, seen red): the Node "no drain" claim is an absence claim, so it needs an
// allow-list (N1), and the terminus exemption covers only the exact createTerminus(server, ...) call (N2).
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, ruleOf, webManifest } from '../support/analyse.js';

afterEach(cleanupTrees);

const HEAD = [
  "import http from 'node:http';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
  '',
].join('\n');
const t2 = (src: string, extra: Record<string, string> = {}) =>
  ruleOf(analyseFiles({ 'src/server.ts': src, ...extra }).result, 'T2');
const GENERIC =
  'a package is imported whose code may register shutdown handlers; declare drain.in_process_s or add a preStop';
const reasonOf = (f: ReturnType<typeof t2>): string => {
  const s = f.chain.find((c) => c.label === 'drain');
  return s !== undefined && 'reason' in s.value ? s.value.reason : '';
};

describe('N1: only built-ins, local files and type-only imports leave the search complete', () => {
  it.each([
    "import {} from 'dotenv';\n",
    "import pkg from 'pkg';\n",
    "import { a } from 'pkg';\n",
    "export * from 'pkg';\n",
    "export { a } from 'pkg';\n",
    "const x = require('pkg');\n",
    "const m = await import('pkg');\n",
    "import * as ns from '@scope/pkg/sub';\n",
  ])('%s is UNRESOLVED with the fixed reason, never FAIL', (line) => {
    const f = t2(`${HEAD}${line}`);
    expect(f.kind, line).toBe('UNRESOLVED');
    expect(f.headline).toBe('the search for a drain is not complete');
    expect(reasonOf(f)).toBe(GENERIC);
  });

  it.each([
    "import type { X } from 'pkg';\n",
    "export type { X } from 'pkg';\n",
    "import fs from 'node:fs';\n",
    "import path from 'path';\n",
    "const os = require('os');\n",
    "import './init.js';\n",
    "export * from './init.js';\n",
  ])('%s leaves the search complete: FAIL as before', (line) => {
    const f = t2(`${HEAD}${line}`, { 'src/init.js': 'export const a = 1;\n' });
    expect(f.kind, line).toBe('FAIL');
  });

  it('a shutdown library keeps its more specific reason', () => {
    const f = t2(`${HEAD}import x from 'close-with-grace';\n`);
    expect(reasonOf(f)).toBe('a shutdown library is imported whose drain tripcurve does not read');
  });

  it('the demo web (preStop) passes T2 whatever the search found', () => {
    const lifecycle = [
      '          lifecycle:',
      '            preStop:',
      '              exec:',
      '                command: ["sleep", "10"]',
    ].join('\n');
    const f = t2(`${HEAD}import pkg from 'pkg';\n`, { 'k8s/web.yaml': webManifest({ lifecycle }) });
    expect(f.kind).toBe('PASS');
  });

  it('T1 keeps its own allow-list: an unused package import does not change the T1 default', () => {
    const r = analyseFiles({ 'src/server.ts': `${HEAD}import pkg from 'pkg';\n` }).result;
    expect(ruleOf(r, 'T1').kind).toBe('FAIL');
  });

  it('terminus and lightship are read forms: importing them is not a gap by itself', () => {
    const src = `${HEAD}import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 8000)) });\n`;
    expect(t2(src).kind).toBe('PASS');
  });
});

describe('N2: the terminus exemption covers only the exact createTerminus(server, ...) call', () => {
  const T =
    "import { createTerminus } from '@godaddy/terminus';\ncreateTerminus(server, { healthChecks: {} });\n";
  it('the exact call alone: FAIL (nothing else handles the server)', () => {
    expect(t2(`${HEAD}${T}`).kind).toBe('FAIL');
  });
  it.each([
    ['an alias of the server', 'const s2 = server;\n'],
    ['a pass-out through an alias', 'const s2 = server;\nfoo(s2);\nfunction foo(_s) {}\n'],
    ['a pass-out next to createTerminus', 'foo(server);\nfunction foo(_s) {}\n'],
    ['the server in an object', 'const o = { server };\n'],
    ['the server exported', 'export { server };\n'],
    ['the server returned from a function', 'function get() { return server; }\n'],
  ])('%s: UNRESOLVED', (_n, extra) => {
    const f = t2(`${HEAD}${T}${extra}`);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('the search for a drain is not complete');
  });
  it('ordinary use of the server (methods, events, close) is not a pass-out', () => {
    expect(
      t2(`${HEAD}${T}server.on('error', () => {});\nserver.keepAliveTimeout = 5000;\n`).kind,
    ).toBe('FAIL');
  });
});
