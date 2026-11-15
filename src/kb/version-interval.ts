// A small hand-written version interval type. There is
// no version-comparison library: Node release lines are not monotonic (a 24.x
// release can be older than 22.19), so knowledge-base ranges are per line and
// compared by explicit bounds.
//
// An interval is half-open on (major, minor, patch) triples: [lower, upper),
// where `upper: null` means unbounded. Examples:
//   exact 22.23.2     -> [22.23.2, 22.23.3)
//   partial 22.23     -> [22.23.0, 22.24.0)
//   partial 22        -> [22.0.0, 23.0.0)
//   unknown           -> [0.0.0, unbounded)   (all versions)
//
// Scope in B1: exact, partial and unknown versions, the knowledge-base range
// grammar, intersection, overlap, coverage. `narrow` understands only that
// same range grammar; any other `engines` text leaves the interval as it is,
// which is safe because narrowing is optional and only ever removes versions.

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface VersionInterval {
  /** Inclusive lower bound. */
  readonly lower: Version;
  /** Exclusive upper bound; null when unbounded. */
  readonly upper: Version | null;
}

// Each part has at most 15 digits, so it is below 2^53 and stays an exact
// integer. The grammar is anchored and has no nested repetition: linear time.
const MAX_DIGITS = 15;
const VERSION_RE = new RegExp(
  `^v?(\\d{1,${MAX_DIGITS}})(?:\\.(\\d{1,${MAX_DIGITS}}))?(?:\\.(\\d{1,${MAX_DIGITS}}))?$`,
);

const ZERO: Version = Object.freeze({ major: 0, minor: 0, patch: 0 });

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function make(lower: Version, upper: Version | null): VersionInterval {
  return Object.freeze({ lower: Object.freeze(lower), upper: upper && Object.freeze(upper) });
}

/** All versions. */
export function unknownInterval(): VersionInterval {
  return make(ZERO, null);
}

/** The exact version `major.minor.patch` as an interval. */
export function exactInterval(major: number, minor: number, patch: number): VersionInterval {
  return make({ major, minor, patch }, { major, minor, patch: patch + 1 });
}

/**
 * Text to an interval: exact (22.23.2), partial (22.23, 22) or unknown (all
 * versions) for anything else. A leading `v` is allowed. It never throws, on
 * any text.
 */
export function parseVersion(text: string): VersionInterval {
  if (typeof text !== 'string') return unknownInterval();
  const m = VERSION_RE.exec(text);
  if (!m) return unknownInterval();
  const major = Number(m[1]);
  if (m[2] === undefined) {
    return make({ major, minor: 0, patch: 0 }, { major: major + 1, minor: 0, patch: 0 });
  }
  const minor = Number(m[2]);
  if (m[3] === undefined) {
    return make({ major, minor, patch: 0 }, { major, minor: minor + 1, patch: 0 });
  }
  return exactInterval(major, minor, Number(m[3]));
}

export function isEmpty(interval: VersionInterval): boolean {
  return interval.upper !== null && compareVersions(interval.lower, interval.upper) >= 0;
}

export function containsVersion(interval: VersionInterval, v: Version): boolean {
  return (
    compareVersions(interval.lower, v) <= 0 &&
    (interval.upper === null || compareVersions(v, interval.upper) < 0)
  );
}

export function intersect(a: VersionInterval, b: VersionInterval): VersionInterval {
  const lower = compareVersions(a.lower, b.lower) >= 0 ? a.lower : b.lower;
  let upper: Version | null;
  if (a.upper === null) upper = b.upper;
  else if (b.upper === null) upper = a.upper;
  else upper = compareVersions(a.upper, b.upper) <= 0 ? a.upper : b.upper;
  return make(lower, upper);
}

// A range is `*`, or one or two comparators `>=X.Y.Z` and `<X.Y.Z` separated
// by one space (lower bound first). Versions in a range are complete X.Y.Z.
const COMPARATOR_RE = new RegExp(
  `^(>=|<)(\\d{1,${MAX_DIGITS}})\\.(\\d{1,${MAX_DIGITS}})\\.(\\d{1,${MAX_DIGITS}})$`,
);

/** Range text to an interval, or undefined when the text is not in the grammar. */
export function parseRange(text: string): VersionInterval | undefined {
  if (typeof text !== 'string') return undefined;
  if (text === '*') return unknownInterval();
  const parts = text.split(' ');
  if (parts.length > 2) return undefined;
  let lower: Version = ZERO;
  let upper: Version | null = null;
  let seenLower = false;
  let seenUpper = false;
  for (const part of parts) {
    const m = COMPARATOR_RE.exec(part);
    if (!m) return undefined;
    const v: Version = { major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) };
    if (m[1] === '>=') {
      if (seenLower || seenUpper) return undefined; // lower bound once, and first
      lower = v;
      seenLower = true;
    } else {
      if (seenUpper) return undefined;
      upper = v;
      seenUpper = true;
    }
  }
  const interval = make(lower, upper);
  return isEmpty(interval) ? undefined : interval;
}

/** True when the two intervals share at least one version. Empty intervals overlap nothing. */
export function intervalsOverlap(a: VersionInterval, b: VersionInterval): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return !isEmpty(intersect(a, b));
}

/**
 * `overlaps(interval, range)`. A range string that is not in the grammar is
 * a malformed knowledge-base entry (the loader rejects those), so it throws
 * rather than answering "no overlap" and dropping an entry silently.
 */
export function overlaps(interval: VersionInterval, range: string): boolean {
  const parsed = parseRange(range);
  if (parsed === undefined) throw new TypeError('malformed version range');
  return intervalsOverlap(interval, parsed);
}

/**
 * `narrow(interval, engines)`: the interval cut by an `engines` range. Only
 * the knowledge-base range grammar is understood here (B1); any other text
 * returns the interval unchanged, which is safe because it can only be wider.
 * `engines` only narrows; it never picks a version.
 */
export function narrow(interval: VersionInterval, engines: string): VersionInterval {
  const parsed = parseRange(engines);
  return parsed === undefined ? interval : intersect(interval, parsed);
}

/**
 * True when the union of `parts` covers every version of `interval`. An empty
 * interval is not covered (nothing is established for it).
 */
export function isCovered(interval: VersionInterval, parts: readonly VersionInterval[]): boolean {
  if (isEmpty(interval)) return false;
  const sorted = parts
    .map((p) => intersect(p, interval))
    .filter((p) => !isEmpty(p))
    .sort((x, y) => compareVersions(x.lower, y.lower));
  let reached: Version = interval.lower; // everything below `reached` is covered
  for (const part of sorted) {
    if (compareVersions(part.lower, reached) > 0) return false; // a gap
    if (part.upper === null) return true;
    if (compareVersions(part.upper, reached) > 0) reached = part.upper;
  }
  return interval.upper !== null && compareVersions(reached, interval.upper) >= 0;
}

function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** A readable label for diagnostics and tests; tripcurve text. */
export function formatInterval(interval: VersionInterval): string {
  if (isEmpty(interval)) return 'no versions';
  if (interval.upper === null) {
    return compareVersions(interval.lower, ZERO) === 0
      ? 'all versions'
      : `${formatVersion(interval.lower)} and later`;
  }
  return `${formatVersion(interval.lower)} up to, not including, ${formatVersion(interval.upper)}`;
}

/** One stretch of a partitioned interval: covered by a part (an entry's range), or a gap no part covers. */
export type Segment<T> =
  | { readonly kind: 'part'; readonly item: T; readonly interval: VersionInterval }
  | { readonly kind: 'gap'; readonly interval: VersionInterval };

/**
 * Cuts `interval` into the stretches the parts cover and the gaps between them:
 * one segment per part, in order of its lower bound, with the part cut to the interval, and one gap
 * for every stretch no part covers. Nothing is dropped and nothing is borrowed from a neighbour: a
 * gap stays a gap. Parts that overlap are each kept (a version in two ranges has two candidates).
 * An empty interval gives no segments. Pure and total.
 */
export function partitionInterval<T>(
  interval: VersionInterval,
  parts: readonly { readonly item: T; readonly interval: VersionInterval }[],
): Segment<T>[] {
  if (isEmpty(interval)) return [];
  const cut = parts
    .map((p) => ({ item: p.item, interval: intersect(p.interval, interval) }))
    .filter((p) => !isEmpty(p.interval))
    .sort((a, b) => compareVersions(a.interval.lower, b.interval.lower));
  const out: Segment<T>[] = [];
  let reached: Version | null = interval.lower; // everything below `reached` is accounted for; null: all
  for (const part of cut) {
    if (reached !== null && compareVersions(part.interval.lower, reached) > 0) {
      out.push({ kind: 'gap', interval: make(reached, part.interval.lower) });
    }
    out.push({ kind: 'part', item: part.item, interval: part.interval });
    if (part.interval.upper === null) reached = null;
    else if (reached !== null && compareVersions(part.interval.upper, reached) > 0) {
      reached = part.interval.upper;
    }
  }
  if (
    reached !== null &&
    (interval.upper === null || compareVersions(reached, interval.upper) < 0)
  ) {
    out.push({ kind: 'gap', interval: make(reached, interval.upper) });
  }
  return out;
}

/** `22.12`, `27` or `18.20.8`: trailing `.0` parts dropped, so a bound reads like a release line. */
function shortVersion(v: Version): string {
  if (v.patch !== 0) return formatVersion(v);
  return v.minor !== 0 ? `${v.major}.${v.minor}` : String(v.major);
}

/**
 * The label of a stretch no entry covers, written from the numbers of the interval only (digits,
 * dots and fixed words): `before 22.12`, `23 to before 24`, `27 and later`. A bound `22.12` means
 * `22.12.0`: the stretch ends before it (`before`) or starts at it.
 */
export function describeGap(interval: VersionInterval): string {
  if (isEmpty(interval)) return 'no versions';
  const fromStart = compareVersions(interval.lower, ZERO) === 0;
  if (interval.upper === null) {
    return fromStart ? 'all versions' : `${shortVersion(interval.lower)} and later`;
  }
  return fromStart
    ? `before ${shortVersion(interval.upper)}`
    : `${shortVersion(interval.lower)} to before ${shortVersion(interval.upper)}`;
}
