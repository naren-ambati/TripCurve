// The structure reader for Terraform source (`*.tf`, bolt B5). It is an allow-list: it recognises
//     resource "<type>" "<name>" { ... }
// for four types, `name = <literal integer>` or `name = <type>.<name>.<attribute>` or a plain string for
// the eight attributes it reads, and comments. Everything else inside a block is only skipped, never
// interpreted. A block it cannot treat as exactly one instance with exactly the attributes it shows
// (count, for_each, a dynamic block, a lifecycle block that is not just create_before_destroy and
// prevent_destroy) has every value unresolved. A file the lexer cannot close, or whose top level is not
// a list of blocks, is unreadable and yields no resource at all: it is never partly read.
// The user's code is never run.

import {
  fileSource,
  type InputText,
  inputText,
  makeSourcedValue,
  makeUnresolved,
  type SourceRef,
  stdinSource,
} from '../../core/index.js';
import { evaluateIntegerExpression, expressionText } from './hcl-arith.js';
import {
  lexHcl,
  T_IDENT,
  T_NEWLINE,
  T_NUMBER,
  T_PUNCT,
  T_STRING,
  type TokenStream,
  type WaiverComment,
} from './hcl-lexer.js';
import {
  problemOf,
  TF_ATTRIBUTES,
  TF_INT_RANGES,
  TF_PROBLEMS,
  TF_REFERENCES,
  type TfAttr,
  type TfAttributeName,
  type TfResource,
  type TfType,
  tfTypeFromInput,
} from './model.js';

export type HclResult =
  | {
      readonly ok: true;
      readonly resources: readonly TfResource[];
      readonly waiverComments: readonly WaiverComment[];
    }
  | { readonly ok: false; readonly line: number };

export interface HclOrigin {
  /** Where lines are reported: a file, or a standard-input document. */
  readonly sourceAt: (line: number) => SourceRef;
  readonly scope: string;
  readonly dir: string;
}

export function fileOrigin(canonical: InputText, raw: string, dir: string): HclOrigin {
  return { sourceAt: (line) => fileSource(canonical, line), scope: raw, dir };
}

export function streamOrigin(document: number): HclOrigin {
  return { sourceAt: (line) => stdinSource(document, line), scope: `<stdin>#${document}`, dir: '' };
}

class Reader {
  constructor(
    private readonly text: string,
    private readonly t: TokenStream,
    private readonly origin: HclOrigin,
  ) {}

  /** The index of the matching `}` of each `{`, from one pass; -1 elsewhere. */
  private matches(): Int32Array {
    const { count, kind, start } = this.t;
    const match = new Int32Array(count).fill(-1);
    const open: number[] = [];
    for (let k = 0; k < count; k += 1) {
      if (kind[k] !== T_PUNCT) continue;
      const c = this.text.charCodeAt(start[k] as number);
      if (c === 123) open.push(k);
      else if (c === 125) {
        const o = open.pop();
        if (o !== undefined) match[o] = k;
      }
    }
    return match;
  }

  private punct(k: number, ch: string): boolean {
    return (
      k < this.t.count &&
      this.t.kind[k] === T_PUNCT &&
      this.text.charCodeAt(this.t.start[k] as number) === ch.charCodeAt(0)
    );
  }

  private tokText(k: number): string {
    return this.text.slice(this.t.start[k] as number, this.t.end[k] as number);
  }

  /** A label token: a bare identifier, or a quoted string with no escape or template in it. */
  private label(k: number): string | undefined {
    if (this.t.kind[k] === T_IDENT) return this.tokText(k);
    if (this.t.kind[k] !== T_STRING) return undefined;
    const raw = this.tokText(k).slice(1, -1);
    return /[\\$%]/.test(raw) ? undefined : raw;
  }

  read(): HclResult | { ok: false; line: number } {
    const { count, kind, line } = this.t;
    const match = this.matches();
    const resources: TfResource[] = [];
    let i = 0;
    const bad = (k: number) => ({
      ok: false as const,
      line: (line[Math.min(k, count - 1)] ?? 1) as number,
    });
    while (i < count) {
      if (kind[i] === T_NEWLINE) {
        i += 1;
        continue;
      }
      if (kind[i] !== T_IDENT) return bad(i);
      const keyword = this.tokText(i);
      let j = i + 1;
      const labels: number[] = [];
      while (j < count && (kind[j] === T_STRING || kind[j] === T_IDENT)) {
        labels.push(j);
        j += 1;
      }
      if (!this.punct(j, '{')) return bad(i);
      const close = match[j] as number;
      if (close < 0) return bad(i);
      if (keyword === 'resource') {
        if (labels.length !== 2) return bad(i);
        const type = this.label(labels[0] as number);
        const name = this.label(labels[1] as number);
        if (type === undefined || name === undefined) return bad(i);
        const known = tfTypeFromInput(type);
        if (known !== undefined) {
          const resource = this.resource(known, name, i, j, close, match);
          if (resource === undefined) return bad(j);
          resources.push(resource);
        }
      }
      i = close + 1;
    }
    return { ok: true, resources, waiverComments: [] };
  }

  /** The end (exclusive) of the expression that starts at `from`: a newline outside brackets, or the body's end. */
  private exprEnd(from: number, bodyClose: number): number {
    let depth = 0;
    let k = from;
    for (; k < bodyClose; k += 1) {
      if (this.t.kind[k] === T_NEWLINE && depth === 0) break;
      if (this.t.kind[k] === T_PUNCT) {
        const c = this.text.charCodeAt(this.t.start[k] as number);
        if (c === 40 || c === 91 || c === 123) depth += 1;
        else if (c === 41 || c === 93 || c === 125) depth -= 1;
      }
    }
    return k;
  }

  private lifecycleOk(open: number, close: number, _match: Int32Array): boolean {
    let k = open + 1;
    while (k < close) {
      if (this.t.kind[k] === T_NEWLINE) {
        k += 1;
        continue;
      }
      if (this.t.kind[k] !== T_IDENT || !this.punct(k + 1, '=')) return false;
      const name = this.tokText(k);
      const end = this.exprEnd(k + 2, close);
      const value =
        end - (k + 2) === 1 && this.t.kind[k + 2] === T_IDENT ? this.tokText(k + 2) : '';
      if (
        (name !== 'create_before_destroy' && name !== 'prevent_destroy') ||
        (value !== 'true' && value !== 'false')
      ) {
        return false;
      }
      k = end;
    }
    return true;
  }

  private resource(
    type: TfType,
    name: string,
    headerTok: number,
    open: number,
    close: number,
    match: Int32Array,
  ): TfResource | undefined {
    const read = TF_ATTRIBUTES[type];
    const seen = new Map<string, { at: number; from: number; to: number }[]>();
    let problem: string | undefined;
    let k = open + 1;
    while (k < close) {
      if (this.t.kind[k] === T_NEWLINE) {
        k += 1;
        continue;
      }
      if (this.t.kind[k] !== T_IDENT) return undefined;
      const key = this.tokText(k);
      if (this.punct(k + 1, '=')) {
        if (
          this.punct(k + 2, '=') &&
          (this.t.start[k + 2] as number) === (this.t.start[k + 1] as number) + 1
        ) {
          return undefined;
        }
        const end = this.exprEnd(k + 2, close);
        if (key === 'count' || key === 'for_each') problem ??= TF_PROBLEMS.countOrForEach;
        if (read.includes(key)) {
          const list = seen.get(key) ?? [];
          list.push({ at: k, from: k + 2, to: end });
          seen.set(key, list);
        }
        k = end;
        continue;
      }
      // a nested block: labels, then its braces
      let j = k + 1;
      while (j < close && (this.t.kind[j] === T_STRING || this.t.kind[j] === T_IDENT)) j += 1;
      if (!this.punct(j, '{')) return undefined;
      const inner = match[j] as number;
      if (inner < 0 || inner > close) return undefined;
      if (key === 'dynamic') problem ??= TF_PROBLEMS.dynamic;
      if (key === 'lifecycle' && !this.lifecycleOk(j, inner, match)) {
        problem ??= TF_PROBLEMS.lifecycle;
      }
      k = inner + 1;
    }
    const attrs: Partial<Record<TfAttributeName, TfAttr>> = {};
    for (const [key, list] of seen) {
      const first = list[0] as { at: number; from: number; to: number };
      const source = this.origin.sourceAt(this.t.line[first.at] as number);
      attrs[key as TfAttributeName] =
        list.length > 1
          ? { kind: 'unresolved', value: makeUnresolved(`${key} ${TF_PROBLEMS.duplicate}`), source }
          : this.value(key, first.from, first.to, source);
    }
    return {
      type,
      name: inputText(name),
      source: this.origin.sourceAt(this.t.line[headerTok] as number),
      endLine: this.t.line[close] as number,
      scope: this.origin.scope,
      dir: this.origin.dir,
      form: 'hcl',
      attrs,
      ...(problem === undefined ? {} : { problem: problemOf(problem) }),
    };
  }

  private value(key: string, from: number, to: number, source: SourceRef): TfAttr {
    const unresolved = (why: string): TfAttr => ({
      kind: 'unresolved',
      value: makeUnresolved(`${key} ${why}`),
      source,
    });
    const single = to - from === 1;
    const range = TF_INT_RANGES[key];
    if (range !== undefined) {
      let n: number;
      let expression: InputText | undefined;
      if (single && this.t.kind[from] === T_NUMBER) {
        const raw = this.tokText(from);
        if (!/^[0-9]{1,15}$/.test(raw)) return unresolved(TF_PROBLEMS.notInteger);
        n = Number(raw);
      } else {
        // `60 + (30 * 6)`: exact integer arithmetic on literals, or nothing (hcl-arith.ts)
        const computed = evaluateIntegerExpression(this.text, this.t, from, to);
        if (!computed.ok) return unresolved(TF_PROBLEMS.notInteger);
        n = computed.value;
        expression = inputText(expressionText(this.text, this.t, from, to));
      }
      if (n < range.min || n > range.max) {
        return unresolved(`is outside the documented range ${range.min} to ${range.max} s`);
      }
      return {
        kind: 'literal',
        value: makeSourcedValue({
          value: n,
          unit: 's',
          source,
          basis: 'declared',
          ...(expression === undefined ? {} : { expression }),
        }),
      };
    }
    const ref = TF_REFERENCES[key];
    if (ref !== undefined) {
      const ok =
        to - from === 5 &&
        this.t.kind[from] === T_IDENT &&
        this.punct(from + 1, '.') &&
        this.t.kind[from + 2] === T_IDENT &&
        this.punct(from + 3, '.') &&
        this.t.kind[from + 4] === T_IDENT;
      if (!ok) return unresolved(TF_PROBLEMS.notReference);
      if (this.tokText(from) !== ref.type || !ref.attributes.includes(this.tokText(from + 4))) {
        return unresolved(`${TF_PROBLEMS.notReference}: it does not name ${ref.type}`);
      }
      return { kind: 'reference', type: ref.type, name: inputText(this.tokText(from + 2)), source };
    }
    // a plain string (name, load_balancer_type)
    if (!single || this.t.kind[from] !== T_STRING) {
      return unresolved(TF_PROBLEMS.notString);
    }
    const raw = this.tokText(from).slice(1, -1);
    if (/[\\$%]/.test(raw)) return unresolved(TF_PROBLEMS.notString);
    return {
      kind: 'literal',
      value: makeSourcedValue({ value: inputText(raw), unit: 'none', source, basis: 'declared' }),
    };
  }
}

/** Reads one Terraform source text. Never throws for any text. */
export function readHcl(text: string, origin: HclOrigin): HclResult {
  try {
    const lexed = lexHcl(text);
    if (!lexed.ok) return { ok: false, line: lexed.line };
    const result = new Reader(text, lexed.tokens, origin).read();
    if (!result.ok) return result;
    return { ok: true, resources: result.resources, waiverComments: lexed.waiverComments };
  } catch {
    return { ok: false, line: 1 };
  }
}

/** The inline waiver comments of a Terraform source text (`# tripcurve: ...`, `// tripcurve: ...`), raw. */
export function hclWaiverComments(text: string): readonly WaiverComment[] {
  try {
    const lexed = lexHcl(text);
    return lexed.ok ? lexed.waiverComments : [];
  } catch {
    return [];
  }
}
