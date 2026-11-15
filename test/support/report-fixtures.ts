// Builders for report tests: findings of a chosen kind, and a Report assembled the
// way the pipeline does it (assembleReport), without reading any file.
import type { AnalysisResult } from '../../src/analyse.js';
import {
  type ChainStep,
  defaultSource,
  type Finding,
  fileSource,
  type InputText,
  inputText,
  makeFinding,
  makeSourcedValue,
  type QueueRef,
  type ResultKind,
  type RuleId,
  type RuleResultKind,
  type WorkloadRef,
  waiveFinding,
} from '../../src/core/index.js';
import type { WorkloadFindings } from '../../src/evaluate/index.js';
import type { NotCheckedItem } from '../../src/link/index.js';
import type {
  ConfigError,
  InputFile,
  IntakeResult,
  RawWaiverRecord,
  UncheckedInput,
} from '../../src/parse/index.js';
import { assembleReport, type Report } from '../../src/report/index.js';

export function workload(
  name: string,
  namespace = 'shop',
  kind: WorkloadRef['kind'] = 'Deployment',
): WorkloadRef {
  return { kind, namespace: inputText(namespace), name: inputText(name) };
}

/** An event source mapping (bolt B5). */
export function queue(mapping: string): QueueRef {
  return { mapping: inputText(mapping) };
}

/** A chain that rests on one established value, so a PASS on it is allowed. */
export function goodChain(file = 'k8s/a.yaml', line = 7): ChainStep[] {
  return [
    {
      label: 'idle close',
      value: makeSourcedValue({
        value: 12,
        unit: 's',
        source: fileSource(inputText(file), line),
        basis: 'declared',
      }),
    },
  ];
}

export function defaultChain(): ChainStep[] {
  return [
    {
      label: 'idle close',
      value: makeSourcedValue({
        value: 6,
        unit: 's',
        source: defaultSource({
          citation: 'Node keepAliveTimeout 5 s + buffer 1 s',
          range: 'Node 22.x from 22.19',
          basisText: 'measured on 22.23.2',
        }),
        basis: 'measured-on',
      }),
    },
  ];
}

export function finding(
  kind: RuleResultKind | 'WAIVED',
  rule: RuleId = 'T1',
  subject: WorkloadRef | QueueRef = workload('web'),
  headline = `headline of ${kind}`,
  chain: readonly ChainStep[] = goodChain(),
): Finding {
  if (kind === 'WAIVED') {
    const base = makeFinding({ rule, subject, kind: 'FAIL', headline, chain });
    return waiveFinding(base, {
      until: '2027-01-31',
      reason: inputText('drains in sidecar'),
      source: fileSource(inputText('tripcurve.yaml'), 11),
      mechanism: 'config',
    });
  }
  return makeFinding({ rule, subject, kind, headline, chain });
}

export function wf(
  subject: WorkloadRef | QueueRef,
  findings: Finding[],
  file = 'k8s/web.yaml',
): WorkloadFindings {
  return { workload: subject, file: fileSource(inputText(file), 2), findings };
}

export function unchecked(
  path: string,
  reasonCode: UncheckedInput['reasonCode'] = 'parse-error',
  line?: number,
): UncheckedInput {
  return line === undefined
    ? { path: inputText(path), reasonCode }
    : { path: inputText(path), reasonCode, line };
}

export interface ReportParts {
  results?: WorkloadFindings[];
  unchecked?: UncheckedInput[];
  notChecked?: NotCheckedItem[];
  configErrors?: ConfigError[];
  noRecognisedFiles?: boolean;
  filesRead?: number;
  checked?: string;
  assumptions?: { text: string; reason: string }[];
  /** Raw waivers (bolt B6); judged by assembleReport against `today`. */
  waiverRecords?: RawWaiverRecord[];
  today?: string;
  /** Files of the intake, so inline waivers can find the block they sit in. */
  intakeFiles?: InputFile[];
}

export function buildReport(parts: ReportParts = {}): Report {
  const intake = {
    root: inputText('/abs'),
    files: parts.intakeFiles ?? [],
    unchecked: parts.unchecked ?? [],
    filesRead: parts.filesRead ?? 3,
    noRecognisedFiles: parts.noRecognisedFiles ?? false,
  } as unknown as IntakeResult;
  const analysis = {
    configErrors: parts.configErrors ?? [],
    graph: {
      knownWorkloads: (parts.results ?? []).flatMap((r) =>
        'mapping' in r.workload ? [] : [r.workload],
      ),
    },
    model: {},
    results: parts.results ?? [],
    notChecked: parts.notChecked ?? [],
    assumptions: parts.assumptions ?? [],
    unidentifiedObjects: [],
    unreadTerraform: [],
    unreadSources: [],
    waiverRecords: parts.waiverRecords ?? [],
    terraformResources: [],
  } as unknown as AnalysisResult;
  return assembleReport({
    checked: parts.checked ?? '.',
    intake,
    analysis,
    ...(parts.today === undefined ? {} : { today: parts.today }),
  });
}

export function configError(
  key: string,
  line = 3,
  code: ConfigError['reasonCode'] = 'bad-value',
): ConfigError {
  return { file: inputText('tripcurve.yaml'), line, key: inputText(key), reasonCode: code };
}

export type { InputText, ResultKind };
