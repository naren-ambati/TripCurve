import { describe, expect, it } from 'vitest';
import {
  compareInputText,
  inputText,
  inputTextEquals,
  isInputText,
  SafeText,
  TERMINAL_WIDTH,
} from '../../src/core/index.js';
import { unwrapForIo } from '../../src/core/safe-text.js';
import { makeRng, randomHostileString } from '../support/prng.js';
import { LINEAR_RATIO_LIMIT, scalingRatio } from '../support/scaling.js';

const q = (s: string, max?: number) =>
  SafeText.render(inputText(s), 'terminal', max === undefined ? {} : { maxLength: max });

describe('SafeText terminal quoting', () => {
  it('wraps plain text in double quotes', () => {
    expect(q('web')).toBe('"web"');
    expect(q('')).toBe('""');
  });

  it('escapes a quote as \\" and a backslash as two backslashes', () => {
    expect(q('a"b')).toBe('"a\\"b"');
    expect(q('a\\b')).toBe('"a\\\\b"');
    // A trailing backslash cannot swallow the closing quote.
    expect(q('end\\')).toBe('"end\\\\"');
  });

  it('shows control characters and terminal escapes as \\xNN', () => {
    expect(q('\x1b[31mred')).toBe('"\\x1b[31mred"');
    expect(q('a\nb')).toBe('"a\\x0ab"');
    expect(q('a\rb\tc')).toBe('"a\\x0db\\x09c"');
    expect(q('\x00')).toBe('"\\x00"');
    expect(q('\x7f')).toBe('"\\x7f"');
  });

  it('a newline that would start a line stays inside the quotes on one line', () => {
    const out = q('web\nPASS T1  all good');
    expect(out).toBe('"web\\x0aPASS T1  all good"');
    expect(out).not.toContain('\n');
  });

  it('shows every non-ASCII character as \\uXXXX, an astral one as two escapes', () => {
    expect(q('café')).toBe('"caf\\u00e9"');
    expect(q('‮')).toBe('"\\u202e"'); // right-to-left override
    expect(q('аpi')).toBe('"\\u0430pi"'); // Cyrillic a, a look-alike
    expect(q('\u{1F600}')).toBe('"\\ud83d\\ude00"');
    expect(q('\ud800')).toBe('"\\ud800"'); // a lone surrogate
    expect(q('\u0085')).toBe('"\\u0085"'); // C1 control
  });

  it('cuts over-long text with a ... marker inside the quotes, within the limit', () => {
    const out = q('x'.repeat(200), 20);
    expect(out).toBe(`"${'x'.repeat(15)}..."`);
    expect(out.length).toBe(20);
  });

  it('keeps text that fits exactly, and cuts text one over', () => {
    expect(q('x'.repeat(8), 10)).toBe(`"${'x'.repeat(8)}"`);
    expect(q('x'.repeat(9), 10).length).toBeLessThanOrEqual(10);
    expect(q('x'.repeat(9), 10).endsWith('..."')).toBe(true);
  });

  it('never splits an escape sequence at the cut', () => {
    const out = q('\x1b'.repeat(50), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toMatch(/^"(\\x1b)+\.\.\."$/);
  });

  it('defaults the cut to the terminal width', () => {
    expect(q('x'.repeat(1000)).length).toBeLessThanOrEqual(TERMINAL_WIDTH);
  });

  it('a hostile 5 MB string is cut to the limit, in linear time', () => {
    const out = q('\x1b'.repeat(5_000_000), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(scalingRatio((n) => q('\x1b'.repeat(n), 40), 1_000_000)).toBeLessThan(
      LINEAR_RATIO_LIMIT,
    );
  });

  it('property: output is plain printable ASCII, one line, within the limit, for any text', () => {
    const rng = makeRng(20261111);
    for (let i = 0; i < 500; i += 1) {
      const text = randomHostileString(rng, 120);
      const max = rng.int(5, 90);
      const out = q(text, max);
      expect(out, `case ${i}`).toMatch(/^"[\x20-\x7e]*"$/);
      expect(out.length, `case ${i}`).toBeLessThanOrEqual(max);
    }
  });

  it('property: below the limit the quoting is reversible (nothing is lost or invented)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 300; i += 1) {
      const text = randomHostileString(rng, 20);
      const out = q(text, 1000);
      const body = out.slice(1, -1);
      const back = body.replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|"|\\)/g, (_m, g: string) => {
        if (g === '"') return '"';
        if (g === '\\') return '\\';
        return String.fromCharCode(Number.parseInt(g.slice(1), 16));
      });
      expect(back, `case ${i}`).toBe(text);
    }
  });
});

describe('SafeText.labelled: input text never starts a line', () => {
  it('always puts a fixed label first', () => {
    const out = SafeText.labelled('Workload', inputText('PASS T1 ok'));
    expect(out).toBe('Workload "PASS T1 ok"');
    expect(out.startsWith('"')).toBe(false);
  });

  it('keeps the labelled result within the room', () => {
    const out = SafeText.labelled('Workload', inputText('x'.repeat(500)), { maxLength: 40 });
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith('Workload "')).toBe(true);
  });

  it('refuses an empty label (a bug in the caller, never input)', () => {
    expect(() => SafeText.labelled('  ', inputText('x'))).toThrow(TypeError);
  });
});

describe('SafeText data destinations (JSON and SARIF)', () => {
  it('returns the text itself, for the serialiser to escape', () => {
    expect(SafeText.render(inputText('a"b\n'), 'json')).toBe('a"b\n');
    expect(JSON.parse(JSON.stringify(SafeText.render(inputText('a"b\n'), 'sarif')))).toBe('a"b\n');
  });

  it('replaces a lone surrogate so the JSON text is valid', () => {
    const out = SafeText.render(inputText('a\ud800b'), 'json');
    expect(out).toBe('a�b');
    expect(JSON.stringify(out)).toBe('"a�b"');
  });

  it('keeps a valid surrogate pair and does not cut it in half', () => {
    expect(SafeText.render(inputText('\u{1F600}'), 'json')).toBe('\u{1F600}');
    const cut = SafeText.render(inputText(`${'x'.repeat(5)}\u{1F600}${'y'.repeat(20)}`), 'json', {
      maxLength: 9,
    });
    expect(cut).toBe('xxxxx...'); // the pair does not fit, so only the marker follows
    expect(cut).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe('InputText is opaque', () => {
  it('never reveals the raw text through string conversion, JSON or inspection', () => {
    const t = inputText('secret-name');
    expect(String(t)).not.toContain('secret-name');
    expect(`${t}`).not.toContain('secret-name');
    expect(JSON.stringify({ t })).not.toContain('secret-name');
    expect(JSON.stringify(t)).not.toContain('secret-name');
    expect(Object.keys(t)).toEqual([]);
    expect(Object.getOwnPropertyNames(t)).toEqual([]);
    expect(Object.values(t as unknown as object)).toEqual([]);
    expect(`${t}x`).not.toContain('secret-name');
  });

  it('is recognised only when made by inputText', () => {
    expect(isInputText(inputText('a'))).toBe(true);
    expect(isInputText('a')).toBe(false);
    expect(isInputText({})).toBe(false);
    expect(isInputText(null)).toBe(false);
    // A look-alike object cannot be printed.
    expect(() => SafeText.render({} as never, 'terminal')).toThrow(TypeError);
  });

  it('refuses a non-string at construction (a bug, not input)', () => {
    expect(() => inputText(5 as never)).toThrow(TypeError);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(inputText('a'))).toBe(true);
  });

  it('compares by exact string and by UTF-8 byte order', () => {
    expect(inputTextEquals(inputText('a'), inputText('a'))).toBe(true);
    expect(inputTextEquals(inputText('a'), inputText('A'))).toBe(false);
    // No Unicode normalisation: two spellings of e-acute are different names.
    expect(inputTextEquals(inputText('é'), inputText('é'))).toBe(false);
    expect(compareInputText(inputText('a'), inputText('b'))).toBe(-1);
    expect(compareInputText(inputText('b'), inputText('a'))).toBe(1);
    expect(compareInputText(inputText('a'), inputText('ab'))).toBe(-1);
    expect(compareInputText(inputText('ab'), inputText('ab'))).toBe(0);
    // Code point order equals UTF-8 byte order: U+FF5E sorts before U+1F600.
    expect(compareInputText(inputText('～'), inputText('\u{1F600}'))).toBe(-1);
  });

  it('gives the raw string back only through unwrapForIo', () => {
    expect(unwrapForIo(inputText('k8s/web.yaml'))).toBe('k8s/web.yaml');
  });
});
