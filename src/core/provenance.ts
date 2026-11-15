// Sources, bases and sourced values. A value cannot exist
// without a source and a basis; an unresolved value is represented as
// unresolved with its reason, never as a number.
//
// Decision: a value read straight from a file or from standard input has
// basis `declared` (the file declares it) and confidence `read`; a value from
// a tripcurve.yaml declaration has basis `declared` and confidence `declared`.
// The contract has no separate basis word for "read from a file", so the
// source type is what tells the two apart.

import { type InputText, isInputText } from './safe-text.js';

export type SourceRef =
  | { readonly type: 'file'; readonly file: InputText; readonly line: number }
  | { readonly type: 'stdin'; readonly document: number; readonly line: number }
  | {
      readonly type: 'default';
      /** The source name, for example "Node keepAliveTimeout 5 s + buffer 1 s". tripcurve text. */
      readonly citation: string;
      /** The range label, for example "Node 22.x from 22.19" or "AWS docs, ALB". tripcurve text. */
      readonly range?: string;
      /** The basis words as printed, for example "measured on 22.23.2". tripcurve text. */
      readonly basisText: string;
      readonly entryId?: string;
      /** Printed without the `default: ` prefix: the value is not a default (an explicit setting's measured rule). */
      readonly bare?: boolean;
    }
  | { readonly type: 'declared'; readonly file: InputText; readonly line: number };

export const BASES = [
  'measured-on',
  'documented',
  'from-source-not-measured',
  'from-changelogs-not-measured',
  'to-be-measured',
  'declared',
  'assumed',
] as const;
export type Basis = (typeof BASES)[number];

export const CONFIDENCES = ['read', 'declared', 'cited', 'assumed'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type Unit = 's' | 'ms' | 'none';

export type SourcedScalar = number | string | InputText;

export interface SourcedValue {
  readonly value: SourcedScalar;
  readonly unit: Unit;
  readonly source: SourceRef;
  readonly basis: Basis;
  readonly confidence: Confidence;
  /**
   * For a number computed from literals written in a file (Terraform `60 + (30 * 6)`, bolt B17): the expression
   * as written, input text. The report quotes it beside the number, so the computation is shown, never hidden.
   */
  readonly expression?: InputText;
}

/** A value that could not be established. `reason` and `declareHint` are tripcurve text. */
export interface UnresolvedValue {
  readonly unresolved: true;
  readonly reason: string;
  readonly declareHint?: string;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
}

function fail(what: string): never {
  throw new TypeError(`cannot build a value: ${what}`);
}

export function fileSource(file: InputText, line: number): SourceRef {
  if (!isInputText(file)) fail('a file source needs an InputText path');
  if (!isPositiveInt(line)) fail('a file source needs a line of 1 or more');
  return Object.freeze({ type: 'file', file, line });
}

export function declaredSource(file: InputText, line: number): SourceRef {
  if (!isInputText(file)) fail('a declaration source needs an InputText path');
  if (!isPositiveInt(line)) fail('a declaration source needs a line of 1 or more');
  return Object.freeze({ type: 'declared', file, line });
}

export function stdinSource(document: number, line: number): SourceRef {
  if (!isPositiveInt(document)) fail('a stdin source needs a document number of 1 or more');
  if (!isPositiveInt(line)) fail('a stdin source needs a line of 1 or more');
  return Object.freeze({ type: 'stdin', document, line });
}

export function defaultSource(args: {
  citation: string;
  basisText: string;
  range?: string;
  entryId?: string;
  bare?: boolean;
}): SourceRef {
  if (args.citation.trim() === '') fail('a default source needs a citation');
  if (args.basisText.trim() === '') fail('a default source needs its basis words');
  return Object.freeze({
    type: 'default',
    citation: args.citation,
    basisText: args.basisText,
    ...(args.range === undefined ? {} : { range: args.range }),
    ...(args.entryId === undefined ? {} : { entryId: args.entryId }),
    ...(args.bare === true ? { bare: true } : {}),
  });
}

function isSourceRef(source: unknown): source is SourceRef {
  if (typeof source !== 'object' || source === null) return false;
  const s = source as { type?: unknown };
  return s.type === 'file' || s.type === 'stdin' || s.type === 'default' || s.type === 'declared';
}

function confidenceFor(source: SourceRef, basis: Basis): Confidence {
  switch (source.type) {
    case 'file':
    case 'stdin':
      return 'read';
    case 'declared':
      return 'declared';
    case 'default':
      return basis === 'assumed' ? 'assumed' : 'cited';
  }
}

/**
 * Builds a sourced value. A value with no source, or a source and basis that
 * do not go together, cannot be built. The confidence follows from
 * the source and basis, so the two cannot disagree.
 */
export function makeSourcedValue(args: {
  value: SourcedScalar;
  unit: Unit;
  source: SourceRef;
  basis: Basis;
  expression?: InputText;
}): SourcedValue {
  const { value, unit, source, basis, expression } = args;
  if (!isSourceRef(source)) fail('a value needs a source');
  if (!(BASES as readonly string[]).includes(basis)) fail('a value needs a known basis');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('a number must be finite');
  if (typeof value !== 'number' && typeof value !== 'string' && !isInputText(value)) {
    fail('a value is a number, a fixed word or an InputText');
  }
  if (source.type === 'default') {
    if (basis === 'declared') fail('a cited default cannot have basis declared');
  } else if (basis !== 'declared') {
    fail('a value from a file or a declaration has basis declared');
  }
  if (expression !== undefined && (!isInputText(expression) || typeof value !== 'number')) {
    fail('an expression is input text, and only a number is computed from one');
  }
  return Object.freeze({
    value,
    unit,
    source,
    basis,
    confidence: confidenceFor(source, basis),
    ...(expression === undefined ? {} : { expression }),
  });
}

export function makeUnresolved(reason: string, declareHint?: string): UnresolvedValue {
  if (reason.trim() === '') fail('an unresolved value needs its reason');
  return Object.freeze({
    unresolved: true as const,
    reason,
    ...(declareHint === undefined ? {} : { declareHint }),
  });
}

export function isUnresolved(value: unknown): value is UnresolvedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { unresolved?: unknown }).unresolved === true
  );
}

export function isSourcedValue(value: unknown): value is SourcedValue {
  if (typeof value !== 'object' || value === null || isInputText(value) || isUnresolved(value)) {
    return false;
  }
  const v = value as Partial<SourcedValue>;
  return isSourceRef(v.source) && typeof v.basis === 'string';
}

/** The printed form of a default source: `default: <source> (<range>; <basis>)`. */
export function formatDefaultSource(source: Extract<SourceRef, { type: 'default' }>): string {
  const inner =
    source.range === undefined ? source.basisText : `${source.range}; ${source.basisText}`;
  return `${source.bare === true ? '' : 'default: '}${source.citation} (${inner})`;
}
