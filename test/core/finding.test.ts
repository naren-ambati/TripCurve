import { describe, expect, it } from 'vitest';
import {
  type Basis,
  BRANCH_UNRESOLVED_TO_BE_MEASURED,
  type ChainStep,
  countsAsPassed,
  declaredSource,
  defaultSource,
  type Finding,
  type FindingInput,
  fileSource,
  inputText,
  makeFinding,
  makeSourcedValue,
  makeUnresolved,
  noteExpiredWaiver,
  PASS_REFUSAL_HEADLINES,
  passBlocker,
  RESULT_KINDS,
  type RuleResultKind,
  WAIVABLE_KINDS,
  type WaiverInfo,
  type WorkloadRef,
  waiveFinding,
} from '../../src/core/index.js';
import { makeRng } from '../support/prng.js';

const subject: WorkloadRef = {
  kind: 'Deployment',
  namespace: inputText('default'),
  name: inputText('web'),
};

const fileValue = (n: number): ChainStep['value'] =>
  makeSourcedValue({
    value: n,
    unit: 's',
    source: fileSource(inputText('k8s/a.yaml'), 3),
    basis: 'declared',
  });

function defaultValue(basis: Basis, n = 6): ChainStep['value'] {
  return makeSourcedValue({
    value: n,
    unit: 's',
    source: defaultSource({ citation: 'Node keepAliveTimeout 5 s + buffer 1 s', basisText: 'x' }),
    basis,
  });
}

const step = (label: string, value: ChainStep['value']): ChainStep => ({ label, value });

function input(
  kind: RuleResultKind,
  chain: ChainStep[],
  headline = 'idle close 6 s is longer than 5 s',
): FindingInput {
  return { rule: 'T1', subject, kind, headline, chain };
}

describe('PASS factory', () => {
  it('keeps a PASS whose chain is all established', () => {
    const f = makeFinding(
      input('PASS', [step('idle close', fileValue(75)), step('LB idle', fileValue(60))]),
    );
    expect(f.kind).toBe('PASS');
    expect(f.demotedFrom).toBeUndefined();
    expect(countsAsPassed(f)).toBe(true);
  });

  it.each<[Basis]>([
    ['measured-on'],
    ['documented'],
    ['from-source-not-measured'],
    ['from-changelogs-not-measured'],
  ])('lets a default with basis %s support PASS, and keeps the basis', (basis) => {
    const v = defaultValue(basis);
    const f = makeFinding(input('PASS', [step('idle close', v)]));
    expect(f.kind).toBe('PASS');
    expect(f.chain[0]?.value).toBe(v);
  });

  it('converts a PASS resting on an assumed value to UNRESOLVED instead of throwing', () => {
    const f = makeFinding(input('PASS', [step('LB idle', defaultValue('assumed', 60))]));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotedFrom).toBe('PASS');
    expect(f.demotionReason).toBe('assumed-value');
    expect(f.headline).toBe(PASS_REFUSAL_HEADLINES['assumed-value']);
    expect(countsAsPassed(f)).toBe(false);
  });

  it('converts a PASS resting on an unresolved value to UNRESOLVED', () => {
    const f = makeFinding(
      input('PASS', [step('drain', makeUnresolved('beforeShutdown duration unknown'))]),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotionReason).toBe('unresolved-value');
  });

  it('converts a PASS resting on a to-be-measured default to UNRESOLVED', () => {
    const f = makeFinding(input('PASS', [step('idle close', defaultValue('to-be-measured'))]));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotionReason).toBe('to-be-measured-default');
  });

  it('refuses even when only one of several chain values is unverified', () => {
    const f = makeFinding(
      input('PASS', [
        step('a', fileValue(1)),
        step('b', fileValue(2)),
        step('c', defaultValue('to-be-measured')),
      ]),
    );
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('looks inside branches too', () => {
    const f = makeFinding({
      ...input('PASS', [step('a', fileValue(1))]),
      branches: [{ range: 'Node 24.x', outcome: BRANCH_UNRESOLVED_TO_BE_MEASURED, chain: [] }],
    });
    expect(f.kind).toBe('UNRESOLVED');
    const g = makeFinding({
      ...input('PASS', [step('a', fileValue(1))]),
      branches: [{ range: 'Node 24.x', outcome: 'PASS', chain: [step('x', makeUnresolved('r'))] }],
    });
    expect(g.kind).toBe('UNRESOLVED');
  });

  it('a declared value from tripcurve.yaml is established', () => {
    const v = makeSourcedValue({
      value: 5,
      unit: 's',
      source: declaredSource(inputText('tripcurve.yaml'), 4),
      basis: 'declared',
    });
    expect(makeFinding(input('PASS', [step('longest request', v)])).kind).toBe('PASS');
  });

  it('is a deterministic order when several problems apply: unresolved, assumed, to be measured', () => {
    expect(
      passBlocker([step('a', defaultValue('to-be-measured')), step('b', defaultValue('assumed'))]),
    ).toBe('assumed-value');
    expect(passBlocker([step('a', defaultValue('assumed')), step('b', makeUnresolved('r'))])).toBe(
      'unresolved-value',
    );
  });

  it('never throws for any chain made of the value kinds, and never leaves a PASS over an unverified value (property)', () => {
    const rng = makeRng(14);
    const bases: Basis[] = [
      'measured-on',
      'documented',
      'from-source-not-measured',
      'from-changelogs-not-measured',
      'to-be-measured',
      'assumed',
    ];
    for (let i = 0; i < 1000; i += 1) {
      const n = rng.int(0, 6);
      const chain: ChainStep[] = [];
      let unverified = false;
      for (let j = 0; j < n; j += 1) {
        const pick = rng.int(0, 4);
        if (pick === 0) {
          chain.push(step(`s${j}`, makeUnresolved('r')));
          unverified = true;
        } else if (pick === 1) {
          chain.push(step(`s${j}`, inputText(`name${j}`)));
        } else if (pick === 2) {
          chain.push(step(`s${j}`, fileValue(rng.int(0, 100))));
        } else if (pick === 3) {
          chain.push(
            step(
              `s${j}`,
              makeSourcedValue({
                value: 1,
                unit: 's',
                source: declaredSource(inputText('tripcurve.yaml'), j + 1),
                basis: 'declared',
              }),
            ),
          );
        } else {
          const basis = rng.pick(bases);
          if (basis === 'assumed' || basis === 'to-be-measured') unverified = true;
          chain.push(step(`s${j}`, defaultValue(basis)));
        }
      }
      let f: Finding | undefined;
      expect(() => {
        f = makeFinding(input('PASS', chain));
      }, `case ${i}`).not.toThrow();
      if (unverified) {
        expect(f?.kind, `case ${i}`).toBe('UNRESOLVED');
        expect(f?.demotedFrom, `case ${i}`).toBe('PASS');
      } else {
        expect(f?.kind, `case ${i}`).toBe('PASS');
      }
      // A result is never PASS while its chain holds an unverified value.
      if (f?.kind === 'PASS') expect(passBlocker(f.chain)).toBeUndefined();
    }
  });
});

describe('other kinds', () => {
  it.each(RESULT_KINDS.filter((k): k is RuleResultKind => k !== 'WAIVED' && k !== 'PASS'))(
    'builds %s exactly as asked, even over unverified values',
    (kind) => {
      const f = makeFinding(input(kind, [step('x', makeUnresolved('r'))], 'h'));
      expect(f.kind).toBe(kind);
      expect(f.headline).toBe('h');
      expect(f.demotedFrom).toBeUndefined();
    },
  );

  it('keeps the chain in the order given', () => {
    const f = makeFinding(
      input('FAIL', [step('idle close', fileValue(2)), step('LB idle', fileValue(60))]),
    );
    expect(f.chain.map((c) => c.label)).toEqual(['idle close', 'LB idle']);
  });

  it('is frozen, and the chain it holds is a copy', () => {
    const chain = [step('a', fileValue(1))];
    const f = makeFinding(input('FAIL', chain));
    chain.push(step('b', fileValue(2)));
    expect(f.chain).toHaveLength(1);
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.chain)).toBe(true);
  });

  it('refuses a malformed call (never reachable from input text)', () => {
    expect(() => makeFinding({ ...input('FAIL', []), kind: 'OK' as never })).toThrow(TypeError);
    expect(() => makeFinding({ ...input('FAIL', []), kind: 'WAIVED' as never })).toThrow(TypeError);
    expect(() => makeFinding({ ...input('FAIL', []), rule: 'T9' as never })).toThrow(TypeError);
    expect(() => makeFinding({ ...input('FAIL', []), headline: inputText('x') as never })).toThrow(
      TypeError,
    );
  });
});

describe('WAIVED', () => {
  const waiver: WaiverInfo = {
    until: '2027-01-31',
    reason: inputText('drains in sidecar'),
    source: fileSource(inputText('k8s/billing.yaml'), 12),
    mechanism: 'inline',
  };

  it.each(WAIVABLE_KINDS)('keeps the original kind and headline of a %s', (kind) => {
    const f = makeFinding(input(kind, [step('x', fileValue(1))], 'the headline'));
    const w = waiveFinding(f, waiver);
    expect(w.kind).toBe('WAIVED');
    expect(w.originalKind).toBe(kind);
    expect(w.headline).toBe('the headline');
    expect(w.waiver).toBe(waiver);
    expect(w.chain).toEqual(f.chain);
    expect(countsAsPassed(w)).toBe(false);
  });

  it('never wraps a PASS, an N/A or an already waived finding', () => {
    const pass = makeFinding(input('PASS', [step('x', fileValue(1))]));
    expect(waiveFinding(pass, waiver)).toBe(pass);
    const na = makeFinding(input('N/A', []));
    expect(waiveFinding(na, waiver)).toBe(na);
    const waived = waiveFinding(makeFinding(input('FAIL', [])), waiver);
    expect(waiveFinding(waived, waiver)).toBe(waived);
  });

  it('never turns a non-PASS into a PASS, and never changes a PASS', () => {
    for (const kind of RESULT_KINDS) {
      if (kind === 'WAIVED') continue;
      const f = makeFinding(input(kind, []));
      const w = waiveFinding(f, waiver);
      expect(w.kind === 'PASS').toBe(f.kind === 'PASS');
    }
  });

  it('only PASS counts as passed', () => {
    for (const kind of RESULT_KINDS) {
      if (kind === 'WAIVED') continue;
      expect(countsAsPassed(makeFinding(input(kind, [])))).toBe(kind === 'PASS');
    }
  });
});

describe('an expired waiver', () => {
  const waiver: WaiverInfo = {
    until: '2026-10-31',
    reason: inputText('drains in sidecar'),
    source: fileSource(inputText('k8s/api.yaml'), 9),
    mechanism: 'inline',
  };

  it.each(WAIVABLE_KINDS)('leaves a %s as it was and records the waiver that ended', (kind) => {
    const f = makeFinding(input(kind, [step('x', fileValue(1))], 'the headline'));
    const e = noteExpiredWaiver(f, waiver);
    expect(e.kind).toBe(kind);
    expect(e.headline).toBe('the headline');
    expect(e.chain).toEqual(f.chain);
    expect(e.expiredWaiver).toBe(waiver);
    expect(e.waiver).toBeUndefined();
    expect(e.originalKind).toBeUndefined();
    expect(countsAsPassed(e)).toBe(false);
  });

  it('never marks a PASS, an N/A or a waived finding', () => {
    const pass = makeFinding(input('PASS', [step('x', fileValue(1))]));
    expect(noteExpiredWaiver(pass, waiver)).toBe(pass);
    const na = makeFinding(input('N/A', []));
    expect(noteExpiredWaiver(na, waiver)).toBe(na);
    const waived = waiveFinding(makeFinding(input('FAIL', [])), {
      ...waiver,
      until: '2099-01-01',
    });
    expect(noteExpiredWaiver(waived, waiver)).toBe(waived);
  });
});
