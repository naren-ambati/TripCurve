// RuleEngine: evaluates every rule over the resolved model. Rules are data
// driven: an id and a pure function over a ResolvedWorkload. B4 adds T2 and T3;
// T4 (bolt B5) runs over an event source mapping. A rule never reads a file or the clock.

import type {
  Finding,
  InputText,
  QueueRef,
  RuleId,
  SourceRef,
  WorkloadRef,
} from '../core/index.js';
import type { ResolvedModel, ResolvedQueueWorkload, ResolvedWorkload } from '../resolve/index.js';
import { evaluateT1 } from './t1.js';
import { evaluateT2 } from './t2.js';
import { evaluateT3 } from './t3.js';
import { evaluateT4 } from './t4.js';

export interface RuleDefinition {
  readonly id: RuleId;
  readonly evaluate: (workload: ResolvedWorkload) => Finding;
}

export const RULES: readonly RuleDefinition[] = [
  { id: 'T1', evaluate: evaluateT1 },
  { id: 'T2', evaluate: evaluateT2 },
  { id: 'T3', evaluate: evaluateT3 },
];

export interface WorkloadFindings {
  readonly workload: WorkloadRef | QueueRef;
  readonly file: SourceRef;
  /** The Helm `# Source:` comment text of the workload's document, when there is one. */
  readonly helmSource?: InputText;
  /** In rule order (T1 first). */
  readonly findings: readonly Finding[];
}

export function evaluateWorkload(workload: ResolvedWorkload): WorkloadFindings {
  return {
    workload: workload.workload,
    file: workload.file,
    ...(workload.helmSource === undefined ? {} : { helmSource: workload.helmSource }),
    findings: RULES.map((rule) => rule.evaluate(workload)),
  };
}

/** An event source mapping (bolt B5): rule T4 only. */
export function evaluateQueueWorkload(workload: ResolvedQueueWorkload): WorkloadFindings {
  return { workload: workload.queue, file: workload.file, findings: [evaluateT4(workload)] };
}

/** Every workload of the resolved model, in the order the resolver gave them, then every event source mapping. */
export function evaluateRules(model: ResolvedModel): readonly WorkloadFindings[] {
  return [
    ...model.workloads.map(evaluateWorkload),
    ...model.queueWorkloads.map(evaluateQueueWorkload),
  ];
}
