// SarifRenderer: the report as a SARIF 2.1.0 log, built from the one Report model.
//
// What is emitted: a result for every FAIL, WARN, UNRESOLVED, VERSION-DEPENDENT, NOT EVALUATED and WAIVED
// finding, never for PASS or N/A, and a `tripcurve-file` warning for every unchecked file, every waiver
// that was not applied, every configuration error and (once) a run in which nothing was checked, so a
// consumer that reads only results sees an incomplete run (the rule that a consumer must never see an incomplete run as complete).
//
// Input text enters only through SafeText: as a URI (percent-encoded), as a quoted name inside a message
// (the terminal form, escaped to ASCII, so a message can hold no markup, newline or invisible character of
// its own), or as a JSON string that `asciiJson` escapes. This file reads no raw InputText.
//
// Messages are plain text (SARIF 3.11.3), so `escapeMessage` writes the characters that would start an
// embedded link or a placeholder as the spec's escapes (3.11.5, 3.11.6) wherever a message is made.
//
// Locations (the schema names the fields but not the choice): a result is located at the first
// value of its chain that was read from the same file as the workload (`k8s/api.yaml:22`), and otherwise
// at the workload's own object (`k8s/api.yaml:2`). Standard input has no file, so a result from stdin has
// no physicalLocation and `properties.tripcurve.source` says where it came from.

import {
  type ChainStep,
  type ChainValue,
  type Finding,
  type InputText,
  inputTextEquals,
  isInputText,
  isSourcedValue,
  type ResultKind,
  RULE_IDS,
  type RuleId,
  SafeText,
  type SourceRef,
} from '../core/index.js';
import { EXPLAIN_ENTRIES } from '../evaluate/explain-entries.js';
import type { NotCheckedItem } from '../link/index.js';
import { STDIN, uncheckedReasonWords } from '../parse/index.js';
import { dataText, sourceJson } from './json.js';
import { quoteText } from './layout.js';
import type { AppliedWaiver, Counts, Report, ReportBlock } from './model.js';
import { asciiJson } from './serialize.js';
import { configErrorWords, NOT_CHECKED_WORDS, WHOLE_FILE_WORDS } from './words.js';

type Json = Record<string, unknown>;

export const FILE_RULE_ID = 'tripcurve-file';
export const RUN_RULE_ID = 'tripcurve-run';
export const NOT_CHECKED_RULE_ID = 'tripcurve-not-checked';
/** The URI base id of every relative uri: the directory that was checked (SARIF 3.4.4, 3.14.14). */
export const SRCROOT = 'SRCROOT';

const FILE_RULE_TEXT =
  'A file, waiver or configuration entry that tripcurve did not check or apply, or a run in which nothing was checked.';
const FILE_RULE_HELP =
  'The run is not complete: fix the file, waiver or configuration entry the message names.';

const RUN_RULE_TEXT =
  'The run as a whole is not clean, although no single result above note level says so.';
const RUN_RULE_HELP =
  'The run is not clean: see the run properties for the outcome and the counts.';
const NOT_CHECKED_RULE_TEXT =
  'A workload, Ingress or kind for which no check was made: no load balancer was found for the workload, or the object is not one tripcurve checks.';
const NOT_CHECKED_RULE_HELP =
  'This does not make the run unclean. For a workload, declare the load balancer in tripcurve.yaml or add it to the checked files to have T1 to T3 checked.';
const SRCROOT_TEXT =
  'The directory that was checked. Every relative uri in this log is relative to it.';

/** The SARIF level of each result kind that is emitted. PASS and N/A have none. */
const LEVELS: Readonly<Partial<Record<ResultKind, 'error' | 'warning' | 'note'>>> = {
  FAIL: 'error',
  WARN: 'warning',
  UNRESOLVED: 'warning',
  'VERSION-DEPENDENT': 'warning',
  'NOT EVALUATED': 'note',
};

/** A quoted name inside a message: SafeText's terminal form, which is ASCII and escapes quotes. */
const MESSAGE_QUOTE_ROOM = 200;
function quoted(text: InputText): string {
  return quoteText(text, MESSAGE_QUOTE_ROOM);
}

/**
 * A plain text message may hold placeholders and embedded links, so a name that came from input must not be
 * able to write either. SARIF 3.11.6 (read 2026-11-12): in a plain text message an embedded link is
 * `[link text](destination)`, and "Literal square brackets ... in the link text of a plain text message SHALL
 * be escaped with a backslash"; so every `[` and `]` is written `\[` and `\]` and no link can be formed.
 * SARIF 3.11.5: "Within both plain text and formatted message strings, the characters '{' and '}' SHALL be
 * represented by the character sequences '{{' and '}}'", so a name cannot write a placeholder either. A
 * backslash in input was already doubled by SafeText, so an escape written here is never cancelled.
 */
export function escapeMessage(text: string): string {
  return text.replace(/[[\]{}]/g, (c) => (c === '[' || c === ']' ? `\\${c}` : `${c}${c}`));
}

function messageOf(text: string): Json {
  return { text: escapeMessage(text) };
}

/**
 * A path as a URI reference (SARIF 3.4.3): each segment percent-encoded, so no space, quote, colon, control
 * or non-ASCII character reaches the document raw. A path that starts with a slash would be an absolute-path
 * reference, which 3.4.3 forbids for a relative reference, so it is written as a `file://` URI.
 */
export function uriOf(path: InputText): string {
  const raw = SafeText.render(path, 'json');
  const encoded = raw
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (raw.startsWith('/')) return `file://${encoded}`;
  return encoded === '' ? '.' : encoded;
}

/**
 * The location of a path. A `--config` file outside the root is located by a `file:` URI of its resolved path with
 * no base (it is not under SRCROOT, and a typed relative path would resolve against the wrong folder); every other
 * path is relative to the root. Set for the duration of one render.
 */
let outsideConfig: Report['outsideConfig'];
function locationUri(path: InputText): string {
  if (
    outsideConfig !== undefined &&
    SafeText.render(path, 'json') === SafeText.render(outsideConfig.shown, 'json')
  ) {
    return uriOf(outsideConfig.real);
  }
  return uriOf(path);
}

interface Place {
  /** Absent for standard input, which has no file. */
  readonly uri?: string;
  readonly line?: number;
  /** `<stdin> document n, line m`, set for standard input. */
  readonly stdin?: string;
}

function placeOfSource(source: SourceRef): Place {
  switch (source.type) {
    case 'file':
    case 'declared':
      return { uri: locationUri(source.file), line: source.line };
    case 'stdin':
      return { stdin: `<stdin> document ${source.document}, line ${source.line}` };
    case 'default':
      return {};
  }
}

/** The checked root itself: the SRCROOT base, whatever path was typed (the message quotes what was typed). */
const ROOT_PLACE: Place = { uri: '.' };

function locationsOf(place: Place): Json {
  if (place.uri === undefined) return {};
  return {
    locations: [
      {
        physicalLocation: {
          // A file: URI is absolute, so it has no base (3.4.4: "If the uri property contains an absolute URI, the
          // uriBaseId property SHALL be absent").
          artifactLocation: place.uri.startsWith('file:')
            ? { uri: place.uri }
            : { uri: place.uri, uriBaseId: SRCROOT },
          ...(place.line === undefined ? {} : { region: { startLine: place.line } }),
        },
      },
    ],
  };
}

function chainValues(chain: readonly ChainStep[]): ChainValue[] {
  return chain.flatMap((s) => [s.value, ...(s.more ?? [])]);
}

/** The first value of the chain read from the same file (or stdin document) as the workload, else the workload. */
function placeOfFinding(block: ReportBlock, finding: Finding): Place {
  const home = block.file;
  for (const value of chainValues(finding.chain)) {
    if (!isSourcedValue(value)) continue;
    const s = value.source;
    if (
      (home.type === 'file' || home.type === 'declared') &&
      (s.type === 'file' || s.type === 'declared') &&
      inputTextEquals(s.file, home.file)
    ) {
      return placeOfSource(s);
    }
    if (home.type === 'stdin' && s.type === 'stdin' && s.document === home.document) {
      return placeOfSource(s);
    }
  }
  return placeOfSource(home);
}

function workloadProperties(block: ReportBlock): Json {
  const w = block.workload;
  return {
    name: dataText('mapping' in w ? w.mapping : w.name),
    kind: dataText(block.kindLabel),
    ...('mapping' in w ? {} : { namespace: dataText(w.namespace) }),
  };
}

function findingResult(block: ReportBlock, finding: Finding): Json | undefined {
  const kind: string = finding.kind;
  if (kind === 'PASS' || kind === 'N/A') return undefined;
  // A waiver counts only when the finding holds both what it was and the waiver itself. A WAIVED finding that
  // lacks either is not trusted to be suppressed: it is a warning and nothing is suppressed.
  const waiver =
    kind === 'WAIVED' && finding.originalKind !== undefined ? finding.waiver : undefined;
  const effective: string = kind === 'WAIVED' ? (finding.originalKind ?? 'WAIVED') : kind;
  // Any kind that has no level of its own is a warning, never nothing.
  // The level follows what the finding was, whether or not its waiver is there (second review m-A).
  const levelOf: string = finding.originalKind ?? kind;
  const level = LEVELS[levelOf as ResultKind] ?? 'warning';
  const place = placeOfFinding(block, finding);
  const expired = finding.expiredWaiver;
  return {
    ruleId: finding.rule,
    level,
    message: messageOf(`${finding.rule} ${effective}: ${finding.headline}`),
    ...locationsOf(place),
    ...(waiver === undefined
      ? {}
      : {
          suppressions: [
            {
              kind: waiver.mechanism === 'inline' ? 'inSource' : 'external',
              justification: dataText(waiver.reason),
              // the expiry and where the waiver is written, so a consumer that reads only SARIF sees them (m2)
              properties: {
                tripcurve: {
                  until: waiver.until,
                  mechanism: waiver.mechanism,
                  source: sourceJson(waiver.source),
                },
              },
            },
          ],
        }),
    properties: {
      tripcurve: {
        kind: finding.kind,
        ...(finding.originalKind === undefined ? {} : { originalKind: finding.originalKind }),
        workload: workloadProperties(block),
        ...(place.stdin === undefined ? {} : { source: place.stdin }),
        ...(expired === undefined
          ? {}
          : {
              expiredWaiver: {
                until: expired.until,
                reason: dataText(expired.reason),
                mechanism: expired.mechanism,
              },
            }),
      },
    },
  };
}

function fileResult(
  message: string,
  place: Place,
  reason: string,
  ruleId: string = FILE_RULE_ID,
  level: 'warning' | 'note' = 'warning',
): Json {
  return {
    ruleId,
    level,
    message: messageOf(message),
    ...locationsOf(place),
    properties: {
      tripcurve: { reason, ...(place.stdin === undefined ? {} : { source: place.stdin }) },
    },
  };
}

function nothingCheckedResult(report: Report): Json {
  const where: Place = report.header.checked === STDIN ? { stdin: STDIN } : ROOT_PLACE;
  if (report.noFilesNote === undefined) {
    return fileResult(
      'nothing checked: files were read but no check was evaluated',
      where,
      'no-check-evaluated',
    );
  }
  const root = report.noFilesNote.checked === STDIN ? STDIN : quoted(report.noFilesNote.checked);
  return fileResult(
    `nothing checked: no Kubernetes, server or Terraform files found under ${root}`,
    where,
    'no-recognised-files',
  );
}

function uncheckedResult(item: Report['unchecked'][number]): Json {
  const where = item.path === STDIN ? STDIN : quoted(item.path);
  const words =
    item.reasonCode === 'parse-error' && item.line !== undefined
      ? `${uncheckedReasonWords(item.reasonCode)} at line ${item.line}`
      : uncheckedReasonWords(item.reasonCode);
  const place: Place =
    item.path === STDIN
      ? { stdin: STDIN }
      : { uri: locationUri(item.path), ...(item.line === undefined ? {} : { line: item.line }) };
  return fileResult(`file not checked: ${where}: ${words}`, place, item.reasonCode);
}

function waiverResult(w: AppliedWaiver): Json {
  const place = placeOfSource(w.source);
  if (w.state === 'unmatched' && w.workload !== undefined && !isInputText(w.rule)) {
    return fileResult(
      `waiver not applied: no finding for rule ${w.rule} on workload ${quoted(w.workload.name)} matches the waiver; it suppresses nothing`,
      place,
      'unmatched-waiver',
    );
  }
  return fileResult(
    `waiver not applied: waiver ${quoted(w.text)} ${w.problem ?? 'matches no finding'}; it suppresses nothing`,
    place,
    w.state === 'unmatched' ? 'unmatched-waiver' : 'invalid-waiver',
  );
}

function configErrorResult(e: Report['configErrors'][number]): Json {
  let message: string;
  if (e.workload !== undefined && e.reasonCode === 'duplicate-workload-entry') {
    message = `configuration error: two entries name the same workload ${quoted(e.workload)}`;
  } else if (e.workload !== undefined && e.reasonCode === 'declaration-names-no-workload') {
    message = `configuration error: no workload named ${quoted(e.workload)} for ${quoted(e.key)}`;
  } else if (e.reasonCode === 'bad-value' && e.expected !== undefined) {
    message = `configuration error: key ${quoted(e.key)} must be ${e.expected}`;
  } else if (e.wholeFile !== undefined) {
    message = `configuration error: ${WHOLE_FILE_WORDS[e.wholeFile]}`;
  } else {
    message = `configuration error: key ${quoted(e.key)} ${configErrorWords(e)}`;
  }
  return fileResult(message, { uri: locationUri(e.file), line: e.line }, e.reasonCode);
}

function notCheckedResult(item: NotCheckedItem): Json {
  const name = item.subject === undefined ? '' : ` ${quoted(item.subject)}`;
  const place: Place =
    item.file === STDIN
      ? { stdin: STDIN }
      : { uri: locationUri(item.file), ...(item.line === undefined ? {} : { line: item.line }) };
  const effect = item.subjectKind === 'workload' ? ', so T1 to T3 were not checked for it' : '';
  return fileResult(
    `not checked: ${item.kind}${name}: ${NOT_CHECKED_WORDS[item.reasonCode]}${effect}`,
    place,
    item.reasonCode,
    NOT_CHECKED_RULE_ID,
    'note',
  );
}

/** The unclean counts of the closing line, in its order, with their words. */
function uncleanCounts(c: Counts): string {
  const parts: string[] = [];
  const add = (n: number, text: string): void => {
    if (n > 0) parts.push(`${n} ${text}`);
  };
  add(c.failed, 'failed');
  add(c.warning, c.warning === 1 ? 'warning' : 'warnings');
  add(c.unresolved, 'unresolved');
  add(c.versionDependent, 'version-dependent');
  add(c.notEvaluated, 'not evaluated');
  return parts.length === 0 ? '' : `: ${parts.join(', ')}`;
}

/**
 * A run that is not clean always has an unsuppressed error or warning in its results. NOT EVALUATED
 * is a `note`, so a run whose only unsuppressed result is a note would look clean to a reader that
 * gates on error and warning; this one warning, at the checked root, says what the run properties say.
 */
function runResult(report: Report): Json {
  return fileResult(
    `the run is not clean${uncleanCounts(report.summary.counts)}; see the run properties`,
    ROOT_PLACE,
    'not-clean',
    RUN_RULE_ID,
  );
}

function ruleDescriptor(id: RuleId): Json {
  return {
    id,
    shortDescription: { text: EXPLAIN_ENTRIES[id].statement },
    help: {
      text: `Run "tripcurve --explain ${id}" for the rule, its sources and the values it uses.`,
    },
  };
}

/** The report as a SARIF 2.1.0 log. */
export function renderSarif(report: Report): string {
  outsideConfig = report.outsideConfig;
  try {
    return renderSarifOf(report);
  } finally {
    outsideConfig = undefined;
  }
}

function renderSarifOf(report: Report): string {
  const s = report.summary;
  const results: Json[] = [];
  if (s.outcome === 'NothingChecked') results.push(nothingCheckedResult(report));
  for (const block of report.blocks) {
    for (const finding of block.findings) {
      const result = findingResult(block, finding);
      if (result !== undefined) results.push(result);
    }
  }
  results.push(...report.notChecked.map(notCheckedResult));
  results.push(...report.unchecked.map(uncheckedResult));
  results.push(...report.waiversNotApplied.map(waiverResult));
  results.push(...report.configErrors.map(configErrorResult));
  const saysSo = results.some(
    (r) =>
      (r.level === 'error' || r.level === 'warning') &&
      (r as { suppressions?: unknown }).suppressions === undefined,
  );
  if (!s.clean && !saysSo) results.push(runResult(report));
  const log: Json = {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'tripcurve',
            version: report.header.version,
            rules: [
              ...RULE_IDS.map(ruleDescriptor),
              {
                id: FILE_RULE_ID,
                shortDescription: { text: FILE_RULE_TEXT },
                help: { text: FILE_RULE_HELP },
              },
              {
                id: RUN_RULE_ID,
                shortDescription: { text: RUN_RULE_TEXT },
                help: { text: RUN_RULE_HELP },
              },
              {
                id: NOT_CHECKED_RULE_ID,
                shortDescription: { text: NOT_CHECKED_RULE_TEXT },
                help: { text: NOT_CHECKED_RULE_HELP },
              },
            ],
          },
        },
        originalUriBaseIds: { [SRCROOT]: { description: { text: SRCROOT_TEXT } } },
        results,
        properties: {
          tripcurve: {
            outcome: s.outcome,
            clean: s.clean,
            summary: { ...s.counts },
            exitCode: s.exitCode,
            notChecked: report.notChecked.length,
          },
        },
      },
    ],
  };
  return asciiJson(log);
}
