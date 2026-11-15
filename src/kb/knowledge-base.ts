// Knowledge-base lookup and the printed citation.
//
// Honesty rules enforced here:
// - Lookup returns every entry whose range overlaps the interval, and never a
//   nearest range: a version outside every range has no match.
// - `covered` says whether the matches together cover the WHOLE interval. A
//   partial cover (for example `node:22`, which includes 22.0 to 22.18 that no
//   entry covers) is `covered: false`, so the caller cannot print a verdict as
//   if the entry applied to every version.
// - An entry whose basis is `to-be-measured` loads and is returned, but never
//   supports PASS (`supportsPass`), and the release check lists it.

import { defaultSource, makeSourcedValue, type SourcedValue } from '../core/provenance.js';
import { type KbEntry, type KbSubject, loadKbEntries, parseCondition } from './schema.js';
import {
  compareVersions,
  intersect,
  intervalsOverlap,
  isCovered,
  isEmpty,
  parseRange,
  type VersionInterval,
} from './version-interval.js';

/** The facts an entry may condition on in v0.1: the resolved worker class. */
export interface Facts {
  readonly workerClass?: string;
}

export interface LookupMatch {
  readonly entry: KbEntry;
  /** `default: <source> (<range>; <basis>)`, exactly as printed. */
  readonly citation: string;
  /** The part of the queried interval this entry's range covers. */
  readonly overlap: VersionInterval;
  /**
   * True when the entry has a condition (a worker class) and no fact was
   * given to check it against. The entry is returned, never silently dropped,
   * but it does not count towards `covered`.
   */
  readonly conditionUnverified: boolean;
}

export interface LookupResult {
  /** Every overlapping entry, in range order then id; empty when no range covers the interval. */
  readonly matches: readonly LookupMatch[];
  /** True only when the verified matches together cover every version of the interval. */
  readonly covered: boolean;
}

/** `22.23.2`, or `5 releases from 22.12.0 to 22.23.5` for several: exactly the releases that were run. */
function releasesText(entry: KbEntry): string {
  const list = entry.measuredVersions;
  if (list === undefined) return entry.measuredOn?.version ?? '(unknown version)';
  const [first] = list;
  const last = list[list.length - 1];
  if (list.length === 1 || first === undefined || last === undefined) {
    return first ?? '(unknown version)';
  }
  return `${list.length} releases from ${first} to ${last}`;
}

/** The printed basis words (interaction spec grammar). */
export function basisWords(entry: KbEntry): string {
  switch (entry.basis) {
    case 'measured':
      return `measured on ${releasesText(entry)}`;
    case 'documented':
      return 'documented';
    case 'from-source':
      return 'from source, not measured';
    case 'from-changelogs':
      return 'from changelogs, not measured';
    case 'to-be-measured':
      return 'to be measured';
  }
}

function listText(items: readonly (string | number)[]): string {
  const last = items[items.length - 1];
  return items.length <= 1 ? String(last) : `${items.slice(0, -1).join(', ')} and ${last}`;
}

/** What the explicit setting is, for the basis words: its value in seconds, and whether it was written in `createServer` options. */
export interface ExplicitUse {
  readonly kSeconds: number;
  readonly viaOptions?: boolean;
}

/**
 * The basis words of an explicit-setting entry, exactly what was run (B3, second review
 * m-a and m-b):
 * - assigned value, K measured: `measured at K = 7, 12 and 65 s on 5 releases from A to B`;
 * - K not one of the measured values: `K = 30 s interpolated between measured K = 7, 12 and 65 s ...`;
 * - options form: `options form measured at K = 7 s on A and B, at K = 65 s on C`, or, when the
 *   line has no options-form run, `options form not measured on this line; ` and the assigned text.
 * Without `use` (a listing) the assigned text of the entry is given.
 */
export function explicitBasisWords(entry: KbEntry, use?: ExplicitUse): string {
  const releases = releasesText(entry);
  const ks =
    entry.measuredKs === undefined ? undefined : [...entry.measuredKs].sort((x, y) => x - y);
  const interpolated = (k: number, measured: readonly number[] | undefined, what: string) =>
    measured !== undefined && !measured.includes(k)
      ? `K = ${k} s interpolated between ${what}`
      : what;
  const assigned = (): string => {
    if (ks === undefined) {
      const span = entry.measuredSpan;
      if (span === undefined) return `measured on ${releases}`;
      return span.min === span.max
        ? `measured at ${span.min} s on ${releases}`
        : `measured from ${span.min} to ${span.max} s on ${releases}`;
    }
    const plain = `measured K = ${listText(ks)} s on ${releases}`;
    if (use !== undefined && !ks.includes(use.kSeconds)) {
      return `K = ${use.kSeconds} s interpolated between ${plain}`;
    }
    return `measured at K = ${listText(ks)} s on ${releases}`;
  };
  if (use?.viaOptions !== true) return assigned();
  const groups = entry.measuredOptions;
  if (groups === undefined) return `options form not measured on this line; ${assigned()}`;
  const runs = [...groups]
    .sort((x, y) => x.k - y.k)
    .map((g) => `at K = ${g.k} s on ${listText(g.versions)}`)
    .join(', ');
  return interpolated(
    use.kSeconds,
    groups.map((g) => g.k),
    `options form measured ${runs}`,
  );
}

/** `default: <source> (<range>; <basis>)`, or `default: <source> (<basis>)` with no range label. */
export function citationFor(entry: KbEntry): string {
  const inner =
    entry.rangeLabel === undefined
      ? basisWords(entry)
      : `${entry.rangeLabel}; ${basisWords(entry)}`;
  return `default: ${entry.citationName} (${inner})`;
}

/** A knowledge-base value may support PASS unless its basis is `to be measured`. */
export function supportsPass(entry: KbEntry): boolean {
  return entry.basis !== 'to-be-measured' && entry.value !== 'n/a';
}

/**
 * The entry's value as a sourced value with a `default` source. With
 * `assumed: true` the basis is `assumed` (a load-balancer default that no file
 * sets). Returns undefined for an `n/a` entry, which has no number.
 */
export function sourcedValueFromEntry(
  entry: KbEntry,
  options: { assumed?: boolean } = {},
): SourcedValue | undefined {
  if (entry.value === 'n/a') return undefined;
  const basis = options.assumed
    ? ('assumed' as const)
    : (
        {
          measured: 'measured-on',
          documented: 'documented',
          'from-source': 'from-source-not-measured',
          'from-changelogs': 'from-changelogs-not-measured',
          'to-be-measured': 'to-be-measured',
        } as const
      )[entry.basis];
  return makeSourcedValue({
    value: entry.value,
    unit: entry.unit,
    source: defaultSource({
      citation: entry.citationName,
      basisText: basisWords(entry),
      ...(entry.rangeLabel === undefined ? {} : { range: entry.rangeLabel }),
      entryId: entry.id,
    }),
    basis,
  });
}

export class KnowledgeBase {
  readonly entries: readonly KbEntry[];
  private readonly ranges: ReadonlyMap<string, VersionInterval>;

  constructor(entries: readonly KbEntry[]) {
    this.entries = entries;
    const ranges = new Map<string, VersionInterval>();
    for (const entry of entries) {
      const parsed = parseRange(entry.applies.versionRange);
      if (parsed === undefined) throw new TypeError('knowledge base holds a malformed range');
      ranges.set(entry.id, parsed);
    }
    this.ranges = ranges;
  }

  entry(id: string): KbEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Entries whose basis is `to be measured`: they never support PASS and block release. */
  releaseBlockers(): readonly KbEntry[] {
    return this.entries.filter((e) => e.basis === 'to-be-measured');
  }

  lookup(subject: KbSubject, interval: VersionInterval, facts: Facts = {}): LookupResult {
    if (isEmpty(interval)) return { matches: [], covered: false };
    const matches: LookupMatch[] = [];
    for (const entry of this.entries) {
      if (entry.subject !== subject) continue;
      const range = this.ranges.get(entry.id);
      if (range === undefined || !intervalsOverlap(interval, range)) continue;
      let conditionUnverified = false;
      if (entry.applies.condition !== undefined) {
        const classes = parseCondition(entry.applies.condition) ?? [];
        if (facts.workerClass === undefined) {
          conditionUnverified = true;
        } else if (!classes.includes(facts.workerClass)) {
          continue;
        }
      }
      matches.push({
        entry,
        citation: citationFor(entry),
        overlap: intersect(interval, range),
        conditionUnverified,
      });
    }
    matches.sort((a, b) => {
      const byRange = compareVersions(a.overlap.lower, b.overlap.lower);
      return byRange !== 0
        ? byRange
        : a.entry.id < b.entry.id
          ? -1
          : a.entry.id > b.entry.id
            ? 1
            : 0;
    });
    const covered = isCovered(
      interval,
      matches.filter((m) => !m.conditionUnverified).map((m) => m.overlap),
    );
    return { matches, covered };
  }
}

export function loadKnowledgeBase(files: readonly unknown[]): KnowledgeBase {
  return new KnowledgeBase(loadKbEntries(files));
}
