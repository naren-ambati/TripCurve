// Helpers for the link, resolve and evaluate tests: build a tree from text, run
// the whole pipeline, and render findings as plain strings for exact expectations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AnalysisResult, analyse } from '../../src/analyse.js';
import {
  type ChainStep,
  type ChainValue,
  type Finding,
  formatDefaultSource,
  isInputText,
  isNoteValue,
  isSourcedValue,
  isUnresolved,
  type SourceRef,
} from '../../src/core/index.js';
import type { KnowledgeBase } from '../../src/kb/index.js';
import { intake } from '../../src/parse/index.js';
import { txt } from './render.js';
import { makeTree, type Tree } from './tmp-tree.js';

const DEMO = join(import.meta.dirname, '..', 'fixtures', 'link', 'web-demo');

/**
 * The shutdown settings the demo fixture carries since bolt B4 (the T2 and T3 golden needs them):
 * a preStop sleep of 10 s and a grace period of 45 s. They are the last lines of `k8s/web.yaml`.
 */
export const DEMO_SHUTDOWN_TAIL = [
  '          lifecycle:',
  '            preStop:',
  '              exec:',
  '                command: ["sleep", "10"]',
  '      terminationGracePeriodSeconds: 45',
  '',
].join('\n');

const DEMO_WEB_FULL = readFileSync(join(DEMO, 'k8s', 'web.yaml'), 'utf8');
if (!DEMO_WEB_FULL.endsWith(DEMO_SHUTDOWN_TAIL))
  throw new Error('the demo fixture lost its shutdown settings');

/**
 * The demo as the T1 tests use it: the same files without the shutdown settings, so that a T1 test
 * is about T1 (no T2 verdict, no propagation assumption). `DEMO_FILES_SHUTDOWN` has them.
 */
export const DEMO_FILES: Readonly<Record<string, string>> = Object.freeze({
  'k8s/ingress.yaml': readFileSync(join(DEMO, 'k8s', 'ingress.yaml'), 'utf8'),
  'k8s/service.yaml': readFileSync(join(DEMO, 'k8s', 'service.yaml'), 'utf8'),
  'k8s/web.yaml': DEMO_WEB_FULL.slice(0, DEMO_WEB_FULL.length - DEMO_SHUTDOWN_TAIL.length),
  'src/server.ts': readFileSync(join(DEMO, 'src', 'server.ts'), 'utf8'),
});

/** The demo with its shutdown settings (the fixture as it is on disk). */
export const DEMO_FILES_SHUTDOWN: Readonly<Record<string, string>> = Object.freeze({
  ...DEMO_FILES,
  'k8s/web.yaml': DEMO_WEB_FULL,
});

const trees: Tree[] = [];
export function cleanupTrees(): void {
  for (const t of trees.splice(0)) t.cleanup();
}

/** Writes the files (a null value drops a demo file) and runs the whole pipeline on them. */
export function analyseFiles(
  files: Record<string, string | null>,
  options: {
    kb?: KnowledgeBase;
    base?: Readonly<Record<string, string>>;
    /** Runs after the files are written, before intake (for symlinks). */
    before?: (tree: Tree) => void;
  } = {},
): { result: AnalysisResult; tree: Tree } {
  const tree = makeTree();
  trees.push(tree);
  const merged: Record<string, string | null> = { ...(options.base ?? DEMO_FILES), ...files };
  for (const [path, text] of Object.entries(merged)) if (text !== null) tree.write(path, text);
  options.before?.(tree);
  return { result: analyse(intake({ root: tree.root }), options.kb), tree };
}

export function whereOf(source: SourceRef): string {
  switch (source.type) {
    case 'file':
    case 'declared':
      return `${JSON.stringify(txt(source.file))}:${source.line}`;
    case 'stdin':
      return `<stdin> document ${source.document}, line ${source.line}`;
    case 'default':
      return formatDefaultSource(source);
  }
}

export function renderValue(value: ChainValue): string {
  if (isInputText(value)) return JSON.stringify(txt(value));
  if (isUnresolved(value)) return `? ${value.reason}`;
  if (isNoteValue(value)) return value.note;
  if (!isSourcedValue(value)) throw new Error('not a chain value');
  const raw = isInputText(value.value) ? JSON.stringify(txt(value.value)) : String(value.value);
  const unit = value.unit === 'none' ? '' : ` ${value.unit}`;
  // a number computed from literals (B17) shows its expression, as input text
  const expression =
    value.expression === undefined ? '' : ` = ${JSON.stringify(txt(value.expression))}`;
  return `${raw}${unit}${expression} @ ${whereOf(value.source)}`;
}

export function renderStep(step: ChainStep): string {
  const head = step.detail === undefined ? step.label : `${step.label} ${step.detail}`;
  const values = [step.value, ...(step.more ?? [])].map(renderValue).join(', ');
  return `${head}: ${values}`;
}

export function renderChain(finding: Finding): string[] {
  return finding.chain.map(renderStep);
}

export function t1Of(result: AnalysisResult, index = 0): Finding {
  const entry = result.results[index];
  const finding = entry?.findings.find((f) => f.rule === 'T1');
  if (finding === undefined) throw new Error('no T1 finding');
  return finding;
}

export function withEnv(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error('the text to replace is not there');
  return text.replace(from, to);
}

/** The finding of one rule for the workload at `index` (the order the resolver gave them). */
export function ruleOf(result: AnalysisResult, rule: Finding['rule'], index = 0): Finding {
  const entry = result.results[index];
  const finding = entry?.findings.find((f) => f.rule === rule);
  if (finding === undefined) throw new Error(`no ${rule} finding`);
  return finding;
}

/** `KIND headline`, the first line of a finding. */
export function lineOf(finding: Finding): string {
  return `${finding.kind} ${finding.headline}`;
}

/**
 * The demo `web` Deployment (without its shutdown settings) with a container `lifecycle` block, pod-level
 * lines and a different command written in. `lifecycle` lines are indented as container keys (10 spaces),
 * `pod` lines as pod spec keys (6 spaces). The first appended line is file line 22.
 */
export function webManifest(
  options: { lifecycle?: string; pod?: string; command?: string } = {},
): string {
  let text = DEMO_FILES['k8s/web.yaml'] as string;
  if (options.command !== undefined) {
    text = text.replace('command: ["node", "src/server.ts"]', `command: ${options.command}`);
  }
  const lifecycle = options.lifecycle === undefined ? '' : `${options.lifecycle}\n`;
  const pod = options.pod === undefined ? '' : `${options.pod}\n`;
  return `${text}${lifecycle}${pod}`;
}

/** The standard preStop of the demo as a container `lifecycle` block of `seconds`. */
export function sleepLifecycle(seconds: number | string): string {
  return [
    '          lifecycle:',
    '            preStop:',
    '              exec:',
    `                command: ["sleep", "${seconds}"]`,
  ].join('\n');
}
