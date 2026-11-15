// A closed pipe is a normal condition (`| head`, `| cmp - file`, a closed terminal): no trace, no message.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MAIN } from '../support/e2e.js';

interface Outcome {
  readonly stderr: string;
  readonly code: number | null;
}

/** Runs the built command, lets `reader` decide what to do with the stdout pipe, and collects the end. */
function run(
  args: readonly string[],
  reader: (child: ReturnType<typeof spawn>) => void,
  startDelayMs = 0,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the command did not end'));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stderr, code });
    });
    setTimeout(() => reader(child), startDelayMs);
  });
}

const expectQuiet = (o: Outcome): void => {
  expect(o.stderr).not.toMatch(/Error/);
  expect(o.stderr).not.toMatch(/^\s+at /m);
  expect(o.stderr).not.toMatch(/EPIPE|ENOTCONN/);
  expect(o.stderr).toBe('');
  expect([0, 1, 2, 3]).toContain(o.code);
};

describe('a reader that closes the pipe early', () => {
  for (const format of ['human', 'json', 'sarif']) {
    it(`${format}: closed after the first bytes, no trace and a computed exit code`, async () => {
      const o = await run(['demo', '--format', format], (child) => {
        child.stdout?.once('data', () => child.stdout?.destroy());
      });
      expectQuiet(o);
    });
    it(`${format}: closed before anything is read (the reader is already gone)`, async () => {
      const o = await run(['demo', '--format', format], (child) => child.stdout?.destroy());
      expectQuiet(o);
    });
    it(`${format}: a reader that never reads and then closes`, async () => {
      const o = await run(
        ['demo', '--format', format],
        (child) => {
          child.stdout?.pause();
          setTimeout(() => child.stdout?.destroy(), 300);
        },
        0,
      );
      expectQuiet(o);
    });
  }
  it('keeps the computed exit code (the demo fails, so 1)', async () => {
    const o = await run(['demo'], (child) => child.stdout?.destroy(), 300);
    expect(o.code).toBe(1);
    expect(o.stderr).toBe('');
  });
});
