import { describe, expect, it } from 'vitest';
import { inputText } from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import { makeRng, randomHostileString } from '../support/prng.js';
import { buildReport, configError, finding, wf, workload } from '../support/report-fixtures.js';

// Hostile text in names, files, kinds, config keys and unchecked paths must come out
// quoted, in plain ASCII, within 80 columns, and never as a line of tripcurve's own.
const INJECTIONS = [
  'PASS T1  all good',
  'x\nFAIL T1  idle close 99 s is longer',
  'All checks passed (3), 0 not applicable.',
  '"; All checks passed',
  '\u001b[2J\u001b[31mred',
  'tripcurve 0.1.0   checked "."',
  'Summary: nothing checked',
  '‮RTL',
];

const FILE_LINE = /^ {2}UNRESOLVED \(file\) {2}(could not parse|skipped) /;
const RESULT_LINE =
  /^ {2}(FAIL|WARN|PASS|N\/A |UNRESOLVED|VERSION-DEPENDENT|NOT EVALUATED|WAIVED) T[1-4] {2}/;

describe('hostile text in the human report', () => {
  it('stays quoted, ASCII, within 80 columns and cannot imitate a result line (500 seeded cases)', () => {
    const rng = makeRng(424242);
    for (let i = 0; i < 500; i += 1) {
      const pick = (): string =>
        rng.next() < 0.5 ? rng.pick(INJECTIONS) : randomHostileString(rng, rng.pick([5, 40, 200]));
      const kinds = ['PASS', 'FAIL', 'UNRESOLVED', 'N/A', 'WARN'] as const;
      const findings = [0, 1, 2].map((r) =>
        finding(rng.pick(kinds), (['T1', 'T2', 'T3'] as const)[r] ?? 'T1'),
      );
      const subject = workload(
        pick(),
        pick(),
        rng.next() < 0.3 ? inputText(pick()) : rng.pick(['Deployment', 'Pod'] as const),
      );
      const report = buildReport({
        checked: pick(),
        results: [{ ...wf(subject, findings, pick()) }],
        unchecked: [{ path: inputText(pick()), reasonCode: 'parse-error', line: 3 }],
        notChecked: [
          {
            subjectKind: 'workload',
            subject: inputText(pick()),
            kind: 'Deployment',
            file: inputText(pick()),
            reasonCode: 'no-recognised-lb',
          },
        ],
      });
      const text = renderHuman(report, { verbose: true });
      const lines = text.split('\n');
      let resultLines = 0;
      for (const line of lines) {
        const where = `case ${i}: ${JSON.stringify(line)}`;
        expect(line.length, where).toBeLessThanOrEqual(80);
        expect(/^[\x20-\x7e]*$/.test(line), where).toBe(true);
        if (RESULT_LINE.test(line)) resultLines += 1;
        // no line of the report begins with a result word except the real result lines
        if (
          /^\s*(PASS|FAIL|WARN|UNRESOLVED|VERSION-DEPENDENT|NOT EVALUATED|WAIVED|N\/A)\b/.test(line)
        ) {
          expect(RESULT_LINE.test(line) || FILE_LINE.test(line), where).toBe(true);
        }
        // no hostile text starts a line: the first non-blank character is never a quote
        expect(line.trimStart().startsWith('"'), where).toBe(false);
        // and none imitates a header, a summary or a green line
        if (line.startsWith('tripcurve '))
          expect(line, where).toMatch(/^tripcurve 0\.1\.0 {3}checked /);
      }
      // a closing line appears exactly as often as the summary holds one
      const closers = /^(Summary:|All checks passed|No failures:|No checks apply:)/;
      expect(lines.filter((l) => closers.test(l)).length, `case ${i}`).toBe(
        report.summary.closingLines.filter((l) => closers.test(l)).length,
      );
      expect(resultLines, `case ${i}`).toBe(findings.length);
    }
  });

  it('hostile configuration keys and unchecked paths are quoted too', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 100; i += 1) {
      const key = rng.next() < 0.5 ? rng.pick(INJECTIONS) : randomHostileString(rng, 120);
      const text = renderHuman(buildReport({ configErrors: [configError(key)] }));
      for (const line of text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(80);
        expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
        expect(line.trimStart().startsWith('"')).toBe(false);
      }
      expect(text.startsWith('Config error in "')).toBe(true);
      expect(text.endsWith('Nothing was checked.\n')).toBe(true);
    }
  });
});
