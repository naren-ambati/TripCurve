// The library export. Unstable in 0.x: it may change without notice until 1.0.
import { type CheckOptions, runPipeline } from './cli/pipeline.js';
import {
  explainRule,
  type RenderHumanOptions,
  type Report,
  renderHuman,
  renderJson,
  renderSarif,
} from './report/index.js';

export type { CheckOptions } from './cli/pipeline.js';
export type {
  AppliedWaiver,
  Counts,
  Outcome,
  Report,
  ReportBlock,
  ReportHeader,
  RunSummary,
} from './report/index.js';

/**
 * Checks a directory (or `-` for rendered YAML on standard input) and returns the
 * report. A configuration error or nothing to check is a report with exit code 2,
 * not an exception; only an internal error throws.
 */
export function check(
  path: string | ({ readonly path: string } & CheckOptions),
  options: CheckOptions = {},
): Report {
  if (typeof path === 'string') return runPipeline(path, options);
  const { path: where, ...rest } = path;
  return runPipeline(where, { ...rest, ...options });
}

/** The report as text: the human report, a JSON document or a SARIF 2.1.0 log. */
export function render(
  report: Report,
  format: 'human' | 'json' | 'sarif',
  options: RenderHumanOptions = {},
): string {
  if (format === 'json') return renderJson(report);
  if (format === 'sarif') return renderSarif(report);
  if (format !== 'human') throw new TypeError('the format is human, json or sarif');
  return renderHuman(report, options);
}

/** What `explain` returns for a rule that is not one of T1 to T4. */
export interface UnknownRule {
  readonly unknownRule: true;
}

/** The text of `--explain <rule>`: tripcurve's own shipped text, or `UnknownRule`. Reads no file. */
export function explain(rule: string): string | UnknownRule {
  return explainRule(rule) ?? { unknownRule: true };
}
