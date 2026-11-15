// The Node models. NodeServerSettings is what the source
// reader found for one entry file; RuntimeVersionHint is one piece of version
// evidence. Nothing here chooses between two pieces of evidence: the order and
// the narrowing rule belong to the resolver.

import type { InputText, SourcedValue, SourceRef, UnresolvedValue } from '../../core/index.js';
import type { VersionInterval } from '../../kb/index.js';
import type { UncheckedInput } from '../intake/index.js';
import type { ReaderUnresolved } from '../reader-result.js';

export const NODE_SETTING_NAMES = [
  'keepAliveTimeout',
  'keepAliveTimeoutBuffer',
  'headersTimeout',
  'requestTimeout',
] as const;
export type NodeSettingName = (typeof NODE_SETTING_NAMES)[number];

/** A setting read as a number of milliseconds (unit `ms`), or unresolved with its fixed reason. */
export type NodeSettingValue = SourcedValue | UnresolvedValue;

/**
 * Why a search for the settings cannot be called complete even though every
 * file reached was read: code that could set them lies outside what was read.
 * Fixed codes; the resolver turns each into one fixed reason.
 */
export const NODE_SEARCH_GAPS = [
  /** A `-r`, `--require`, `--import`, `--loader` or eval flag whose code was not read. */
  'preload-not-read',
  /** An argument of `createServer` is not in a form tripcurve reads (see `FileWalk.createServerArgs`). */
  'createserver-args',
  /** `--env-file` or `--env-file-if-exists`: variables, `NODE_OPTIONS` among them, come from a file not read. */
  'env-file-not-read',
  /** The npm script run has a `pre<script>` entry: code runs before the server that was not read. */
  'npm-pre-script',
  /** A setting may be written in a form that is not read (`Reflect.set`, `eval`, a computed key, ...). */
  'setting-form-not-read',
  /** `NODE_OPTIONS` comes from `valueFrom` or an `envFrom` that is not read. */
  'node-options-not-read',
  /** `require(...)` or `import(...)` with an argument that is not a literal. */
  'dynamic-load',
  /** The server value is passed to a function from a module that is not read. */
  'server-passed-out',
  /** A `.listen(...)` on something that is not an http or https server or an Express app. */
  'framework-not-read',
] as const;
export type NodeSearchGap = (typeof NODE_SEARCH_GAPS)[number];

/**
 * Why the search for a DRAIN is incomplete although the search for the timeouts may not be (B4 review
 * M3): a shutdown library is imported whose drain is not read, or a package is imported only for its
 * side effects (which may include signal handlers), or the server is handed to a function that is not
 * `createTerminus` (a read form) from a module that was not read. These never affect T1.
 */
export const NODE_DRAIN_GAPS = [
  'shutdown-library',
  'side-effect-import',
  'package-imported',
  'server-passed-out',
] as const;
export type NodeDrainGap = (typeof NODE_DRAIN_GAPS)[number];

/**
 * Code Node runs before the entry file: local files to read like imports (each
 * relative to `base`, a folder under the root), and the gaps for everything else.
 */
export interface NodePreloads {
  readonly files: readonly { readonly base: InputText; readonly specifier: InputText }[];
  readonly gaps: readonly NodeSearchGap[];
}

export const NODE_DRAIN_KINDS = ['lightship', 'terminus', 'sigterm-handler'] as const;
/** Where an in-process drain comes from: lightship's `shutdownDelay`, terminus's `beforeShutdown`, a SIGTERM handler. */
export type NodeDrainKind = (typeof NODE_DRAIN_KINDS)[number];

/**
 * How long a drain delays the server. Read only from forms tripcurve fully reads (the allow-list):
 * `literal` is a number written in the code (unit `ms`, from the file); `lightship-default` is a
 * `createLightship` call with no `shutdownDelay`, whose delay is the knowledge base's default for
 * the lightship release; everything else is `unresolved` with a fixed reason and what to declare.
 */
export type NodeDrainDelay =
  | { readonly state: 'literal'; readonly value: SourcedValue }
  | { readonly state: 'lightship-default' }
  | { readonly state: 'unresolved'; readonly value: UnresolvedValue };

/** One in-process drain: a delay before the server stops that the source shows (or cannot be read). */
export interface NodeDrain {
  readonly kind: NodeDrainKind;
  /** The call or handler registration that makes the drain. */
  readonly source: SourceRef;
  readonly delay: NodeDrainDelay;
}

/** What one source file shows. */
export interface NodeFileReading {
  readonly file: InputText;
  /** Every place a setting is written, in source order; the same setting can appear more than once. */
  readonly settings: readonly {
    readonly name: NodeSettingName;
    readonly value: NodeSettingValue;
    readonly source: SourceRef;
  }[];
  /**
   * Names of settings written where they are not shown to run before the server listens (after
   * `listen`, in another function or callback, or in a file with no `listen`). A setting set by an
   * options literal is always before; so is an assignment in the same function body as every
   * `listen` of the file and written before them.
   */
  readonly notBeforeListen: readonly NodeSettingName[];
  /** Names of settings written on an object not tied to the one listening server of this file (or in a file with none). */
  readonly unattributed: readonly NodeSettingName[];
  /** The number of distinct servers this file listens on; 2 when that cannot be told. */
  readonly listenServers: number;
  /** Names with at least one assignment (or Object.assign) / at least one `createServer` options write in this file. */
  readonly assignedNames: readonly NodeSettingName[];
  readonly optionNames: readonly NodeSettingName[];
  /** A `createServer` of `https` is read in this file. */
  readonly usesHttps: boolean;
  /** The first server construction site (`createServer(...)` or a `.listen(...)` call). */
  readonly constructionSite?: SourceRef;
  /** Relative module specifiers (`./x`, `../y`) with the line they are written on. */
  readonly imports: readonly { readonly specifier: InputText; readonly line: number }[];
  /** Local imports used as the request handler of `createServer`; each must be an Express app in the file it names. */
  readonly handlerImports: readonly {
    readonly specifier: string;
    readonly member: string;
    readonly line: number;
  }[];
  /** Names this file exports that trace to an `express()` call (`default`, `module.exports`, or a name). */
  readonly exportedApps: readonly string[];
  /** Gaps this file shows (`dynamic-load`, `server-passed-out`, `framework-not-read`). */
  readonly gaps: readonly NodeSearchGap[];
  /** Why the drain search of this file is incomplete (see `NODE_DRAIN_GAPS`). */
  readonly drainGaps: readonly NodeDrainGap[];
  /** In-process drains this file shows, each tied to the process or the listening server on a path that is fully read. */
  readonly drains: readonly NodeDrain[];
  /** Set when the file could not be read as source (`parse-error` or `over-depth`); nothing else is then trusted. */
  readonly unchecked?: UncheckedInput;
}

/**
 * What the source reader found for one entry file and the local files it
 * reaches. A setting is present only when some file writes it.
 */
export interface NodeServerSettings {
  readonly entryFile: InputText;
  readonly keepAliveTimeout?: NodeSettingValue;
  readonly keepAliveTimeoutBuffer?: NodeSettingValue;
  readonly headersTimeout?: NodeSettingValue;
  readonly requestTimeout?: NodeSettingValue;
  /** The first server construction site found; absent when none was. */
  readonly constructionSite?: SourceRef;
  /** Settings written where they may run after `listen`, summed over every file read (see `NodeFileReading`). */
  readonly notBeforeListen: readonly NodeSettingName[];
  /** Settings written on an object that cannot be tied to the one listening server (see `NodeFileReading`), over every file read. */
  readonly unattributed: readonly NodeSettingName[];
  /** Settings written only in `createServer` options, never by assignment, over every file read. */
  readonly optionsOnly: readonly NodeSettingName[];
  /** An `https` server is created in the files read: its idle close was not measured. */
  readonly usesHttps: boolean;
  /** The local files followed from the entry file (canonical paths), the entry file not included. */
  readonly imports: readonly InputText[];
  /** Every file read, the entry file first: "no setting found in N files read" lists these. */
  readonly filesRead: readonly InputText[];
  /** Files that were reached but could not be read as source. */
  readonly unchecked: readonly UncheckedInput[];
  /** Relative imports that named no file in the input (so the search is not complete). */
  readonly unreadImports: readonly InputText[];
  /** Why the search is incomplete although every file reached was read; empty when it is not. */
  readonly gaps: readonly NodeSearchGap[];
  /**
   * Every in-process drain found in the files read (lightship, terminus `beforeShutdown`, a SIGTERM
   * handler), zero-delay ones included. A drain read with a zero delay still counts as a source: how
   * two drains combine is not read, so more than one is UNRESOLVED (the resolver).
   */
  readonly drains: readonly NodeDrain[];
  /** Why the search for a drain is incomplete (see `NODE_DRAIN_GAPS`); empty when it is not. */
  readonly drainGaps: readonly NodeDrainGap[];
  /**
   * True when the whole search is established: a construction site was found,
   * every file reached was read, every local import was followed, and no code
   * outside what was read could set the timeouts (`gaps` is empty). Only
   * then is "no setting found" evidence that the Node default applies;
   * otherwise an absent setting is unresolved.
   */
  readonly searchComplete: boolean;
  readonly unresolved: readonly ReaderUnresolved[];
}

export const VERSION_SOURCE_KINDS = [
  'declaration',
  'image-tag',
  'linked-dockerfile',
  'engines',
] as const;
export type VersionSourceKind = (typeof VERSION_SOURCE_KINDS)[number];

/**
 * One piece of version evidence. `interval` is absent when the evidence does
 * not name a version tripcurve can read (then `unknownReason` is tripcurve's
 * fixed wording). `text` is what the input wrote, to be quoted.
 */
export interface RuntimeVersionHint {
  readonly runtime: 'node';
  readonly sourceKind: VersionSourceKind;
  readonly interval?: VersionInterval;
  readonly unknownReason?: string;
  readonly text?: InputText;
  readonly sourceRef: SourceRef;
}
