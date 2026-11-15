// The demo repository is an end-to-end test: the built
// command run from inside `demo/` and `demo-fixed/` prints the expected files byte for byte and exits
// 1 and 0. The expected files hold real output; demo/README.md says how each differs from the design mockup
// (the differences are listed in BUILD-NOTES.md, bolt B10).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AFTER_FIX,
  applyFixEdits,
  copyOfDemo,
  DEMO,
  DEMO_FIXED,
  FIRST_RUN,
  replaceOnce,
  TRIPCURVE_YAML,
} from '../support/demo.js';
import { runBuilt } from '../support/e2e.js';
import type { Tree } from '../support/tmp-tree.js';

const first = readFileSync(FIRST_RUN, 'utf8');
const after = readFileSync(AFTER_FIX, 'utf8');

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});
const demoCopy = (): Tree => {
  const t = copyOfDemo();
  trees.push(t);
  return t;
};

describe('first run: tripcurve . inside demo/ (exit 1)', () => {
  const run = runBuilt(['.'], { cwd: DEMO });

  it('prints exactly the expected file', () => {
    expect(run.stdout).toBe(first);
  });

  it('exits 1 and writes nothing to stderr', () => {
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('reads 14 files and ends with the summary of', () => {
    expect(first.split('\n')[0]).toBe('tripcurve 0.1.0   checked "."   14 files read');
    expect(first.replace(/\s+/g, ' ')).toContain(
      'Summary: 4 failed, 1 unresolved, 1 not evaluated, 1 not applicable, 3 passed; not a clean result',
    );
  });

  it('prints the cited lines of the expected report layout', () => {
    for (const cited of [
      '"k8s/ingress.yaml":9',
      '"k8s/ingress.yaml":11',
      '"k8s/api.yaml":21',
      '"k8s/web.yaml":17',
      '"k8s/web.yaml":26',
      '"k8s/web.yaml":30',
      '"k8s/admin.yaml":19',
      '"k8s/admin.yaml":24',
      '"k8s/admin.yaml":31',
      '"infra/queue.tf":3',
      '"infra/queue.tf":12',
      '"infra/queue.tf":20',
    ]) {
      expect(first, cited).toContain(cited);
    }
  });
});

describe('after the fix: tripcurve . inside demo-fixed/ (exit 0)', () => {
  const run = runBuilt(['.'], { cwd: DEMO_FIXED });

  it('prints exactly the expected file', () => {
    expect(run.stdout).toBe(after);
  });

  it('exits 0 and writes nothing to stderr', () => {
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('ends with nine PASS lines counted and one N/A', () => {
    expect(after).toContain('All checks passed (9), 1 not applicable.\n');
    expect(after.endsWith('Green does not mean zero-downtime: see Assumptions.\n')).toBe(true);
    expect(after.match(/^ {2}PASS /gm)?.length).toBe(9);
    expect(after.match(/^ {2}N\/A /gm)?.length).toBe(1);
  });

  it('the web idle close is the knowledge-base measurement, 66 s, not the one in the expected report layout', () => {
    const flat = after.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'PASS T1 idle close 66 s is longer than LB idle 60 s ("src/server.ts":12',
    );
    expect(flat).toContain('measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5');
    expect(after).not.toContain('<MEASURED>');
  });

  it('cites the lines of the expected report layout', () => {
    expect(after).toContain('("k8s/api.yaml":21,');
    expect(after).toContain('PASS T2  preStop sleep 10 s ("k8s/api.yaml":28)');
    expect(after).toContain('PASS T4  visibility 190 s covers 185 s ("infra/queue.tf":3)');
  });
});

describe('the demo is deterministic and path independent', () => {
  it('a second run is byte-identical', () => {
    expect(runBuilt(['.'], { cwd: DEMO }).stdout).toBe(first);
  });

  it('a copy elsewhere prints the same report, so no absolute path enters the output', () => {
    const t = demoCopy();
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).toBe(first);
    expect(run.status).toBe(1);
  });
});

describe('the end-to-end check can fail (a mutation of a temp copy)', () => {
  it('a different visibility changes the report, so the byte-for-byte check would fail', () => {
    const t = demoCopy();
    t.write(
      'infra/queue.tf',
      replaceOnce(
        readFileSync(`${t.root}/infra/queue.tf`, 'utf8'),
        'visibility_timeout_seconds = 60',
        'visibility_timeout_seconds = 61',
      ),
    );
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).not.toBe(first);
    expect(run.stdout).toContain('visibility 61 s is less than 6 x 30 s + 5 s = 185 s');
  });

  it('dropping one of the three fixes keeps the fixed demo from printing its expected file or exiting 0', () => {
    const t = demoCopy();
    applyFixEdits(t);
    t.write('tripcurve.yaml', TRIPCURVE_YAML);
    // take the preStop off api again: that one fix matters, so the report must change and exit 1
    t.write(
      'k8s/api.yaml',
      readFileSync(`${t.root}/k8s/api.yaml`, 'utf8').replace(
        '          lifecycle:\n            preStop:\n              exec:\n                command: ["sleep", "10"]\n',
        '',
      ),
    );
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).not.toBe(after);
    expect(run.status).toBe(1);
  });
});

describe('the walkthrough in demo/README.md says what the tool prints', () => {
  const readme = readFileSync(`${DEMO}/README.md`, 'utf8');

  it('step 2, the three fixes without the declarations, leaves a warning and an unresolved T3 and exits 1', () => {
    const t = demoCopy();
    applyFixEdits(t);
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.status).toBe(1);
    const flat = run.stdout.replace(/\s+/g, ' ');
    expect(flat).toContain('WARN T3 worst case: grace 30 s is less than preStop 10 s');
    expect(flat).toContain('UNRESOLVED T3 no graceful-timeout ceiling known for a Node server');
    expect(flat).toContain(
      'Summary: 1 warning, 1 unresolved, 1 not applicable, 7 passed; not a clean result',
    );
    expect(readme).toContain('grace 30 s is less than 10 s + 30 s + 1 s');
    expect(readme).toContain('`web` T3 is unresolved');
  });

  it('step 1 numbers are the first-run numbers', () => {
    expect(readme).toContain(
      'It reads 14 files, prints 4 failures, 1 unresolved, 1 not evaluated, 1 not applicable and\n3 passed, and exits 1.',
    );
    expect(first).toContain('14 files read');
    expect(first.replace(/\s+/g, ' ')).toContain(
      '4 failed, 1 unresolved, 1 not evaluated, 1 not applicable, 3 passed',
    );
    expect(first).toContain('visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
  });

  it('step 3 closing lines and the 66 s are the after-fix output', () => {
    expect(after).toContain(
      'All checks passed (9), 1 not applicable.\nGreen does not mean zero-downtime: see Assumptions.\n',
    );
    expect(readme).toContain(
      'All checks passed (9), 1 not applicable.\nGreen does not mean zero-downtime: see Assumptions.',
    );
    expect(after).toContain('idle close 66 s');
    expect(readme).toContain('is 66 s, not 65 s');
  });

  it('the three fixes it lists are the ones the tests apply', () => {
    expect(readme).toContain('`src/server.ts` line 12');
    expect(readme).toContain('`infra/queue.tf` line 3');
    expect(readFileSync(`${DEMO}/src/server.ts`, 'utf8').split('\n')[11]).toContain('keep-alive');
    expect(readFileSync(`${DEMO}/infra/queue.tf`, 'utf8').split('\n')[2]).toContain('= 60');
  });
});
