// One candidate per knowledge-base range for the idle close of a Node server. The version is an interval; the
// knowledge base cuts it into the stretches an entry covers and the gaps no entry covers. Every
// stretch is a candidate and none is dropped or borrowed from a neighbour:
//
//   - a stretch an entry covers gives the entry's value, or, when the source sets the idle close
//     explicitly, a value computed by the rule the entry measured (below);
//   - a gap, and a stretch where the rule cannot be applied, gives an UNRESOLVED candidate with a
//     fixed reason. It stays in the list so the VERSION-DEPENDENT result prints a line for it, and
//     it can never support PASS.
//
// Which entries cut the interval depends on what the source writes (the ranges are data):
//   - nothing explicit: the default entries (subject `node-idle-close`).
//   - an explicit keepAliveTimeout K and no buffer: the entries of `node-keepalive-explicit`
//     (idle close = K + the entry's extra seconds, measured), and the old-Node trap entries.
//   - an explicit keepAliveTimeoutBuffer B: the entries of `node-keepalive-buffer-explicit` whose
//     value is B (idle close = K + B, measured), and the trap entries. A release line where the
//     property does not exist has no such entry, so it is a gap, not a guess.
//   - the old-Node `headersTimeout` trap: on the trap ranges the idle
//     close is the smaller of K and headersTimeout, from changelogs, not measured. A project rule
//     says that basis may support PASS, provided the basis is printed.
//
// With the effect of an explicit setting measured (measure/results/2026-11-11-b3.jsonl and
// 2026-11-11-b3-versions.jsonl) "both effects (with and without the 1 s buffer) are
// candidates until the entry is measured" no longer applies: each range has one measured rule.
//
// Honesty: the rules hold only where measured. An explicit value outside the measured span, a
// value that may run after `listen`, a buffer no entry measured and a `headersTimeout` below the
// idle close (outside the trap ranges) are UNRESOLVED with a fixed reason.

import {
  defaultSource,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  type SourcedValue,
  type SourceRef,
} from '../core/index.js';
import {
  basisWords,
  describeGap,
  explicitBasisWords,
  type KbEntry,
  type KnowledgeBase,
  type LookupMatch,
  partitionInterval,
  sourcedValueFromEntry,
  supportsPass,
  type VersionInterval,
} from '../kb/index.js';
import type { NodeSettingName, NodeSettingValue } from '../parse/index.js';
import type { Candidate } from './model.js';

export const REASON_NOT_BEFORE_LISTEN =
  'the setting is not shown to be written before listen on an unconditional path, and only a value set before listen is measured';
export const REASON_BUFFER_WITHOUT_KEEPALIVE =
  'keepAliveTimeoutBuffer is set without keepAliveTimeout, and the default keepAliveTimeout with an explicit buffer is not measured';
export const REASON_HEADERS_SHORT =
  'headersTimeout is set below the idle close, and its effect on this release is not measured';

/** What the source writes about the idle close of this server; only values that were read. */
export interface NodeIdleSettings {
  readonly keepAlive?: NodeSettingValue;
  readonly buffer?: NodeSettingValue;
  readonly headers?: NodeSettingValue;
  readonly notBeforeListen: readonly NodeSettingName[];
  /** Settings written only in the options of `createServer`: the basis names the options-form runs. */
  readonly optionsOnly?: readonly NodeSettingName[];
}

export interface PlanArgs {
  readonly interval: VersionInterval;
  /** `Node 22.23`: used when no entry covers the whole interval. */
  readonly versionLabel: string;
  readonly kb: KnowledgeBase;
  readonly settings: NodeIdleSettings;
}

function unresolvedCandidate(condition: string, reason: string): Candidate {
  return { condition, value: makeUnresolved(reason), supportsPass: false };
}

function numberOf(v: NodeSettingValue | undefined): number | undefined {
  return v !== undefined && !isUnresolved(v) && typeof v.value === 'number' ? v.value : undefined;
}

/** Seconds as printed in a reason: whole numbers bare, otherwise up to three decimals. */
function secondsText(seconds: number): string {
  if (Number.isInteger(seconds)) return String(seconds);
  return seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function sourcedBasis(entry: KbEntry): SourcedValue['basis'] {
  switch (entry.basis) {
    case 'measured':
      return 'measured-on';
    case 'documented':
      return 'documented';
    case 'from-source':
      return 'from-source-not-measured';
    case 'from-changelogs':
      return 'from-changelogs-not-measured';
    case 'to-be-measured':
      return 'to-be-measured';
  }
}

/** A value that is a computed result of an entry's rule, not a default: it prints without `default: `. */
function ruleValue(entry: KbEntry, seconds: number, basisText: string): SourcedValue {
  return makeSourcedValue({
    value: seconds,
    unit: 's',
    source: defaultSource({
      citation: entry.citationName,
      ...(entry.rangeLabel === undefined ? {} : { range: entry.rangeLabel }),
      basisText,
      entryId: entry.id,
      bare: true,
    }),
    basis: sourcedBasis(entry),
  });
}

/** `keepAliveTimeout 59000.4 ms is not a whole number of milliseconds; ...` for a value the measurements cannot speak for. */
function fractionalReason(name: string, ms: number): string {
  return `${name} ${ms} ms is not a whole number of milliseconds; fractional milliseconds are not measured`;
}

function labelOf(entry: KbEntry): string {
  return entry.rangeLabel ?? entry.id;
}

/**
 * `headersTimeout` outside the trap ranges. A value at or above the idle close cannot shorten it
 * (the timer would have to fire later than the keep-alive close). A shorter one, or one that is
 * not a literal, is not measured on these releases: UNRESOLVED. Returns the reason, or undefined
 * when headersTimeout is absent or cannot matter.
 */
function headersBlock(
  headers: NodeSettingValue | undefined,
  idleSeconds: number,
): string | undefined {
  if (headers === undefined) return undefined;
  if (isUnresolved(headers)) return headers.reason;
  if (typeof headers.value !== 'number') return REASON_HEADERS_SHORT;
  return headers.value >= idleSeconds * 1000 ? undefined : REASON_HEADERS_SHORT;
}

function defaultCandidate(match: LookupMatch, settings: NodeIdleSettings): Candidate {
  const entry = match.entry;
  const condition = labelOf(entry);
  const value = sourcedValueFromEntry(entry);
  if (value === undefined)
    return unresolvedCandidate(condition, 'the knowledge base entry holds no number');
  const blocked =
    typeof entry.value === 'number' ? headersBlock(settings.headers, entry.value) : undefined;
  if (blocked !== undefined) return unresolvedCandidate(condition, blocked);
  return { condition, value, basis: entry.basis, supportsPass: supportsPass(entry) };
}

/** The old-Node trap: the idle close of an explicit keepAliveTimeout is the smaller of it and headersTimeout. */
function trapCandidate(entry: KbEntry, settings: NodeIdleSettings): Candidate {
  const condition = labelOf(entry);
  const keepAlive = settings.keepAlive;
  if (keepAlive === undefined || isUnresolved(keepAlive) || typeof keepAlive.value !== 'number') {
    return unresolvedCandidate(
      condition,
      'keepAliveTimeout is not set to a literal number here, and its default on this release is not in the knowledge base',
    );
  }
  if (typeof entry.value !== 'number') {
    return unresolvedCandidate(condition, 'the knowledge base entry holds no number');
  }
  const headers = settings.headers;
  if (headers !== undefined && (isUnresolved(headers) || typeof headers.value !== 'number')) {
    return unresolvedCandidate(
      condition,
      isUnresolved(headers) ? headers.reason : REASON_HEADERS_SHORT,
    );
  }
  const keepAliveMs = keepAlive.value;
  if (!Number.isInteger(keepAliveMs)) {
    return unresolvedCandidate(condition, fractionalReason('keepAliveTimeout', keepAliveMs));
  }
  const headersMs = headers === undefined ? entry.value * 1000 : (headers.value as number);
  const seconds = Math.min(keepAliveMs, headersMs) / 1000;
  const headersIsLess = headersMs < keepAliveMs;
  const decidedBy: SourceRef =
    headersIsLess && headers !== undefined && !isUnresolved(headers)
      ? headers.source
      : keepAlive.source;
  const headersText =
    headers === undefined
      ? `headersTimeout ${secondsText(headersMs / 1000)} s (default)`
      : `headersTimeout ${secondsText(headersMs / 1000)} s`;
  return {
    condition,
    value: ruleValue(entry, seconds, basisWords(entry)),
    basis: entry.basis,
    supportsPass: supportsPass(entry),
    decidedBy,
    note: `smaller of keepAliveTimeout ${secondsText(keepAliveMs / 1000)} s and ${headersText} (${labelOf(entry)}; ${basisWords(entry)})`,
  };
}

/** An explicit keepAliveTimeout K inside a measured range: the idle close is K + the entry's value. */
function explicitCandidate(entry: KbEntry, settings: NodeIdleSettings): Candidate {
  const condition = labelOf(entry);
  const keepAlive = settings.keepAlive;
  if (keepAlive === undefined || isUnresolved(keepAlive) || typeof keepAlive.value !== 'number') {
    return unresolvedCandidate(condition, REASON_BUFFER_WITHOUT_KEEPALIVE);
  }
  const span = entry.measuredSpan;
  if (span === undefined || typeof entry.value !== 'number') {
    return unresolvedCandidate(condition, 'the knowledge base entry holds no measured rule');
  }
  if (!Number.isInteger(keepAlive.value)) {
    return unresolvedCandidate(condition, fractionalReason('keepAliveTimeout', keepAlive.value));
  }
  const keepAliveSeconds = keepAlive.value / 1000;
  if (keepAliveSeconds < span.min || keepAliveSeconds > span.max) {
    return unresolvedCandidate(
      condition,
      `explicit keepAliveTimeout ${secondsText(keepAliveSeconds)} s is outside the measured span (${span.min} to ${span.max} s)`,
    );
  }
  const written: NodeSettingName[] = ['keepAliveTimeout'];
  if (entry.subject === 'node-keepalive-buffer-explicit') written.push('keepAliveTimeoutBuffer');
  if (written.some((name) => settings.notBeforeListen.includes(name))) {
    return unresolvedCandidate(condition, REASON_NOT_BEFORE_LISTEN);
  }
  const seconds = keepAliveSeconds + entry.value;
  // Written in createServer options, K or the buffer: the basis names the form that was run.
  const basisUse = {
    kSeconds: keepAliveSeconds,
    viaOptions: written.some((name) => settings.optionsOnly?.includes(name)),
  };
  const blocked = headersBlock(settings.headers, seconds);
  if (blocked !== undefined) return unresolvedCandidate(condition, blocked);
  const extra =
    entry.subject === 'node-keepalive-buffer-explicit'
      ? `${secondsText(entry.value)} s buffer`
      : `${secondsText(entry.value)} s`;
  return {
    condition,
    value: ruleValue(entry, seconds, explicitBasisWords(entry, basisUse)),
    basis: entry.basis,
    supportsPass: supportsPass(entry),
    decidedBy: keepAlive.source,
    note: `keepAliveTimeout ${secondsText(keepAliveSeconds)} s + ${extra} (${labelOf(entry)}; ${explicitBasisWords(entry, basisUse)})`,
  };
}

/**
 * One candidate per stretch of the interval, in version order. Never throws and never
 * returns an empty list for a non-empty interval.
 */
export function planNodeRanges(args: PlanArgs): Candidate[] {
  const { interval, kb, settings } = args;
  const explicitKeepAlive = settings.keepAlive !== undefined;
  const explicitBuffer = settings.buffer !== undefined;
  const explicit = explicitKeepAlive || explicitBuffer;

  let matches: LookupMatch[];
  /** Why a stretch no entry covers is unresolved, when the setting is what leaves it uncovered. */
  let gapReason: (label: string, whole: boolean) => string = (label) =>
    `no knowledge-base entry covers ${label}`;
  if (!explicit) {
    matches = [...kb.lookup('node-idle-close', interval).matches];
  } else {
    const bufferMs = numberOf(settings.buffer);
    const bufferEntries = kb.lookup('node-keepalive-buffer-explicit', interval).matches;
    matches = [
      ...(explicitBuffer
        ? bufferEntries.filter(
            (m) => typeof m.entry.value === 'number' && m.entry.value * 1000 === bufferMs,
          )
        : kb.lookup('node-keepalive-explicit', interval).matches),
      ...kb.lookup('node-headers-timeout-trap', interval).matches,
    ];
    if (explicitBuffer) {
      // The buffer is unresolved only when no entry of any release line holds its value.
      const measuredAnywhere = kb.entries.some(
        (e) =>
          e.subject === 'node-keepalive-buffer-explicit' &&
          typeof e.value === 'number' &&
          e.value * 1000 === bufferMs,
      );
      gapReason = (label, whole) =>
        bufferMs !== undefined && !Number.isInteger(bufferMs)
          ? fractionalReason('keepAliveTimeoutBuffer', bufferMs)
          : !measuredAnywhere
            ? `keepAliveTimeoutBuffer ${bufferMs} ms is not measured`
            : whole
              ? `an explicit keepAliveTimeoutBuffer is not measured on ${label}`
              : 'an explicit keepAliveTimeoutBuffer is not measured on this range';
    } else {
      gapReason = (label) =>
        `no knowledge-base entry covers an explicit keepAliveTimeout in ${label}`;
    }
  }

  const segments = partitionInterval(
    interval,
    matches.map((m) => ({ item: m, interval: m.overlap })),
  );
  const whole = segments.length === 1;
  const out: Candidate[] = [];
  for (const segment of segments) {
    if (segment.kind === 'gap') {
      // The branch line already names the stretch; only a lone gap names the version asked about.
      const label = whole ? args.versionLabel : 'this range';
      out.push(unresolvedCandidate(describeGap(segment.interval), gapReason(label, whole)));
    } else if (!explicit) {
      out.push(defaultCandidate(segment.item, settings));
    } else if (segment.item.entry.subject === 'node-headers-timeout-trap') {
      out.push(trapCandidate(segment.item.entry, settings));
    } else {
      out.push(explicitCandidate(segment.item.entry, settings));
    }
  }
  return out;
}
