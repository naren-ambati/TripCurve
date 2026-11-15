// The second property: no T1 PASS (and no T1 FAIL) ever rests on an
// unresolved, assumed or `to be measured` value, whatever combination of inputs the
// resolver hands the rule. Seeded, so a failing case replays from its index.
import { describe, expect, it } from 'vitest';
import {
  type Basis,
  type ChainStep,
  type ChainValue,
  defaultSource,
  type Finding,
  fileSource,
  inputText,
  isSourcedValue,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  type SourcedValue,
} from '../../src/core/index.js';
import { evaluateT1 } from '../../src/evaluate/index.js';
import type { Candidate, ResolvedWorkload } from '../../src/resolve/index.js';
import { makeRng, type Rng } from '../support/prng.js';
import { shutdownDefaults } from '../support/shutdown-defaults.js';

const FILE = fileSource(inputText('k8s/x.yaml'), 3);

function read(n: number, unit: 's' | 'ms' = 's'): SourcedValue {
  return makeSourcedValue({ value: n, unit, source: FILE, basis: 'declared' });
}

function cited(n: number, basis: Basis): SourcedValue {
  return makeSourcedValue({
    value: n,
    unit: 's',
    source: defaultSource({ citation: 'test', basisText: basis }),
    basis,
  });
}

const KB_BASES: readonly Basis[] = [
  'measured-on',
  'documented',
  'from-source-not-measured',
  'from-changelogs-not-measured',
  'to-be-measured',
];

function randomResolved(rng: Rng): ResolvedWorkload {
  const lbKind = rng.pick(['alb', 'alb', 'alb', 'nlb', 'several'] as const);
  const lbForm = rng.int(0, 4);
  const n = rng.int(1, 120);
  const lbIdle =
    lbForm === 0
      ? read(n)
      : lbForm === 1
        ? makeSourcedValue({
            value: n,
            unit: 's',
            source: defaultSource({ citation: 'alb', basisText: 'documented' }),
            basis: 'assumed',
          })
        : lbForm === 2
          ? makeUnresolved('some reason')
          : lbForm === 3
            ? read(n * 1000, 'ms')
            : read(n);
  const candidates: Candidate[] = [];
  const count = rng.int(0, 3);
  for (let i = 0; i < count; i += 1) {
    const basis = rng.pick(KB_BASES);
    candidates.push({
      condition: `range ${i}`,
      value: cited(rng.int(1, 120), basis),
      basis: basis === 'measured-on' ? 'measured' : 'documented',
      // sometimes the flag lies: the factory must still refuse a to-be-measured value
      supportsPass: basis !== 'to-be-measured' || rng.int(0, 3) === 0,
    });
  }
  const evidence: ChainStep[] = [];
  const problems = [];
  if (rng.int(0, 4) === 0) {
    const value = makeUnresolved('evidence problem');
    problems.push({ label: 'source', value });
  }
  if (rng.int(0, 4) === 0) evidence.push({ label: 'Node 22.23', value: cited(1, 'assumed') });
  if (rng.int(0, 4) === 0) evidence.push({ label: 'keepAliveTimeout', value: read(5000, 'ms') });
  return {
    workload: { kind: 'Deployment', namespace: inputText('ns'), name: inputText('w') },
    file: FILE,
    linkState: rng.int(0, 9) === 0 ? 'unresolved-more-than-one-match' : 'linked',
    behindLb: {
      kind: lbKind,
      lbIdle,
      lbIdleSteps: [{ label: 'LB idle', value: lbIdle }],
      declare: [],
    },
    server: { family: 'node' },
    idleCloseCandidates: candidates,
    idleClose: {
      candidates,
      problems,
      evidence,
      declare: [],
      explicitSetting: false,
    },
    versionRanges: [],
    drainSearchComplete: true,
    assumptions: [],
    ...shutdownDefaults(),
  };
}

function everyValue(finding: Finding): ChainValue[] {
  const out: ChainValue[] = [];
  const add = (steps: readonly ChainStep[]) => {
    for (const s of steps) out.push(s.value, ...(s.more ?? []));
  };
  add(finding.chain);
  for (const b of finding.branches ?? []) add(b.chain);
  return out;
}

describe('property: a T1 PASS or FAIL never rests on an unverified value', () => {
  const rng = makeRng(20261111);
  const kinds = new Map<string, number>();
  for (let i = 0; i < 3000; i += 1) {
    const w = randomResolved(rng);
    const finding = evaluateT1(w);
    kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);
    if (finding.kind !== 'PASS' && finding.kind !== 'FAIL') continue;
    it(`case ${i}: ${finding.kind} has only established values`, () => {
      const values = everyValue(finding);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(isUnresolved(v)).toBe(false);
        if (isSourcedValue(v)) {
          expect(v.basis).not.toBe('assumed');
          expect(v.basis).not.toBe('to-be-measured');
          expect(v.confidence).not.toBe('assumed');
        }
      }
      expect(finding.demotedFrom).toBeUndefined();
    });
  }

  it('the generator reaches every verdict it is meant to test', () => {
    for (const kind of ['PASS', 'FAIL', 'UNRESOLVED', 'VERSION-DEPENDENT']) {
      expect(kinds.get(kind) ?? 0, `no ${kind} generated`).toBeGreaterThan(20);
    }
  });
});

describe('property: the arithmetic of the comparison', () => {
  it('PASS exactly when the idle close is strictly greater than the LB idle (equal is FAIL)', () => {
    const rng = makeRng(7);
    let passes = 0;
    let fails = 0;
    for (let i = 0; i < 2000; i += 1) {
      const idle = rng.int(1, 100);
      const lb = rng.int(1, 100);
      const candidate: Candidate = {
        condition: 'r',
        value: cited(idle, 'measured-on'),
        basis: 'measured',
        supportsPass: true,
      };
      const lbValue = read(lb);
      const w: ResolvedWorkload = {
        ...randomResolved(rng),
        linkState: 'linked',
        behindLb: {
          kind: 'alb',
          lbIdle: lbValue,
          lbIdleSteps: [{ label: 'LB idle', value: lbValue }],
          declare: [],
        },
        idleCloseCandidates: [candidate],
        idleClose: {
          candidates: [candidate],
          problems: [],
          evidence: [],
          declare: [],
          explicitSetting: false,
        },
      };
      const finding = evaluateT1(w);
      expect(finding.kind).toBe(idle > lb ? 'PASS' : 'FAIL');
      if (finding.kind === 'PASS') passes += 1;
      else fails += 1;
    }
    expect(passes).toBeGreaterThan(100);
    expect(fails).toBeGreaterThan(100);
  });

  it('the LB idle in milliseconds is compared in seconds', () => {
    const lbValue = read(5000, 'ms');
    const candidate: Candidate = {
      condition: 'r',
      value: cited(6, 'measured-on'),
      basis: 'measured',
      supportsPass: true,
    };
    const base = randomResolved(makeRng(1));
    const finding = evaluateT1({
      ...base,
      linkState: 'linked',
      behindLb: {
        kind: 'alb',
        lbIdle: lbValue,
        lbIdleSteps: [{ label: 'LB idle', value: lbValue }],
        declare: [],
      },
      idleCloseCandidates: [candidate],
      idleClose: {
        candidates: [candidate],
        problems: [],
        evidence: [],
        declare: [],
        explicitSetting: false,
      },
    });
    expect(finding.kind).toBe('PASS');
    expect(finding.headline).toBe('idle close 6 s is longer than LB idle 5 s');
  });
});
