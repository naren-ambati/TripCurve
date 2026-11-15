// Regression (2026-11-13): `measure/lanes.mjs` called `process.exit()` straight after printing,
// and under heavy load on macOS a `--list` read through a pipe lost its last 30 lines. The exit
// now waits for each stream's earlier writes; these tests hold writes back and check that it does.
import { describe, expect, it } from 'vitest';
import { exitAfterFlush } from '../../measure/lib/exit-after-flush.mjs';

/** A stream whose writes complete only when `release()` is called, in order. */
function heldStream() {
  const pending: Array<() => void> = [];
  return {
    write(_chunk: string, done: () => void) {
      pending.push(done);
      return false;
    },
    release() {
      for (const done of pending.splice(0)) done();
    },
    get waiting() {
      return pending.length;
    },
  };
}

describe('exitAfterFlush', () => {
  it('does not exit while a stream still holds earlier writes', () => {
    const out = heldStream();
    const err = heldStream();
    const exits: number[] = [];
    exitAfterFlush(3, [out, err], (c) => exits.push(c));
    expect(exits).toEqual([]);
    out.release();
    expect(exits).toEqual([]);
    expect(err.waiting).toBe(1);
    err.release();
    expect(exits).toEqual([3]);
  });

  it('exits once, with the code given, when nothing is held', () => {
    const exits: number[] = [];
    const now = { write: (_c: string, done: () => void) => done() };
    exitAfterFlush(0, [now, now], (c) => exits.push(c));
    expect(exits).toEqual([0]);
  });

  it('the lane runner ends through it, not through a bare process.exit', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'measure', 'lanes.mjs'), 'utf8');
    const lastLine = src.trim().split('\n').at(-1) ?? '';
    expect(lastLine).toBe(
      'exitAfterFlush(code, [process.stdout, process.stderr], (c) => process.exit(c));',
    );
  });
});
