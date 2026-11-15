// Bolt B20: the publication leak guard. Every tracked file that will be published must stand on its
// own: no design-process files, no personal paths or names, no token-shaped strings. The unpublished
// set stays local; the local export script (not published) applies the same patterns to the export.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from '../support/docs-check.js';

/** The strings are written in two halves so that this file does not match its own scan (and the local export script's). */
const j = (...parts: string[]): string => parts.join('');
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Paths that stay local only and are never exported. */
const UNPUBLISHED = [
  j('ai', 'dlc/'),
  j('.cla', 'ude/'),
  j('ai', 'dlc-inputs/'),
  j('CLA', 'UDE.md'),
  j('START', '-HERE.md'),
  'tools-local/',
  '.gitignore',
];

/** The text each pattern looks for; matched case-sensitively unless `ci` is set. */
const NEEDLES: ReadonlyArray<{ name: string; text: string; ci?: boolean }> = [
  { name: 'process-folder', text: j('ai', 'dlc'), ci: true },
  { name: 'process-name', text: j('AI-', 'DLC') },
  { name: 'start-file', text: j('START', '-HERE') },
  { name: 'decisions-file', text: j('founder', '-decisions') },
  { name: 'home-path', text: j('/Us', 'ers/') },
  { name: 'tmp-path', text: j('/priv', 'ate/tmp') },
  { name: 'personal-name', text: j('naren', 'chandra') },
  { name: 'host-name', text: j('mac', 'book'), ci: true },
  { name: 'personal-mail-name', text: j('highc', 'endriix') },
  { name: 'mail-domain', text: j('@g', 'mail') },
  { name: 'github-token-ghp', text: j('gh', 'p_') },
  { name: 'github-token-gho', text: j('gh', 'o_') },
  { name: 'github-token-pat', text: j('github', '_pat_') },
  { name: 'aws-key-prefix', text: j('AK', 'IA') },
  { name: 'private-key-header', text: j('-----', 'BEGIN') },
  { name: 'npm-token', text: j('np', 'm_') },
  { name: 'claude-folder-ref', text: j('.cla', 'ude/') },
  { name: 'inputs-folder-ref', text: j('ai', 'dlc-inputs/') },
  { name: 'agent-notes-file-ref', text: j('CLA', 'UDE.md') },
  { name: 'agent-folder-name-ref', text: j('.cla', 'ude') },
];

/**
 * The published files that may contain a needle, each for named needles only. The verbatim extract of the
 * maintainer's project-selection report names the agent-notes file once, as a generic term of that report's
 * own subject (a table row about path rot in such files), not as a file of this project.
 */
const EXEMPT: Readonly<Record<string, readonly string[]>> = {
  'docs/arena-report-extract.md': ['agent-notes-file-ref'],
  // the public ignore file lists the agent folder so that it is never added
  '.gitignore.public': ['claude-folder-ref', 'agent-folder-name-ref'],
};

const LEAK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; text: string }> = NEEDLES.map(
  (n) => ({ name: n.name, text: n.text, re: new RegExp(esc(n.text), n.ci ? 'i' : '') }),
);

const SKIP_DIRS = new Set(['node_modules', '.cache', 'dist', '.git', '.worktrees', 'coverage']);

function walk(dir: string, out: string[], root: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out, root);
    else out.push(relative(root, full));
  }
}

/**
 * The files git knows (tracked, or untracked and not ignored, so a fresh export before `git add` is
 * scanned too), or a directory walk when git is not available or lists nothing.
 */
function candidateFiles(root: string = ROOT): string[] {
  let files: string[] = [];
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    files = [];
  }
  if (files.length === 0) walk(root, files, root);
  files = [...new Set(files)];
  // a folder entry ends with a slash; a file entry matches exactly (so .gitignore.public is scanned)
  return files.filter(
    (f) => !UNPUBLISHED.some((u) => (u.endsWith('/') ? f.startsWith(u) : f === u)),
  );
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Every (file, pattern) hit in the files that would be published. */
function leaks(root: string = ROOT): string[] {
  const hits: string[] = [];
  for (const f of candidateFiles(root)) {
    const full = join(root, f);
    let buf: Buffer;
    try {
      if (!statSync(full).isFile()) continue;
      buf = readFileSync(full);
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    for (const p of LEAK_PATTERNS) {
      if (EXEMPT[f]?.includes(p.name)) continue;
      if (p.re.test(text)) hits.push(`${f}: ${p.name}`);
    }
    for (const p of LEAK_PATTERNS) if (p.re.test(f)) hits.push(`${f}: (file name) ${p.name}`);
  }
  return hits;
}

describe('publication leak guard (B20)', () => {
  it('finds files to scan', () => {
    expect(candidateFiles().length).toBeGreaterThan(100);
  });

  it('the scan can fail: each pattern matches a planted string', () => {
    for (const p of LEAK_PATTERNS) {
      expect(p.re.test(`some text ${p.text} more text`), p.name).toBe(true);
      expect(p.re.test('a harmless sentence about timeouts'), p.name).toBe(false);
    }
  });

  it('no published file mentions a design-process file, a personal path or a secret', () => {
    const hits = leaks();
    expect(hits, `${hits.length} hits:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('publication leak guard: scratch trees (B20 review)', () => {
  const made: string[] = [];
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'tripcurve-pub-'));
    made.push(d);
    return d;
  };
  const put = (root: string, rel: string, text: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const git = (root: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a planted mention of the agent-notes file or folder is reported, in a published file', () => {
    const d = scratch();
    put(d, 'docs/guide.md', `see ${j('CLA', 'UDE.md')} for the rules\n`);
    put(d, 'docs/other.md', `settings live in ${j('.cla', 'ude')}\n`);
    put(d, 'docs/clean.md', 'a harmless sentence about timeouts\n');
    const hits = leaks(d);
    expect(hits).toContain('docs/guide.md: agent-notes-file-ref');
    expect(hits).toContain('docs/other.md: agent-folder-name-ref');
    expect(hits.some((h) => h.startsWith('docs/clean.md'))).toBe(false);
  });

  it('an exemption covers its own file and its own needles only', () => {
    const d = scratch();
    const line = `a report row about ${j('CLA', 'UDE.md')} path rot, and ${j('.cla', 'ude')}\n`;
    put(d, 'docs/arena-report-extract.md', line);
    put(d, 'docs/not-exempt.md', line);
    const hits = leaks(d);
    expect(hits).not.toContain('docs/arena-report-extract.md: agent-notes-file-ref');
    expect(hits).toContain('docs/arena-report-extract.md: agent-folder-name-ref');
    expect(hits).toContain('docs/not-exempt.md: agent-notes-file-ref');
  });

  it('a fresh git init before git add is still scanned (untracked files are listed)', () => {
    const d = scratch();
    git(d, 'init', '-q');
    put(d, 'README.md', 'hello\n');
    put(d, 'docs/a.md', `${j('/Us', 'ers/')}someone\n`);
    expect(candidateFiles(d).sort()).toEqual(['README.md', 'docs/a.md']);
    expect(leaks(d)).toEqual(['docs/a.md: home-path']);
  });

  it('falls back to the directory walk when git lists nothing, or is not used', () => {
    const plain = scratch();
    put(plain, 'x/y.md', 'text\n');
    expect(candidateFiles(plain)).toEqual(['x/y.md']);
    const empty = scratch();
    git(empty, 'init', '-q');
    put(empty, '.gitignore', '*\n');
    put(empty, 'a.md', `${j('naren', 'chandra')}\n`);
    expect(candidateFiles(empty)).toEqual(['a.md']); // .gitignore is in the unpublished set
    expect(leaks(empty)).toEqual(['a.md: personal-name']);
  });
});
