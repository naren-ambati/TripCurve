// CliApp: the flags, and every exit before a file is read: a
// usage error, a root path that cannot be read, `--help` and `--version`. stdout
// carries the report only; stderr carries tripcurve's own fixed messages, which
// never echo input except a quoted path (through SafeText).

import { Command, CommanderError } from 'commander';
import { inputText } from '../core/index.js';
import { inspectRoot } from '../parse/index.js';
import type { Report } from '../report/index.js';
import {
  explainRule,
  renderHuman,
  renderJson,
  renderSarif,
  UNKNOWN_RULE_MESSAGE,
} from '../report/index.js';
import { quote, t, wrap } from '../report/layout.js';
import { VERSION } from '../version.js';
import { utcToday } from './clock.js';
import { HELP_TEXT } from './help.js';
import { type CheckOptions, runPipeline, STDIN_ARGUMENT } from './pipeline.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Colour is allowed only when stdout is a terminal. */
  readonly stdoutIsTty: boolean;
}

export interface CliDeps {
  /** The pipeline, replaceable so a test can make it fail. */
  readonly check?: (path: string, options: CheckOptions) => Report;
  /** The UTC date of the run, `YYYY-MM-DD`; tests pass it, the command reads the clock once. */
  readonly today?: string;
}

export const INTERNAL_ERROR_MESSAGE =
  'tripcurve hit an internal error. Nothing was verified. This is a bug in\ntripcurve, not in your files.\n';

const FORMATS = ['human', 'json', 'sarif'] as const;

interface ParsedOptions {
  explain?: string;
  format?: string;
  config?: string;
  verbose?: boolean;
  color: boolean;
  help?: boolean;
  version?: boolean;
}

function usageError(io: CliIo, message: string): 2 {
  io.stderr(`tripcurve: ${message} See --help.\n`);
  return 2;
}

function commanderMessage(error: CommanderError): string {
  switch (error.code) {
    case 'commander.unknownOption':
      return 'unknown option.';
    case 'commander.excessArguments':
      return 'only one path can be given.';
    case 'commander.optionMissingArgument':
      return 'an option is missing its value.';
    case 'commander.missingArgument':
      return 'an argument is missing.';
    default:
      return 'invalid usage.';
  }
}

function parseArguments(
  args: readonly string[],
): { ok: true; path: string | undefined; options: ParsedOptions } | { ok: false; message: string } {
  const program = new Command();
  program
    .name('tripcurve')
    .helpOption(false)
    .exitOverride()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    .allowExcessArguments(false)
    .argument('[path]')
    .option('--explain <rule>')
    .option('--format <format>')
    .option('--config <file>')
    .option('--verbose')
    .option('--no-color')
    .option('--help')
    .option('--version');
  try {
    program.parse([...args], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return { ok: false, message: commanderMessage(error) };
    throw error;
  }
  return { ok: true, path: program.args[0], options: program.opts<ParsedOptions>() };
}

function colourWanted(options: ParsedOptions, io: CliIo, env: NodeJS.ProcessEnv): boolean {
  if (options.color === false || !io.stdoutIsTty) return false;
  return env.NO_COLOR === undefined || env.NO_COLOR === '';
}

function unreadablePathMessage(path: string): string {
  const lines = wrap(
    [t('tripcurve: '), quote(inputText(path), 50), t(' does not exist or cannot be read.')],
    '',
    '  ',
  );
  return `${[...lines, 'Nothing was checked.'].join('\n')}\n`;
}

/**
 * Runs the command line and returns the exit code: 0, 1, 2 or 3. Nothing here
 * throws; an unexpected failure is exit 3 with the fixed message and no stack.
 */
export function runCli(
  args: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = {},
  deps: CliDeps = {},
): number {
  // The clock is read here, once, and nowhere else.
  const today = deps.today ?? utcToday();
  const parsed = parseArguments(args);
  if (!parsed.ok) return usageError(io, parsed.message);
  const { options } = parsed;
  if (options.help === true) {
    io.stdout(HELP_TEXT);
    return 0;
  }
  if (options.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (options.explain !== undefined) {
    if (parsed.path !== undefined) return usageError(io, '--explain cannot be used with a path.');
    // --explain is text for a person; a JSON or SARIF consumer would get something that is not its format.
    if (options.format !== undefined && options.format !== 'human') {
      return usageError(io, '--explain prints text only.');
    }
    const text = explainRule(options.explain);
    if (text === undefined) {
      io.stderr(UNKNOWN_RULE_MESSAGE);
      return 2;
    }
    io.stdout(text);
    return 0;
  }
  const format = FORMATS.find((f) => f === options.format);
  if (options.format !== undefined && format === undefined) {
    return usageError(io, 'unknown format. Formats are human, json and sarif.');
  }
  const path = parsed.path ?? '.';
  if (path !== STDIN_ARGUMENT && !inspectRoot(path).ok) {
    io.stderr(unreadablePathMessage(path));
    return 2;
  }
  try {
    const run = deps.check ?? runPipeline;
    const report = run(path, {
      ...(options.config === undefined ? {} : { config: options.config }),
      today,
    });
    io.stdout(
      format === 'json'
        ? renderJson(report)
        : format === 'sarif'
          ? renderSarif(report)
          : renderHuman(report, {
              verbose: options.verbose === true,
              color: colourWanted(options, io, env),
            }),
    );
    return report.summary.exitCode;
  } catch {
    io.stderr(INTERNAL_ERROR_MESSAGE);
    return 3;
  }
}
