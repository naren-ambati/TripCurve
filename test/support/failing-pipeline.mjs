// A child-process entry that runs the real built CliApp with a pipeline that throws,
// to prove the exit-3 path through real streams. The message holds text that must
// never reach the output.
import { runCli } from '../../.cache/e2e-build/cli/app.js';

process.exitCode = runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdoutIsTty: false,
  },
  process.env,
  {
    check: () => {
      throw new Error('boom: /etc/passwd secret-input-text');
    },
  },
);
