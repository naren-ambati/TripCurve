#!/usr/bin/env node
// The `tripcurve` command. The Node version is checked before the rest of tripcurve
// is loaded, so an unsupported Node prints one fixed message and exits 2 having
// read nothing.

import { nodeIsSupported, unsupportedNodeMessage } from './node-check.js';

// A closed pipe (`| head`, `| cmp - file`, a closed terminal) is a normal condition. On POSIX a write to
// one fails later, as an 'error' event with code 'EPIPE' on the stream, and Node ignores SIGPIPE. Without a
// listener that event is thrown as a stack trace. Here the writing stops, nothing more is printed, and the
// exit code is the one the run computed (1 when it was not yet known).
let closed = false;
let computedExitCode: number | undefined;
const onStreamError = (error: NodeJS.ErrnoException): void => {
  if (error.code !== 'EPIPE') throw error;
  closed = true;
  process.exitCode = computedExitCode ?? 1;
};
process.stdout.on('error', onStreamError);
process.stderr.on('error', onStreamError);

if (!nodeIsSupported(process.versions.node)) {
  process.stderr.write(unsupportedNodeMessage(process.versions.node));
  process.exitCode = 2;
} else {
  const { runCli } = await import('./app.js');
  computedExitCode = runCli(
    process.argv.slice(2),
    {
      stdout: (text) => {
        if (!closed) process.stdout.write(text);
      },
      stderr: (text) => {
        if (!closed) process.stderr.write(text);
      },
      stdoutIsTty: process.stdout.isTTY === true,
    },
    process.env,
  );
  process.exitCode = computedExitCode;
}
