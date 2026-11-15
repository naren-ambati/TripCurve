// Exact integer arithmetic on literals in one Terraform attribute value (bolt B17). Terraform evaluates an
// expression such as `60 + (30 * 6)`; tripcurve reads exactly this much of that grammar and nothing more:
//   - decimal integer literals: `0`, or a digit 1 to 9 followed by digits (no leading zero, no sign, no point,
//     no exponent, no prefix, no suffix), at most 15 digits;
//   - the operators `+`, `-` and `*` (never `/` or `%`: Terraform division gives a number that is not a whole
//     number, and `%` is not needed), with HCL's precedence (`*` before `+` and `-`, left to right);
//   - parentheses.
// There is no unary sign (HCL's `-x` reads as a negation; a refusal is safer than a guess), no name, no function
// and no string. The tokens must sit on ONE line with only spaces or tabs between them: a line end or a comment
// inside (HCL allows both inside parentheses) is refused, because the lexer does not keep comments.
//
// The result is exact: every literal and every intermediate value stays inside the range a double holds exactly
// (at most 2^53 - 1 in absolute value), so HCL's own arithmetic, which is exact on such integers, gives the same
// number. A value past that is refused, not rounded. The expression is bounded: at most MAX_TOKENS tokens and
// MAX_DEPTH nested parentheses, checked before parsing, so the recursion below is as shallow as MAX_DEPTH and a
// hostile text costs work proportional to MAX_TOKENS.
// The caller turns a refusal into the attribute's "not a whole number written as a literal" reason.

import { T_NUMBER, T_PUNCT, type TokenStream } from './hcl-lexer.js';

export const ARITH_MAX_TOKENS = 64;
export const ARITH_MAX_DEPTH = 8;

const LITERAL = /^(?:0|[1-9][0-9]{0,14})$/;

export type ArithResult = { readonly ok: true; readonly value: number } | { readonly ok: false };

const REFUSED: ArithResult = { ok: false };

class Refuse extends Error {}

/** Evaluates the tokens `[from, to)` of `text` as an integer expression, or refuses. Never throws. */
export function evaluateIntegerExpression(
  text: string,
  t: TokenStream,
  from: number,
  to: number,
): ArithResult {
  const count = to - from;
  if (count < 1 || count > ARITH_MAX_TOKENS) return REFUSED;
  const items: string[] = [];
  for (let k = from; k < to; k += 1) {
    const kind = t.kind[k];
    const tok = text.slice(t.start[k] as number, t.end[k] as number);
    if (kind === T_NUMBER) {
      if (!LITERAL.test(tok)) return REFUSED;
    } else if (kind === T_PUNCT) {
      if (!'+-*()'.includes(tok) || tok.length !== 1) return REFUSED;
    } else return REFUSED;
    if (k > from) {
      // only spaces and tabs between two tokens: no comment, no line end
      const gap = text.slice(t.end[k - 1] as number, t.start[k] as number);
      // (a line end is a token of its own, or sits in a comment or in this gap, so one line follows from this)
      if (!/^[ \t]*$/.test(gap)) return REFUSED;
    }
    items.push(tok);
  }

  let at = 0;
  const peek = (): string | undefined => items[at];
  const exact = (n: number): number => {
    // Number.isSafeInteger is true exactly up to 2^53 - 1 in absolute value: the largest range a double holds exactly
    if (!Number.isSafeInteger(n)) throw new Refuse();
    return n;
  };
  const factor = (depth: number): number => {
    const tok = items[at];
    at += 1;
    if (tok === undefined) throw new Refuse();
    if (tok === '(') {
      if (depth >= ARITH_MAX_DEPTH) throw new Refuse();
      const inner = sum(depth + 1);
      if (items[at] !== ')') throw new Refuse();
      at += 1;
      return inner;
    }
    if (LITERAL.test(tok)) return exact(Number(tok));
    throw new Refuse();
  };
  const product = (depth: number): number => {
    let value = factor(depth);
    while (peek() === '*') {
      at += 1;
      value = exact(value * factor(depth));
    }
    return value;
  };
  const sum = (depth: number): number => {
    let value = product(depth);
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') return value;
      at += 1;
      const right = product(depth);
      value = exact(op === '+' ? value + right : value - right);
    }
  };
  try {
    const value = sum(0);
    if (at !== items.length) return REFUSED;
    return { ok: true, value };
  } catch {
    return REFUSED;
  }
}

/** The text of the tokens `[from, to)` as written, for the expression a value was computed from. */
export function expressionText(text: string, t: TokenStream, from: number, to: number): string {
  return text.slice(t.start[from] as number, t.end[to - 1] as number);
}
