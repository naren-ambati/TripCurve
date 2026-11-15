// Knowledge-base entry schema and loader.
// Entries are data files, not code. The loader rejects an entry that is
// missing a required field or has a malformed one, and names the entry id.
// Everything in an entry is shipped text written by a contributor; none of it
// is input text, so the strings here are plain strings, not InputText.

import { WORKER_CLASSES } from '../core/vocab.js';
import { parseRange } from './version-interval.js';

export const KB_SUBJECTS = [
  'alb-idle-timeout',
  'k8s-grace-period',
  'node-idle-close',
  'node-keepalive-explicit',
  'node-keepalive-buffer-explicit',
  'node-headers-timeout-trap',
  'gunicorn-keepalive',
  'gunicorn-keepalive-explicit',
  'gunicorn-graceful-timeout',
  'gunicorn-graceful-timeout-explicit',
  'uvicorn-graceful-timeout-explicit',
  'gunicorn-sync-keepalive',
  'uvicorn-keepalive',
  'uvicorn-keepalive-explicit',
  'lightship-shutdown-delay',
  'gunicorn-setting-precedence',
  'terraform-lb-idle-timeout',
  'terraform-sqs-visibility',
  'terraform-lambda-timeout',
  'lambda-sqs-batching-window',
  'cfn-lb-idle-timeout',
  'cfn-sqs-visibility',
  'cfn-lambda-timeout',
] as const;
export type KbSubject = (typeof KB_SUBJECTS)[number];

export const KB_BASES = [
  'measured',
  'documented',
  'from-source',
  'from-changelogs',
  'to-be-measured',
] as const;
export type KbBasis = (typeof KB_BASES)[number];

export const KB_SOURCES = ['command', 'env', 'config-file'] as const;
export type KbSource = (typeof KB_SOURCES)[number];

export interface KbMeasuredOn {
  readonly version: string;
  readonly date: string;
  readonly platform: string;
}

export interface KbEntry {
  /** Unique, kebab-case. */
  readonly id: string;
  readonly subject: KbSubject;
  readonly value: number | 'n/a';
  readonly unit: 's' | 'ms';
  readonly applies: {
    readonly runtime: string;
    /** `*`, or `>=X.Y.Z`, `<X.Y.Z` or both separated by a space. */
    readonly versionRange: string;
    /** Only `workerClass in [a, b]` in v0.1. */
    readonly condition?: string;
  };
  /** The source name in the printed citation, for example "ALB idle timeout". */
  readonly citationName: string;
  /** The range label in the printed citation, for example "Node 22.x from 22.19". */
  readonly rangeLabel?: string;
  readonly docUrl: string;
  /** ISO date the docUrl was read. */
  readonly docDate: string;
  readonly basis: KbBasis;
  /** Required when basis is `measured`. */
  readonly measuredOn?: KbMeasuredOn;
  /**
   * For an explicit-setting entry (subject ending `-explicit`): the smallest and largest explicit
   * value, in seconds, that was measured. The rule holds only inside this span.
   */
  readonly measuredSpan?: { readonly min: number; readonly max: number };
  /**
   * For a measured entry: the exact releases that were run, as written in the results (B3). The printed basis counts and bounds them (`5 releases from 22.12.0 to 22.23.5`) and a
   * test checks each against the result files, so the text never claims a release that was not run.
   */
  readonly measuredVersions?: readonly string[];
  /**
   * For an explicit-setting entry: the explicit values K, in seconds, that were run. The printed
   * basis lists them (`K = 7, 12 and 65 s`); `measuredSpan` is their smallest and largest.
   */
  readonly measuredKs?: readonly number[];
  /**
   * For a buffer-unset explicit entry: the runs of the `createServer` options form, one group per
   * K (seconds) with the releases it was run on. Absent when the options form was not run on the
   * line. The options form is not run with a buffer, so a buffer entry never has it.
   */
  readonly measuredOptions?: readonly {
    readonly k: number;
    readonly versions: readonly string[];
  }[];
  /**
   * A measurement script path, or the reason it cannot be measured locally (only for a
   * documented value of a service that cannot run on localhost). Absent only when `deferredTo` is set.
   */
  readonly scriptRef?: string | { readonly notMeasurableLocally: string };
  /**
   * Runnable software whose measurement waits for a later bolt: the bolt and the
   * fact that stops it now. The lanes print it as DEFERRED, never as measured, and it is no release blocker.
   */
  readonly deferredTo?: { readonly bolt: string; readonly reason: string };
  /** Required when scriptRef is a script that measures time. For a proportional entry: the tolerance at the largest value of its span. */
  readonly toleranceMs?: number;
  /**
   * For an entry whose overshoot grows with the value (gthread): the largest observed relative
   * deviation, so the tolerance at a value of V s is `V * 1000 * toleranceRelative + 1` ms.
   */
  readonly toleranceRelative?: number;
  /**
   * For a proportional entry: the tolerance, in ms, for a value that has observations of its own (key:
   * the value in seconds). The lane uses it for that value; the relative rule covers the others.
   */
  readonly toleranceMsAt?: Readonly<Record<string, number>>;
  /**
   * For an explicit gunicorn graceful timeout: the places the setting was measured from (`command`: the
   * flag; `env`: GUNICORN_CMD_ARGS; `config-file`: a `-c` file). A value from any other place is not covered.
   */
  readonly sources?: readonly KbSource[];
  readonly notes?: string;
}

export interface KbProblem {
  /** The entry id, or a position label when the entry has no usable id. */
  readonly entryId: string;
  readonly field: string;
  readonly message: string;
}

export class KbSchemaError extends Error {
  readonly problems: readonly KbProblem[];
  constructor(problems: readonly KbProblem[]) {
    super(
      `knowledge base rejected: ${problems
        .map((p) => `entry ${p.entryId}: ${p.field}: ${p.message}`)
        .join('; ')}`,
    );
    this.name = 'KbSchemaError';
    this.problems = problems;
  }
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONDITION_RE = /^workerClass in \[([a-z]+(?:, [a-z]+)*)\]$/;
const ENTRY_KEYS = new Set([
  'id',
  'subject',
  'value',
  'unit',
  'applies',
  'citationName',
  'rangeLabel',
  'docUrl',
  'docDate',
  'basis',
  'measuredOn',
  'measuredSpan',
  'measuredVersions',
  'measuredKs',
  'measuredOptions',
  'scriptRef',
  'toleranceMs',
  'toleranceRelative',
  'toleranceMsAt',
  'deferredTo',
  'sources',
  'notes',
]);
const REASON_FORM_SUBJECTS: readonly string[] = [
  'alb-idle-timeout',
  'k8s-grace-period',
  // Terraform and AWS-service defaults (bolt B5): AWS services cannot run on the build machine.
  'terraform-lb-idle-timeout',
  'terraform-sqs-visibility',
  'terraform-lambda-timeout',
  'lambda-sqs-batching-window',
  // CloudFormation and SAM defaults (bolt B12): AWS services cannot run on the build machine.
  'cfn-lb-idle-timeout',
  'cfn-sqs-visibility',
  'cfn-lambda-timeout',
];
/** Node subjects whose entries each cover one release line. */
const NODE_LINE_SUBJECTS: readonly string[] = [
  'node-idle-close',
  'node-keepalive-explicit',
  'node-keepalive-buffer-explicit',
  'node-headers-timeout-trap',
];

function isIsoDate(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The condition's worker classes, or undefined when the text is not the one grammar. */
export function parseCondition(text: string): readonly string[] | undefined {
  const m = CONDITION_RE.exec(text);
  if (!m?.[1]) return undefined;
  const words = m[1].split(', ');
  return words.every((w) => (WORKER_CLASSES as readonly string[]).includes(w)) ? words : undefined;
}

function validateEntry(raw: unknown, position: number): { entry?: KbEntry; problems: KbProblem[] } {
  const problems: KbProblem[] = [];
  if (!isRecord(raw)) {
    return {
      problems: [{ entryId: `#${position}`, field: '(entry)', message: 'is not an object' }],
    };
  }
  const id = isNonEmptyString(raw.id) ? raw.id : `#${position} (no id)`;
  const bad = (field: string, message: string) => problems.push({ entryId: id, field, message });

  if (!isNonEmptyString(raw.id)) bad('id', 'is missing');
  else if (!ID_RE.test(raw.id)) bad('id', 'must be kebab-case');
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) bad(key, 'is not a known field');
  }
  if (!KB_SUBJECTS.includes(raw.subject as KbSubject))
    bad('subject', 'is missing or not a known subject');
  if (
    !(
      raw.value === 'n/a' ||
      (typeof raw.value === 'number' && Number.isFinite(raw.value) && raw.value >= 0)
    )
  ) {
    bad('value', 'must be a number of 0 or more, or "n/a"');
  }
  if (raw.unit !== 's' && raw.unit !== 'ms') bad('unit', 'must be s or ms');

  const applies = raw.applies;
  if (!isRecord(applies)) {
    bad('applies', 'is missing');
  } else {
    if (!isNonEmptyString(applies.runtime)) bad('applies.runtime', 'is missing');
    if (!isNonEmptyString(applies.versionRange)) {
      bad('applies.versionRange', 'is missing');
    } else if (parseRange(applies.versionRange) === undefined) {
      bad('applies.versionRange', 'is not in the version range grammar');
    } else if (typeof raw.subject === 'string' && NODE_LINE_SUBJECTS.includes(raw.subject)) {
      // One release line per Node entry: never "*", never a range across lines.
      const interval = parseRange(applies.versionRange);
      if (applies.versionRange === '*') {
        bad('applies.versionRange', 'a Node entry covers one release line, not "*"');
      } else if (interval?.upper) {
        const endsOnLineBoundary = interval.upper.minor === 0 && interval.upper.patch === 0;
        const lastLine = endsOnLineBoundary ? interval.upper.major - 1 : interval.upper.major;
        if (lastLine !== interval.lower.major) {
          bad('applies.versionRange', 'a Node entry must not span release lines');
        }
      }
    }
    if (applies.condition !== undefined) {
      if (
        typeof applies.condition !== 'string' ||
        parseCondition(applies.condition) === undefined
      ) {
        bad('applies.condition', 'is not "workerClass in [<known worker classes>]"');
      }
    }
    for (const key of Object.keys(applies)) {
      if (key !== 'runtime' && key !== 'versionRange' && key !== 'condition') {
        bad(`applies.${key}`, 'is not a known field');
      }
    }
  }
  if (!isNonEmptyString(raw.citationName)) bad('citationName', 'is missing');
  if (raw.rangeLabel !== undefined && !isNonEmptyString(raw.rangeLabel)) {
    bad('rangeLabel', 'must be non-empty when present');
  }
  if (!isNonEmptyString(raw.docUrl)) {
    bad('docUrl', 'is missing');
  } else {
    let protocol = '';
    try {
      protocol = new URL(raw.docUrl).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'https:') bad('docUrl', 'must be an https URL');
  }
  if (!isIsoDate(raw.docDate)) bad('docDate', 'is missing or not a real YYYY-MM-DD date');
  if (!KB_BASES.includes(raw.basis as KbBasis)) bad('basis', 'is missing or not a known basis');

  if (raw.basis === 'measured') {
    const m = raw.measuredOn;
    if (
      !isRecord(m) ||
      !isNonEmptyString(m.version) ||
      !isIsoDate(m.date) ||
      !isNonEmptyString(m.platform)
    ) {
      bad('measuredOn', 'is required for a measured entry: {version, date, platform}');
    }
  } else if (raw.measuredOn !== undefined) {
    bad('measuredOn', 'is allowed only when basis is measured');
  }

  const isExplicit = typeof raw.subject === 'string' && raw.subject.endsWith('-explicit');
  const span = raw.measuredSpan;
  if (isExplicit) {
    if (
      !isRecord(span) ||
      !Number.isFinite(span.min) ||
      !Number.isFinite(span.max) ||
      (span.min as number) < 1 ||
      (span.max as number) < (span.min as number)
    ) {
      bad('measuredSpan', 'is required for an explicit entry: {min, max} in seconds, 1 or more');
    }
  } else if (span !== undefined) {
    bad('measuredSpan', 'is allowed only for an explicit-setting entry');
  }

  const versions = raw.measuredVersions;
  if (versions !== undefined) {
    if (
      raw.basis !== 'measured' ||
      !Array.isArray(versions) ||
      versions.length === 0 ||
      !versions.every((v) => isNonEmptyString(v)) ||
      new Set(versions).size !== versions.length
    ) {
      bad(
        'measuredVersions',
        'is a non-empty list of distinct versions, allowed only when basis is measured',
      );
    }
  }
  const ks = raw.measuredKs;
  if (ks !== undefined) {
    if (
      !isExplicit ||
      !Array.isArray(ks) ||
      ks.length === 0 ||
      !ks.every((k) => typeof k === 'number' && Number.isFinite(k) && k >= 1) ||
      new Set(ks).size !== ks.length ||
      !isRecord(span) ||
      Math.min(...(ks as number[])) !== span.min ||
      Math.max(...(ks as number[])) !== span.max
    ) {
      bad(
        'measuredKs',
        'is a non-empty list of distinct values of 1 s or more, allowed only for an explicit entry, whose smallest and largest are the measuredSpan',
      );
    }
  }

  const options = raw.measuredOptions;
  if (options !== undefined) {
    const listed = Array.isArray(versions) ? (versions as unknown[]) : [];
    if (
      raw.subject !== 'node-keepalive-explicit' ||
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every(
        (o) =>
          isRecord(o) &&
          typeof o.k === 'number' &&
          Number.isFinite(o.k) &&
          o.k >= 1 &&
          Array.isArray(o.versions) &&
          o.versions.length > 0 &&
          o.versions.every((v: unknown) => listed.includes(v)),
      )
    ) {
      bad(
        'measuredOptions',
        'is a non-empty list of {k, versions} for a node-keepalive-explicit entry, each version one of measuredVersions',
      );
    }
  }

  const script = raw.scriptRef;
  const deferred = raw.deferredTo;
  if (deferred !== undefined) {
    if (
      !isRecord(deferred) ||
      typeof deferred.bolt !== 'string' ||
      !/^B\d+$/.test(deferred.bolt) ||
      !isNonEmptyString(deferred.reason)
    ) {
      bad('deferredTo', 'is {bolt: "B<number>", reason: text}');
    } else {
      for (const key of Object.keys(deferred)) {
        if (key !== 'bolt' && key !== 'reason') bad(`deferredTo.${key}`, 'is not a known field');
      }
    }
    if (script !== undefined)
      bad('deferredTo', 'an entry is either deferred or has a script or a reason, not both');
    if (raw.subject !== 'node-headers-timeout-trap' || raw.basis !== 'from-changelogs') {
      bad(
        'deferredTo',
        'a deferral is valid only for subject node-headers-timeout-trap with basis from-changelogs (it is unmeasured)',
      );
    }
    if (raw.toleranceMs !== undefined)
      bad('toleranceMs', 'is only for an entry with a measurement script');
  } else if (isNonEmptyString(script)) {
    if (
      !(
        typeof raw.toleranceMs === 'number' &&
        Number.isFinite(raw.toleranceMs) &&
        raw.toleranceMs > 0
      )
    ) {
      bad('toleranceMs', 'is required (a positive number) when scriptRef is a measurement script');
    }
  } else if (isRecord(script) && isNonEmptyString(script.notMeasurableLocally)) {
    if (!REASON_FORM_SUBJECTS.includes(raw.subject as string)) {
      bad(
        'scriptRef',
        'the not-measurable-locally reason is allowed only for the ALB idle, Kubernetes grace and Terraform/AWS default entries',
      );
    }
    if (raw.basis !== 'documented') {
      bad('scriptRef', 'the not-measurable-locally reason is allowed only for a documented value');
    }
    if (raw.toleranceMs !== undefined)
      bad('toleranceMs', 'is only for an entry with a measurement script');
    for (const key of Object.keys(script)) {
      if (key !== 'notMeasurableLocally') bad(`scriptRef.${key}`, 'is not a known field');
    }
  } else {
    bad('scriptRef', 'is missing: a script path, {notMeasurableLocally: reason}, or deferredTo');
  }
  const at = raw.toleranceMsAt;
  if (at === undefined && raw.toleranceRelative !== undefined) {
    bad(
      'toleranceMsAt',
      'is required for a proportional entry: its span minimum and maximum each need a tolerance',
    );
  }
  if (at !== undefined) {
    const lo = isRecord(span) ? Number(span.min) : Number.NaN;
    const hi = isRecord(span) ? Number(span.max) : Number.NaN;
    if (
      raw.toleranceRelative === undefined ||
      !isRecord(at) ||
      Object.keys(at).length === 0 ||
      !Object.entries(at).every(
        ([k, v]) =>
          /^[1-9]\d*$/.test(k) &&
          Number(k) >= lo &&
          Number(k) <= hi &&
          typeof v === 'number' &&
          Number.isFinite(v) &&
          v > 0,
      )
    ) {
      bad(
        'toleranceMsAt',
        'is {<value in seconds inside measuredSpan>: positive ms} and needs toleranceRelative',
      );
    } else if (isRecord(at) && (at[String(lo)] === undefined || at[String(hi)] === undefined)) {
      bad(
        'toleranceMsAt',
        'must hold the span minimum and the span maximum: every value the plan runs needs its own tolerance',
      );
    }
  }
  if (
    raw.toleranceRelative !== undefined &&
    !(
      typeof raw.toleranceRelative === 'number' &&
      raw.toleranceRelative > 0 &&
      raw.toleranceRelative < 1
    )
  ) {
    bad('toleranceRelative', 'must be a fraction above 0 and below 1');
  }
  const sources = raw.sources;
  if (sources !== undefined) {
    if (
      raw.subject !== 'gunicorn-graceful-timeout-explicit' ||
      !Array.isArray(sources) ||
      sources.length === 0 ||
      new Set(sources).size !== sources.length ||
      !sources.every((x) => (KB_SOURCES as readonly unknown[]).includes(x))
    ) {
      bad(
        'sources',
        'is a non-empty list of command, env or config-file, only for an explicit gunicorn graceful timeout',
      );
    }
  } else if (raw.subject === 'gunicorn-graceful-timeout-explicit') {
    bad('sources', 'is required for an explicit gunicorn graceful timeout');
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') bad('notes', 'must be text');

  if (problems.length > 0) return { problems };
  return { entry: raw as unknown as KbEntry, problems };
}

/**
 * Validates parsed knowledge-base files and returns the entries. Throws a
 * KbSchemaError naming every bad entry id; the shipped files are validated at
 * load, so a bad entry is a build-time fault, never input-reachable.
 */
export function loadKbEntries(files: readonly unknown[]): readonly KbEntry[] {
  const problems: KbProblem[] = [];
  const entries: KbEntry[] = [];
  const seen = new Set<string>();
  for (const [fileIndex, file] of files.entries()) {
    if (!isRecord(file) || file.schemaVersion !== 1 || !Array.isArray(file.entries)) {
      problems.push({
        entryId: `(file #${fileIndex})`,
        field: 'schemaVersion',
        message: 'a knowledge-base file is {schemaVersion: 1, entries: [...]}',
      });
      continue;
    }
    for (const [position, raw] of file.entries.entries()) {
      const result = validateEntry(raw, position);
      problems.push(...result.problems);
      if (result.entry) {
        if (seen.has(result.entry.id)) {
          problems.push({ entryId: result.entry.id, field: 'id', message: 'is not unique' });
        } else {
          seen.add(result.entry.id);
          entries.push(result.entry);
        }
      }
    }
  }
  if (problems.length > 0) throw new KbSchemaError(problems);
  return entries;
}
