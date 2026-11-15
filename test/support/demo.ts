// The demo repository (bolt B10): where it lives, and the documented fix applied to a copy of it.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeTree, type Tree } from './tmp-tree.js';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');
export const DEMO = join(REPO_ROOT, 'demo');
export const DEMO_FIXED = join(REPO_ROOT, 'demo-fixed');
export const FIRST_RUN = join(DEMO, 'expected', 'first-run.txt');
export const AFTER_FIX = join(DEMO, 'expected', 'after-fix.txt');

/** The part of `demo/` that is the repository itself: no expected output, no walkthrough. */
const NOT_THE_REPOSITORY = new Set(['expected', 'README.md']);

/** A throw-away copy of `demo/` with only the files tripcurve is meant to check. */
export function copyOfDemo(): Tree {
  const tree = makeTree('tripcurve-demo-');
  cpSync(DEMO, tree.root, {
    recursive: true,
    filter: (src) => !NOT_THE_REPOSITORY.has(relative(DEMO, src)),
  });
  return tree;
}

/** Replaces `from` with `to` in a file text, and throws unless `from` occurs exactly once. */
export function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) {
    throw new Error(`expected exactly one ${JSON.stringify(from)}`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** The three documented steps, each as one edit of one file of `demo/` (the README walks through the same four). */
export const FIX_EDITS: ReadonlyArray<{
  readonly step: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
}> = [
  {
    step: '1: Node keepAliveTimeout',
    file: 'src/server.ts',
    from: "// (no keep-alive setting here: Node's default applies)",
    to: 'server.keepAliveTimeout = 65_000;',
  },
  {
    step: '2: gunicorn --keep-alive 75',
    file: 'k8s/api.yaml',
    from: '"-w", "4"]',
    to: '"-w", "4", "--keep-alive", "75"]',
  },
  {
    step: '2: preStop sleep 10 on api',
    file: 'k8s/api.yaml',
    from: '              containerPort: 8000\n',
    to: [
      '              containerPort: 8000',
      '          lifecycle:',
      '            preStop:',
      '              exec:',
      '                command: ["sleep", "10"]',
      '',
    ].join('\n'),
  },
  {
    step: '2: visibility 190',
    file: 'infra/queue.tf',
    from: 'visibility_timeout_seconds = 60',
    to: 'visibility_timeout_seconds = 190',
  },
];

/** The declarations of step 3: `longest_request_s: 5` for `api` (line 4) and `web` (line 7). */
export const TRIPCURVE_YAML = [
  'version: 1',
  'workloads:',
  '  - name: api',
  '    longest_request_s: 5',
  '  - name: web',
  '    # the slowest web request is declared the same way',
  '    longest_request_s: 5',
  '',
].join('\n');

/** Applies steps 1 and 2 (the three code fixes) to a tree made by `copyOfDemo`. */
export function applyFixEdits(tree: Tree): void {
  for (const edit of FIX_EDITS) {
    const path = join(tree.root, edit.file);
    tree.write(edit.file, replaceOnce(readFileSync(path, 'utf8'), edit.from, edit.to));
  }
}

/** Every file under `dir` (relative path, sorted), as `[path, bytes]`; used to compare two trees exactly. */
export function treeContents(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([relative(dir, full), readFileSync(full, 'utf8')]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
