// RunSummarizer: the one owner of the counting order, the outcome
// precedence, `clean`, the closing lines and the exit code for every run that
// reached intake with a valid configuration (the no-files case and the nothing-checked case included). Every
// renderer prints what this returns; none counts for itself.
//
// Honesty: `clean` is a function of `outcome` and nothing else, and it is
// true exactly when the exit code is 0. "All checks passed" is produced in one
// place only (`cleanLine`), reachable only from the Clean outcome, which needs no
// failed, warning, unresolved, version-dependent or not-evaluated result, no
// unchecked file, no waiver and at least one pass.

import type { Finding } from '../core/index.js';
import type { Counts, ExitCode, Outcome, RunSummary } from './model.js';

export interface SummarizeInput {
  readonly findings: readonly Finding[];
  /** Files (and streams) that were not checked; they count under unresolved. */
  readonly uncheckedFiles: number;
  /** Waivers that are invalid or match nothing (B6 supplies them; none exist in B1). */
  readonly waiversNotApplied?: number;
  /** Workloads listed as not checked (no load balancer found): the suffix. */
  readonly workloadsNotChecked: number;
}

export const ZERO_DOWNTIME_LINE = 'Green does not mean zero-downtime: see Assumptions.';

const EXIT_BY_OUTCOME: Readonly<Record<Outcome, ExitCode>> = {
  NothingChecked: 2,
  Incomplete: 1,
  NotClean: 1,
  NoFailures: 0,
  NoChecksApply: 0,
  Clean: 0,
  ConfigError: 2,
};

/** `clean` follows from the outcome: the three outcomes that exit 0. */
export function isCleanOutcome(outcome: Outcome): boolean {
  return EXIT_BY_OUTCOME[outcome] === 0;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function countsText(counts: Counts, files: number, waivers: number): string {
  const parts: string[] = [];
  const add = (n: number, text: string): void => {
    if (n > 0) parts.push(`${n} ${text}`);
  };
  add(counts.failed, 'failed');
  add(counts.warning, plural(counts.warning, 'warning', 'warnings'));
  if (counts.unresolved > 0) {
    const detail: string[] = [];
    if (files > 0) detail.push(`${files} ${plural(files, 'file', 'files')} not checked`);
    if (waivers > 0) detail.push(`${waivers} ${plural(waivers, 'waiver', 'waivers')} not applied`);
    parts.push(
      detail.length === 0
        ? `${counts.unresolved} unresolved`
        : `${counts.unresolved} unresolved (${detail.join(', ')})`,
    );
  }
  add(counts.versionDependent, 'version-dependent');
  add(counts.notEvaluated, 'not evaluated');
  add(counts.waived, 'waived');
  add(counts.notApplicable, 'not applicable');
  add(counts.passed, 'passed');
  return parts.join(', ');
}

function notCheckedSuffix(workloadsNotChecked: number): string {
  return workloadsNotChecked > 0
    ? `; ${workloadsNotChecked} ${plural(workloadsNotChecked, 'workload', 'workloads')} not checked`
    : '';
}

function count(findings: readonly Finding[]): {
  counts: Omit<Counts, 'unresolved'> & { unresolvedFindings: number };
  dates: string[];
} {
  let failed = 0;
  let warning = 0;
  let unresolvedFindings = 0;
  let versionDependent = 0;
  let notEvaluated = 0;
  let waived = 0;
  let notApplicable = 0;
  let passed = 0;
  const dates = new Set<string>();
  for (const f of findings) {
    switch (f.kind) {
      case 'FAIL':
        failed += 1;
        break;
      case 'WARN':
        warning += 1;
        break;
      case 'VERSION-DEPENDENT':
        versionDependent += 1;
        break;
      case 'NOT EVALUATED':
        notEvaluated += 1;
        break;
      case 'WAIVED':
        waived += 1;
        if (f.waiver !== undefined) dates.add(f.waiver.until);
        break;
      case 'N/A':
        notApplicable += 1;
        break;
      case 'PASS':
        passed += 1;
        break;
      default:
        // UNRESOLVED, and anything that is not one of the eight kinds: never counted as good.
        unresolvedFindings += 1;
    }
  }
  return {
    counts: {
      failed,
      warning,
      unresolvedFindings,
      versionDependent,
      notEvaluated,
      waived,
      notApplicable,
      passed,
    },
    dates: [...dates].sort(),
  };
}

/** The outcome by the fixed precedence (interaction spec, "Precedence once files are read"). */
export function decideOutcome(args: {
  readonly results: number;
  readonly uncheckedFiles: number;
  readonly notClean: boolean;
  readonly waived: number;
  readonly passed: number;
}): Outcome {
  if (args.results === 0) return 'NothingChecked';
  if (args.uncheckedFiles > 0) return 'Incomplete';
  if (args.notClean) return 'NotClean';
  if (args.waived > 0) return 'NoFailures';
  if (args.passed === 0) return 'NoChecksApply';
  return 'Clean';
}

export function summarizeRun(input: SummarizeInput): RunSummary {
  const waivers = input.waiversNotApplied ?? 0;
  const { counts: c, dates } = count(input.findings);
  const counts: Counts = {
    failed: c.failed,
    warning: c.warning,
    unresolved: c.unresolvedFindings + input.uncheckedFiles + waivers,
    versionDependent: c.versionDependent,
    notEvaluated: c.notEvaluated,
    waived: c.waived,
    notApplicable: c.notApplicable,
    passed: c.passed,
  };
  const notClean =
    c.failed + c.warning + c.unresolvedFindings + c.versionDependent + c.notEvaluated + waivers > 0;
  const outcome = decideOutcome({
    results: input.findings.length,
    uncheckedFiles: input.uncheckedFiles,
    notClean,
    waived: c.waived,
    passed: c.passed,
  });
  const suffix = notCheckedSuffix(input.workloadsNotChecked);
  const text = countsText(counts, input.uncheckedFiles, waivers);
  let closingLines: string[];
  switch (outcome) {
    case 'NothingChecked':
      // Files and waivers that are unresolved are counted exactly as JSON counts them, so no format shows less.
      closingLines = [
        counts.unresolved > 0
          ? `Summary: nothing checked, ${text}; not a clean result`
          : 'Summary: nothing checked; not a clean result',
      ];
      break;
    case 'Incomplete':
      closingLines = [`Summary: ${text}; run incomplete, not a clean result`];
      break;
    case 'NotClean':
      closingLines = [`Summary: ${text}; not a clean result`];
      break;
    case 'NoFailures':
      closingLines = [
        `No failures: ${counts.passed} passed, ${counts.waived} waived (expiring ${dates.join(', ')}), ${counts.notApplicable} not applicable${suffix}.`,
        ZERO_DOWNTIME_LINE,
      ];
      break;
    case 'NoChecksApply':
      closingLines = [`No checks apply: ${counts.notApplicable} not applicable.`];
      break;
    case 'Clean':
      closingLines = [
        `All checks passed (${counts.passed}), ${counts.notApplicable} not applicable${suffix}.`,
        ZERO_DOWNTIME_LINE,
      ];
      break;
    case 'ConfigError':
      closingLines = ['Nothing was checked.'];
      break;
  }
  return Object.freeze({
    counts,
    unresolvedDetail: { files: input.uncheckedFiles, waivers },
    outcome,
    clean: isCleanOutcome(outcome),
    waivedDates: dates,
    exitCode: EXIT_BY_OUTCOME[outcome],
    closingLines,
  });
}

/** The summary of the config-error case stop: PipelineRunner supplies it; no rule ran. */
export function configErrorSummary(): RunSummary {
  return Object.freeze({
    counts: {
      failed: 0,
      warning: 0,
      unresolved: 0,
      versionDependent: 0,
      notEvaluated: 0,
      waived: 0,
      notApplicable: 0,
      passed: 0,
    },
    unresolvedDetail: { files: 0, waivers: 0 },
    outcome: 'ConfigError' as const,
    clean: false,
    waivedDates: [],
    exitCode: 2 as const,
    closingLines: ['Nothing was checked.'],
  });
}
