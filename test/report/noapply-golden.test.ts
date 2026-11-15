import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderJson, renderSarif } from '../../src/report/index.js';
import { buildReport, finding, wf, workload } from '../support/report-fixtures.js';
import { validateSarif } from '../support/sarif-validate.js';

// Review of B7, m5: the NoChecksApply outcome has JSON and SARIF goldens too. No file that the command reads
// gives only N/A results (T2 and T3 never return N/A, so a workload behind a load balancer always has a T2
// result), so the report is built directly, the way the summary tests build it.

const golden = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'golden', name), 'utf8');

describe('golden: NoChecksApply (every result is not applicable)', () => {
  const report = buildReport({
    results: [
      wf(workload('a'), [finding('N/A', 'T1', workload('a'), 'headline of N/A')], 'k8s/web.yaml'),
    ],
  });

  it('JSON matches the golden', () => {
    expect(renderJson(report)).toBe(golden('report-noapply.json.txt'));
  });

  it('SARIF matches the golden, has no result, and says clean: true with passed 0', () => {
    expect(renderSarif(report)).toBe(golden('report-noapply.sarif.txt'));
    const log = JSON.parse(renderSarif(report));
    expect(validateSarif(log)).toEqual([]);
    expect(log.runs[0].results).toEqual([]);
    expect(log.runs[0].properties.tripcurve).toMatchObject({
      outcome: 'NoChecksApply',
      clean: true,
      exitCode: 0,
    });
    expect(log.runs[0].properties.tripcurve.summary.passed).toBe(0);
  });
});
