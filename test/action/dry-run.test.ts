// The local dry run of the Action's steps (B9 expected demo): build step with a stubbed `npm ci`,
// then the check step, against fixture repos. The exit status is the Action step's.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEAN, FAILING, ROOT } from './support.js';

const DRY_RUN = join(ROOT, 'action', 'dry-run.sh');
const run = (fixture: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', [DRY_RUN, fixture], {
    encoding: 'utf8',
    timeout: 170_000,
    env: { ...process.env, ...env },
  });

// The build step runs a real `npm run build` (no network); the timeout is only a hang guard.
const HANG_GUARD_MS = 180_000;

describe('action/dry-run.sh', () => {
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
