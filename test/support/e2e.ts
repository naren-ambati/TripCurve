// Runs the built command through a child process (see global-setup.ts).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
export const BUILD = join(ROOT, '.cache', 'e2e-build');
export const MAIN = join(BUILD, 'cli', 'main.js');

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

export function runBuilt(
  args: readonly string[],
  options: {
    cwd?: string;
    input?: string;
    env?: Record<string, string | undefined>;
    /** Extra `node` arguments, for example `--import`. */
    nodeArgs?: readonly string[];
    script?: string;
  } = {},
): RunResult {
  const result = spawnSync(
    process.execPath,
    [...(options.nodeArgs ?? []), options.script ?? MAIN, ...args],
    {
      cwd: options.cwd ?? ROOT,
      input: options.input ?? '',
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...options.env },
    },
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}
