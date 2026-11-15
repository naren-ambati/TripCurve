import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'link', 'web-demo');
const GOLDEN = readFileSync(join(ROOT, 'test', 'golden', 'web-t1.txt'), 'utf8');

// The golden file was written from the design mockup and the interaction spec before the
// renderer existed (test/golden/README.md says how it reads for this fixture).
describe('golden: tripcurve . on the one-workload demo fixture', () => {
  const run = runBuilt(['.'], { cwd: FIXTURE });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(GOLDEN);
  });

  it('exits 1 (a FAIL: not a clean result) and writes nothing to stderr', () => {
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('prints the web T1 failure with its sources, the T2 pass and the unresolved T3 (bolt B4)', () => {
    expect(GOLDEN).toContain('  FAIL T1  idle close 6 s is not longer than LB idle 60 s');
    expect(GOLDEN.replace(/\s+/g, ' ')).toContain(
      'Node 22.x from 22.12; measured on 5 releases from 22.12.0 to 22.23.5',
    );
    expect(GOLDEN).toContain('"k8s/web.yaml":17');
    expect(GOLDEN).toContain('"k8s/ingress.yaml":9');
    expect(GOLDEN).toContain('  PASS T2  preStop sleep 10 s ("k8s/web.yaml":25)');
    expect(GOLDEN).toContain(
      '  UNRESOLVED T3  no graceful-timeout ceiling known for a Node server',
    );
    expect(GOLDEN).toContain('declare longest_request_s for this workload in tripcurve.yaml');
    expect(GOLDEN).not.toMatch(/\bT4\b/);
    expect(run.stdout).not.toMatch(/\bT4\b/);
  });

  it('is byte-identical on a second run (deterministic)', () => {
    expect(runBuilt(['.'], { cwd: FIXTURE }).stdout).toBe(run.stdout);
  });

  it('is plain ASCII and at most 80 columns', () => {
    for (const line of GOLDEN.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });

  it('prints the path as typed: a relative spelling from the parent directory', () => {
    const out = runBuilt(['web-demo'], { cwd: join(ROOT, 'test', 'fixtures', 'link') });
    expect(out.stdout).toBe(GOLDEN.replace('checked "."', 'checked "web-demo"'));
    expect(out.status).toBe(1);
  });
});

// The demo after the fix: `server.keepAliveTimeout = 65000` on Node 22.23.
// The golden was written before the resolver learned the explicit-setting rule, from the design mockup and the
// measurement in measure/results/2026-11-11-b3.jsonl (test/golden/README.md says how it reads).
describe('golden: the web demo after the fix (explicit keepAliveTimeout = 65000)', () => {
  const fixed = join(ROOT, 'test', 'fixtures', 'link', 'web-demo-fixed');
  const golden = readFileSync(join(ROOT, 'test', 'golden', 'web-t1-fixed.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd: fixed });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(golden);
  });

  it('exits 0 (a PASS that rests only on measured values) and writes nothing to stderr', () => {
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('prints the measured basis and the setting it rests on', () => {
    const flat = golden.replace(/\s+/g, ' ');
    expect(flat).toContain('PASS T1 idle close 66 s is longer than LB idle 60 s');
    expect(flat).toContain('("src/server.ts":7, keepAliveTimeout 65 s + 1 s');
    expect(flat).toContain('measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5');
  });

  it('is plain ASCII and at most 80 columns', () => {
    for (const line of golden.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });
});

// an invalid declaration in tripcurve.yaml names the key quoted and the
// form it expects, stops before any rule, and exits 2. The golden follows the design mockup.
describe('golden: the config-error case, a declaration that is not a number of seconds', () => {
  const fixture = join(ROOT, 'test', 'fixtures', 'config', 'e4-golden');
  const golden = readFileSync(join(ROOT, 'test', 'golden', 'e4-config-error.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd: fixture });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(golden);
  });

  it('exits 2, writes nothing to stderr and checks nothing', () => {
    expect(run.status).toBe(2);
    expect(run.stderr).toBe('');
    expect(golden.endsWith('Nothing was checked.\n')).toBe(true);
    expect(golden).not.toMatch(/\b(PASS|FAIL|T1|T2|T3)\b/);
  });

  it("names the key quoted and the form it expects, in tripcurve's own words", () => {
    expect(golden).toContain(
      'Config error in "tripcurve.yaml" at line 7: key "workloads[0].longest_request_s"',
    );
    expect(golden).toContain('must be a number of seconds, for example longest_request_s: 5.');
  });

  it('is plain ASCII and at most 80 columns', () => {
    for (const line of golden.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });

  it('is the same on a second run', () => {
    expect(runBuilt(['.'], { cwd: fixture }).stdout).toBe(run.stdout);
  });
});

// T4: the `orders` event source mapping of the design mockup. The golden was written from
// before the Terraform reader and rule T4 existed (test/golden/README.md says how it reads).
describe('golden: the orders event source mapping, T4 FAIL', () => {
  const fixture = join(ROOT, 'test', 'fixtures', 'terraform', 'orders');
  const golden = readFileSync(join(ROOT, 'test', 'golden', 'orders-t4.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd: fixture });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(golden);
  });

  it('exits 1 (a FAIL) and writes nothing to stderr', () => {
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('prints the arithmetic and the three sources of the expected report layout', () => {
    expect(golden).toContain('  FAIL T4  visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    expect(golden).toContain('"infra/queue.tf":3');
    expect(golden).toContain('"infra/queue.tf":12');
    expect(golden).toContain('"infra/queue.tf":20');
  });

  it('is plain ASCII and at most 80 columns', () => {
    for (const line of golden.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    }
  });

  it('is the same on a second run', () => {
    expect(runBuilt(['.'], { cwd: fixture }).stdout).toBe(run.stdout);
  });
});

// The same mapping after the fix: visibility 190 s covers 6 x 30 s + 5 s = 185 s.
describe('golden: the orders event source mapping after the fix, T4 PASS', () => {
  const fixture = join(ROOT, 'test', 'fixtures', 'terraform', 'orders-fixed');
  const golden = readFileSync(join(ROOT, 'test', 'golden', 'orders-t4-fixed.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd: fixture });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(golden);
  });

  it('exits 0 (every value it rests on is read from a file) and writes nothing to stderr', () => {
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});

// T4 over a SAM template: the same FAIL as the Terraform `orders` case, from a SAM
// function with an SQS event. The golden was written before the reader existed.
describe('golden: the SAM orders event, T4 FAIL (the same result as the Terraform orders case)', () => {
  const fixture = join(ROOT, 'test', 'fixtures', 'iac', 'sam', 'orders');
  const golden = readFileSync(join(ROOT, 'test', 'golden', 'sam-t4.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd: fixture });

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(golden);
  });

  it('exits 1 (a FAIL) and writes nothing to stderr', () => {
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('has the same verdict line and arithmetic as the Terraform golden, with the sources in the template', () => {
    const terraform = readFileSync(join(ROOT, 'test', 'golden', 'orders-t4.txt'), 'utf8');
    const verdict = (text: string): string =>
      text.split('\n').filter((l) => l.includes('FAIL T4'))[0] ?? '';
    expect(verdict(golden)).toBe(verdict(terraform));
    expect(golden).toContain('"template.yaml":7');
    expect(golden).toContain('"template.yaml":14');
    expect(golden).toContain('"template.yaml":21');
  });
});
