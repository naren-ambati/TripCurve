// Builds the CLI once per test run into `.cache/e2e-build` (git-ignored), so the golden
// and end-to-end tests run the compiled command through a child process, the same way
// a person runs `node dist/cli/main.js`. The shipped `dist/` is not touched.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

export default function setup(): void {
  const out = join(ROOT, '.cache', 'e2e-build');
  rmSync(out, { recursive: true, force: true });
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.build.json', '--outDir', out],
    { cwd: ROOT, stdio: 'inherit' },
  );
}
