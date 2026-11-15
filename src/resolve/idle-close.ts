// The idle close of a Node server.
//
// The Resolver supplies candidates only: one per knowledge-base range the version interval
// overlaps, and one for every stretch no entry covers (node-ranges.ts). It establishes a candidate
// only when every input is established:
//   - the server is Node (gunicorn and uvicorn are resolved by python-server.ts), and the container it runs in is determined;
//   - the Node version is an interval (declaration, image tag, linked Dockerfile): exact, partial or unknown;
//   - the source is linked, and read completely. A setting found is an EXPLICIT setting: its effect
//     is the measured rule of the entry of its range (K + 1 s, ...), applied only where measured
//     (node-ranges.ts). "No setting found" is evidence that the default applies only when the search
//     was complete (`searchComplete`); an explicit setting needs the same complete search,
//     because code that was not read could change it;
//   - a range no entry covers is UNRESOLVED ("no knowledge-base entry covers <version>"), never the
//     nearest or the partial match.

import { type ChainStep, isUnresolved, makeUnresolved } from '../core/index.js';
import type { KnowledgeBase } from '../kb/index.js';
import type { SourceUnlinkedReason, WorkloadChain } from '../link/index.js';
import type { NodeSearchGap, NodeServerSettings, NodeSettingValue } from '../parse/index.js';
import type { IdleCloseResolution, ResolveProblem, ServerFamily } from './model.js';
import { planNodeRanges } from './node-ranges.js';
import { DECLARE_NODE_VERSION, type NodeVersionOutcome } from './node-version.js';

export const DECLARE_SOURCE =
  'link the entry file as source for this workload in tripcurve.yaml, or give the container a command of the form node <file>';
/**
 * What identifies the program of a container whose program is not identified (bolt B17). Neutral between server
 * kinds, because the image may be Python or anything else: the command or args name it (node, npm, gunicorn,
 * uvicorn); for Node, `runtime.node` also identifies it and `source` links its entry file. Fixed text.
 */
export const DECLARE_PROGRAM =
  'name the program in the container command or args (node, npm, gunicorn or uvicorn); for Node, tripcurve.yaml can instead declare runtime.node for this workload, with source for its entry file';
export const DECLARE_CONTAINER =
  'give exactly one container a containerPort that the Service targetPort names';
export const DECLARE_EXPLICIT =
  'no declaration settles this: pin the Node image to a version tripcurve has measured, or set the value in the source before listen within the measured span';
export const DECLARE_SEARCH =
  'link an entry file whose server construction (createServer or listen) is written in the files read';

export const REASON_NOT_NODE = 'the server is not identified as a Node program';
export const REASON_CONTAINER = 'the container the load balancer reaches is not determined';
export const REASON_NO_VERSION = 'no Node version is established for this workload';
export const DECLARE_UNATTRIBUTED =
  'write the setting as a plain statement on the server that listens, before listen, with no condition around it';
export const REASON_HTTPS = 'https server not measured';
export const DECLARE_HTTPS =
  'no declaration settles this: the idle close of an https server was not measured';
/** A setting the search could not tie to the one listening server. */
export function reasonUnattributed(name: string): string {
  return `a ${name} is written on an object tripcurve cannot tie to the listening server`;
}
export const REASON_NO_SITE =
  'no server construction (createServer or listen) was found in the files read, so no setting found does not show that the default applies';
export const REASON_BACKEND_PORT = 'the Ingress backend port is not a port of the Service';
/** One fixed reason for each way code outside what was read could set the timeouts. */
export const GAP_REASONS: Record<NodeSearchGap, string> = {
  'preload-not-read': 'code preloaded before the entry was not read',
  'node-options-not-read':
    'NODE_OPTIONS comes from a source that is not read, so code preloaded before the entry may not have been read',
  'createserver-args': 'the createServer arguments are not in a form tripcurve reads',
  'env-file-not-read': 'environment file not read',
  'npm-pre-script': 'an npm pre-script runs code before the server that was not read',
  'setting-form-not-read': 'a setting may be written in a form that is not read',
  'dynamic-load':
    'a require or import with a computed name loads code that was not read, so no setting found does not show that the default applies',
  'server-passed-out':
    'the server is passed to a function from a module that was not read, so no setting found does not show that the default applies',
  'framework-not-read': 'server framework not read',
};
export const REASON_SOURCE_NOT_PARSED = 'the source could not be parsed';
export const REASON_SOURCE_TOO_LARGE = 'source too large to read safely';
export const REASON_SOURCE_TOO_DEEP = 'the source is too deeply nested to read';
/** Why a linked source file could not be read, in tripcurve's own words (never the parser's message). */
function reasonForUnread(code: string): string {
  if (code === 'source-parse-error') return REASON_SOURCE_NOT_PARSED;
  if (code === 'source-too-large') return REASON_SOURCE_TOO_LARGE;
  return REASON_SOURCE_TOO_DEEP;
}
/** What to do about a source file that could not be read: the fix that fits, not "link an entry file". */
function hintForUnread(code: string): string {
  if (code === 'source-parse-error') {
    return 'fix the syntax error in the file named under "Files not checked", so that it can be read';
  }
  if (code === 'source-too-large') {
    return 'split the file named under "Files not checked" so that each part is smaller, or move the server construction into a smaller file';
  }
  return 'reduce the nesting in the file named under "Files not checked", so that it can be read';
}
export const REASON_UNREAD_FILES =
  'a file reached from the entry file could not be read, so no setting found does not show that the default applies';

export const SOURCE_REASON_TEXT: Record<SourceUnlinkedReason, string> = {
  'no-evidence': 'source not linked: no declared source, command file or npm script names it',
  'no-container': 'source not linked: the container is not determined',
  'no-command': 'source not linked: the container has no literal command',
  'not-a-node-command': 'source not linked: the container command does not run node',
  'command-names-no-file': 'source not linked: the node command names no file',
  'script-not-found': 'source not linked: the npm script was not found',
  'script-not-literal': 'source not linked: the npm script is not a plain node command',
  'absolute-path': 'source not linked: the command names a path inside the container',
  'outside-root': 'source not linked: the linked path lies outside the checked root',
  'symlink-loop': 'source not linked: the linked path is a symlink loop',
  unreadable: 'source not linked: the linked path could not be read',
  'not-read-as-source': 'source not linked: the linked file is not a source file that was read',
  'working-dir-not-mapped':
    'container working directory is not mapped to the repository; declare source: in tripcurve.yaml',
  'several-files-match':
    'more than one file matches the command; declare source: in tripcurve.yaml',
};

export interface IdleCloseArgs {
  readonly chain: WorkloadChain;
  readonly family: ServerFamily;
  readonly version: NodeVersionOutcome;
  readonly settings?: NodeServerSettings;
  readonly kb: KnowledgeBase;
}

export interface IdleCloseResult {
  readonly resolution: IdleCloseResolution;
  /** The knowledge-base ranges the version overlaps (labels), covered or not. */
  readonly versionRanges: readonly string[];
}

function none(
  problems: readonly ResolveProblem[],
  declare: readonly string[],
  evidence: readonly ChainStep[] = [],
  explicitSetting = false,
): IdleCloseResult {
  return {
    resolution: { candidates: [], problems, evidence, declare, explicitSetting },
    versionRanges: [],
  };
}

function problem(label: string, reason: string, hint?: string): ResolveProblem {
  return { label, value: makeUnresolved(reason, hint) };
}

function settingStep(name: string, value: NodeSettingValue): ChainStep {
  return { label: name, detail: 'set in the source', value };
}

export function resolveIdleClose(args: IdleCloseArgs): IdleCloseResult {
  const { chain, family, version, settings, kb } = args;

  if (family !== 'node') {
    const containerKnown = chain.container.state === 'determined';
    const badPort =
      chain.container.state === 'unresolved' &&
      chain.container.reasonCode === 'service-port-not-found';
    return none(
      [
        problem(
          'idle close',
          containerKnown ? REASON_NOT_NODE : badPort ? REASON_BACKEND_PORT : REASON_CONTAINER,
          containerKnown ? undefined : DECLARE_CONTAINER,
        ),
      ],
      containerKnown ? [DECLARE_PROGRAM] : [DECLARE_CONTAINER],
    );
  }

  const problems: ResolveProblem[] = [];
  const declare: string[] = [];
  const evidence: ChainStep[] = [];

  // 1. the version
  let known: Extract<NodeVersionOutcome, { state: 'known' }> | undefined;
  if (version.state === 'known') {
    known = version;
    evidence.push(version.resolution.step);
  } else if (version.state === 'unknown') {
    problems.push(version.problem);
    declare.push(...version.declare);
  } else {
    problems.push(problem('Node version', REASON_NO_VERSION, DECLARE_NODE_VERSION));
    declare.push(DECLARE_NODE_VERSION);
  }

  // 2. the source
  let explicit = false;
  const link = chain.sourceLink;
  if (link.state === 'unlinked') {
    problems.push(problem('source', SOURCE_REASON_TEXT[link.reasonCode], DECLARE_SOURCE));
    declare.push(DECLARE_SOURCE);
  } else if (settings !== undefined) {
    const keepAlive = settings.keepAliveTimeout;
    const buffer = settings.keepAliveTimeoutBuffer;
    const headers = settings.headersTimeout;
    for (const [name, value] of [
      ['keepAliveTimeout', keepAlive],
      ['keepAliveTimeoutBuffer', buffer],
      ['headersTimeout', headers],
    ] as const) {
      if (value !== undefined) evidence.push(settingStep(name, value));
    }
    explicit = keepAlive !== undefined || buffer !== undefined;
    // A setting that is not a literal number cannot be read: its reader reason is the reason.
    for (const [name, value] of [
      ['keepAliveTimeout', keepAlive],
      ['keepAliveTimeoutBuffer', buffer],
    ] as const) {
      if (value !== undefined && isUnresolved(value)) {
        problems.push({ label: name, value });
        if (!declare.includes(DECLARE_EXPLICIT)) declare.push(DECLARE_EXPLICIT);
      }
    }
    for (const name of ['keepAliveTimeout', 'keepAliveTimeoutBuffer', 'headersTimeout'] as const) {
      if (problems.length === 0 && settings.unattributed.includes(name)) {
        problems.push(problem('source', reasonUnattributed(name), DECLARE_UNATTRIBUTED));
        declare.push(DECLARE_UNATTRIBUTED);
      }
    }
    if (problems.length === 0 && settings.usesHttps) {
      problems.push(problem('source', REASON_HTTPS, DECLARE_HTTPS));
      declare.push(DECLARE_HTTPS);
    }
    if (problems.length === 0 && !settings.searchComplete) {
      const gap = settings.gaps[0];
      const unread = settings.unchecked[0];
      const reason =
        unread !== undefined
          ? reasonForUnread(unread.reasonCode)
          : gap !== undefined
            ? GAP_REASONS[gap]
            : settings.constructionSite === undefined
              ? REASON_NO_SITE
              : REASON_UNREAD_FILES;
      const hint = unread === undefined ? DECLARE_SEARCH : hintForUnread(unread.reasonCode);
      problems.push(problem('source', reason, hint));
      declare.push(hint);
    } else if (problems.length === 0 && !explicit) {
      const [first, ...rest] = settings.filesRead;
      if (first !== undefined) {
        const n = settings.filesRead.length;
        evidence.push({
          label: 'source',
          detail: `no setting found in ${n} ${n === 1 ? 'file' : 'files'} read`,
          value: first,
          ...(rest.length > 0 ? { more: rest } : {}),
        });
      }
    }
  }

  // 3. the knowledge base: one candidate per range of the interval, gaps included
  if (known === undefined) return none(problems, declare, evidence, explicit);
  const interval = known.resolution.interval;
  const versionRanges = kb
    .lookup('node-idle-close', interval)
    .matches.map((m) => m.entry.rangeLabel ?? m.entry.id);
  if (problems.length > 0) {
    return {
      resolution: { candidates: [], problems, evidence, declare, explicitSetting: explicit },
      versionRanges,
    };
  }
  const candidates = planNodeRanges({
    interval,
    versionLabel: known.resolution.label,
    kb,
    settings: {
      ...(settings?.keepAliveTimeout === undefined ? {} : { keepAlive: settings.keepAliveTimeout }),
      ...(settings?.keepAliveTimeoutBuffer === undefined
        ? {}
        : { buffer: settings.keepAliveTimeoutBuffer }),
      ...(settings?.headersTimeout === undefined ? {} : { headers: settings.headersTimeout }),
      notBeforeListen: settings?.notBeforeListen ?? [],
      optionsOnly: settings?.optionsOnly ?? [],
    },
  });
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined && isUnresolved(only.value)) {
    // One range and no number for it: the idle close is not established, and says why.
    problems.push({ label: 'idle close', value: only.value });
    declare.push(explicit ? DECLARE_EXPLICIT : DECLARE_NODE_VERSION);
    return {
      resolution: { candidates: [], problems, evidence, declare, explicitSetting: explicit },
      versionRanges,
    };
  }
  if (candidates.some((c) => isUnresolved(c.value))) declare.push(DECLARE_NODE_VERSION);
  return {
    resolution: { candidates, problems, evidence, declare, explicitSetting: explicit },
    versionRanges,
  };
}
