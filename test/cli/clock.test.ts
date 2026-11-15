import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/app.js';
import { utcToday } from '../../src/cli/clock.js';
import { check } from '../../src/index.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { listSources, relativeSlash } from '../support/raw-reader-scan.js';
import { buildReport } from '../support/report-fixtures.js';

// the date is an input. The command reads the clock once, at the top, and passes it
// down; rules, the waiver applier and the report read no clock, and a scan fails if one starts to.

afterEach(() => {
  vi.useRealTimers();
});

describe('the one clock read (src/cli/clock.ts)', () => {
  it.each([
    ['2027-01-31T23:59:59.999Z', '2027-01-31'],
    ['2027-02-01T00:00:00.000Z', '2027-02-01'],
    ['2026-12-31T23:59:59.999Z', '2026-12-31'],
    ['2028-02-29T12:00:00.000Z', '2028-02-29'],
  ])('%s is the UTC date %s, whatever the local zone', (instant, date) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    expect(utcToday()).toBe(date);
  });
});

describe('the command passes the date down', () => {
  const io = { stdout: () => undefined, stderr: () => undefined, stdoutIsTty: false };

  it('uses the injected date, and passes the same one to the pipeline', () => {
    const seen: (string | undefined)[] = [];
    runCli(
      ['.'],
      io,
      {},
      {
        today: '2027-01-31',
        check: (_path, options) => {
          seen.push(options.today);
          return buildReport({ results: [] });
        },
      },
    );
    expect(seen).toEqual(['2027-01-31']);
  });

  it('reads the clock when nothing is injected, once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-02-01T00:00:00.000Z'));
    const seen: (string | undefined)[] = [];
    runCli(
      ['.'],
      io,
      {},
      {
        check: (_path, options) => {
          seen.push(options.today);
          return buildReport({ results: [] });
        },
      },
    );
    expect(seen).toEqual(['2027-02-01']);
  });
});

describe('the library check() takes a today option', () => {
  const tree = fixtureTree('python/api-admin', {
    'tripcurve.yaml':
      'version: 1\nwaive:\n  - rule: T2\n    workload: api\n    reason: "drains in sidecar"\n    until: 2027-01-31\n',
  });

  it('applies the waiver through its date and not after it', () => {
    const on = check({ path: tree.root, today: '2027-01-31' });
    expect(on.waivers.map((w) => w.state)).toEqual(['applied']);
    expect(on.summary.counts.waived).toBe(1);
    const after = check({ path: tree.root, today: '2027-02-01' });
    expect(after.waivers.map((w) => w.state)).toEqual(['expired']);
    expect(after.summary.counts.waived).toBe(0);
    expect(after.summary.counts.failed).toBe(2);
  });

  it('takes the option beside the path too, and refuses a date that is not a date', () => {
    expect(check(tree.root, { today: '2027-01-31' }).summary.counts.waived).toBe(1);
    expect(() => check({ path: tree.root, today: '2027-02-30' })).toThrow(TypeError);
    expect(() => check({ path: tree.root, today: 'soon' })).toThrow(TypeError);
  });

  it('with no date it reads today: a waiver that ran out long ago has expired', () => {
    const old = fixtureTree('python/api-admin', {
      'tripcurve.yaml':
        'version: 1\nwaive:\n  - rule: T2\n    workload: api\n    reason: "r"\n    until: 2000-01-01\n',
    });
    expect(check(old.root).waivers.map((w) => w.state)).toEqual(['expired']);
    old.cleanup();
    tree.cleanup();
  });
});

describe('rules, the waiver applier and the report read no clock', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  // every way of asking for the time: `new Date()`, `Date()` called without `new` (it
  // returns now whatever its arguments), `Date.now`, `Temporal.Now`, an `Intl.DateTimeFormat` (it formats
  // now by default), the clocks of `performance` and `process`
  const CLOCK =
    /new Date\(\s*\)|(?<!new\s+)(?<![\w.$])Date\(|Date\.now|Temporal\.Now|Intl\.DateTimeFormat|performance\.(?:now|timeOrigin)|process\.(?:hrtime|uptime)/;
  /** Importing the clock module: only the command (src/cli/) may. */
  const CLOCK_IMPORT = /\butcToday\b|from\s+['"][^'"]*\bclock(?:\.js)?['"]/;

  it('finds a clock read in no source file but src/cli/clock.ts', () => {
    const files = listSources(join(ROOT, 'src')).map((f) => ({
      path: relativeSlash(ROOT, f),
      text: readFileSync(f, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => CLOCK.test(f.text)).map((f) => f.path)).toEqual([
      'src/cli/clock.ts',
    ]);
  });

  it('the scan can fail: it flags the ways of asking for the time', () => {
    for (const text of [
      'new Date()',
      'new Date( )',
      'Date()',
      'Date(0)',
      'x = Date(1)',
      'Date.now()',
      'Temporal.Now.instant()',
      'new Intl.DateTimeFormat("en").format()',
      'performance.now()',
      'performance.timeOrigin',
      'process.hrtime()',
      'process.uptime()',
    ]) {
      expect(CLOCK.test(text), text).toBe(true);
    }
    expect(CLOCK.test('new Date(text + "T00:00:00Z")')).toBe(false);
  });

  it('only src/cli imports the clock module, and only runCli and the library entry call it', () => {
    const files = listSources(join(ROOT, 'src')).map((f) => ({
      path: relativeSlash(ROOT, f),
      text: readFileSync(f, 'utf8'),
    }));
    const users = files.filter((f) => CLOCK_IMPORT.test(f.text)).map((f) => f.path);
    expect(users.sort()).toEqual(['src/cli/app.ts', 'src/cli/clock.ts', 'src/cli/pipeline.ts']);
    expect(users.every((p) => p.startsWith('src/cli/'))).toBe(true);
    // the scan can fail
    expect(CLOCK_IMPORT.test("import { utcToday } from '../cli/clock.js';")).toBe(true);
    expect(CLOCK_IMPORT.test("import { utcToday } from './clock';")).toBe(true);
    expect(CLOCK_IMPORT.test("import { x } from './model.js';")).toBe(false);
  });

  it('the rules and the applier take no `today`', () => {
    for (const dir of ['evaluate', 'resolve', 'link']) {
      for (const f of listSources(join(ROOT, 'src', dir))) {
        expect(readFileSync(f, 'utf8'), f).not.toMatch(/\btoday\b/);
      }
    }
  });
});
