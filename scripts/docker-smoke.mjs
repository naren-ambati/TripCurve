// Smoke test of the tripcurve container image, run locally and by .github/workflows/release.yml before a push:
//   node scripts/docker-smoke.mjs <image>
// Every run has no network (--network none) and mounts the fixture read-only at /repo. Checks: the version is the
// package's; the process runs as the unprivileged `node` user; demo exits 1 and demo-fixed 0; an empty directory
// exits 2; --format sarif on demo is SARIF 2.1.0. Exit 0 when every check passes, 1 with each failure named;
// nothing is pushed or pulled here.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const image = process.argv[2];
if (!image) {
  console.error('usage: node scripts/docker-smoke.mjs <image>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function run(repoDir, args, extra = []) {
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--network', 'none', '-v', `${repoDir}:/repo:ro`, ...extra, image, ...args],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (r.error) throw r.error;
  return r;
}
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
};

// mkdtemp makes a 0700 directory owned by this user; the container runs as `node` (uid 1000), and on a Linux
// host a bind mount keeps the host's owner and mode, so the directory must be readable by others.
const empty = mkdtempSync(join(tmpdir(), 'tripcurve-smoke-'));
chmodSync(empty, 0o755);
try {
  const v = run(empty, ['--version']);
  check(
    '--version prints the package version',
    v.stdout.trim() === pkg.version && v.status === 0,
    `${v.stdout.trim()} (exit ${v.status})`,
  );

  const id = run(empty, ['-u'], ['--entrypoint', 'id']);
  check('runs as an unprivileged user', id.stdout.trim() !== '0' && id.status === 0, `uid ${id.stdout.trim()}`);

  const demo = run(join(root, 'demo'), ['/repo']);
  check('demo exits 1 (not clean)', demo.status === 1, `exit ${demo.status}; stderr: ${demo.stderr.slice(0, 200)}`);
  check(
    'demo names the T1 failure of web',
    /FAIL T1/.test(demo.stdout) && /"web"/.test(demo.stdout),
    demo.stdout.slice(0, 300),
  );

  const fixed = run(join(root, 'demo-fixed'), ['/repo']);
  check('demo-fixed exits 0', fixed.status === 0, `exit ${fixed.status}; stderr: ${fixed.stderr.slice(0, 200)}`);

  const nothing = run(empty, ['/repo']);
  check(
    'an empty directory exits 2 and reports 0 files read',
    nothing.status === 2 && /0 files read/.test(nothing.stdout + nothing.stderr),
    `exit ${nothing.status}; output: ${(nothing.stdout + nothing.stderr).slice(0, 200)}`,
  );

  const sarif = run(join(root, 'demo'), ['/repo', '--format', 'sarif']);
  let version = '';
  try {
    version = JSON.parse(sarif.stdout).version;
  } catch (e) {
    version = `unparsable: ${e.message}`;
  }
  check(
    '--format sarif on demo is SARIF 2.1.0 and exits 1',
    version === '2.1.0' && sarif.status === 1,
    `version ${version}, exit ${sarif.status}`,
  );
} finally {
  rmSync(empty, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length} of ${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
