// B27: the stream-error handler of the built command, exercised deterministically. A preload turns the first
// write to standard output into an 'error' event with a chosen code (test/support/fail-write.mjs), the way Node
// reports a failed write. The e2e closed-pipe test cannot choose the code the OS reports; this one can.
// Before B27 the handler treated EPIPE alone as a gone reader, so ENOTCONN printed a trace and exited 1.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';

const PRELOAD = join(import.meta.dirname, '..', 'support', 'fail-write.mjs');
const run = (code: string) =>
  runBuilt(['demo-fixed'], { nodeArgs: ['--import', PRELOAD], env: { FAIL_WRITE_CODE: code } });

describe('a write that fails because the reader is gone', () => {
  for (const code of ['EPIPE', 'ENOTCONN']) {
    it(`${code}: no trace, no message, and the exit code the run computed (0 for demo-fixed)`, () => {
      const r = run(code);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('');
      expect(r.status).toBe(0);
    });
  }
});

describe('a write that fails for another reason keeps its trace', () => {
  for (const code of ['EACCES', 'ENOSPC']) {
    it(`${code}: the error is rethrown, named in stderr with a stack, and the exit is not the computed 0`, () => {
      const r = run(code);
      expect(r.stderr).toMatch(new RegExp(`write ${code}`));
      expect(r.stderr).toMatch(/^\s+at /m);
      expect(r.status).not.toBe(0);
    });
  }
});
