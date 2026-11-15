// The timed check is a script in the one local command. These tests run it as a
// child process with stand-in commands, so that every outcome is shown: skipped on another machine,
// within budget on the recorded one, failed over budget, failed on a run that was not the real report.
// Nothing here times the real command: that would make a test depend on the load of the machine.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_BUDGET_S,
  hostBusy,
  overBudget,
  printable,
  SETTLE_MAX_MS,
  settle,
  TREE_BUDGET_S,
  validIdentity,
} from '../../scripts/timed-check.mjs';
import { AFTER_FIX, DEMO, FIRST_RUN, REPO_ROOT } from '../support/demo.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const SCRIPT = join(REPO_ROOT, 'scripts', 'timed-check.mjs');
const SKIPPED =
  /^timed check: skipped \(not the recorded machine: found "[^"\n]*", recorded "[^"\n]*"\)\n$/;

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});
const scratch = (): Tree => {
  const t = makeTree('tripcurve-timed-test-');
  trees.push(t);
  return t;
};

function sysctl(key: string): string | undefined {
  try {
    return execFileSync('sysctl', ['-n', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
const MODEL = sysctl('hw.model');
const CPU = sysctl('machdep.cpu.brand_string');
const HAS_SYSCTL = MODEL !== undefined && CPU !== undefined;

// Every run assumes a quiet host (`--load 0`) unless the test sets a load: a real reading would make the
// script wait up to two minutes for this machine's load to settle, and make the outcome depend on it.
function run(args: string[], env: Record<string, string> = { PATH: process.env.PATH ?? '' }) {
  const full = args.includes('--load') ? args : [...args, '--load', '0'];
  const r = spawnSync(process.execPath, [SCRIPT, ...full], { encoding: 'utf8', env });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** A machine identity file for this very machine (so the budgets are enforced), or another one. */
function identity(t: Tree, model: string | undefined, cpu: string | undefined): string {
  return t.write('machine.json', JSON.stringify({ model, cpu }));
}

/** A stand-in command that prints `text` after `delayMs`, exiting with `status`. */
function stub(t: Tree, text: string, status: number, delayMs: number): string {
  return t.write(
    'stub.mjs',
    [
      `if (${delayMs} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});`,
      `process.stdout.write(${JSON.stringify(text)});`,
      `process.exitCode = ${status};`,
    ].join('\n'),
  );
}

describe('on a machine that is not the recorded one', () => {
  it('prints the skipped line, exits 0 and never says it passed or was within budget', () => {
    const t = scratch();
    const r = run(['--machine-file', identity(t, 'Some-Other,1', 'Some Other CPU')]);
    expect(r.stdout).toMatch(SKIPPED);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/pass|within budget/i);
    expect(r.stderr).toBe('');
  });

  it('a different CPU on the same model is another machine', () => {
    const t = scratch();
    const r = run(['--machine-file', identity(t, MODEL ?? 'x', 'Another CPU')]);
    expect(r.stdout).toMatch(SKIPPED);
  });

  it('a missing sysctl, as on Linux, is skipped', () => {
    const t = scratch();
    const empty = scratch();
    const r = run(['--machine-file', identity(t, 'Mac17,3', 'Apple M5')], { PATH: empty.root });
    expect(r.stdout).toMatch(SKIPPED);
    expect(r.status).toBe(0);
  });

  it('skips before it times anything: a stand-in that would fail is never run', () => {
    const t = scratch();
    const bad = stub(t, 'wrong', 9, 0);
    const r = run(['--machine-file', identity(t, 'Some-Other,1', 'x'), '--cli', bad]);
    expect(r.stdout).toMatch(SKIPPED);
  });

  it('the recorded machine file in the repository names Mac17,3 and Apple M5', () => {
    const recorded = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'timed-check-machine.json'), 'utf8'),
    ) as { model: string; cpu: string };
    expect(recorded.model).toBe('Mac17,3');
    expect(recorded.cpu).toBe('Apple M5');
  });
});

describe.skipIf(!HAS_SYSCTL)('on the recorded machine (a stand-in for it: this machine)', () => {
  const first = (): string => readFileSync(FIRST_RUN, 'utf8');

  it('within budget: records model, CPU, Node version and date with each result', () => {
    const t = scratch();
    const ok = stub(t, first(), 1, 0);
    const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', ok, '--only', 'demo']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`on ${MODEL}, ${CPU}, Node ${process.version}, `);
    expect(r.stdout).toMatch(/, \d{4}-\d{2}-\d{2} \(/);
    expect(r.stdout).toContain('budget under 2 s');
    expect(r.stdout).toContain(
      'timed check: within budget (machine-file, cli, only, load overridden: not the real check)',
    );
    expect(r.stdout).not.toContain('skipped');
  });

  it('over the 2 s demo budget fails, and prints no "within budget"', () => {
    const t = scratch();
    const slow = stub(t, first(), 1, 2300);
    const r = run([
      '--machine-file',
      identity(t, MODEL, CPU),
      '--cli',
      slow,
      '--only',
      'demo',
      '--runs',
      '1',
      '--load',
      '0',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/timed check: FAILED, demo: 2\.\d\d s is not under 2 s/);
    expect(r.stdout).not.toContain('within budget');
  });

  it('over budget on a busy host is skipped, exits 0, and never says within budget or passed', () => {
    const t = scratch();
    const slow = stub(t, first(), 1, 2300);
    const r = run([
      '--machine-file',
      identity(t, MODEL, CPU),
      '--cli',
      slow,
      '--only',
      'demo',
      '--runs',
      '1',
      '--load',
      '999',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /timed check: skipped \(host busy: load 999\.00 on \d+ CPUs; an over-budget time on a busy host is not a measurement\)/,
    );
    expect(r.stdout).not.toContain('within budget');
    expect(r.stdout).not.toMatch(/passed/i);
    expect(r.stderr).not.toContain('FAILED');
  });

  it('a wrong report still fails on a busy host: load excuses only time, never output', () => {
    const t = scratch();
    const wrong = stub(t, 'not the demo report', 1, 0);
    const r = run([
      '--machine-file',
      identity(t, MODEL, CPU),
      '--cli',
      wrong,
      '--only',
      'demo',
      '--runs',
      '1',
      '--load',
      '999',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('timed check: FAILED, demo: the demo run did not print');
    expect(r.stdout).not.toContain('skipped');
  });

  it('within budget on a busy host is still within budget (load only adds time), and --load is marked', () => {
    const t = scratch();
    const ok = stub(t, first(), 1, 0);
    const r = run([
      '--machine-file',
      identity(t, MODEL, CPU),
      '--cli',
      ok,
      '--only',
      'demo',
      '--load',
      '999',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'timed check: within budget (machine-file, cli, only, load overridden: not the real check)',
    );
  });

  it('a fast run that is not the expected report fails: a crash cannot look fast', () => {
    const t = scratch();
    const crash = stub(t, 'boom\n', 1, 0);
    const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', crash, '--only', 'demo']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not print demo/expected/first-run.txt and exit 1');
    expect(r.stdout).not.toContain('within budget');
  });

  it('the right text with the wrong exit code fails', () => {
    const t = scratch();
    const wrong = stub(t, first(), 0, 0);
    const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', wrong, '--only', 'demo']);
    expect(r.status).toBe(1);
  });

  it('the fixed demo text is not accepted as the demo run', () => {
    const t = scratch();
    const fixed = stub(t, readFileSync(AFTER_FIX, 'utf8'), 1, 0);
    const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', fixed, '--only', 'demo']);
    expect(r.status).toBe(1);
  });

  it('the generated tree has 1,000 files, none over 5 MB, and is removed afterwards', () => {
    const t = scratch();
    const seen = join(t.root, 'seen.json');
    const counter = t.write(
      'count.mjs',
      [
        "import { readdirSync, statSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        `const seen = ${JSON.stringify(seen)};`,
        'let n = 0; let biggest = 0;',
        'const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); const s = statSync(p);',
        '  if (s.isDirectory()) walk(p); else { n++; biggest = Math.max(biggest, s.size); } } };',
        "walk('.');",
        'writeFileSync(seen, JSON.stringify({ n, biggest, cwd: process.cwd() }));',
        'process.stdout.write("tripcurve 0.1.1   checked \\".\\"   " + n + " files read\\n");',
        'process.exitCode = 1;',
      ].join('\n'),
    );
    // The child gets a private temporary folder (`TMPDIR`), so that what it creates there, and what it leaves,
    // can be listed exactly. The test used to compare the test process's own temporary folder before and after,
    // which is not the child's (the child's environment is `PATH` only) and which other test runs write to at
    // any moment: it could not see a leftover tree, and it failed on Node 24.22.3 when another run was going
    // (B16, 2026-11-12).
    const tmp = join(t.root, 'private-tmp');
    mkdirSync(tmp);
    const r = run(
      [
        '--machine-file',
        identity(t, MODEL, CPU),
        '--cli',
        counter,
        '--only',
        'tree',
        '--runs',
        '1',
      ],
      { PATH: process.env.PATH ?? '', TMPDIR: tmp },
    );
    expect(r.status, r.stderr).toBe(0);
    const info = JSON.parse(readFileSync(seen, 'utf8')) as {
      n: number;
      biggest: number;
      cwd: string;
    };
    expect(info.n).toBe(1000);
    expect(info.biggest).toBeLessThan(5_000_000);
    expect(info.biggest).toBeGreaterThan(4_000_000);
    expect(info.cwd).toContain('/tripcurve-timed-');
    expect(info.cwd).toContain('/private-tmp/tripcurve-timed-');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('a tree run that did not read 1,000 files fails', () => {
    const t = scratch();
    const short = stub(t, 'tripcurve 0.1.1   checked "."   3 files read\n', 1, 0);
    const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', short, '--only', 'tree']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not read 1000 files');
  });
});

describe('the recorded machine file is validated', () => {
  const BAD =
    'timed check: the recorded machine file must be a JSON object with a non-empty "model" and a non-empty "cpu" (text)\n';
  const cases: Array<[string, string]> = [
    ['an empty object', '{}'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"Mac17,3"'],
    ['a number model', '{"model": 1, "cpu": "Apple M5"}'],
    ['an empty model', '{"model": "", "cpu": "Apple M5"}'],
    ['a blank cpu', '{"model": "Mac17,3", "cpu": "  "}'],
    ['a missing cpu', '{"model": "Mac17,3"}'],
    ['not JSON', '{"model": '],
  ];
  it.each(cases)('%s: exit 2 with the fixed message, nothing on stdout, no crash', (_n, text) => {
    const t = scratch();
    const file = t.write('machine.json', text);
    const r = run(['--machine-file', file]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(BAD);
    expect(r.stdout).toBe('');
  });

  it('a missing file is the same fixed message', () => {
    const t = scratch();
    const r = run(['--machine-file', join(t.root, 'nope.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(BAD);
  });

  it('validIdentity accepts only two non-empty strings', () => {
    expect(validIdentity({ model: 'a', cpu: 'b' })).toBe(true);
    expect(validIdentity({})).toBe(false);
    expect(validIdentity(null)).toBe(false);
    expect(validIdentity({ model: 'a', cpu: '' })).toBe(false);
  });

  it('a skip prints what was found next to what was recorded', () => {
    const t = scratch();
    const r = run(['--machine-file', identity(t, 'Rec-Model,9', 'Rec CPU')]);
    expect(r.stdout).toContain('recorded "Rec-Model,9, Rec CPU")');
    if (HAS_SYSCTL) expect(r.stdout).toContain(`found "${MODEL}, ${CPU}"`);
  });

  it('with no sysctl the skip says there was no answer', () => {
    const t = scratch();
    const empty = scratch();
    const r = run(['--machine-file', identity(t, 'Mac17,3', 'Apple M5')], { PATH: empty.root });
    expect(r.stdout).toContain('found "no sysctl answer"');
  });

  it('a recorded value is bounded and printable when shown', () => {
    const t = scratch();
    const r = run(['--machine-file', identity(t, `x\u001b[31m${'y'.repeat(200)}`, 'cpu')]);
    expect(r.stdout).toMatch(/^[\x20-\x7e]*\n$/);
    expect(r.stdout.length).toBeLessThan(400);
    expect(printable('a\nb')).toBe('a?b');
    expect(printable('z'.repeat(81))).toHaveLength(80);
    expect(printable('z'.repeat(80))).toHaveLength(80);
  });
});

describe.skipIf(!HAS_SYSCTL)(
  'an overridden run is marked and never says it is the real check',
  () => {
    const first = (): string => readFileSync(FIRST_RUN, 'utf8');
    it('--cli: every result line and the last line carry the marker, with no "on the recorded machine"', () => {
      const t = scratch();
      const ok = stub(t, first(), 1, 0);
      const r = run(['--machine-file', identity(t, MODEL, CPU), '--cli', ok, '--only', 'demo']);
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      for (const line of lines) expect(line).toContain('overridden: not the real check');
      expect(lines.at(-1)).toMatch(
        /^timed check: within budget \(.*cli.*overridden: not the real check\)$/,
      );
      expect(r.stdout).not.toContain('within budget on the recorded machine');
    });

    it('--runs other than 3 and --only are marked too', () => {
      const t = scratch();
      const ok = stub(t, first(), 1, 0);
      const r = run([
        '--machine-file',
        identity(t, MODEL, CPU),
        '--cli',
        ok,
        '--runs',
        '1',
        '--only',
        'demo',
      ]);
      expect(r.stdout).toContain(
        '(machine-file, cli, runs, only, load overridden: not the real check)',
      );
    });

    it('"under" means equal is over: overBudget at the edges', () => {
      expect(overBudget(1.99, DEMO_BUDGET_S)).toBe(false);
      expect(overBudget(2, DEMO_BUDGET_S)).toBe(true);
      expect(overBudget(29.99, TREE_BUDGET_S)).toBe(false);
      expect(overBudget(30, TREE_BUDGET_S)).toBe(true);
      expect(overBudget(0, DEMO_BUDGET_S)).toBe(false);
    });

    it('the demo is timed from demo/', () => {
      expect(readdirSync(DEMO)).toContain('expected');
    });
  },
);

describe("hostBusy: the lanes' rule, load above half the CPUs", () => {
  it('is false at exactly half and true just above', () => {
    expect(hostBusy(4, 8)).toBe(false);
    expect(hostBusy(4.01, 8)).toBe(true);
    expect(hostBusy(0, 1)).toBe(false);
  });
});

describe('settle: wait for load left by the verify run itself to fade (review F1)', () => {
  it('stops waiting as soon as the load is quiet, and reports that load', () => {
    const loads = [9, 7, 5, 4.5, 1];
    const slept: number[] = [];
    const last = settle(
      () => loads.shift() ?? 0,
      10,
      SETTLE_MAX_MS,
      (ms) => slept.push(ms),
    );
    expect(last).toBe(5);
    expect(slept.length).toBe(2);
  });
  it('gives up after the maximum wait when the load stays busy, so the run can still be skipped', () => {
    const slept: number[] = [];
    const last = settle(
      () => 50,
      10,
      10_000,
      (ms) => slept.push(ms),
    );
    expect(last).toBe(50);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(10_000);
  });
  it('does not wait at all on a quiet host', () => {
    const slept: number[] = [];
    settle(
      () => 1,
      10,
      SETTLE_MAX_MS,
      (ms) => slept.push(ms),
    );
    expect(slept).toEqual([]);
  });
  it('waits up to two minutes, no more', () => {
    expect(SETTLE_MAX_MS).toBe(120_000);
  });
});
