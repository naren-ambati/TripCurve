/** Calls `exit(code)` only after an empty write to each stream, in order, has completed. */
export function exitAfterFlush(
  code: number,
  streams: ReadonlyArray<{ write(chunk: string, done: () => void): unknown }>,
  exit: (code: number) => void,
): void;
