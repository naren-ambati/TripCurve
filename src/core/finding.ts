// Findings, chains and assumptions. The kind of a finding
// is decided here and nowhere else: a PASS that rests on an unverified value
// is converted to UNRESOLVED instead of being refused with an exception, so no
// input can reach the internal-error path (exit 3) through this factory.

import {
  isSourcedValue,
  isUnresolved,
  type SourcedValue,
  type SourceRef,
  type UnresolvedValue,
} from './provenance.js';
import {
  isResultKind,
  isRuleId,
  isWaivableKind,
  type ResultKind,
  type RuleId,
  type RuleResultKind,
  type WaivableKind,
} from './results.js';
import { type InputText, isInputText } from './safe-text.js';
import type { WorkloadKind } from './vocab.js';

/** A workload as read from a file. A kind off the fixed list is InputText and prints quoted. */
export interface WorkloadRef {
  readonly kind: WorkloadKind | InputText;
  readonly namespace: InputText;
  readonly name: InputText;
}

/** An event source mapping, named after its resource. */
export interface QueueRef {
  readonly mapping: InputText;
}

/** A workload as named in a declaration or a waiver. */
export interface WorkloadName {
  readonly name: InputText;
  readonly namespace?: InputText;
}

/**
 * A fact stated in tripcurve's own words (a search that found nothing, a note on a step): fixed
 * text, never input text, and never a number a verdict could rest on. It is not a value that can be
 * unresolved, assumed or measured, so it never changes whether a PASS is allowed.
 */
export interface NoteValue {
  readonly note: string;
}

export function isNoteValue(value: unknown): value is NoteValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { note?: unknown }).note === 'string' &&
    !isInputText(value) &&
    !isUnresolved(value)
  );
}

export type ChainValue = SourcedValue | InputText | UnresolvedValue | NoteValue;

/** One value a rule used, in the order it used them. `label` is tripcurve text. */
export interface ChainStep {
  readonly label: string;
  readonly value: ChainValue;
  /**
   * tripcurve text the report prints between the label and the value, for
   * example `image` (Node 22.23 image "node:22.23" at ...) or `no setting found
   * in 2 files read` (the value is then the first file). Never input text.
   */
  readonly detail?: string;
  /** Further values printed after `value`, for a step that names several files. */
  readonly more?: readonly ChainValue[];
  /**
   * For a value computed from a setting in a file (an explicit `keepAliveTimeout` plus the measured
   * extra second): the source a PASS or N/A line cites as the deciding source, while
   * `value` keeps the rule it was computed by and its basis.
   */
  readonly decidedBy?: SourceRef;
  /**
   * For a step whose value is a file name: print `detail` and the quoted name with no parentheses
   * (`preStop none     in "k8s/api.yaml"`, the design mockup) instead of `detail ("name")`.
   */
  readonly plain?: boolean;
}

export const BRANCH_UNRESOLVED_TO_BE_MEASURED = 'unresolved: to be measured' as const;

/** One knowledge-base range of a VERSION-DEPENDENT result. */
export interface Branch {
  readonly range: string;
  readonly outcome: ResultKind | typeof BRANCH_UNRESOLVED_TO_BE_MEASURED;
  readonly chain: readonly ChainStep[];
}

export interface Assumption {
  readonly text: string;
  readonly reason: string;
}

export interface WaiverInfo {
  /** ISO date, YYYY-MM-DD. */
  readonly until: string;
  readonly reason: InputText;
  readonly source: SourceRef;
  readonly mechanism: 'inline' | 'config';
}

export type PassRefusalReason = 'unresolved-value' | 'assumed-value' | 'to-be-measured-default';

export interface Finding {
  readonly rule: RuleId;
  readonly subject: WorkloadRef | QueueRef;
  readonly kind: ResultKind;
  /** tripcurve text; never input text. */
  readonly headline: string;
  readonly chain: readonly ChainStep[];
  readonly branches?: readonly Branch[];
  /** What the branch ranges are ranges of (`Node`): the report says `every known Node range evaluated:`. */
  readonly rangeNoun?: string;
  /** Required when kind is WAIVED. */
  readonly originalKind?: WaivableKind;
  /** Required when kind is WAIVED. */
  readonly waiver?: WaiverInfo;
  /**
   * Set when a valid waiver for this finding has expired: the finding keeps its own
   * kind and the report says the waiver expired on its date. It never changes the kind.
   */
  readonly expiredWaiver?: WaiverInfo;
  /** Set when a PASS was converted to UNRESOLVED. */
  readonly demotedFrom?: 'PASS';
  readonly demotionReason?: PassRefusalReason;
  /** What to declare or change so the result can be established; tripcurve text, one line each. */
  readonly declare?: readonly string[];
  /**
   * tripcurve text printed after the deciding source of a PASS or N/A line, inside its
   * parentheses (the design mockup: `("k8s/admin.yaml":19, no -k given)`). Never input text.
   */
  readonly decidingNote?: string;
  /**
   * Assumptions this result actually used, for example the propagation allowance behind a
   * T2 verdict. The pipeline lists each once in the Assumptions block. tripcurve text.
   */
  readonly assumptions?: readonly Assumption[];
}

export interface FindingInput {
  readonly rule: RuleId;
  readonly subject: WorkloadRef | QueueRef;
  readonly kind: RuleResultKind;
  readonly headline: string;
  readonly chain: readonly ChainStep[];
  readonly branches?: readonly Branch[];
  readonly rangeNoun?: string;
  /** tripcurve text: what to declare so an UNRESOLVED result can be settled. */
  readonly declare?: readonly string[];
  /** tripcurve text after the deciding source of a PASS or N/A line. */
  readonly decidingNote?: string;
  /** Assumptions this result used. */
  readonly assumptions?: readonly Assumption[];
}

/** Fixed headlines of a converted PASS (tripcurve's own words). */
export const PASS_REFUSAL_HEADLINES: Readonly<Record<PassRefusalReason, string>> = {
  'unresolved-value': 'a value this check rests on could not be established',
  'assumed-value': 'a value this check rests on is assumed, not read from the files',
  'to-be-measured-default': 'a default this check rests on has not been measured yet',
};

function stepsOf(chain: readonly ChainStep[], branches?: readonly Branch[]): ChainValue[] {
  const values: ChainValue[] = [];
  for (const step of chain) values.push(step.value, ...(step.more ?? []));
  for (const branch of branches ?? []) {
    for (const step of branch.chain) values.push(step.value, ...(step.more ?? []));
  }
  return values;
}

/**
 * Why a PASS resting on this chain is not allowed, or undefined when it is.
 * Order when several apply: unresolved, then assumed, then to be measured.
 */
export function passBlocker(
  chain: readonly ChainStep[],
  branches?: readonly Branch[],
): PassRefusalReason | undefined {
  const values = stepsOf(chain, branches);
  if (values.some((v) => isUnresolved(v))) return 'unresolved-value';
  if (
    values.some((v) => isSourcedValue(v) && (v.basis === 'assumed' || v.confidence === 'assumed'))
  ) {
    return 'assumed-value';
  }
  if (
    (branches ?? []).some((b) => b.outcome === BRANCH_UNRESOLVED_TO_BE_MEASURED) ||
    values.some((v) => isSourcedValue(v) && v.basis === 'to-be-measured')
  ) {
    return 'to-be-measured-default';
  }
  return undefined;
}

/**
 * The one way to build a finding. Never throws on a refused PASS: it returns
 * UNRESOLVED with a fixed headline and `demotedFrom: 'PASS'`. It
 * throws only for a malformed call (a kind that is not one of the eight, or
 * WAIVED, which only `waiveFinding` makes), which no input text can cause.
 */
export function makeFinding(input: FindingInput): Finding {
  if (!isRuleId(input.rule)) throw new TypeError('unknown rule id');
  if (!isResultKind(input.kind)) throw new TypeError('unknown result kind');
  if ((input.kind as ResultKind) === 'WAIVED') {
    throw new TypeError('WAIVED is made only by waiveFinding');
  }
  if (typeof input.headline !== 'string') throw new TypeError('a headline is tripcurve text');
  const chain = Object.freeze([...input.chain]);
  const branches = input.branches === undefined ? undefined : Object.freeze([...input.branches]);
  const base = {
    rule: input.rule,
    subject: input.subject,
    chain,
    ...(branches ? { branches } : {}),
    ...(input.rangeNoun === undefined ? {} : { rangeNoun: input.rangeNoun }),
    ...(input.declare && input.declare.length > 0
      ? { declare: Object.freeze([...input.declare]) }
      : {}),
    ...(input.decidingNote === undefined ? {} : { decidingNote: input.decidingNote }),
    ...(input.assumptions && input.assumptions.length > 0
      ? { assumptions: Object.freeze([...input.assumptions]) }
      : {}),
  };
  if (input.kind === 'PASS') {
    const reason = passBlocker(chain, branches);
    if (reason !== undefined) {
      // The refused PASS used nothing: its assumptions are dropped with it.
      const { assumptions: _used, ...kept } = base;
      return Object.freeze({
        ...kept,
        kind: 'UNRESOLVED' as const,
        headline: PASS_REFUSAL_HEADLINES[reason],
        demotedFrom: 'PASS' as const,
        demotionReason: reason,
      });
    }
  }
  return Object.freeze({ ...base, kind: input.kind, headline: input.headline });
}

/**
 * Wraps a non-pass finding as WAIVED. The result keeps the original kind and
 * headline. A finding that cannot be waived (PASS, N/A, already
 * WAIVED) is returned unchanged: a waiver can never produce a PASS and never
 * hides a result that was not a problem. It never throws.
 */
export function waiveFinding(finding: Finding, waiver: WaiverInfo): Finding {
  if (!isWaivableKind(finding.kind)) return finding;
  return Object.freeze({
    ...finding,
    kind: 'WAIVED' as const,
    originalKind: finding.kind,
    waiver,
  });
}

/**
 * Records that a valid waiver for this finding has expired: the finding keeps its original
 * kind, so a run is as unclean as it was before the waiver existed. A finding that is not a problem
 * (PASS, N/A) or is already WAIVED is returned unchanged. It never throws.
 */
export function noteExpiredWaiver(finding: Finding, waiver: WaiverInfo): Finding {
  if (!isWaivableKind(finding.kind)) return finding;
  return Object.freeze({ ...finding, expiredWaiver: waiver });
}

/** Only PASS counts as passed; WAIVED never does. */
export function countsAsPassed(finding: Finding): boolean {
  return finding.kind === 'PASS';
}
