// The knowledge base.

import { defaultKnowledgeBase } from './default-knowledge-base.js';
import type { Facts, KnowledgeBase, LookupResult } from './knowledge-base.js';
import type { KbSubject } from './schema.js';
import type { VersionInterval } from './version-interval.js';

export { defaultKnowledgeBase } from './default-knowledge-base.js';
export {
  basisWords,
  citationFor,
  type ExplicitUse,
  explicitBasisWords,
  type Facts,
  KnowledgeBase,
  type LookupMatch,
  type LookupResult,
  loadKnowledgeBase,
  sourcedValueFromEntry,
  supportsPass,
} from './knowledge-base.js';
export {
  KB_BASES,
  KB_SUBJECTS,
  type KbBasis,
  type KbEntry,
  type KbMeasuredOn,
  type KbProblem,
  KbSchemaError,
  type KbSource,
  type KbSubject,
  loadKbEntries,
  parseCondition,
} from './schema.js';
export * from './version-interval.js';

/** `lookup(subject, interval, condition?)` over the shipped knowledge base (or the one given). */
export function lookup(
  subject: KbSubject,
  interval: VersionInterval,
  facts?: Facts,
  kb: KnowledgeBase = defaultKnowledgeBase(),
): LookupResult {
  return kb.lookup(subject, interval, facts);
}
