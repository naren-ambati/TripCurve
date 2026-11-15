// PipelineRunner: intake, analyse, then the report. It owns the
// stops only it can detect: a configuration error (the config-error case, exit 2; no rule ran) comes
// back as a Report with outcome ConfigError, and an internal error is thrown for
// the caller to turn into exit 3. Everything else is RunSummarizer's.

import { analyse } from '../analyse.js';
import type { KnowledgeBase } from '../kb/index.js';
import { intake, intakeStdin, STDIN } from '../parse/index.js';
import { assembleReport, type Report } from '../report/index.js';
import { isIsoDate } from '../waive/index.js';
import { utcToday } from './clock.js';

/** The argument that means "read rendered YAML from standard input". */
export const STDIN_ARGUMENT = '-';

export interface CheckOptions {
  /** An explicit tripcurve.yaml (--config); it may lie outside the root. */
  readonly config?: string;
  /**
   * The UTC date of the run, `YYYY-MM-DD`, against which waivers expire: a waiver applies through its own
   * date and has expired from the day after. The command reads the clock once and passes it; the
   * library defaults to today's UTC date. Tests always pass it.
   */
  readonly today?: string;
}

export function runPipeline(path: string, options: CheckOptions = {}, kb?: KnowledgeBase): Report {
  const configPath = options.config === undefined ? {} : { configPath: options.config };
  const read =
    path === STDIN_ARGUMENT
      ? intakeStdin({ fd: 0, ...configPath })
      : intake({ root: path, ...configPath });
  const today = options.today ?? utcToday();
  if (!isIsoDate(today)) throw new TypeError('today must be a date in the form YYYY-MM-DD');
  const analysis = analyse(read, kb);
  return assembleReport({
    checked: path === STDIN_ARGUMENT ? STDIN : path,
    intake: read,
    analysis,
    today,
  });
}
