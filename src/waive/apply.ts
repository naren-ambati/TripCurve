// WaiverApplier: the one place a waiver is judged and applied. It runs after
// the rules, over their findings, and changes nothing a rule decided except to wrap a finding that is
// not a pass in WAIVED, which keeps its original kind and headline. It reads no clock: the date of the
// run is an input.
//
// What it guarantees (the honesty rules of waivers):
//   - a waiver covers FAIL, WARN, UNRESOLVED, VERSION-DEPENDENT and NOT EVALUATED, never PASS or N/A
//     (waiveFinding is the one wrapper and refuses anything else);
//   - an invalid waiver suppresses nothing: the finding keeps its real result, and the waiver is
//     listed with what is wrong;
//   - an expired waiver (a date before today; the date itself still applies) suppresses nothing, and
//     the finding says the waiver expired on its date;
//   - a waiver that matches no finding is listed;
//   - a waiver never covers more than one finding, and a finding is never covered by two waivers:
//     whatever is ambiguous is listed as invalid, so no waiver can hide a finding it was not written for.
// Every waiver lands in exactly one state: applied, expired, unmatched or invalid.

import {
  type Finding,
  inputText,
  inputTextEquals,
  isWaivableKind,
  noteExpiredWaiver,
  type QueueRef,
  type RuleId,
  type SourceRef,
  type WaiverInfo,
  type WorkloadName,
  type WorkloadRef,
  waiveFinding,
} from '../core/index.js';
import type { WorkloadFindings } from '../evaluate/index.js';
import {
  type InputFile,
  type IntakeDocument,
  type IntakeResult,
  type RawWaiverRecord,
  rawInputTextForParser,
  rawTextForParser,
  type TfResource,
} from '../parse/index.js';
import { hasExpired, isIsoDate } from './dates.js';
import { type AppliedWaiver, WAIVER_PROBLEMS, type WaiverProblemCode } from './model.js';
import { isRuleText, type ReadWaiver, readWaiver, type WaiverTarget } from './read-waiver.js';

export interface ApplyInput {
  readonly results: readonly WorkloadFindings[];
  readonly records: readonly RawWaiverRecord[];
  /** Every workload read (`knownWorkloads`), also those that were not checked. */
  readonly knownWorkloads: readonly WorkloadRef[];
  readonly intake: IntakeResult;
  readonly terraform: readonly TfResource[];
  /** The UTC date of the run, `YYYY-MM-DD`; the one clock input. Absent or malformed: no waiver can be judged. */
  readonly today: string | undefined;
}

export interface ApplyOutput {
  /** The same blocks, with each covered finding wrapped (WAIVED) or marked as having an expired waiver. */
  readonly results: readonly WorkloadFindings[];
  /** Every waiver, in the order the readers gave them. */
  readonly waivers: readonly AppliedWaiver[];
}

// ---- where a line belongs ------------------------------------------------------------------------

interface Segment extends Span {
  readonly key: string;
  /** For an item of a List that has another item after it: the line that next item starts on. */
  readonly nextItemLine?: number;
}

interface DocumentSpan extends Span {
  readonly doc: IntakeDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The line ranges of the objects of one YAML document. A whole document is one object; a `List` is
 * one object per item. When the item lines cannot be told apart the whole document is one range, so a
 * waiver in it matches every object in it and is rejected as ambiguous rather than guessed.
 */
function segmentsOf(doc: IntakeDocument): readonly Segment[] {
  const whole: Segment[] = [
    { key: String(doc.index), first: doc.blockFirstLine, last: doc.blockLastLine },
  ];
  const value = doc.value;
  if (!isRecord(value)) return whole;
  const kind = Object.hasOwn(value, 'kind') ? value.kind : undefined;
  const items = Object.hasOwn(value, 'items') ? value.items : undefined;
  if (typeof kind !== 'string' || !kind.endsWith('List') || !Array.isArray(items)) return whole;
  const starts: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const at = doc.sourceAt(['items', i]);
    if (at.type === 'default') return whole;
    const previous = starts[i - 1] ?? doc.blockFirstLine - 1;
    if (at.line <= previous) return whole;
    starts.push(at.line);
  }
  return items.map((_item, i) => ({
    key: `${doc.index}.${i}`,
    first: starts[i] as number,
    last: i + 1 < starts.length ? (starts[i + 1] as number) - 1 : doc.blockLastLine,
    ...(i + 1 < starts.length ? { nextItemLine: starts[i + 1] as number } : {}),
  }));
}

/** The last index whose `start` is at or before `line` in a list sorted by start; -1 when there is none. */
function lastStartingAtOrBefore(starts: readonly number[], line: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

interface Span {
  readonly first: number;
  readonly last: number;
}

/** Spans in order of their first line, with the first lines kept for the binary search. */
interface Spans<T extends Span> {
  readonly items: readonly T[];
  readonly starts: readonly number[];
}

function spansOf<T extends Span>(list: readonly T[]): Spans<T> {
  const items = [...list].sort((a, b) => a.first - b.first);
  return { items, starts: items.map((i) => i.first) };
}

/** The span that contains `line`, or undefined. Spans do not overlap, so the last one starting at or before it is the only candidate. */
function spanAt<T extends Span>(spans: Spans<T>, line: number): T | undefined {
  const found = spans.items[lastStartingAtOrBefore(spans.starts, line)];
  return found !== undefined && line <= found.last ? found : undefined;
}

const NO_SPANS: Spans<Span> = { items: [], starts: [] };

/** A line that ends a YAML document: its end marker `...`, or a directive (`%YAML 1.2`). */
function isDocumentEnd(line: string): boolean {
  const t = line.trim();
  return t === '...' || t.startsWith('%') || t.startsWith('... ');
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function indentOf(line: string): number {
  let n = 0;
  while (line[n] === ' ' || line[n] === '\t') n += 1;
  return n;
}

/**
 * Tells which object (a YAML object, or a Terraform resource) holds a line of a file. Every lookup is a
 * binary search, so a file full of waivers is matched in time linear (times a logarithm) in its size.
 */
class Locator {
  private readonly files = new Map<string, InputFile>();
  private readonly terraform = new Map<string, Spans<Span>>();
  private readonly documents = new Map<string, Spans<DocumentSpan>>();
  private readonly segments = new Map<IntakeDocument, Spans<Segment>>();
  private readonly lineTexts = new Map<string, readonly string[]>();
  private readonly tails = new Map<string, { start: number; lastEnd: number }>();

  constructor(intake: IntakeResult, resources: readonly TfResource[]) {
    for (const file of intake.files)
      this.files.set(rawInputTextForParser(file.canonicalPath), file);
    const byFile = new Map<string, Span[]>();
    for (const resource of resources) {
      if (resource.source.type !== 'file' || resource.endLine === undefined) continue;
      const path = rawInputTextForParser(resource.source.file);
      const list = byFile.get(path) ?? [];
      list.push({ first: resource.source.line, last: resource.endLine });
      byFile.set(path, list);
    }
    for (const [path, list] of byFile) this.terraform.set(path, spansOf(list));
  }

  private documentsOf(path: string, file: InputFile): Spans<DocumentSpan> {
    let spans = this.documents.get(path);
    if (spans === undefined) {
      spans = spansOf(
        (file.documents ?? []).map((doc) => ({
          first: doc.blockFirstLine,
          last: doc.blockLastLine,
          doc,
        })),
      );
      this.documents.set(path, spans);
    }
    return spans;
  }

  private segmentsOf(doc: IntakeDocument): Spans<Segment> {
    let spans = this.segments.get(doc);
    if (spans === undefined) {
      spans = spansOf(segmentsOf(doc));
      this.segments.set(doc, spans);
    }
    return spans;
  }

  /** The key of the object whose lines contain `line` of `source`'s file, or undefined when none does. */
  locate(source: SourceRef): string | undefined {
    if (source.type !== 'file' && source.type !== 'declared') return undefined;
    const path = rawInputTextForParser(source.file);
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    const line = source.line;
    const resource = spanAt(this.terraform.get(path) ?? NO_SPANS, line);
    if (resource !== undefined) return `${path}\u0000tf\u0000${resource.first}`;
    const segment = this.segmentOf(path, file, line);
    return segment === undefined ? undefined : `${path}\u0000yaml\u0000${segment.key}`;
  }

  private segmentOf(path: string, file: InputFile, line: number): Segment | undefined {
    const found = spanAt(this.documentsOf(path, file), line);
    return found === undefined ? undefined : spanAt(this.segmentsOf(found.doc), line);
  }

  private linesOf(path: string, file: InputFile): readonly string[] {
    let lines = this.lineTexts.get(path);
    if (lines === undefined) {
      const text = rawTextForParser(file);
      const starts = file.lineIndex;
      lines = starts.map((from, i) => text.slice(from, starts[i + 1] ?? text.length));
      this.lineTexts.set(path, lines);
    }
    return lines;
  }

  /**
   * The run of blank, comment, `...` and `%` lines that ends a block (cached per block): its first line,
   * and the last line in it that ends a document (0 when none does).
   */
  private tailOf(path: string, segment: Segment, lines: readonly string[]) {
    const id = `${path}\u0000${segment.key}`;
    let tail = this.tails.get(id);
    if (tail === undefined) {
      let start = segment.last + 1;
      let lastEnd = 0;
      while (start - 1 >= segment.first) {
        const text = lines[start - 2] ?? '';
        const end = isDocumentEnd(text);
        if (!end && !isBlankOrComment(text)) break;
        if (end && lastEnd === 0) lastEnd = start - 1;
        start -= 1;
      }
      tail = { start, lastEnd };
      this.tails.set(id, tail);
    }
    return tail;
  }

  /**
   * Whether a comment line sits BETWEEN two blocks: in the run of comment-only lines directly before a
   * `---` that starts the next document, or directly before the `- ` of the next item of a List (at that
   * item's indent or less). Such a comment could belong to either neighbour, so it belongs to neither.
   * A comment inside a block, or after the last block, is not between.
   */
  isBetween(source: SourceRef): boolean {
    if (source.type !== 'file' && source.type !== 'declared') return false;
    const path = rawInputTextForParser(source.file);
    const file = this.files.get(path);
    if (file === undefined) return false;
    const segment = this.segmentOf(path, file, source.line);
    if (segment === undefined) return false;
    const lines = this.linesOf(path, file);
    let maxIndent = Number.POSITIVE_INFINITY;
    if (segment.nextItemLine !== undefined) {
      maxIndent = indentOf(lines[segment.nextItemLine - 1] ?? '');
    }
    const tail = this.tailOf(path, segment, lines);
    if (source.line < tail.start) return false;
    if (segment.nextItemLine === undefined) {
      // a comment is between when a `---`, or a `...` or directive line after it, ends the document
      const endsAfter = (lines[segment.last] ?? '').trimStart().startsWith('---');
      if (!endsAfter && tail.lastEnd <= source.line) return false;
    }
    return indentOf(lines[source.line - 1] ?? '') <= maxIndent;
  }
}

// ---- who a waiver names --------------------------------------------------------------------------

type Subject = WorkloadRef | QueueRef;

function isQueue(subject: Subject): subject is QueueRef {
  return 'mapping' in subject;
}

function identity(subject: Subject): string {
  if (isQueue(subject)) return `m\u0000${rawInputTextForParser(subject.mapping)}`;
  const kind =
    typeof subject.kind === 'string' ? subject.kind : `?${rawInputTextForParser(subject.kind)}`;
  return `w\u0000${kind}\u0000${rawInputTextForParser(subject.namespace)}\u0000${rawInputTextForParser(subject.name)}`;
}

function subjectName(subject: Subject): WorkloadName {
  return isQueue(subject)
    ? { name: subject.mapping }
    : { name: subject.name, namespace: subject.namespace };
}

function matchesTarget(target: WaiverTarget, subject: Subject): boolean {
  if (isQueue(subject)) {
    return (
      target.namespace === undefined &&
      target.kind === undefined &&
      inputTextEquals(target.name, subject.mapping)
    );
  }
  return (
    inputTextEquals(target.name, subject.name) &&
    (target.namespace === undefined || inputTextEquals(target.namespace, subject.namespace)) &&
    (target.kind === undefined || subject.kind === target.kind)
  );
}

// ---- classification ------------------------------------------------------------------------------

interface Judged {
  readonly read: ReadWaiver;
  readonly workload?: WorkloadName;
  readonly problem?: WaiverProblemCode;
  readonly unmatched?: boolean;
  /** Set when the waiver names exactly one non-pass finding. */
  readonly claim?: { readonly block: number; readonly finding: number };
}

function waiverFor(read: ReadWaiver, judged: Omit<Judged, 'read'>): Judged {
  return { read, ...judged };
}

/** What the blocks look like from the outside, built once so that each waiver is matched without a scan. */
interface Index {
  readonly blocksByKey: ReadonlyMap<string, readonly number[]>;
  readonly blocksByIdentity: ReadonlyMap<string, readonly number[]>;
  /** Every distinct workload or mapping read or evaluated, by the name it goes by. */
  readonly subjectsByName: ReadonlyMap<string, readonly Subject[]>;
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function nameKey(subject: Subject): string {
  return rawInputTextForParser(isQueue(subject) ? subject.mapping : subject.name);
}

function buildIndex(input: ApplyInput, locator: Locator): Index {
  const blocksByKey = new Map<string, number[]>();
  const blocksByIdentity = new Map<string, number[]>();
  input.results.forEach((block, i) => {
    const key = locator.locate(block.file);
    if (key !== undefined) push(blocksByKey, key, i);
    push(blocksByIdentity, identity(block.workload), i);
  });
  const subjectsByName = new Map<string, Subject[]>();
  const seen = new Set<string>();
  for (const subject of [...input.results.map((r) => r.workload), ...input.knownWorkloads]) {
    const id = identity(subject);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = nameKey(subject);
    const list = subjectsByName.get(name);
    if (list === undefined) subjectsByName.set(name, [subject]);
    else list.push(subject);
  }
  return { blocksByKey, blocksByIdentity, subjectsByName };
}

/** Judges one waiver against the blocks: its form, whose it is, and which finding it names. */
function judge(
  read: ReadWaiver,
  input: ApplyInput,
  locator: Locator,
  index: Index,
  todayKnown: boolean,
): Judged {
  if (read.problem !== undefined) return waiverFor(read, { problem: read.problem });
  if (!todayKnown) return waiverFor(read, { problem: 'no-date-known' });
  const rule = read.ruleText as RuleId;

  let blockIndex: number;
  let workload: WorkloadName | undefined;
  if (read.record.mechanism === 'inline') {
    const key = locator.locate(read.record.source);
    const hits = key === undefined ? [] : (index.blocksByKey.get(key) ?? []);
    if (hits.length === 0) return waiverFor(read, { problem: 'outside-block' });
    if (hits.length > 1) return waiverFor(read, { problem: 'several-findings' });
    if (locator.isBetween(read.record.source)) {
      return waiverFor(read, { problem: 'between-blocks' });
    }
    blockIndex = hits[0] as number;
  } else {
    const target = read.target as WaiverTarget;
    workload = { name: target.name, ...(target.namespace ? { namespace: target.namespace } : {}) };
    const named = (index.subjectsByName.get(rawInputTextForParser(target.name)) ?? []).filter((s) =>
      matchesTarget(target, s),
    );
    if (named.length === 0) return waiverFor(read, { workload, problem: 'unknown-workload' });
    if (named.length > 1) return waiverFor(read, { workload, problem: 'ambiguous-workload' });
    const hits = index.blocksByIdentity.get(identity(named[0] as Subject)) ?? [];
    if (hits.length === 0) return waiverFor(read, { workload, unmatched: true });
    if (hits.length > 1) return waiverFor(read, { workload, problem: 'several-findings' });
    blockIndex = hits[0] as number;
  }
  const block = input.results[blockIndex] as WorkloadFindings;
  workload ??= subjectName(block.workload);
  const findingIndex = block.findings.findIndex((f) => f.rule === rule);
  const finding = block.findings[findingIndex];
  // A finding that is a pass, or not applicable, is not waivable: the waiver matches nothing.
  if (finding === undefined || !isWaivableKind(finding.kind)) {
    return waiverFor(read, { workload, unmatched: true });
  }
  return waiverFor(read, { workload, claim: { block: blockIndex, finding: findingIndex } });
}

function applied(
  judged: Judged,
  state: AppliedWaiver['state'],
  problem?: WaiverProblemCode,
): AppliedWaiver {
  const { read } = judged;
  const ruleText = read.ruleText;
  return {
    rule: isRuleText(ruleText) ? ruleText : inputText(ruleText ?? ''),
    ...(judged.workload === undefined ? {} : { workload: judged.workload }),
    source: read.record.source,
    mechanism: read.record.mechanism,
    state,
    until:
      read.untilText !== undefined && isIsoDate(read.untilText)
        ? read.untilText
        : inputText(read.untilText ?? ''),
    reason: read.reason,
    text: read.text,
    ...(problem === undefined ? {} : { problem: WAIVER_PROBLEMS[problem] }),
  };
}

export function applyWaivers(input: ApplyInput): ApplyOutput {
  if (input.records.length === 0) return { results: input.results, waivers: [] };
  const todayKnown = input.today !== undefined && isIsoDate(input.today);
  const today = input.today as string;
  const locator = new Locator(input.intake, input.terraform);
  const index = buildIndex(input, locator);
  const judged = input.records.map((record) =>
    judge(readWaiver(record), input, locator, index, todayKnown),
  );

  // A finding named by two waivers is covered by neither: which one would win is a choice no file made.
  const byFinding = new Map<string, number[]>();
  judged.forEach((j, i) => {
    if (j.claim === undefined) return;
    const key = `${j.claim.block}:${j.claim.finding}`;
    const list = byFinding.get(key);
    if (list === undefined) byFinding.set(key, [i]);
    else list.push(i);
  });
  const shared = new Set<number>();
  for (const list of byFinding.values()) {
    if (list.length > 1) for (const i of list) shared.add(i);
  }

  const replaced = new Map<string, Finding>();
  const waivers: AppliedWaiver[] = judged.map((j, i) => {
    if (shared.has(i)) return applied(j, 'invalid', 'shared-finding');
    if (j.problem !== undefined) return applied(j, 'invalid', j.problem);
    if (j.unmatched === true || j.claim === undefined) return applied(j, 'unmatched');
    const block = input.results[j.claim.block] as WorkloadFindings;
    const finding = block.findings[j.claim.finding] as Finding;
    const until = j.read.untilText as string;
    const info: WaiverInfo = {
      until,
      reason: j.read.reason,
      source: j.read.record.source,
      mechanism: j.read.record.mechanism,
    };
    const expired = hasExpired(until, today);
    replaced.set(
      `${j.claim.block}:${j.claim.finding}`,
      expired ? noteExpiredWaiver(finding, info) : waiveFinding(finding, info),
    );
    return applied(j, expired ? 'expired' : 'applied');
  });

  const results = input.results.map((block, b) => {
    if (!block.findings.some((_f, f) => replaced.has(`${b}:${f}`))) return block;
    return { ...block, findings: block.findings.map((f, i) => replaced.get(`${b}:${i}`) ?? f) };
  });
  return { results, waivers };
}
