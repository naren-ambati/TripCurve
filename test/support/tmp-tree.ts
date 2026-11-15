// A throw-away directory tree for tests that need a real file system.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Tree {
  readonly root: string;
  write(rel: string, content: string | Uint8Array): string;
  cleanup(): void;
}

export function makeTree(prefix = 'tripcurve-test-'): Tree {
  // realpath of the temp dir so macOS /var -> /private/var does not confuse comparisons
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(rel, content) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
