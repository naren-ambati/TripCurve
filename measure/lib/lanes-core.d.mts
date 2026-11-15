// Types for lanes-core.mjs, so the typechecked tests can import it.

export interface RawEntry {
  id: string;
  subject: string;
  value: number | 'n/a';
  unit: 's' | 'ms';
  applies: { runtime: string; versionRange: string; condition?: string };
  docUrl?: string;
  docDate?: string;
  basis?: string;
  measuredOn?: { version: string; date: string; platform: string };
  measuredSpan?: { min: number; max: number };
  measuredVersions?: string[];
  measuredKs?: number[];
  measuredOptions?: { k: number; versions: string[] }[];
  scriptRef?: string | { notMeasurableLocally: string };
  toleranceMs?: number;
  toleranceRelative?: number;
  sources?: string[];
  toleranceMsAt?: Record<string, number>;
  deferredTo?: { bolt: string; reason: string };
}

export interface Companion {
  runtime: string;
  ranges: string[];
}

export type Check =
  | {
      type: 'idleClose';
      workerClass?: string;
      observed?: { keepAliveTimeout?: number; keepAliveTimeoutBuffer?: number };
      companion?: Companion;
    }
  | { type: 'syncCloses'; workerClass?: string }
  | { type: 'closeAt'; responseComplete: boolean; companion?: Companion }
  | { type: 'noCeiling' }
  | { type: 'handlerStart' };

export interface Case {
  entryId: string;
  label: string;
  runtime: string;
  version: string;
  script: string;
  toolchain: 'node' | 'venv' | 'lightship';
  venv?: 'g26' | 'g27';
  args: string[];
  check: Check;
  expectedMs: number | null;
  toleranceMs: number;
  covers?: { version: string; cls?: string; source?: string; k?: number; form?: string };
}

export interface Verdict {
  ok: boolean;
  entryId: string;
  label: string;
  measured: string;
  entry: string;
  tolerance: string;
  margin: string;
  reason: string | null;
}

export interface Gap {
  entryId: string;
  field: string;
  message: string;
}

export function parseVersion(text: unknown): { major: number; minor: number; patch: number } | null;
export function compareVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number;
export function parseRange(text: unknown): {
  lower?: { major: number; minor: number; patch: number };
  upper?: { major: number; minor: number; patch: number };
} | null;
export function inRange(range: NonNullable<ReturnType<typeof parseRange>>, version: string): boolean;
export function loadEntries(kbDir: string): RawEntry[];
export function pinnedVersions(entry: RawEntry): string[];
export function kbGaps(entries: readonly RawEntry[], measureDir: string): Gap[];
export function releaseBlockerIds(entries: readonly RawEntry[]): string[];
export function statedReasons(entries: readonly RawEntry[]): { entryId: string; reason: string }[];
export function planCases(
  entry: RawEntry,
  options?: { versions?: readonly string[]; full?: boolean; entries?: readonly RawEntry[] },
): Case[];
export function reportedVersion(line: unknown, runtime: string): string | undefined;
export function compareLine(c: Case, line: unknown): Verdict;
export function formatVerdict(v: Verdict): string;
export function runCases(
  cases: readonly Case[],
  runOne: (c: Case) => Promise<unknown>,
  jobs?: number,
  onVerdict?: (v: Verdict) => void,
): Promise<Verdict[]>;
export function judgeLane(input: {
  entries: readonly RawEntry[];
  verdicts: readonly Verdict[];
  drift?: readonly string[];
  partial?: boolean;
  busy?: boolean;
}): { ok: boolean; lines: string[] };
export function latestTargets(
  entries: readonly RawEntry[],
  releasesByRuntime: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]>;
export function newerOutsideRanges(
  entries: readonly RawEntry[],
  newestByRuntime: Readonly<Record<string, readonly string[]>>,
): string[];
export function deferredEntries(
  entries: readonly RawEntry[],
): { entryId: string; bolt: string; reason: string }[];
export function derivedToleranceMs(deviationsMs: readonly number[], resolutionMs: number): number;
export function coverageGaps(entry: RawEntry): string[];
export function unrecognisedVersions(list: readonly string[]): string[];
