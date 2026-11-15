// A preload for the closed-reader tests (B27): `node --import <this file> dist/cli/main.js ...`.
// The first write to standard output is turned into an 'error' event on the stream with the code named by
// FAIL_WRITE_CODE (ENOTCONN, EPIPE, EACCES, ...), the way Node reports a failed write, so the command's
// stream-error handling can be exercised with any code, deterministically. Nothing is written to stdout.
const code = process.env.FAIL_WRITE_CODE ?? 'EPIPE';
process.stdout.write = () => {
  const error = new Error(`write ${code}`);
  error.code = code;
  error.syscall = 'write';
  process.nextTick(() => process.stdout.emit('error', error));
  return false;
};
