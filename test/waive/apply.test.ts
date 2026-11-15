import { describe, expect, it } from 'vitest';
import {
  countsAsPassed,
  type Finding,
  type RuleResultKind,
  type WorkloadRef,
} from '../../src/core/index.js';
import type { WorkloadFindings } from '../../src/evaluate/index.js';
import type { IntakeResult } from '../../src/parse/index.js';
import { type AppliedWaiver, applyWaivers, WAIVER_PROBLEMS } from '../../src/waive/index.js';
import { txt } from '../support/render.js';
import { finding, queue, wf, workload } from '../support/report-fixtures.js';
import { entry, inline, VALID_ENTRY } from '../support/waiver-records.js';

// WaiverApplier judges every waiver once, wraps only findings that are not a pass, and
// keeps every other finding exactly as the rule left it. These tests use findings built by hand and a
// config waiver (which names its workload); the inline waivers, which attach by line, are tested against
// real files in inline.test.ts.

const NO_INTAKE = { files: [] } as unknown as IntakeResult;
const TODAY = '2026-11-12';

function run(
  results: readonly WorkloadFindings[],
  records: ReturnType<typeof entry>[],
  options: { today?: string | undefined; known?: readonly WorkloadRef[] } = {},
) {
  return applyWaivers({
    results,
    records,
    knownWorkloads:
      options.known ?? results.flatMap((r) => ('mapping' in r.workload ? [] : [r.workload])),
    intake: NO_INTAKE,
    terraform: [],
    today: 'today' in options ? options.today : TODAY,
  });
}

function stateOf(w: AppliedWaiver | undefined): string | undefined {
  return w?.state;
}

function kindsOf(results: readonly WorkloadFindings[]): string[] {
  return results.flatMap((r) => r.findings.map((f) => `${f.rule}:${f.kind}`));
}

const api = workload('api', 'shop');
const failT2 = (): Finding => finding('FAIL', 'T2', api, 'no drain delay before SIGTERM');

describe('a valid waiver', () => {
  it('wraps the finding as WAIVED with its original kind and headline, and counts as not passed', () => {
    const out = run([wf(api, [failT2()])], [entry(VALID_ENTRY)]);
    const f = out.results[0]?.findings[0] as Finding;
    expect(f.kind).toBe('WAIVED');
    expect(f.originalKind).toBe('FAIL');
    expect(f.headline).toBe('no drain delay before SIGTERM');
    expect(f.waiver?.until).toBe('2027-01-31');
    expect(txt(f.waiver?.reason as never)).toBe('drains in sidecar');
    expect(f.waiver?.mechanism).toBe('config');
    expect(countsAsPassed(f)).toBe(false);
    expect(out.waivers.map(stateOf)).toEqual(['applied']);
  });

  it.each(['FAIL', 'WARN', 'UNRESOLVED', 'VERSION-DEPENDENT', 'NOT EVALUATED'] as const)(
    'covers a %s result',
    (kind) => {
      const out = run([wf(api, [finding(kind, 'T2', api)])], [entry(VALID_ENTRY)]);
      const f = out.results[0]?.findings[0] as Finding;
      expect(f.kind).toBe('WAIVED');
      expect(f.originalKind).toBe(kind);
    },
  );

  it.each(['PASS', 'N/A'] as const)(
    'never covers a %s result: the waiver matches nothing and the result is untouched',
    (kind) => {
      const before = finding(kind, 'T2', api);
      const out = run([wf(api, [before])], [entry(VALID_ENTRY)]);
      expect(out.results[0]?.findings[0]).toBe(before);
      expect(out.waivers.map(stateOf)).toEqual(['unmatched']);
    },
  );

  it('changes only the one finding it names (other rules and other workloads are the same objects)', () => {
    const t1 = finding('FAIL', 'T1', api);
    const other = finding('FAIL', 'T2', workload('web', 'shop'));
    const blocks = [wf(api, [t1, failT2()]), wf(workload('web', 'shop'), [other])];
    const out = run(blocks, [entry(VALID_ENTRY)]);
    expect(kindsOf(out.results)).toEqual(['T1:FAIL', 'T2:WAIVED', 'T2:FAIL']);
    expect(out.results[0]?.findings[0]).toBe(t1);
    expect(out.results[1]).toBe(blocks[1]);
  });

  it('matches by namespace and kind when the waiver gives them', () => {
    const shop = workload('api', 'shop');
    const live = workload('api', 'live');
    const blocks = [
      wf(shop, [finding('FAIL', 'T2', shop)]),
      wf(live, [finding('FAIL', 'T2', live)]),
    ];
    const out = run(blocks, [entry({ ...VALID_ENTRY, namespace: 'live' })]);
    expect(kindsOf(out.results)).toEqual(['T2:FAIL', 'T2:WAIVED']);
  });

  it('names an event source mapping by its name for T4', () => {
    const q = queue('orders');
    const out = run(
      [wf(q, [finding('FAIL', 'T4', q)], 'infra/q.tf')],
      [entry({ ...VALID_ENTRY, rule: 'T4', workload: 'orders' })],
    );
    expect(kindsOf(out.results)).toEqual(['T4:WAIVED']);
  });
});

describe('expiry: through the date, inclusive, in UTC', () => {
  const record = entry({ ...VALID_ENTRY, until: '2027-01-31' });
  it.each([
    ['2027-01-30', 'applied'],
    ['2027-01-31', 'applied'],
    ['2027-02-01', 'expired'],
    ['2028-01-01', 'expired'],
  ])('on %s the waiver is %s', (today, state) => {
    const out = run([wf(api, [failT2()])], [record], { today });
    expect(out.waivers.map(stateOf)).toEqual([state]);
    const f = out.results[0]?.findings[0] as Finding;
    if (state === 'applied') {
      expect(f.kind).toBe('WAIVED');
    } else {
      // the finding returns with its original kind and says the waiver expired
      expect(f.kind).toBe('FAIL');
      expect(f.expiredWaiver?.until).toBe('2027-01-31');
      expect(f.waiver).toBeUndefined();
    }
  });

  it('has no upper bound', () => {
    const out = run([wf(api, [failT2()])], [entry({ ...VALID_ENTRY, until: '9999-12-31' })]);
    expect(out.waivers.map(stateOf)).toEqual(['applied']);
  });

  it.each([undefined, 'today', '2026-13-01', '2026-11-12T00:00', ''])(
    'with the date of the run unknown (%j) no waiver applies and every one is listed',
    (today) => {
      const out = run([wf(api, [failT2()])], [entry(VALID_ENTRY)], { today });
      expect(out.waivers.map(stateOf)).toEqual(['invalid']);
      expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['no-date-known']);
      expect(out.results[0]?.findings[0]?.kind).toBe('FAIL');
    },
  );
});

describe('an invalid waiver suppresses nothing', () => {
  it.each([
    ['unknown rule', { ...VALID_ENTRY, rule: 'T9' }, 'unknown-rule'],
    ['unknown workload', { ...VALID_ENTRY, workload: 'ghost' }, 'unknown-workload'],
    ['no reason', { rule: 'T2', workload: 'api', until: '2027-01-31' }, 'no-reason'],
    ['empty reason', { ...VALID_ENTRY, reason: ' ' }, 'empty-reason'],
    ['long reason', { ...VALID_ENTRY, reason: 'z'.repeat(201) }, 'long-reason'],
    ['bad date', { ...VALID_ENTRY, until: '2027-02-30' }, 'bad-date'],
    ['unknown field', { ...VALID_ENTRY, why: 'x' }, 'unknown-field'],
  ] as const)(
    '%s: the finding keeps its real result and the waiver is listed',
    (_n, fields, problem) => {
      const before = failT2();
      const out = run([wf(api, [before])], [entry(fields as never)]);
      expect(out.results[0]?.findings[0]).toBe(before);
      expect(out.waivers.map(stateOf)).toEqual(['invalid']);
      expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS[problem]);
    },
  );

  it('a waiver that names a workload that matches two is ambiguous, not applied to either', () => {
    const shop = workload('api', 'shop');
    const live = workload('api', 'live');
    const blocks = [
      wf(shop, [finding('FAIL', 'T2', shop)]),
      wf(live, [finding('FAIL', 'T2', live)]),
    ];
    const out = run(blocks, [entry(VALID_ENTRY)]);
    expect(kindsOf(out.results)).toEqual(['T2:FAIL', 'T2:FAIL']);
    expect(out.waivers[0]?.state).toBe('invalid');
    expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['ambiguous-workload']);
  });

  it('two workloads of one name in two namespaces: ambiguous, and neither finding is waived', () => {
    const shop = workload('api', 'shop');
    const live = workload('api', 'live');
    const blocks = [
      wf(shop, [finding('FAIL', 'T2', shop)]),
      wf(live, [finding('FAIL', 'T2', live)]),
    ];
    // not even when the other namespace's workload has no result (it was read, so the name is still shared)
    const known = [shop, live];
    const out = run([blocks[0] as WorkloadFindings], [entry(VALID_ENTRY)], { known });
    expect(out.results[0]?.findings[0]?.kind).toBe('FAIL');
    expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['ambiguous-workload']);
    const both = run(blocks, [entry(VALID_ENTRY)]);
    expect(kindsOf(both.results)).toEqual(['T2:FAIL', 'T2:FAIL']);
    expect(both.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['ambiguous-workload']);
  });

  it('a Deployment and a StatefulSet of one name are two workloads: a kind picks one', () => {
    const dep = workload('api', 'shop', 'Deployment');
    const sts = workload('api', 'shop', 'StatefulSet');
    const blocks = [wf(dep, [finding('FAIL', 'T2', dep)]), wf(sts, [finding('FAIL', 'T2', sts)])];
    expect(run(blocks, [entry(VALID_ENTRY)]).waivers[0]?.state).toBe('invalid');
    const out = run(blocks, [entry({ ...VALID_ENTRY, kind: 'StatefulSet' })]);
    expect(kindsOf(out.results)).toEqual(['T2:FAIL', 'T2:WAIVED']);
  });

  it('two valid waivers for one finding cover neither: which would win is not written anywhere', () => {
    const before = failT2();
    const out = run(
      [wf(api, [before])],
      [entry(VALID_ENTRY), entry({ ...VALID_ENTRY, reason: 'again' }, 9)],
    );
    expect(out.results[0]?.findings[0]).toBe(before);
    expect(out.waivers.map(stateOf)).toEqual(['invalid', 'invalid']);
    expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['shared-finding']);
  });

  it('two waivers for one finding are still both listed when one has expired', () => {
    const out = run(
      [wf(api, [failT2()])],
      [entry(VALID_ENTRY), entry({ ...VALID_ENTRY, until: '2020-01-01' }, 9)],
    );
    expect(out.waivers.map(stateOf)).toEqual(['invalid', 'invalid']);
    expect(out.results[0]?.findings[0]?.kind).toBe('FAIL');
  });

  it('a waiver of one rule never covers another rule of the same workload', () => {
    const t1 = finding('FAIL', 'T1', api);
    const out = run([wf(api, [t1, failT2()])], [entry({ ...VALID_ENTRY, rule: 'T3' })]);
    expect(kindsOf(out.results)).toEqual(['T1:FAIL', 'T2:FAIL']);
    expect(out.waivers.map(stateOf)).toEqual(['unmatched']);
  });
});

describe('a waiver that matches no finding is listed', () => {
  it('names the workload and rule it looked for', () => {
    const out = run([wf(api, [finding('PASS', 'T2', api)])], [entry(VALID_ENTRY)]);
    const w = out.waivers[0] as AppliedWaiver;
    expect(w.state).toBe('unmatched');
    expect(w.rule).toBe('T2');
    expect(txt(w.workload?.name as never)).toBe('api');
    expect(w.mechanism).toBe('config');
  });

  it('a workload that was read but has no result (not checked) is unmatched, not unknown', () => {
    const known = [workload('idle', 'shop')];
    const out = run([wf(api, [failT2()])], [entry({ ...VALID_ENTRY, workload: 'idle' })], {
      known,
    });
    expect(out.waivers.map(stateOf)).toEqual(['unmatched']);
  });

  it('a rule the workload has no result for (T4 on a Deployment) is unmatched', () => {
    const out = run([wf(api, [failT2()])], [entry({ ...VALID_ENTRY, rule: 'T4' })]);
    expect(out.waivers.map(stateOf)).toEqual(['unmatched']);
  });
});

describe('the result', () => {
  it('lists every waiver once, in the order the readers gave them', () => {
    const records = [
      entry({ ...VALID_ENTRY, rule: 'T9' }, 3),
      entry(VALID_ENTRY, 7),
      entry({ ...VALID_ENTRY, workload: 'ghost' }, 11),
    ];
    const out = run([wf(api, [failT2()])], records);
    expect(out.waivers.map((w) => w.state)).toEqual(['invalid', 'applied', 'invalid']);
    expect(out.waivers.map((w) => (w.source.type === 'declared' ? w.source.line : 0))).toEqual([
      3, 7, 11,
    ]);
  });

  it('with no waiver returns the very same blocks', () => {
    const blocks = [wf(api, [failT2()])];
    const out = run(blocks, []);
    expect(out.results).toBe(blocks);
    expect(out.waivers).toEqual([]);
  });

  it('an inline waiver in a run with no file to attach to is outside every block', () => {
    const out = run(
      [wf(api, [failT2()])],
      [inline('# tripcurve: ignore T2 reason="a" until=2027-01-31')],
    );
    expect(out.waivers.map(stateOf)).toEqual(['invalid']);
    expect(out.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['outside-block']);
  });

  it('never throws for a kind it does not know: a waiver covers only the five waivable kinds', () => {
    for (const kind of ['PASS', 'N/A'] as RuleResultKind[]) {
      const out = run([wf(api, [finding(kind, 'T2', api)])], [entry(VALID_ENTRY)]);
      expect(out.results[0]?.findings[0]?.kind).toBe(kind);
    }
  });
});
