// The hosted workflow files, checked as files (B19; first run on GitHub 2026-11-15, B25).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const DIR = join(ROOT, '.github', 'workflows');

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
}
interface Job {
  'runs-on'?: unknown;
  if?: string;
  needs?: unknown;
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown>; 'fail-fast'?: boolean };
  steps: Step[];
}
interface Workflow {
  on: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const FILES = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const raw = (f: string) => readFileSync(join(DIR, f), 'utf8');
const load = (f: string) => parse(raw(f)) as Workflow;
const allSteps = (w: Workflow) => Object.values(w.jobs).flatMap((j) => j.steps);

describe('workflow files: the set', () => {
  it('is exactly verify.yml and action-selftest.yml', () => {
    expect(FILES.sort()).toEqual(['action-selftest.yml', 'verify.yml']);
  });
});

describe.each(FILES)('%s: rules every workflow must follow', (file) => {
  const w = load(file);

  it('has no ${{ }} expression inside any run body', () => {
    const runs = allSteps(w).filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) expect(s.run).not.toContain('${{');
  });

  it('pins every uses: to a full 40-hex SHA with the tag in a comment', () => {
    const lines = raw(file)
      .split('\n')
      .filter((l) => /^\s*(-\s+)?uses:/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (/uses:\s+\.\/\s*$/.test(line)) continue; // the repository's own Action
      expect(line, line).toMatch(/uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d/);
    }
  });

  it('sets workflow-level permissions to contents: read only', () => {
    expect(w.permissions).toEqual({ contents: 'read' });
  });

  it('triggers on push and pull_request only (never pull_request_target or a schedule)', () => {
    expect(Object.keys(w.on as object).sort()).toEqual(['pull_request', 'push']);
  });

  it('uses no secret and no token', () => {
    expect(raw(file)).not.toMatch(/secrets\./);
  });

  // a same-repository pull request used to run the workflow twice (once for the push, once for the pull
  // request). A push runs it only on main; a pull_request runs it with no filter.
  it('runs on pushes to main only, and on every pull_request (so a same-repository PR runs once)', () => {
    const on = w.on as { push?: { branches?: string[] } | null; pull_request?: unknown };
    expect(on.push).toEqual({ branches: ['main'] });
    expect(on.pull_request === null || Object.keys(on.pull_request as object).length === 0).toBe(
      true,
    );
  });
});

describe('verify.yml (B19)', () => {
  const w = load('verify.yml');
  const job = w.jobs.verify as Job;
  const include = (job.strategy?.matrix?.include ?? []) as { os: string; node: string }[];

  it('runs the matrix: ubuntu-latest with Node 22.12.0, 24 and 26, and macos-latest with 22.12.0', () => {
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(include.map((i) => `${i.os} ${i.node}`).sort()).toEqual([
      'macos-latest 22.12.0',
      'ubuntu-latest 22.12.0',
      'ubuntu-latest 24',
      'ubuntu-latest 26',
    ]);
  });

  it('lets every matrix cell finish (fail-fast off), so one failure does not hide another', () => {
    expect(job.strategy?.['fail-fast']).toBe(false);
  });

  it('sets up Node from the matrix with the same setup-node pin as the Action', () => {
    const setup = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(setup?.with?.['node-version']).toBe('${{ matrix.node }}');
    const pin = (t: string) => /actions\/setup-node@([0-9a-f]{40})/.exec(t)?.[1];
    expect(pin(raw('verify.yml'))).toBe(pin(readFileSync(join(ROOT, 'action.yml'), 'utf8')));
  });

  it('installs with npm ci --ignore-scripts, then runs npm run verify, in that order', () => {
    const runs = job.steps.map((s) => s.run).filter((r) => r !== undefined);
    expect(runs).toEqual(['npm ci --ignore-scripts', 'npm run verify']);
  });

  it('has no job-level permission wider than the workflow', () => {
    expect(job.permissions).toBeUndefined();
  });
});

describe('action-selftest.yml (B19)', () => {
  const w = load('action-selftest.yml');
  const jobs = w.jobs;
  const own = (j: Job) => j.steps.find((s) => s.uses === './' || s.uses?.startsWith('./'));
  const checkout = (j: Job) => j.steps[0];

  it('has the three jobs clean, failing and upload', () => {
    expect(Object.keys(jobs).sort()).toEqual(['clean', 'failing', 'upload']);
  });

  it('every job checks out first, with the pinned checkout, and without keeping credentials', () => {
    for (const j of Object.values(jobs)) {
      expect(checkout(j)?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      expect(checkout(j)?.with?.['persist-credentials']).toBe(false);
    }
    const pin = (t: string) => /actions\/checkout@([0-9a-f]{40})/.exec(t)?.[1];
    expect(pin(raw('action-selftest.yml'))).toBe(pin(raw('verify.yml')));
  });

  it('clean: runs the Action on demo-fixed and asserts exit-code 0 and a valid SARIF file', () => {
    const j = jobs.clean as Job;
    const a = own(j);
    expect(a?.with?.path).toBe('demo-fixed');
    expect(a?.id).toBeDefined();
    expect(a?.['continue-on-error']).toBeUndefined();
    expect(a?.with?.['upload-sarif']).toBeUndefined();
    const assert = j.steps.find((s) => s.run?.includes('2.1.0'));
    expect(assert?.env?.EXIT_CODE).toBe(`\${{ steps.${a?.id}.outputs.exit-code }}`);
    expect(assert?.env?.SARIF_FILE).toBe(`\${{ steps.${a?.id}.outputs.sarif-file }}`);
    expect(assert?.run).toContain('"$EXIT_CODE" = "0"');
    expect(j.permissions).toBeUndefined();
  });

  it('failing: runs the Action on demo with continue-on-error and asserts failure, exit-code 1 and a SARIF file', () => {
    const j = jobs.failing as Job;
    const a = own(j);
    expect(a?.with?.path).toBe('demo');
    expect(a?.['continue-on-error']).toBe(true);
    expect(a?.with?.['upload-sarif']).toBeUndefined();
    const assert = j.steps.find((s) => s.env?.OUTCOME !== undefined);
    expect(assert?.if).toContain('always()');
    expect(assert?.env?.OUTCOME).toBe(`\${{ steps.${a?.id}.outcome }}`);
    expect(assert?.env?.EXIT_CODE).toBe(`\${{ steps.${a?.id}.outputs.exit-code }}`);
    expect(assert?.run).toContain('"$OUTCOME" = "failure"');
    expect(assert?.run).toContain('"$EXIT_CODE" = "1"');
    expect(assert?.run).toContain('2.1.0');
    expect(j.permissions).toBeUndefined();
  });

  it('upload: like failing, with upload-sarif true and only security-events: write added to contents: read', () => {
    const j = jobs.upload as Job;
    const a = own(j);
    expect(a?.with?.path).toBe('demo');
    expect(a?.with?.['upload-sarif']).toBe('true');
    expect(a?.['continue-on-error']).toBe(true);
    expect(j.permissions).toEqual({ contents: 'read', 'security-events': 'write' });
    const assert = j.steps.find((s) => s.env?.OUTCOME !== undefined);
    expect(assert?.run).toContain('"$OUTCOME" = "failure"');
    expect(assert?.run).toContain('"$EXIT_CODE" = "1"');
  });

  it('upload: only runs on a public repository, and never for a fork pull request', () => {
    const cond = String((jobs.upload as Job).if).replace(/\s+/g, ' ');
    expect(cond).toContain("github.event.repository.visibility == 'public'");
    // A Dependabot pull request gets a read-only token, so the upload could only fail there.
    expect(cond).toContain("github.actor != 'dependabot[bot]'");
    expect(cond).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(cond).toContain("github.event_name == 'push'");
  });

  it('no job other than upload asks for security-events', () => {
    expect(raw('action-selftest.yml').match(/security-events/g)).toHaveLength(1);
  });
});
