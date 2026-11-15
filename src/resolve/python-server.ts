// The idle close of a gunicorn or uvicorn server.
//
// The worker model is resolved BEFORE any keep-alive default:
//   - the worker class is read from the settings (the command line, GUNICORN_CMD_ARGS, a
//     linked Dockerfile's ENV, the config file); the default, `sync`, applies ONLY when every
//     place that could set it was read and none did;
//   - `--threads` above 1 with the sync worker means gthread, as in gunicorn;
//   - `sync` closes every connection after its response: rule T1 is not applicable to it;
//   - the uvicorn worker, gthread, gevent, eventlet and tornado use a knowledge-base entry (a
//     class with no measured entry is UNRESOLVED, never a borrowed number); an unknown class
//     is UNRESOLVED.
// A setting written in two places is resolved by `resolveSettingPrecedence` (the seam). An
// explicit `keepalive` is not turned into an idle close until its effect is measured (the
// same rule as an explicit Node `keepAliveTimeout`), so it is UNRESOLVED with its value
// shown. A knowledge-base default needs a release: see `python-version.ts`.

import {
  type Assumption,
  type ChainStep,
  defaultSource,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  SafeText,
  type SourcedValue,
  type SourceRef,
} from '../core/index.js';
import type { WorkerClass } from '../core/vocab.js';
import {
  explicitBasisWords,
  type KbEntry,
  type KbSource,
  type KnowledgeBase,
  sourcedValueFromEntry,
  supportsPass,
  unknownInterval,
  type VersionInterval,
} from '../kb/index.js';
import type { GunicornConfigUnlinkedReason, WorkloadChain } from '../link/index.js';
import {
  DOCKERFILE_ENV_NAMES,
  type DockerEnv,
  GUNICORN_SETTING_NAMES,
  type GunicornCommandReading,
  type GunicornSettingName,
  type InputFile,
  type IntakeResult,
  type K8sContainer,
  type PyContribution,
  type PyOrigin,
  type PyValue,
  readDockerfileEnv,
  readGunicornConfig,
  readPythonCommand,
  type UvicornCommandReading,
  uncheckedReasonWords,
} from '../parse/index.js';
import { resolveSettingPrecedence } from './gunicorn-precedence.js';
import type {
  Candidate,
  IdleCloseResolution,
  ResolvedCeiling,
  ResolvedServer,
  ResolveProblem,
} from './model.js';
import { describeInterval } from './node-version.js';
import {
  DECLARE_NO_UVICORN_VERSION,
  type Known,
  REASON_NO_UVICORN_VERSION,
  resolvePythonServerVersion,
  versionAssumptions,
} from './python-version.js';
import { DECLARE_LONGEST_REQUEST } from './shutdown-text.js';

export const REASON_CONF_MAY_BE_LOADED =
  'gunicorn.conf.py may be loaded from the working directory; link it in tripcurve.yaml';
export const DECLARE_LINK_CONFIG =
  'link the gunicorn.conf.py as gunicorn_config for this workload in tripcurve.yaml';
export const DECLARE_LITERAL_SETTING =
  'give the setting as a literal flag in the container command, or link the gunicorn config in tripcurve.yaml';
export const REASON_CHDIR =
  'the --chdir flag changes where gunicorn looks for its config file, and that is not measured';
export const REASON_EXPLICIT_KEEPALIVE =
  'the effect of an explicit keepalive on the idle close is not measured yet';
export const DECLARE_EXPLICIT_KEEPALIVE =
  'no declaration settles this: the effect of an explicit keepalive is not measured for this worker and release';
export const REASON_NO_COMMAND = 'the container command is not read as gunicorn or uvicorn';

export const GUNICORN_CONFIG_REASON_TEXT: Record<GunicornConfigUnlinkedReason, string> = {
  'not-a-path': 'the -c value is a module or a form that is not a file path, so it was not read',
  'no-value': 'the -c flag has no value',
  'absolute-path':
    'the -c path is inside the container, so it was not read; link the file in tripcurve.yaml',
  'working-dir-not-mapped':
    'container working directory is not mapped to the repository; link the gunicorn config in tripcurve.yaml',
  'several-files-match':
    'more than one file matches the -c path; link the gunicorn config in tripcurve.yaml',
  'outside-root': 'the config file lies outside the checked root',
  'symlink-loop': 'the config file is a symlink loop',
  unreadable: 'the config file named by -c or by the link was not found in the files read',
  'not-a-config-file':
    'the config file is not named gunicorn.conf.py, so it was not read as a gunicorn config',
  'link-conflict': 'the tripcurve.yaml link and the -c flag name different config files',
  skipped: 'the config file was skipped',
  'default-skipped': 'a gunicorn.conf.py that may be loaded was skipped',
};

const MODEL_WORDS: readonly WorkerClass[] = [
  'sync',
  'gthread',
  'gevent',
  'eventlet',
  'tornado',
  'uvicorn',
];

function asWorkerClass(word: unknown): WorkerClass | undefined {
  return MODEL_WORDS.find((w) => w === word);
}

export interface PythonResolveArgs {
  readonly chain: WorkloadChain;
  readonly container: K8sContainer;
  readonly intake: IntakeResult;
  readonly kb: KnowledgeBase;
}

/** The idle-close half of a result (T1). */
interface PythonIdleResult {
  readonly server: ResolvedServer;
  readonly resolution: IdleCloseResolution;
  readonly versionRanges: readonly string[];
  readonly assumptions: readonly Assumption[];
}

export interface PythonResolveResult extends PythonIdleResult {
  /** The graceful-timeout ceiling of the server (T3), or why none is known. */
  readonly ceiling: ResolvedCeiling;
}

function problem(label: string, reason: string): ResolveProblem {
  return { label, value: makeUnresolved(reason) };
}

function noResolution(
  family: 'gunicorn' | 'uvicorn',
  problems: readonly ResolveProblem[],
  declare: readonly string[],
  evidence: readonly ChainStep[] = [],
  explicitSetting = false,
  workerModel?: ResolvedServer['workerModel'],
): PythonIdleResult {
  return {
    server: { family, ...(workerModel === undefined ? {} : { workerModel }) },
    resolution: { candidates: [], problems, evidence, declare, explicitSetting },
    versionRanges: [],
    assumptions: [],
  };
}

function contributionsFrom(
  reading: GunicornCommandReading,
  name: GunicornSettingName,
  config: readonly PyContribution[],
): PyContribution[] {
  return [...reading.settings[name], ...config];
}

/** The config file's contribution to each setting (an unresolved value for each when it is not read). */
function configContributions(
  chain: WorkloadChain,
  reading: GunicornCommandReading,
): { byName: Record<GunicornSettingName, PyContribution[]>; assumptions: Assumption[] } {
  const byName: Record<GunicornSettingName, PyContribution[]> = {
    workerClass: [],
    threads: [],
    keepalive: [],
    gracefulTimeout: [],
    workers: [],
  };
  const assumptions: Assumption[] = [];
  const link = chain.gunicornConfig;
  const all = (reason: string): void => {
    for (const name of GUNICORN_SETTING_NAMES) {
      byName[name].push({ origin: 'config-file', value: makeUnresolved(reason) });
    }
  };
  if (link === undefined || link.state === 'none') return { byName, assumptions };
  if (reading.chdirSource !== undefined) {
    // Where gunicorn looks for its config file after `--chdir` was not measured.
    all(REASON_CHDIR);
  } else if (link.state === 'may-be-loaded') {
    all(REASON_CONF_MAY_BE_LOADED);
  } else if (link.state === 'unlinked') {
    all(
      link.reasonCode === 'skipped' && link.skip !== undefined
        ? `the config file was skipped: ${uncheckedReasonWords(link.skip)}`
        : link.reasonCode === 'default-skipped' && link.skip !== undefined
          ? `a gunicorn.conf.py that may be loaded was skipped: ${uncheckedReasonWords(link.skip)}`
          : GUNICORN_CONFIG_REASON_TEXT[link.reasonCode],
    );
  } else {
    const reading = readGunicornConfig(link.file);
    for (const name of GUNICORN_SETTING_NAMES) {
      const value = reading.settings[name];
      if (value !== undefined) byName[name].push({ origin: 'config-file', value });
    }
    if (link.assumedWorkingDir !== undefined) {
      assumptions.push({
        text: `The container's working directory is taken to be ${SafeText.render(link.assumedWorkingDir, 'terminal')}.`,
        reason:
          'the -c flag names a relative file, and the working directory of the container is not read',
      });
    }
  }
  return { byName, assumptions };
}

function stepOf(label: string, value: PyValue, detail?: string): ChainStep {
  return { label, value, ...(detail === undefined ? {} : { detail }) };
}

interface ExplicitArgs {
  readonly program: 'gunicorn' | 'uvicorn';
  readonly subject: 'gunicorn-keepalive-explicit' | 'uvicorn-keepalive-explicit';
  readonly keepalive: SourcedValue;
  readonly model: WorkerClass | undefined;
  readonly interval: VersionInterval;
  readonly kb: KnowledgeBase;
  readonly server: ResolvedServer;
  /** Chain steps before the keepalive step (the worker). */
  readonly head: readonly ChainStep[];
  readonly version: Extract<ReturnType<typeof resolvePythonServerVersion>, { state: 'known' }>;
  readonly assumptions: readonly Assumption[];
}

/** The basis words of an explicit keepalive, as the chain prints them: `explicit keepalive, <class> (<range>; measured ...)`. */
function explicitNote(entry: KbEntry): string {
  const range = entry.rangeLabel === undefined ? '' : `${entry.rangeLabel}; `;
  return `${entry.citationName} (${range}${explicitBasisWords(entry)})`;
}

/**
 * An explicit keepalive equals the idle close ONLY where a measured entry covers the worker class
 * and the whole release interval (the entries of subject `<program>-keepalive-explicit`, citing the
 * measurement lines), and the value is a whole number of 1 or more; every other case stays
 * UNRESOLVED with the value shown. The value is the file's own: its source and line are the idle
 * close's source.
 */
export const REASON_HTTP_NOT_READ = 'HTTP protocol implementation not read';

/**
 * An explicit keepalive equals the idle close ONLY where a measured entry covers the worker class
 * and the whole release interval (the entries of subject `<program>-keepalive-explicit`, citing the
 * measurement lines), and the value lies inside the span that entry recorded as measured; every other
 * case stays UNRESOLVED with the value shown. The idle close is the nominal value, cited to the
 * measurement and printed as `explicit keepalive, <class> (<range>; measured from A to B s on <version>)`
 * (it is not a default). The setting's own source and line stay in the chain as the `keepalive` step.
 */
function explicitKeepalive(a: ExplicitArgs): PythonIdleResult {
  const { keepalive, version } = a;
  const lookup = a.kb.lookup(
    a.subject,
    a.interval,
    a.model === undefined ? {} : { workerClass: a.model },
  );
  const versionRanges = lookup.matches.map((m) => m.entry.rangeLabel ?? m.entry.id);
  const assumptions = [...a.assumptions];
  const tail = version.step === undefined ? [] : [version.step];
  const unresolvedWith = (reason: string, declare: readonly string[]): PythonIdleResult => ({
    server: a.server,
    resolution: {
      candidates: [],
      problems: [problem('idle close', reason)],
      evidence: [...a.head, stepOf('keepalive', keepalive), ...tail],
      declare,
      explicitSetting: true,
    },
    versionRanges,
    assumptions,
  });
  const notMeasured = (): PythonIdleResult =>
    unresolvedWith(REASON_EXPLICIT_KEEPALIVE, [DECLARE_EXPLICIT_KEEPALIVE]);
  const value = keepalive.value;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    lookup.matches.length === 0 ||
    !lookup.covered
  ) {
    return notMeasured();
  }
  const candidates: Candidate[] = [];
  for (const m of lookup.matches) {
    const span = m.entry.measuredSpan;
    if (span === undefined) return notMeasured();
    if (value < span.min || value > span.max) {
      return unresolvedWith(
        `explicit keepalive ${value} s is outside the measured span (${span.min} to ${span.max} s)`,
        [DECLARE_EXPLICIT_KEEPALIVE],
      );
    }
    candidates.push({
      condition: m.entry.rangeLabel ?? m.entry.id,
      value: makeSourcedValue({
        value,
        unit: 's',
        source: defaultSource({
          citation: m.entry.citationName,
          ...(m.entry.rangeLabel === undefined ? {} : { range: m.entry.rangeLabel }),
          basisText: explicitBasisWords(m.entry),
          entryId: m.entry.id,
          bare: true,
        }),
        basis: 'measured-on',
      }),
      basis: m.entry.basis,
      supportsPass: m.entry.basis !== 'to-be-measured',
      // The PASS line names the setting itself, then the measured basis.
      decidedBy: keepalive.source,
      note: explicitNote(m.entry),
    });
  }
  return {
    server: a.server,
    resolution: {
      candidates,
      problems: [],
      evidence: [...a.head, stepOf('keepalive', keepalive), ...tail],
      declare: [],
      explicitSetting: false,
    },
    versionRanges,
    assumptions,
  };
}

type WorkerModelFound =
  | { readonly stop: ResolveProblem }
  | {
      readonly model: WorkerClass;
      readonly modelSource: SourceRef;
      readonly modelReason: string;
      readonly explicitClass: WorkerClass | undefined;
      readonly classValue: PyValue | undefined;
    };

/**
 * The gunicorn worker model, from the resolved `-k` and `--threads`: the class named, else
 * the default `sync`; `--threads` above 1 turns the sync worker into gthread. A class or a threads
 * value that is not read, or a class tripcurve does not know, is a `stop` with its problem.
 */
function workerModelOf(
  reading: GunicornCommandReading,
  resolved: (name: GunicornSettingName) => PyValue | undefined,
): WorkerModelFound {
  const classValue = resolved('workerClass');
  if (classValue !== undefined && isUnresolved(classValue)) {
    return { stop: { label: 'worker', value: classValue } };
  }
  const explicitClass = classValue === undefined ? undefined : asWorkerClass(classValue.value);
  if (classValue !== undefined && explicitClass === undefined) {
    return { stop: problem('worker', 'worker class is not one tripcurve knows') };
  }
  let model: WorkerClass = explicitClass ?? 'sync';
  let modelSource: SourceRef = classValue === undefined ? reading.commandSource : classValue.source;
  let modelReason =
    explicitClass === undefined
      ? 'the gunicorn default worker class is sync'
      : `the worker class is ${model}`;
  if (model === 'sync') {
    const threads = resolved('threads');
    if (threads !== undefined && isUnresolved(threads)) {
      return { stop: { label: 'worker', value: threads } };
    }
    if (threads !== undefined && typeof threads.value === 'number' && threads.value > 1) {
      model = 'gthread';
      modelSource = threads.source;
      modelReason = '--threads above 1 switches the sync worker to gthread';
    }
  }
  return { model, modelSource, modelReason, explicitClass, classValue };
}

function resolveGunicorn(
  reading: GunicornCommandReading,
  args: PythonResolveArgs,
): PythonIdleResult {
  const { chain, kb } = args;
  const config = configContributions(chain, reading);
  const resolved = (name: GunicornSettingName): PyValue | undefined =>
    resolveSettingPrecedence(
      'gunicorn',
      name,
      contributionsFrom(reading, name, config.byName[name]),
    );
  const withAssumptions = (r: PythonIdleResult): PythonIdleResult => ({
    ...r,
    assumptions: config.assumptions,
  });

  // 1. the worker model, before any default
  const found = workerModelOf(reading, resolved);
  if ('stop' in found) {
    return withAssumptions(noResolution('gunicorn', [found.stop], [DECLARE_LITERAL_SETTING]));
  }
  const { explicitClass, classValue } = found;
  const { model, modelSource, modelReason } = found;
  const workerStep: ChainStep = {
    label: 'worker',
    value:
      explicitClass !== undefined && model === explicitClass && classValue !== undefined
        ? classValue
        : makeSourcedValue({ value: model, unit: 'none', source: modelSource, basis: 'declared' }),
  };

  // 2. sync: closes after every response, no keep-alive default is applied
  if (model === 'sync') {
    return withAssumptions(
      noResolution('gunicorn', [], [], [], false, {
        model,
        reason: modelReason,
        source: modelSource,
        fromDefault: classValue === undefined,
      }),
    );
  }
  const workerModel = { model, reason: modelReason, source: modelSource, fromDefault: false };

  // 3. keepalive from the sources, else the knowledge-base default
  const keepalive = resolved('keepalive');
  if (keepalive !== undefined && isUnresolved(keepalive)) {
    return withAssumptions(
      noResolution(
        'gunicorn',
        [{ label: 'keepalive', value: keepalive }],
        [DECLARE_LITERAL_SETTING],
        [workerStep],
        false,
        workerModel,
      ),
    );
  }
  const keepaliveStep = keepalive === undefined ? [] : [stepOf('keepalive', keepalive)];
  const version = resolvePythonServerVersion('gunicorn', chain, args.intake);
  if (version.state === 'unresolved') {
    return withAssumptions(
      noResolution(
        'gunicorn',
        [problem('version', version.reason)],
        [version.declare],
        [workerStep, ...keepaliveStep],
        keepalive !== undefined,
        workerModel,
      ),
    );
  }
  let uvicornKnown: Known | undefined;
  if (model === 'uvicorn') {
    const covered = uvicornWorkerCovered(args);
    if (covered.ok) uvicornKnown = covered.version;
    if (!covered.ok) {
      return withAssumptions(
        noResolution(
          'gunicorn',
          [problem('version', covered.reason)],
          [covered.declare],
          [workerStep, ...keepaliveStep],
          keepalive !== undefined,
          workerModel,
        ),
      );
    }
  }
  if (keepalive !== undefined) {
    return explicitKeepalive({
      program: 'gunicorn',
      subject: 'gunicorn-keepalive-explicit',
      keepalive,
      model,
      interval: version.interval,
      kb,
      server: { family: 'gunicorn', workerModel },
      head: uvicornKnown?.step === undefined ? [workerStep] : [workerStep, uvicornKnown.step],
      version,
      assumptions: [...config.assumptions, ...versionAssumptions(version, uvicornKnown)],
    });
  }
  const lookup = kb.lookup('gunicorn-keepalive', version.interval, { workerClass: model });
  const versionRanges = lookup.matches.map((m) => m.entry.rangeLabel ?? m.entry.id);
  const server: ResolvedServer = { family: 'gunicorn', workerModel };
  const evidence = [
    workerStep,
    ...(version.step === undefined ? [] : [version.step]),
    ...(uvicornKnown?.step === undefined ? [] : [uvicornKnown.step]),
  ];
  const assumptions = [...config.assumptions, ...versionAssumptions(version, uvicornKnown)];
  const none = (label: string, reason: string, declare: readonly string[]): PythonIdleResult => ({
    server,
    resolution: {
      candidates: [],
      problems: [problem(label, reason)],
      evidence,
      declare,
      explicitSetting: false,
    },
    versionRanges,
    assumptions,
  });
  if (lookup.matches.length === 0 || !lookup.covered) {
    // an entry for this class exists for some release: this release is outside it. None at all: not measured.
    const known = kb.lookup('gunicorn-keepalive', unknownInterval(), { workerClass: model });
    if (known.matches.length === 0) {
      return none('idle close', `no measured default for the ${model} worker: to be measured`, []);
    }
    return none(
      'version',
      `gunicorn ${describeInterval(version.interval)} is not covered by a measured default`,
      [],
    );
  }
  const candidates: Candidate[] = [];
  for (const m of lookup.matches) {
    const value: SourcedValue | undefined = sourcedValueFromEntry(m.entry);
    if (value === undefined) {
      return none('idle close', 'the knowledge base entry holds no number', []);
    }
    candidates.push({
      condition: m.entry.rangeLabel ?? m.entry.id,
      value,
      basis: m.entry.basis,
      supportsPass: supportsPass(m.entry),
    });
  }
  return {
    server,
    resolution: { candidates, problems: [], evidence, declare: [], explicitSetting: false },
    versionRanges,
    assumptions,
  };
}

/**
 * The uvicorn worker's keep-alive timer is uvicorn's code, so its entries apply only when a uvicorn
 * version is established (a `runtime.uvicorn` declaration, or an exact pin in the nearest pin files,
 * with the same rules as any version) and an entry covers it (0.54.x from 0.54.0). A gunicorn pin
 * alone is not enough. The HTTP implementation does not matter for a covered version: h11 and
 * httptools were measured identical (measure/results/2026-11-11-b2-httptools.jsonl).
 */
function uvicornWorkerCovered(
  args: PythonResolveArgs,
): { ok: true; version: Known } | { ok: false; reason: string; declare: string } {
  const v = resolvePythonServerVersion('uvicorn', args.chain, args.intake);
  if (v.state === 'unresolved') {
    return {
      ok: false,
      reason:
        v.reason === REASON_NO_UVICORN_VERSION
          ? 'uvicorn version not in the files; declare runtime.uvicorn'
          : v.reason,
      declare: v.declare,
    };
  }
  const lookup = args.kb.lookup('uvicorn-keepalive', v.interval);
  if (lookup.matches.length === 0 || !lookup.covered) {
    return {
      ok: false,
      reason: `uvicorn ${describeInterval(v.interval)} is not covered by a measured default`,
      declare: DECLARE_NO_UVICORN_VERSION,
    };
  }
  return { ok: true, version: v };
}

/** A `--http` or `UVICORN_HTTP` value other than h11, httptools or auto (uvicorn has exactly these), or one not readable. */
function httpNotRead(reading: UvicornCommandReading): boolean {
  return reading.http.some(
    (h) => h.text === undefined || !['h11', 'httptools', 'auto'].includes(h.text),
  );
}

function resolveUvicorn(reading: UvicornCommandReading, args: PythonResolveArgs): PythonIdleResult {
  const { kb } = args;
  const keepalive = resolveSettingPrecedence('uvicorn', 'keepalive', reading.keepalive);
  if (keepalive !== undefined) {
    if (isUnresolved(keepalive)) {
      return noResolution(
        'uvicorn',
        [{ label: 'keepalive', value: keepalive }],
        ['give --timeout-keep-alive as a literal flag in the container command'],
      );
    }
  }
  const version = resolvePythonServerVersion('uvicorn', args.chain, args.intake);
  if (version.state === 'unresolved') {
    return noResolution(
      'uvicorn',
      [problem('version', version.reason)],
      [version.declare],
      keepalive === undefined ? [] : [stepOf('keepalive', keepalive)],
      keepalive !== undefined,
    );
  }
  if (httpNotRead(reading)) {
    return noResolution(
      'uvicorn',
      [problem('protocol', REASON_HTTP_NOT_READ)],
      ['give --http as h11, httptools or auto, or leave it out'],
      keepalive === undefined ? [] : [stepOf('keepalive', keepalive)],
      keepalive !== undefined,
    );
  }
  if (keepalive !== undefined) {
    return explicitKeepalive({
      program: 'uvicorn',
      subject: 'uvicorn-keepalive-explicit',
      keepalive,
      model: undefined,
      interval: version.interval,
      kb,
      server: { family: 'uvicorn' },
      head: [],
      version,
      assumptions: versionAssumptions(undefined, version),
    });
  }
  const lookup = kb.lookup('uvicorn-keepalive', version.interval);
  const versionRanges = lookup.matches.map((m) => m.entry.rangeLabel ?? m.entry.id);
  const server: ResolvedServer = { family: 'uvicorn' };
  const evidence = version.step === undefined ? [] : [version.step];
  const assumptions = versionAssumptions(undefined, version);
  const none = (label: string, reason: string): PythonIdleResult => ({
    server,
    resolution: {
      candidates: [],
      problems: [problem(label, reason)],
      evidence,
      declare: [],
      explicitSetting: false,
    },
    versionRanges,
    assumptions,
  });
  if (lookup.matches.length === 0 || !lookup.covered) {
    return none(
      'version',
      `uvicorn ${describeInterval(version.interval)} is not covered by a measured default`,
    );
  }
  const candidates: Candidate[] = [];
  for (const m of lookup.matches) {
    const value = sourcedValueFromEntry(m.entry);
    if (value === undefined) return none('idle close', 'the knowledge base entry holds no number');
    candidates.push({
      condition: m.entry.rangeLabel ?? m.entry.id,
      value,
      basis: m.entry.basis,
      supportsPass: supportsPass(m.entry),
    });
  }
  return {
    server,
    resolution: { candidates, problems: [], evidence, declare: [], explicitSetting: false },
    versionRanges,
    assumptions,
  };
}

// ---- the graceful-timeout ceiling (T3, bolt B4) ----------------------------------------------

function ceilingUnresolved(reason: string, declare?: readonly string[]): ResolvedCeiling {
  return { state: 'unresolved', reason, declare: declare ?? [DECLARE_LONGEST_REQUEST] };
}

const SOURCE_OF_ORIGIN: Readonly<Record<PyOrigin, KbSource>> = {
  command: 'command',
  'cmd-args-env': 'env',
  'dockerfile-env': 'env',
  'config-file': 'config-file',
};
const SOURCE_WORDS: Readonly<Record<KbSource, string>> = {
  command: 'the command line',
  env: 'GUNICORN_CMD_ARGS',
  'config-file': 'a config file',
};

/** Workers whose default graceful timeout was measured (bolt B4): sync, gthread and the uvicorn worker. */
const MEASURED_CEILING_CLASSES: readonly WorkerClass[] = ['sync', 'gthread', 'uvicorn'];

/**
 * How long gunicorn waits for a request still running at SIGTERM: `graceful_timeout`, measured at 30 s
 * by default for the sync worker, gthread and the uvicorn worker, and at 10 s for `--graceful-timeout
 * 10` on the sync worker only (`measure/results/2026-11-11-b4.jsonl`). The ceiling is established only
 * when every place that could set the setting was read, the worker class is one that was measured, the
 * release is covered by an entry, and (for an explicit value) the value, the class and the place (the
 * command line) are exactly what was measured. Anything else is UNRESOLVED with the reason.
 */
function gunicornCeiling(
  reading: GunicornCommandReading,
  args: PythonResolveArgs,
): ResolvedCeiling {
  const { chain, kb } = args;
  const config = configContributions(chain, reading);
  const resolved = (name: GunicornSettingName): PyValue | undefined =>
    resolveSettingPrecedence(
      'gunicorn',
      name,
      contributionsFrom(reading, name, config.byName[name]),
    );
  const found = workerModelOf(reading, resolved);
  if ('stop' in found)
    return ceilingUnresolved(`the worker model is not known: ${found.stop.value.reason}`);
  const model = found.model;
  if (!MEASURED_CEILING_CLASSES.includes(model)) {
    return ceilingUnresolved(`no measured graceful timeout for the ${model} worker`);
  }
  const contributions = contributionsFrom(
    reading,
    'gracefulTimeout',
    config.byName.gracefulTimeout,
  );
  const notRead = contributions.find((c) => isUnresolved(c.value));
  if (notRead !== undefined && isUnresolved(notRead.value)) {
    return ceilingUnresolved(`the graceful timeout is not read: ${notRead.value.reason}`);
  }
  let explicit: SourcedValue | undefined;
  const sourcesUsed = new Set(contributions.map((c) => SOURCE_OF_ORIGIN[c.origin]));
  if (contributions.length > 0) {
    const value = resolved('gracefulTimeout');
    if (value === undefined || isUnresolved(value)) {
      return ceilingUnresolved(
        value === undefined ? 'the graceful timeout is not read' : value.reason,
      );
    }
    explicit = value;
  }
  const version = resolvePythonServerVersion('gunicorn', chain, args.intake);
  if (version.state === 'unresolved') {
    return ceilingUnresolved(version.reason, [version.declare, DECLARE_LONGEST_REQUEST]);
  }
  let uvicornKnown: Known | undefined;
  if (model === 'uvicorn') {
    const covered = uvicornWorkerCovered(args);
    if (!covered.ok)
      return ceilingUnresolved(covered.reason, [covered.declare, DECLARE_LONGEST_REQUEST]);
    uvicornKnown = covered.version;
  }
  const assumptions = versionAssumptions(version, uvicornKnown);
  const lookup = kb.lookup(
    explicit === undefined ? 'gunicorn-graceful-timeout' : 'gunicorn-graceful-timeout-explicit',
    version.interval,
    { workerClass: model },
  );
  if (lookup.matches.length === 0 || !lookup.covered) {
    return ceilingUnresolved(
      explicit === undefined
        ? `no measured graceful timeout for gunicorn ${describeInterval(version.interval)} with the ${model} worker`
        : `an explicit graceful timeout is not measured for the ${model} worker on gunicorn ${describeInterval(version.interval)}`,
    );
  }
  let matches = lookup.matches;
  if (explicit !== undefined) {
    // every place the value came from must be one the entries measured, for this worker class
    for (const source of sourcesUsed) {
      if (!matches.some((m) => m.entry.sources?.includes(source))) {
        return ceilingUnresolved(
          `an explicit graceful timeout from ${SOURCE_WORDS[source]} was not measured for the ${model} worker`,
        );
      }
    }
    matches = matches.filter((m) => [...sourcesUsed].some((x) => m.entry.sources?.includes(x)));
  }
  return ceilingFromMatches(matches, explicit, assumptions);
}

function ceilingFromMatches(
  matches: readonly { readonly entry: KbEntry }[],
  explicit: SourcedValue | undefined,
  assumptions: readonly Assumption[],
): ResolvedCeiling {
  let chosen: SourcedValue | undefined;
  for (const m of matches) {
    let value: SourcedValue | undefined;
    if (explicit === undefined) {
      if (!supportsPass(m.entry))
        return ceilingUnresolved('the graceful timeout default is not measured yet');
      value = sourcedValueFromEntry(m.entry);
    } else {
      const span = m.entry.measuredSpan;
      const n = explicit.value;
      if (span === undefined || typeof n !== 'number' || n < span.min || n > span.max) {
        return ceilingUnresolved(
          `the explicit graceful timeout is not the value that was measured (${span === undefined ? 'none' : `${span.min} s`})`,
        );
      }
      value = makeSourcedValue({
        value: n,
        unit: 's',
        source: defaultSource({
          citation: m.entry.citationName,
          ...(m.entry.rangeLabel === undefined ? {} : { range: m.entry.rangeLabel }),
          basisText: explicitBasisWords(m.entry),
          entryId: m.entry.id,
          bare: true,
        }),
        basis: 'measured-on',
      });
    }
    if (value === undefined) return ceilingUnresolved('the knowledge base entry holds no number');
    if (chosen !== undefined && chosen.value !== value.value) {
      return ceilingUnresolved(
        'the graceful timeout differs between the knowledge-base ranges that apply',
      );
    }
    chosen ??= value;
  }
  if (chosen === undefined) return ceilingUnresolved('no measured graceful timeout');
  return {
    state: 'known',
    value: chosen,
    ...(explicit === undefined ? {} : { setting: explicit }),
    assumptions,
  };
}

export const REASON_NO_UVICORN_CEILING =
  'no graceful-timeout ceiling is known for uvicorn without --timeout-graceful-shutdown';

/**
 * uvicorn alone has no ceiling by default (a request in flight at SIGTERM finishes however long it
 * takes, measured on 0.54.0); `--timeout-graceful-shutdown 5` on the command line gives 5 s, measured
 * at that value only. The environment form (`UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN`) was not measured and
 * is never used.
 */
function uvicornCeiling(reading: UvicornCommandReading, args: PythonResolveArgs): ResolvedCeiling {
  const contributions = reading.gracefulShutdown;
  const notRead = contributions.find((c) => isUnresolved(c.value));
  if (notRead !== undefined && isUnresolved(notRead.value)) {
    return ceilingUnresolved(`the graceful shutdown timeout is not read: ${notRead.value.reason}`);
  }
  if (contributions.length === 0) return ceilingUnresolved(REASON_NO_UVICORN_CEILING);
  const value = resolveSettingPrecedence('uvicorn', 'gracefulShutdown', contributions);
  if (value === undefined || isUnresolved(value)) {
    return ceilingUnresolved(
      value === undefined ? 'the graceful shutdown timeout is not read' : value.reason,
    );
  }
  const version = resolvePythonServerVersion('uvicorn', args.chain, args.intake);
  if (version.state === 'unresolved') {
    return ceilingUnresolved(version.reason, [version.declare, DECLARE_LONGEST_REQUEST]);
  }
  const lookup = args.kb.lookup('uvicorn-graceful-timeout-explicit', version.interval);
  if (lookup.matches.length === 0 || !lookup.covered) {
    return ceilingUnresolved(
      `an explicit graceful shutdown timeout is not measured on uvicorn ${describeInterval(version.interval)}`,
    );
  }
  return ceilingFromMatches(lookup.matches, value, versionAssumptions(undefined, version));
}

/** The linked Dockerfile's ENV, read only when `tripcurve.yaml` links the Dockerfile. */
function dockerEnvOf(chain: WorkloadChain): DockerEnv | undefined {
  const link = chain.dockerfile;
  if (link === undefined || link.state !== 'linked') return undefined;
  const file: InputFile = link.file;
  return readDockerfileEnv(file, DOCKERFILE_ENV_NAMES);
}

export function resolvePythonServer(
  family: 'gunicorn' | 'uvicorn',
  args: PythonResolveArgs,
): PythonResolveResult {
  const reading = readPythonCommand(args.container, dockerEnvOf(args.chain));
  if (reading === undefined || reading.program !== family) {
    return {
      ...noResolution(family, [problem('idle close', REASON_NO_COMMAND)], []),
      ceiling: ceilingUnresolved(REASON_NO_COMMAND),
    };
  }
  return reading.program === 'gunicorn'
    ? { ...resolveGunicorn(reading, args), ceiling: gunicornCeiling(reading, args) }
    : { ...resolveUvicorn(reading, args), ceiling: uvicornCeiling(reading, args) };
}
