// The local dry run of the Action's steps (B9 expected demo): build step with a stubbed `npm ci`,
// then the check step, against fixture repos. The exit status is the Action step's.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLEAN, FAILING, ROOT } from './support.js';

const DRY_RUN = join(ROOT, 'action', 'dry-run.sh');

// The build step runs a real `npm run build` (no network) in a scratch copy of the Action checkout
// (sources, build config and the script; node_modules linked, nothing installed), so this repository's
// dist/ is not emptied under tests that read it. The timeout is only a hang guard.
const HANG_GUARD_MS = 180_000;
let actionCopy = '';
const run = (fixture: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', [DRY_RUN, fixture], {
    encoding: 'utf8',
    timeout: 170_000,
    env: { ...process.env, DRY_RUN_ACTION_PATH: actionCopy, ...env },
  });

beforeAll(() => {
  actionCopy = mkdtempSync(join(tmpdir(), 'tripcurve-action-copy-'));
  for (const f of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'action']) {
    cpSync(join(ROOT, f), join(actionCopy, f), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(actionCopy, 'node_modules'), 'dir');
});
afterAll(() => {
  if (actionCopy) rmSync(actionCopy, { recursive: true, force: true });
});

describe('action/dry-run.sh', () => {
  // B25 regression: the dry run's build step used to run `npm run build` in this repository, which empties
  // `dist/` first. `test/docs/package-shrinkwrap.test.ts` runs `npm pack --dry-run` on the same tree in parallel
  // and failed with ENOENT on a half-rebuilt dist/ (seen 2026-11-15). The dry run must leave this checkout alone.
  // On a fresh checkout dist/ does not exist while the tests run (verify builds after the tests); there the
  // check is that the dry run does not create it. Where an earlier build left it, the file must be the same one.
  it(
    "does not rebuild this repository's dist/",
    () => {
      const main = join(ROOT, 'dist', 'cli', 'main.js');
      const identity = () =>
        existsSync(main) ? [statSync(main).ino, statSync(main).mtimeMs] : 'absent';
      const before = identity();
      const r = run(CLEAN);
      expect(r.status).toBe(0);
      expect(identity()).toEqual(before);
    },
    HANG_GUARD_MS,
  );

  it(
    'a failing fixture: exit 1, outputs exit-code=1, a SARIF file, nothing downloaded',
    () => {
      const r = run(FAILING);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('npm ci --ignore-scripts (stubbed: nothing downloaded)');
      expect(r.stdout).toContain('exit-code=1');
      expect(r.stdout).toContain('sarif-file=tripcurve.sarif');
      expect(r.stdout).toContain('tripcurve.sarif: version 2.1.0');
      expect(r.stdout).toContain('upload-sarif is not "true": the upload step is skipped');
    },
    HANG_GUARD_MS,
  );

  it(
    'a clean fixture: exit 0 and exit-code=0',
    () => {
      const r = run(CLEAN);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('exit-code=0');
      expect(r.stdout).toContain('All checks passed');
    },
    HANG_GUARD_MS,
  );

  // B19: the three jobs of .github/workflows/action-selftest.yml, on the repository's own demo
  // directories. The upload itself is an external write and is never simulated.
  describe('the action-selftest jobs, simulated', () => {
    const DEMO = join(ROOT, 'demo');
    const DEMO_FIXED = join(ROOT, 'demo-fixed');

    it(
      '(a) clean: demo-fixed exits 0, exit-code=0, a SARIF file, no upload',
      () => {
        const r = run(DEMO_FIXED);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('exit-code=0');
        expect(r.stdout).toContain('sarif-file=tripcurve.sarif');
        expect(r.stdout).toContain('tripcurve.sarif: version 2.1.0');
        expect(r.stdout).toContain('upload-sarif is not "true": the upload step is skipped');
      },
      HANG_GUARD_MS,
    );

    it(
      '(b) failing: demo exits 1, exit-code=1, a SARIF file is still written, no upload',
      () => {
        const r = run(DEMO);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('exit-code=1');
        expect(r.stdout).toContain('tripcurve.sarif: version 2.1.0');
        expect(r.stdout).toContain('upload-sarif is not "true": the upload step is skipped');
      },
      HANG_GUARD_MS,
    );

    it(
      '(c) upload: demo with upload-sarif true still exits 1 and says the upload would run, and was not run',
      () => {
        const r = run(DEMO, { DRY_RUN_UPLOAD_SARIF: 'true' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('exit-code=1');
        expect(r.stdout).toContain(
          'upload-sarif is "true" and a SARIF file was written: the upload step would run here. NOT SIMULATED',
        );
        expect(r.stdout).not.toContain('the upload step is skipped');
      },
      HANG_GUARD_MS,
    );

    it(
      '(c) upload requested but no SARIF file written: the upload step is skipped, and says why',
      () => {
        // A directory that cannot be checked at all (missing) is a usage failure before any SARIF file.
        const r = run(DEMO, {
          DRY_RUN_UPLOAD_SARIF: 'true',
          DRY_RUN_SARIF_FILE: '../escape.sarif',
        });
        expect(r.status).toBe(2);
        expect(r.stdout).toContain('no SARIF file was written: the upload step is skipped');
        expect(r.stdout).not.toContain('would run here');
      },
      HANG_GUARD_MS,
    );

    it(
      'any value but the exact string "true" does not request the upload',
      () => {
        const r = run(DEMO_FIXED, { DRY_RUN_UPLOAD_SARIF: 'TRUE' });
        expect(r.stdout).toContain('upload-sarif is not "true": the upload step is skipped');
      },
      HANG_GUARD_MS,
    );
  });
});
