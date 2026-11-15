#!/usr/bin/env node
// The `tripcurve` command. The Node version is checked before the rest of tripcurve
// is loaded, so an unsupported Node prints one fixed message and exits 2 having
// read nothing.

import { nodeIsSupported, unsupportedNodeMessage } from './node-check.js';

if (!nodeIsSupported(process.versions.node)) {
  process.stderr.write(unsupportedNodeMessage(process.versions.node));
  process.exitCode = 2;
} else {
  const { runCli } = await import('./app.js');
  process.exitCode = runCli(
    process.argv.slice(2),
    {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
      stdoutIsTty: process.stdout.isTTY === true,
    },
    process.env,
  );
}
