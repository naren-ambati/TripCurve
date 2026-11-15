// The measurement lanes: run every knowledge-base entry's measurement
// script and compare what it measured with what the entry says.
//
//   node measure/lanes.mjs <pinned|latest> [--jobs=N] [--list] [--full] [--only=<entry id>]
//                          [--raw=<file>] [--cache=<dir>] [--kb=<dir>]
//
// pinned: each script runs against the exact releases the entry cites (already in .cache/).
// latest: the newest release inside each entry range is looked up (read-only), downloaded into
//         .cache/ with its checksum verified, and run; a newer release outside every range fails.
// Every value is compared within the entry's own tolerance; any difference, any script that could
// not measure, any entry nothing ran for, fails the lane. Exit 0 pass, 1 lane failed, 2 usage,
// 4 the lane could not run (a lookup or download failed: never read as "no change").
// Servers are started by the scripts on 127.0.0.1 only; this runner starts no server of its own and
// stops every script it started when it is interrupted. Downloads are GET only and go into .cache/.
// The logic is in lib/lanes-runner.mjs, which takes everything outside as arguments (tested).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitAfterFlush } from './lib/exit-after-flush.mjs';
import { runLane } from './lib/lanes-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, what, env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error((r.error?.message ?? r.stderr ?? what).toString().split('\n').filter(Boolean).slice(-2).join(' | '));
  return r.stdout;
}

const stop = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop.abort();
    setTimeout(() => process.exit(4), 40000).unref();
  });
}

const code = await runLane(process.argv.slice(2), {
  rootDir: ROOT,
  fetch: globalThis.fetch,
  run,
  spawn,
  fs: { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync },
  platform: process.platform,
  arch: process.arch,
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  now: () => new Date(),
  loadavg,
  cores: cpus().length,
  out: (t) => console.log(t),
  err: (t) => console.error(t),
  signal: stop.signal,
});
exitAfterFlush(code, [process.stdout, process.stderr], (c) => process.exit(c));
