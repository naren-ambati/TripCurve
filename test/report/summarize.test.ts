import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/index.js';
import {
  configErrorSummary,
  decideOutcome,
  isCleanOutcome,
  OUTCOMES,
  type Outcome,
  summarizeRun,
  ZERO_DOWNTIME_LINE,
} from '../../src/report/index.js';
import { finding } from '../support/report-fixtures.js';

const k = (kind: Parameters<typeof finding>[0], n = 1): Finding[] =>
  Array.from({ length: n }, () => finding(kind));

function sum(findings: Finding[], files = 0, notChecked = 0, waivers = 0) {
  return summarizeRun({
    findings,
    uncheckedFiles: files,
    workloadsNotChecked: notChecked,
    waiversNotApplied: waivers,
  });
}

describe('the outcome precedence (interaction spec table)', () => {
  const cases: Array<[string, ReturnType<typeof sum>, Outcome, number]> = [
    ['no result at all', sum([]), 'NothingChecked', 2],
    [
      'no result, but a file not checked: still NothingChecked first',
      sum([], 1),
      'NothingChecked',
      2,
    ],
    ['a file not checked beats a failure', sum([...k('FAIL'), ...k('PASS')], 1), 'Incomplete', 1],
    ['a file not checked beats a pass', sum(k('PASS'), 1), 'Incomplete', 1],
    ['a failure with waivers is NotClean', sum([...k('FAIL'), ...k('WAIVED')]), 'NotClean', 1],
    ['an unresolved result', sum([...k('PASS'), ...k('UNRESOLVED')]), 'NotClean', 1],
    ['a warning', sum([...k('PASS'), ...k('WARN')]), 'NotClean', 1],
    ['version-dependent', sum(k('VERSION-DEPENDENT')), 'NotClean', 1],
    ['not evaluated', sum(k('NOT EVALUATED')), 'NotClean', 1],
    ['an unmatched waiver', sum(k('PASS'), 0, 0, 1), 'NotClean', 1],
    ['a valid waiver with passes', sum([...k('PASS'), ...k('WAIVED')]), 'NoFailures', 0],
    ['only not applicable', sum(k('N/A', 3)), 'NoChecksApply', 0],
    ['a pass and the rest not applicable', sum([...k('PASS'), ...k('N/A')]), 'Clean', 0],
  ];
  it.each(cases)('%s', (_name, summary, outcome, exit) => {
    expect(summary.outcome).toBe(outcome);
    expect(summary.exitCode).toBe(exit);
  });
});

describe('clean follows from the outcome and is true exactly when the exit is 0', () => {
  it('for every outcome', () => {
    for (const outcome of OUTCOMES) {
      const exit =
        outcome === 'NoFailures' || outcome === 'NoChecksApply' || outcome === 'Clean'
          ? 0
          : undefined;
      expect(isCleanOutcome(outcome)).toBe(exit === 0);
    }
  });

  it('on every summary the summarizer builds', () => {
    const sets: Finding[][] = [
      [],
      k('PASS'),
      k('FAIL'),
      k('WAIVED'),
      k('N/A'),
      [...k('PASS'), ...k('N/A')],
    ];
    for (const set of sets) {
      for (const files of [0, 1]) {
        const s = sum(set, files);
        expect(s.clean).toBe(s.exitCode === 0);
      }
    }
    expect(configErrorSummary().clean).toBe(false);
    expect(configErrorSummary().exitCode).toBe(2);
  });

  it('decideOutcome alone follows the precedence', () => {
    expect(
      decideOutcome({ results: 1, uncheckedFiles: 0, notClean: false, waived: 0, passed: 1 }),
    ).toBe('Clean');
    expect(
      decideOutcome({ results: 0, uncheckedFiles: 5, notClean: true, waived: 0, passed: 0 }),
    ).toBe('NothingChecked');
  });
});

describe('the closing lines (exact wording)', () => {
  it('Clean, no waivers', () => {
    expect(sum([...k('PASS', 7), ...k('N/A')]).closingLines).toEqual([
      'All checks passed (7), 1 not applicable.',
      ZERO_DOWNTIME_LINE,
    ]);
  });

  it('Clean with workloads not checked: the one allowed form', () => {
    expect(sum([...k('PASS', 7), ...k('N/A')], 0, 2).closingLines).toEqual([
      'All checks passed (7), 1 not applicable; 2 workloads not checked.',
      ZERO_DOWNTIME_LINE,
    ]);
    expect(sum(k('PASS'), 0, 1).closingLines[0]).toBe(
      'All checks passed (1), 0 not applicable; 1 workload not checked.',
    );
  });

  it('NoFailures lists the waiver dates and never says All checks passed', () => {
    const s = sum([...k('PASS', 7), ...k('WAIVED', 2), ...k('N/A')], 0, 2);
    expect(s.closingLines).toEqual([
      'No failures: 7 passed, 2 waived (expiring 2027-01-31), 1 not applicable; 2 workloads not checked.',
      ZERO_DOWNTIME_LINE,
    ]);
    expect(s.counts.passed).toBe(7);
    expect(s.waivedDates).toEqual(['2027-01-31']);
  });

  it('only not applicable', () => {
    expect(sum(k('N/A', 3)).closingLines).toEqual(['No checks apply: 3 not applicable.']);
  });

  it('not clean, in the fixed count order, zero counts left out', () => {
    const s = sum([
      ...k('PASS', 3),
      ...k('FAIL', 4),
      ...k('UNRESOLVED'),
      ...k('NOT EVALUATED'),
      ...k('N/A'),
    ]);
    expect(s.closingLines).toEqual([
      'Summary: 4 failed, 1 unresolved, 1 not evaluated, 1 not applicable, 3 passed; not a clean result',
    ]);
  });

  it('a warning is singular or plural by its count', () => {
    expect(sum(k('WARN')).closingLines[0]).toBe('Summary: 1 warning; not a clean result');
    expect(sum(k('WARN', 2)).closingLines[0]).toBe('Summary: 2 warnings; not a clean result');
  });

  it('unchecked files and waivers count under unresolved, with brackets and no comma before them', () => {
    expect(sum([...k('FAIL'), ...k('PASS', 2)], 1).closingLines[0]).toBe(
      'Summary: 1 failed, 1 unresolved (1 file not checked), 2 passed; run incomplete, not a clean result',
    );
    expect(sum(k('PASS', 9), 0, 0, 1).closingLines[0]).toBe(
      'Summary: 1 unresolved (1 waiver not applied), 9 passed; not a clean result',
    );
    expect(sum(k('PASS'), 2, 0, 1).closingLines[0]).toBe(
      'Summary: 3 unresolved (2 files not checked, 1 waiver not applied), 1 passed; run incomplete, not a clean result',
    );
  });

  it('an unresolved finding and an unchecked file add up', () => {
    const s = sum([...k('UNRESOLVED'), ...k('PASS')], 1);
    expect(s.counts.unresolved).toBe(2);
    expect(s.unresolvedDetail).toEqual({ files: 1, waivers: 0 });
  });

  it('nothing checked', () => {
    expect(sum([]).closingLines).toEqual(['Summary: nothing checked; not a clean result']);
  });

  it('nothing checked, with files or waivers that are unresolved: the human summary carries the same count as JSON (B22)', () => {
    const one = sum([], 1);
    expect(one.counts.unresolved).toBe(1);
    expect(one.closingLines).toEqual([
      'Summary: nothing checked, 1 unresolved (1 file not checked); not a clean result',
    ]);
    expect(sum([], 2, 0, 1).closingLines).toEqual([
      'Summary: nothing checked, 3 unresolved (2 files not checked, 1 waiver not applied); not a clean result',
    ]);
  });

  it('All checks passed (0) is never printed', () => {
    for (const set of [[], k('N/A'), k('WAIVED'), k('FAIL')]) {
      expect(sum(set).closingLines.join('\n')).not.toContain('All checks passed (0)');
    }
  });

  it('a result kind that is not one of the eight is counted as unresolved, never as good', () => {
    const odd = { ...finding('PASS'), kind: 'GREAT' } as unknown as Finding;
    const s = sum([odd, ...k('PASS')]);
    expect(s.outcome).toBe('NotClean');
    expect(s.counts.unresolved).toBe(1);
  });
});
