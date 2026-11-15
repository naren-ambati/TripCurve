// A throw-away copy of a fixture directory, with files added or replaced, for the waiver goldens.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { makeTree, type Tree } from './tmp-tree.js';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** `overlay` maps a path to its new text; `null` is not allowed, the overlay only adds or replaces. */
export function fixtureTree(dir: string, overlay: Readonly<Record<string, string>> = {}): Tree {
  const tree = makeTree();
  cpSync(join(FIXTURES, dir), tree.root, { recursive: true });
  for (const [path, text] of Object.entries(overlay)) tree.write(path, text);
  return tree;
}

/** Inserts `line` after the first line of `text` that equals `after` (one place, so a line number is fixed). */
export function insertAfter(text: string, after: string, line: string): string {
  const lines = text.split('\n');
  const at = lines.indexOf(after);
  if (at < 0) throw new Error(`no line ${JSON.stringify(after)} to insert after`);
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
}
