// Which stream errors mean "the reader of our output is gone" (a normal condition: `| head`, `| cmp - file`,
// a closed terminal). Everything else is a real error and is rethrown by the caller.
//
// EPIPE: a write to a pipe whose reader closed (POSIX; seen on macOS and Linux, B24).
// ENOTCONN: seen once as `Error: write ENOTCONN` from a write to a stdout whose reader had closed, in the
// hosted macOS run of 2026-11-15 (run 43686256521, B27; docs/evidence/gh-macos-enotconn.txt). Why that
// write reported ENOTCONN rather than EPIPE is not established. Not included: codes never observed here;
// they keep the trace so they can be reported.
export const CLOSED_READER_CODES: readonly string[] = ['EPIPE', 'ENOTCONN'];

export function isClosedReaderCode(code: unknown): boolean {
  return typeof code === 'string' && CLOSED_READER_CODES.includes(code);
}
