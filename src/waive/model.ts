// The waiver model (`AppliedWaiver`). A waiver is judged by WaiverApplier and by
// nothing else: the readers hand over raw records and validate nothing.

import type { InputText, SourceRef, WorkloadName } from '../core/index.js';

export const WAIVER_STATES = ['applied', 'expired', 'unmatched', 'invalid'] as const;
export type WaiverState = (typeof WAIVER_STATES)[number];

/** The longest reason a waiver may give, in characters. */
export const MAX_REASON_CHARS = 200;

/**
 * Everything that can be wrong with a waiver, as tripcurve's own words. Fixed text: the
 * waiver's own text is shown quoted beside it, never inside it.
 */
export const WAIVER_PROBLEMS = {
  'not-in-form': 'is not in the form tripcurve: ignore <RULE> reason="<text>" until=<YYYY-MM-DD>',
  'not-an-entry': 'is not an entry with rule, workload, reason and until',
  'waive-not-a-list': 'waive must be a list of entries',
  'unknown-field': 'has a field tripcurve does not read',
  'no-rule': 'names no rule',
  'unknown-rule': 'names a rule that is not T1, T2, T3 or T4',
  'no-reason': 'has no reason',
  'empty-reason': 'has an empty reason',
  'bad-reason': 'has a reason that is not text',
  'long-reason': `has a reason longer than ${MAX_REASON_CHARS} characters`,
  'no-date': 'has no until date',
  'bad-date': 'has an until date that is not a real date in the form YYYY-MM-DD',
  'no-workload': 'names no workload',
  'unknown-workload': 'names a workload that was not read',
  'ambiguous-workload': 'names more than one workload; give its namespace or kind',
  'outside-block': 'is not inside the block of a workload or event source mapping that was checked',
  'between-blocks': 'sits between two documents (or items); put it inside the block it waives',
  'several-findings': 'matches more than one finding',
  'shared-finding': 'covers a finding that another waiver also covers',
  'no-date-known': 'cannot be judged because the date of the run is not known',
} as const;
export type WaiverProblemCode = keyof typeof WAIVER_PROBLEMS;

export interface AppliedWaiver {
  /** A rule id (tripcurve's word) when the waiver names one, else what it wrote, as input text. */
  readonly rule: string | InputText;
  /** The workload the waiver names or sits in; absent when it could not be established. */
  readonly workload?: WorkloadName;
  /** Where the waiver is written: the comment line, or the `waive:` entry in tripcurve.yaml. */
  readonly source: SourceRef;
  readonly mechanism: 'inline' | 'config';
  readonly state: WaiverState;
  /** The date as an ISO date when it is one, else what was written, as input text. */
  readonly until: string | InputText;
  readonly reason: InputText;
  /** The waiver as written (an inline comment without its comment mark), for the lines that quote it. */
  readonly text: InputText;
  /** tripcurve's words for what is wrong; set for an invalid waiver. */
  readonly problem?: string;
}
