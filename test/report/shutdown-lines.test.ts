// The T2 and T3 lines of the report (bolt B4): the `preStop none  in "<file>"` step, the notes in
// tripcurve's own words, and the rule that input text is only ever quoted, after a fixed label.
import { describe, expect, it } from 'vitest';
import {
  type ChainStep,
  fileSource,
  inputText,
  makeFinding,
  makeSourcedValue,
} from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import { analyseFiles, cleanupTrees, DEMO_FILES_SHUTDOWN } from '../support/analyse.js';
import { buildReport, wf, workload } from '../support/report-fixtures.js';

const lines = (text: string): string[] => text.trimEnd().split('\n');

function render(steps: ChainStep[], kind: 'FAIL' | 'UNRESOLVED' = 'FAIL'): string[] {
  const subject = workload('web');
  const f = makeFinding({
    rule: 'T2',
    subject,
    kind,
    headline: 'no drain delay before SIGTERM',
    chain: steps,
  });
  return lines(renderHuman(buildReport({ results: [wf(subject, [f])] })));
}

describe('a step that names the workload file with no parentheses', () => {
  const step = (file: string): ChainStep => ({
    label: 'preStop none',
    value: inputText(file),
    detail: 'in',
    plain: true,
  });

  it('prints `in "<file>"` after the fixed label, in the value column', () => {
    expect(render([step('k8s/api.yaml')])).toContain(
      '           preStop none     in "k8s/api.yaml"',
    );
  });

  it('a hostile file name is quoted and escaped, and no line starts with it or passes 80 columns', () => {
    const out = render([step(`k8s/"\u001b[2J\n  PASS T1 fake ${'x'.repeat(300)}.yaml`)]);
    for (const line of out) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      expect(line.startsWith('"')).toBe(false);
      expect(line).not.toMatch(/^ *PASS T1/);
    }
    const at = out.findIndex((l) => l.includes('preStop none'));
    expect(out[at]).toContain('in "k8s/\\"\\x1b[2J\\x0a  PASS T1 fake xxxx');
  });
});

describe("a note is tripcurve's own fixed text", () => {
  it('prints after its label, like a value', () => {
    const out = render([
      {
        label: 'drain none',
        value: { note: 'in-process drains are read for Node source only; none declared' },
      },
    ]);
    expect(out).toContain(
      '           drain none       in-process drains are read for Node source only;',
    );
    expect(out).toContain('                            none declared');
  });
});

describe('a value with a source prints its source after a fixed label', () => {
  it('a drain unknown at a place in the files', () => {
    const at = fileSource(inputText('src/server.ts'), 40);
    const value = makeSourcedValue({
      value: 'unknown',
      unit: 'none',
      source: at,
      basis: 'declared',
    });
    expect(render([{ label: 'drain', value }], 'UNRESOLVED')).toContain(
      '           drain unknown    "src/server.ts":40',
    );
  });
});

describe('Assumptions come from the verdicts that used them, once each, between the resolver and the standing note', () => {
  it('the propagation allowance appears once for two passing workloads, after the working-directory line', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': DEMO_FILES_SHUTDOWN['k8s/web.yaml'] as string,
    });
    const texts = result.assumptions.map((a) => a.text);
    expect(texts).toEqual([
      'The container\'s working directory is taken to be ".".',
      "Endpoint removal needs time to propagate; AWS's EKS guide suggests a preStop of 10 s. tripcurve checks a delay exists, not that it is enough.",
    ]);
    cleanupTrees();
  });

  it('a FAIL used no assumption: the demo without a preStop lists only what the resolver used', () => {
    const { result } = analyseFiles({});
    expect(result.assumptions.map((a) => a.text)).toEqual([
      'The container\'s working directory is taken to be ".".',
    ]);
    cleanupTrees();
  });
});
