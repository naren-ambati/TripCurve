// Helpers for the Python server tests: build a container, a gunicorn.conf.py or a
// Dockerfile as the readers receive them (through intake), and summarise contributions
// as short strings for exact expectations.
import { inputText, isUnresolved } from '../../src/core/index.js';
import { type InputFile, intake } from '../../src/parse/intake/index.js';
import type { K8sContainer } from '../../src/parse/k8s/index.js';
import { readKubernetes } from '../../src/parse/k8s/index.js';
import type { PyContribution, PyValue } from '../../src/parse/python/index.js';
import { txt, where } from './render.js';
import { makeTree, type Tree } from './tmp-tree.js';

const trees: Tree[] = [];
export function cleanupPythonTrees(): void {
  for (const t of trees.splice(0)) t.cleanup();
}

const HEAD = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  selector:
    matchLabels: {app: app}
  template:
    metadata:
      labels: {app: app}
    spec:
      containers:
        - name: app
`;

/** The one container of a Deployment whose container body is `body` (lines indented 10 spaces). Line 1 of the body is file line 14. */
export function containerFrom(body: string): K8sContainer {
  const t = makeTree();
  trees.push(t);
  t.write('app.yaml', `${HEAD}${body}\n`);
  const found = readKubernetes(intake({ root: t.root })).workloads[0]?.containers[0];
  if (found === undefined) throw new Error('no container');
  return found;
}

function fileOf(name: string, text: string, cls: string): InputFile {
  const t = makeTree();
  trees.push(t);
  t.write(name, text);
  const f = intake({ root: t.root }).files.find((x) => x.class === cls);
  if (f === undefined) throw new Error(`no ${cls} file`);
  return f;
}
export const configFile = (text: string): InputFile =>
  fileOf('gunicorn.conf.py', text, 'gunicorn-conf');
export const dockerfile = (text: string): InputFile => fileOf('Dockerfile', text, 'dockerfile');

export function show(value: PyValue | undefined): string {
  if (value === undefined) return 'none';
  if (isUnresolved(value)) return `?${value.reason}`;
  const v = value.value;
  const text = typeof v === 'number' || typeof v === 'string' ? String(v) : txt(v);
  return `${text}${value.unit === 'none' ? '' : value.unit}@${where(value.source)}`;
}

export function showAll(list: readonly PyContribution[]): string[] {
  return list.map((c) => `${c.origin}:${show(c.value)}`);
}

// ---- precision fixtures -------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AnalysisResult } from '../../src/analyse.js';
import type { KnowledgeBase } from '../../src/kb/index.js';
import { analyseFiles, renderChain, t1Of } from './analyse.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'python');

function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** The files of one precision case (not the shared Ingress and Service). */
export function analysePrecisionFiles(name: string): Record<string, string> {
  return filesUnder(join(FIXTURES, 'precision', name));
}

/** The shared Ingress and Service plus the files of one precision case, run through the whole pipeline. */
export function analysePrecision(
  name: string,
  options: { kb?: KnowledgeBase; extra?: Record<string, string | null> } = {},
): AnalysisResult {
  const files = {
    ...filesUnder(join(FIXTURES, 'common')),
    ...filesUnder(join(FIXTURES, 'precision', name)),
    ...(options.extra ?? {}),
  };
  return analyseFiles(files, { base: {}, ...(options.kb === undefined ? {} : { kb: options.kb }) })
    .result;
}

/** The T1 result of the first workload, as kind, headline and chain lines. */
export function t1Summary(result: AnalysisResult): {
  kind: string;
  headline: string;
  chain: string[];
} {
  const f = t1Of(result);
  return { kind: f.kind, headline: f.headline, chain: renderChain(f) };
}

// ---- inline cases ----------------------------------------------------------------------

import albKb from '../../src/kb/data/alb.json' with { type: 'json' };
import pythonKb from '../../src/kb/data/python-servers.json' with { type: 'json' };
import { loadKnowledgeBase } from '../../src/kb/index.js';

const COMMON = filesUnder(join(FIXTURES, 'common'));
/** A test that passes its own knowledge base is about the verdict path: the release is known (a pin). */
const PINS = { 'requirements.txt': 'gunicorn==26.2.0\nuvicorn==0.54.0\n' };

/**
 * One Deployment `app` behind the shared ALB Ingress. With a knowledge base argument a `requirements.txt`
 * pinning gunicorn and uvicorn is added (unless `extra` has one), so the release is known.
 * `container` are the lines of the container
 * after `ports:` (10 spaces of indent), so the first of them is file line 20 of k8s/app.yaml.
 */
export function pythonApp(
  container: string,
  extra: Record<string, string | null> = {},
  kb?: KnowledgeBase,
): AnalysisResult {
  const manifest = `${readFileSync(
    join(FIXTURES, 'precision', 'sync-default', 'k8s', 'app.yaml'),
    'utf8',
  )
    .split('\n')
    .slice(0, 19)
    .join('\n')}\n${container}\n`;
  return analyseFiles(
    { ...COMMON, 'k8s/app.yaml': manifest, ...(kb === undefined ? {} : PINS), ...extra },
    { base: {}, ...(kb === undefined ? {} : { kb }) },
  ).result;
}

/**
 * The shipped Python entries with every range widened to `*` and (optionally) only the listed ids:
 * a stand-in for "a version source exists", to run the verdict path with the exact citation.
 */
export function starKb(ids?: readonly string[]): KnowledgeBase {
  const widened = pythonKb.entries
    .filter((e) => ids === undefined || ids.includes(e.id))
    .map((e) => ({ ...e, applies: { ...e.applies, versionRange: '*' } }));
  // the uvicorn worker needs a covered uvicorn version: keep the real 0.54.x entry unless widened
  const real = pythonKb.entries.filter(
    (e) => e.id === 'uvicorn-keepalive-0-54x' && !widened.some((w) => w.id === e.id),
  );
  return loadKnowledgeBase([albKb, { schemaVersion: 1, entries: [...widened, ...real] }]);
}

export const NO_VERSION = 'no gunicorn version in the files';
export const LB_STEP = 'LB idle: 60 s @ "k8s/ingress.yaml":9';

/**
 * A file as intake would hand it over, with no size limit: for tests that grow an input past what
 * intake accepts (5 MB) to see how the reader itself scales.
 */
export function fakeFile(text: string, cls: InputFile['class'], name = `f.${cls}`): InputFile {
  return { canonicalPath: inputText(name), class: cls, text: inputText(text), lineIndex: [] };
}

/** The files of a reviewer fixture under test/fixtures/python/review/<name>. */
export function reviewFiles(name: string): Record<string, string> {
  return filesUnder(join(FIXTURES, 'review', name));
}
