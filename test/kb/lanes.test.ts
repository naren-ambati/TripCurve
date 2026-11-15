// B8: the measurement lanes.
//   1. The gap test: an entry without a script (or the stated reason), source URL, range or basis
//      is a gap, and a script the lanes cannot plan is a gap too.
//   2. The planted-drift test: a knowledge-base entry whose value differs from a recorded
//      measurement makes the lane comparison fail. Recorded lines and fakes only; `npm run verify`
//      never starts a server (the real lanes are `npm run verify:measure` and `lanes.mjs latest`).
// The lanes runner reads the knowledge-base JSON directly and imports no `src/` code (U12 ->
// reads the schema only), so this file is also where the two sides are tied together.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Case,
  compareLine,
  coverageGaps,
  deferredEntries,
  formatVerdict,
  inRange,
  judgeLane,
  kbGaps,
  latestTargets,
  loadEntries,
  newerOutsideRanges,
  parseRange,
  planCases,
  type RawEntry,
  releaseBlockerIds,
  runCases,
  statedReasons,
  type Verdict,
} from '../../measure/lib/lanes-core.mjs';
import { defaultKnowledgeBase } from '../../src/kb/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const KB_DIR = join(ROOT, 'src', 'kb', 'data');
const MEASURE_DIR = join(ROOT, 'measure');
const RESULTS = join(MEASURE_DIR, 'results');
const entries: readonly RawEntry[] = loadEntries(KB_DIR);

const RES = { sweepStepMs: 1, injectedLatencyMs: 0 };
const POLL10 = { pollMs: 10 };
const POLL20 = { pollMs: 20 };

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`test setup: ${what} is missing`);
  return value;
}
const byId = (id: string): RawEntry =>
  must(
    entries.find((e) => e.id === id),
    id,
  );
function copy(entry: RawEntry, patch: Record<string, unknown> = {}): RawEntry {
  return { ...structuredClone(entry), ...patch } as RawEntry;
}
function without(entry: RawEntry, field: string): RawEntry {
  const e = structuredClone(entry) as unknown as Record<string, unknown>;
  Reflect.deleteProperty(e, field);
  return e as unknown as RawEntry;
}
function recorded(file: string): Record<string, unknown>[] {
  return readFileSync(join(RESULTS, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
function firstCase(entry: RawEntry, version?: string): Case {
  const cases = planCases(entry);
  return must(
    version === undefined ? cases[0] : cases.find((c) => c.version === version),
    `a case for ${entry.id}`,
  );
}

describe('the shipped knowledge base has no gaps', () => {
  it('every entry has a script that exists, or a stated reason; a source URL; a range; a basis', () => {
    expect(kbGaps(entries, MEASURE_DIR)).toEqual([]);
  });

  it('the data the lanes read is the data the tool loads (same ids, same values)', () => {
    const shipped = defaultKnowledgeBase();
    expect(entries.map((e) => e.id).sort()).toEqual(shipped.entries.map((e) => e.id).sort());
    for (const e of shipped.entries) {
      expect(byId(e.id).value, e.id).toBe(e.value);
      expect(byId(e.id).scriptRef, e.id).toEqual(e.scriptRef);
    }
  });

  it('the entries with a stated reason instead of a script are exactly the ones that cannot run locally', () => {
    expect(
      statedReasons(entries)
        .map((r) => r.entryId)
        .sort(),
    ).toEqual(
      [
        'alb-idle-timeout-default',
        'k8s-grace-period-default',
        'terraform-lb-idle-timeout-default',
        'terraform-sqs-visibility-default',
        'terraform-lambda-timeout-default',
        'lambda-sqs-batching-window-default',
        'cfn-lb-idle-timeout-default',
        'cfn-sqs-visibility-default',
        'cfn-lambda-timeout-default',
      ].sort(),
    );
    for (const r of statedReasons(entries)) expect(r.reason.length).toBeGreaterThan(20);
  });

  it('no shipped entry is a release blocker', () => {
    expect(releaseBlockerIds(entries)).toEqual([]);
  });
});

describe('the gap test can fail: each planted gap is named by entry and field', () => {
  const node = byId('node-idle-close-22x');
  const alb = byId('alb-idle-timeout-default');
  const planted: readonly (readonly [string, RawEntry, string, RegExp])[] = [
    ['no scriptRef', without(node, 'scriptRef'), 'scriptRef', /missing/],
    ['empty scriptRef', copy(node, { scriptRef: '' }), 'scriptRef', /missing/],
    ['blank scriptRef', copy(node, { scriptRef: '   ' }), 'scriptRef', /missing/],
    [
      'empty reason',
      copy(alb, { scriptRef: { notMeasurableLocally: '' } }),
      'scriptRef',
      /missing/,
    ],
    [
      'blank reason',
      copy(alb, { scriptRef: { notMeasurableLocally: '  \t ' } }),
      'scriptRef',
      /missing/,
    ],
    [
      'reason of the wrong type',
      copy(alb, { scriptRef: { notMeasurableLocally: 7 } }),
      'scriptRef',
      /missing/,
    ],
    [
      'a script that does not exist',
      copy(node, { scriptRef: 'measure/does-not-exist.mjs' }),
      'scriptRef',
      /does not exist/,
    ],
    [
      'a script outside measure/',
      copy(node, { scriptRef: 'package.json' }),
      'scriptRef',
      /measure\//,
    ],
    [
      'a script that climbs out of measure/',
      copy(node, { scriptRef: 'measure/../package.json' }),
      'scriptRef',
      /measure\//,
    ],
    ['no docUrl', without(node, 'docUrl'), 'docUrl', /https/],
    ['a plain http docUrl', copy(node, { docUrl: 'http://nodejs.org/' }), 'docUrl', /https/],
    ['a docUrl that is not a URL', copy(node, { docUrl: 'nodejs docs' }), 'docUrl', /https/],
    [
      'no range',
      copy(node, { applies: { runtime: 'node' } }),
      'applies.versionRange',
      /missing|grammar/,
    ],
    [
      'a range outside the grammar',
      copy(node, { applies: { runtime: 'node', versionRange: '22.x' } }),
      'applies.versionRange',
      /grammar/,
    ],
    ['no basis', without(node, 'basis'), 'basis', /known basis/],
    ['an unknown basis', copy(node, { basis: 'guessed' }), 'basis', /known basis/],
    ['no source date', without(node, 'docDate'), 'docDate', /date/],
    ['a script entry with no tolerance', without(node, 'toleranceMs'), 'toleranceMs', /tolerance/],
    [
      'a script entry no case can be planned for',
      copy(node, { subject: 'gunicorn-setting-precedence' }),
      'scriptRef',
      /no measurement case/,
    ],
    [
      'a measured entry with no pinned version',
      (() => {
        const e = copy(node);
        Reflect.deleteProperty(e as unknown as Record<string, unknown>, 'measuredVersions');
        Reflect.deleteProperty(e as unknown as Record<string, unknown>, 'measuredOn');
        return e;
      })(),
      'measuredVersions',
      /pinned version/,
    ],
  ];

  for (const [label, entry, field, message] of planted) {
    it(`reports ${label}`, () => {
      const gaps = kbGaps([...entries.filter((e) => e.id !== entry.id), entry], MEASURE_DIR);
      const mine = gaps.filter((g) => g.entryId === entry.id);
      expect(mine.map((g) => g.field)).toContain(field);
      expect(mine.find((g) => g.field === field)?.message).toMatch(message);
      expect(gaps.every((g) => g.entryId === entry.id)).toBe(true);
    });
  }

  it('lists a to-be-measured entry as a release blocker', () => {
    const tbm = copy(node, { id: 'planted-tbm', basis: 'to-be-measured' });
    expect(releaseBlockerIds([...entries, tbm])).toEqual(['planted-tbm']);
  });

  it('two entries with one id is a gap', () => {
    const gaps = kbGaps([...entries, copy(node)], MEASURE_DIR);
    expect(gaps.some((g) => g.entryId === node.id && g.field === 'id')).toBe(true);
  });
});

describe('version ranges (the grammar, read without src/)', () => {
  it('parses *, lower, upper and both; refuses anything else', () => {
    expect(parseRange('*')).toEqual({});
    expect(parseRange('>=22.12.0 <23.0.0')).toEqual({
      lower: { major: 22, minor: 12, patch: 0 },
      upper: { major: 23, minor: 0, patch: 0 },
    });
    for (const bad of ['', '22', '22.x', '>22.0.0', '>=22.0', '>= 22.0.0', '<23.0.0 >=22.0.0']) {
      expect(parseRange(bad), bad).toBeNull();
    }
  });

  it('includes the lower bound and excludes the upper bound', () => {
    const r = must(parseRange('>=22.12.0 <23.0.0'), 'range');
    expect(inRange(r, '22.12.0')).toBe(true);
    expect(inRange(r, '22.23.5')).toBe(true);
    expect(inRange(r, '22.11.9')).toBe(false);
    expect(inRange(r, '23.0.0')).toBe(false);
    expect(inRange(r, '22.12')).toBe(false);
    expect(inRange(r, '22.12.0-rc.1')).toBe(false);
    expect(inRange({}, '1.2.3')).toBe(true);
  });
});

describe('the pinned plan: one case per release, value and setting the entry names', () => {
  it('Node default idle close: one case per measured release, entry value as the target', () => {
    const e = byId('node-idle-close-22x');
    const cases = planCases(e);
    expect(cases.map((c) => c.version)).toEqual([
      '22.12.0',
      '22.18.0',
      '22.19.0',
      '22.23.2',
      '22.23.5',
    ]);
    for (const c of cases) {
      expect(c.expectedMs).toBe(6000);
      expect(c.toleranceMs).toBe(5);
      expect(c.script).toBe('measure/node-idle-close.mjs');
      expect(c.toolchain).toBe('node');
      expect(c.args).toEqual([]);
    }
    expect(planCases(byId('node-idle-close-18x')).map((c) => c.expectedMs)).toEqual([5000]);
  });

  it('Node explicit keepAliveTimeout: every release at every K, plus the options form runs', () => {
    const e = byId('node-explicit-keepalive-22x');
    const cases = planCases(e);
    // 5 releases x K = 7, 12, 65 (assign), plus the options runs the entry lists (2 + 2).
    expect(cases).toHaveLength(5 * 3 + 4);
    const k7 = must(
      cases.find((c) => c.version === '22.23.5' && c.args[0] === '7000' && c.args.length === 2),
      'assign K=7 on 22.23.5',
    );
    expect(k7.expectedMs).toBe(8000);
    expect(k7.args).toEqual(['7000', '--cap-ms=17000']);
    const k65 = must(
      cases.find((c) => c.version === '22.12.0' && c.args[0] === '65000' && c.args.length === 2),
      'assign K=65 on 22.12.0',
    );
    expect(k65.expectedMs).toBe(66000);
    const options = cases.filter((c) => c.args.includes('--form=options'));
    expect(options.map((c) => `${c.version}@${c.args[0]}`).sort()).toEqual([
      '22.12.0@65000',
      '22.23.2@7000',
      '22.23.5@65000',
      '22.23.5@7000',
    ]);
    // 18.x closes at exactly K: the entry value is 0 s.
    expect(planCases(byId('node-explicit-keepalive-18x')).map((c) => c.expectedMs)).toEqual([
      7000, 12000, 65000,
    ]);
  });

  it('Node explicit buffer: the buffer the entry value stands for is written and read back', () => {
    const zero = planCases(byId('node-explicit-buffer-22x-0'));
    expect(zero).toHaveLength(4);
    expect(zero.every((c) => c.args.includes('--buffer=0') && c.check.type === 'idleClose')).toBe(
      true,
    );
    expect(zero.map((c) => c.expectedMs).sort((a, b) => Number(a) - Number(b))).toEqual([
      7000, 7000, 65000, 65000,
    ]);
    const one = planCases(byId('node-explicit-buffer-22x-1'));
    expect(one).toHaveLength(2);
    expect(one.every((c) => c.args.includes('--buffer=1000') && c.expectedMs === 8000)).toBe(true);
  });

  it('gunicorn and uvicorn entries get the cases their worker classes name', () => {
    const labels = (id: string) => planCases(byId(id)).map((c) => c.args.join(' '));
    expect(labels('gunicorn-keepalive-uvicorn-worker-26x')).toEqual(['gunicorn-uvicorn']);
    expect(labels('gunicorn-keepalive-gthread-27x')).toEqual(['threads']);
    expect(labels('gunicorn-sync-worker-26x')).toEqual(['sync']);
    expect(labels('uvicorn-keepalive-0-54x')).toEqual(['uvicorn']);
    expect(labels('gunicorn-graceful-timeout-26x')).toEqual([
      'sync long',
      'gthread long',
      'uvicorn-worker long',
    ]);
    expect(labels('gunicorn-explicit-graceful-timeout-flag-27x')).toEqual([
      'sync-w2-graceful10 long',
      'gthread-graceful10 long',
      'uvicorn-worker-graceful10 long',
    ]);
    expect(labels('gunicorn-explicit-graceful-timeout-sync-env-conf-26x')).toEqual([
      'sync-env-graceful10 long',
      'sync-conf-graceful10 long',
    ]);
    expect(labels('uvicorn-explicit-graceful-timeout-0-54x')).toEqual([
      'uvicorn-graceful5 long',
      'uvicorn long',
    ]);
    expect(planCases(byId('gunicorn-keepalive-uvicorn-worker-27x'))[0]?.venv).toBe('g27');
    expect(planCases(byId('gunicorn-keepalive-uvicorn-worker-26x'))[0]?.venv).toBe('g26');
    expect(planCases(byId('uvicorn-keepalive-0-54x'))[0]?.venv).toBe('g26');
  });

  it('an explicit Python keepalive runs the smallest measured value; --full adds the largest', () => {
    const e = byId('gunicorn-explicit-keepalive-gthread-26x');
    const quick = planCases(e);
    expect(quick.map((c) => c.args)).toEqual([['gthread-keepalive', '7']]);
    expect(quick[0]?.expectedMs).toBe(7000);
    // tolerance at V s is V x 1000 x toleranceRelative + 1 ms (the entry's own rule)
    expect(quick[0]?.toleranceMs).toBe(e.toleranceMsAt?.['7']);
    const full = planCases(e, { full: true });
    expect(full.map((c) => c.args)).toEqual([
      ['gthread-keepalive', '7'],
      ['gthread-keepalive', '300', '400'],
    ]);
    expect(full[1]?.toleranceMs).toBe(e.toleranceMsAt?.['300']);
    // a non-proportional entry keeps its flat tolerance
    expect(planCases(byId('uvicorn-explicit-keepalive-0-54x')).map((c) => c.toleranceMs)).toEqual([
      6, 6,
    ]);
    expect(planCases(byId('gunicorn-explicit-keepalive-uvicorn-worker-27x'))[0]?.args).toEqual([
      'uvicorn-worker-keepalive',
      '3',
    ]);
  });

  it('lightship runs in k8s mode against the entry value in ms', () => {
    const [c, ...rest] = planCases(byId('lightship-shutdown-delay-9x'));
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      toolchain: 'lightship',
      args: ['k8s'],
      expectedMs: 5000,
      toleranceMs: byId('lightship-shutdown-delay-9x').toleranceMs,
      version: '9.1.0',
    });
  });

  it('every case agrees with its entry: script, range, tolerance', () => {
    for (const e of entries) {
      for (const c of planCases(e)) {
        expect(c.entryId).toBe(e.id);
        expect(c.script, `${e.id} ${c.label}`).toBe(e.scriptRef);
        expect(existsSync(join(ROOT, c.script)), c.script).toBe(true);
        expect(
          inRange(must(parseRange(e.applies.versionRange), e.id), c.version),
          `${e.id} ${c.version}`,
        ).toBe(true);
        if (e.toleranceRelative === undefined) expect(c.toleranceMs).toBe(e.toleranceMs);
        else expect(c.toleranceMs).toBeLessThanOrEqual(must(e.toleranceMs, 'tolerance'));
      }
    }
  });

  it('every entry without a stated reason or a deferral plans at least one case', () => {
    const reasons = new Set([
      ...statedReasons(entries).map((r) => r.entryId),
      ...deferredEntries(entries).map((d) => d.entryId),
    ]);
    for (const e of entries) {
      if (reasons.has(e.id)) expect(planCases(e), e.id).toEqual([]);
      else expect(planCases(e).length, e.id).toBeGreaterThan(0);
    }
  });

  it('the pinned versions of every case are the ones the entry names', () => {
    for (const e of entries) {
      const named = e.measuredVersions ?? (e.measuredOn ? [e.measuredOn.version] : []);
      for (const c of planCases(e)) expect(named, `${e.id} ${c.label}`).toContain(c.version);
    }
  });
});

describe('the planted-drift test: a changed entry value fails the lane comparison', () => {
  const b0 = recorded('2026-11-11-b0.jsonl');
  const line22 = must(
    b0.find((l) => l.version === '22.23.5'),
    'recorded Node 22.23.5 line',
  );

  it('the shipped entry agrees with the recorded measurement', () => {
    const v = compareLine(firstCase(byId('node-idle-close-22x'), '22.23.5'), line22);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
  });

  it('an entry planted one second off fails, naming measured, entry and tolerance', () => {
    for (const value of [5, 7, 6.5]) {
      const planted = copy(byId('node-idle-close-22x'), { value });
      const v = compareLine(firstCase(planted, '22.23.5'), line22);
      expect(v.ok, String(value)).toBe(false);
      expect(v.measured).toMatch(/^60\d\d ms$/);
      expect(v.entry).toBe(`${value * 1000} ms`);
      expect(v.tolerance).toBe('5 ms');
      expect(v.reason).toMatch(/differs by/);
      expect(formatVerdict(v)).toMatch(/^FAIL /);
    }
  });

  it('the edge is the tolerance, on both sides', () => {
    const c = firstCase(byId('node-idle-close-22x'), '22.23.5');
    const at = (ms: number) => compareLine(c, { ...line22, measured: { idleCloseMs: ms } }).ok;
    expect([5994, 5995, 6000, 6005, 6006].map(at)).toEqual([false, true, true, true, false]);
  });

  it('a tolerance planted too wide would pass a drifted value (so the edge test above bites)', () => {
    const wide = copy(byId('node-idle-close-22x'), { value: 7, toleranceMs: 1500 });
    expect(compareLine(firstCase(wide, '22.23.5'), line22).ok).toBe(true);
  });

  it('a relative tolerance is V x 1000 x rate + 1 ms and no more', () => {
    // the relative rule alone: the entry without its per-value table
    const e = copy(byId('gunicorn-explicit-keepalive-gthread-26x'));
    Reflect.deleteProperty(e as unknown as Record<string, unknown>, 'toleranceMsAt');
    const c = firstCase(e);
    const line = (ms: number): Record<string, unknown> => ({
      version: 'gunicorn 26.2.0',
      resolution: RES,
      observed: { workerClass: 'gthread' },
      measured: { idleCloseMs: ms },
    });
    expect([6970, 6971, 7029, 7030].map((ms) => compareLine(c, line(ms)).ok)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it('a line from another release than the one the entry pins is a failure, not a pass', () => {
    const c = firstCase(byId('node-idle-close-22x'), '22.23.5');
    const v = compareLine(c, { ...line22, version: '22.23.2' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/22\.23\.2/);
  });

  it('a line that does not say which version ran is a failure', () => {
    const c = firstCase(byId('node-idle-close-22x'), '22.23.5');
    const rest: Record<string, unknown> = { ...line22 };
    Reflect.deleteProperty(rest, 'version');
    expect(compareLine(c, rest).ok).toBe(false);
    expect(compareLine(c, { ...line22, version: 22 }).ok).toBe(false);
  });

  it('a missing, non-numeric or non-finite measurement is a failure, never a number', () => {
    const c = firstCase(byId('node-idle-close-22x'), '22.23.5');
    const bad: unknown[] = [
      null,
      'x',
      [],
      42,
      { version: '22.23.5', resolution: RES },
      { version: '22.23.5', resolution: RES, measured: null },
      { version: '22.23.5', resolution: RES, measured: {} },
      { version: '22.23.5', resolution: RES, measured: { idleCloseMs: '6001' } },
      { version: '22.23.5', resolution: RES, measured: { idleCloseMs: Number.NaN } },
      { version: '22.23.5', resolution: RES, measured: { idleCloseMs: Number.POSITIVE_INFINITY } },
      { version: '22.23.5', resolution: RES, measured: { idleCloseMs: null } },
      { version: '22.23.5', resolution: RES, measured: { idleCloseMs: true } },
    ];
    for (const line of bad) {
      const v = compareLine(c, line);
      expect(v.ok, JSON.stringify(line)).toBe(false);
      expect(v.reason).not.toBeNull();
    }
  });

  it('an explicit run must have read the setting back from the running server', () => {
    const c = must(
      planCases(byId('node-explicit-keepalive-22x')).find(
        (x) => x.version === '22.23.5' && x.args[0] === '7000' && x.args.length === 2,
      ),
      'case',
    );
    const good = {
      version: '22.23.5',
      resolution: RES,
      observed: { keepAliveTimeout: 7000, keepAliveTimeoutBuffer: 1000 },
      measured: { idleCloseMs: 8002 },
    };
    expect(compareLine(c, good).ok).toBe(true);
    expect(compareLine(c, { ...good, observed: { keepAliveTimeout: 7001 } }).ok).toBe(false);
    expect(compareLine(c, { ...good, observed: { keepAliveTimeout: null } }).ok).toBe(false);
    expect(compareLine(c, { ...good, observed: undefined }).ok).toBe(false);
    // 8002 is the right number only for K = 7000: the drifted entry (a buffer of 0) fails
    const drifted = copy(byId('node-explicit-keepalive-22x'), { value: 0 });
    const dc = must(
      planCases(drifted).find((x) => x.version === '22.23.5' && x.args[0] === '7000'),
      'drifted case',
    );
    expect(compareLine(dc, good).ok).toBe(false);
  });

  it('an explicit buffer run must have read back the buffer the case wrote', () => {
    const c = firstCase(byId('node-explicit-buffer-22x-0'), '22.23.5');
    const good = {
      version: '22.23.5',
      resolution: RES,
      observed: { keepAliveTimeout: 7000, keepAliveTimeoutBuffer: 0 },
      measured: { idleCloseMs: 7002 },
    };
    expect(compareLine(c, good).ok).toBe(true);
    expect(
      compareLine(c, {
        ...good,
        observed: { keepAliveTimeout: 7000, keepAliveTimeoutBuffer: 1000 },
      }).ok,
    ).toBe(false);
  });

  it('a gunicorn line must name the worker class the case asked for', () => {
    const c = firstCase(byId('gunicorn-keepalive-gthread-26x'));
    const good = {
      version: 'gunicorn 26.2.0',
      resolution: RES,
      observed: { workerClass: 'gthread' },
      measured: { idleCloseMs: 2003 },
    };
    expect(compareLine(c, good).ok).toBe(true);
    expect(compareLine(c, { ...good, observed: { workerClass: 'sync' } }).ok).toBe(false);
    expect(compareLine(c, { ...good, observed: { workerClass: null } }).ok).toBe(false);
    expect(compareLine(c, { ...good, version: 'gunicorn 27.0.0' }).ok).toBe(false);
    // the version is read for the entry's own runtime, not any version in the text
    expect(compareLine(c, { ...good, version: 'gunicorn 26.2.0 + uvicorn 27.0.0' }).ok).toBe(true);
    expect(compareLine(c, { ...good, version: 'uvicorn 26.2.0' }).ok).toBe(false);
  });

  it('the sync worker is N/A by measurement: it must close after the response, with Connection: close', () => {
    const c = firstCase(byId('gunicorn-sync-worker-26x'));
    const good = {
      version: 'gunicorn 26.2.0',
      resolution: RES,
      observed: { workerClass: 'sync' },
      measured: { closesAfterResponse: true, connectionCloseHeader: true, closeMs: 0 },
    };
    expect(compareLine(c, good).ok).toBe(true);
    const flip = (m: Record<string, unknown>) =>
      compareLine(c, { ...good, measured: { ...good.measured, ...m } }).ok;
    expect(flip({ closesAfterResponse: false, closeMs: null })).toBe(false);
    expect(flip({ connectionCloseHeader: false })).toBe(false);
    expect(flip({ closeMs: 7 })).toBe(false);
    expect(flip({ closeMs: 6 })).toBe(true);
    expect(compareLine(c, { ...good, observed: { workerClass: 'gthread' } }).ok).toBe(false);
  });

  it('a graceful ceiling is the time to the FIN, with the response cut', () => {
    const c = must(
      planCases(byId('gunicorn-graceful-timeout-26x')).find((x) => x.args[0] === 'sync'),
      'sync case',
    );
    const good = {
      version: 'gunicorn 26.2.0',
      resolution: POLL10,
      measured: {
        sigtermToConnectionClosedMs: 30010,
        connectionClose: 'fin',
        responseComplete: false,
      },
    };
    expect(compareLine(c, good).ok).toBe(true);
    const flip = (m: Record<string, unknown>) =>
      compareLine(c, { ...good, measured: { ...good.measured, ...m } }).ok;
    expect(flip({ sigtermToConnectionClosedMs: 30121 })).toBe(false);
    expect(flip({ sigtermToConnectionClosedMs: 29879 })).toBe(false);
    expect(flip({ connectionClose: 'reset' })).toBe(false);
    expect(flip({ responseComplete: true })).toBe(false);
    // the entry planted at 10 s instead of 30 s: the recorded 30 s run no longer agrees
    const drifted = copy(byId('gunicorn-graceful-timeout-26x'), { value: 10 });
    const dc = must(
      planCases(drifted).find((x) => x.args[0] === 'sync'),
      'drifted case',
    );
    expect(compareLine(dc, good).ok).toBe(false);
  });

  it('uvicorn alone has no ceiling: the long request must finish in full', () => {
    const c = must(
      planCases(byId('uvicorn-explicit-graceful-timeout-0-54x')).find(
        (x) => x.args[0] === 'uvicorn',
      ),
      'no-ceiling case',
    );
    const good = {
      version: 'uvicorn 0.54.0',
      resolution: POLL10,
      measured: {
        sigtermToConnectionClosedMs: 59451.6,
        connectionClose: 'fin',
        responseComplete: true,
      },
    };
    expect(compareLine(c, good).ok).toBe(true);
    expect(
      compareLine(c, { ...good, measured: { ...good.measured, responseComplete: false } }).ok,
    ).toBe(false);
    expect(
      compareLine(c, { ...good, measured: { ...good.measured, responseComplete: 'yes' } }).ok,
    ).toBe(false);
  });

  it('lightship: the handler starts at the entry value after SIGTERM', () => {
    const c = firstCase(byId('lightship-shutdown-delay-9x'));
    const line = (ms: unknown) => ({
      version: 'lightship 9.1.0',
      resolution: POLL20,
      measured: { sigtermToHandlerStartMs: ms },
    });
    const tol = c.toleranceMs;
    expect(
      [5000 - tol - 1, 5000 - tol, 5000 + tol, 5000 + tol + 1].map(
        (ms) => compareLine(c, line(ms)).ok,
      ),
    ).toEqual([false, true, true, false]);
    expect(compareLine(c, line(null)).ok).toBe(false);
  });

  it('a script whose resolution is coarser than the tolerance fails the comparison', () => {
    const c = firstCase(byId('node-idle-close-22x'), '22.23.5');
    const line = (resolution: unknown) => ({
      version: '22.23.5',
      resolution,
      measured: { idleCloseMs: 6001 },
    });
    expect(compareLine(c, line({ sweepStepMs: 1, injectedLatencyMs: 0 })).ok).toBe(true);
    // sweep step plus injected latency, equal to the tolerance (5 ms), is allowed; above it is not
    expect(compareLine(c, line({ sweepStepMs: 3, injectedLatencyMs: 2 })).ok).toBe(true);
    const over = compareLine(c, line({ sweepStepMs: 3, injectedLatencyMs: 3 }));
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/resolution of 6 ms is coarser than the tolerance of 5 ms/);
    // the poll interval of the graceful scripts is a resolution too, and adds to the others
    expect(compareLine(c, line({ pollMs: 6 })).ok).toBe(false);
    expect(compareLine(c, line({ pollMs: 5 })).ok).toBe(true);
    expect(compareLine(c, line({ sweepStepMs: 4, pollMs: 2 })).ok).toBe(false);
    // a line that states no resolution, or a nonsense one, is a failure, not a pass
    for (const bad of [
      undefined,
      null,
      {},
      7,
      { sweepStepMs: '1' },
      { pollMs: -1 },
      { pollMs: Number.NaN },
    ]) {
      const v = compareLine(c, line(bad));
      expect(v.ok, JSON.stringify(bad)).toBe(false);
      expect(v.reason).toMatch(/resolution/);
    }
  });

  it('the verdict line carries the three numbers a reader compares, in plain ASCII', () => {
    const v = compareLine(firstCase(byId('node-idle-close-22x'), '22.23.5'), line22);
    const text = formatVerdict(v);
    expect(text).toMatch(/^PASS +node-idle-close-22x/);
    expect(text).toContain('node 22.23.5');
    expect(text).toMatch(/measured 60\d\d ms/);
    expect(text).toContain('entry 6000 ms');
    expect(text).toContain('tolerance 5 ms');
    expect(text).toMatch(/margin [0-4] ms$/);
    expect(text).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('judging a lane', () => {
  const pass = (entryId: string): Verdict => ({
    ok: true,
    entryId,
    label: 'x',
    measured: '1 ms',
    entry: '1 ms',
    tolerance: '1 ms',
    margin: '0 ms',
    reason: null,
  });
  const fail = (entryId: string): Verdict => ({
    ...pass(entryId),
    ok: false,
    reason: 'differs by 9 ms',
  });
  const small = [
    byId('node-idle-close-18x'),
    byId('node-idle-close-20x'),
    byId('alb-idle-timeout-default'),
  ];

  it('passes only when every runnable entry has a passing case and none failed', () => {
    const r = judgeLane({
      entries: small,
      verdicts: [pass('node-idle-close-18x'), pass('node-idle-close-20x')],
    });
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^LANE PASS/);
    expect(r.lines.join('\n')).toContain('alb-idle-timeout-default');
    expect(r.lines.join('\n')).toMatch(/stated reason|not measurable locally/);
  });

  it('one failed case fails the lane', () => {
    const r = judgeLane({
      entries: small,
      verdicts: [
        pass('node-idle-close-18x'),
        fail('node-idle-close-20x'),
        pass('node-idle-close-20x'),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toMatch(/^LANE FAIL/);
  });

  it('an entry with no verdict at all fails the lane (nothing measured is not a pass)', () => {
    const r = judgeLane({ entries: small, verdicts: [pass('node-idle-close-18x')] });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/node-idle-close-20x.*no case/);
  });

  it('a verdict for an entry that is not in the knowledge base fails the lane (it is not a measurement of any entry)', () => {
    const r = judgeLane({
      entries: small,
      verdicts: [pass('node-idle-close-18x'), pass('node-idle-close-20x'), pass('somebody-else')],
    });
    expect(r.ok).toBe(false);
  });

  it('no verdicts at all is a failure, not an empty pass', () => {
    expect(judgeLane({ entries: [], verdicts: [] }).ok).toBe(false);
    expect(judgeLane({ entries: [byId('alb-idle-timeout-default')], verdicts: [] }).ok).toBe(false);
  });

  it('a release blocker fails the lane and is listed', () => {
    const tbm = copy(byId('node-idle-close-18x'), { id: 'planted-tbm', basis: 'to-be-measured' });
    const r = judgeLane({
      entries: [byId('node-idle-close-18x'), tbm],
      verdicts: [pass('node-idle-close-18x'), pass('planted-tbm')],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/release blocker.*planted-tbm/);
  });

  it('drift found by the latest lane (a newer version outside every range) fails the lane', () => {
    const r = judgeLane({
      entries: small,
      verdicts: [pass('node-idle-close-18x'), pass('node-idle-close-20x')],
      drift: ['node 27.0.0 is outside every range'],
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toContain('node 27.0.0 is outside every range');
  });
});

describe('the lane runner with a planted knowledge-base entry (fake server, recorded line)', () => {
  const b0 = recorded('2026-11-11-b0.jsonl');
  const line = must(
    b0.find((l) => l.version === '24.22.3'),
    'recorded Node 24.22.3 line',
  );
  const only24 = (e: RawEntry) => e.id === 'node-idle-close-24x';
  const shipped = entries.filter(only24);
  const replay = async (): Promise<unknown> => line;

  it('the shipped entry passes with the recorded measurement', async () => {
    const cases = shipped.flatMap((e) => planCases(e)).filter((c) => c.version === '24.22.3');
    const verdicts = await runCases(cases, replay, 2);
    const r = judgeLane({ entries: shipped, verdicts });
    expect(r.ok).toBe(true);
  });

  it('the same entry with a value that differs from the recording fails the lane', async () => {
    const planted = shipped.map((e) => copy(e, { value: 7 }));
    const cases = planted.flatMap((e) => planCases(e)).filter((c) => c.version === '24.22.3');
    const verdicts = await runCases(cases, replay, 2);
    const r = judgeLane({ entries: planted, verdicts });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/FAIL +node-idle-close-24x/);
    expect(r.lines.at(-1)).toMatch(/^LANE FAIL/);
  });

  it('a script that cannot measure (exit 4) or throws is a failure, never a pass', async () => {
    const cases = shipped.flatMap((e) => planCases(e)).filter((c) => c.version === '24.22.3');
    const v1 = await runCases(
      cases,
      async () => {
        throw new Error('could not measure: the server exited early');
      },
      1,
    );
    expect(v1.every((v) => !v.ok)).toBe(true);
    expect(v1[0]?.reason).toMatch(/could not measure/);
    expect(judgeLane({ entries: shipped, verdicts: v1 }).ok).toBe(false);
    const v2 = await runCases(cases, async () => undefined, 1);
    expect(v2.every((v) => !v.ok)).toBe(true);
  });

  it('runs every case once, in order of the plan, at most `jobs` at a time', async () => {
    const cases = planCases(byId('node-idle-close-22x'));
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    const verdicts = await runCases(
      cases,
      async (c) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(c.version);
        live--;
        return { ...line, version: c.version, measured: { idleCloseMs: 6001 } };
      },
      2,
    );
    expect(peak).toBe(2);
    expect(seen.sort()).toEqual(cases.map((c) => c.version).sort());
    expect(verdicts.map((v) => v.label)).toEqual(cases.map((c) => c.label));
    expect(verdicts.every((v) => v.ok)).toBe(true);
  });
});

describe('the latest lane: newest release per range, and a newer one outside every range', () => {
  const node = entries.filter(
    (e) => e.applies.runtime === 'node' && e.subject === 'node-idle-close',
  );

  it('picks the newest plain release inside each range, ignoring pre-releases and other lines', () => {
    const t = latestTargets(entries, {
      node: [
        '22.23.5',
        '22.23.6-rc.1',
        '22.24.0',
        '24.22.3',
        '26.13.1',
        '26.14.0-nightly',
        '25.9.0',
        '18.20.8',
        '20.20.2',
      ],
      gunicorn: ['26.2.0', '26.3.0', '27.0.0', '27.0.1', '27.1.0.dev1'],
      uvicorn: ['0.54.0', '0.54.1', '0.55.0'],
      lightship: ['9.1.0', '9.2.0'],
    });
    // Computed from the entries' ranges (B16): the newest plain release inside each Node range, so an entry
    // for another line needs no edit here. 25.9.0 is in the list only as "a line with no entry"; if an entry
    // for it exists it is expected too.
    const releases = ['22.23.5', '22.24.0', '24.22.3', '26.13.1', '25.9.0', '18.20.8', '20.20.2'];
    const newestIn = (range: string) => {
      const r = parseRange(range);
      const inside = releases.filter((v) => r !== null && inRange(r, v));
      return inside.sort((x, y) => x.localeCompare(y, 'en', { numeric: true })).pop();
    };
    const expected = [
      ...new Set(
        entries.map((e) => newestIn(e.applies.versionRange)).filter((v) => v !== undefined),
      ),
    ].sort((x, y) => (x as string).localeCompare(y as string, 'en', { numeric: true }));
    expect(t.node).toEqual(expected);
    for (const v of ['18.20.8', '20.20.2', '22.24.0', '24.22.3', '26.13.1'])
      expect(t.node).toContain(v);
    expect(t.node).not.toContain('22.23.5');
    expect(t.gunicorn).toEqual(['26.3.0', '27.0.1']);
    expect(t.uvicorn).toEqual(['0.54.1']);
    expect(t.lightship).toEqual(['9.2.0']);
  });

  it('finds nothing outside the ranges when the newest releases are the pinned ones', () => {
    expect(
      newerOutsideRanges(entries, {
        node: ['22.23.5', '24.22.3', '26.13.1'],
        gunicorn: ['26.2.0', '27.0.0'],
        uvicorn: ['0.54.0'],
        lightship: ['9.1.0'],
      }),
    ).toEqual([]);
  });

  it('flags a newer release that falls outside every range of its runtime', () => {
    const drift = newerOutsideRanges(entries, {
      node: ['27.0.0'],
      gunicorn: ['28.0.0'],
      uvicorn: ['0.55.0'],
      lightship: ['10.0.0'],
    });
    expect(drift).toHaveLength(4);
    expect(drift.join('\n')).toMatch(/node 27\.0\.0/);
    expect(drift.join('\n')).toMatch(/gunicorn 28\.0\.0/);
    expect(drift.join('\n')).toMatch(/uvicorn 0\.55\.0/);
    expect(drift.join('\n')).toMatch(/lightship 10\.0\.0/);
  });

  it('a release inside a range of another entry of the same runtime is covered', () => {
    expect(newerOutsideRanges(node, { node: ['26.99.0'] })).toEqual([]);
    expect(newerOutsideRanges(node, { node: ['21.0.0'] })).toHaveLength(1);
  });

  it('a runtime with no entry at all is drift, not silence', () => {
    expect(newerOutsideRanges(node, { gunicorn: ['26.2.0'] })).toHaveLength(1);
  });

  it('plans the cases for the newest release of each range, with the same expectations', () => {
    const e = byId('node-idle-close-22x');
    const cases = planCases(e, { versions: ['22.24.0'] });
    expect(cases.map((c) => c.version)).toEqual(['22.24.0']);
    expect(cases[0]?.expectedMs).toBe(6000);
    // a version outside the entry's range is never planned for it
    expect(planCases(e, { versions: ['23.0.0'] })).toEqual([]);
  });
});

describe('the runner program', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(MEASURE_DIR, 'lanes.mjs'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' },
      timeout: 30_000,
    });

  it('refuses an unknown lane or option with exit 2 and starts nothing', () => {
    for (const args of [
      [],
      ['nope'],
      ['pinned', '--jobs=0'],
      ['pinned', '--bogus'],
      ['pinned', '--jobs=x'],
    ]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/usage/);
      expect(r.stdout).toBe('');
    }
  });

  it('--list prints every case and every stated reason without running a server', () => {
    const r = run(['pinned', '--list']);
    expect(r.status).toBe(0);
    for (const e of entries) expect(r.stdout, e.id).toContain(e.id);
    expect(r.stdout).toMatch(/not measurable locally/);
    expect(r.stdout).not.toMatch(/\bPASS\b|\bFAIL\b/);
  });

  it('refuses to run, naming the entry and the field, when the knowledge base has a gap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-lanes-kb-'));
    try {
      const node = structuredClone(byId('node-idle-close-22x')) as unknown as Record<
        string,
        unknown
      >;
      Reflect.deleteProperty(node, 'scriptRef');
      writeFileSync(
        join(dir, 'planted.json'),
        JSON.stringify({ schemaVersion: 1, entries: [node] }),
      );
      for (const args of [['pinned', '--list'], ['pinned']]) {
        const r = run([...args, `--kb=${dir}`]);
        expect(r.status, args.join(' ')).toBe(1);
        expect(r.stderr).toContain('node-idle-close-22x');
        expect(r.stderr).toContain('scriptRef');
        expect(r.stdout).not.toMatch(/\bPASS\b/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs one script at a time by default: no parallel notice, jobs 1', () => {
    const r = run(['pinned', '--only=alb-idle-timeout-default']);
    expect(r.stdout).toMatch(/jobs 1\b/);
    expect(r.stdout).not.toContain('measurements ran in parallel; timing may be skewed');
  });

  // `--only` on an entry with a stated reason used to print `LANE FAIL (partial: --only): 0 of 0 cases`, which
  // reads as a failed measurement when nothing was asked to run. It is `NOT RUN`, exit 2, with the reason class.
  it('--only on an entry that carries a stated reason is NOT RUN (exit 2), never a lane failure', () => {
    const r = run(['pinned', '--only=alb-idle-timeout-default']);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(
      'NOT RUN (partial: --only): alb-idle-timeout-default carries a stated reason; nothing to measure',
    );
    expect(r.stdout).not.toContain('LANE FAIL');
    expect(r.stdout).not.toContain('LANE PASS');
    expect(r.stdout).not.toContain('0 of 0 cases');
  });

  it('--only on a deferred entry is NOT RUN (exit 2) and names the bolt it is deferred to', () => {
    const deferred = deferredEntries(entries)[0];
    expect(deferred, 'the knowledge base has a deferred entry').toBeDefined();
    const id = deferred?.entryId;
    const r = run(['pinned', `--only=${id}`]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain(
      `NOT RUN (partial: --only): ${id} is deferred to ${deferred?.bolt}; nothing to measure`,
    );
    expect(r.stdout).not.toContain('LANE FAIL');
  });

  it('an unknown --only entry is still a usage error (exit 2)', () => {
    const r = run(['pinned', '--only=no-such-entry']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no entry named/);
  });

  it('a higher --jobs prints the notice that timing may be skewed', () => {
    const r = run(['pinned', '--only=alb-idle-timeout-default', '--jobs=2']);
    expect(r.stdout).toMatch(/jobs 2\b/);
    expect(r.stdout).toContain('measurements ran in parallel; timing may be skewed');
  });
});

describe('m1: the tolerance of each case can see a one-second error', () => {
  it('every planned case, --full included, has a tolerance below 1 s, and a run 1 s out fails', () => {
    for (const e of entries) {
      for (const c of planCases(e, { full: true })) {
        expect(c.toleranceMs, `${e.id} ${c.label}`).toBeLessThan(1000);
        if (c.expectedMs === null) continue;
        const line = {
          version: c.runtime === 'node' ? c.version : `${c.runtime} ${c.version}`,
          resolution: { sweepStepMs: 0, injectedLatencyMs: 0, pollMs: 0 },
          observed: {
            ...(c.check.type === 'idleClose' ? c.check.observed : {}),
            workerClass: (c.check as { workerClass?: string }).workerClass,
          },
          measured: {
            idleCloseMs: c.expectedMs + 1000,
            sigtermToHandlerStartMs: c.expectedMs + 1000,
            sigtermToConnectionClosedMs: c.expectedMs + 1000,
            connectionClose: 'fin',
            responseComplete: false,
          },
        };
        expect(compareLine(c, line).ok, `${e.id} ${c.label}`).toBe(false);
      }
    }
  });

  it('the gthread 300 s case uses the tolerance its own observations give, not the relative one', () => {
    const e = byId('gunicorn-explicit-keepalive-gthread-26x');
    const [c7, c300] = planCases(e, { full: true });
    expect(c7?.toleranceMs).toBe(e.toleranceMsAt?.['7']);
    expect(c300?.toleranceMs).toBe(e.toleranceMsAt?.['300']);
    expect(c300?.toleranceMs ?? 9999).toBeLessThan(1000);
  });

  it('a value with no observations of its own falls back to the relative rule', () => {
    const e = copy(byId('gunicorn-explicit-keepalive-gthread-26x'), {
      toleranceMsAt: { '300': 590 },
    });
    const [c7] = planCases(e);
    expect(c7?.toleranceMs).toBe(Math.ceil(7000 * (e.toleranceRelative ?? 0) + 1));
  });
});

describe('m4: the summary says what was planned and what passed', () => {
  const v = (entryId: string, ok: boolean): Verdict => ({
    ok,
    entryId,
    label: 'x',
    measured: '1 ms',
    entry: '1 ms',
    tolerance: '1 ms',
    margin: '0 ms',
    reason: ok ? null : 'differs',
  });
  const two = [byId('node-idle-close-18x'), byId('node-idle-close-20x')];

  it('a failing run counts entries planned and entries passing, not "measured"', () => {
    const r = judgeLane({
      entries: two,
      verdicts: [v('node-idle-close-18x', true), v('node-idle-close-20x', false)],
    });
    const last = r.lines.at(-1) ?? '';
    expect(last).toMatch(
      /^LANE FAIL: 1 of 2 cases within tolerance, 2 entries planned, 1 entries passing,/,
    );
    expect(last).not.toMatch(/entries measured/);
  });

  it('an interrupted run (an entry nothing ran for) shows fewer passing than planned', () => {
    const r = judgeLane({ entries: two, verdicts: [v('node-idle-close-18x', true)] });
    expect(r.lines.at(-1)).toMatch(/2 entries planned, 1 entries passing/);
  });

  it('a lane over part of the knowledge base says so', () => {
    const r = judgeLane({
      entries: [two[0] as RawEntry],
      verdicts: [v('node-idle-close-18x', true)],
      partial: true,
    });
    expect(r.lines.at(-1)).toMatch(/^LANE PASS \(partial: --only\): /);
    const full = judgeLane({
      entries: [two[0] as RawEntry],
      verdicts: [v('node-idle-close-18x', true)],
    });
    expect(full.lines.at(-1)).toMatch(/^LANE PASS: /);
  });
});

describe('m8: the uvicorn worker runs on a uvicorn release an entry covers', () => {
  const worker = byId('gunicorn-keepalive-uvicorn-worker-26x');
  const line = (version: string, workerClass: string | null = 'uvicorn_worker.UvicornWorker') => ({
    version,
    resolution: RES,
    observed: { workerClass },
    measured: { idleCloseMs: 2002 },
  });
  const [c] = planCases(worker, { entries });

  it('the default case reads the worker class back, and the uvicorn release is required', () => {
    expect(c?.check).toMatchObject({
      workerClass: 'uvicorn_worker.UvicornWorker',
      companion: { runtime: 'uvicorn', ranges: ['>=0.54.0 <0.55.0'] },
    });
    const good = 'gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0';
    expect(compareLine(must(c, 'the case'), line(good)).ok).toBe(true);
    expect(compareLine(must(c, 'the case'), line(good, 'sync')).ok).toBe(false);
    expect(compareLine(must(c, 'the case'), line(good, null)).ok).toBe(false);
  });

  it('a uvicorn release outside every uvicorn range, or none stated, fails', () => {
    const v = compareLine(
      must(c, 'the case'),
      line('gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.55.0'),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/uvicorn 0\.55\.0 is not covered/);
    expect(compareLine(must(c, 'the case'), line('gunicorn 26.2.0')).ok).toBe(false);
    expect(
      compareLine(must(c, 'the case'), line('gunicorn 26.2.0 + uvicorn-worker 0.4.0')).ok,
    ).toBe(false);
  });

  it('the explicit and the graceful uvicorn-worker cases carry the same requirement', () => {
    for (const id of [
      'gunicorn-explicit-keepalive-uvicorn-worker-26x',
      'gunicorn-explicit-keepalive-uvicorn-worker-27x',
      'gunicorn-graceful-timeout-26x',
      'gunicorn-explicit-graceful-timeout-flag-27x',
    ]) {
      const cases = planCases(byId(id), { entries }).filter(
        (x) => x.args[0]?.startsWith('uvicorn-worker') || x.covers?.cls === 'uvicorn',
      );
      expect(cases.length, id).toBeGreaterThan(0);
      for (const x of cases) {
        expect((x.check as { companion?: unknown }).companion, `${id} ${x.label}`).toBeDefined();
      }
    }
    // the plain-gthread and sync cases have none
    const plain = planCases(byId('gunicorn-keepalive-gthread-26x'), { entries })[0];
    expect((plain?.check as { companion?: unknown } | undefined)?.companion).toBeUndefined();
  });
});

describe('m9: the plan must cover every class, source and value an entry names', () => {
  const gaps = (e: RawEntry) =>
    kbGaps([...entries.filter((x) => x.id !== e.id), e], MEASURE_DIR).filter(
      (g) => g.entryId === e.id,
    );

  it('shipped entries have no coverage gap', () => {
    for (const e of entries) expect(coverageGaps(e), e.id).toEqual([]);
  });

  it('a worker class no case runs is a gap, not a silent drop', () => {
    const e = copy(byId('gunicorn-keepalive-gthread-26x'), {
      applies: {
        runtime: 'gunicorn',
        versionRange: '>=26.2.0 <27.0.0',
        condition: 'workerClass in [gthread, gevent]',
      },
    });
    expect(
      gaps(e)
        .map((g) => g.message)
        .join(' '),
    ).toMatch(/no case covers worker class gevent/);
    const g2 = copy(byId('gunicorn-graceful-timeout-26x'), {
      applies: {
        runtime: 'gunicorn',
        versionRange: '>=26.2.0 <27.0.0',
        condition: 'workerClass in [sync, eventlet]',
      },
    });
    expect(
      gaps(g2)
        .map((g) => g.message)
        .join(' '),
    ).toMatch(/worker class eventlet/);
  });

  it('a source that has no case for a worker class is a gap', () => {
    const e = copy(byId('gunicorn-explicit-graceful-timeout-sync-env-conf-26x'), {
      applies: {
        runtime: 'gunicorn',
        versionRange: '>=26.2.0 <27.0.0',
        condition: 'workerClass in [sync, gthread]',
      },
    });
    expect(
      gaps(e)
        .map((g) => g.message)
        .join(' '),
    ).toMatch(/no case covers source env for worker class gthread/);
  });

  it('an options-form run for a release that is not pinned is a gap', () => {
    const e = copy(byId('node-explicit-keepalive-22x'), {
      measuredOptions: [{ k: 7, versions: ['22.23.5', '22.99.0'] }],
    });
    expect(
      gaps(e)
        .map((g) => g.message)
        .join(' '),
    ).toMatch(/options-form release 22\.99\.0 is not one of the pinned releases/);
  });

  it('a pinned release outside the range is a gap', () => {
    const e = copy(byId('node-idle-close-22x'), { measuredVersions: ['22.23.5', '24.0.0'] });
    expect(
      gaps(e)
        .map((g) => g.message)
        .join(' '),
    ).toMatch(/pinned release 24\.0\.0 is outside/);
  });

  it('an explicit entry whose only worker class has no case is a gap', () => {
    const f = copy(byId('gunicorn-explicit-keepalive-gthread-26x'), {
      applies: {
        runtime: 'gunicorn',
        versionRange: '>=26.2.0 <27.0.0',
        condition: 'workerClass in [gevent]',
      },
    });
    expect(gaps(f).length).toBeGreaterThan(0);
  });
});

describe('B2: judgeLane and a busy host', () => {
  const ok: Verdict = {
    ok: true,
    entryId: 'node-idle-close-18x',
    label: 'x',
    measured: '1 ms',
    entry: '1 ms',
    tolerance: '1 ms',
    margin: '0 ms',
    reason: null,
  };
  const one = [byId('node-idle-close-18x')];
  it('a passing busy run is labelled not official; a failing busy run stays LANE FAIL', () => {
    expect(judgeLane({ entries: one, verdicts: [ok], busy: true }).lines.at(-1)).toMatch(
      /^LANE PASS \(host was busy: not an official run\): /,
    );
    expect(
      judgeLane({
        entries: one,
        verdicts: [{ ...ok, ok: false, reason: 'x' }],
        busy: true,
      }).lines.at(-1),
    ).toMatch(/^LANE FAIL: /);
    expect(judgeLane({ entries: one, verdicts: [ok] }).lines.at(-1)).toMatch(/^LANE PASS: /);
  });
});

describe('m7: drift ignores the ranges of deferred and reasoned entries', () => {
  it('a release covered only by a deferred entry is outside every measured range', () => {
    const deferred = copy(byId('node-headers-trap-10x'), {
      applies: { runtime: 'node', versionRange: '>=0.0.0 <200.0.0' },
    });
    expect(
      newerOutsideRanges([byId('node-idle-close-22x'), deferred], { node: ['27.0.0'] }),
    ).toHaveLength(1);
    expect(newerOutsideRanges([byId('node-idle-close-22x')], { node: ['22.99.0'] })).toEqual([]);
  });
  it('a reasoned entry of the same runtime does not count either', () => {
    const reasoned = copy(byId('alb-idle-timeout-default'), {
      applies: { runtime: 'node', versionRange: '*' },
    });
    expect(
      newerOutsideRanges([byId('node-idle-close-22x'), reasoned], { node: ['27.0.0'] }),
    ).toHaveLength(1);
  });
});
