// PythonServerReader: the gunicorn and uvicorn settings a container shows, from its
// command and args, its literal environment, and a linked Dockerfile's ENV. Pure: it reads
// the models the Kubernetes reader and intake produced and never runs anything.
//
// Every place that could set a setting and is NOT readable is recorded as an unresolved
// contribution (see model.ts), so "no source sets it" always means every place was read.

import {
  inputText,
  inputTextEquals,
  isInputText,
  isSourcedValue,
  makeUnresolved,
  type SourceRef,
} from '../../core/index.js';
import { rawInputTextForParser } from '../intake/index.js';
import type { K8sContainer, K8sEnvVar, K8sStringList } from '../k8s/index.js';
import {
  markAllGunicorn,
  newGunicornAcc,
  readGunicornFlags,
  readUvicornFlags,
  uvicornValue,
  type Word,
} from './flags.js';
import {
  type DockerEnv,
  type PyContribution,
  type PyOrigin,
  type PythonCommandReading,
  REASON_CMD_ARGS_CONFIG,
  REASON_CMD_ARGS_FORM,
  REASON_CMD_ARGS_REFERENCE,
  REASON_DOCKER_ENV_FORM,
  REASON_ENV_FILE,
  REASON_ENV_FROM_GUNICORN,
  REASON_ENV_FROM_UVICORN,
  REASON_ENV_FROM_UVICORN_GRACEFUL,
  REASON_EXPANSION,
  REASON_UVICORN_ENV_REFERENCE,
  REASON_UVICORN_GRACEFUL_ENV,
  type UvicornHttpSetting,
} from './model.js';
import { shlexSplit } from './shell-words.js';

export const GUNICORN_CMD_ARGS = 'GUNICORN_CMD_ARGS';
export const UVICORN_KEEPALIVE_ENV = 'UVICORN_TIMEOUT_KEEP_ALIVE';
export const UVICORN_GRACEFUL_ENV = 'UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN';
export const UVICORN_ENV_FILE_ENV = 'UVICORN_ENV_FILE';
export const UVICORN_HTTP_ENV = 'UVICORN_HTTP';
/** The Dockerfile ENV names the readers look for. */
export const DOCKERFILE_ENV_NAMES: readonly string[] = [
  GUNICORN_CMD_ARGS,
  UVICORN_KEEPALIVE_ENV,
  UVICORN_GRACEFUL_ENV,
  UVICORN_ENV_FILE_ENV,
  UVICORN_HTTP_ENV,
];

function basenameOf(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash < 0 ? word : word.slice(slash + 1);
}

/**
 * Which Python server a command runs, and where its own flags start: `gunicorn ...`,
 * `uvicorn ...`, `python -m gunicorn ...`, `python -m uvicorn ...` (any `python`, `python3`,
 * `python3.12`). Anything else (`poetry run gunicorn`, `sh -c ...`) is not read.
 */
export function pythonServerProgram(
  words: readonly string[] | undefined,
): { program: 'gunicorn' | 'uvicorn'; flagsFrom: number } | undefined {
  const first = words?.[0];
  if (words === undefined || first === undefined) return undefined;
  const program = basenameOf(first);
  if (program === 'gunicorn' || program === 'uvicorn') return { program, flagsFrom: 1 };
  if (/^python[0-9.]*$/.test(program) && words[1] === '-m') {
    const module = words[2];
    if (module === 'gunicorn' || module === 'uvicorn') return { program: module, flagsFrom: 3 };
  }
  return undefined;
}

function wordsOf(list: K8sStringList | undefined): Word[] | undefined {
  if (list === undefined) return [];
  if ('unresolved' in list) return undefined;
  const out: Word[] = [];
  for (const item of list.items) {
    if (!isInputText(item.value)) return undefined;
    out.push({ text: rawInputTextForParser(item.value), source: item.source });
  }
  return out;
}

/** The container's literal words (command then args), or undefined when they are not all literal. */
export function commandWords(container: K8sContainer): Word[] | undefined {
  if (container.command === undefined || 'unresolved' in container.command) return undefined;
  const command = wordsOf(container.command);
  const args = wordsOf(container.args);
  if (command === undefined || args === undefined) return undefined;
  return [...command, ...args];
}

type EnvLookup =
  | { readonly state: 'absent' }
  | { readonly state: 'ambiguous' }
  | { readonly state: 'present'; readonly env: K8sEnvVar };

function lookupEnv(container: K8sContainer, name: string): EnvLookup {
  const wanted = inputText(name);
  const found = container.env.filter((v) => inputTextEquals(v.name, wanted));
  const [only] = found;
  if (only === undefined) return { state: 'absent' };
  return found.length > 1 ? { state: 'ambiguous' } : { state: 'present', env: only };
}

/** The literal text of an env var, or undefined when it is a reference or not text. */
function envText(env: K8sEnvVar): string | undefined {
  const v = env.value;
  return isSourcedValue(v) && isInputText(v.value) ? rawInputTextForParser(v.value) : undefined;
}

// ---- gunicorn ----------------------------------------------------------------------------

function readGunicorn(
  container: K8sContainer,
  words: readonly Word[],
  dockerEnv: DockerEnv | undefined,
  commandSource: SourceRef,
): PythonCommandReading {
  const acc = newGunicornAcc();
  readGunicornFlags(words, 'command', acc);

  const addEnvText = (text: string, source: SourceRef, origin: PyOrigin): void => {
    if (text.includes('$(')) {
      markAllGunicorn(acc, origin, REASON_EXPANSION);
      return;
    }
    const split = shlexSplit(text);
    if (split === undefined) {
      markAllGunicorn(acc, origin, REASON_CMD_ARGS_FORM);
      return;
    }
    const scratch = newGunicornAcc();
    readGunicornFlags(
      split.map((t) => ({ text: t, source })),
      origin,
      scratch,
    );
    // A config file named in GUNICORN_CMD_ARGS is applied after gunicorn has loaded its config:
    // how it takes effect is not established, so every setting is unresolved.
    if (scratch.configArg !== undefined) {
      markAllGunicorn(acc, origin, REASON_CMD_ARGS_CONFIG);
      return;
    }
    if (scratch.chdir !== undefined) acc.chdir ??= scratch.chdir;
    for (const name of Object.keys(scratch.settings) as Array<keyof typeof scratch.settings>) {
      // not push(...list): a spread of a huge list into a call overflows the stack
      for (const contribution of scratch.settings[name]) acc.settings[name].push(contribution);
    }
  };

  const manifest = lookupEnv(container, GUNICORN_CMD_ARGS);
  if (manifest.state === 'ambiguous') {
    markAllGunicorn(acc, 'cmd-args-env', REASON_CMD_ARGS_FORM);
  } else if (manifest.state === 'present') {
    // `env` takes precedence over `envFrom` and over an image's ENV.
    const text = envText(manifest.env);
    if (text === undefined) markAllGunicorn(acc, 'cmd-args-env', REASON_CMD_ARGS_REFERENCE);
    else addEnvText(text, manifest.env.source, 'cmd-args-env');
  } else if (container.envFromSource !== undefined) {
    markAllGunicorn(acc, 'cmd-args-env', REASON_ENV_FROM_GUNICORN);
  } else {
    const image = dockerEnv?.[GUNICORN_CMD_ARGS];
    if (image !== undefined) {
      if (image.text === undefined) markAllGunicorn(acc, 'dockerfile-env', REASON_DOCKER_ENV_FORM);
      else addEnvText(image.text, image.source, 'dockerfile-env');
    }
  }
  const reading: PythonCommandReading = {
    program: 'gunicorn',
    settings: acc.settings,
    commandSource,
    ...(acc.configArg === undefined ? {} : { configArg: acc.configArg }),
    ...(acc.chdir === undefined ? {} : { chdirSource: acc.chdir }),
  };
  return reading;
}

// ---- uvicorn -----------------------------------------------------------------------------

function readUvicorn(
  container: K8sContainer,
  words: readonly Word[],
  dockerEnv: DockerEnv | undefined,
  commandSource: SourceRef,
): PythonCommandReading {
  const flags = readUvicornFlags(words, 'command');
  const keepalive: PyContribution[] = flags.keepalive;
  const gracefulShutdown: PyContribution[] = flags.gracefulShutdown;
  const http: UvicornHttpSetting[] = flags.http;
  const unresolved = (origin: PyOrigin, reason: string): void => {
    keepalive.push({ origin, value: makeUnresolved(reason) });
  };
  /** The graceful shutdown timeout is read from the command line only; any other place is not measured. */
  const gracefulUnresolved = (origin: PyOrigin, reason: string): void => {
    gracefulShutdown.push({ origin, value: makeUnresolved(reason) });
  };

  const httpEnv = lookupEnv(container, UVICORN_HTTP_ENV);
  if (httpEnv.state !== 'absent') {
    http.push({
      origin: 'cmd-args-env',
      text: httpEnv.state === 'present' ? envText(httpEnv.env) : undefined,
    });
  } else if (container.envFromSource !== undefined) {
    http.push({ origin: 'cmd-args-env', text: undefined });
  } else if (dockerEnv?.[UVICORN_HTTP_ENV] !== undefined) {
    // an image's ENV, read only for a linked Dockerfile
    http.push({ origin: 'dockerfile-env', text: dockerEnv[UVICORN_HTTP_ENV]?.text });
  }

  // UVICORN_ENV_FILE (or an envFrom) names an env file that is not read
  const envFile = lookupEnv(container, UVICORN_ENV_FILE_ENV);
  if (envFile.state !== 'absent') {
    unresolved('cmd-args-env', REASON_ENV_FILE);
    gracefulUnresolved('cmd-args-env', REASON_ENV_FILE);
  }

  const gracefulEnv = lookupEnv(container, UVICORN_GRACEFUL_ENV);
  if (gracefulEnv.state !== 'absent') {
    gracefulUnresolved('cmd-args-env', REASON_UVICORN_GRACEFUL_ENV);
  } else if (container.envFromSource !== undefined) {
    gracefulUnresolved('cmd-args-env', REASON_ENV_FROM_UVICORN_GRACEFUL);
  } else if (dockerEnv?.[UVICORN_GRACEFUL_ENV] !== undefined) {
    gracefulUnresolved('dockerfile-env', REASON_UVICORN_GRACEFUL_ENV);
  }

  const manifest = lookupEnv(container, UVICORN_KEEPALIVE_ENV);
  if (manifest.state === 'ambiguous') {
    unresolved('cmd-args-env', REASON_UVICORN_ENV_REFERENCE);
  } else if (manifest.state === 'present') {
    const text = envText(manifest.env);
    if (text === undefined) unresolved('cmd-args-env', REASON_UVICORN_ENV_REFERENCE);
    else keepalive.push({ origin: 'cmd-args-env', value: uvicornValue(text, manifest.env.source) });
  } else if (container.envFromSource !== undefined) {
    unresolved('cmd-args-env', REASON_ENV_FROM_UVICORN);
  } else {
    const image = dockerEnv?.[UVICORN_KEEPALIVE_ENV];
    if (image !== undefined) {
      if (image.text === undefined) unresolved('dockerfile-env', REASON_DOCKER_ENV_FORM);
      else
        keepalive.push({ origin: 'dockerfile-env', value: uvicornValue(image.text, image.source) });
    }
    if (dockerEnv?.[UVICORN_ENV_FILE_ENV] !== undefined) {
      unresolved('dockerfile-env', REASON_ENV_FILE);
      gracefulUnresolved('dockerfile-env', REASON_ENV_FILE);
    }
  }
  return { program: 'uvicorn', keepalive, gracefulShutdown, http, commandSource };
}

/**
 * What the container's command, literal environment and (when linked) Dockerfile ENV say about
 * gunicorn or uvicorn; undefined when the command is not one of them or is not literal.
 */
export function readPythonCommand(
  container: K8sContainer,
  dockerEnv?: DockerEnv,
): PythonCommandReading | undefined {
  const words = commandWords(container);
  if (words === undefined) return undefined;
  const server = pythonServerProgram(words.map((w) => w.text));
  if (server === undefined) return undefined;
  const flags = words.slice(server.flagsFrom);
  const commandSource =
    container.command !== undefined && !('unresolved' in container.command)
      ? container.command.source
      : container.source;
  return server.program === 'gunicorn'
    ? readGunicorn(container, flags, dockerEnv, commandSource)
    : readUvicorn(container, flags, dockerEnv, commandSource);
}
