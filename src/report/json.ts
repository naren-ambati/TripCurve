// JsonRenderer: the report as a JSON document, built from the one Report model and never by
// parsing text. Input text enters only as a JSON string, through SafeText's data mode (a lone surrogate
// becomes U+FFFD) and `asciiJson`, which escapes everything above 0x7e. This file reads no raw InputText.
//
// Where a field can hold several values, the document follows the report model; the fields it does not list are
// additions that a consumer may ignore (`namespace`, `line`, `valueType`, `confidence`, `originalKind`,
// `declare`, `decidingNote`, `expiredWaiver`, `reasonCode`, `mechanism`).

import {
  type Branch,
  type ChainStep,
  type ChainValue,
  type Finding,
  type InputText,
  isInputText,
  isNoteValue,
  isSourcedValue,
  isUnresolved,
  SafeText,
  type SourceRef,
  type WaiverInfo,
} from '../core/index.js';
import type { NotCheckedItem } from '../link/index.js';
import {
  type ConfigError,
  STDIN,
  type UncheckedInput,
  uncheckedReasonWords,
} from '../parse/index.js';
import type { AppliedWaiver, Report, ReportBlock } from './model.js';
import { asciiJson } from './serialize.js';
import { configErrorWords, NOT_CHECKED_WORDS } from './words.js';

type Json = Record<string, unknown>;

/** Input text, or tripcurve text, as a plain string for the document. */
export function dataText(value: InputText | string): string {
  return isInputText(value) ? SafeText.render(value, 'json') : value;
}

/** A source as the JSON document writes it. `basis` is set for a chain value only (every chain source carries it). */
export function sourceJson(source: SourceRef, basis?: string): Json {
  const tail = basis === undefined ? {} : { basis };
  switch (source.type) {
    case 'file':
    case 'declared':
      return { type: source.type, file: dataText(source.file), line: source.line, ...tail };
    case 'stdin':
      return { type: 'stdin', document: source.document, line: source.line, ...tail };
    case 'default':
      return {
        type: 'default',
        citation: source.citation,
        ...(source.range === undefined ? {} : { range: source.range }),
        ...(basis === undefined ? {} : { basis: source.basisText }),
      };
  }
}

function valueEntries(label: string, detail: string | undefined, value: ChainValue): Json[] {
  const head: Json = { label, ...(detail === undefined ? {} : { detail }) };
  if (isSourcedValue(value)) {
    const raw = value.value;
    return [
      {
        ...head,
        valueType: 'value',
        value: typeof raw === 'number' ? raw : dataText(raw),
        unit: value.unit,
        source: sourceJson(value.source, value.basis),
        confidence: value.confidence,
        // a number computed from literals in a file (bolt B17): the expression as written, data text
        ...(value.expression === undefined ? {} : { expression: dataText(value.expression) }),
      },
    ];
  }
  if (isUnresolved(value)) {
    return [
      {
        ...head,
        valueType: 'unresolved',
        value: null,
        reason: value.reason,
        ...(value.declareHint === undefined ? {} : { declareHint: value.declareHint }),
      },
    ];
  }
  if (isNoteValue(value)) return [{ ...head, valueType: 'note', value: value.note }];
  if (isInputText(value)) return [{ ...head, valueType: 'text', value: dataText(value) }];
  // Not one of the four shapes of ChainValue: say it is not established rather than print a guess.
  return [
    { ...head, valueType: 'unresolved', value: null, reason: 'a value that could not be shown' },
  ];
}

function stepEntries(step: ChainStep): Json[] {
  const [first, ...rest] = valueEntries(step.label, step.detail, step.value);
  const entries: Json[] = [];
  if (first !== undefined) {
    entries.push(
      step.decidedBy === undefined ? first : { ...first, decidedBy: sourceJson(step.decidedBy) },
    );
    entries.push(...rest);
  }
  for (const extra of step.more ?? []) entries.push(...valueEntries(step.label, undefined, extra));
  return entries;
}

function chainJson(chain: readonly ChainStep[]): Json[] {
  return chain.flatMap(stepEntries);
}

function branchJson(branch: Branch): Json {
  return { range: branch.range, outcome: branch.outcome, chain: chainJson(branch.chain) };
}

function waiverInfoJson(w: WaiverInfo): Json {
  return {
    until: w.until,
    reason: dataText(w.reason),
    source: sourceJson(w.source),
    mechanism: w.mechanism,
  };
}

function resultJson(f: Finding): Json {
  return {
    rule: f.rule,
    kind: f.kind,
    ...(f.originalKind === undefined ? {} : { originalKind: f.originalKind }),
    headline: f.headline,
    chain: chainJson(f.chain),
    ...(f.branches === undefined || f.branches.length === 0
      ? {}
      : { branches: f.branches.map(branchJson) }),
    ...(f.declare === undefined || f.declare.length === 0 ? {} : { declare: [...f.declare] }),
    ...(f.decidingNote === undefined ? {} : { decidingNote: f.decidingNote }),
    ...(f.waiver === undefined ? {} : { waiver: waiverInfoJson(f.waiver) }),
    ...(f.expiredWaiver === undefined ? {} : { expiredWaiver: waiverInfoJson(f.expiredWaiver) }),
  };
}

function fileFields(file: SourceRef): Json {
  switch (file.type) {
    case 'file':
    case 'declared':
      return { file: dataText(file.file), line: file.line };
    case 'stdin':
      return { file: STDIN, document: file.document, line: file.line };
    case 'default':
      return { file: file.citation };
  }
}

function workloadJson(block: ReportBlock): Json {
  const w = block.workload;
  const ref = 'mapping' in w ? undefined : w;
  return {
    name: dataText('mapping' in w ? w.mapping : w.name),
    kind: dataText(block.kindLabel),
    ...(ref === undefined ? {} : { namespace: dataText(ref.namespace) }),
    ...fileFields(block.file),
    ...(block.helmSource === undefined ? {} : { helmSource: dataText(block.helmSource) }),
    results: block.findings.map(resultJson),
  };
}

function notCheckedJson(item: NotCheckedItem): Json {
  return {
    subjectKind: item.subjectKind,
    ...(item.subject === undefined ? {} : { name: dataText(item.subject) }),
    kind: item.kind,
    file: item.file === STDIN ? STDIN : dataText(item.file),
    ...(item.line === undefined ? {} : { line: item.line }),
    reason: NOT_CHECKED_WORDS[item.reasonCode],
    reasonCode: item.reasonCode,
  };
}

function uncheckedJson(item: UncheckedInput): Json {
  return {
    type: item.path === STDIN ? 'stdin' : 'file',
    file: item.path === STDIN ? STDIN : dataText(item.path),
    reason: uncheckedReasonWords(item.reasonCode),
    reasonCode: item.reasonCode,
    ...(item.line === undefined ? {} : { line: item.line }),
  };
}

function configErrorJson(e: ConfigError): Json {
  return {
    file: dataText(e.file),
    line: e.line,
    key: dataText(e.key),
    reason: configErrorWords(e),
    reasonCode: e.reasonCode,
    ...(e.wholeFile === undefined ? {} : { wholeFile: e.wholeFile }),
    ...(e.expected === undefined ? {} : { expected: e.expected }),
    ...(e.workload === undefined ? {} : { workload: dataText(e.workload) }),
  };
}

function waiverJson(w: AppliedWaiver): Json {
  return {
    rule: dataText(w.rule),
    ...(w.workload === undefined
      ? {}
      : {
          workload: {
            name: dataText(w.workload.name),
            ...(w.workload.namespace === undefined
              ? {}
              : { namespace: dataText(w.workload.namespace) }),
          },
        }),
    state: w.state,
    until: dataText(w.until),
    reason: dataText(w.reason),
    source: sourceJson(w.source),
    mechanism: w.mechanism,
    ...(w.problem === undefined ? {} : { problem: w.problem }),
  };
}

/** The report as a JSON document. The same results as the human report: both print the one Report. */
export function renderJson(report: Report): string {
  const h = report.header;
  const s = report.summary;
  const document: Json = {
    schemaVersion: 1,
    tool: { name: 'tripcurve', version: h.version },
    checked: {
      path: h.checked === STDIN ? STDIN : dataText(h.checked),
      filesRead: h.filesRead,
      ...(h.stream === undefined ? {} : { documents: h.stream.documents }),
    },
    workloads: report.blocks.map(workloadJson),
    ...(report.noFilesNote === undefined
      ? {}
      : {
          noFiles: {
            checked:
              report.noFilesNote.checked === STDIN ? STDIN : dataText(report.noFilesNote.checked),
          },
        }),
    notChecked: report.notChecked.map(notCheckedJson),
    assumptions: report.assumptions.map((a) => a.text),
    waivers: report.waivers.map(waiverJson),
    unchecked: report.unchecked.map(uncheckedJson),
    configErrors: report.configErrors.map(configErrorJson),
    summary: {
      failed: s.counts.failed,
      warning: s.counts.warning,
      unresolved: s.counts.unresolved,
      versionDependent: s.counts.versionDependent,
      notEvaluated: s.counts.notEvaluated,
      waived: s.counts.waived,
      notApplicable: s.counts.notApplicable,
      passed: s.counts.passed,
      outcome: s.outcome,
      clean: s.clean,
      waivedDates: [...s.waivedDates],
      exitCode: s.exitCode,
    },
  };
  return asciiJson(document);
}
