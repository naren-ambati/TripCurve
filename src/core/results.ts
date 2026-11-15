// The eight result kinds. The words are exactly as printed.
// The set is closed: a value that is not one of these is not a result kind.

export const RESULT_KINDS = [
  'PASS',
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
  'N/A',
  'WAIVED',
] as const;

export type ResultKind = (typeof RESULT_KINDS)[number];

/** Kinds a rule may produce directly. WAIVED is made only by `waiveFinding`. */
export type RuleResultKind = Exclude<ResultKind, 'WAIVED'>;

/** Kinds a waiver may wrap: every kind except PASS, N/A and WAIVED itself. */
export const WAIVABLE_KINDS = [
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
] as const;

export type WaivableKind = (typeof WAIVABLE_KINDS)[number];

export function isResultKind(value: unknown): value is ResultKind {
  return typeof value === 'string' && (RESULT_KINDS as readonly string[]).includes(value);
}

export function isWaivableKind(value: unknown): value is WaivableKind {
  return typeof value === 'string' && (WAIVABLE_KINDS as readonly string[]).includes(value);
}

export const RULE_IDS = ['T1', 'T2', 'T3', 'T4'] as const;
export type RuleId = (typeof RULE_IDS)[number];

export function isRuleId(value: unknown): value is RuleId {
  return typeof value === 'string' && (RULE_IDS as readonly string[]).includes(value);
}
