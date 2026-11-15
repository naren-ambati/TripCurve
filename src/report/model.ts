// The Report model. Every renderer prints this and nothing
// else; the summary is computed once by RunSummarizer and never recomputed.

import type {
  Assumption,
  Finding,
  InputText,
  QueueRef,
  SourceRef,
  WorkloadRef,
} from '../core/index.js';
import type { WorkloadKind } from '../core/vocab.js';
import type { NotCheckedItem } from '../link/index.js';
import type { ConfigError, StdinPath, UncheckedInput } from '../parse/index.js';
import type { AppliedWaiver } from '../waive/index.js';

export const OUTCOMES = [
  'NothingChecked',
  'Incomplete',
  'NotClean',
  'NoFailures',
  'NoChecksApply',
  'Clean',
  'ConfigError',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type ExitCode = 0 | 1 | 2;

/** Counts in the fixed order of the report summary. Unchecked files are inside `unresolved`. */
export interface Counts {
  readonly failed: number;
  readonly warning: number;
  readonly unresolved: number;
  readonly versionDependent: number;
  readonly notEvaluated: number;
  readonly waived: number;
  readonly notApplicable: number;
  readonly passed: number;
}

export interface RunSummary {
  readonly counts: Counts;
  readonly unresolvedDetail: { readonly files: number; readonly waivers: number };
  readonly outcome: Outcome;
  /** Derived from `outcome`: true exactly for Clean, NoFailures and NoChecksApply (exit 0). */
  readonly clean: boolean;
  /** ISO dates of the valid waivers, ascending, each once. */
  readonly waivedDates: readonly string[];
  readonly exitCode: ExitCode;
  /** tripcurve's own text, one logical line each; the renderer wraps them. */
  readonly closingLines: readonly string[];
}

export interface ReportHeader {
  readonly version: string;
  readonly checked: InputText | StdinPath;
  readonly filesRead: number;
  /** Set for standard input: the documents read from the stream. */
  readonly stream?: { readonly documents: number };
}

export interface ReportBlock {
  readonly workload: WorkloadRef | QueueRef;
  /** The kind as printed: a word of the fixed list, or input text (quoted). */
  readonly kindLabel: WorkloadKind | InputText;
  readonly file: SourceRef;
  /** Quoted after the fixed label `Helm source comment`, on the line under the block header. */
  readonly helmSource?: InputText;
  /** Non-pass kinds first (fixed order, then rule order), then PASS and N/A in rule order. */
  readonly findings: readonly Finding[];
}

export type { AppliedWaiver } from '../waive/index.js';

export interface Report {
  readonly header: ReportHeader;
  readonly blocks: readonly ReportBlock[];
  readonly unchecked: readonly UncheckedInput[];
  /** Every waiver in every state (applied, expired, unmatched, invalid), in the order the readers gave them. */
  readonly waivers: readonly AppliedWaiver[];
  /** The unmatched and invalid waivers: listed, and counted under unresolved. */
  readonly waiversNotApplied: readonly AppliedWaiver[];
  readonly notChecked: readonly NotCheckedItem[];
  readonly configErrors: readonly ConfigError[];
  /** intake found nothing it recognises. */
  readonly noFilesNote?: { readonly checked: InputText | StdinPath };
  readonly assumptions: readonly Assumption[];
  readonly summary: RunSummary;
  /** The `--config` file outside the root: its shown name and resolved path, for the SARIF location only. */
  readonly outsideConfig?: { readonly shown: InputText; readonly real: InputText };
}
