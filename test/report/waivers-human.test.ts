import { describe, expect, it } from 'vitest';
import {
  type Finding,
  fileSource,
  inputText,
  makeFinding,
  makeUnresolved,
  SafeText,
} from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import { buildReport, finding, goodChain, wf, workload } from '../support/report-fixtures.js';
import { entry, VALID_ENTRY } from '../support/waiver-records.js';

// How the human report prints a waiver in each of its four states.

const api = workload('api', 'shop');
const failT2 = (): Finding => finding('FAIL', 'T2', api, 'no drain delay before SIGTERM');
const TODAY = '2026-11-12';

function report(
  records: ReturnType<typeof entry>[],
  findings: Finding[] = [failT2()],
  today = TODAY,
) {
  return buildReport({ results: [wf(api, findings)], waiverRecords: records, today });
}

describe('WAIVED', () => {
  const r = report([entry(VALID_ENTRY)]);
  const text = renderHuman(r);

  it('is the one line form: original kind, headline, date, quoted reason and source', () => {
    expect(text).toContain(
      '  WAIVED T2  (was FAIL: no drain delay before SIGTERM) until 2027-01-31:\n           reason "drains in sidecar" from "tripcurve.yaml":3\n',
    );
  });

  it('has no chain lines under it (the line repeats what it covers), but --verbose adds the chain', () => {
    const withChain = finding(
      'FAIL',
      'T2',
      api,
      'no drain delay before SIGTERM',
      goodChain('k8s/api.yaml', 12),
    );
    const lines = renderHuman(report([entry(VALID_ENTRY)], [withChain])).split('\n');
    const at = lines.findIndex((l) => l.startsWith('  WAIVED T2'));
    expect(lines[at + 2]).toBe('');
    expect(renderHuman(report([entry(VALID_ENTRY)], [withChain]), { verbose: true })).toContain(
      '           idle close 12 s  "k8s/api.yaml":12\n',
    );
    expect(renderHuman(report([entry(VALID_ENTRY)], [withChain]))).not.toContain('idle close');
  });

  it('never carries the declare lines of a result it covers', () => {
    const unresolved = makeFinding({
      rule: 'T2',
      subject: api,
      kind: 'UNRESOLVED',
      headline: 'source not linked',
      chain: [{ label: 'source', value: makeUnresolved('not linked') }],
      declare: ['link the source for this workload'],
    });
    const t = renderHuman(report([entry(VALID_ENTRY)], [unresolved]));
    expect(t).toContain('(was UNRESOLVED: source not linked)');
    expect(t).not.toContain('link the source for this workload');
  });

  it('colours only the result word, and removing the colour gives the plain text', () => {
    const coloured = renderHuman(r, { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
    expect(coloured.replace(/\u001b\[[0-9;]*m/g, '')).toBe(text);
    expect(coloured).toContain('\u001b[36mWAIVED\u001b[0m');
  });

  it('quotes a reason that holds control characters, quotes and non-ASCII, and stays within 80 columns', () => {
    const hostile = `a"b\\c\u001b[2J\né ${'x'.repeat(300)}`;
    const t = renderHuman(report([entry({ ...VALID_ENTRY, reason: hostile.slice(0, 200) })]));
    for (const line of t.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(t).not.toContain('\u001b');
  });
});

describe('an expired waiver', () => {
  const text = renderHuman(report([entry({ ...VALID_ENTRY, until: '2026-10-31' })]));
  it('leaves the finding as it was and says so under it', () => {
    expect(text).toContain(
      '  FAIL T2  no drain delay before SIGTERM\n           waiver expired on 2026-10-31\n           reason "drains in sidecar" from "tripcurve.yaml":3\n',
    );
    expect(text).not.toContain('WAIVED');
  });
  it('does not make the run clean: not a waived count, not No failures', () => {
    expect(text).toContain('Summary: 1 failed; not a clean result');
    expect(text).not.toContain('No failures');
  });
});

describe('Waivers not applied', () => {
  it('an unmatched waiver says which rule and workload found nothing', () => {
    const t = renderHuman(report([entry(VALID_ENTRY)], [finding('PASS', 'T2', api)]));
    expect(t).toContain(
      'Waivers not applied\n  UNRESOLVED (file)  no finding for rule T2 on workload "api" matches the waiver\n                     at "tripcurve.yaml":3\n',
    );
    expect(t).toContain(
      'Summary: 1 unresolved (1 waiver not applied), 1 passed; not a clean result',
    );
  });

  it('an invalid waiver is quoted, says what is wrong, and says it suppresses nothing', () => {
    const t = renderHuman(report([entry({ rule: 'T2', workload: 'api', until: '2027-01-31' })]));
    expect(t).toContain(
      '  UNRESOLVED (file)  waiver "rule: \\"T2\\" workload: \\"api\\" until: \\"2027-01..."\n                     at "tripcurve.yaml":3 has no reason; it suppresses nothing\n',
    );
    expect(t).toContain('FAIL T2  no drain delay before SIGTERM');
    expect(t).toContain('1 failed, 1 unresolved (1 waiver not applied)');
  });

  it('the section comes after the blocks and before the Assumptions, one line per waiver', () => {
    const t = renderHuman(
      report(
        [entry({ ...VALID_ENTRY, rule: 'T9' }), entry({ ...VALID_ENTRY, workload: 'ghost' }, 7)],
        [failT2()],
      ),
    );
    const at = t.indexOf('Waivers not applied');
    expect(at).toBeGreaterThan(t.indexOf('Workload "api"'));
    expect(t.match(/^ {2}UNRESOLVED \(file\) {2}/gm)).toHaveLength(2);
    expect(t.replace(/\s+/g, ' ')).toContain(
      'names a rule that is not T1, T2, T3 or T4; it suppresses nothing',
    );
    expect(t.replace(/\s+/g, ' ')).toContain(
      'names a workload that was not read; it suppresses nothing',
    );
  });

  it('prints none when every waiver applied', () => {
    expect(renderHuman(report([entry(VALID_ENTRY)]))).not.toContain('Waivers not applied');
  });
});

describe('the report model', () => {
  it('holds every waiver, in every state, for the renderers of bolt B7', () => {
    const r = report([
      entry(VALID_ENTRY),
      entry({ ...VALID_ENTRY, until: '2020-01-01' }, 9),
      entry({ ...VALID_ENTRY, rule: 'T9' }, 11),
    ]);
    // two waivers cover the one finding: both are invalid; a third is invalid too
    expect(r.waivers.map((w) => w.state)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(r.waiversNotApplied).toHaveLength(3);
    const ok = report([entry(VALID_ENTRY)]);
    expect(ok.waivers.map((w) => w.state)).toEqual(['applied']);
    expect(ok.waiversNotApplied).toEqual([]);
    expect(ok.summary.waivedDates).toEqual(['2027-01-31']);
  });

  it('counts a waived result as waived and never as passed, and an unmatched one as unresolved', () => {
    const r = report(
      [entry(VALID_ENTRY)],
      [failT2(), finding('PASS', 'T1', api, 'ok', goodChain())],
    );
    expect(r.summary.counts.waived).toBe(1);
    expect(r.summary.counts.passed).toBe(1);
    expect(r.summary.outcome).toBe('NoFailures');
    expect(r.summary.exitCode).toBe(0);
    const unmatched = report([entry({ ...VALID_ENTRY, rule: 'T3' })], [failT2()]);
    expect(unmatched.summary.counts.unresolved).toBe(1);
    expect(unmatched.summary.unresolvedDetail.waivers).toBe(1);
    expect(unmatched.summary.exitCode).toBe(1);
  });

  it('a run with no valid date lists every waiver and is not clean', () => {
    const r = buildReport({ results: [wf(api, [failT2()])], waiverRecords: [entry(VALID_ENTRY)] });
    expect(r.waivers.map((w) => w.state)).toEqual(['invalid']);
    expect(r.summary.exitCode).toBe(1);
    expect(renderHuman(r).replace(/\s+/g, ' ')).toContain(
      'cannot be judged because the date of the run is not known',
    );
  });

  it('an inline waiver source prints as the comment line, a config waiver as the quoted declaration', () => {
    const rec = entry(VALID_ENTRY, 14, 'tripcurve.yaml');
    expect(renderHuman(report([rec]))).toContain('from "tripcurve.yaml":14');
    // a file source built by hand reads the same way
    expect(fileSource(inputText('k8s/a.yaml'), 9).type).toBe('file');
  });
});

describe('a hostile number of waivers', () => {
  const many = Array.from({ length: 120 }, (_v, i) =>
    entry({ ...VALID_ENTRY, workload: `ghost${i}` }, 3 + i),
  );
  const t = renderHuman(report(many));

  it('lists the first 50, says how many more there are, and the summary counts every one', () => {
    expect(t.match(/^ {2}UNRESOLVED \(file\) {2}waiver /gm)).toHaveLength(50);
    expect(t.replace(/\s+/g, ' ')).toContain(
      'UNRESOLVED (file) ... and 70 more waivers not applied, each counted under unresolved.',
    );
    expect(t).toContain('Summary: 1 failed, 120 unresolved (120 waivers not applied); not a clean');
  });

  it('is still plain ASCII within 80 columns', () => {
    for (const line of t.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('says nothing about "more" when the list fits', () => {
    expect(renderHuman(report(many.slice(0, 50)))).not.toContain('more waiver');
    expect(renderHuman(report(many.slice(0, 51)))).toContain('... and 1 more waiver not applied,');
  });
});

describe('a long reason is printed whole', () => {
  const chunksOf = (text: string): string[] =>
    [...text.matchAll(/^ {11}reason \(part (\d+) of (\d+)\) "(.*)"$/gm)].map((m) => m[3] as string);
  const whole = (reason: string): string =>
    SafeText.render(inputText(reason), 'terminal', { maxLength: 100_000 }).slice(1, -1);

  it.each([
    ['plain words', 'word '.repeat(40).trim()],
    ['200 non-ASCII characters', '\u00e9'.repeat(200)],
    ['quotes and backslashes', 'say "hi" \\ '.repeat(15).slice(0, 200)],
    ['astral characters', '\u{1f600}'.repeat(100)],
    ['control characters', 'a\u0007b\u001b[2J c\n '.repeat(20).slice(0, 200)],
    ['the longest reason', 'r'.repeat(200)],
  ])(
    '%s: every character is there, in order, quoted, each line within 80 columns',
    (_name, reason) => {
      const t = renderHuman(report([entry({ ...VALID_ENTRY, reason })]));
      const pieces = chunksOf(t);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.join('')).toBe(whole(reason));
      for (const piece of pieces) {
        // no piece ends in the middle of an escape
        expect(piece).not.toMatch(/\\(?:x[0-9a-f]?|u[0-9a-f]{0,3})?$/);
      }
      for (const line of t.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(80);
        expect(line).toMatch(/^[\x20-\x7e]*$/);
        // the quoted text never starts a line
        expect(line.trimStart().startsWith('"')).toBe(false);
      }
      expect(t).toContain('until 2027-01-31:\n');
      expect(t).toContain(`${' '.repeat(11)}from "tripcurve.yaml":3\n`);
    },
  );

  it('a short reason stays on the WAIVED line, exactly as before', () => {
    const reason = 'x'.repeat(30);
    expect(renderHuman(report([entry({ ...VALID_ENTRY, reason })]))).toContain(
      `until 2027-01-31:\n           reason "${reason}" from "tripcurve.yaml":3\n`,
    );
  });

  it('the first reason that does not fit moves to its own lines (48 characters)', () => {
    const t = renderHuman(report([entry({ ...VALID_ENTRY, reason: 'y'.repeat(49) })]));
    expect(chunksOf(t).join('')).toBe('y'.repeat(49));
  });

  it('an expired waiver says its whole reason too', () => {
    const reason = 'because '.repeat(24).trim();
    const t = renderHuman(report([entry({ ...VALID_ENTRY, reason, until: '2026-10-31' })]));
    expect(t).toContain('waiver expired on 2026-10-31\n');
    expect(chunksOf(t).join('')).toBe(whole(reason));
    for (const line of t.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });
});
