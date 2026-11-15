// A child-process entry that runs the real built CliApp with an injected UTC date (the date is an
// input; there is no hidden variable or flag). First argument: the date; the rest: the command line.
import { runCli } from '../../.cache/e2e-build/cli/app.js';

const [today, ...args] = process.argv.slice(2);
process.exitCode = runCli(
  args,
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdoutIsTty: false,
  },
  process.env,
  { today },
);
