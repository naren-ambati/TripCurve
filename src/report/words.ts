// Fixed words shared by the renderers (tripcurve's own text, never input). The human report, the JSON
// document and the SARIF messages all say the same thing about a configuration error or a workload that
// was not checked, so the words live here once.

import type { NotCheckedReason } from '../link/index.js';
import type { ConfigError, WholeFileProblem } from '../parse/index.js';

export const CONFIG_REASON_WORDS: Readonly<Record<ConfigError['reasonCode'], string>> = {
  'invalid-schema': 'is not in a form tripcurve reads',
  'unknown-key': 'is not a key tripcurve knows',
  'bad-value': 'has a value that is not valid',
  'declaration-names-no-workload': 'names no workload that was read',
  'declaration-names-several-workloads': 'names more than one workload',
  'duplicate-workload-entry': 'is a second entry for a workload that is already named',
};

/** Why an object was listed as not checked (NotCheckedItem), as a short phrase for JSON. */
export const NOT_CHECKED_WORDS: Readonly<Record<NotCheckedReason, string>> = {
  'no-recognised-lb': 'no load balancer found in the checked files',
  'not-alb-ingress': 'not recognised as an ALB Ingress',
  'kind-not-checked': 'not a kind tripcurve checks',
};

/** A configuration error about the whole file, as a plain sentence without its full stop (review of B7, m3). */
export const WHOLE_FILE_WORDS: Readonly<Record<WholeFileProblem, string>> = {
  unreadable: 'the config file could not be read',
  'not-a-mapping': 'the config file is not a mapping of keys',
  'several-documents': 'the config file has more than one document',
};

/** What is wrong, after the quoted key (`is not a key tripcurve knows`) or, for the whole file, a sentence. */
export function configErrorWords(e: ConfigError): string {
  return e.wholeFile === undefined
    ? CONFIG_REASON_WORDS[e.reasonCode]
    : WHOLE_FILE_WORDS[e.wholeFile];
}
