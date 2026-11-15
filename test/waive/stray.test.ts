// Bolt B6: a waiver comment in a YAML file that tripcurve does not otherwise read (a values file,
// a non-Kubernetes file, a comment-only file) is never dropped: it is listed, names no workload, and the
// run is not clean.
import { afterEach, describe, expect, it } from 'vitest';
import { check, render } from '../../src/index.js';
import { intake } from '../../src/parse/index.js';
import { WAIVER_PROBLEMS } from '../../src/waive/index.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import type { Tree } from '../support/tmp-tree.js';
import { makeTree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

const WAIVE = '# tripcurve: ignore T2 reason="meant for web" until=2027-03-01';
const TODAY = '2026-11-12';

function run(overlay: Record<string, string>) {
  const t = fixtureTree('link/web-demo-fixed', overlay);
  trees.push(t);
  const report = check({ path: t.root, today: TODAY });
  return { report, text: render(report, 'human') };
}

describe('the clean fixture is clean', () => {
  it('ends All checks passed, so the cases below change the outcome', () => {
    const r = run({});
    expect(r.report.summary.exitCode).toBe(0);
    expect(r.text).toContain('All checks passed (3)');
  });
});

describe.each([
  ['a Helm values.yaml', 'values.yaml', `replicas: 2\n${WAIVE}\n`],
  ['a non-Kubernetes YAML file', 'ci/pipeline.yml', `stages:\n  - build\n${WAIVE}\n`],
  ['a comment-only file', 'notes.yaml', `${WAIVE}\n`],
  ['a comment-only .yml file in a folder', 'k8s/note.yml', `# a note\n${WAIVE}\n`],
  ['a file with an uppercase extension', 'k8s/NOTE.YAML', `${WAIVE}\n`],
])('a waiver comment in %s', (_name, path, text) => {
  const r = run({ [path]: text });

  it('is listed, as a waiver that sits in no workload block', () => {
    expect(r.report.waivers.map((w) => w.state)).toEqual(['invalid']);
    expect(r.report.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['outside-block']);
    expect(r.report.waiversNotApplied).toHaveLength(1);
  });

  it('is counted under unresolved (file) and the run no longer says All checks passed', () => {
    expect(r.report.summary.counts.unresolved).toBe(1);
    expect(r.report.summary.exitCode).toBe(1);
    expect(r.text).not.toContain('All checks passed');
    expect(r.text).toContain('Waivers not applied');
    expect(r.text).toContain(`"${path}":`);
  });
});

describe('what is not a waiver stays unread', () => {
  it.each([
    ['an empty .yml file', 'empty.yml', ''],
    [
      'a YAML file with an ordinary comment',
      'values.yaml',
      'a: 1 # not ours\n# tripcurve is great\n',
    ],
    ['text in a quoted scalar', 'values.yaml', `note: "${WAIVE}"\n`],
    ['a file that is not YAML by name', 'notes.txt', `${WAIVE}\n`],
  ])('%s', (_name, path, text) => {
    const r = run({ [path]: text });
    expect(r.report.waivers).toEqual([]);
    expect(r.report.summary.exitCode).toBe(0);
  });

  it('a broken YAML file that holds a waiver comment still lists it', () => {
    const r = run({ 'values.yaml': `a: [unclosed\n${WAIVE}\n` });
    expect(r.report.waivers.map((w) => w.state)).toEqual(['invalid']);
  });

  it('a file under node_modules is never walked, so its comment is not read', () => {
    const r = run({ 'node_modules/x/values.yaml': `${WAIVE}\n` });
    expect(r.report.waivers).toEqual([]);
  });

  it('a file over the size limit is listed as unchecked, as before', () => {
    const r = run({ 'big.yaml': `# ${'x'.repeat(5_000_001)}\n` });
    expect(r.report.unchecked.map((u) => u.reasonCode)).toEqual(['over-size']);
    expect(r.report.summary.exitCode).toBe(1);
  });
});

describe('N2: the scan of an unclassified YAML file is a line pass, never a parse', () => {
  const stray = (text: string) => {
    const t = makeTree();
    trees.push(t);
    t.write('values.yaml', text);
    const read = intake({ root: t.root });
    t.cleanup();
    return read.strayWaiverComments ?? [];
  };

  it.each([
    ['1M lines of ---', (n: number) => '---\n'.repeat(n)],
    ['a long run of [', (n: number) => '['.repeat(n * 2)],
  ])(
    '%s: 4x the input takes about 4x the time',
    (_name, make) => {
      expect(scalingRatio((n) => stray(make(n)), 50_000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('still finds the comment among hostile lines, with its line and text', () => {
    const found = stray(`${'---\n'.repeat(1000)}a: [\n  ${WAIVE}\nb: 1 ${WAIVE}\n`);
    expect(found.map((f) => f.line)).toEqual([1002, 1003]);
  });

  it('lists a comment-like line inside a block scalar too (over-listing is safe, dropping is not)', () => {
    expect(stray(`text: |\n  ${WAIVE}\n`)).toHaveLength(1);
  });

  it('does not list a marker inside a quoted string or an ordinary comment', () => {
    expect(stray(`a: "${WAIVE}"\n# tripcurve is great\n`)).toEqual([]);
  });
});

describe('N2: the cost of the scan is that of a line pass, not of a YAML parse', () => {
  // A relative bound, no wall-clock budget: the scan of a hostile file against a plain split of the same text
  // on the same machine in the same run. A YAML parse of these shapes is 50 to 100 times a split.
  const best = (run: () => void): number => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      run();
      fastest = Math.min(fastest, performance.now() - t0);
    }
    return fastest;
  };
  it.each([
    ['1M lines of ---', '---\n'.repeat(1_000_000)],
    ['a 2 MB run of [', '['.repeat(2_000_000)],
  ])(
    '%s costs at most 25 times a split of the text',
    (_name, text) => {
      const t = makeTree();
      trees.push(t);
      t.write('values.yaml', text);
      const scan = best(() => intake({ root: t.root }));
      const baseline = best(() => text.split('\n'));
      t.cleanup();
      expect(scan / Math.max(baseline, 1)).toBeLessThan(25);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});
