// Resolver: turns the config graph into one ResolvedWorkload per workload
// chain. It resolves values and candidates and produces no result kind.
// A pure function of the graph, the intake result (for reading linked source) and
// the knowledge base: nothing is executed and nothing is invented.

import { type Assumption, type InputText, SafeText } from '../core/index.js';
import { defaultKnowledgeBase, type KnowledgeBase } from '../kb/index.js';
import {
  basenameOf,
  type ConfigGraph,
  literalArgv,
  nearestPackageJson,
  type WorkloadChain,
} from '../link/index.js';
import {
  type IacReadResult,
  type IntakeResult,
  type NodePreloads,
  type NodeServerSettings,
  pythonServerProgram,
  rawInputTextForParser,
  readNodeServer,
  type UncheckedInput,
} from '../parse/index.js';
import { resolveIdleClose, SOURCE_REASON_TEXT } from './idle-close.js';
import { resolveLbIdle } from './lb-idle.js';
import type {
  ResolvedCeiling,
  ResolvedModel,
  ResolvedServer,
  ResolvedWorkload,
  ServerFamily,
} from './model.js';
import { type NodeVersionOutcome, resolveNodeVersion } from './node-version.js';
import { resolvePythonServer } from './python-server.js';
import { resolveQueueWorkloads } from './queue.js';
import { declaredDrainOf, resolveGrace, resolveInProcessDrain } from './shutdown.js';
import { DECLARE_LONGEST_REQUEST } from './shutdown-text.js';

export interface ResolveInput {
  readonly graph: ConfigGraph;
  readonly intake: IntakeResult;
  readonly iac: IacReadResult;
  readonly kb?: KnowledgeBase;
}

function preloadKey(preloads: NodePreloads | undefined): string {
  if (preloads === undefined) return '';
  const files = preloads.files.map(
    (f) => `${rawInputTextForParser(f.base)}\u0001${rawInputTextForParser(f.specifier)}`,
  );
  return `${files.join('\u0002')}\u0003${preloads.gaps.join(',')}`;
}

export const REASON_DRAIN_SEARCH_NODE =
  'the source search is not complete, so a drain in code that was not read cannot be ruled out';
export const REASON_DRAIN_SEARCH_UNKNOWN =
  'the server is not recognised, so the search for a drain is not complete';

export const REASON_SHUTDOWN_LIBRARY =
  'a shutdown library is imported whose drain tripcurve does not read';
export const REASON_PACKAGE_IMPORTED =
  'a package is imported whose code may register shutdown handlers; declare drain.in_process_s or add a preStop';
export const REASON_SIDE_EFFECT_IMPORT =
  'a package is imported only for its side effects, which may include signal handlers';

function drainGapReason(settings: NodeServerSettings | undefined): string {
  const gaps = settings?.drainGaps ?? [];
  if (gaps.includes('shutdown-library')) return REASON_SHUTDOWN_LIBRARY;
  if (gaps.includes('side-effect-import')) return REASON_SIDE_EFFECT_IMPORT;
  if (gaps.includes('package-imported')) return REASON_PACKAGE_IMPORTED;
  return REASON_DRAIN_SEARCH_NODE;
}

const NODE_PROGRAMS = new Set(['node', 'nodejs', 'npm', 'npx', 'yarn', 'pnpm']);

function familyFromArgv(words: readonly string[] | undefined): ServerFamily | undefined {
  const first = words?.[0];
  if (first === undefined) return undefined;
  if (NODE_PROGRAMS.has(basenameOf(first))) return 'node';
  return pythonServerProgram(words)?.program;
}

const CONTAINER_TEXT = {
  'no-container-matches': 'no container declares the port the Service targets',
  'several-containers-match': 'more than one container declares the port the Service targets',
  'port-not-readable': 'a port of the Ingress backend or the Service could not be read',
  'backend-port-not-named': 'the Ingress backend names no Service port',
  'service-port-not-found': 'the Ingress backend port is not a port of the Service',
} as const;

function linkProblemOf(
  chain: WorkloadChain,
  state: ResolvedWorkload['linkState'],
): string | undefined {
  switch (state) {
    case 'linked':
      return undefined;
    case 'unresolved-more-than-one-match':
      return chain.workload.duplicate
        ? 'unresolved: more than one match: another object has the same kind, namespace and name'
        : 'unresolved: more than one match: an Ingress or Service of the same name was read more than once';
    case 'unresolved-container-not-determined':
      return chain.container.state === 'unresolved'
        ? `unresolved: ${CONTAINER_TEXT[chain.container.reasonCode]}`
        : 'unresolved: the container is not determined';
    case 'unresolved-source-not-linked':
      return chain.sourceLink.state === 'unlinked'
        ? `unresolved: ${SOURCE_REASON_TEXT[chain.sourceLink.reasonCode]}`
        : undefined;
  }
}

function stateOf(chain: WorkloadChain, family: ServerFamily): ResolvedWorkload['linkState'] {
  if (chain.ambiguous) return 'unresolved-more-than-one-match';
  if (chain.container.state !== 'determined') return 'unresolved-container-not-determined';
  if (family === 'node' && chain.sourceLink.state === 'unlinked') {
    return 'unresolved-source-not-linked';
  }
  return 'linked';
}

/** Every source file the Node reader could not read, once each, in the order the files were first read. */
function unreadSourcesOf(reads: ReadonlyMap<string, NodeServerSettings>): UncheckedInput[] {
  const seen = new Set<string>();
  const out: UncheckedInput[] = [];
  for (const settings of reads.values()) {
    for (const u of settings.unchecked) {
      const key = rawInputTextForParser(u.path as InputText);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

export function resolveWorkloads(input: ResolveInput): ResolvedModel {
  const kb = input.kb ?? defaultKnowledgeBase();
  const readCache = new Map<string, NodeServerSettings>();
  const workloads: ResolvedWorkload[] = [];
  const all = new Map<string, Assumption>();

  for (const chain of input.graph.workloadChains) {
    const container =
      chain.container.state === 'determined' ? chain.container.container : undefined;
    const link = chain.sourceLink;
    const entryFile = link.state === 'linked' ? link.entry : undefined;
    const enginesFile =
      entryFile === undefined
        ? undefined
        : nearestPackageJson(input.intake, entryFile.canonicalPath);
    const version: NodeVersionOutcome = resolveNodeVersion({
      declarations: chain.declarations,
      ...(container === undefined ? {} : { container }),
      ...(chain.dockerfile?.state === 'linked' ? { dockerfile: chain.dockerfile.file } : {}),
      ...(enginesFile === undefined ? {} : { enginesFile }),
    });
    const family: ServerFamily =
      familyFromArgv(container === undefined ? undefined : literalArgv(container)) ??
      (version.state !== 'no-evidence' ? 'node' : 'unknown');

    let settings: NodeServerSettings | undefined;
    if (family === 'node' && entryFile !== undefined) {
      const preloads = link.state === 'linked' ? link.preloads : undefined;
      // The same entry file read with different preloads is a different search.
      const key = `${rawInputTextForParser(entryFile.canonicalPath)}\u0000${preloadKey(preloads)}`;
      settings = readCache.get(key);
      if (settings === undefined) {
        settings = readNodeServer(
          input.intake,
          entryFile,
          preloads === undefined ? {} : { preloads },
        );
        readCache.set(key, settings);
      }
    }

    const python =
      (family === 'gunicorn' || family === 'uvicorn') && container !== undefined
        ? resolvePythonServer(family, { chain, container, intake: input.intake, kb })
        : undefined;
    const idle =
      python !== undefined
        ? { resolution: python.resolution, versionRanges: python.versionRanges }
        : resolveIdleClose({
            chain,
            family,
            version,
            ...(settings === undefined ? {} : { settings }),
            kb,
          });
    const lb = resolveLbIdle(chain, kb);
    const state = stateOf(chain, family);
    const problem = linkProblemOf(chain, state);

    const assumptions: Assumption[] = [...lb.assumptions, ...(python?.assumptions ?? [])];
    if (link.state === 'linked' && link.by === 'npm-script') {
      assumptions.push({
        text: 'Source was linked through an npm script of the package.json nearest to the manifest, because the container working directory is not read.',
        reason: 'the container command is an npm script',
      });
    }
    if (link.state === 'linked' && link.assumedWorkingDir !== undefined) {
      // The folder is the input's own text: quoted through SafeText, never in our voice.
      assumptions.push({
        text: `The container's working directory is taken to be ${SafeText.render(link.assumedWorkingDir, 'terminal')}.`,
        reason:
          'the command names a relative file, and the working directory of the container is not read',
      });
    }
    for (const a of assumptions) if (!all.has(a.text)) all.set(a.text, a);

    const server: ResolvedServer = python?.server ?? { family };
    const drainSearchComplete =
      family === 'gunicorn' || family === 'uvicorn'
        ? true
        : family === 'node' &&
          settings !== undefined &&
          settings.unchecked.length === 0 &&
          settings.unreadImports.length === 0 &&
          // a server handed to createTerminus is read as a drain (drainGaps says if it went anywhere else)
          settings.gaps.every((g) => g === 'server-passed-out') &&
          settings.drainGaps.length === 0;
    const drainSearchReason = drainSearchComplete
      ? undefined
      : family === 'node'
        ? drainGapReason(settings)
        : REASON_DRAIN_SEARCH_UNKNOWN;

    const longest = chain.declarations.find((d) => d.key === 'longest_request_s');
    const drain = declaredDrainOf(chain);
    const ceiling: ResolvedCeiling =
      python !== undefined
        ? python.ceiling
        : {
            state: 'unresolved',
            reason:
              family === 'node'
                ? 'no graceful-timeout ceiling known for a Node server'
                : 'the server is not recognised, so no graceful-timeout ceiling is known',
            declare: [DECLARE_LONGEST_REQUEST],
          };
    workloads.push({
      workload: chain.ref,
      file: chain.workload.source,
      ...(chain.workload.helmSource === undefined ? {} : { helmSource: chain.workload.helmSource }),
      linkState: state,
      ...(problem === undefined ? {} : { linkProblem: problem }),
      behindLb: lb.lb,
      server,
      ...(version.state === 'known' ? { nodeVersion: version.resolution } : {}),
      idleCloseCandidates: idle.resolution.candidates,
      idleClose: idle.resolution,
      versionRanges: idle.versionRanges,
      drainSearchComplete,
      ...(drainSearchReason === undefined ? {} : { drainSearchReason }),
      assumptions,
      ...(chain.workload.gracePeriod === undefined
        ? {}
        : { gracePeriod: chain.workload.gracePeriod }),
      ...(container?.preStop === undefined ? {} : { preStop: container.preStop }),
      grace: resolveGrace(chain, kb),
      ...(longest === undefined ? {} : { longestRequest: longest.value }),
      ...(drain === undefined ? {} : { declaredDrain: drain }),
      inProcessDrain: resolveInProcessDrain({
        family,
        settings,
        entryFile: entryFile?.canonicalPath,
        chain,
        intake: input.intake,
        kb,
      }),
      ceiling,
    });
  }

  // A queue workload's assumption (the batching window) is listed by the findings that use it (T4 attaches it,
  // bolt B17), so a FAIL that does not rest on the window does not list it.
  const queueWorkloads = resolveQueueWorkloads(input.iac, kb);

  return {
    workloads,
    queueWorkloads,
    notChecked: input.graph.notChecked,
    configErrors: input.graph.configErrors,
    unreadSources: unreadSourcesOf(readCache),
    assumptions: [...all.values()],
  };
}
