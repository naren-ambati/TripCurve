// The Python server models: what the gunicorn and uvicorn
// readers found. Every setting is a list of CONTRIBUTIONS, one per place that sets
// it (the command line, GUNICORN_CMD_ARGS, a Dockerfile ENV, the config file), each a
// sourced value or an unresolved value with a fixed reason. Nothing here chooses
// between two places: the precedence of conflicting sources belongs to the resolver,
// which has one function for it.
//
// "Not found" is not recorded as a value. A place that could set a setting and was not
// read (an `envFrom`, a `valueFrom`, a config file that is not linked) is recorded as an
// UNRESOLVED contribution to every setting it could touch, so a search that was not
// complete can never look like "nothing sets it".

import type { SourcedValue, SourceRef, UnresolvedValue } from '../../core/index.js';

export const GUNICORN_SETTING_NAMES = [
  'workerClass',
  'threads',
  'keepalive',
  'gracefulTimeout',
  'workers',
] as const;
export type GunicornSettingName = (typeof GUNICORN_SETTING_NAMES)[number];

/** Where a setting was written. The order here is the order contributions are listed in. */
export const PY_ORIGINS = ['command', 'cmd-args-env', 'dockerfile-env', 'config-file'] as const;
export type PyOrigin = (typeof PY_ORIGINS)[number];

export type PyValue = SourcedValue | UnresolvedValue;

export interface PyContribution {
  readonly origin: PyOrigin;
  readonly value: PyValue;
}

export type GunicornContributions = Readonly<
  Record<GunicornSettingName, readonly PyContribution[]>
>;

/** What the container names with `-c` / `--config`. */
export type GunicornConfigArg =
  | { readonly kind: 'path'; readonly path: string; readonly source: SourceRef }
  /** `python:module.name`, or a value that is not a plain path: not read. */
  | { readonly kind: 'not-a-path'; readonly source: SourceRef }
  /** The flag has no value. */
  | { readonly kind: 'no-value'; readonly source: SourceRef };

export interface GunicornCommandReading {
  readonly program: 'gunicorn';
  readonly settings: GunicornContributions;
  /** `-c` / `--config` from the command line (the last one wins in gunicorn, so the last is kept). */
  readonly configArg?: GunicornConfigArg;
  /**
   * Where `--chdir` is written (command or GUNICORN_CMD_ARGS). Where gunicorn then finds its config
   * file was not measured, so the config file is not read when this is set.
   */
  readonly chdirSource?: SourceRef;
  /** The container's command, where "no -k given" is evidenced (a default has no word to point at). */
  readonly commandSource: SourceRef;
}

/** `--http` or `UVICORN_HTTP`: the protocol implementation; `text` is undefined when it is not readable. */
export interface UvicornHttpSetting {
  readonly origin: PyOrigin;
  readonly text: string | undefined;
}

export interface UvicornCommandReading {
  readonly program: 'uvicorn';
  readonly keepalive: readonly PyContribution[];
  /**
   * `--timeout-graceful-shutdown` (seconds) from the command line; an unresolved contribution for
   * every place that could set it and is not read, including `UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN`
   * (the environment form was not measured, so a value there is never used).
   */
  readonly gracefulShutdown: readonly PyContribution[];
  readonly http: readonly UvicornHttpSetting[];
  readonly commandSource: SourceRef;
}

export type PythonCommandReading = GunicornCommandReading | UvicornCommandReading;

/** The settings one `gunicorn.conf.py` shows (never run). */
export interface GunicornConfigReading {
  readonly settings: Readonly<Record<GunicornSettingName, PyValue | undefined>>;
  /** Set when a statement other than a literal assignment was met: the line of the first one. */
  readonly opaqueAtLine?: number;
  /** Set when the file is opaque because of its encoding (a PEP 263 cookie), not a statement. */
  readonly opaqueBy?: 'coding';
}

/** One `ENV` of a Dockerfile: a literal text, or not literal. */
export interface DockerEnvEntry {
  readonly text: string | undefined;
  readonly source: SourceRef;
}
export type DockerEnv = Readonly<Record<string, DockerEnvEntry>>;

// ---- fixed reasons (tripcurve text, never input text) -------------------------------

export const REASON_NOT_WHOLE_NUMBER = 'not a whole number of 0 or more';
export const REASON_CLASS_UNKNOWN = 'worker class is not one tripcurve knows';
export const REASON_NO_VALUE = 'the flag has no value';
export const REASON_EXPANSION = 'a $(...) reference in the command is expanded by Kubernetes';
export const REASON_FLAG_FORM = 'the flag is written in a form that is not read';
export const REASON_CMD_ARGS_REFERENCE =
  'GUNICORN_CMD_ARGS comes from a reference that is not read';
export const REASON_CMD_ARGS_FORM = 'GUNICORN_CMD_ARGS is not in a form tripcurve reads';
export const REASON_CMD_ARGS_CONFIG = 'a config file is named in GUNICORN_CMD_ARGS';
export const REASON_ENV_FROM_GUNICORN =
  'envFrom may set GUNICORN_CMD_ARGS from a source that is not read';
export const REASON_ENV_FROM_UVICORN =
  'envFrom may set UVICORN_TIMEOUT_KEEP_ALIVE from a source that is not read';
export const REASON_UVICORN_ENV_REFERENCE =
  'UVICORN_TIMEOUT_KEEP_ALIVE comes from a reference that is not read';
export const REASON_ENV_FILE = 'an env file is named and is not read';
export const REASON_UVICORN_GRACEFUL_ENV =
  'UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN is set in the environment, a form that was not measured';
export const REASON_ENV_FROM_UVICORN_GRACEFUL =
  'envFrom may set UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN from a source that is not read';
export const REASON_DOCKER_ENV_FORM = 'a Dockerfile ENV is not in a form tripcurve reads';
export const REASON_CONF_CODING =
  'gunicorn.conf.py declares a source encoding that tripcurve does not read';
export const REASON_CONF_OPAQUE = (line: number): string =>
  `a statement at line ${line} of gunicorn.conf.py is not a plain literal assignment`;
export const REASON_CONF_NOT_LITERAL = (line: number): string =>
  `the value at line ${line} of gunicorn.conf.py is not a literal`;
