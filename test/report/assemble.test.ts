import { describe, expect, it } from 'vitest';
import { inputText } from '../../src/core/index.js';
import { buildBlocks, orderFindings } from '../../src/report/index.js';
import { txt } from '../support/render.js';
import {
  buildReport,
  configError,
  finding,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';

const names = (blocks: ReturnType<typeof buildBlocks>): string[] =>
  blocks.map((b) => ('mapping' in b.workload ? txt(b.workload.mapping) : txt(b.workload.name)));

describe('line order inside a block (rule 3)', () => {
  it('non-pass kinds first in the fixed order, each in rule order, then PASS and N/A in rule order', () => {
    const ordered = orderFindings([
      finding('PASS', 'T2'),
      finding('N/A', 'T1'),
      finding('UNRESOLVED', 'T3'),
      finding('FAIL', 'T2'),
      finding('NOT EVALUATED', 'T3'),
      finding('FAIL', 'T1'),
      finding('WAIVED', 'T4'),
      finding('WARN', 'T4'),
      finding('VERSION-DEPENDENT', 'T1'),
    ]);
    expect(ordered.map((f) => `${f.kind} ${f.rule}`)).toEqual([
      'FAIL T1',
      'FAIL T2',
      'WARN T4',
      'UNRESOLVED T3',
      'VERSION-DEPENDENT T1',
      'NOT EVALUATED T3',
      'WAIVED T4',
      'N/A T1',
      'PASS T2',
    ]);
  });
});

describe('block order (rule 3)', () => {
  it('blocks with a FAIL or WARN first, then kind, namespace and name in byte order', () => {
    const blocks = buildBlocks([
      wf(workload('z-pass', 'a', 'StatefulSet'), [finding('PASS')]),
      wf(workload('b-pass', 'b'), [finding('PASS')]),
      wf(workload('a-pass', 'b'), [finding('PASS')]),
      wf(workload('warned', 'zz'), [finding('WARN')]),
      wf(workload('pod', 'a', 'Pod'), [finding('PASS')]),
      wf(workload('failed-ds', 'a', 'DaemonSet'), [finding('FAIL')]),
      wf(workload('failed-dep', 'a'), [finding('FAIL')]),
      wf(workload('unres', 'a'), [finding('UNRESOLVED')]),
      wf(workload('a-pass', 'a'), [finding('PASS')]),
    ]);
    expect(names(blocks)).toEqual([
      'failed-dep', // FAIL group: Deployment first
      'warned',
      'failed-ds', // then DaemonSet
      'a-pass', // the rest: Deployment ns a
      'unres',
      'a-pass', // Deployment ns b
      'b-pass',
      'z-pass', // StatefulSet
      'pod', // Pod
    ]);
  });

  it('a kind off the fixed list sorts after the known kinds and prints quoted later', () => {
    const odd = workload('x', 'a', inputText('Rollout'));
    const blocks = buildBlocks([
      wf(odd, [finding('PASS')]),
      wf(workload('d', 'a', 'Pod'), [finding('PASS')]),
    ]);
    expect(names(blocks)).toEqual(['d', 'x']);
  });

  it('is independent of the order the workloads arrive in', () => {
    const a = wf(workload('a'), [finding('PASS')]);
    const b = wf(workload('b'), [finding('PASS')]);
    expect(names(buildBlocks([a, b]))).toEqual(names(buildBlocks([b, a])));
  });

  it('two objects with one kind, namespace and name keep a fixed order by file', () => {
    const one = wf(workload('dup'), [finding('PASS')], 'k8s/b.yaml');
    const two = wf(workload('dup'), [finding('PASS')], 'k8s/a.yaml');
    const files = (blocks: ReturnType<typeof buildBlocks>): string[] =>
      blocks.map((b) => (b.file.type === 'file' ? txt(b.file.file) : '?'));
    expect(files(buildBlocks([one, two]))).toEqual(['k8s/a.yaml', 'k8s/b.yaml']);
    expect(files(buildBlocks([two, one]))).toEqual(['k8s/a.yaml', 'k8s/b.yaml']);
  });
});

describe('the Report', () => {
  it('holds the header, blocks, unchecked files and the summary computed once', () => {
    const r = buildReport({
      results: [wf(workload('web'), [finding('FAIL')])],
      unchecked: [unchecked('k8s/broken.yaml', 'parse-error', 14)],
      filesRead: 5,
    });
    expect(r.header.version).toBe('0.1.1');
    expect(r.header.filesRead).toBe(5);
    expect(r.blocks).toHaveLength(1);
    expect(r.unchecked).toHaveLength(1);
    expect(r.summary.outcome).toBe('Incomplete');
    expect(r.summary.exitCode).toBe(1);
  });

  it('the standing zero-downtime assumption is present when a result exists, and only then', () => {
    const withResult = buildReport({ results: [wf(workload('web'), [finding('PASS')])] });
    expect(withResult.assumptions.map((a) => a.text)).toEqual([
      'Green never means zero-downtime: the SIGTERM race and the deregistration delay are outside these rules.',
    ]);
    expect(buildReport({ results: [] }).assumptions).toEqual([]);
  });

  it('lists each assumption once', () => {
    const dup = { text: 'assumed 60 s', reason: 'r' };
    const r = buildReport({
      results: [wf(workload('a'), [finding('PASS')]), wf(workload('b'), [finding('PASS')])],
      assumptions: [dup, { ...dup }, { text: 'other', reason: 'r' }],
    });
    expect(r.assumptions.map((a) => a.text).filter((t) => t === 'assumed 60 s')).toHaveLength(1);
    expect(r.assumptions).toHaveLength(3);
  });

  it('nothing recognised gives the no-files note and NothingChecked (exit 2)', () => {
    const r = buildReport({ noRecognisedFiles: true, filesRead: 0, checked: './docs' });
    expect(r.noFilesNote).toBeDefined();
    expect(r.summary.outcome).toBe('NothingChecked');
    expect(r.summary.exitCode).toBe(2);
  });

  it('configuration errors give outcome ConfigError, zero counts and exit 2, with no blocks', () => {
    const r = buildReport({
      configErrors: [configError('longest_request_s', 6)],
      results: [wf(workload('web'), [finding('FAIL')])],
    });
    expect(r.summary.outcome).toBe('ConfigError');
    expect(r.summary.exitCode).toBe(2);
    expect(r.summary.clean).toBe(false);
    expect(r.summary.counts.failed).toBe(0);
    expect(r.blocks).toEqual([]);
    expect(r.configErrors).toHaveLength(1);
  });

  it('the config-error case outranks the no-files case', () => {
    const r = buildReport({ configErrors: [configError('x')], noRecognisedFiles: true });
    expect(r.summary.outcome).toBe('ConfigError');
    expect(r.noFilesNote).toBeUndefined();
  });

  it('files read but no rule produced a result is NothingChecked (exit 2)', () => {
    const r = buildReport({ results: [], filesRead: 3 });
    expect(r.summary.outcome).toBe('NothingChecked');
    expect(r.summary.exitCode).toBe(2);
  });

  it('counts workloads not checked in the closing line only for workload items', () => {
    const r = buildReport({
      results: [wf(workload('a'), [finding('PASS')])],
      notChecked: [
        {
          subjectKind: 'workload',
          subject: inputText('w'),
          kind: 'Deployment',
          file: inputText('k8s/w.yaml'),
          reasonCode: 'no-recognised-lb',
        },
        {
          subjectKind: 'ingress',
          subject: inputText('i'),
          kind: 'Ingress',
          file: inputText('k8s/i.yaml'),
          reasonCode: 'not-alb-ingress',
        },
      ],
    });
    expect(r.summary.closingLines[0]).toBe(
      'All checks passed (1), 0 not applicable; 1 workload not checked.',
    );
  });
});
