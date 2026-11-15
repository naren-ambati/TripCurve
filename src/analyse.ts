// The pipeline from parsed input to findings: read, link, resolve, evaluate. A pure
// function of the intake result (and the knowledge base). PipelineRunner owns
// the CLI around it; it stops on `configErrors` before any rule runs.

import type { Assumption } from './core/index.js';
import { evaluateRules, type WorkloadFindings } from './evaluate/index.js';
import type { KnowledgeBase } from './kb/index.js';
import type { NotCheckedItem } from './link/index.js';
import { type ConfigGraph, linkConfigGraph } from './link/index.js';
import type {
  ConfigError,
  RawWaiverRecord,
  ReaderUnresolved,
  TfResource,
  UncheckedInput,
} from './parse/index.js';
import {
  type IntakeResult,
  rawInputTextForParser,
  readConfig,
  readIac,
  readKubernetes,
  STDIN,
} from './parse/index.js';
import { type ResolvedModel, resolveWorkloads } from './resolve/index.js';

export interface AnalysisResult {
  /** Non-empty: the run stops here, nothing was resolved or evaluated (exit 2). */
  readonly configErrors: readonly ConfigError[];
  readonly graph: ConfigGraph;
  readonly model: ResolvedModel;
  /** One entry per resolved workload; empty when `configErrors` is non-empty. */
  readonly results: readonly WorkloadFindings[];
  readonly notChecked: readonly NotCheckedItem[];
  readonly assumptions: readonly Assumption[];
  /**
   * One record per file (or stream) holding a Kubernetes object that could not be
   * identified (its name or namespace is not literal text). The report adds them
   * to the files not checked, so such an object never vanishes and the run is
   * never clean.
   */
  readonly unidentifiedObjects: readonly UncheckedInput[];
  /** Terraform files the reader could not read: listed as not checked, so the run is never clean. */
  readonly unreadTerraform: readonly UncheckedInput[];
  /** Node source files the reader could not read: listed as not checked, so the run is never clean. */
  readonly unreadSources: readonly UncheckedInput[];
  /** The waivers as written, inline and in tripcurve.yaml, validated by nothing: WaiverApplier judges them. */
  readonly waiverRecords: readonly RawWaiverRecord[];
  /** The Terraform resources read, with the lines of each block: inline waivers attach by line. */
  readonly terraformResources: readonly TfResource[];
}

/** The reader's `object-not-identified` markers as unchecked-input records, one per file. */
function unidentifiedObjectsOf(unresolved: readonly ReaderUnresolved[]): UncheckedInput[] {
  const out: UncheckedInput[] = [];
  const seen = new Set<string>();
  for (const u of unresolved) {
    if (u.what !== 'object-not-identified') continue;
    const at = u.where;
    if (at.type !== 'file' && at.type !== 'stdin') continue;
    const path = at.type === 'file' ? at.file : STDIN;
    const key = at.type === 'file' ? `f${rawInputTextForParser(at.file)}` : 's';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, reasonCode: 'object-not-identified' });
  }
  return out;
}

/**
 * The resolver's assumptions, then those the rules' verdicts used (every assumption actually
 * used, each once): the propagation allowance behind a T2 verdict, the lightship detection behind a
 * lightship default, the version file a ceiling came from.
 */
function withRuleAssumptions(
  resolved: readonly Assumption[],
  results: readonly WorkloadFindings[],
): Assumption[] {
  const seen = new Set<string>();
  const out: Assumption[] = [];
  const add = (a: Assumption): void => {
    if (seen.has(a.text)) return;
    seen.add(a.text);
    out.push(a);
  };
  for (const a of resolved) add(a);
  for (const r of results) for (const f of r.findings) for (const a of f.assumptions ?? []) add(a);
  return withoutImpliedVersionLines(out);
}

const ONE_VERSION = /^The (gunicorn|uvicorn) version is taken from (.+)\.$/s;

/**
 * "The gunicorn version is taken from X." says nothing that "The gunicorn and uvicorn versions are
 * taken from X." does not already say: the shorter line is dropped, so a file is not named twice.
 */
function withoutImpliedVersionLines(list: Assumption[]): Assumption[] {
  const texts = new Set(list.map((a) => a.text));
  return list.filter((a) => {
    const m = ONE_VERSION.exec(a.text);
    return m === null || !texts.has(`The gunicorn and uvicorn versions are taken from ${m[2]}.`);
  });
}

export function analyse(intake: IntakeResult, kb?: KnowledgeBase): AnalysisResult {
  const k8s = readKubernetes(intake);
  const config = readConfig(intake);
  const iac = readIac(intake);
  const graph = linkConfigGraph({ intake, k8s, config, iac });
  const unidentifiedObjects = unidentifiedObjectsOf(k8s.unresolved);
  if (graph.configErrors.length > 0) {
    const model: ResolvedModel = {
      workloads: [],
      queueWorkloads: [],
      notChecked: graph.notChecked,
      configErrors: graph.configErrors,
      unreadSources: [],
      assumptions: [],
    };
    return {
      configErrors: graph.configErrors,
      graph,
      model,
      results: [],
      notChecked: graph.notChecked,
      assumptions: [],
      unidentifiedObjects,
      unreadTerraform: iac.unchecked,
      unreadSources: [],
      waiverRecords: config.waiverRecords,
      terraformResources: iac.resources,
    };
  }
  const model = resolveWorkloads({ graph, intake, iac, ...(kb === undefined ? {} : { kb }) });
  const results = evaluateRules(model);
  return {
    configErrors: [],
    graph,
    model,
    results,
    notChecked: model.notChecked,
    assumptions: withRuleAssumptions(model.assumptions, results),
    unidentifiedObjects,
    unreadTerraform: iac.unchecked,
    unreadSources: model.unreadSources,
    waiverRecords: config.waiverRecords,
    terraformResources: iac.resources,
  };
}
