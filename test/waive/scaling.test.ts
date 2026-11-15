// Hostile input must not freeze the tool (NFR): a tripcurve.yaml or a manifest can hold tens of
// thousands of waivers. Matching them to workloads and to the objects their comment lines sit in has to
// stay linear (no wall-clock budget: the ratio of the time at 4n to the time at n, test/support/scaling.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText } from '../../src/core/index.js';
import type { WorkloadFindings } from '../../src/evaluate/index.js';
import { intake, readConfig, readIac } from '../../src/parse/index.js';
import { applyWaivers, readWaiver } from '../../src/waive/index.js';
import { finding, workload } from '../support/report-fixtures.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';
import { entry, VALID_ENTRY } from '../support/waiver-records.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

const TODAY = '2026-11-12';

function blocks(
  names: readonly string[],
  file: (i: number) => { path: string; line: number },
): WorkloadFindings[] {
  return names.map((name, i) => {
    const subject = workload(name);
    const at = file(i);
    return {
      workload: subject,
      file: fileSource(inputText(at.path), at.line),
      findings: [finding('FAIL', 'T2', subject)],
    };
  });
}

function run(files: Record<string, string>, results: WorkloadFindings[]) {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const read = intake({ root: t.root });
  const records = readConfig(read).waiverRecords;
  const out = applyWaivers({
    results,
    records,
    knownWorkloads: results.map((r) => r.workload as never),
    intake: read,
    terraform: readIac(read).resources,
    today: TODAY,
  });
  t.cleanup();
  return out;
}

const WAIVE = '# tripcurve: ignore T2 reason="r" until=2027-01-31';

describe('WaiverApplier is linear', () => {
  it(
    'inline waivers in n documents, each one for the workload in its own document',
    () => {
      const work = (n: number) => {
        const names = Array.from({ length: n }, (_, i) => `w${i}`);
        // each document: apiVersion, kind, a comment, then the next `---` (4 lines with the separator)
        const text = names
          .map(
            (name) =>
              `apiVersion: apps/v1\nkind: Deployment\n${WAIVE}\nmetadata:\n  name: ${name}\n`,
          )
          .join('---\n');
        const out = run(
          { 'k8s/all.yaml': text },
          blocks(names, (i) => ({ path: 'k8s/all.yaml', line: 2 + i * 6 })),
        );
        expect(out.waivers.every((w) => w.state === 'applied')).toBe(true);
      };
      expect(scalingRatio(work, 500)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'inline waivers in a List of n items',
    () => {
      const work = (n: number) => {
        const names = Array.from({ length: n }, (_, i) => `w${i}`);
        const items = names
          .map(
            (name) => `  - kind: Deployment\n    metadata:\n      name: ${name}\n      ${WAIVE}\n`,
          )
          .join('');
        const text = `apiVersion: v1\nkind: List\nitems:\n${items}`;
        const out = run(
          { 'k8s/list.yaml': text },
          blocks(names, (i) => ({ path: 'k8s/list.yaml', line: 4 + i * 4 })),
        );
        expect(out.waivers.every((w) => w.state === 'applied')).toBe(true);
      };
      expect(scalingRatio(work, 500)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'n waive: entries naming n workloads',
    () => {
      const work = (n: number) => {
        const names = Array.from({ length: n }, (_, i) => `w${i}`);
        const yaml = `version: 1\nwaive:\n${names
          .map(
            (name) =>
              `  - rule: T2\n    workload: ${name}\n    reason: "r"\n    until: 2027-01-31\n`,
          )
          .join('')}`;
        const out = run(
          { 'tripcurve.yaml': yaml, 'k8s/a.yaml': 'apiVersion: v1\nkind: Service\n' },
          blocks(names, () => ({ path: 'k8s/a.yaml', line: 2 })),
        );
        expect(out.waivers.every((w) => w.state === 'applied')).toBe(true);
      };
      expect(scalingRatio(work, 500)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'n waivers that all name the same finding (records built directly, so the grouping is what is timed)',
    () => {
      const subject = workload('api');
      const block: WorkloadFindings = {
        workload: subject,
        file: fileSource(inputText('k8s/a.yaml'), 2),
        findings: [finding('FAIL', 'T2', subject)],
      };
      const work = (n: number) => {
        const records = Array.from({ length: n }, (_v, i) => entry(VALID_ENTRY, 3 + i));
        const out = applyWaivers({
          results: [block],
          records,
          knownWorkloads: [subject],
          intake: { files: [] } as never,
          terraform: [],
          today: TODAY,
        });
        // two or more waivers for one finding cover neither: every one is listed as invalid
        expect(out.waivers.every((w) => w.state === 'invalid')).toBe(true);
      };
      expect(scalingRatio(work, 16000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('a hostile file full of waivers neither crashes nor freezes the report', () => {
    const lines = Array.from(
      { length: 20_000 },
      (_, i) =>
        `  - rule: T${(i % 6) + 1}\n    workload: ghost${i}\n    reason: "r"\n    until: 2027-01-31\n`,
    );
    const out = run(
      {
        'tripcurve.yaml': `version: 1\nwaive:\n${lines.join('')}`,
        'k8s/a.yaml': 'apiVersion: v1\nkind: Service\n',
      },
      [],
    );
    expect(out.waivers).toHaveLength(20_000);
    expect(out.waivers.every((w) => w.state === 'invalid')).toBe(true);
  });
});

describe('reading one waiver is linear in its text', () => {
  // review-style probe: a long run of blanks inside a `waive:` entry made the one-line collapse quadratic
  it(
    'a waive: entry with n blanks between its words',
    () => {
      const work = (n: number) => {
        const record = { ...entry(VALID_ENTRY), rawText: inputText(`rule: T2${' '.repeat(n)}x`) };
        readWaiver(record);
      };
      expect(scalingRatio(work, 20_000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'an inline waiver with n blanks, n backslashes or n quotes in its reason',
    () => {
      const inline = (text: string) =>
        readWaiver({
          rawFields: [],
          rawText: inputText(text),
          source: fileSource(inputText('k8s/a.yaml'), 3),
          mechanism: 'inline',
        });
      const work = (n: number) => {
        inline(`# tripcurve: ignore T2${' '.repeat(n)}reason="a" until=2027-01-31`);
        inline(`# tripcurve: ignore T2 reason="${'\\'.repeat(n)}" until=2027-01-31`);
        inline(`# tripcurve: ignore T2 reason="${'a'.repeat(n)}`);
        inline(`# tripcurve: ignore T2 reason="a"${' '.repeat(n)}until=2027-01-31${' '.repeat(n)}`);
      };
      expect(scalingRatio(work, 20_000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});
