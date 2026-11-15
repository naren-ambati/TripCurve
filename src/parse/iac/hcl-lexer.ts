// A bounded lexer for the HCL subset tripcurve reads. It never recurses: nesting lives in a
// byte stack the size of the text, and tokens live in typed arrays, so a hostile file can make work
// proportional to its length and nothing more (no stack overflow, no quadratic scan).
//
// It tells code from text exactly as HCL does, because that is what decides where a block ends:
//   - `#`, `//` line comments and `/* */` block comments;
//   - quoted strings, which may not contain a newline, with `${ ... }` and `%{ ... }` sequences that
//     nest code (and strings) inside them, and `$${` / `%%{` as escapes;
//   - heredocs (`<<ID`, `<<-ID`) whose closing line is the delimiter alone; a heredoc may hold `${ }`.
// A construct it cannot close (an unterminated string, heredoc, comment or bracket, a mismatched
// bracket, a character HCL does not allow, a carriage return that is not part of a line end) makes the
// whole file unreadable: it reports a line and a fixed reason and no tokens.
//
// A heredoc closes exactly as hclsyntax's scanner closes it (scan_tokens.rl, `heredocLiteralEOL`): at the
// start of a line, when the whole line trimmed of Go's white space (`bytes.TrimSpace`) equals the marker,
// for `<<ID` and `<<-ID` alike, and never after a `${ }` or `%{ }` on the same line. A heredoc that the
// text never closes that way ends unterminated, so the file is unreadable. A closing line HCL would take
// but this lexer did not would swallow the attributes after it, so this rule must stay identical.

export const T_IDENT = 1;
export const T_NUMBER = 2;
export const T_STRING = 3;
export const T_HEREDOC = 4;
export const T_NEWLINE = 5;
export const T_PUNCT = 6;

export interface TokenStream {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly line: Int32Array;
}

export interface WaiverComment {
  readonly line: number;
  readonly text: string;
}

export type LexResult =
  | {
      readonly ok: true;
      readonly tokens: TokenStream;
      readonly waiverComments: readonly WaiverComment[];
    }
  | { readonly ok: false; readonly line: number; readonly reason: string };

const F_BRACE = 1;
const F_BRACKET = 2;
const F_PAREN = 3;
const F_QUOTE = 4;
const F_HEREDOC = 5;
const F_INTERP = 6;

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isIdentStart = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentPart = (c: number): boolean => isIdentStart(c) || isDigit(c) || c === 45;
const PUNCT = new Set([61, 44, 46, 58, 63, 43, 45, 42, 37, 33, 60, 62, 38, 124, 47]);

function fail(line: number, reason: string): LexResult {
  return { ok: false, line, reason };
}

/** Go's `unicode.IsSpace` (what `bytes.TrimSpace` trims): not U+FEFF, which JavaScript's trim() also removes. */
function isGoSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** True when `text[from, to)` with Go white space trimmed from both ends is exactly `marker`. */
function trimmedEquals(text: string, from: number, to: number, marker: string): boolean {
  let a = from;
  let b = to;
  while (a < b && isGoSpace(text.charCodeAt(a))) a += 1;
  while (b > a && isGoSpace(text.charCodeAt(b - 1))) b -= 1;
  return b - a === marker.length && text.startsWith(marker, a);
}

function isWaiver(text: string, from: number): boolean {
  let i = from;
  while (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9) i += 1;
  return text.startsWith('tripcurve:', i);
}

export function lexHcl(text: string): LexResult {
  const n = text.length;
  const kind = new Uint8Array(n + 1);
  const start = new Int32Array(n + 1);
  const end = new Int32Array(n + 1);
  const lines = new Int32Array(n + 1);
  const stack = new Uint8Array(n + 2);
  const delims: string[] = [];
  const waivers: WaiverComment[] = [];
  let count = 0;
  let sp = 0;
  let tdepth = 0;
  let tokStart = 0;
  let tokLine = 1;
  let line = 1;
  let lineStart = false;
  let i = 0;

  const emit = (k: number, s: number, e: number, l: number): void => {
    kind[count] = k;
    start[count] = s;
    end[count] = e;
    lines[count] = l;
    count += 1;
  };
  const beginTemplate = (): void => {
    if (tdepth === 0) {
      tokStart = i;
      tokLine = line;
    }
    tdepth += 1;
  };

  while (i < n) {
    const top = sp > 0 ? (stack[sp - 1] as number) : 0;
    const c = text.charCodeAt(i);

    if (top === F_QUOTE) {
      if (c === 34) {
        sp -= 1;
        tdepth -= 1;
        i += 1;
        if (tdepth === 0) emit(T_STRING, tokStart, i, tokLine);
      } else if (c === 10 || c === 13) {
        return fail(line, 'a string is not closed on its line');
      } else if (c === 92) {
        const next = text.charCodeAt(i + 1);
        if (next === 10 || next === 13) return fail(line, 'a string is not closed on its line');
        i += 2;
      } else if (c === 36 || c === 37) {
        const c1 = text.charCodeAt(i + 1);
        if (c1 === c && text.charCodeAt(i + 2) === 123) i += 3;
        else if (c1 === 123) {
          stack[sp++] = F_INTERP;
          tdepth += 1;
          i += 2;
        } else i += 1;
      } else i += 1;
      continue;
    }

    if (top === F_HEREDOC) {
      if (lineStart) {
        const delim = delims[delims.length - 1] as string;
        let e = text.indexOf('\n', i);
        if (e === -1) e = n;
        if (trimmedEquals(text, i, e, delim)) {
          sp -= 1;
          tdepth -= 1;
          delims.pop();
          // stop before the line end (and before a carriage return that belongs to it)
          i = e > i && text.charCodeAt(e - 1) === 13 ? e - 1 : e;
          lineStart = false;
          if (tdepth === 0) emit(T_HEREDOC, tokStart, i, tokLine);
          continue;
        }
        lineStart = false;
      }
      if (c === 10) {
        line += 1;
        i += 1;
        lineStart = true;
      } else if (c === 36 || c === 37) {
        const c1 = text.charCodeAt(i + 1);
        if (c1 === c && text.charCodeAt(i + 2) === 123) i += 3;
        else if (c1 === 123) {
          stack[sp++] = F_INTERP;
          tdepth += 1;
          i += 2;
        } else i += 1;
      } else i += 1;
      continue;
    }

    // code: the top level, a bracket, or the inside of a `${ }`
    if (c === 32 || c === 9) {
      i += 1;
    } else if (c === 13) {
      // only as part of a line end: HCL's scanner takes a lone carriage return as an invalid character
      if (text.charCodeAt(i + 1) !== 10)
        return fail(line, 'a carriage return is not part of a line end');
      i += 1;
    } else if (c === 10) {
      if (tdepth === 0) emit(T_NEWLINE, i, i + 1, line);
      line += 1;
      i += 1;
    } else if (c === 35 || (c === 47 && text.charCodeAt(i + 1) === 47)) {
      let e = text.indexOf('\n', i);
      if (e === -1) e = n;
      if (tdepth === 0 && isWaiver(text, i + (c === 35 ? 1 : 2))) {
        const stop = e > i && text.charCodeAt(e - 1) === 13 ? e - 1 : e;
        waivers.push({ line, text: text.slice(i, stop) });
      }
      i = e;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const e = text.indexOf('*/', i + 2);
      if (e === -1) return fail(line, 'a comment is not closed');
      for (let k = text.indexOf('\n', i); k !== -1 && k < e; k = text.indexOf('\n', k + 1)) {
        line += 1;
      }
      i = e + 2;
    } else if (c === 34) {
      stack[sp++] = F_QUOTE;
      beginTemplate();
      i += 1;
    } else if (c === 60 && text.charCodeAt(i + 1) === 60) {
      let j = i + 2;
      if (text.charCodeAt(j) === 45) j += 1;
      if (!isIdentStart(text.charCodeAt(j))) return fail(line, 'a heredoc marker is not valid');
      const from = j;
      while (isIdentPart(text.charCodeAt(j))) j += 1;
      const delim = text.slice(from, j);
      if (text.charCodeAt(j) === 13) j += 1;
      if (j >= n || text.charCodeAt(j) !== 10) return fail(line, 'a heredoc marker is not valid');
      stack[sp++] = F_HEREDOC;
      delims.push(delim);
      beginTemplate();
      i = j + 1;
      line += 1;
      lineStart = true;
    } else if (c === 123 || c === 91 || c === 40) {
      stack[sp++] = c === 123 ? F_BRACE : c === 91 ? F_BRACKET : F_PAREN;
      if (tdepth === 0) emit(T_PUNCT, i, i + 1, line);
      i += 1;
    } else if (c === 125 || c === 93 || c === 41) {
      const want = c === 125 ? F_BRACE : c === 93 ? F_BRACKET : F_PAREN;
      if (c === 125 && top === F_INTERP) {
        sp -= 1;
        tdepth -= 1;
        i += 1;
        lineStart = false;
      } else if (top === want) {
        sp -= 1;
        if (tdepth === 0) emit(T_PUNCT, i, i + 1, line);
        i += 1;
      } else {
        return fail(line, 'a bracket does not match');
      }
    } else if (isDigit(c)) {
      const s = i;
      i += 1;
      for (;;) {
        const d = text.charCodeAt(i);
        if (isDigit(d) || isIdentStart(d) || d === 46) i += 1;
        else break;
      }
      if (tdepth === 0) emit(T_NUMBER, s, i, line);
    } else if (isIdentStart(c)) {
      const s = i;
      i += 1;
      while (isIdentPart(text.charCodeAt(i))) i += 1;
      if (tdepth === 0) emit(T_IDENT, s, i, line);
    } else if (PUNCT.has(c)) {
      if (tdepth === 0) emit(T_PUNCT, i, i + 1, line);
      i += 1;
    } else {
      return fail(line, 'a character HCL does not allow here');
    }
  }
  if (sp !== 0) {
    const top = stack[sp - 1];
    return fail(
      line,
      top === F_QUOTE
        ? 'a string is not closed'
        : top === F_HEREDOC
          ? 'a heredoc is not closed'
          : 'a bracket is not closed',
    );
  }
  return {
    ok: true,
    tokens: { count, kind, start, end, line: lines },
    waiverComments: waivers,
  };
}
