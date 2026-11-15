// The shutdown chain's inputs (T2 and T3, bolt B4): the pod's
// grace period, the in-process drain a Node server's source shows, and the version of lightship that
// decides its default delay. The Resolver supplies values; the rules (evaluate/t2.ts, t3.ts) decide
// every verdict. Nothing is run and nothing is invented: a value that cannot be established is an
// unresolved value with a fixed reason and what to declare.
//
// Honesty here:
//   - the Kubernetes default grace period (30 s, documented) is used only when the pod spec sets
//     none, which the file itself shows; a value that is not a whole number is unresolved;
//   - a drain counts only as the source reader found it (the allow-list forms); a drain read with an
//     unresolved duration, or more than one drain (how they combine is not read), is unresolved;
//   - the lightship default (5000 ms under Kubernetes) needs the lightship RELEASE: an exact pin in
//     package.json or a lock file (the nearest folder that names the package, an unreadable form or a
//     skipped file is UNRESOLVED, an Assumption names the file), and a release the measurement
//     covers (9.1.0 and later 9.x). The Kubernetes detection is an assumption, listed.

import {
  type Assumption,
  type InputText,
  makeSourcedValue,
  makeUnresolved,
  SafeText,
  type SourcedValue,
} from '../core/index.js';
import {
  exactInterval,
  type KnowledgeBase,
  sourcedValueFromEntry,
  supportsPass,
  unknownInterval,
  type VersionInterval,
} from '../kb/index.js';
import type { SourceUnlinkedReason, WorkloadChain } from '../link/index.js';
import { foldersUp } from '../link/source-link.js';
import {
  type InputFile,
  type IntakeResult,
  isNodeLockFileName,
  type NodeDrain,
  type NodeServerSettings,
  rawInputTextForParser,
  readNodePackagePin,
  STDIN,
  uncheckedReasonWords,
} from '../parse/index.js';
import { SOURCE_REASON_TEXT } from './idle-close.js';
import type { InProcessDrain, ResolvedGrace, ServerFamily } from './model.js';
import { describeInterval } from './node-version.js';
import { DECLARE_DRAIN } from './shutdown-text.js';

export const KUBERNETES_DETECTION_ASSUMPTION: Assumption = {
  text: 'lightship detects Kubernetes at run time; assumed true because the workload is a Kubernetes manifest.',
  reason: 'the lightship default delay (5000 ms) applies only when lightship detects Kubernetes',
};

export const REASON_SOURCE_NOT_LINKED = 'source not linked; link it or declare a drain';
export const REASON_SEVERAL_DRAINS = 'more than one in-process drain: how they combine is not read';

// ---- the grace period -----------------------------------------------------------------------------------

/** `terminationGracePeriodSeconds`: the pod spec's value, else the knowledge base's documented default. */
export function resolveGrace(chain: WorkloadChain, kb: KnowledgeBase): ResolvedGrace {
  const written = chain.workload.gracePeriod;
  if (written !== undefined) return written;
  const lookup = kb.lookup('k8s-grace-period', unknownInterval());
  const [only] = lookup.matches;
  if (only === undefined || lookup.matches.length !== 1 || !lookup.covered) {
    return makeUnresolved('no knowledge-base default for the grace period');
  }
  return (
    sourcedValueFromEntry(only.entry) ?? makeUnresolved('the grace period default holds no number')
  );
}

// ---- the lightship release ------------------------------------------------------------------------------------

type LightshipVersion =
  | { readonly state: 'known'; readonly interval: VersionInterval; readonly assumption: Assumption }
  | { readonly state: 'unresolved'; readonly reason: string };

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

const PACKAGE_FILE_NAMES = new Set(['package.json']);
function isPackageFileName(name: string): boolean {
  return PACKAGE_FILE_NAMES.has(name) || isNodeLockFileName(name);
}

/**
 * The lightship release, from an exact pin in the nearest folder (from the entry file's folder up to
 * the root) with a file that names the package at all. A pin in `package.json` or a lock file counts;
 * a range alone does not; a form that is not read, a skipped file, or different pins are UNRESOLVED.
 */
export function resolveLightshipVersion(
  intake: IntakeResult,
  entryFile: InputText,
): LightshipVersion {
  const files = new Map<string, InputFile[]>();
  for (const f of intake.files) {
    if (f.class !== 'package-json' && f.class !== 'node-lock') continue;
    const dir = dirOf(rawInputTextForParser(f.canonicalPath));
    const list = files.get(dir);
    if (list === undefined) files.set(dir, [f]);
    else list.push(f);
  }
  const skipped = new Map<string, string>();
  for (const u of intake.unchecked) {
    if (u.path === STDIN) continue;
    const path = rawInputTextForParser(u.path);
    if (!isPackageFileName(path.slice(path.lastIndexOf('/') + 1))) continue;
    const dir = dirOf(path);
    if (!skipped.has(dir)) skipped.set(dir, uncheckedReasonWords(u.reasonCode));
  }
  for (const dir of foldersUp(dirOf(rawInputTextForParser(entryFile)))) {
    const here = (files.get(dir) ?? []).sort((a, b) =>
      rawInputTextForParser(a.canonicalPath) < rawInputTextForParser(b.canonicalPath) ? -1 : 1,
    );
    const skippedHere = skipped.get(dir);
    if (skippedHere !== undefined) {
      return { state: 'unresolved', reason: `a package file was skipped: ${skippedHere}` };
    }
    const readings = here.map((file) => ({ file, reading: readNodePackagePin(file, 'lightship') }));
    if (readings.every((r) => r.reading.state === 'none')) continue;
    if (readings.some((r) => r.reading.state === 'unreadable')) {
      return {
        state: 'unresolved',
        reason: 'a lightship version in the repository is not in a form tripcurve reads',
      };
    }
    if (readings.some((r) => r.reading.state === 'conflict')) {
      return { state: 'unresolved', reason: 'the repository pins different lightship versions' };
    }
    const versions = new Set<string>();
    let from: InputFile | undefined;
    for (const r of readings) {
      if (r.reading.state === 'pin') {
        versions.add(r.reading.version);
        from ??= r.file;
      }
    }
    const [only] = versions;
    if (only === undefined || from === undefined) {
      return {
        state: 'unresolved',
        reason: 'lightship is not pinned to an exact version in the files',
      };
    }
    if (versions.size > 1) {
      return { state: 'unresolved', reason: 'the repository pins different lightship versions' };
    }
    const [major, minor, patch] = only.split('.').map(Number) as [number, number, number];
    return {
      state: 'known',
      interval: exactInterval(major, minor, patch),
      assumption: {
        text: `The lightship version is taken from ${SafeText.render(from.canonicalPath, 'terminal')}.`,
        reason: 'lightship is pinned there, and tripcurve has no other source for its release',
      },
    };
  }
  return { state: 'unresolved', reason: 'no lightship version in the files' };
}

// ---- the in-process drain ---------------------------------------------------------------------------------------

const KIND_NOTE: Readonly<Record<NodeDrain['kind'], string>> = {
  lightship: 'lightship shutdownDelay',
  terminus: 'terminus beforeShutdown',
  'sigterm-handler': 'SIGTERM handler',
};

export interface DrainArgs {
  readonly family: ServerFamily;
  /** The Node source reading, when the source was linked and read. */
  readonly settings: NodeServerSettings | undefined;
  readonly entryFile: InputText | undefined;
  readonly chain: WorkloadChain;
  readonly intake: IntakeResult;
  readonly kb: KnowledgeBase;
}

function unresolvedDrain(
  reason: string,
  at?: NodeDrain['source'],
  kind?: NodeDrain['kind'],
): InProcessDrain {
  return {
    state: 'unresolved',
    reason,
    ...(kind === undefined ? {} : { kind }),
    ...(at === undefined ? {} : { at }),
    declare: [DECLARE_DRAIN],
  };
}

/** The lightship drain as a value in seconds, from the release's knowledge-base entry or the literal the file wrote. */
function lightshipDrain(d: NodeDrain, args: DrainArgs): InProcessDrain {
  if (args.entryFile === undefined)
    return unresolvedDrain('the lightship release is not known', d.source, 'lightship');
  const version = resolveLightshipVersion(args.intake, args.entryFile);
  if (version.state === 'unresolved') {
    return unresolvedDrain(version.reason, d.source, 'lightship');
  }
  const lookup = args.kb.lookup('lightship-shutdown-delay', version.interval);
  const [entry] = lookup.matches;
  if (entry === undefined || lookup.matches.length !== 1 || !lookup.covered) {
    return unresolvedDrain(
      `lightship ${describeInterval(version.interval)} is not covered by a measured default`,
      d.source,
      'lightship',
    );
  }
  if (!supportsPass(entry.entry)) {
    return unresolvedDrain(
      'the lightship shutdownDelay default is not measured yet',
      d.source,
      'lightship',
    );
  }
  if (d.delay.state === 'literal') {
    const ms = d.delay.value.value;
    if (typeof ms !== 'number')
      return unresolvedDrain('the drain has no duration', d.source, 'lightship');
    return {
      state: 'found',
      kind: 'lightship',
      value: makeSourcedValue({
        value: ms / 1000,
        unit: 's',
        source: d.delay.value.source,
        basis: 'declared',
      }),
      at: d.source,
      note: KIND_NOTE.lightship,
      assumptions: [version.assumption],
    };
  }
  const measured = sourcedValueFromEntry(entry.entry);
  if (measured === undefined || typeof measured.value !== 'number') {
    return unresolvedDrain('the lightship default holds no number', d.source, 'lightship');
  }
  return {
    state: 'found',
    kind: 'lightship',
    value: makeSourcedValue({
      value: measured.value / 1000,
      unit: 's',
      source: measured.source,
      basis: 'measured-on',
    }),
    at: d.source,
    note: 'lightship shutdownDelay default',
    assumptions: [version.assumption, KUBERNETES_DETECTION_ASSUMPTION],
  };
}

/** What the source shows for in-process drains: none, one of known duration, or unresolved. */
export function resolveInProcessDrain(args: DrainArgs): InProcessDrain {
  if (args.family !== 'node') return { state: 'none' };
  const { settings, chain } = args;
  if (settings === undefined) {
    const link = chain.sourceLink;
    const why =
      link.state === 'unlinked'
        ? SOURCE_REASON_TEXT[link.reasonCode as SourceUnlinkedReason]
        : 'source not linked';
    return { state: 'not-read', why };
  }
  const [only] = settings.drains;
  if (only === undefined) return { state: 'none', filesRead: settings.filesRead };
  if (settings.drains.length > 1) {
    return unresolvedDrain(REASON_SEVERAL_DRAINS, only.source);
  }
  if (only.delay.state === 'unresolved') {
    return unresolvedDrain(only.delay.value.reason, only.source, only.kind);
  }
  if (only.kind === 'lightship') return lightshipDrain(only, args);
  if (only.delay.state !== 'literal') {
    return unresolvedDrain('the drain has no duration', only.source, only.kind);
  }
  const ms = only.delay.value.value;
  if (typeof ms !== 'number')
    return unresolvedDrain('the drain has no duration', only.source, only.kind);
  return {
    state: 'found',
    kind: only.kind,
    value: makeSourcedValue({
      value: ms / 1000,
      unit: 's',
      source: only.delay.value.source,
      basis: 'declared',
    }),
    at: only.source,
    note: KIND_NOTE[only.kind],
    assumptions: [],
  };
}

/** The declared drain in seconds, as the config reader wrote it. */
export function declaredDrainOf(chain: WorkloadChain): SourcedValue | undefined {
  return chain.declarations.find((d) => d.key === 'drain.in_process_s')?.value;
}
