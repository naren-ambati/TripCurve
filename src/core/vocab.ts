// Fixed vocabularies that may print bare (interaction spec rule 1). Any
// other value prints quoted. A word read from a file is matched here by exact
// string; what comes out is tripcurve's own constant, never the input string,
// so a field the input controls cannot become a fact in tripcurve's voice.

/** Kubernetes workload kinds tripcurve checks (the bare Pod included). */
export const K8S_WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'] as const;
export type K8sWorkloadKind = (typeof K8S_WORKLOAD_KINDS)[number];

/** The kind word of a queue-consuming workload (WorkloadRef). */
export const EVENT_SOURCE_MAPPING = 'event source mapping' as const;

/** Every kind that may print bare, in the report's kind order (interaction spec rule 3). */
export const WORKLOAD_KINDS = [...K8S_WORKLOAD_KINDS, EVENT_SOURCE_MAPPING] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

/** ALB target types. */
export const TARGET_TYPES = ['ip', 'instance'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/**
 * gunicorn worker classes the knowledge base knows (
 * gthread, gevent, eventlet, tornado and the uvicorn worker keep connections
 * alive; sync does not).
 */
export const WORKER_CLASSES = [
  'sync',
  'gthread',
  'gevent',
  'eventlet',
  'tornado',
  'uvicorn',
] as const;
export type WorkerClass = (typeof WORKER_CLASSES)[number];

function fromList<T extends string>(list: readonly T[], text: string): T | undefined {
  // An own-property-free exact match; inherited names like "constructor" never match.
  return list.find((word) => word === text);
}

/** Exact match against the Kubernetes kinds; undefined for anything else. */
export function k8sWorkloadKindFromInput(text: string): K8sWorkloadKind | undefined {
  return fromList(K8S_WORKLOAD_KINDS, text);
}

export function workloadKindFromInput(text: string): WorkloadKind | undefined {
  return fromList(WORKLOAD_KINDS, text);
}

export function targetTypeFromInput(text: string): TargetType | undefined {
  return fromList(TARGET_TYPES, text);
}

export function workerClassFromInput(text: string): WorkerClass | undefined {
  return fromList(WORKER_CLASSES, text);
}

/** Rank of a kind in the report order; unknown kinds sort after the known ones. */
export function workloadKindRank(kind: WorkloadKind | undefined): number {
  return kind === undefined ? WORKLOAD_KINDS.length : WORKLOAD_KINDS.indexOf(kind);
}
