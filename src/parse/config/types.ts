// The parsed output of tripcurve.yaml and its error list
// (`configErrors`). Waivers are raw: nothing here validates them.

import type { InputText, SourcedValue, SourceRef, WorkloadName } from '../../core/index.js';
import type { K8sWorkloadKind } from '../../core/vocab.js';

export const CONFIG_ERROR_CODES = [
  'invalid-schema',
  'unknown-key',
  'bad-value',
  // Decided by the linker, which knows the workloads; listed here so the
  // reason codes are one closed list.
  'declaration-names-no-workload',
  'declaration-names-several-workloads',
  // Two entries of `workloads:` name the same workload: nothing is merged (B4 review, minor 6).
  'duplicate-workload-entry',
] as const;
export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

/**
 * Why a configuration error is about the whole file and names no key: the file could not be read as YAML, is
 * empty or not a mapping, or holds more than one document. The report says it in plain words instead of
 * naming the placeholder key `(file)` (review of B7, m3).
 */
export const WHOLE_FILE_PROBLEMS = ['unreadable', 'not-a-mapping', 'several-documents'] as const;
export type WholeFileProblem = (typeof WHOLE_FILE_PROBLEMS)[number];

/** `key` is the key as written (unknown key) or a path such as `workloads[0].drain`, both as quoted input. */
export interface ConfigError {
  readonly file: InputText;
  /** The line of the error. JSON and SARIF always carry a number (1 when no line is known); see `lineUnknown`. */
  readonly line: number;
  /** True when the file was never opened or no line is known: the human report then names no line. */
  readonly lineUnknown?: true;
  readonly key: InputText;
  readonly reasonCode: ConfigErrorCode;
  /** Set when the error is about the whole file and `key` is only a placeholder. */
  readonly wholeFile?: WholeFileProblem;
  /**
   * For a `bad-value` of a number of seconds: what the value must be, with an example
   * (tripcurve's own words, for instance `a number of seconds, for example longest_request_s: 5`),
   * so the error names the key and the form it expects.
   */
  readonly expected?: string;
  /** The workload name the error is about (a declaration that names none, a duplicated entry): quoted input. */
  readonly workload?: InputText;
}

export const DECLARATION_KEYS = [
  'longest_request_s',
  'drain.in_process_s',
  'runtime.node',
  'runtime.gunicorn',
  'runtime.uvicorn',
] as const;
export type DeclarationKey = (typeof DECLARATION_KEYS)[number];

/** The workload entry a declaration or link came from (`workloadKind` only when the entry named one). */
export interface WorkloadSelector {
  readonly workload: WorkloadName;
  readonly workloadKind?: K8sWorkloadKind;
}

export interface Declaration extends WorkloadSelector {
  readonly key: DeclarationKey;
  /** Basis `declared`, source `tripcurve.yaml`:<line>. */
  readonly value: SourcedValue;
  readonly line: number;
}

export const LINK_KINDS = ['source', 'dockerfile', 'gunicorn_config', 'load_balancer'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * A link from a workload to a file or a load balancer. The `loadBalancer`
 * detail is an addition to (the contract names the link and the target but
 * not where the declared idle timeout goes): `form` says how the target is
 * named and `idleTimeoutS` carries the declared idle timeout of an ingress or
 * service form.
 */
export interface ConfigLink extends WorkloadSelector {
  readonly kind: LinkKind;
  readonly target: InputText;
  readonly line: number;
  readonly loadBalancer?: {
    readonly form: 'terraform' | 'ingress' | 'service';
    readonly idleTimeoutS?: SourcedValue;
  };
}

export type RawFieldValue = InputText | number | boolean | null | { readonly nested: true };

/** One top-level field of a waive entry, as written. */
export interface RawField {
  readonly key: InputText;
  readonly value: RawFieldValue;
}

/** A raw waiver record: extracted, never validated here. */
export interface RawWaiverRecord {
  readonly rawFields: readonly RawField[];
  readonly rawText: InputText;
  readonly source: SourceRef;
  readonly mechanism: 'inline' | 'config';
  /**
   * Set on the one record made for a `waive:` key whose value is not a list (a scalar, a mapping, or
   * nothing): it is listed as an invalid waiver, never a configuration error.
   */
  readonly notAList?: true;
}

export interface ConfigResult {
  readonly declarations: readonly Declaration[];
  readonly links: readonly ConfigLink[];
  readonly waiverRecords: readonly RawWaiverRecord[];
  readonly configErrors: readonly ConfigError[];
  /** The configuration file that was read, when there is one. */
  readonly configFile?: InputText;
}
