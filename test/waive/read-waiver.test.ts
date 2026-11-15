import { describe, expect, it } from 'vitest';
import {
  isIsoDate,
  MAX_REASON_CHARS,
  readWaiver,
  WAIVER_PROBLEMS,
  type WaiverProblemCode,
} from '../../src/waive/index.js';
import { txt } from '../support/render.js';
import { entry, inline, VALID_ENTRY } from '../support/waiver-records.js';

// WaiverApplier is the one validator. readWaiver reads one raw record into what it says and
// names the FIRST thing wrong with it (form, then rule, then reason, then date, then workload).

function read(text: string) {
  return readWaiver(inline(text));
}

describe('an inline waiver: the exact grammar', () => {
  it('reads rule, reason and date', () => {
    const w = read('# tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31');
    expect(w.problem).toBeUndefined();
    expect(w.ruleText).toBe('T2');
    expect(txt(w.reason)).toBe('drains in sidecar');
    expect(w.untilText).toBe('2027-01-31');
    // shown without its comment mark
    expect(txt(w.text)).toBe('tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31');
  });

  it.each([
    ['# tripcurve: ignore T1 reason="a" until=2027-01-31'],
    ['#tripcurve: ignore T1 reason="a" until=2027-01-31'],
    ['// tripcurve: ignore T1 reason="a" until=2027-01-31'],
    ['#   tripcurve:   ignore   T1   reason="a"   until=2027-01-31   '],
  ])('%j is valid (hash or slashes, spacing)', (text) => {
    expect(read(text).problem).toBeUndefined();
  });

  it('reads YAML double-quote escapes in the reason', () => {
    const w = read(
      '# tripcurve: ignore T3 reason="say \\"hi\\" \\\\ \\x41\\u00e9\\t" until=2027-01-31',
    );
    expect(w.problem).toBeUndefined();
    expect(txt(w.reason)).toBe('say "hi" \\ Aé\t');
  });

  it('a reason may hold the words until= and reason= (the closing quote decides)', () => {
    const w = read('# tripcurve: ignore T3 reason="until=2030-01-01 reason=x" until=2027-01-31');
    expect(w.problem).toBeUndefined();
    expect(w.untilText).toBe('2027-01-31');
    expect(txt(w.reason)).toBe('until=2030-01-01 reason=x');
  });

  const cases: ReadonlyArray<readonly [string, WaiverProblemCode]> = [
    ['# tripcurve:', 'not-in-form'],
    ['# tripcurve: please', 'not-in-form'],
    ['# tripcurve: ignoreT2 reason="a" until=2027-01-31', 'not-in-form'],
    ['# tripcurve: ignore', 'no-rule'],
    ['# tripcurve: ignore T9 reason="a" until=2027-01-31', 'unknown-rule'],
    ['# tripcurve: ignore t2 reason="a" until=2027-01-31', 'unknown-rule'],
    ['# tripcurve: ignore T2 until=2027-01-31', 'no-reason'],
    ['# tripcurve: ignore T2 reason= until=2027-01-31', 'empty-reason'],
    ['# tripcurve: ignore T2 reason="" until=2027-01-31', 'empty-reason'],
    ['# tripcurve: ignore T2 reason="   " until=2027-01-31', 'empty-reason'],
    ['# tripcurve: ignore T2 reason=drains until=2027-01-31', 'not-in-form'],
    ['# tripcurve: ignore T2 reason="open until=2027-01-31', 'not-in-form'],
    ['# tripcurve: ignore T2 reason="bad \\q escape" until=2027-01-31', 'not-in-form'],
    ['# tripcurve: ignore T2 reason="a"until=2027-01-31', 'not-in-form'],
    ['# tripcurve: ignore T2 reason="a"', 'no-date'],
    ['# tripcurve: ignore T2 reason="a" until=', 'no-date'],
    ['# tripcurve: ignore T2 reason="a" until=never', 'bad-date'],
    ['# tripcurve: ignore T2 reason="a" until=2027-02-30', 'bad-date'],
    ['# tripcurve: ignore T2 reason="a" until=2027-1-5', 'bad-date'],
    ['# tripcurve: ignore T2 reason="a" until=2027-01-31 extra', 'not-in-form'],
    // the order of the grammar is fixed: reason, then until
    ['# tripcurve: ignore T2 until=2027-01-31 reason="a"', 'not-in-form'],
    // the first problem wins: form, rule, reason, date
    ['# tripcurve: ignore T9 until=never', 'unknown-rule'],
    ['# tripcurve: ignore T2 until=never', 'no-reason'],
  ];
  it.each(cases)('%j is invalid: %s', (text, problem) => {
    expect(read(text).problem).toBe(problem);
  });

  it.each([
    ['a zero-width space', '\u200b'],
    ['several zero-width characters', '\u200b\u200c\u200d\ufeff'],
    ['a NUL', '\\0'],
    ['a NUL and blanks', ' \\0 \\t'],
    ['a line separator', '\u2028'],
    ['a no-break space', '\u00a0'],
    ['a control character', '\\x07'],
  ])('a reason of only %s is empty', (_name, reason) => {
    expect(read(`# tripcurve: ignore T2 reason="${reason}" until=2027-01-31`).problem).toBe(
      'empty-reason',
    );
  });

  it.each(['a', '7', '!', '+', '\u00e9', '\u4e2d', '\u200ba\u200b', '...'])(
    'a reason with one visible character (%j) is valid',
    (reason) => {
      expect(
        read(`# tripcurve: ignore T2 reason="${reason}" until=2027-01-31`).problem,
      ).toBeUndefined();
    },
  );

  it('a reason of 200 characters is valid and 201 is not (characters, not UTF-16 units)', () => {
    expect(
      read(`# tripcurve: ignore T2 reason="${'x'.repeat(MAX_REASON_CHARS)}" until=2027-01-31`)
        .problem,
    ).toBeUndefined();
    expect(
      read(`# tripcurve: ignore T2 reason="${'x'.repeat(MAX_REASON_CHARS + 1)}" until=2027-01-31`)
        .problem,
    ).toBe('long-reason');
    // 200 astral characters are 400 UTF-16 units and still 200 characters
    expect(
      read(`# tripcurve: ignore T2 reason="${'\u{1f600}'.repeat(200)}" until=2027-01-31`).problem,
    ).toBeUndefined();
  });

  it('never throws on hostile text, and stays fast on a very long one', () => {
    for (const text of [
      `# tripcurve: ignore T2 reason="${'\\'.repeat(5000)}`,
      `# tripcurve: ignore ${'T'.repeat(100_000)}`,
      `# tripcurve: ignore T2 reason="${'a'.repeat(1_000_000)}" until=2027-01-31`,
      '# tripcurve: ignore T2 reason="\u0000\ud800" until=2027-01-31',
    ]) {
      expect(() => read(text)).not.toThrow();
    }
  });

  it('every problem has a fixed wording, none contains input text', () => {
    for (const [code, words] of Object.entries(WAIVER_PROBLEMS)) {
      expect(typeof words, code).toBe('string');
      expect(words, code).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('a waive: entry of tripcurve.yaml', () => {
  it('reads rule, workload, reason and date', () => {
    const w = readWaiver(entry(VALID_ENTRY));
    expect(w.problem).toBeUndefined();
    expect(w.ruleText).toBe('T2');
    expect(txt(w.target?.name as never)).toBe('api');
    expect(txt(w.reason)).toBe('drains in sidecar');
    expect(w.untilText).toBe('2027-01-31');
  });

  it('reads an optional namespace and a kind from the fixed list', () => {
    const w = readWaiver(entry({ ...VALID_ENTRY, namespace: 'shop', kind: 'StatefulSet' }));
    expect(w.problem).toBeUndefined();
    expect(txt(w.target?.namespace as never)).toBe('shop');
    expect(w.target?.kind).toBe('StatefulSet');
  });

  it.each(['\u200b', '\u0000', ' \u200b '])(
    'an entry with a reason of only invisible characters (%j) is invalid',
    (reason) => {
      expect(readWaiver(entry({ ...VALID_ENTRY, reason })).problem).toBe('empty-reason');
    },
  );

  const bad = (fields: Record<string, string | number | boolean | null | object>) =>
    readWaiver(entry(fields)).problem;

  it.each([
    ['no rule', { workload: 'api', reason: 'a', until: '2027-01-31' }, 'no-rule'],
    ['a rule that is a number', { ...VALID_ENTRY, rule: 2 }, 'unknown-rule'],
    ['a rule that is a list', { ...VALID_ENTRY, rule: { nested: true } }, 'unknown-rule'],
    ['an unknown rule', { ...VALID_ENTRY, rule: 'T5' }, 'unknown-rule'],
    ['no reason', { rule: 'T2', workload: 'api', until: '2027-01-31' }, 'no-reason'],
    ['a null reason', { ...VALID_ENTRY, reason: null }, 'no-reason'],
    ['an empty reason', { ...VALID_ENTRY, reason: '' }, 'empty-reason'],
    ['a reason that is a number', { ...VALID_ENTRY, reason: 5 }, 'bad-reason'],
    ['a reason over 200 characters', { ...VALID_ENTRY, reason: 'y'.repeat(201) }, 'long-reason'],
    ['no date', { rule: 'T2', workload: 'api', reason: 'a' }, 'no-date'],
    ['a date that is a number', { ...VALID_ENTRY, until: 20270131 }, 'bad-date'],
    ['a date that is not a date', { ...VALID_ENTRY, until: 'soon' }, 'bad-date'],
    ['a date that is not real', { ...VALID_ENTRY, until: '2027-13-01' }, 'bad-date'],
    ['no workload', { rule: 'T2', reason: 'a', until: '2027-01-31' }, 'no-workload'],
    ['a workload that is not text', { ...VALID_ENTRY, workload: 5 }, 'unknown-workload'],
    ['an empty workload name', { ...VALID_ENTRY, workload: '' }, 'unknown-workload'],
    ['a kind off the fixed list', { ...VALID_ENTRY, kind: 'Job' }, 'unknown-workload'],
    ['a field tripcurve does not read', { ...VALID_ENTRY, reasno: 'typo' }, 'unknown-field'],
    ['an entry with no fields', {}, 'not-an-entry'],
  ] as const)('%s is invalid', (_name, fields, problem) => {
    expect(bad(fields as never)).toBe(problem);
  });
});

describe('dates', () => {
  it.each([
    ['2027-01-31', true],
    ['2028-02-29', true],
    ['2027-02-29', false],
    ['1900-02-29', false],
    ['2000-02-29', true],
    ['2027-04-31', false],
    ['0000-01-01', false],
    ['9999-12-31', true],
    ['2027-00-10', false],
    ['2027-01-00', false],
    ['2027-1-1', false],
    ['27-01-01', false],
    [' 2027-01-01', false],
    ['2027-01-01 ', false],
    ['2027-01-01T00:00:00Z', false],
    ['', false],
  ])('%j is a date: %s', (text, ok) => {
    expect(isIsoDate(text)).toBe(ok);
  });
});
