// B27: the codes that mean the reader of our output is gone. ENOTCONN was first seen in the hosted macOS run
// of 2026-11-15 (run 43686256521): B24 handled EPIPE only, so the closed-pipe test printed a trace there.
import { describe, expect, it } from 'vitest';
import { CLOSED_READER_CODES, isClosedReaderCode } from '../../src/cli/closed-reader.js';

describe('isClosedReaderCode', () => {
  it('EPIPE (a closed pipe) and ENOTCONN (seen once, hosted macOS) mean the reader is gone', () => {
    expect(isClosedReaderCode('EPIPE')).toBe(true);
    expect(isClosedReaderCode('ENOTCONN')).toBe(true);
  });
  it('any other error keeps its trace: EACCES, ENOSPC, EIO, an unknown code, or no code at all', () => {
    for (const code of [
      'EACCES',
      'ENOSPC',
      'EIO',
      'ECONNRESET',
      'epipe',
      '',
      undefined,
      null,
      32,
    ]) {
      expect(isClosedReaderCode(code), String(code)).toBe(false);
    }
  });
  it('the list is exactly the two observed codes, so a new one has to be added here with its evidence', () => {
    expect([...CLOSED_READER_CODES].sort()).toEqual(['ENOTCONN', 'EPIPE']);
  });
});
