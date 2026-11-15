// ReportAssembler: builds the Report from what the pipeline produced.
// It orders blocks and lines (the block order), collects the
// assumptions once, and attaches the summary RunSummarizer computed. It builds the
// the no-files case and the config-error case entries too, so a renderer only formats what the Report holds. It never
// reads the raw text of an input.

import type { AnalysisResult } from '../analyse.js';
import {
  type Assumption,
  compareInputText,
  type Finding,
  type InputText,
  inputText,
  isInputText,
  type ResultKind,
  RULE_IDS,
  type RuleId,
} from '../core/index.js';
import { EVENT_SOURCE_MAPPING, type WorkloadKind, workloadKindRank } from '../core/vocab.js';
import type { WorkloadFindings } from '../evaluate/index.js';
import type { ConfigError, IntakeResult, StdinPath, UncheckedInput } from '../parse/index.js';
import { mergeUnchecked, STDIN } from '../parse/index.js';
import { VERSION } from '../version.js';
import { type AppliedWaiver, applyWaivers } from '../waive/index.js';
import type { Report, ReportBlock } from './model.js';
import { configErrorSummary, summarizeRun } from './summarize.js';

/** Non-pass kinds in their fixed order (interaction spec rule 3), then PASS and N/A together. */
const KIND_ORDER: readonly ResultKind[] = [
  'FAIL',
  'WARN',
  'UNRESOLVED',
  'VERSION-DEPENDENT',
  'NOT EVALUATED',
  'WAIVED',
];

function kindGroup(kind: ResultKind): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

function ruleIndex(rule: RuleId): number {
  return RULE_IDS.indexOf(rule);
}

/** Non-pass lines first (each kind in rule order), then PASS and N/A in rule order. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => kindGroup(a.kind) - kindGroup(b.kind) || ruleIndex(a.rule) - ruleIndex(b.rule),
  );
}

function hasFailOrWarn(block: ReportBlock): boolean {
  return block.findings.some((f) => f.kind === 'FAIL' || f.kind === 'WARN');
}

function nameOf(block: ReportBlock): InputText {
  return 'mapping' in block.workload ? block.workload.mapping : block.workload.name;
}

function namespaceOf(block: ReportBlock): InputText | undefined {
  return 'mapping' in block.workload ? undefined : block.workload.namespace;
}

function fileKey(block: ReportBlock): { file: InputText | undefined; line: number } {
  const s = block.file;
  if (s.type === 'file' || s.type === 'declared') return { file: s.file, line: s.line };
  if (s.type === 'stdin') return { file: undefined, line: s.document * 1_000_000 + s.line };
  return { file: undefined, line: 0 };
}

function compareBlocks(a: ReportBlock, b: ReportBlock): number {
  const group = Number(hasFailOrWarn(b)) - Number(hasFailOrWarn(a));
  if (group !== 0) return group;
  const rank = (x: ReportBlock): number =>
    workloadKindRank(typeof x.kindLabel === 'string' ? (x.kindLabel as WorkloadKind) : undefined);
  const byKind = rank(a) - rank(b);
  if (byKind !== 0) return byKind;
  if (isInputText(a.kindLabel) && isInputText(b.kindLabel)) {
    const byLabel = compareInputText(a.kindLabel, b.kindLabel);
    if (byLabel !== 0) return byLabel;
  }
  const na = namespaceOf(a);
  const nb = namespaceOf(b);
  if (na !== undefined && nb !== undefined) {
    const byNs = compareInputText(na, nb);
    if (byNs !== 0) return byNs;
  }
  const byName = compareInputText(nameOf(a), nameOf(b));
  if (byName !== 0) return byName;
  // Two objects with one kind, namespace and name: the file and line keep the order fixed.
  const fa = fileKey(a);
  const fb = fileKey(b);
  if (fa.file !== undefined && fb.file !== undefined) {
    const byFile = compareInputText(fa.file, fb.file);
    if (byFile !== 0) return byFile;
  }
  return fa.line - fb.line;
}

export function buildBlocks(results: readonly WorkloadFindings[]): ReportBlock[] {
  const blocks = results.map(
    (r): ReportBlock => ({
      workload: r.workload,
      kindLabel: 'mapping' in r.workload ? EVENT_SOURCE_MAPPING : r.workload.kind,
      file: r.file,
      ...(r.helmSource === undefined ? {} : { helmSource: r.helmSource }),
      findings: orderFindings(r.findings),
    }),
  );
  return blocks.sort(compareBlocks);
}

/** Each assumption once, in the order first met. */
function uniqueAssumptions(assumptions: readonly Assumption[]): Assumption[] {
  const seen = new Set<string>();
  const out: Assumption[] = [];
  for (const a of assumptions) {
    if (seen.has(a.text)) continue;
    seen.add(a.text);
    out.push(a);
  }
  return out;
}

/**
 * The standing assumption of every report that holds a result: what a
 * green result does not cover. The propagation allowance belongs to the T2 rule and
 * is listed when T2 exists; it is not claimed here.
 */
export const ZERO_DOWNTIME_ASSUMPTION: Assumption = {
  text: 'Green never means zero-downtime: the SIGTERM race and the deregistration delay are outside these rules.',
  reason: 'standing note',
};

export interface AssembleInput {
  /** The path as the person typed it, or the place-holder for standard input. */
  readonly checked: string;
  readonly intake: IntakeResult;
  readonly analysis: AnalysisResult;
  /**
   * The UTC date of the run, `YYYY-MM-DD`: the one clock input, read once by the caller. Without a
   * valid date no waiver can be judged, so every waiver is listed as not applied and none suppresses anything.
   */
  readonly today?: string;
}

function checkedOf(checked: string): InputText | StdinPath {
  return checked === STDIN ? STDIN : inputText(checked);
}

function streamOf(intake: IntakeResult): { documents: number } | undefined {
  return intake.root === STDIN ? { documents: intake.stream?.documents.length ?? 0 } : undefined;
}

/** configuration errors stop the run before any rule. */
function configErrorReport(
  checked: string,
  intake: IntakeResult,
  errors: readonly ConfigError[],
  unchecked: readonly UncheckedInput[],
): Report {
  const stream = streamOf(intake);
  return {
    header: {
      version: VERSION,
      checked: checkedOf(checked),
      filesRead: intake.filesRead,
      ...(stream === undefined ? {} : { stream }),
    },
    blocks: [],
    unchecked,
    waivers: [],
    waiversNotApplied: [],
    notChecked: [],
    configErrors: errors,
    assumptions: [],
    summary: configErrorSummary(),
    ...(intake.outsideConfig === undefined ? {} : { outsideConfig: intake.outsideConfig }),
  };
}

export function assembleReport(input: AssembleInput): Report {
  const { intake, analysis } = input;
  // Objects the Kubernetes reader could not identify count as files not checked.
  const unchecked = mergeUnchecked(intake.unchecked, [
    ...analysis.unidentifiedObjects,
    ...analysis.unreadTerraform,
    ...analysis.unreadSources,
  ]);
  if (analysis.configErrors.length > 0) {
    return configErrorReport(input.checked, intake, analysis.configErrors, unchecked);
  }
  // Waivers wrap findings after the rules; a rule never sees one.
  const waived = applyWaivers({
    results: analysis.results,
    records: analysis.waiverRecords,
    knownWorkloads: analysis.graph.knownWorkloads,
    intake,
    terraform: analysis.terraformResources,
    today: input.today,
  });
  const waiversNotApplied: AppliedWaiver[] = waived.waivers.filter(
    (w) => w.state === 'unmatched' || w.state === 'invalid',
  );
  const blocks = buildBlocks(waived.results);
  const findings = waived.results.flatMap((r) => r.findings);
  const workloadsNotChecked = analysis.notChecked.filter(
    (i) => i.subjectKind === 'workload',
  ).length;
  const summary = summarizeRun({
    findings,
    uncheckedFiles: unchecked.length,
    waiversNotApplied: waiversNotApplied.length,
    workloadsNotChecked,
  });
  // The assumptions this run used come first; the standing note closes the block.
  const assumptions = uniqueAssumptions([
    ...analysis.assumptions,
    ...(blocks.length > 0 ? [ZERO_DOWNTIME_ASSUMPTION] : []),
  ]);
  const stream = streamOf(intake);
  const checked = checkedOf(input.checked);
  return {
    header: {
      version: VERSION,
      checked,
      filesRead: intake.filesRead,
      ...(stream === undefined ? {} : { stream }),
    },
    blocks,
    unchecked,
    waivers: waived.waivers,
    waiversNotApplied,
    notChecked: analysis.notChecked,
    configErrors: [],
    ...(intake.noRecognisedFiles ? { noFilesNote: { checked } } : {}),
    assumptions,
    summary,
    ...(intake.outsideConfig === undefined ? {} : { outsideConfig: intake.outsideConfig }),
  };
}
