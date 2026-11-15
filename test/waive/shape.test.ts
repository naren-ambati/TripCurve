// Bolt B6: a `waive:` key that is not a list is one listed invalid waiver, never a configuration
// error that stops the run; and a repeated key inside a waive entry names the key.
import { afterEach, describe, expect, it } from 'vitest';
import { check, render } from '../../src/index.js';
import { WAIVER_PROBLEMS } from '../../src/waive/index.js';
import { fixtureTree } from '../support/fixture-tree.js';
import type { Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function run(config: string) {
  const t = fixtureTree('python/api-admin', { 'tripcurve.yaml': config });
  trees.push(t);
  const report = check({ path: t.root, today: '2026-11-12' });
  return { report, text: render(report, 'human') };
}

describe('a waive: that is not a list', () => {
  it.each([
    ['a scalar', 'version: 1\nwaive: 5\n', '"5"'],
    ['a string', 'version: 1\nwaive: "soon"\n', '"\\"soon\\""'],
    ['a mapping', 'version: 1\nwaive:\n  rule: T2\n', '"rule: T2"'],
    ['nothing', 'version: 1\nwaive:\n', '""'],
    ['an empty mapping', 'version: 1\nwaive: {}\n', '"{}"'],
  ])('%s is a listed invalid waiver and the run goes on', (_name, config, quoted) => {
    const { report, text } = run(config);
    expect(report.configErrors).toEqual([]);
    expect(report.waivers.map((w) => w.state)).toEqual(['invalid']);
    expect(report.waivers[0]?.problem).toBe(WAIVER_PROBLEMS['waive-not-a-list']);
    // everything else was checked: the findings are there, the waiver is counted under unresolved (file)
    expect(report.blocks.length).toBeGreaterThan(0);
    expect(report.summary.counts.failed).toBe(2);
    expect(report.summary.unresolvedDetail.waivers).toBe(1);
    expect(report.summary.exitCode).toBe(1);
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('waive must be a list of entries; it suppresses nothing');
    expect(flat).toContain(`waiver ${quoted} at "tripcurve.yaml":2`);
    expect(text).not.toContain('Config error');
  });

  it('a list (even an empty one) is still the normal case', () => {
    expect(run('version: 1\nwaive: []\n').report.waivers).toEqual([]);
  });
});

describe('a repeated key inside a waive entry', () => {
  it('names the key, quoted, instead of "(file)"', () => {
    const { text, report } = run(
      'version: 1\nwaive:\n  - rule: T2\n    rule: T1\n    workload: api\n    reason: x\n    until: 2027-01-01\n',
    );
    expect(report.summary.exitCode).toBe(2);
    expect(text).toContain(
      'Config error in "tripcurve.yaml" at line 4: key "rule" is not in a form',
    );
    expect(text).not.toContain('key "(file)"');
  });

  it('a syntax error on a line that is not a key says the file could not be read, not "(file)" (review of B7, m3)', () => {
    const { text } = run('version: 1\nwaive: [unclosed\n');
    expect(text).toContain('the config file could not be read.');
    expect(text).not.toContain('key "(file)"');
  });
});
