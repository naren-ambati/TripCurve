// Exit only after every earlier write to the given streams has been handed to the OS.
//
// On macOS a write to a pipe can be queued (the pipe holds 16 KiB at first), and `process.exit()`
// drops what is still queued, so a slow reader can get a cut-off report. A lane `--list` of about
// 16.7 KB lost its last 30 lines that way under heavy load (Node 22.12.0, 2026-11-13). Writing an
// empty chunk to each stream in turn and exiting in the last callback waits for the earlier writes,
// because a stream completes writes in order.
export function exitAfterFlush(code, streams, exit) {
  const next = (i) => {
    if (i >= streams.length) {
      exit(code);
      return;
    }
    streams[i].write('', () => next(i + 1));
  };
  next(0);
}
