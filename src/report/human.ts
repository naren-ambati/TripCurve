// HumanRenderer: the report as terminal text, per the line
// grammar of the interaction spec. Plain ASCII, at most 80 columns, the result
// word written out and padded to 4 columns, colour on the result word only.
//
// Input text is printed only through `quote` (SafeText), after a fixed label or
// inside parentheses, never at the start of a line and never in tripcurve's own
// voice. This file reads no raw InputText (a scan test enforces it).

import {
  BRANCH_UNRESOLVED_TO_BE_MEASURED,
  type Branch,
  type ChainStep,
  type ChainValue,
  type Finding,
  formatDefaultSource,
  type InputText,
  isInputText,
  isNoteValue,
  isSourcedValue,
  isUnresolved,
  type QueueRef,
  type ResultKind,
  type SourcedValue,
  type SourceRef,
  type WorkloadRef,
} from '../core/index.js';
import { formatSeconds } from '../evaluate/index.js';
import type { NotCheckedItem } from '../link/index.js';
import {
  type ConfigError,
  STDIN,
  type UncheckedInput,
  uncheckedReasonWords,
} from '../parse/index.js';
import { quote, quoteText, type Seg, t, wrap, wrapText } from './layout.js';
import type { AppliedWaiver, Report, ReportBlock } from './model.js';
import { CONFIG_REASON_WORDS, WHOLE_FILE_WORDS } from './words.js';

export interface RenderHumanOptions {
  /** `--verbose`: the full chain under PASS and N/A lines, and the basis of declared values. */
  readonly verbose?: boolean;
  /** Colour on the result word only. Off unless the caller (the CLI) decides it is a terminal. */
  readonly color?: boolean;
}

const DETAIL_INDENT = 11;
const LABEL_WIDTH = 16;
const VALUE_COLUMN = DETAIL_INDENT + LABEL_WIDTH + 1;
/** A quoted word in a detail value: the line room (80 - 28) less what can be glued to it. */
const DETAIL_QUOTE_ROOM = 42;
/** A quoted word after the 11-column indent (parenthesised sources, WAIVED continuation). */
const LINE_QUOTE_ROOM = 50;
/** Room for the Helm comment so that `(Helm source comment "...")` fits one line: 11 + 21 + 46 + 1 = 79 columns. */
const HELM_QUOTE_ROOM = 46;
/**
 * Most file names listed in one `source` step. With two names, each cut to 20 columns, a
 * wrapped list always fits on one line with a word of tripcurve's own before it, so a
 * continuation line never starts with quoted input (rule 5).
 */
const MAX_LISTED_FILES = 2;
const LIST_QUOTE_ROOM = 20;
/** Most configuration errors printed (a hostile file can produce thousands). */
const MAX_CONFIG_ERRORS = 10;
/** Most waivers listed as not applied; a hostile file can hold tens of thousands. The summary counts every one. */
const MAX_WAIVERS_LISTED = 50;

const PAD = (n: number): string => ' '.repeat(n);

const COLORS: Readonly<Record<ResultKind, string>> = {
  FAIL: '31',
  WARN: '33',
  UNRESOLVED: '33',
  'VERSION-DEPENDENT': '33',
  'NOT EVALUATED': '33',
  WAIVED: '36',
  PASS: '32',
  'N/A': '2',
};

function paint(word: string, kind: ResultKind, color: boolean): string {
  return color ? `\u001b[${COLORS[kind]}m${word}\u001b[0m` : word;
}

// ---- sources ---------------------------------------------------------------

function sourceSegs(source: SourceRef, room: number): Seg[] {
  switch (source.type) {
    case 'file':
    case 'declared':
      return [quote(source.file, room), t(`:${source.line}`)];
    case 'stdin':
      return [t(`<stdin> document ${source.document}, line ${source.line}`)];
    case 'default':
      return [t(formatDefaultSource(source))];
  }
}

function fileSegs(source: SourceRef, room: number): Seg[] {
  switch (source.type) {
    case 'file':
    case 'declared':
      return [quote(source.file, room)];
    case 'stdin':
      return [t(`<stdin> document ${source.document}`)];
    case 'default':
      return [t(source.citation)];
  }
}

// ---- chain values ------------------------------------------------------------

interface Row {
  readonly label: string;
  readonly value: Seg[];
}

function numberText(value: SourcedValue): string {
  const v = value.value;
  if (typeof v === 'number') {
    if (value.unit === 's') return `${formatSeconds(v)} s`;
    if (value.unit === 'ms') return `${v} ms`;
    return String(v);
  }
  return String(v);
}

function sourcedRow(
  label: string,
  detail: string | undefined,
  v: SourcedValue,
  verbose: boolean,
): Row {
  const value = v.value;
  const segs: Seg[] = [];
  if (isInputText(value)) {
    // A value read from a file that is text (an image tag, a version): quoted, then where it is.
    segs.push(t(detail === undefined ? '' : `${detail} `), quote(value, DETAIL_QUOTE_ROOM));
    segs.push(t(' at '), ...sourceSegs(v.source, DETAIL_QUOTE_ROOM));
    if (verbose && v.source.type === 'declared') segs.push(t(' (declared)'));
    return { label, value: segs };
  }
  if (detail !== undefined) segs.push(t(`${detail}: `));
  // A number computed from literals in a file (Terraform `60 + (30 * 6)`): the expression is shown, quoted
  // as input text, before where it is, so the computation can be checked against the file.
  if (v.expression !== undefined)
    segs.push(t('= '), quote(v.expression, DETAIL_QUOTE_ROOM), t(' at '));
  segs.push(...sourceSegs(v.source, DETAIL_QUOTE_ROOM));
  if (verbose && v.source.type === 'declared') segs.push(t(' (declared)'));
  return { label: `${label} ${numberText(v)}`, value: segs };
}

function textList(first: InputText, more: readonly ChainValue[]): Seg[] {
  const files = [first, ...more.filter((m): m is InputText => isInputText(m))];
  const shown = files.slice(0, MAX_LISTED_FILES);
  const segs: Seg[] = [];
  shown.forEach((file, i) => {
    if (i > 0) segs.push(t(', '));
    segs.push(quote(file, files.length === 1 ? DETAIL_QUOTE_ROOM : LIST_QUOTE_ROOM));
  });
  if (files.length > shown.length) segs.push(t(`, and ${files.length - shown.length} more`));
  return segs;
}

function stepRows(step: ChainStep, verbose: boolean): Row[] {
  const v = step.value;
  const rows: Row[] = [];
  const extras = step.more ?? [];
  if (isSourcedValue(v)) {
    rows.push(sourcedRow(step.label, step.detail, v, verbose));
  } else if (isUnresolved(v)) {
    rows.push({
      label: step.label,
      value: [t(step.detail === undefined ? v.reason : `${step.detail}: ${v.reason}`)],
    });
  } else if (isNoteValue(v)) {
    rows.push({ label: step.label, value: [t(v.note)] });
  } else if (isInputText(v)) {
    const list = textList(v, extras);
    let value: Seg[];
    if (step.detail === undefined) value = list;
    else if (step.plain === true) value = [t(`${step.detail} `), ...list];
    else value = [t(`${step.detail} (`), ...list, t(')')];
    rows.push({ label: step.label, value });
  }
  // Values after the first that are not text each get their own row under the same label.
  for (const extra of extras) {
    if (isInputText(extra)) continue;
    rows.push(...stepRows({ label: step.label, value: extra }, verbose));
  }
  return rows;
}

function detailLines(row: Row): string[] {
  if (row.label.length <= LABEL_WIDTH) {
    return wrap(
      row.value,
      `${PAD(DETAIL_INDENT)}${row.label.padEnd(LABEL_WIDTH)} `,
      PAD(VALUE_COLUMN),
    );
  }
  // A label wider than its column keeps the value column aligned by taking its own line.
  return [PAD(DETAIL_INDENT) + row.label, ...wrap(row.value, PAD(VALUE_COLUMN), PAD(VALUE_COLUMN))];
}

// ---- a long waiver reason -------------------------------------------------------------------------

/** The widest quoted piece of a reason on a line that starts `reason (part 12 of 26) ` (23 columns after the 11 of indent). */
const REASON_CHUNK_ROOM = 44;
/** One escaped character of SafeText output: `\"`, `\\`, `\xNN`, `\uXXXX`, or any other single character. */
const ESCAPED_UNIT = /\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|.)|[^\\]/gs;

/**
 * A reason too long for the rest of its line is printed whole (it is what a reviewer reads), as quoted
 * pieces of at most REASON_CHUNK_ROOM characters, one per line, each after the fixed words `reason (part k of
 * n)` so that no line starts with quoted input. A piece never splits an escape. Short reasons return
 * undefined and stay on the WAIVED line. The reason is at most 200 characters, so this is bounded.
 */
function reasonChunks(reason: InputText): string[] | undefined {
  const full = quoteText(reason, 100_000);
  if (full.length <= LINE_QUOTE_ROOM) return undefined;
  const units = full.slice(1, -1).match(ESCAPED_UNIT) ?? [];
  const pieces: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current.length + unit.length > REASON_CHUNK_ROOM) {
      pieces.push(current);
      current = '';
    }
    current += unit;
  }
  pieces.push(current);
  return pieces.map(
    (piece, i) => `${PAD(DETAIL_INDENT)}reason (part ${i + 1} of ${pieces.length}) "${piece}"`,
  );
}

// ---- finding lines -------------------------------------------------------------

/** The result words of the grammar: padded to 4 columns when shorter. */
function resultWord(kind: ResultKind): string {
  return kind.padEnd(4);
}

const DECIDING_LABEL: Readonly<Record<string, string>> = {
  T1: 'idle close',
  T2: 'preStop',
  T3: 'grace',
  T4: 'visibility',
};

/** The source of the value being checked (rule 8): the deciding source of a PASS or N/A line. */
function decidingSource(finding: Finding): SourceRef | undefined {
  const wanted = DECIDING_LABEL[finding.rule];
  const sourced = finding.chain
    .map((s) => ({ label: s.label, value: s.value, decidedBy: s.decidedBy }))
    .filter((s): s is { label: string; value: SourcedValue; decidedBy: SourceRef | undefined } =>
      isSourcedValue(s.value),
    );
  const match = sourced.find((s) => s.label === wanted) ?? sourced[0];
  return match?.decidedBy ?? match?.value.source;
}

function branchRow(branch: Branch): Row {
  const step = branch.chain[0];
  const value = step?.value;
  const segs: Seg[] = [];
  if (value !== undefined && isUnresolved(value)) {
    // A range with no number for it (no entry covers it, or the rule cannot be applied): the reason, never a value.
    segs.push(t(`unresolved: ${value.reason}`));
  } else if (value !== undefined && isSourcedValue(value) && step !== undefined) {
    segs.push(t(`${step.label} ${numberText(value)} `));
    if (branch.outcome === BRANCH_UNRESOLVED_TO_BE_MEASURED) segs.push(t('to be measured'));
    else {
      segs.push(t(`would ${branch.outcome}`));
      if (value.source.type === 'default') segs.push(t(` (${value.source.basisText})`));
    }
  } else {
    segs.push(
      t(branch.outcome === BRANCH_UNRESOLVED_TO_BE_MEASURED ? 'to be measured' : branch.outcome),
    );
  }
  // `Node 22.x from 22.12` reads `22.x from 22.12` on the line: the block is about Node already.
  return { label: branch.range.replace(/^Node /, ''), value: segs };
}

function findingLines(finding: Finding, verbose: boolean, color: boolean): string[] {
  const out: string[] = [];
  const word = finding.kind === 'WAIVED' ? 'WAIVED' : resultWord(finding.kind);
  const first = `  ${word} ${finding.rule}  `;
  let lines: string[];
  if (
    finding.kind === 'WAIVED' &&
    finding.waiver !== undefined &&
    finding.originalKind !== undefined
  ) {
    const w = finding.waiver;
    const lead = `(was ${finding.originalKind}: ${finding.headline}) until ${w.until}:`;
    const chunks = reasonChunks(w.reason);
    lines =
      chunks === undefined
        ? wrap(
            [
              t(`${lead} reason `),
              quote(w.reason, LINE_QUOTE_ROOM),
              t(' from '),
              ...sourceSegs(w.source, LINE_QUOTE_ROOM),
            ],
            first,
            PAD(DETAIL_INDENT),
          )
        : [
            ...wrap([t(lead)], first, PAD(DETAIL_INDENT)),
            ...chunks,
            ...wrap(
              [t('from '), ...sourceSegs(w.source, LINE_QUOTE_ROOM)],
              PAD(DETAIL_INDENT),
              PAD(DETAIL_INDENT),
            ),
          ];
  } else if (finding.kind === 'PASS' || finding.kind === 'N/A') {
    const source = decidingSource(finding);
    lines = wrap(
      [
        t(finding.headline),
        ...(source === undefined
          ? []
          : [
              t(' ('),
              ...sourceSegs(source, LINE_QUOTE_ROOM),
              t(finding.decidingNote === undefined ? ')' : `, ${finding.decidingNote})`),
            ]),
      ],
      first,
      PAD(first.length),
    );
  } else {
    lines = wrap([t(finding.headline)], first, PAD(first.length));
  }
  // Colour wraps only the result word of the first line.
  const head = lines[0];
  if (head !== undefined && color) {
    lines[0] = `  ${paint(word.trimEnd(), finding.kind, true)}${head.slice(2 + word.trimEnd().length)}`;
  }
  out.push(...lines);

  // A waiver that has expired is said right under the result it no longer covers.
  const expired = finding.expiredWaiver;
  if (expired !== undefined) {
    out.push(
      ...wrapText(`waiver expired on ${expired.until}`, PAD(DETAIL_INDENT), PAD(DETAIL_INDENT)),
    );
    const chunks = reasonChunks(expired.reason);
    out.push(
      ...(chunks === undefined
        ? wrap(
            [
              t('reason '),
              quote(expired.reason, LINE_QUOTE_ROOM),
              t(' from '),
              ...sourceSegs(expired.source, LINE_QUOTE_ROOM),
            ],
            PAD(DETAIL_INDENT),
            PAD(DETAIL_INDENT),
          )
        : [
            ...chunks,
            ...wrap(
              [t('from '), ...sourceSegs(expired.source, LINE_QUOTE_ROOM)],
              PAD(DETAIL_INDENT),
              PAD(DETAIL_INDENT),
            ),
          ]),
    );
  }

  // PASS and N/A are one line; so is WAIVED, whose line already repeats the kind and headline it covers;
  // `--verbose` shows the chain under every result.
  const oneLine = finding.kind === 'PASS' || finding.kind === 'N/A' || finding.kind === 'WAIVED';
  const showChain = verbose || !oneLine;
  if (showChain) {
    for (const step of finding.chain) {
      for (const row of stepRows(step, verbose)) out.push(...detailLines(row));
    }
  }
  if (showChain && finding.branches !== undefined && finding.branches.length > 0) {
    out.push(
      `${PAD(DETAIL_INDENT)}every known ${finding.rangeNoun === undefined ? '' : `${finding.rangeNoun} `}range evaluated:`,
    );
    for (const branch of finding.branches) out.push(...detailLines(branchRow(branch)));
  }
  if (showChain) {
    for (const text of finding.declare ?? []) {
      out.push(...wrapText(text, PAD(DETAIL_INDENT), PAD(DETAIL_INDENT)));
    }
  }
  return out;
}

// ---- blocks ----------------------------------------------------------------------

function blockHeader(block: ReportBlock): string[] {
  const subject = block.workload;
  const name = 'mapping' in subject ? (subject as QueueRef).mapping : (subject as WorkloadRef).name;
  const kind: Seg[] =
    typeof block.kindLabel === 'string' ? [t(block.kindLabel)] : [quote(block.kindLabel, 60)];
  return wrap(
    [t('Workload '), quote(name, 71), t(' ('), ...kind, t(') in '), ...fileSegs(block.file, 66)],
    '',
    PAD(DETAIL_INDENT),
  );
}

/** the design mockup: `(Helm source comment "<text>")` under the header, a fixed label before quoted input. */
function helmLines(block: ReportBlock): string[] {
  if (block.helmSource === undefined) return [];
  return wrap(
    [t('(Helm source comment '), quote(block.helmSource, HELM_QUOTE_ROOM), t(')')],
    PAD(DETAIL_INDENT),
    PAD(DETAIL_INDENT),
  );
}

function blockLines(block: ReportBlock, options: Required<RenderHumanOptions>): string[] {
  const lines = [...blockHeader(block), ...helmLines(block)];
  for (const finding of block.findings) {
    lines.push(...findingLines(finding, options.verbose, options.color));
  }
  return lines;
}

// ---- sections --------------------------------------------------------------------

function uncheckedLines(items: readonly UncheckedInput[]): string[] {
  const lines = ['Files not checked'];
  const prefix = '  UNRESOLVED (file)  ';
  for (const item of items) {
    const where: Seg[] = item.path === STDIN ? [t(STDIN)] : [quote(item.path, 40)];
    let segs: Seg[];
    if (item.reasonCode === 'parse-error') {
      const at = item.line === undefined ? '' : ` at line ${item.line}`;
      segs = [t('could not parse '), ...where, t(`: YAML syntax error${at}`)];
    } else if (item.reasonCode === 'source-parse-error') {
      const at = item.line === undefined ? '' : ` at line ${item.line}`;
      segs = [
        t('could not parse '),
        ...where,
        t(`: ${uncheckedReasonWords(item.reasonCode)}${at}`),
      ];
    } else {
      segs = [t('skipped '), ...where, t(`: ${uncheckedReasonWords(item.reasonCode)}`)];
    }
    lines.push(...wrap(segs, prefix, PAD(prefix.length)));
  }
  return lines;
}

/**
 * The `Waivers not applied` section. An unmatched waiver says which rule and
 * workload found nothing; an invalid one is quoted and says what is wrong in tripcurve's words. Each
 * says it suppresses nothing, and each counts under unresolved (file).
 */
function waiverLines(items: readonly AppliedWaiver[]): string[] {
  const lines = ['Waivers not applied'];
  const prefix = '  UNRESOLVED (file)  ';
  for (const w of items.slice(0, MAX_WAIVERS_LISTED)) {
    let segs: Seg[];
    if (w.state === 'unmatched' && w.workload !== undefined && !isInputText(w.rule)) {
      segs = [
        t(`no finding for rule ${w.rule} on workload `),
        quote(w.workload.name, 30),
        t(' matches the waiver at '),
        ...sourceSegs(w.source, 40),
      ];
    } else {
      segs = [
        t('waiver '),
        quote(w.text, 52),
        t(' at '),
        ...sourceSegs(w.source, 40),
        t(` ${w.problem ?? 'matches no finding'}; it suppresses nothing`),
      ];
    }
    lines.push(...wrap(segs, prefix, PAD(prefix.length)));
  }
  if (items.length > MAX_WAIVERS_LISTED) {
    const more = items.length - MAX_WAIVERS_LISTED;
    lines.push(
      ...wrapText(
        `... and ${more} more ${more === 1 ? 'waiver' : 'waivers'} not applied, each counted under unresolved.`,
        prefix,
        PAD(prefix.length),
      ),
    );
  }
  return lines;
}

/** The rule ids an unmatched load balancer leaves unchecked (T1 to T3 in this release; T4 is not about a load balancer). */
const LB_RULES: readonly string[] = ['T1', 'T2', 'T3'];

function lbRulesText(): string {
  const first = LB_RULES[0];
  const last = LB_RULES[LB_RULES.length - 1];
  return LB_RULES.length === 1 || first === last ? String(first) : `${first} to ${last}`;
}

function fileOf(item: NotCheckedItem, room: number): Seg[] {
  return item.file === STDIN ? [t(STDIN)] : [quote(item.file, room)];
}

function notCheckedBullets(items: readonly NotCheckedItem[]): string[] {
  const bullets: string[] = [];
  const workloads = items.filter((i) => i.subjectKind === 'workload');
  if (workloads.length > 0) {
    const n = workloads.length;
    bullets.push(
      ...wrapText(
        `- No load balancer found in the checked files for ${n} ${n === 1 ? 'workload' : 'workloads'}, ${lbRulesText()} not checked for ${n === 1 ? 'it' : 'them'}:`,
        '  ',
        '    ',
      ),
    );
    for (const item of workloads) {
      const name: Seg[] = item.subject === undefined ? [] : [quote(item.subject, 60), t(' ')];
      bullets.push(
        ...wrap(
          [t('Workload '), ...name, t(`(${item.kind}) in `), ...fileOf(item, 40)],
          '    ',
          PAD(4 + DETAIL_INDENT),
        ),
      );
    }
  }
  for (const item of items) {
    if (item.subjectKind === 'workload') continue;
    const name: Seg[] = item.subject === undefined ? [] : [quote(item.subject, 40), t(' ')];
    if (item.subjectKind === 'ingress') {
      bullets.push(
        ...wrap(
          [
            t(`- Not checked: ${item.kind} `),
            ...name,
            t('in '),
            ...fileOf(item, 40),
            t(' is not recognised as an ALB Ingress.'),
          ],
          '  ',
          '    ',
        ),
      );
    } else {
      bullets.push(
        ...wrap(
          [
            t(`- Not checked: kind "${item.kind}" in `),
            ...fileOf(item, 40),
            t(' (Gateway API) is not a kind tripcurve checks.'),
          ],
          '  ',
          '    ',
        ),
      );
    }
  }
  return bullets;
}

/**
 * A quoted run in an assumption's text (SafeText output: `"..."` with `\\"` for a quote, and an optional
 * `:line`) is input text. It stays in one piece when the line wraps and never starts a line (rule 5).
 */
const QUOTED_RUN = /"(?:[^"\\]|\\.)*"(?::\d+)?/g;
function assumptionSegs(text: string): Seg[] {
  const segs: Seg[] = [];
  let from = 0;
  for (const m of text.matchAll(QUOTED_RUN)) {
    if (m.index > from) segs.push(t(text.slice(from, m.index)));
    segs.push({ quoted: m[0] });
    from = m.index + m[0].length;
  }
  if (from < text.length) segs.push(t(text.slice(from)));
  return segs;
}

function assumptionLines(report: Report): string[] {
  const lines = ['Assumptions'];
  for (const a of report.assumptions) {
    lines.push(...wrap([t('- '), ...assumptionSegs(a.text)], '  ', '    '));
  }
  lines.push(...notCheckedBullets(report.notChecked));
  return lines;
}

// ---- header and errors ---------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function headerLine(report: Report): string {
  const h = report.header;
  const reads = h.stream
    ? `${[
        '1 stream',
        plural(h.stream.documents, 'document', 'documents'),
        ...(h.filesRead > 0 ? [plural(h.filesRead, 'file', 'files')] : []),
      ].join(', ')} read`
    : `${plural(h.filesRead, 'file', 'files')} read`;
  // One line, with the three-space gaps of the grammar (wrapping would collapse them).
  const prefix = `tripcurve ${h.version}   checked `;
  const suffix = `   ${reads}`;
  const where =
    h.checked === STDIN ? STDIN : quoteText(h.checked, 80 - prefix.length - suffix.length);
  return `${prefix}${where}${suffix}`;
}

function configErrorLines(errors: readonly ConfigError[]): string[] {
  const lines: string[] = [];
  for (const e of errors.slice(0, MAX_CONFIG_ERRORS)) {
    if (e.wholeFile !== undefined) {
      lines.push(
        ...wrap(
          [
            t('Config error in '),
            quote(e.file, 40),
            t(`${e.lineUnknown ? '' : ` at line ${e.line}`}: ${WHOLE_FILE_WORDS[e.wholeFile]}.`),
          ],
          '',
          '',
        ),
      );
      continue;
    }
    if (e.workload !== undefined && e.reasonCode === 'duplicate-workload-entry') {
      lines.push(
        ...wrap(
          [
            t('Config error in '),
            quote(e.file, 40),
            t(` at line ${e.line}: two entries name the same workload `),
            quote(e.workload, 40),
            t('.'),
          ],
          '',
          '',
        ),
      );
      continue;
    }
    if (e.workload !== undefined && e.reasonCode === 'declaration-names-no-workload') {
      lines.push(
        ...wrap(
          [
            t('Config error in '),
            quote(e.file, 40),
            t(` at line ${e.line}: no workload named `),
            quote(e.workload, 40),
            t(' for '),
            quote(e.key, 40),
            t('.'),
          ],
          '',
          '',
        ),
      );
      continue;
    }
    lines.push(
      ...wrap(
        [
          t('Config error in '),
          quote(e.file, 40),
          t(` at line ${e.line}: key `),
          quote(e.key, 40),
          t(
            e.reasonCode === 'bad-value' && e.expected !== undefined
              ? ` must be ${e.expected}.`
              : ` ${CONFIG_REASON_WORDS[e.reasonCode]}.`,
          ),
        ],
        '',
        '',
      ),
    );
  }
  if (errors.length > MAX_CONFIG_ERRORS) {
    lines.push(`... and ${errors.length - MAX_CONFIG_ERRORS} more configuration errors.`);
  }
  return lines;
}

function closing(report: Report): string[] {
  return report.summary.closingLines.flatMap((line) => wrapText(line, '', ''));
}

// ---- the report --------------------------------------------------------------------------

/** The human report. The same text on a terminal and in a CI log apart from colour. */
export function renderHuman(report: Report, options: RenderHumanOptions = {}): string {
  const opts: Required<RenderHumanOptions> = {
    verbose: options.verbose ?? false,
    color: options.color ?? false,
  };
  if (report.configErrors.length > 0) {
    // The unchecked files are shown as they are in JSON and SARIF: an unreadable tripcurve.yaml is both a
    // configuration error and a file that was not checked (review of B7, m3).
    const lines = configErrorLines(report.configErrors);
    if (report.unchecked.length > 0) lines.push('', ...uncheckedLines(report.unchecked), '');
    return `${[...lines, ...closing(report)].join('\n')}\n`;
  }
  const sections: string[][] = [[headerLine(report)]];
  if (report.noFilesNote !== undefined) {
    const where: Seg[] =
      report.noFilesNote.checked === STDIN ? [t(STDIN)] : [quote(report.noFilesNote.checked, 40)];
    const note = wrap(
      [t('No Kubernetes, server or Terraform files found under '), ...where, t('.')],
      '',
      '',
    );
    sections.push([...note, ...closing(report)]);
    return `${sections.map((s) => s.join('\n')).join('\n\n')}\n`;
  }
  for (const block of report.blocks) sections.push(blockLines(block, opts));
  if (report.unchecked.length > 0) sections.push(uncheckedLines(report.unchecked));
  if (report.waiversNotApplied.length > 0) sections.push(waiverLines(report.waiversNotApplied));
  if (report.assumptions.length > 0 || report.notChecked.length > 0) {
    sections.push(assumptionLines(report));
  }
  sections.push(closing(report));
  return `${sections.map((s) => s.join('\n')).join('\n\n')}\n`;
}
