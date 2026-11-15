// B16 (macOS and Linux): a source scan for the code patterns that make a result depend on the host,
// and one behaviour test of the directory walk order. Linux itself cannot be run on the build host
// (darwin-arm64), so this is evidence by reading and scanning, not by running on Linux; the hosted Linux run of
// 2026-11-15 (verify run 43682221175, B25) is the running check.
//
// What it checks, in `src/` only, outside comments:
//   1. no locale-dependent call (`localeCompare`, `toLocale*`, `Intl`), no `process.platform`, no `os` module in
//      any import form (`node:os`, `os`, `require('os')`, `import('os')`), no `win32` path module;
//   2. `process.env` is read only in the files listed in ENV_ALLOWED, each with its reason;
//   3. a host path function (anything imported from `node:path` or `path` other than `posix`) appears only in the
//      files listed in HOST_PATH_ALLOWED, each with its reason and its exact import line, so adding one anywhere
//      else, or one more name in those files, fails until a person reads it;
//   4. the walk lists a directory in UTF-8 byte order, shown with file names whose byte order and locale order differ.
// What it does NOT check: that the allowed files use their host path functions correctly (they were read in
// B16, `docs/release-checklist.md`, "Platform audit"), file system case behaviour, or anything about Windows.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkRoot } from '../../src/parse/intake/walk.js';
import { makeTree } from '../support/tmp-tree.js';

const ROOT = join(import.meta.dirname, '..', '..');

/** Files that may read `process.env`, and why. */
const ENV_ALLOWED: Record<string, string> = {
  'src/cli/main.ts':
    'passes the process environment to runCli, which reads only NO_COLOR (src/cli/app.ts); the library takes env as a parameter',
};

/** Files that may import host `path` functions, with the exact import line and why. */
const HOST_PATH_ALLOWED: Record<string, { line: string; reason: string }> = {
  'src/parse/intake/walk.ts': {
    line: "import { isAbsolute, join, relative, sep } from 'node:path';",
    reason:
      'converts host file system paths to `/` paths (toPosix) and tests containment (isInside); the only place that uses `sep`',
  },
  'src/parse/intake/intake.ts': {
    line: "import { basename, dirname, isAbsolute, join, relative } from 'node:path';",
    reason:
      'resolves host paths for reading (join with the root, relative, dirname of a root file); every path that leaves intake goes through toPosix',
  },
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/**
 * The lines of a TypeScript text that are code: a line that starts with `//`, or that is inside a `/* ... *\/` block
 * (it starts with `/*` or follows one that has not closed), is skipped; a line that merely starts with `*` is code
 * (a continued multiplication or a spread) and is scanned.
 */
function codeLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

const HOST_DEPENDENT = new RegExp(
  [
    '\\blocaleCompare\\b',
    '\\btoLocale\\w*\\(',
    '\\bIntl\\b',
    '\\bprocess\\.platform\\b',
    '\\bos\\.platform\\b',
    // the os module in every import form, with or without the `node:` prefix
    '(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)[\'"](?:node:)?os[\'"]',
    '\\bpath\\.win32\\b',
    '\\bwin32\\b',
  ].join('|'),
);
const PROCESS_ENV = /\bprocess\.env\b/;
const PATH_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?path(?:\/posix)?['"]/;

const hits = (text: string, pattern: RegExp): string[] =>
  codeLines(text).filter((l) => pattern.test(l));

describe('nothing in src/ depends on the host', () => {
  const files = sources('src');
  const text = (f: string) => readFileSync(join(ROOT, f), 'utf8');

  it('there are files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no locale-dependent call, process.platform, os module (any form) or Windows path module', () => {
    const found = files.flatMap((f) =>
      hits(text(f), HOST_DEPENDENT).map((l) => `${f}: ${l.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it('process.env is read only in the allowed files', () => {
    const found = files
      .filter((f) => !(f in ENV_ALLOWED))
      .flatMap((f) => hits(text(f), PROCESS_ENV).map((l) => `${f}: ${l.trim()}`));
    expect(found).toEqual([]);
    for (const f of Object.keys(ENV_ALLOWED)) {
      expect(
        hits(text(f), PROCESS_ENV).length,
        `${f} no longer reads process.env: drop it from ENV_ALLOWED`,
      ).toBeGreaterThan(0);
    }
  });

  it('host path functions are imported only in the allowed files, with exactly the listed names', () => {
    const found = files
      .filter((f) => !(f in HOST_PATH_ALLOWED))
      .flatMap((f) =>
        hits(text(f), PATH_IMPORT)
          .filter((l) => !/import\s*\{\s*posix\s*\}\s*from\s*['"]node:path['"];?\s*$/.test(l))
          .map((l) => `${f}: ${l.trim()}`),
      );
    expect(found).toEqual([]);
    for (const [f, { line }] of Object.entries(HOST_PATH_ALLOWED)) {
      expect(
        hits(text(f), PATH_IMPORT).map((l) => l.trim()),
        f,
      ).toEqual([line]);
    }
  });

  it('every allow-list entry has a stated reason', () => {
    for (const v of Object.values(ENV_ALLOWED)) expect(v.length).toBeGreaterThan(20);
    for (const v of Object.values(HOST_PATH_ALLOWED)) expect(v.reason.length).toBeGreaterThan(20);
  });

  it('can fail: planted lines are found', () => {
    expect(hits('a.localeCompare(b)', HOST_DEPENDENT)).toHaveLength(1);
    expect(hits("if (process.platform === 'darwin') {", HOST_DEPENDENT)).toHaveLength(1);
    for (const os of [
      "import { platform } from 'node:os';",
      "import { platform } from 'os';",
      "const os = require('os');",
      "const os = require('node:os');",
      "const os = await import('os');",
    ]) {
      expect(hits(os, HOST_DEPENDENT), os).toHaveLength(1);
    }
    expect(hits('const e = process.env.HOME;', PROCESS_ENV)).toHaveLength(1);
    for (const p of [
      "import { join } from 'node:path';",
      "import { join } from 'path';",
      "import * as path from 'node:path';",
      "const { resolve } = require('path');",
    ]) {
      expect(hits(p, PATH_IMPORT), p).toHaveLength(1);
    }
  });

  it('can fail: a continuation line that starts with * is code and is scanned; real comments are not', () => {
    expect(hits('const x = a\n  * b.localeCompare(c);', HOST_DEPENDENT)).toHaveLength(1);
    expect(hits('// a.localeCompare(b) was replaced', HOST_DEPENDENT)).toEqual([]);
    expect(hits('/* a.localeCompare(b) */', HOST_DEPENDENT)).toEqual([]);
    expect(hits('/**\n * a.localeCompare(b)\n * more\n */\nconst ok = 1;', HOST_DEPENDENT)).toEqual(
      [],
    );
    expect(hits('/**\n * text\n */\na.localeCompare(b);', HOST_DEPENDENT)).toHaveLength(1);
  });
});

describe('the walk lists a directory in UTF-8 byte order, not locale order', () => {
  // Byte order puts every capital before every lower-case letter and puts an accented letter after `z`;
  // locale order (en) puts `a` before `B` and `é` between `e` and `f`. The names differ in the two orders.
  const NAMES = ['z.yaml', 'a.yaml', 'B.yaml', 'é.yaml', 'e.yaml', 'f.yaml'];
  const byteOrder = [...NAMES].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  const localeOrder = [...NAMES].sort((x, y) => x.localeCompare(y, 'en'));

  it('the planted names really sort differently by bytes and by locale', () => {
    expect(byteOrder).not.toEqual(localeOrder);
    expect(byteOrder.indexOf('B.yaml')).toBeLessThan(byteOrder.indexOf('a.yaml'));
    expect(localeOrder.indexOf('a.yaml')).toBeLessThan(localeOrder.indexOf('B.yaml'));
    expect(byteOrder.indexOf('z.yaml')).toBeLessThan(byteOrder.indexOf('é.yaml'));
  });

  it('walkRoot returns the files in byte order, in the root and in a sub-folder', () => {
    const tree = makeTree('tripcurve-order-');
    try {
      for (const n of NAMES) writeFileSync(join(tree.root, n), 'a: 1\n');
      mkdirSync(join(tree.root, 'sub'));
      for (const n of NAMES) writeFileSync(join(tree.root, 'sub', n), 'a: 1\n');
      const rels = walkRoot(tree.root).candidates.map((c) => c.rel);
      expect(rels.filter((r) => !r.includes('/'))).toEqual(byteOrder);
      expect(rels.filter((r) => r.startsWith('sub/'))).toEqual(byteOrder.map((n) => `sub/${n}`));
    } finally {
      tree.cleanup();
    }
  });
});
