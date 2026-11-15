import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../support/e2e.js';
import { runBuilt } from '../support/e2e.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';
import { WAIVER_SCENARIOS } from '../support/waiver-scenarios.js';

// Bolt B6: the waiver goldens, run through the built command with an injected UTC date (the entry
// `test/support/with-today.mjs` calls the real CliApp with `{ today }`; the command has no hidden variable
// or flag for it). Each golden was written from the design mockup and the interaction
// spec, then checked line by line; test/golden/README.md lists the readings.

const ROOT = join(import.meta.dirname, '..', '..');
const WITH_TODAY = join(ROOT, 'test', 'support', 'with-today.mjs');
const golden = (name: string): string => readFileSync(join(ROOT, 'test', 'golden', name), 'utf8');

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function runOn(tree: Tree, today: string, args: readonly string[] = ['.']) {
  return runBuilt([today, ...args], { cwd: tree.root, script: WITH_TODAY });
}

describe.each(WAIVER_SCENARIOS)('golden: $name', (scenario) => {
  const tree = fixtureTree(scenario.fixture, scenario.overlay);
  afterAll(() => tree.cleanup());
  let run: RunResult;
  beforeAll(() => {
    run = runOn(tree, scenario.today);
  });
  const expected = golden(scenario.golden);

  it('prints exactly the golden text', () => {
    expect(run.stdout).toBe(expected);
  });

  it(`exits ${scenario.exit} and writes nothing to stderr`, () => {
    expect(run.status).toBe(scenario.exit);
    expect(run.stderr).toBe('');
  });

  it('is plain ASCII and at most 80 columns, with no line starting with quoted input', () => {
    for (const line of expected.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).toMatch(/^[\x20-\x7e]*$/);
      expect(line.trimStart().startsWith('"')).toBe(false);
    }
  });

  it('is byte-identical on a second run (deterministic)', () => {
    expect(runOn(tree, scenario.today).stdout).toBe(run.stdout);
  });
});

describe('what the goldens say, in words (the honesty rules)', () => {
  const valid = golden('waivers-valid.txt');

  it('the waived NLB line is the one WAIVED line form and the run ends No failures, never All checks passed', () => {
    expect(valid).toContain(
      '  WAIVED T1  (was UNRESOLVED: no measured evidence for NLBs) until 2027-03-01:\n           reason "NLB owned by the network team" from "tripcurve.yaml":7\n',
    );
    expect(valid).toContain(
      'No failures: 3 passed, 3 waived (expiring 2026-12-01, 2027-01-15, 2027-03-01), 0\nnot applicable.\nGreen does not mean zero-downtime: see Assumptions.\n',
    );
    expect(valid).not.toContain('All checks passed');
    expect(valid).not.toContain('not a clean result');
  });

  it('a waived result is counted as waived and never as passed', () => {
    expect(valid).toContain('3 passed, 3 waived');
    // three PASS lines (web) and three WAIVED lines (stream)
    expect(valid.match(/^ {2}PASS /gm)).toHaveLength(3);
    expect(valid.match(/^ {2}WAIVED /gm)).toHaveLength(3);
  });

  it('with a workload not checked, the other closing line adds the count and keeps No failures', () => {
    const text = golden('waivers-valid-not-checked.txt');
    expect(text).toContain('0\nnot applicable; 1 workload not checked.\n');
    expect(text).not.toContain('All checks passed');
  });

  it('the finding returns with its original kind and the report says the waiver expired', () => {
    const text = golden('waivers-e5-expired.txt');
    expect(text).toContain(
      '  FAIL T2  no drain delay before SIGTERM\n           waiver expired on 2026-10-31\n           reason "drains in sidecar" from "k8s/api.yaml":6\n',
    );
    expect(text).not.toContain('WAIVED');
    expect(text).toContain(
      'Summary: 2 failed, 1 not evaluated, 1 not applicable, 2 passed; not a clean\nresult',
    );
  });

  it('a waiver that is not applied is listed, counted unresolved, and the run is not clean', () => {
    for (const name of ['waivers-e6-unmatched.txt', 'waivers-e9-invalid.txt']) {
      const text = golden(name);
      expect(text, name).toContain('Waivers not applied\n  UNRESOLVED (file)  ');
      expect(text, name).toContain('1 unresolved (1 waiver not applied)');
      expect(text, name).toContain('not a clean');
      expect(text, name).not.toContain('No failures');
      expect(text, name).not.toContain('WAIVED');
    }
    expect(golden('waivers-e9-invalid.txt')).toContain('FAIL T2  no drain delay before SIGTERM\n');
  });
});

describe('the date: through the day itself, in UTC', () => {
  const tree = fixtureTree('python/api-admin', {
    'tripcurve.yaml':
      'version: 1\nwaive:\n  - rule: T2\n    workload: api\n    reason: "drains in sidecar"\n    until: 2027-01-31\n',
  });
  afterAll(() => tree.cleanup());

  it('on 2027-01-31 the waiver applies', () => {
    const run = runOn(tree, '2027-01-31');
    expect(run.stdout).toContain(
      '  WAIVED T2  (was FAIL: no drain delay before SIGTERM) until 2027-01-31:',
    );
    expect(run.stdout).not.toContain('waiver expired');
  });

  it('on 2027-02-01 it has expired and the finding is back', () => {
    const run = runOn(tree, '2027-02-01');
    expect(run.stdout).toContain(
      '  FAIL T2  no drain delay before SIGTERM\n           waiver expired on 2027-01-31\n',
    );
    expect(run.stdout).not.toContain('WAIVED');
  });

  it('the command with no injected date reads the clock: a far-future waiver applies, a past one has expired', () => {
    const real = (until: string) => {
      const t = fixtureTree('python/api-admin', {
        'tripcurve.yaml': `version: 1\nwaive:\n  - rule: T2\n    workload: api\n    reason: "r"\n    until: ${until}\n`,
      });
      trees.push(t);
      return runBuilt(['.'], { cwd: t.root }).stdout;
    };
    expect(real('9999-12-31')).toContain('WAIVED T2');
    expect(real('2000-01-01')).toContain('waiver expired on 2000-01-01');
  });
});

describe('exit codes', () => {
  const plain = (files: Record<string, string>): Tree => {
    const t = makeTree();
    trees.push(t);
    for (const [p, text] of Object.entries(files)) t.write(p, text);
    return t;
  };
  const cases: ReadonlyArray<readonly [string, () => Tree, string, number, string]> = [
    [
      'a clean run',
      () => fixtureTree('link/web-demo-fixed'),
      '2026-11-12',
      0,
      'All checks passed (3)',
    ],
    [
      'a run with valid waivers',
      () => fixtureTree('waivers/valid'),
      '2026-11-12',
      0,
      'No failures:',
    ],
    ['a failure', () => fixtureTree('python/api-admin'), '2026-11-12', 1, 'not a clean'],
    [
      'an invalid waiver',
      () =>
        fixtureTree('python/api-admin', { 'tripcurve.yaml': 'version: 1\nwaive:\n  - rule: T2\n' }),
      '2026-11-12',
      1,
      'not a clean',
    ],
    [
      'an expired waiver',
      () => fixtureTree('waivers/valid'),
      '2028-01-01',
      1,
      'not a clean result',
    ],
    ['nothing found', () => plain({ 'README.md': '# none\n' }), '2026-11-12', 2, 'nothing checked'],
    [
      'an invalid tripcurve.yaml',
      () => plain({ 'tripcurve.yaml': 'version: 1\nbogus: 1\n' }),
      '2026-11-12',
      2,
      'Nothing was checked.',
    ],
  ];
  it.each(cases)('%s', (_name, make, today, status, text) => {
    const run = runOn(make(), today);
    expect(run.status).toBe(status);
    expect(run.stdout).toContain(text);
    if (status !== 0) expect(run.stdout).not.toContain('All checks passed');
  });

  it('an expired waiver in a run that was clean only through it is not clean (the date moved)', () => {
    const t = fixtureTree('waivers/valid');
    trees.push(t);
    const run = runOn(t, '2027-02-01');
    // T2 (2026-12-01) and T3 (2027-01-15) have expired; T1 (2027-03-01) still applies
    expect(run.stdout).toContain('waiver expired on 2026-12-01');
    expect(run.stdout).toContain('waiver expired on 2027-01-15');
    expect(run.stdout).toContain('  WAIVED T1');
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('No failures');
  });

  it('usage errors, an unknown rule and a missing path are 2, and an internal error is 3', () => {
    expect(runBuilt(['--bogus']).status).toBe(2);
    expect(runBuilt(['--explain', 'T9']).status).toBe(2);
    expect(runBuilt(['--explain', 'T1', '.']).status).toBe(2);
    expect(runBuilt(['/no/such/dir/anywhere']).status).toBe(2);
    const failing = runBuilt(['.'], {
      script: join(ROOT, 'test', 'support', 'failing-pipeline.mjs'),
    });
    expect(failing.status).toBe(3);
  });
});

describe('--explain: tripcurve text only, exit 0', () => {
  it.each(['T1', 'T2', 'T3', 'T4'])(
    '%s prints exactly its golden and writes nothing to stderr',
    (rule) => {
      const run = runBuilt(['--explain', rule]);
      expect(run.stdout).toBe(golden(`explain-${rule.toLowerCase()}.txt`));
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
    },
  );

  it('an unknown rule prints a fixed message on stderr, nothing on stdout, and exits 2', () => {
    for (const rule of ['T9', 't1', '', 'T1 ', 'T1\u001b[2J', '"; rm -rf /', 'x'.repeat(10_000)]) {
      const run = runBuilt(['--explain', rule]);
      expect(run.status, JSON.stringify(rule)).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe(golden('explain-unknown.txt'));
    }
  });
});
