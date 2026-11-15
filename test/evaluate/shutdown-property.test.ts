// for the shutdown chain (bolt B4): no T2 or T3 PASS (and no T3 FAIL or WARN) ever rests on a value
// that is unresolved, assumed or `to be measured`, whatever combination of inputs the resolver hands the
// rules; a drain of unknown duration is never PASS (the terminus case of is a named fixture);
// NOT EVALUATED is exactly "T2 failed"; and the arithmetic of T3 is whole-millisecond exact. Seeded, so a
// failing case replays from its index.
import { describe, expect, it } from 'vitest';
import {
  type Basis,
  type ChainStep,
  type ChainValue,
  defaultSource,
  type Finding,
  fileSource,
  inputText,
  isNoteValue,
  isSourcedValue,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  type SourcedValue,
} from '../../src/core/index.js';
import { evaluateT2, evaluateT3 } from '../../src/evaluate/index.js';
import type { K8sPreStop } from '../../src/parse/index.js';
import type { InProcessDrain, ResolvedCeiling, ResolvedWorkload } from '../../src/resolve/index.js';
import { makeRng, type Rng } from '../support/prng.js';
import { shutdownDefaults } from '../support/shutdown-defaults.js';

const FILE = fileSource(inputText('k8s/x.yaml'), 3);

function read(n: number, unit: 's' | 'ms' = 's'): SourcedValue {
  return makeSourcedValue({ value: n, unit, source: FILE, basis: 'declared' });
}
function cited(n: number, basis: Basis, unit: 's' | 'ms' = 's'): SourcedValue {
  return makeSourcedValue({
    value: n,
    unit,
    source: defaultSource({ citation: 'test', basisText: basis }),
    basis,
  });
}
const BASES: readonly Basis[] = [
  'measured-on',
  'documented',
  'from-source-not-measured',
  'from-changelogs-not-measured',
  'to-be-measured',
  'assumed',
];

function randomPreStop(rng: Rng): K8sPreStop | undefined {
  switch (rng.int(0, 4)) {
    case 0:
      return undefined;
    case 1:
      return { form: 'hook', delay: makeUnresolved('hook'), source: FILE };
    case 2:
      return { form: 'sleep-handler', delay: read(rng.int(0, 20)), source: FILE };
    default:
      return { form: 'exec-sleep', delay: read(rng.int(1, 20)), source: FILE };
  }
}

function randomDrain(rng: Rng): InProcessDrain {
  switch (rng.int(0, 5)) {
    case 0:
      return { state: 'none' };
    case 1:
      return {
        state: 'unresolved',
        reason: 'r',
        kind: 'terminus',
        at: FILE,
        declare: ['declare it'],
      };
    case 2:
      return { state: 'not-read', why: 'source not linked: no evidence' };
    default:
      return {
        state: 'found',
        kind: rng.pick(['lightship', 'terminus', 'sigterm-handler'] as const),
        value: rng.int(0, 3) === 0 ? cited(rng.int(0, 10), rng.pick(BASES)) : read(rng.int(0, 10)),
        at: FILE,
        note: 'n',
        assumptions: [],
      };
  }
}

function randomCeiling(rng: Rng): ResolvedCeiling {
  if (rng.int(0, 2) === 0) return { state: 'unresolved', reason: 'none', declare: ['declare L'] };
  return {
    state: 'known',
    value: cited(rng.int(1, 40), rng.pick(BASES)),
    assumptions: [],
  };
}

function randomWorkload(rng: Rng): ResolvedWorkload {
  const base = shutdownDefaults();
  const graceForm = rng.int(0, 5);
  const grace =
    graceForm === 0
      ? makeUnresolved('not a number')
      : graceForm === 1
        ? cited(30, rng.pick(BASES))
        : read(rng.int(0, 120));
  const declaredDrain = rng.int(0, 3) === 0 ? read(rng.int(0, 20)) : undefined;
  const longestRequest = rng.int(0, 2) === 0 ? read(rng.int(0, 30)) : undefined;
  const preStop = randomPreStop(rng);
  const complete = rng.int(0, 2) !== 0;
  return {
    workload: { kind: 'Deployment', namespace: inputText('ns'), name: inputText('w') },
    file: FILE,
    linkState: rng.int(0, 12) === 0 ? 'unresolved-more-than-one-match' : 'linked',
    behindLb: { kind: 'alb', lbIdle: read(60), lbIdleSteps: [], declare: [] },
    server: { family: 'node' },
    idleCloseCandidates: [],
    idleClose: { candidates: [], problems: [], evidence: [], declare: [], explicitSetting: false },
    versionRanges: [],
    drainSearchComplete: complete,
    ...(complete ? {} : { drainSearchReason: 'incomplete' }),
    assumptions: [],
    ...base,
    grace,
    inProcessDrain: randomDrain(rng),
    ceiling: randomCeiling(rng),
    ...(preStop === undefined ? {} : { preStop }),
    ...(declaredDrain === undefined ? {} : { declaredDrain }),
    ...(longestRequest === undefined ? {} : { longestRequest }),
  };
}

function everyValue(finding: Finding): ChainValue[] {
  const out: ChainValue[] = [];
  const add = (steps: readonly ChainStep[]) => {
    for (const s of steps) out.push(s.value, ...(s.more ?? []));
  };
  add(finding.chain);
  return out;
}

function expectEstablished(finding: Finding): void {
  for (const v of everyValue(finding)) {
    expect(isUnresolved(v)).toBe(false);
    if (isSourcedValue(v)) {
      expect(v.basis).not.toBe('assumed');
      expect(v.basis).not.toBe('to-be-measured');
      expect(v.confidence).not.toBe('assumed');
    } else {
      expect(isNoteValue(v) || typeof v === 'object').toBe(true);
    }
  }
  expect(finding.demotedFrom).toBeUndefined();
}

describe('property: a T2 or T3 verdict never rests on an unverified value', () => {
  const rng = makeRng(20261112);
  const seen = new Map<string, number>();
  for (let i = 0; i < 4000; i += 1) {
    const w = randomWorkload(rng);
    const t2 = evaluateT2(w);
    const t3 = evaluateT3(w);
    seen.set(`T2 ${t2.kind}`, (seen.get(`T2 ${t2.kind}`) ?? 0) + 1);
    seen.set(`T3 ${t3.kind}`, (seen.get(`T3 ${t3.kind}`) ?? 0) + 1);
    if (t2.kind === 'PASS') {
      it(`case ${i}: T2 PASS has only established values`, () => expectEstablished(t2));
    }
    if (t3.kind === 'PASS' || t3.kind === 'FAIL' || t3.kind === 'WARN') {
      it(`case ${i}: T3 ${t3.kind} has only established values`, () => expectEstablished(t3));
    }
    it(`case ${i}: NOT EVALUATED exactly when T2 failed`, () => {
      expect(t3.kind === 'NOT EVALUATED').toBe(t2.kind === 'FAIL');
    });
    if (w.preStop?.form === 'hook') {
      it(`case ${i}: a preStop hook of unknown duration is UNRESOLVED for T2 and for T3 (never PASS)`, () => {
        if (w.linkState === 'linked') {
          expect(t2.kind).toBe('UNRESOLVED');
          expect(t3.kind).toBe('UNRESOLVED');
        }
      });
    }
    if (
      w.inProcessDrain.state === 'unresolved' &&
      w.declaredDrain === undefined &&
      w.linkState === 'linked'
    ) {
      it(`case ${i}: an in-process drain of unknown duration is UNRESOLVED for T2 and T3 unless declared`, () => {
        expect(t2.kind).toBe('UNRESOLVED');
        expect(t3.kind).toBe('UNRESOLVED');
      });
    }
    if (t2.kind === 'FAIL') {
      it(`case ${i}: T2 FAIL only after a complete search or a declared drain`, () => {
        expect(w.drainSearchComplete || w.declaredDrain !== undefined).toBe(true);
      });
    }
  }

  it('the generator reaches every verdict it is meant to test', () => {
    for (const key of [
      'T2 PASS',
      'T2 FAIL',
      'T2 UNRESOLVED',
      'T3 PASS',
      'T3 FAIL',
      'T3 WARN',
      'T3 UNRESOLVED',
      'T3 NOT EVALUATED',
    ]) {
      expect(seen.get(key) ?? 0, `no ${key} generated`).toBeGreaterThan(20);
    }
  });
});

describe('NAMED FIXTURE: a terminus beforeShutdown of unresolved duration', () => {
  const terminus: ResolvedWorkload = {
    ...randomWorkload(makeRng(1)),
    linkState: 'linked',
    server: { family: 'node' },
    drainSearchComplete: true,
    inProcessDrain: {
      state: 'unresolved',
      kind: 'terminus',
      reason: 'beforeShutdown has no delay that is a number written in the code',
      at: FILE,
      declare: ['declare drain.in_process_s for this workload in tripcurve.yaml'],
    },
    grace: read(45),
    preStop: { form: 'exec-sleep', delay: read(10), source: FILE },
    longestRequest: read(5),
  };
  const { declaredDrain: _declared, ...noDeclared } = terminus;

  it('T2 is UNRESOLVED and T3 is UNRESOLVED, with what to declare, even with a preStop and a declared L', () => {
    const t2 = evaluateT2(noDeclared as ResolvedWorkload);
    const t3 = evaluateT3(noDeclared as ResolvedWorkload);
    expect(t2.kind).toBe('UNRESOLVED');
    expect(t3.kind).toBe('UNRESOLVED');
    expect(t2.declare).toEqual(['declare drain.in_process_s for this workload in tripcurve.yaml']);
    expect(t3.declare).toEqual(['declare drain.in_process_s for this workload in tripcurve.yaml']);
  });
});

describe('property: the arithmetic of T3', () => {
  it('PASS exactly when grace >= preStop + drain + L + 1 s (declared L: PASS or FAIL; a ceiling: PASS or WARN)', () => {
    const rng = makeRng(11);
    const verdicts = new Map<string, number>();
    for (let i = 0; i < 3000; i += 1) {
      const grace = rng.int(0, 90);
      const pre = rng.int(1, 30);
      const drain = rng.int(0, 20);
      const l = rng.int(0, 40);
      const declared = rng.int(0, 1) === 0;
      const w: ResolvedWorkload = {
        ...randomWorkload(rng),
        linkState: 'linked',
        server: { family: 'gunicorn' },
        drainSearchComplete: true,
        grace: read(grace),
        preStop: { form: 'exec-sleep', delay: read(pre), source: FILE },
        declaredDrain: read(drain),
        inProcessDrain: { state: 'none' },
        ...(declared
          ? { longestRequest: read(l) }
          : {
              ceiling: { state: 'known' as const, value: cited(l, 'measured-on'), assumptions: [] },
            }),
      };
      const { longestRequest: _l, ...rest } = w;
      const subject = declared ? w : (rest as ResolvedWorkload);
      const f = evaluateT3(subject);
      const enough = grace >= pre + drain + l + 1;
      const expected = enough ? 'PASS' : declared ? 'FAIL' : 'WARN';
      expect(f.kind, `grace ${grace} pre ${pre} drain ${drain} L ${l} declared ${declared}`).toBe(
        expected,
      );
      verdicts.set(f.kind, (verdicts.get(f.kind) ?? 0) + 1);
    }
    for (const kind of ['PASS', 'FAIL', 'WARN']) {
      expect(verdicts.get(kind) ?? 0, kind).toBeGreaterThan(100);
    }
  });

  it('fractions of a second do not move a verdict (whole milliseconds)', () => {
    const w = (l: number): ResolvedWorkload => ({
      ...randomWorkload(makeRng(3)),
      linkState: 'linked',
      server: { family: 'gunicorn' },
      drainSearchComplete: true,
      grace: read(2),
      preStop: { form: 'exec-sleep', delay: read(1), source: FILE },
      declaredDrain: read(0.1),
      inProcessDrain: { state: 'none' },
      longestRequest: read(l),
    });
    // 1 + 0.1 + 0.2 + 0.7 + 1 would be 3.0000000000000004 in floats
    expect(
      evaluateT3({
        ...w(0.2),
        grace: read(3),
        declaredDrain: read(0.1),
        preStop: { form: 'exec-sleep', delay: read(1), source: FILE },
      }).headline,
    ).toBe('grace 3 s covers 1 s + 0.1 s + 0.2 s + 1 s');
    expect(evaluateT3({ ...w(0.2), grace: read(2) }).kind).toBe('FAIL');
  });
});
