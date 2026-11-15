// Review finding M4: a Kubernetes object the reader cannot identify (the name
// is a map, as in an unquoted Helm template, or the name or namespace is not
// text) used to vanish: `K8sReadResult.unresolved` was never consumed. It must
// now reach the report as an unchecked file, so the run is never clean.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { intake } from '../../src/parse/index.js';
import { assembleReport } from '../../src/report/index.js';
import { analyseFiles, cleanupTrees } from '../support/analyse.js';
import { txt } from '../support/render.js';

afterEach(cleanupTrees);

const HOSTILE = join(import.meta.dirname, '..', 'fixtures', 'hostile');
const read = (dir: string): string => readFileSync(join(HOSTILE, dir, 'deployment.yaml'), 'utf8');

function reportFor(files: Record<string, string | null>) {
  const { result, tree } = analyseFiles(files);
  return assembleReport({ checked: '.', intake: intake({ root: tree.root }), analysis: result });
}

describe('an object the reader cannot identify is reported, never dropped', () => {
  it.each([
    ['an unquoted Helm template as the name', 'helm-name'],
    ['a number as the namespace', 'non-text-namespace'],
  ])('%s makes the file not checked and the run Incomplete', (_label, dir) => {
    const report = reportFor({ 'k8s/odd.yaml': read(dir) });
    expect(report.unchecked.map((u) => `${txt(u.path as never)}|${u.reasonCode}`)).toEqual([
      'k8s/odd.yaml|object-not-identified',
    ]);
    expect(report.summary.outcome).toBe('Incomplete');
    expect(report.summary.clean).toBe(false);
    expect(report.summary.exitCode).toBe(1);
  });

  it('is not hidden when the file also failed for another reason (one entry per file)', () => {
    const report = reportFor({ 'k8s/odd.yaml': `${read('helm-name')}\n---\nkind: [unclosed\n` });
    expect(report.unchecked).toHaveLength(1);
    expect(report.summary.outcome).toBe('Incomplete');
  });

  it('a nameless IngressClass is reported the same way', () => {
    const report = reportFor({
      'k8s/class.yaml': 'apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata: {}\n',
    });
    expect(report.unchecked.map((u) => u.reasonCode)).toEqual(['object-not-identified']);
  });

  it('objects that identify cleanly add nothing', () => {
    const report = reportFor({});
    expect(report.unchecked).toEqual([]);
  });

  it('the analysis result carries them too, for every consumer of it', () => {
    const { result } = analyseFiles({ 'k8s/odd.yaml': read('helm-name') });
    expect(result.unidentifiedObjects.map((u) => u.reasonCode)).toEqual(['object-not-identified']);
    // and analyse() itself is unchanged for a clean tree
    const clean = analyseFiles({}).result;
    expect(clean.unidentifiedObjects).toEqual([]);
  });
});
