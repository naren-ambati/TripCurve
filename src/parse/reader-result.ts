// The parts of the reader output that every reader shares: the
// closed list of reasons a value could not be established, and the helper that
// records one. The wrapper type is owned by in the contract text; it lives
// here because it needs nothing from beyond SourceRef and UnresolvedValue.

import { makeUnresolved, type SourceRef, type UnresolvedValue } from '../core/index.js';

export const UNRESOLVED_WHATS = [
  'non-literal',
  'unsupported-form',
  'source-not-linked',
  'ambiguous',
  'value-from-reference',
  'hook-unresolved-duration',
  'drain-unresolved-duration',
  /** A workload, Service, Ingress or IngressClass whose name or namespace is not literal text. */
  'object-not-identified',
] as const;
export type UnresolvedWhat = (typeof UNRESOLVED_WHATS)[number];

/** `label` is tripcurve's own fixed text, never input text. */
export interface ReaderUnresolved {
  readonly what: UnresolvedWhat;
  readonly where: SourceRef;
  readonly label: string;
}

/** Collects unresolved markers for one reader run and hands back the value to put in the model. */
export class UnresolvedLog {
  readonly items: ReaderUnresolved[] = [];

  mark(
    what: UnresolvedWhat,
    where: SourceRef,
    label: string,
    declareHint?: string,
  ): UnresolvedValue {
    this.items.push({ what, where, label });
    return makeUnresolved(label, declareHint);
  }
}
