// B8: "not measurable locally" is for services that cannot run on localhost, and
// only for a documented value. Runnable software that has not been measured yet is DEFERRED to a
// bolt, with the fact that stops it now, and is never counted as measured or as a pass.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deferredEntries,
  judgeLane,
  kbGaps,
  loadEntries,
  planCases,
  type RawEntry,
  releaseBlockerIds,
  statedReasons,
} from '../../measure/lib/lanes-core.mjs';
import { loadKbEntries } from '../../src/kb/schema.js';

const ROOT = join(import.meta.dirname, '..', '..');
const entries = loadEntries(join(ROOT, 'src', 'kb', 'data'));
const MEASURE = join(ROOT, 'measure');
const get = (id: string): RawEntry => {
  const e = entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(id);
  return e;
};
const copy = (e: RawEntry, patch: Record<string, unknown> = {}): RawEntry =>
  ({ ...structuredClone(e), ...patch }) as RawEntry;
const REASON = { notMeasurableLocally: 'it cannot run on localhost, says the contributor' };
const file = (...e: unknown[]) => ({ schemaVersion: 1, entries: e });

describe('a stated reason is valid only for a documented value of a service that cannot run locally', () => {
  it("the reviewer's repro: node-idle-close-22x with a reason and value 99 is a gap, and the lane fails", () => {
    const planted = copy(get('node-idle-close-22x'), { value: 99, scriptRef: REASON });
    delete (planted as unknown as Record<string, unknown>).toleranceMs;
    const gaps = kbGaps([...entries.filter((e) => e.id !== planted.id), planted], MEASURE);
    const mine = gaps.filter((g) => g.entryId === 'node-idle-close-22x');
    expect(mine.map((g) => g.field)).toContain('scriptRef');
    expect(mine.map((g) => g.message).join(' ')).toMatch(
      /never "not measurable locally"|not allowed/,
    );
    // even with the gap check skipped, the lane judges an entry nothing ran for as a failure
    const r = judgeLane({ entries: [planted], verdicts: [] });
    expect(r.ok).toBe(false);
    expect(statedReasons([planted])).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/FAIL +node-idle-close-22x +no case ran/);
  });

  const cases: readonly (readonly [string, RawEntry, RegExp])[] = [
    [
      'a measured entry',
      copy(get('alb-idle-timeout-default'), { basis: 'measured' }),
      /documented/,
    ],
    [
      'a from-source entry',
      copy(get('alb-idle-timeout-default'), { basis: 'from-source' }),
      /documented/,
    ],
    [
      'a gunicorn entry, even documented',
      copy(get('gunicorn-keepalive-gthread-26x'), { basis: 'documented', scriptRef: REASON }),
      /gunicorn has measurement scripts/,
    ],
    [
      'a uvicorn entry',
      copy(get('uvicorn-keepalive-0-54x'), { basis: 'documented', scriptRef: REASON }),
      /uvicorn has measurement scripts/,
    ],
    [
      'a lightship entry',
      copy(get('lightship-shutdown-delay-9x'), { basis: 'documented', scriptRef: REASON }),
      /lightship has measurement scripts/,
    ],
    [
      'a node entry, even documented',
      copy(get('node-idle-close-22x'), { basis: 'documented', scriptRef: REASON }),
      /node has measurement scripts/,
    ],
    [
      'a runtime that is not on the list',
      copy(get('alb-idle-timeout-default'), { applies: { runtime: 'redis', versionRange: '*' } }),
      /closed list/,
    ],
    [
      'a subject that is not on the list',
      copy(get('alb-idle-timeout-default'), { subject: 'node-idle-close' }),
      /closed list/,
    ],
  ];
  for (const [label, entry, message] of cases) {
    it(`is a gap for ${label}`, () => {
      const gaps = kbGaps([...entries.filter((e) => e.id !== entry.id), entry], MEASURE).filter(
        (g) => g.entryId === entry.id,
      );
      expect(gaps.map((g) => g.field)).toContain('scriptRef');
      expect(gaps.map((g) => g.message).join(' ')).toMatch(message);
    });
  }

  it('the nine entries of the closed list keep their reason, and no gap is found', () => {
    const ids = [
      'alb-idle-timeout-default',
      'k8s-grace-period-default',
      'terraform-lb-idle-timeout-default',
      'terraform-sqs-visibility-default',
      'terraform-lambda-timeout-default',
      'lambda-sqs-batching-window-default',
      'cfn-lb-idle-timeout-default',
      'cfn-sqs-visibility-default',
      'cfn-lambda-timeout-default',
    ];
    expect(
      statedReasons(entries)
        .map((r) => r.entryId)
        .sort(),
    ).toEqual([...ids].sort());
    expect(kbGaps(entries, MEASURE)).toEqual([]);
  });

  it('the schema loader refuses the same repros: a measured entry, a node entry, a headers-trap entry', () => {
    const alb = get('alb-idle-timeout-default');
    expect(() => loadKbEntries([file(alb)])).not.toThrow();
    expect(() => loadKbEntries([file({ ...alb, basis: 'measured' })])).toThrow(
      /scriptRef|measuredOn/,
    );
    expect(() => loadKbEntries([file({ ...alb, basis: 'from-source' })])).toThrow(/documented/);
    const trap = get('node-headers-trap-12x');
    const { deferredTo: _drop, ...rest } = trap;
    expect(() => loadKbEntries([file({ ...rest, scriptRef: REASON })])).toThrow(/scriptRef/);
  });
});

describe('the old-Node trap entries are deferred, not "not measurable locally"', () => {
  const trapIds = ['node-headers-trap-10x', 'node-headers-trap-12x', 'node-headers-trap-13x'];

  it('they carry deferredTo B13 with the fact that stops the measurement, and no script and no reason', () => {
    expect(
      deferredEntries(entries)
        .map((d) => d.entryId)
        .sort(),
    ).toEqual(trapIds);
    for (const id of trapIds) {
      const e = get(id);
      expect(e.deferredTo?.bolt, id).toBe('B13');
      expect(e.deferredTo?.reason, id).toMatch(/Rosetta 2 is absent/);
      expect(e.deferredTo?.reason, id).toMatch(/arch -x86_64/);
      expect(e.scriptRef, id).toBeUndefined();
      expect(planCases(e), id).toEqual([]);
    }
    expect(statedReasons(entries).map((r) => r.entryId)).not.toEqual(
      expect.arrayContaining(trapIds),
    );
  });

  it('they are not release blockers (their basis from changelogs is allowed), and no gap is found', () => {
    expect(releaseBlockerIds(entries)).toEqual([]);
    expect(kbGaps(entries, MEASURE)).toEqual([]);
    for (const id of trapIds) expect(get(id).basis).toBe('from-changelogs');
  });

  it('the lane prints them as DEFERRED (B13), counts them apart, and never as a pass', () => {
    const trap = get('node-headers-trap-10x');
    const r = judgeLane({ entries: [trap], verdicts: [] });
    const line = r.lines.find((l) => l.includes('node-headers-trap-10x')) ?? '';
    expect(line).toMatch(/^DEFERRED \(B13\) +node-headers-trap-10x +not measured:/);
    expect(line).not.toMatch(/PASS/);
    const last = r.lines.at(-1) ?? '';
    expect(last).toMatch(/1 deferred and not measured/);
    expect(last).toMatch(/0 carry a stated reason/);
    expect(last).toMatch(/0 entries planned/);
    expect(last).not.toMatch(/entries passing, 0 carry a stated reason, 0 deferred/);
    // nothing else ran, so the lane has no measurement to pass on
    expect(r.ok).toBe(false);
  });

  it('a deferred entry beside a passing one does not fail the lane, and is still listed as unmeasured', () => {
    const node = get('node-idle-close-18x');
    const r = judgeLane({
      entries: [node, get('node-headers-trap-10x')],
      verdicts: [
        {
          ok: true,
          entryId: node.id,
          label: 'x',
          measured: '5001 ms',
          entry: '5000 ms',
          tolerance: '5 ms',
          margin: '4 ms',
          reason: null,
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toMatch(/DEFERRED \(B13\)/);
    expect(r.lines.at(-1)).toMatch(
      /1 entries planned, 1 entries passing, 0 carry a stated reason, 1 deferred and not measured/,
    );
  });

  const bad: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    ['a script as well', { scriptRef: 'measure/node-idle-close.mjs' }, /not both/],
    ['a reason as well', { scriptRef: REASON }, /not both/],
    [
      'a bolt that is not B<number>',
      { deferredTo: { bolt: 'later', reason: 'x y' } },
      /deferredTo/,
    ],
    ['no reason', { deferredTo: { bolt: 'B13', reason: '  ' } }, /deferredTo/],
    ['a measured basis', { basis: 'measured' }, /unmeasured/],
    ['a documented basis', { basis: 'documented' }, /unmeasured/],
  ];
  for (const [label, patch, message] of bad) {
    it(`is a gap in the lane and a refusal in the loader: ${label}`, () => {
      const planted = copy(get('node-headers-trap-10x'), patch);
      const gaps = kbGaps([...entries.filter((e) => e.id !== planted.id), planted], MEASURE).filter(
        (g) => g.entryId === planted.id,
      );
      expect(gaps.map((g) => g.field)).toContain('deferredTo');
      expect(gaps.map((g) => g.message).join(' ')).toMatch(message);
      expect(() => loadKbEntries([file(planted)])).toThrow(/deferredTo|scriptRef|measuredOn/);
    });
  }

  it('the loader accepts a well-formed deferredTo and nothing else in its place', () => {
    const trap = get('node-headers-trap-10x');
    expect(() => loadKbEntries([file(trap)])).not.toThrow();
    expect(() =>
      loadKbEntries([file({ ...trap, deferredTo: { ...trap.deferredTo, extra: 1 } })]),
    ).toThrow(/deferredTo.extra/);
    expect(() => loadKbEntries([file({ ...trap, toleranceMs: 5 })])).toThrow(/toleranceMs/);
  });
});

describe('B1 (second review): deferredTo is valid only for the old-Node trap entries', () => {
  const repro = (): RawEntry => {
    const e = copy(get('node-idle-close-22x'), {
      basis: 'from-source',
      value: 99,
      deferredTo: { bolt: 'B99', reason: 'later' },
    });
    for (const k of ['scriptRef', 'toleranceMs', 'measuredOn', 'measuredVersions', 'measuredKs']) {
      Reflect.deleteProperty(e as unknown as Record<string, unknown>, k);
    }
    return e;
  };

  it("the reviewer's repro is a gap in the lane check, a refusal in the loader, and not a lane pass", () => {
    const e = repro();
    const gaps = kbGaps([...entries.filter((x) => x.id !== e.id), e], MEASURE).filter(
      (g) => g.entryId === e.id,
    );
    expect(gaps.map((g) => g.field)).toContain('deferredTo');
    expect(gaps.map((g) => g.message).join(' ')).toMatch(/node-headers-timeout-trap/);
    expect(() => loadKbEntries([file(e)])).toThrow(/deferredTo/);
    expect(deferredEntries([e])).toEqual([]);
    const r = judgeLane({ entries: [e], verdicts: [] });
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/FAIL +node-idle-close-22x +no case ran/);
  });

  const trap = () => get('node-headers-trap-10x');
  const bad: readonly (readonly [string, Record<string, unknown>])[] = [
    ['another subject', { subject: 'node-idle-close' }],
    ['a gunicorn subject', { subject: 'gunicorn-keepalive' }],
    ['a from-source basis', { basis: 'from-source' }],
    ['a to-be-measured basis', { basis: 'to-be-measured' }],
  ];
  for (const [label, patch] of bad) {
    it(`is a gap and a refusal for ${label}`, () => {
      const e = copy(trap(), patch);
      const gaps = kbGaps([...entries.filter((x) => x.id !== e.id), e], MEASURE).filter(
        (g) => g.entryId === e.id,
      );
      expect(gaps.map((g) => g.field)).toContain('deferredTo');
      expect(() => loadKbEntries([file(e)])).toThrow(/deferredTo|subject|node-headers/);
      expect(deferredEntries([e])).toEqual([]);
    });
  }

  it('the three shipped trap entries stay valid', () => {
    for (const id of ['node-headers-trap-10x', 'node-headers-trap-12x', 'node-headers-trap-13x']) {
      expect(() => loadKbEntries([file(get(id))])).not.toThrow();
    }
    expect(deferredEntries(entries)).toHaveLength(3);
  });
});

describe('m5 (second review): every value the plan runs has its own tolerance', () => {
  const g = () => get('gunicorn-explicit-keepalive-gthread-26x');
  it('a proportional entry without the max-of-span key is a gap and a loader refusal', () => {
    const e = copy(g());
    const at = { ...(e.toleranceMsAt ?? {}) } as Record<string, number>;
    delete at['300'];
    const planted = copy(e, { toleranceMsAt: at });
    const gaps = kbGaps([...entries.filter((x) => x.id !== planted.id), planted], MEASURE).filter(
      (x) => x.entryId === planted.id,
    );
    expect(gaps.map((x) => x.field)).toContain('toleranceMsAt');
    expect(gaps.map((x) => x.message).join(' ')).toMatch(/300/);
    expect(() => loadKbEntries([file(planted)])).toThrow(/toleranceMsAt/);
  });
  it('the min key is required too, and a table is required at all', () => {
    for (const key of ['7']) {
      const at = { ...(g().toleranceMsAt ?? {}) } as Record<string, number>;
      delete at[key];
      const planted = copy(g(), { toleranceMsAt: at });
      expect(() => loadKbEntries([file(planted)])).toThrow(/toleranceMsAt/);
    }
    const none = copy(g());
    Reflect.deleteProperty(none as unknown as Record<string, unknown>, 'toleranceMsAt');
    expect(() => loadKbEntries([file(none)])).toThrow(/toleranceMsAt/);
    expect(
      kbGaps([...entries.filter((x) => x.id !== none.id), none], MEASURE).map((x) => x.field),
    ).toContain('toleranceMsAt');
  });
  it('the shipped entries pass', () => {
    expect(kbGaps(entries, MEASURE)).toEqual([]);
    for (const id of [
      'gunicorn-explicit-keepalive-gthread-26x',
      'gunicorn-explicit-keepalive-gthread-27x',
    ]) {
      expect(Object.keys(get(id).toleranceMsAt ?? {})).toEqual(
        expect.arrayContaining(['7', '300']),
      );
    }
  });
});

describe('m1: toleranceMsAt in the loader', () => {
  const g = get('gunicorn-explicit-keepalive-gthread-26x');
  it('accepts values inside the span for an entry with a relative tolerance', () => {
    expect(() =>
      loadKbEntries([file({ ...g, toleranceMsAt: { '7': 25, '300': 590 } })]),
    ).not.toThrow();
  });
  for (const [label, at] of [
    ['a value outside the span', { '1': 25 }],
    ['a value that is not a whole number', { '7.5': 25 }],
    ['a tolerance of zero', { '7': 0 }],
    ['a tolerance that is not a number', { '7': '25' }],
    ['an empty table', {}],
  ] as const) {
    it(`refuses ${label}`, () => {
      expect(() => loadKbEntries([file({ ...g, toleranceMsAt: at })])).toThrow(/toleranceMsAt/);
    });
  }
  it('refuses a table without a relative tolerance', () => {
    const { toleranceRelative: _r, ...rest } = g;
    expect(() => loadKbEntries([file({ ...rest, toleranceMsAt: { '7': 25 } })])).toThrow(
      /toleranceMsAt/,
    );
  });
});
