// Bounded reading of one file. The size is checked on the open
// handle before a byte is read, so a huge file is never loaded; a file that
// changes size while it is read is reported as cut short, never as complete.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { UncheckedReason } from './types.js';

export type ReadOutcome =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly reasonCode: UncheckedReason };

/**
 * Decodes UTF-8 strictly. Bytes that are not valid UTF-8 are `unreadable`; a
 * sequence cut off at the very end is `truncated`. A NUL byte means a binary
 * file: `unreadable`. A UTF-8 byte-order mark is removed. Other control
 * characters are kept as text (SafeText makes them visible when printed).
 */
export function decodeUtf8(bytes: Uint8Array): ReadOutcome {
  if (bytes.includes(0)) return { ok: false, reasonCode: 'unreadable' };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    return { ok: false, reasonCode: 'unreadable' };
  }
  try {
    text += decoder.decode();
  } catch {
    return { ok: false, reasonCode: 'truncated' };
  }
  return { ok: true, text, bytes: bytes.length };
}

export function readBounded(path: string, maxBytes: number): ReadOutcome {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { ok: false, reasonCode: 'unreadable' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reasonCode: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reasonCode: 'over-size' };
    const buffer = Buffer.allocUnsafe(stat.size);
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    if (filled !== stat.size) return { ok: false, reasonCode: 'truncated' };
    // One more byte means the file grew while we read it: what we hold is not the whole file.
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, null) > 0) return { ok: false, reasonCode: 'truncated' };
    return decodeUtf8(buffer);
  } catch {
    return { ok: false, reasonCode: 'unreadable' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing useful to do; the read result stands
    }
  }
}

/** Reads a stream (a file descriptor) up to `maxBytes`; more than that is `over-size`. */
export function readStreamBounded(fd: number, maxBytes: number): ReadOutcome {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(65_536);
  try {
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, chunk, 0, chunk.length, null);
      } catch (error) {
        // A pipe with nothing yet: wait by trying again; any other failure ends the read.
        if ((error as { code?: string }).code === 'EAGAIN') continue;
        if ((error as { code?: string }).code === 'EOF') break;
        return { ok: false, reasonCode: 'unreadable' };
      }
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return { ok: false, reasonCode: 'over-size' };
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
  } catch {
    return { ok: false, reasonCode: 'unreadable' };
  }
  return decodeUtf8(Buffer.concat(chunks, total));
}

/**
 * The first `n` bytes of a file, raw, or undefined when it cannot be opened or is not a regular file. A bounded read
 * for a file that failed the normal read (too large, not UTF-8): its content decides whether it may be a template
 * (bolt B12 review, M2).
 */
export function readHeadBytes(path: string, n: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const got = readSync(fd, buffer, filled, n - filled, null);
      if (got === 0) break;
      filled += got;
    }
    return buffer.subarray(0, filled);
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // the bytes already read stand
    }
  }
}
