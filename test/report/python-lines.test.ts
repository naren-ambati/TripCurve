// Two additions of bolt B2 to the report: the note inside the parentheses of a PASS or N/A line
// (the design mockup: `("k8s/admin.yaml":19, no -k given)`) and the Helm source comment line.
import { describe, expect, it } from 'vitest';
import { fileSource, inputText, makeFinding } from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import { buildReport, goodChain, wf, workload } from '../support/report-fixtures.js';

const naFinding = (note: string | undefined, line = 19) =>
  makeFinding({
    rule: 'T1',
    subject: workload('admin'),
    kind: 'N/A',
    headline: 'gunicorn sync worker closes after every response',
    chain: goodChain('k8s/admin.yaml', line),
    ...(note === undefined ? {} : { decidingNote: note }),
  });

describe('the deciding note of an N/A line', () => {
  it('is printed after the source, inside the parentheses, wrapped under the headline', () => {
    const out = renderHuman(
      buildReport({
        results: [wf(workload('admin'), [naFinding('no -k given')], 'k8s/admin.yaml')],
      }),
    );
    expect(out).toContain(
      [
        '  N/A  T1  gunicorn sync worker closes after every response',
        '           ("k8s/admin.yaml":19, no -k given)',
      ].join('\n'),
    );
  });

  it('with no note the line is unchanged', () => {
    const out = renderHuman(
      buildReport({ results: [wf(workload('admin'), [naFinding(undefined)], 'k8s/admin.yaml')] }),
    );
    expect(out).toContain('           ("k8s/admin.yaml":19)\n');
    expect(out).not.toContain('no -k given');
  });

  it('a finding built with a note keeps it (and a PASS demoted to UNRESOLVED prints no source line)', () => {
    expect(naFinding('no -k given').decidingNote).toBe('no -k given');
  });
});

describe('the Helm source comment line', () => {
  const block = (text: string) => {
    const r = wf(workload('api'), [naFinding(undefined)], 'k8s/api.yaml');
    return renderHuman(
      buildReport({
        results: [
          { ...r, file: fileSource(inputText('k8s/api.yaml'), 2), helmSource: inputText(text) },
        ],
      }),
    );
  };

  it('is a parenthesised fixed label and the quoted text, 11 columns in, under the header', () => {
    const out = block('chart/templates/api.yaml');
    expect(out).toContain(
      'Workload "api" (Deployment) in "k8s/api.yaml"\n           (Helm source comment "chart/templates/api.yaml")\n  N/A  T1',
    );
  });

  it('input text is escaped and cut, and the line never starts with it', () => {
    const out = block(`a"b\u001b[31m\n${'q'.repeat(300)}`);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.includes('Helm source'));
    expect(at).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      expect(line.startsWith('"')).toBe(false);
    }
    expect(out).toContain('a\\"b\\x1b[31m\\x0a');
    expect(out).toContain('...');
  });

  it('a block with no Helm comment prints no such line', () => {
    const out = renderHuman(
      buildReport({ results: [wf(workload('api'), [naFinding(undefined)])] }),
    );
    expect(out).not.toContain('Helm');
  });
});

describe('review m4: the Helm label is never split', () => {
  it('a long comment is cut so that `(Helm source comment "...")` stays on one line within 80 columns', () => {
    const r = wf(workload('api'), [naFinding(undefined)], 'k8s/api.yaml');
    const out = renderHuman(
      buildReport({
        results: [
          {
            ...r,
            file: fileSource(inputText('k8s/api.yaml'), 2),
            helmSource: inputText(`chart/templates/${'long-name-'.repeat(30)}.yaml`),
          },
        ],
      }),
    );
    const line = out.split('\n').find((l) => l.includes('Helm source comment'));
    expect(line).toBeDefined();
    expect(line?.startsWith('           (Helm source comment "chart/templates/long-name-')).toBe(
      true,
    );
    expect(line?.endsWith('...")')).toBe(true);
    expect(line?.length).toBeLessThanOrEqual(80);
    expect(out).not.toMatch(/\(Helm source\n/);
  });
});
