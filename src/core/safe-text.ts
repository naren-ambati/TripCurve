// SafeText: the one place where text that came from the files under check
// (names, paths, annotation values, image tags) is turned into printable text.
//
// Design:
// - `InputText` is an opaque branded type. The raw string lives in a
//   module-private WeakMap, so an InputText has no string value to leak: it
//   has no readable property, and string conversion, JSON and util.inspect all
//   give a fixed placeholder, never the raw text.
// - The only function that returns the raw string is `unwrapForIo`. It exists
//   because intake has to open a file by its path. A source-scan test
//   (test/core/input-text-scan.test.ts) fails when any module outside this
//   file, and outside that test's named allowlist, mentions it.
// - Printing goes through `SafeText.render` and `SafeText.labelled` only.
//   Terminal output is plain ASCII: a quote or backslash is escaped, a control
//   character is written as \xNN, any other character outside ASCII as \uXXXX
//   (UTF-16 code units, so an astral character is two escapes), over-long
//   text is cut with `...`.

declare const inputTextBrand: unique symbol;

/** Text that came from an input file. Opaque; printable only through SafeText. */
export interface InputText {
  readonly [inputTextBrand]: true;
}

const raws = new WeakMap<object, string>();

const PLACEHOLDER = '[InputText]';

class InputTextImpl {
  toString(): string {
    return PLACEHOLDER;
  }
  valueOf(): string {
    return PLACEHOLDER;
  }
  toJSON(): string {
    return PLACEHOLDER;
  }
  [Symbol.toPrimitive](): string {
    return PLACEHOLDER;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return PLACEHOLDER;
  }
}

/**
 * Wraps text from an input file. This is the only constructor; readers reach
 * it through the provenance helpers in `provenance.ts`.
 */
export function inputText(raw: string): InputText {
  if (typeof raw !== 'string') {
    throw new TypeError('inputText needs a string');
  }
  const wrapped = Object.freeze(new InputTextImpl());
  raws.set(wrapped, raw);
  return wrapped as unknown as InputText;
}

export function isInputText(value: unknown): value is InputText {
  return typeof value === 'object' && value !== null && raws.has(value);
}

function rawOf(text: InputText): string {
  const raw = raws.get(text as unknown as object);
  if (raw === undefined) {
    throw new TypeError('not an InputText');
  }
  return raw;
}

/**
 * The raw string, for file-system access only (intake opening a path).
 * Never print the result. The scan test limits who may mention this name.
 */
export function unwrapForIo(text: InputText): string {
  return rawOf(text);
}

/** Exact comparison; names compare by exact string, no normalisation. */
export function inputTextEquals(a: InputText, b: InputText): boolean {
  return rawOf(a) === rawOf(b);
}

/**
 * Byte order of the UTF-8 encoding, which is code point order (interaction
 * spec rule 3). A lone surrogate compares as its own value.
 */
export function compareInputText(a: InputText, b: InputText): number {
  const x = rawOf(a);
  const y = rawOf(b);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const cx = x.codePointAt(i) ?? 0;
    const cy = y.codePointAt(j) ?? 0;
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
    i += cx > 0xffff ? 2 : 1;
    j += cy > 0xffff ? 2 : 1;
  }
  if (i < x.length) return 1;
  if (j < y.length) return -1;
  return 0;
}

export type Destination = 'terminal' | 'json' | 'sarif';

/**
 * One output line is at most 80 columns (interaction spec rule 5). A quoted
 * text can never be wider than a line, so this is the default cut for the
 * terminal; callers pass the room they really have.
 */
export const TERMINAL_WIDTH = 80;

const CUT_MARKER = '...';

export interface RenderOptions {
  /** Most characters the result may take, quotes and cut marker included. */
  readonly maxLength?: number;
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

// One escaped token per UTF-16 code unit, so a cut never splits an escape.
function escapeUnit(unit: number): string {
  if (unit === 0x22) return '\\"';
  if (unit === 0x5c) return '\\\\';
  if (unit < 0x20 || unit === 0x7f) return `\\x${hex(unit, 2)}`;
  if (unit < 0x7f) return String.fromCharCode(unit);
  return `\\u${hex(unit, 4)}`;
}

function quoteForTerminal(raw: string, maxLength: number): string {
  const room = maxLength - 2; // the two quotes
  const tokens: string[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const token = escapeUnit(raw.charCodeAt(i));
    tokens.push(token);
    total += token.length;
    // Stop early on hostile, very long text; the cut below needs only `room`.
    if (total > room + 8) break;
  }
  if (tokens.length === raw.length && total <= room) {
    return `"${tokens.join('')}"`;
  }
  let out = '';
  const keep = room - CUT_MARKER.length;
  for (const token of tokens) {
    if (out.length + token.length > keep) break;
    out += token;
  }
  return `"${out}${CUT_MARKER}"`;
}

// JSON and SARIF strings are serialised by JSON.stringify, which escapes
// controls and quotes. The only repair needed is a lone surrogate, which would
// make an invalid JSON text.
function forData(raw: string, maxLength: number | undefined): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const unit = raw.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += raw.slice(i, i + 2);
        i += 1;
      } else {
        out += '�';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '�';
    } else {
      out += raw[i];
    }
  }
  if (maxLength !== undefined && out.length > maxLength) {
    const keep = Math.max(0, maxLength - CUT_MARKER.length);
    let cut = out.slice(0, keep);
    // Do not leave half of a surrogate pair at the cut.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return `${cut}${CUT_MARKER}`;
  }
  return out;
}

export const SafeText = {
  /**
   * Terminal: the text in double quotes, plain ASCII. JSON and SARIF: the
   * text itself, valid for JSON, for the serialiser to escape.
   */
  render(text: InputText, destination: Destination, options: RenderOptions = {}): string {
    const raw = rawOf(text);
    if (destination === 'terminal') {
      return quoteForTerminal(raw, options.maxLength ?? TERMINAL_WIDTH);
    }
    return forData(raw, options.maxLength);
  },

  /**
   * A fixed label of tripcurve's own, then the quoted text. Input text never
   * starts a line because it never comes without a label.
   * `label` must be tripcurve's own constant: it is not input, not escaped.
   */
  labelled(label: string, text: InputText, options: RenderOptions = {}): string {
    if (label.trim().length === 0) {
      throw new TypeError('labelled needs a non-empty fixed label');
    }
    const room = (options.maxLength ?? TERMINAL_WIDTH) - label.length - 1;
    return `${label} ${quoteForTerminal(rawOf(text), Math.max(room, 5))}`;
  },
};
