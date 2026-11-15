// Walking the root with confinement.
//
// The one symlink rule (documented in docs/limits.md and the area 2 report):
// a directory is never entered through a symlink. A real directory is walked
// where it really is, so nothing is read twice and a loop cannot form.
//   - a symlink to a directory outside the root: not read, reported outside-root;
//   - a symlink to the directory it sits in or to one of that directory's
//     ancestors (a cycle): reported symlink-loop;
//   - a symlink to any other directory inside the root: ignored (the real
//     directory is walked in its own place);
//   - a symlink to a file inside the root: that file is a candidate under its
//     real name (two spellings of one file are one file);
//   - a symlink to a file outside the root: not read, reported outside-root
//     when its name is one tripcurve could read;
//   - a chain that never ends (ELOOP): reported symlink-loop.
// Directories named `.git`, `node_modules` and `.terraform` are never entered.

import { type Dirent, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { couldBeRelevant, SKIPPED_DIRECTORIES } from './classify.js';
import type { UncheckedReason } from './types.js';

export interface Candidate {
  /** The real path of the file (no symlink in it). */
  readonly real: string;
  /** Relative to the root, '/' separators. */
  readonly rel: string;
}

export interface WalkUnchecked {
  readonly rel: string;
  readonly reasonCode: UncheckedReason;
}

export interface WalkResult {
  readonly candidates: readonly Candidate[];
  readonly unchecked: readonly WalkUnchecked[];
}

/** UTF-8 byte order, which is code point order (interaction spec rule 3). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function walkRoot(rootReal: string): WalkResult {
  const candidates: Candidate[] = [];
  const unchecked: WalkUnchecked[] = [];
  const visited = new Set<string>();
  const stack: Array<{ real: string; rel: string }> = [{ real: rootReal, rel: '' }];

  const dirKey = (path: string): string => {
    try {
      const st = statSync(path, { bigint: true });
      return st.ino === 0n ? path : `${st.dev}:${st.ino}`;
    } catch {
      return path;
    }
  };
  visited.add(dirKey(rootReal));

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir.real, { withFileTypes: true });
    } catch {
      unchecked.push({ rel: dir.rel === '' ? '.' : dir.rel, reasonCode: 'unreadable' });
      continue;
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));
    const atRoot = dir.rel === '';
    for (const entry of entries) {
      const real = join(dir.real, entry.name);
      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`;
      const relevant = couldBeRelevant(entry.name, atRoot);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        const key = dirKey(real);
        if (visited.has(key)) continue;
        visited.add(key);
        stack.push({ real, rel });
      } else if (entry.isFile()) {
        if (relevant) candidates.push({ real, rel });
      } else if (entry.isSymbolicLink()) {
        followSymlink(real, rel, dir.real, relevant);
      } else if (relevant) {
        // A socket, a pipe or a device: never opened (it could block), reported.
        unchecked.push({ rel, reasonCode: 'unreadable' });
      }
    }
  }

  function followSymlink(
    linkPath: string,
    rel: string,
    containingDir: string,
    relevant: boolean,
  ): void {
    let target: string;
    try {
      target = realpathSync.native(linkPath);
    } catch (error) {
      if (errorCode(error) === 'ELOOP') unchecked.push({ rel, reasonCode: 'symlink-loop' });
      else if (relevant) unchecked.push({ rel, reasonCode: 'unreadable' });
      return;
    }
    let isDirectory: boolean;
    let isFile: boolean;
    try {
      const st = statSync(target);
      isDirectory = st.isDirectory();
      isFile = st.isFile();
    } catch {
      if (relevant) unchecked.push({ rel, reasonCode: 'unreadable' });
      return;
    }
    const inside = isInside(rootReal, target);
    if (isDirectory) {
      if (!inside) {
        unchecked.push({ rel, reasonCode: 'outside-root' });
      } else if (target === containingDir || isInside(target, containingDir)) {
        unchecked.push({ rel, reasonCode: 'symlink-loop' });
      }
      // Any other directory inside the root is walked in its own place.
      return;
    }
    if (!isFile) {
      if (relevant) unchecked.push({ rel, reasonCode: 'unreadable' });
      return;
    }
    const targetName = target.slice(target.lastIndexOf(sep) + 1);
    const targetRel = toPosix(relative(rootReal, target));
    const targetRelevant = couldBeRelevant(targetName, !targetRel.includes('/'));
    if (!relevant && !targetRelevant) return;
    if (!inside) {
      unchecked.push({ rel, reasonCode: 'outside-root' });
      return;
    }
    if (targetRelevant) candidates.push({ real: target, rel: targetRel });
  }

  return { candidates, unchecked };
}
