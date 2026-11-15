import { describe, expect, it } from 'vitest';
import type { Finding, RuleResultKind } from '../../src/core/index.js';
import { type Report, renderHuman, renderJson, renderSarif } from '../../src/report/index.js';
import { makeRng, type Rng, randomHostileString } from '../support/prng.js';
import {
  buildReport,
  configError,
  finding,
  queue,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';
import { validateSarif } from '../support/sarif-validate.js';
import { type EntryFields, entry } from '../support/waiver-records.js';

// Bolt B7, the honesty property: for random reports, the human report and the JSON document
// say the same thing about every result kind and every count, and SARIF holds exactly the non-pass results
// plus the file results. The reports go through the real WaiverApplier and RunSummarizer, and each renderer
// reads the one Report; nothing here parses text except the human report, which is the thing compared.

const TODAY = '2026-11-12';
const KINDS: readonly (RuleResultKind | 'WAIVED')[] = [
  'PASS',
  'PASS',
  'N/A',
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
  'WAIVED',
];
const KIND_WORDS = [
  'PASS',
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
  'N/A',
  'WAIVED',
] as const;
const NON_PASS = new Set(['FAIL', 'WARN', 'UNRESOLVED', 'VERSION-DEPENDENT', 'NOT EVALUATED']);

function randomName(rng: Rng, hostile: boolean, fallback: string): string {
  if (!hostile) return fallback;
  const s = randomHostileString(rng, 12);
  return s === '' ? fallback : s;
}

function randomReport(rng: Rng, hostile: boolean): Report {
  // a share of the reports hold only results that cannot make a run unclean, so green runs come up
  const pool = rng.next() < 0.35 ? (['PASS', 'PASS', 'N/A'] as const) : KINDS;
  const names = [randomName(rng, hostile, 'a'), 'b', randomName(rng, hostile, 'c')];
  const results: ReturnType<typeof wf>[] = [];
  const findings: Finding[] = [];
  names.slice(0, rng.int(0, 3)).forEach((name, i) => {
    const subject = workload(name, rng.pick(['shop', 'live'] as const));
    const own = (['T1', 'T2', 'T3'] as const)
      .slice(0, rng.int(1, 3))
      .map((rule) => finding(rng.pick(pool), rule, subject, `h ${rule}`));
    findings.push(...own);
    results.push(wf(subject, own, randomName(rng, hostile, `k8s/${i}.yaml`)));
  });
  if (rng.next() < 0.3) {
    const q = queue('orders');
    const own = [finding(rng.pick(pool), 'T4', q, 'h T4')];
    findings.push(...own);
    results.push(wf(q, own, 'infra/queue.tf'));
  }
  const fields = (): EntryFields => {
    const roll = rng.next();
    const base = {
      rule: rng.pick(['T1', 'T2', 'T3', 'T4'] as const),
      workload: rng.pick(['a', 'b', 'ghost'] as const),
      reason: randomName(rng, hostile, 'r'),
      until: rng.pick(['2026-11-12', '2027-06-01', '2020-01-01'] as const),
    };
    if (roll < 0.7) return base;
    if (roll < 0.8) return { ...base, rule: 'T9' };
    if (roll < 0.9) return { ...base, reason: '' };
    return { ...base, until: '2027-02-30' };
  };
  return buildReport({
    results,
    unchecked: Array.from({ length: rng.next() < 0.25 ? rng.int(1, 3) : 0 }, (_v, i) =>
      unchecked(
        randomName(rng, hostile, `k8s/u${i}.yaml`),
        rng.pick(['parse-error', 'over-size'] as const),
        5,
      ),
    ),
    notChecked:
      rng.next() < 0.2
        ? [
            {
              subjectKind: 'workload' as const,
              kind: 'Deployment' as const,
              file: unchecked('k8s/n.yaml').path,
              reasonCode: 'no-recognised-lb' as const,
            },
          ]
        : [],
    configErrors: rng.next() < 0.06 ? [configError(randomName(rng, hostile, 'k'), 3)] : [],
    noRecognisedFiles: results.length === 0 && rng.next() < 0.5,
    filesRead: rng.int(0, 5),
    waiverRecords: Array.from({ length: rng.int(0, 3) }, () => entry(fields(), rng.int(1, 9))),
    today: TODAY,
  });
}

/** The counts a person reads from the closing lines of the human report; a count that is not printed is 0. */
function closingCounts(human: string): Record<string, number> {
  const closing = (human.split('\n\n').pop() ?? '').replace(/\s+/g, ' ');
  const n = (re: RegExp): number => Number(re.exec(closing)?.[1] ?? 0);
  return {
    failed: n(/(\d+) failed/),
    warning: n(/(\d+) warnings?\b/),
    unresolved: n(/(\d+) unresolved/),
    versionDependent: n(/(\d+) version-dependent/),
    notEvaluated: n(/(\d+) not evaluated/),
    waived: n(/(\d+) waived/),
    notApplicable: n(/(\d+) not applicable/),
    passed:
      n(/(?:All checks passed \(|No failures: |, |Summary: )?(?:(\d+) passed|passed \((\d+)\))/) ||
      n(/All checks passed \((\d+)\)/),
  };
}

function humanKindCounts(human: string): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(KIND_WORDS.map((k) => [k, 0]));
  const re =
    /^ {2}(PASS|FAIL|WARN|UNRESOLVED|VERSION-DEPENDENT|NOT EVALUATED|N\/A|WAIVED) +T[1-4] {2}/;
  for (const line of human.split('\n')) {
    const m = re.exec(line);
    if (m?.[1] !== undefined) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

describe('JSON, SARIF and the human report agree', () => {
  it('holds for 2500 seeded random reports, with hostile names in half of them', {
    timeout: 60_000,
  }, () => {
    const rng = makeRng(20261112);
    let withWaivedResults = 0;
    let withFileResults = 0;
    let clean = 0;
    let e4 = 0;
    for (let i = 0; i < 2500; i += 1) {
      const hostile = i % 2 === 1;
      const report = randomReport(rng, hostile);
      const human = renderHuman(report);
      const jsonText = renderJson(report);
      const sarifText = renderSarif(report);
      const where = `case ${i}`;
      const json = JSON.parse(jsonText);
      const sarif = JSON.parse(sarifText);
      const s = report.summary;

      // both documents are plain ASCII JSON, and the SARIF is valid for the subset
      expect(jsonText, where).toMatch(/^[\n\x20-\x7e]*$/);
      expect(sarifText, where).toMatch(/^[\n\x20-\x7e]*$/);
      expect(validateSarif(sarif), where).toEqual([]);

      // JSON results: the same kinds, in the same numbers, as the result lines of the human report
      const jsonResults = json.workloads.flatMap(
        (w: { results: { kind: string; rule: string; originalKind?: string }[] }) => w.results,
      ) as { kind: string; rule: string; originalKind?: string }[];
      const fromJson: Record<string, number> = Object.fromEntries(KIND_WORDS.map((k) => [k, 0]));
      for (const r of jsonResults) fromJson[r.kind] = (fromJson[r.kind] ?? 0) + 1;
      expect(fromJson, where).toEqual(humanKindCounts(human));

      // the summary: JSON equals the Report, and the closing lines of the human report print the same counts
      expect(json.summary, where).toEqual({
        failed: s.counts.failed,
        warning: s.counts.warning,
        unresolved: s.counts.unresolved,
        versionDependent: s.counts.versionDependent,
        notEvaluated: s.counts.notEvaluated,
        waived: s.counts.waived,
        notApplicable: s.counts.notApplicable,
        passed: s.counts.passed,
        outcome: s.outcome,
        clean: s.clean,
        waivedDates: [...s.waivedDates],
        exitCode: s.exitCode,
      });
      // On the config-error case stop no rule ran: every count is 0 whatever is listed, and the exit is 2. On every other
      // outcome the unresolved count is the UNRESOLVED results, the unchecked files and the waivers not applied.
      if (s.outcome === 'ConfigError') {
        expect(
          Object.values(s.counts).every((n) => n === 0),
          where,
        ).toBe(true);
        expect(json.summary.exitCode, where).toBe(2);
        expect(json.workloads, where).toEqual([]);
        expect(json.unchecked.length, where).toBe(report.unchecked.length);
      }
      // the closing lines of NothingChecked and ConfigError print no counts, so there is nothing to compare
      if (s.outcome !== 'ConfigError' && s.outcome !== 'NothingChecked') {
        const printed = closingCounts(human);
        for (const key of Object.keys(printed) as (keyof typeof printed)[]) {
          if (key === 'passed') continue; // checked below, the closing lines word it three ways
          expect(printed[key], `${where} ${key}`).toBe(json.summary[key]);
        }
        expect(printed.passed, `${where} passed`).toBe(json.summary.passed);
      }
      // every kind count equals the number of results of that kind (unresolved also counts the file results)
      expect(json.summary.failed, where).toBe(fromJson.FAIL);
      expect(json.summary.warning, where).toBe(fromJson.WARN);
      expect(json.summary.versionDependent, where).toBe(fromJson['VERSION-DEPENDENT']);
      expect(json.summary.notEvaluated, where).toBe(fromJson['NOT EVALUATED']);
      expect(json.summary.waived, where).toBe(fromJson.WAIVED);
      expect(json.summary.notApplicable, where).toBe(fromJson['N/A']);
      expect(json.summary.passed, where).toBe(fromJson.PASS);
      const notApplied = json.waivers.filter(
        (w: { state: string }) => w.state === 'unmatched' || w.state === 'invalid',
      ).length;
      if (s.outcome !== 'ConfigError') {
        expect(json.summary.unresolved, where).toBe(
          (fromJson.UNRESOLVED ?? 0) + json.unchecked.length + notApplied,
        );
      }
      // clean follows from the outcome, which follows from the exit code, in every format
      expect(json.summary.clean, where).toBe(json.summary.exitCode === 0);
      expect(sarif.runs[0].properties.tripcurve, where).toMatchObject({
        outcome: s.outcome,
        clean: s.clean,
        exitCode: s.exitCode,
        summary: { ...s.counts },
      });

      // SARIF: exactly the non-pass results plus the file results
      const results = sarif.runs[0].results as {
        ruleId: string;
        level: string;
        message: { text: string };
        suppressions?: unknown[];
        properties: { tripcurve: { kind?: string; originalKind?: string } };
      }[];
      const ruleResults = results.filter((r) => /^T[1-4]$/.test(r.ruleId));
      const fileResults = results.filter((r) => r.ruleId === 'tripcurve-file');
      const noteResults = results.filter((r) => r.ruleId === 'tripcurve-not-checked');
      const runResults = results.filter((r) => r.ruleId === 'tripcurve-run');
      const effective = (r: { kind: string; originalKind?: string }): string =>
        r.originalKind ?? r.kind;
      const expectedRule = jsonResults
        .filter((r) => NON_PASS.has(effective(r)))
        .map((r) => `${r.rule} ${effective(r)} ${r.kind === 'WAIVED'}`);
      expect(
        ruleResults.map(
          (r) =>
            `${r.ruleId} ${r.properties.tripcurve.originalKind ?? r.properties.tripcurve.kind} ${r.properties.tripcurve.kind === 'WAIVED'}`,
        ),
        where,
      ).toEqual(expectedRule);
      const expectedFiles =
        report.unchecked.length +
        report.waiversNotApplied.length +
        report.configErrors.length +
        (s.outcome === 'NothingChecked' ? 1 : 0);
      expect(fileResults.length, where).toBe(expectedFiles);
      expect(
        fileResults.every((r) => r.level === 'warning' && r.suppressions === undefined),
        where,
      ).toBe(true);
      expect(results.length, where).toBe(
        ruleResults.length + fileResults.length + noteResults.length + runResults.length,
      );
      // Review M2: no message holds an unescaped bracket or brace, so no embedded link or placeholder can be formed
      for (const r of results) {
        expect(r.message.text.replace(/\\[[\]]|\{\{|\}\}/g, ''), where).not.toMatch(/[[\]{}]/);
      }
      // one note per workload that was not checked, and never a warning (the run stays clean)
      expect(noteResults.length, where).toBe(report.notChecked.length);
      expect(noteResults.length, where).toBe(sarif.runs[0].properties.tripcurve.notChecked);
      expect(
        noteResults.every((r) => r.level === 'note'),
        where,
      ).toBe(true);
      // Review M1: every document of a run that is not clean holds an unsuppressed error or warning, and the
      // run-level result is there exactly when nothing else says so
      const saysSo = results.filter(
        (r) =>
          r.ruleId !== 'tripcurve-run' &&
          (r.level === 'error' || r.level === 'warning') &&
          r.suppressions === undefined,
      );
      expect(runResults.length, where).toBe(!s.clean && saysSo.length === 0 ? 1 : 0);
      if (!s.clean) {
        expect(
          results.filter(
            (r) => (r.level === 'error' || r.level === 'warning') && r.suppressions === undefined,
          ).length,
          where,
        ).toBeGreaterThan(0);
      }
      // levels follow the effective kind; suppressions are exactly the waived results
      for (const r of ruleResults) {
        const kind = r.properties.tripcurve.originalKind ?? r.properties.tripcurve.kind;
        const level = kind === 'FAIL' ? 'error' : kind === 'NOT EVALUATED' ? 'note' : 'warning';
        expect(r.level, where).toBe(level);
        expect(r.suppressions !== undefined, where).toBe(r.properties.tripcurve.kind === 'WAIVED');
      }
      // honesty: a non-zero exit never has an empty results array, and a clean run has no problem result
      if (s.exitCode !== 0) expect(results.length, where).toBeGreaterThan(0);
      if (s.clean) {
        expect(
          ruleResults.every((r) => r.properties.tripcurve.kind === 'WAIVED'),
          where,
        ).toBe(true);
        expect(fileResults, where).toEqual([]);
      }

      withWaivedResults += fromJson.WAIVED && fromJson.WAIVED > 0 ? 1 : 0;
      withFileResults += fileResults.length > 0 ? 1 : 0;
      clean += s.clean ? 1 : 0;
      e4 += s.outcome === 'ConfigError' ? 1 : 0;
    }
    // the generator really reached each branch
    expect(withWaivedResults).toBeGreaterThan(100);
    expect(withFileResults).toBeGreaterThan(300);
    expect(clean).toBeGreaterThan(50);
    expect(e4).toBeGreaterThan(30);
  });

  it('the checks can fail: a document that drops a result or flips a level is caught', () => {
    const report = buildReport({
      results: [wf(workload('a'), [finding('FAIL', 'T1'), finding('PASS', 'T2')])],
    });
    const sarif = JSON.parse(renderSarif(report));
    expect(sarif.runs[0].results).toHaveLength(1);
    sarif.runs[0].results[0].level = 'warning';
    expect(sarif.runs[0].results[0].level).not.toBe('error');
    const json = JSON.parse(renderJson(report));
    const kinds = json.workloads[0].results.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(['FAIL', 'PASS']);
    expect(humanKindCounts(renderHuman(report))).toMatchObject({ FAIL: 1, PASS: 1 });
  });
});
