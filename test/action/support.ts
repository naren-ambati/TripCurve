// Helpers for the Action script tests: a temp workspace, a GITHUB_OUTPUT file, stub CLIs, and
// a clean environment for `action/run.sh`.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const RUN_SH = join(ROOT, 'action', 'run.sh');
export const REAL_CLI = join(ROOT, '.cache', 'e2e-build', 'cli', 'main.js');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const CLEAN = join(FIXTURES, 'link', 'web-demo-fixed'); // exit 0
export const FAILING = join(FIXTURES, 'report', 'demo'); // exit 1
export const NOTHING = join(FIXTURES, 'hostile', 'no-files'); // exit 2

export interface Sandbox {
  dir: string;
  workspace: string;
  output: string;
  log: string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'tripcurve-action-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  return {
    dir,
    workspace,
    output,
    log: join(dir, 'argv.log'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A stub CLI. `body` runs after argv is logged; `sarif` is true for the --format sarif run. */
export function stubCli(sb: Sandbox, body: string): string {
  const file = join(sb.dir, 'stub-cli.js');
  writeFileSync(
    file,
    `const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + '\\n');
const sarif = a[a.indexOf('--format') + 1] === 'sarif';
${body}
`,
  );
  return file;
}

export const VALID_SARIF = '{"version":"2.1.0","runs":[{}]}';

export function argvLog(sb: Sandbox): string[][] {
  if (!existsSync(sb.log)) return [];
  return readFileSync(sb.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

export function outputs(sb: Sandbox): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(sb.output, 'utf8').split('\n').filter(Boolean)) {
    const i = line.indexOf('=');
    result[line.slice(0, i)] = line.slice(i + 1);
  }
  return result;
}

export interface Result {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function runScript(
  sb: Sandbox,
  mode: 'check' | 'build',
  env: Record<string, string | undefined>,
  pathDirs: string[] = [dirname(process.execPath), '/usr/bin', '/bin'],
): Result {
  const full: Record<string, string> = {
    PATH: pathDirs.join(':'),
    HOME: sb.dir,
    GITHUB_WORKSPACE: sb.workspace,
    GITHUB_ACTION_PATH: ROOT,
    GITHUB_OUTPUT: sb.output,
    STUB_LOG: sb.log,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete full[k];
    else full[k] = v;
  }
  const r = spawnSync('/bin/bash', [RUN_SH, mode], {
    env: full,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

/** A PATH directory holding only the tools run.sh needs, and no `node`. */
export function pathWithoutNode(sb: Sandbox): string[] {
  const bin = join(sb.dir, 'bin-no-node');
  mkdirSync(bin);
  for (const tool of [
    'tr',
    'cut',
    'grep',
    'mkdir',
    'dirname',
    'basename',
    'mktemp',
    'rm',
    'mv',
    'cat',
  ]) {
    for (const d of ['/usr/bin', '/bin']) {
      if (existsSync(join(d, tool))) {
        symlinkSync(join(d, tool), join(bin, tool));
        break;
      }
    }
  }
  return [bin];
}

/** A PATH directory with a stub `npm` (exit code given) in front of the real tools. */
export function pathWithNpm(sb: Sandbox, exitFor: { ci: number; build: number }): string[] {
  const bin = join(sb.dir, 'bin-npm');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    `#!/bin/sh
echo "$@" >> "$STUB_LOG"
case "$1" in
  ci) exit ${exitFor.ci} ;;
  run) exit ${exitFor.build} ;;
esac
exit 99
`,
  );
  chmodSync(npm, 0o755);
  return [bin, dirname(process.execPath), '/usr/bin', '/bin'];
}

export function copyFixture(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}

/** A PATH directory with a `mv` that always fails, in front of the real tools. */
export function pathWithFailingMv(sb: Sandbox): string[] {
  const bin = join(sb.dir, 'bin-mv');
  mkdirSync(bin);
  const mv = join(bin, 'mv');
  writeFileSync(mv, '#!/bin/sh\nexit 1\n');
  chmodSync(mv, 0o755);
  return [bin, dirname(process.execPath), '/usr/bin', '/bin'];
}

/**
 * Runs `run.sh check` with stdin left OPEN (never written, never closed) and its own bounded timeout,
 * so a script that forgets `< /dev/null` blocks and is killed by the timeout instead of seeing EOF.
 */
export function runScriptOpenStdin(
  sb: Sandbox,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [RUN_SH, 'check'], {
      env: {
        PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        HOME: sb.dir,
        GITHUB_WORKSPACE: sb.workspace,
        GITHUB_ACTION_PATH: ROOT,
        GITHUB_OUTPUT: sb.output,
        STUB_LOG: sb.log,
        ...env,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut });
    });
  });
}
