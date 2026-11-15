// The resolved model (ResolvedWorkload;, Resolver). The Resolver
// supplies values and candidates only; it produces no result kind. Rules read
// only this model. Any field that could not be established is an
// unresolved value with a fixed reason, never a default without a citation.
//
// Fields that only later bolts need are present as stubs where the contract
// names them, and are marked so.

import type {
  Assumption,
  ChainStep,
  InputText,
  QueueRef,
  SourcedValue,
  SourceRef,
  UnresolvedValue,
  WorkloadRef,
} from '../core/index.js';
import type { WorkerClass } from '../core/vocab.js';
import type { KbBasis, VersionInterval } from '../kb/index.js';
import type { LinkState, NotCheckedItem } from '../link/index.js';
import type { ConfigError, K8sPreStop, Maybe, UncheckedInput } from '../parse/index.js';

/**
 * One range of the version interval an idle close could come from (Candidate). A range
 * no entry covers, or one whose rule cannot be applied, is still a candidate: its `value` is
 * unresolved with the fixed reason, so the VERSION-DEPENDENT result lists it and never drops it.
 */
export interface Candidate {
  /** The range the entry covers, for example `Node 22.x from 22.19`, or `before 18.20.8` for a gap (tripcurve text). */
  readonly condition: string;
  /** The idle close, a sourced value with a `default` source, or unresolved with its reason. */
  readonly value: SourcedValue | UnresolvedValue;
  /** The basis of the entry; absent when the value is unresolved. */
  readonly basis?: KbBasis;
  /** False for an unresolved range and for a `to be measured` entry: neither supports PASS. */
  readonly supportsPass: boolean;
  /**
   * The setting a value computed from the source rests on (the explicit `keepAliveTimeout`): the
   * deciding source a PASS or N/A line cites, while `value` keeps the rule and its basis.
   */
  readonly decidedBy?: SourceRef;
  /** tripcurve text printed after the deciding source of a PASS line, for example `keepAliveTimeout 65 s + 1 s buffer (...)`. */
  readonly note?: string;
}

/** Why a value was not established: a fixed reason, and what the user can declare. */
export interface ResolveProblem {
  readonly label: string;
  readonly value: UnresolvedValue;
}

export const SERVER_FAMILIES = ['gunicorn', 'uvicorn', 'node', 'unknown'] as const;
export type ServerFamily = (typeof SERVER_FAMILIES)[number];

export interface ResolvedServer {
  readonly family: ServerFamily;
  /**
   * The resolved gunicorn worker model (B2). Absent when the server is not gunicorn, and when
   * the model could not be established (then `idleClose.problems` says why).
   */
  readonly workerModel?: {
    readonly model: WorkerClass;
    readonly reason: string;
    /** The flag, config line or env value that decided it; for a default, the command. */
    readonly source: SourceRef;
    /** True when no setting names the class: the worker is the gunicorn default (`no -k given`). */
    readonly fromDefault?: boolean;
  };
}

export interface NodeVersionResolution {
  /** `22.23.2`, `22.23` or `22`: digits and dots only, written by tripcurve from the parsed version. */
  readonly label: string;
  readonly interval: VersionInterval;
  /** The step printed in the chain: the version with the text that gave it. */
  readonly step: ChainStep;
}

/**
 * What the idle close of this workload's server is. `candidates` is non-empty
 * only when every input is established; otherwise `problems` says what was not,
 * and `candidates` is empty. `evidence` is the chain the rule prints with it.
 */
export interface IdleCloseResolution {
  readonly candidates: readonly Candidate[];
  readonly problems: readonly ResolveProblem[];
  readonly evidence: readonly ChainStep[];
  /** What to declare so the idle close can be established; tripcurve text. */
  readonly declare: readonly string[];
  /**
   * True when a setting for the idle close is written in source (an explicit
   * `keepAliveTimeout` or `keepAliveTimeoutBuffer`). Its effect on Node 22.19 and
   * later is not measured, so the idle close is not established.
   */
  readonly explicitSetting: boolean;
}

export interface ResolvedLb {
  /** `several`: more than one load balancer reaches the workload, so no one idle timeout applies. */
  readonly kind: 'alb' | 'nlb' | 'several';
  /**
   * The idle timeout in the files or a declaration, or the documented default as
   * an ASSUMED value (basis `assumed`), or unresolved with a fixed reason.
   */
  readonly lbIdle: SourcedValue | UnresolvedValue;
  /** The chain steps that show where the idle timeout came from (both, when they differ). */
  readonly lbIdleSteps: readonly ChainStep[];
  readonly declare: readonly string[];
  /** `target-type` of the Ingress (a fixed word or unresolved); read for T2 in a later bolt. */
  readonly targetType?: Maybe;
  /**
   * Set when the idle value is not established by the files: `default` (nothing sets it, the documented
   * default is ASSUMED) or `terraform-name` (the value is read from a Terraform `aws_lb` that is linked
   * only by the Ingress `load-balancer-name` annotation, an ASSUMPTION). T1 never passes or fails on it.
   */
  readonly assumedFrom?: 'default' | 'terraform-name';
}

/**
 * The longest a request still running at SIGTERM is waited for (the server's graceful timeout, a
 * CEILING): known from a measured knowledge-base entry (a default, or an explicit value in
 * the span that was measured), or unresolved with a fixed reason and what to declare.
 */
export type ResolvedCeiling =
  | {
      readonly state: 'known';
      /** The ceiling in seconds, with the entry that measured it as its source. */
      readonly value: SourcedValue;
      /** For an explicit setting: the value as the file wrote it (its own source), shown beside the rule. */
      readonly setting?: SourcedValue;
      /** The assumptions using this ceiling relies on (the server versions are taken from files). */
      readonly assumptions: readonly Assumption[];
    }
  | {
      readonly state: 'unresolved';
      readonly reason: string;
      readonly declare: readonly string[];
    };

/** The pod's grace period: the pod spec's value, the knowledge base's documented default, or unresolved. */
export type ResolvedGrace = SourcedValue | UnresolvedValue;

/**
 * What the in-process search of the workload found:
 * `none`: every place that was read shows no drain; `found`: exactly one drain of known duration;
 * `unresolved`: a drain exists (or may) whose duration is not known, with the reason and what to declare;
 * `not-read`: the source was not read at all (Node source not linked), so nothing is known.
 */
export type InProcessDrain =
  | {
      readonly state: 'none';
      /** Node: the source files that were searched, for the `drain none` line. Absent for a server whose source is not read for drains. */
      readonly filesRead?: readonly InputText[];
    }
  | {
      readonly state: 'found';
      readonly kind: 'lightship' | 'terminus' | 'sigterm-handler';
      /** Seconds. For the lightship default: the knowledge base's measured value, cited. */
      readonly value: SourcedValue;
      /** The call or handler that makes it (the deciding source of a T2 PASS). */
      readonly at: SourceRef;
      /** tripcurve text after the deciding source, for example `lightship shutdownDelay default`. */
      readonly note: string;
      /** The assumptions a verdict that uses this drain relies on. */
      readonly assumptions: readonly Assumption[];
    }
  | {
      readonly state: 'unresolved';
      readonly reason: string;
      /** Which source the unknown duration is in; absent when more than one drain was read. */
      readonly kind?: 'lightship' | 'terminus' | 'sigterm-handler';
      readonly at?: SourceRef;
      readonly declare: readonly string[];
    }
  | {
      readonly state: 'not-read';
      /** Why the Node source was not linked (fixed wording of the link). */
      readonly why: string;
    };

export interface ResolvedWorkload {
  readonly workload: WorkloadRef;
  readonly file: SourceRef;
  /** The Helm `# Source:` comment text of the workload's document (standard input), quoted input only. */
  readonly helmSource?: InputText;
  readonly linkState: LinkState;
  /** Fixed wording for the link state when it is not `linked`; tripcurve text. */
  readonly linkProblem?: string;
  readonly behindLb: ResolvedLb;
  readonly server: ResolvedServer;
  readonly nodeVersion?: NodeVersionResolution;
  readonly idleCloseCandidates: readonly Candidate[];
  readonly idleClose: IdleCloseResolution;
  /** One label per knowledge-base range the version interval still overlaps. */
  readonly versionRanges: readonly string[];
  /** `drainSearchComplete`: the Node source was linked and read, or the server is not Node. */
  readonly drainSearchComplete: boolean;
  /** Why the drain search is not complete (tripcurve text); absent when it is. */
  readonly drainSearchReason?: string;
  readonly assumptions: readonly Assumption[];

  /** `terminationGracePeriodSeconds` as the pod spec writes it (absent when the file sets none; `grace` has the default then). */
  readonly gracePeriod?: Maybe;
  /** The grace period T3 checks: the pod spec's value, else the knowledge base's documented default. */
  readonly grace: ResolvedGrace;
  /** The determined container's preStop hook, as read. Absent: the container has none. */
  readonly preStop?: K8sPreStop;
  /** `longest_request_s` declared for this workload (never global). */
  readonly longestRequest?: SourcedValue;
  /** `drain.in_process_s` declared for this workload, in seconds. */
  readonly declaredDrain?: SourcedValue;
  /** What the in-process search found (see `InProcessDrain`). */
  readonly inProcessDrain: InProcessDrain;
  /** The graceful-timeout ceiling of the server, or why there is none known. */
  readonly ceiling: ResolvedCeiling;

  /** Stub for B2: a gunicorn.conf.py that nothing names. */
  readonly unlinkedServerConfig?: { readonly file: SourceRef };
}

/** One T4 input: a value and the chain step the rule prints for it (bolt B5). */
export interface QueueInput {
  readonly value: SourcedValue | UnresolvedValue;
  readonly step: ChainStep;
  /** What to declare or change so the value can be established; tripcurve text. */
  readonly declare: readonly string[];
}

/** An event source mapping and the three values T4 compares (QueueWorkload). */
export interface ResolvedQueueWorkload {
  readonly queue: QueueRef;
  /** Where the mapping resource is written. */
  readonly file: SourceRef;
  readonly visibility: QueueInput;
  readonly functionTimeout: QueueInput;
  readonly batchingWindow: QueueInput;
  /** The batching window is the assumed 0 s (the attribute is not set): no PASS or FAIL rests on it. */
  readonly batchingAssumed: boolean;
  readonly assumptions: readonly Assumption[];
}

export interface ResolvedModel {
  readonly workloads: readonly ResolvedWorkload[];
  /** Terraform event source mappings (bolt B5), one per `aws_lambda_event_source_mapping` read. */
  readonly queueWorkloads: readonly ResolvedQueueWorkload[];
  readonly notChecked: readonly NotCheckedItem[];
  readonly configErrors: readonly ConfigError[];
  /**
   * Linked source files that could not be read (a syntax error, over the size bound, too deeply nested), each
   * once: the report lists them under "Files not checked", so the run is never clean.
   */
  readonly unreadSources: readonly UncheckedInput[];
  /** Every assumption actually used, each once. */
  readonly assumptions: readonly Assumption[];
}
