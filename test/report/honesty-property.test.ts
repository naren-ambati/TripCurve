import { describe, expect, it } from 'vitest';
import type { Finding, ResultKind, RuleId, RuleResultKind } from '../../src/core/index.js';
import {
  countsAsPassed,
  defaultSource,
  inputText,
  isWaivableKind,
  makeSourcedValue,
} from '../../src/core/index.js';
import type { InputFile } from '../../src/parse/index.js';
import { renderHuman } from '../../src/report/index.js';
import { makeRng, type Rng } from '../support/prng.js';
import {
  buildReport,
  configError,
  finding,
  goodChain,
  queue,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';
import { type EntryFields, entry, inline } from '../support/waiver-records.js';

// The first property: no report whose model holds an UNRESOLVED,
// VERSION-DEPENDENT, NOT EVALUATED, WARN or FAIL result, an unchecked file, a
// configuration error, or no result at all, contains "All checks passed" or exits 0;
// a waived result is never counted as passed and never allows "All checks passed".
// The converse is checked too, so the property cannot pass by never printing a green line.

const BAD: readonly ResultKind[] = [
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
  'WARN',
  'FAIL',
];
const KINDS: ReadonlyArray<RuleResultKind | 'WAIVED'> = [
  'PASS',
  'PASS',
  'PASS',
  'N/A',
  'N/A',
  ...BAD.filter((k): k is RuleResultKind => k !== 'WAIVED'),
  'WAIVED',
];

interface Case {
  findings: Finding[];
  files: number;
  workloadsNotChecked: number;
  noRecognised: boolean;
  configErrors: number;
}

function randomCase(rng: Rng, weights: { bad: number }): Case {
  const n = rng.int(0, 6);
  const findings: Finding[] = [];
  for (let i = 0; i < n; i += 1) {
    // lean towards good kinds so that clean runs come up often enough to test the converse
    const kind = rng.next() < weights.bad ? rng.pick(KINDS) : rng.pick(['PASS', 'N/A'] as const);
    const rule = rng.pick(['T1', 'T2', 'T3', 'T4'] as const);
    findings.push(finding(kind, rule, rule === 'T4' ? queue('orders') : workload('web')));
  }
  return {
    findings,
    files: rng.next() < 0.15 ? rng.int(1, 3) : 0,
    workloadsNotChecked: rng.next() < 0.2 ? rng.int(1, 3) : 0,
    noRecognised: rng.next() < 0.05,
    configErrors: rng.next() < 0.07 ? rng.int(1, 2) : 0,
  };
}

function reportOf(c: Case) {
  return buildReport({
    // T4 findings belong to an event source mapping (bolt B5), the others to a workload
    results: [
      ...(c.findings.some((f) => f.rule !== 'T4')
        ? [
            wf(
              workload('w'),
              c.findings.filter((f) => f.rule !== 'T4'),
            ),
          ]
        : []),
      ...(c.findings.some((f) => f.rule === 'T4')
        ? [
            wf(
              queue('orders'),
              c.findings.filter((f) => f.rule === 'T4'),
              'infra/queue.tf',
            ),
          ]
        : []),
    ],
    unchecked: Array.from({ length: c.files }, (_v, i) => unchecked(`k8s/f${i}.yaml`)),
    notChecked: Array.from({ length: c.workloadsNotChecked }, (_v, i) => ({
      subjectKind: 'workload' as const,
      subject: inputText(`w${i}`),
      kind: 'Deployment' as const,
      file: inputText('k8s/x.yaml'),
      reasonCode: 'no-recognised-lb' as const,
    })),
    noRecognisedFiles: c.noRecognised,
    configErrors: Array.from({ length: c.configErrors }, () => configError('k')),
  });
}

describe('the honesty property', () => {
  it('holds for 2000 seeded random models, and the converse holds too', () => {
    const rng = makeRng(20261111);
    let clean = 0;
    let waivedClean = 0;
    let notClean = 0;
    for (let i = 0; i < 2000; i += 1) {
      const c = randomCase(rng, { bad: i % 2 === 0 ? 0.5 : 0.08 });
      const report = reportOf(c);
      const text = renderHuman(report);
      const kinds = c.findings.map((f) => f.kind);
      const bad =
        kinds.some((k) => BAD.includes(k)) ||
        c.files > 0 ||
        c.configErrors > 0 ||
        c.findings.length === 0;
      const waived = kinds.includes('WAIVED');
      const where = `case ${i} (${kinds.join(',')} files=${c.files} cfg=${c.configErrors})`;

      // clean is derived from the exit code, on every report
      expect(report.summary.clean, where).toBe(report.summary.exitCode === 0);
      // a waived result is never counted as passed
      if (c.configErrors === 0) {
        expect(report.summary.counts.passed, where).toBe(kinds.filter((k) => k === 'PASS').length);
        expect(report.summary.counts.waived, where).toBe(
          kinds.filter((k) => k === 'WAIVED').length,
        );
      }

      if (bad) {
        notClean += 1;
        expect(text, where).not.toContain('All checks passed');
        expect(text, where).not.toContain('No failures');
        expect(report.summary.exitCode, where).not.toBe(0);
        expect(report.summary.clean, where).toBe(false);
      }
      if (waived) {
        expect(text, where).not.toContain('All checks passed');
      }
      if (report.summary.exitCode === 0) {
        expect(bad, where).toBe(false);
        // exit 0 only with one of the three green lines, and only the waiver form for waivers
        expect(/All checks passed \(\d+\)|No failures:|No checks apply:/.test(text), where).toBe(
          true,
        );
        if (waived) expect(text, where).toContain('No failures:');
      }

      // the converse: a model that is good, with a pass and no waiver, does say so and exits 0
      if (!bad && !waived && kinds.includes('PASS')) {
        clean += 1;
        expect(report.summary.exitCode, where).toBe(0);
        expect(text, where).toMatch(
          /All checks passed \(\d+\), \d+ not applicable(; \d+ workloads? not checked)?\./,
        );
      }
      if (!bad && waived) {
        waivedClean += 1;
        expect(report.summary.exitCode, where).toBe(0);
        expect(text, where).toContain('No failures:');
      }
      // an "All checks passed" with workloads not checked always says how many
      if (text.includes('All checks passed') && c.workloadsNotChecked > 0) {
        expect(text, where).toContain(`${c.workloadsNotChecked} workload`);
      }
    }
    // the generator really reached each branch
    expect(clean).toBeGreaterThan(50);
    expect(waivedClean).toBeGreaterThan(5);
    expect(notClean).toBeGreaterThan(500);
  });

  it('a T4 result that rests on the assumed batching window cannot give a green run (B5)', () => {
    // visibility 190 s covers 6 x 30 s + 0 s, but the window 0 s is assumed, not read: the rule gives UNRESOLVED
    const assumedWindow = makeSourcedValue({
      value: 0,
      unit: 's',
      source: defaultSource({
        citation: 'Lambda event source mapping batching window',
        basisText: 'documented',
      }),
      basis: 'assumed',
    });
    const demoted = finding('PASS', 'T4', queue('orders'), 'visibility 190 s covers 180 s', [
      ...goodChain('infra/queue.tf', 3),
      { label: 'batching', value: assumedWindow },
    ]);
    expect(demoted.kind).toBe('UNRESOLVED');
    expect(demoted.demotionReason).toBe('assumed-value');
    const report = buildReport({ results: [wf(queue('orders'), [demoted], 'infra/queue.tf')] });
    expect(report.summary.exitCode).toBe(1);
    expect(renderHuman(report)).not.toContain('All checks passed');
    expect(renderHuman(report)).toContain(
      'Workload "orders" (event source mapping) in "infra/queue.tf"',
    );
  });

  it('the no-files case, the config-error case and the nothing-checked case never print All checks passed and never exit 0', () => {
    const e1 = buildReport({ noRecognisedFiles: true, filesRead: 0 });
    const e4 = buildReport({
      configErrors: [configError('k')],
      results: [wf(workload('w'), [finding('PASS')])],
    });
    const e10 = buildReport({ results: [], filesRead: 4 });
    for (const [name, r] of [
      ['no files', e1],
      ['config error', e4],
      ['nothing checked', e10],
    ] as const) {
      expect(renderHuman(r), name).not.toContain('All checks passed');
      expect(r.summary.exitCode, name).toBe(2);
      expect(r.summary.clean, name).toBe(false);
    }
  });

  it('an unchecked file alone stops a run that would be green', () => {
    const report = buildReport({
      results: [wf(workload('w'), [finding('PASS'), finding('N/A', 'T2')])],
      unchecked: [unchecked('k8s/x.yaml', 'over-size')],
    });
    expect(report.summary.outcome).toBe('Incomplete');
    expect(renderHuman(report)).not.toContain('All checks passed');
    expect(report.summary.exitCode).toBe(1);
  });

  it('the one allowed form with workloads not checked is asserted explicitly', () => {
    const report = buildReport({
      results: [
        wf(workload('w'), [
          ...Array.from({ length: 7 }, () => finding('PASS')),
          finding('N/A', 'T2'),
        ]),
      ],
      notChecked: [0, 1].map((i) => ({
        subjectKind: 'workload' as const,
        subject: inputText(`w${i}`),
        kind: 'Deployment' as const,
        file: inputText('k8s/x.yaml'),
        reasonCode: 'no-recognised-lb' as const,
      })),
    });
    expect(renderHuman(report)).toContain(
      'All checks passed (7), 1 not applicable; 2 workloads not checked.\nGreen does not mean zero-downtime: see Assumptions.\n',
    );
    expect(report.summary.exitCode).toBe(0);
  });

  it('a demoted PASS (resting on an unverified value) cannot give a green run', () => {
    // makeFinding turns this PASS into UNRESOLVED; the report must then not be green
    const demoted = finding('PASS', 'T1', workload('w'), 'h', [
      {
        label: 'idle close',
        value: { unresolved: true, reason: 'not established' },
      },
    ]);
    expect(demoted.kind).toBe('UNRESOLVED');
    const report = buildReport({ results: [wf(workload('w'), [demoted])] });
    expect(report.summary.exitCode).toBe(1);
    expect(renderHuman(report)).not.toContain('All checks passed');
  });
});

// ---- waivers ---------------------------------------------------------------------------
//
// The same property, now with waivers in the model. The generator makes random results for three workloads
// (a fourth of the same name in another namespace, and two that share one document, now and then) and a
// queue, random unchecked files, and random waivers: config entries and inline comments, valid ones,
// expired ones, non-ASCII reasons, and each way a waiver can be wrong. Everything goes through the real
// WaiverApplier, RunSummarizer and renderer. The oracle below states the waiver rules on their own, so a
// change in how the applier decides shows as a disagreement:
//   a waiver is applied only if its form is valid, its date is on or after today, its rule and workload
//   exist (and the workload is named by one workload, an inline comment sits in one block), the finding it
//   names is not a pass or not applicable, and no other waiver names the same finding;
//   everything else changes no result.
// mutation check (bolt B6): each guard was removed in turn and this test failed every time; the
// table is in the report of the bolt (BUILD-NOTES.md).

const TODAY = '2026-11-12';
const NAMES = ['w0', 'w1', 'w2'] as const;
const WAIVE_KINDS: readonly RuleResultKind[] = [
  'PASS',
  'PASS',
  'N/A',
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
];
/** Reasons that are valid, valid and not ASCII, and made only of characters nobody can see. */
const GOOD_REASONS = ['a reason', 'raison été', '理由', 'x​', '!', '\u{1f600} ok'];
const INVISIBLE_REASONS = ['', ' ', '​', '​‌﻿', ' ', ' '];

interface Spec {
  readonly form: 'config' | 'inline';
  readonly fields: EntryFields;
  /** For an inline comment: the block (0 to 2) whose lines it sits in. */
  readonly block?: number;
}

interface Gen {
  readonly results: ReturnType<typeof wf>[];
  readonly specs: Spec[];
  readonly originals: Finding[];
  /** The path each block's object is in (the queue has none). */
  readonly paths: (string | undefined)[];
  readonly dupW1: boolean;
  readonly unchecked: number;
}

function randomFields(rng: Rng, inlineForm: boolean): EntryFields {
  const roll = rng.next();
  const base: Record<string, string> = {
    rule: rng.pick(['T1', 'T2', 'T3', 'T4'] as const),
    reason: rng.pick(GOOD_REASONS),
    until: rng.pick(['2026-11-12', '2026-11-13', '2027-06-01', '9999-12-31'] as const),
  };
  if (!inlineForm) base.workload = rng.pick([...NAMES, 'orders'] as const);
  if (roll < 0.5) return base;
  if (roll < 0.6) return { ...base, until: rng.pick(['2026-11-11', '2020-01-01'] as const) };
  if (roll < 0.65) return { ...base, rule: 'T9' };
  if (roll < 0.7) return inlineForm ? { ...base, rule: 'T0' } : { ...base, workload: 'ghost' };
  if (roll < 0.76) return { ...base, reason: rng.pick(INVISIBLE_REASONS) };
  if (roll < 0.8) return { ...base, reason: 'r'.repeat(201) };
  if (roll < 0.85) return { ...base, until: '2027-02-30' };
  if (roll < 0.92) {
    const { reason: _drop, ...noReason } = base;
    return noReason;
  }
  return { ...base, extra: 'x' };
}

/** `bad` is the chance that a result is a problem; low, so that runs which can go green come up. */
function randomWaiverCase(rng: Rng, bad: number): Gen {
  const results: ReturnType<typeof wf>[] = [];
  const originals: Finding[] = [];
  const paths: (string | undefined)[] = [];
  const pickKind = (): RuleResultKind =>
    rng.next() < bad
      ? rng.pick(WAIVE_KINDS.filter((k) => k !== 'PASS' && k !== 'N/A'))
      : rng.pick(['PASS', 'PASS', 'N/A'] as const);
  const sharedDoc = rng.next() < 0.15;
  const dupW1 = rng.next() < 0.15;
  const addWorkload = (name: string, namespace: string, path: string): void => {
    const subject = workload(name, namespace);
    const findings = (['T1', 'T2', 'T3'] as const).map((rule) => {
      const f = finding(pickKind(), rule, subject);
      originals.push(f);
      return f;
    });
    results.push(wf(subject, findings, path));
    paths.push(path);
  };
  NAMES.forEach((name, i) => {
    addWorkload(name, 'shop', sharedDoc && i === 2 ? 'k8s/w1.yaml' : `k8s/${name}.yaml`);
  });
  const q = queue('orders');
  const t4 = finding(pickKind(), 'T4', q);
  originals.push(t4);
  results.push(wf(q, [t4], 'infra/q.tf'));
  paths.push(undefined);
  if (dupW1) addWorkload('w1', 'live', 'k8s/w1-live.yaml');

  const specs = Array.from({ length: rng.int(0, 5) }, (): Spec => {
    const inlineForm = rng.next() < 0.4;
    const fields = randomFields(rng, inlineForm);
    // half of the waivers are aimed at a result that can be waived, so that runs that go green through
    // waivers (and the ways that can go wrong) come up often
    const aimable = originals.flatMap((f, i) =>
      isWaivableKind(f.kind) && (!inlineForm || i < 9)
        ? [{ rule: f.rule, index: i < 9 ? Math.floor(i / 3) : 3 }]
        : [],
    );
    if (aimable.length > 0 && rng.next() < 0.5) {
      const aim = rng.pick(aimable);
      const aimed = { ...fields, rule: aim.rule } as Record<string, string>;
      if (inlineForm) return { form: 'inline', fields: aimed, block: aim.index };
      aimed.workload = aim.index === 3 ? 'orders' : (NAMES[aim.index] as string);
      return { form: 'config', fields: aimed };
    }
    return inlineForm
      ? { form: 'inline', fields, block: rng.int(0, 2) }
      : { form: 'config', fields };
  });
  return {
    results,
    specs,
    originals,
    paths,
    dupW1,
    unchecked: rng.next() < 0.15 ? rng.int(1, 2) : 0,
  };
}

/** The directive an inline spec writes; a missing field is left out, as a person would. */
function inlineText(fields: EntryFields): string {
  const parts = ['# tripcurve: ignore', String(fields.rule ?? '')];
  if (fields.rule === undefined) parts.pop();
  if (fields.reason !== undefined) parts.push(`reason="${String(fields.reason)}"`);
  if (fields.until !== undefined) parts.push(`until=${String(fields.until)}`);
  if (fields.extra !== undefined) parts.push('extra=x');
  return parts.join(' ');
}

const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** The waiver rules on their own: which waivers apply to which findings, and which have expired. */
function oracle(gen: Gen): {
  applied: Set<number>;
  covered: Map<Finding, number>;
  expired: Set<Finding>;
} {
  const formOk = (f: EntryFields): boolean => {
    const reason = f.reason;
    const until = f.until;
    return (
      Object.keys(f).every((k) => ['rule', 'workload', 'reason', 'until'].includes(k)) &&
      typeof f.rule === 'string' &&
      /^T[1-4]$/.test(f.rule) &&
      typeof reason === 'string' &&
      VISIBLE.test(reason) &&
      [...reason].length <= 200 &&
      typeof until === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(until) &&
      until !== '2027-02-30'
    );
  };
  // blocks: 0 w0, 1 w1, 2 w2, 3 the queue, and 4 w1 in another namespace when `dupW1`
  const blockOf = (spec: Spec): number | undefined => {
    if (spec.form === 'config') {
      const name = spec.fields.workload;
      if (name === 'orders') return 3;
      const i = NAMES.indexOf(name as (typeof NAMES)[number]);
      if (i < 0) return undefined; // a workload that was not read
      if (name === 'w1' && gen.dupW1) return undefined; // two workloads of that name: ambiguous
      return i;
    }
    const own = spec.block as number;
    const sharing = gen.paths.flatMap((p, i) =>
      p !== undefined && p === gen.paths[own] ? [i] : [],
    );
    return sharing.length === 1 ? own : undefined; // a comment in a document of two workloads names neither
  };
  const named = new Map<number, Finding>();
  gen.specs.forEach((spec, i) => {
    if (!formOk(spec.fields)) return;
    const target = gen.results[blockOf(spec) ?? -1];
    const hit = target?.findings.find((x) => x.rule === (spec.fields.rule as RuleId));
    if (hit !== undefined && isWaivableKind(hit.kind)) named.set(i, hit);
  });
  const perFinding = new Map<Finding, number[]>();
  for (const [i, hit] of named) perFinding.set(hit, [...(perFinding.get(hit) ?? []), i]);
  const applied = new Set<number>();
  const covered = new Map<Finding, number>();
  const expired = new Set<Finding>();
  for (const [hit, list] of perFinding) {
    const only = list[0];
    if (list.length !== 1 || only === undefined) continue; // two waivers for one finding cover neither
    if ((gen.specs[only]?.fields.until as string) < TODAY) {
      expired.add(hit); // a date before today: the waiver is over, the finding is as the rule left it
      continue;
    }
    applied.add(only);
    covered.set(hit, only);
  }
  return { applied, covered, expired };
}

/** A file of ten lines holding one YAML object, so an inline comment on line 5 sits in its block. */
function fakeFile(path: string): InputFile {
  const lines = Array.from({ length: 10 }, (_v, i) => (i === 9 ? '# end' : `k${i}: v`));
  const text = `${lines.join('\n')}\n`;
  const lineIndex: number[] = [];
  let at = 0;
  for (const line of lines) {
    lineIndex.push(at);
    at += line.length + 1;
  }
  const doc = { index: 1, startLine: 1, blockFirstLine: 1, blockLastLine: 10, value: {} };
  return {
    canonicalPath: inputText(path),
    class: 'k8s-yaml',
    text: inputText(text),
    lineIndex,
    documents: [doc],
  } as unknown as InputFile;
}

describe('the honesty property with waivers', () => {
  it('holds for 4000 seeded random models: a waiver never makes a pass, hides a result or turns the run green by itself', () => {
    const rng = makeRng(20261112);
    let noFailures = 0;
    let withExpired = 0;
    let withInvalid = 0;
    let withInline = 0;
    let withDuplicateName = 0;
    let withSharedDoc = 0;
    let withUnchecked = 0;
    let checkedAllChecksPassed = 0;
    for (let i = 0; i < 4000; i += 1) {
      const gen = randomWaiverCase(rng, i % 2 === 0 ? 0.35 : 0.08);
      const records = gen.specs.map((spec, k) =>
        spec.form === 'config'
          ? entry(spec.fields, 3 + k * 4)
          : inline(inlineText(spec.fields), gen.paths[spec.block as number] as string, 5),
      );
      const files = [...new Set(gen.paths.filter((p): p is string => p !== undefined))].map(
        fakeFile,
      );
      const report = buildReport({
        results: gen.results,
        waiverRecords: records,
        today: TODAY,
        intakeFiles: files,
        unchecked: Array.from({ length: gen.unchecked }, (_v, k) => unchecked(`k8s/u${k}.yaml`)),
      });
      const text = renderHuman(report);
      const { applied, covered, expired } = oracle(gen);
      const where = `case ${i}: ${JSON.stringify(gen.specs)} dupW1=${gen.dupW1} unchecked=${gen.unchecked}`;

      // every waiver is in exactly one state, and the states are the oracle's
      expect(report.waivers, where).toHaveLength(gen.specs.length);
      report.waivers.forEach((w, k) => {
        expect(w.state === 'applied', `${where} waiver ${k} applied`).toBe(applied.has(k));
      });

      const outFindings = report.blocks.flatMap((b) => b.findings);
      const find = (from: Finding): Finding => {
        const hit = outFindings.find((f) => f.rule === from.rule && f.subject === from.subject);
        if (hit === undefined) throw new Error('a finding went missing');
        return hit;
      };

      // a result is WAIVED exactly when the oracle says a waiver covers it, keeps its original kind, and a
      // pass or not applicable result is never touched
      for (const original of gen.originals) {
        const out = find(original);
        if (covered.has(original)) {
          expect(out.kind, where).toBe('WAIVED');
          expect(out.originalKind, where).toBe(original.kind);
          expect(isWaivableKind(original.kind), where).toBe(true);
          expect(out.headline, where).toBe(original.headline);
          expect(countsAsPassed(out), where).toBe(false);
        } else if (expired.has(original)) {
          // the finding keeps its kind and everything else, and says the waiver expired
          expect(out.kind, where).toBe(original.kind);
          expect(out.expiredWaiver, where).toBeDefined();
          expect({ ...out, expiredWaiver: undefined }, where).toEqual({
            ...original,
            expiredWaiver: undefined,
          });
        } else {
          expect(out, where).toBe(original);
        }
        if (original.kind === 'PASS' || original.kind === 'N/A') {
          expect(out.kind, where).toBe(original.kind);
        }
      }

      // counts: waived is exactly the applied waivers, and passed is exactly the PASS results the rules gave
      expect(report.summary.counts.waived, where).toBe(applied.size);
      expect(report.summary.counts.passed, where).toBe(
        gen.originals.filter((f) => f.kind === 'PASS').length,
      );
      expect(report.summary.counts.notApplicable, where).toBe(
        gen.originals.filter((f) => f.kind === 'N/A').length,
      );

      // a waiver of any kind forbids "All checks passed"
      if (gen.specs.length > 0) expect(text, where).not.toContain('All checks passed');

      const unwaivedBad = gen.originals.some((f) => isWaivableKind(f.kind) && !covered.has(f));
      const notApplied = report.waiversNotApplied.length;
      // the run is clean exactly when nothing is left unwaived, every waiver is in force and no file was
      // left unchecked: stated on the exit code, which is what a build reads
      const clean = !unwaivedBad && notApplied === 0 && gen.unchecked === 0;
      expect(report.summary.exitCode === 0, where).toBe(clean);
      expect(report.summary.clean, where).toBe(clean);

      if (clean) {
        expect(
          report.waivers.every((w) => w.state === 'applied'),
          where,
        ).toBe(true);
        // exit 0 says which green it is: with a waiver "No failures:", else a pass, else nothing applies
        const hasPass = gen.originals.some((f) => f.kind === 'PASS');
        const expected =
          applied.size > 0 ? 'No failures:' : hasPass ? 'All checks passed' : 'No checks apply:';
        expect(text, where).toContain(expected);
        for (const other of ['No failures:', 'All checks passed', 'No checks apply:']) {
          if (other !== expected) expect(text, `${where} ${other}`).not.toContain(other);
        }
        noFailures += applied.size > 0 ? 1 : 0;
        checkedAllChecksPassed += expected === 'All checks passed' ? 1 : 0;
      } else {
        expect(text, where).not.toContain('No failures:');
        expect(text, where).not.toContain('All checks passed');
        expect(text.replace(/\s+/g, ' '), where).toContain('not a clean result');
      }
      if (notApplied > 0) {
        // an unmatched or invalid waiver is counted under unresolved and the run is not clean
        expect(report.summary.unresolvedDetail.waivers, where).toBe(notApplied);
        expect(report.summary.clean, where).toBe(false);
      }
      if (gen.unchecked > 0) {
        withUnchecked += 1;
        expect(report.summary.unresolvedDetail.files, where).toBe(gen.unchecked);
      }
      if (report.waivers.some((w) => w.state === 'expired')) withExpired += 1;
      if (report.waivers.some((w) => w.state === 'invalid')) withInvalid += 1;
      if (gen.specs.some((s) => s.form === 'inline')) withInline += 1;
      if (gen.dupW1) withDuplicateName += 1;
      if (gen.paths[1] === gen.paths[2]) withSharedDoc += 1;
    }
    // the generator reached each branch
    expect(noFailures).toBeGreaterThan(40);
    expect(checkedAllChecksPassed).toBeGreaterThan(20);
    expect(withExpired).toBeGreaterThan(100);
    expect(withInvalid).toBeGreaterThan(500);
    expect(withInline).toBeGreaterThan(500);
    expect(withDuplicateName).toBeGreaterThan(300);
    expect(withSharedDoc).toBeGreaterThan(300);
    expect(withUnchecked).toBeGreaterThan(300);
  });
});
