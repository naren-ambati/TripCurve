import { describe, expect, it } from 'vitest';
import {
  type ChainStep,
  defaultSource,
  fileSource,
  inputText,
  makeFinding,
  makeSourcedValue,
  makeUnresolved,
  stdinSource,
} from '../../src/core/index.js';
import { renderJson } from '../../src/report/index.js';
import {
  buildReport,
  configError,
  finding,
  goodChain,
  queue,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';
import { entry, inline, VALID_ENTRY } from '../support/waiver-records.js';

// The JSON document, built from the Report model.

const TODAY = '2026-11-12';
const api = workload('api', 'shop');
const parse = (text: string) => JSON.parse(text);

function jsonOf(parts: Parameters<typeof buildReport>[0]) {
  return parse(renderJson(buildReport({ today: TODAY, ...parts })));
}

describe('the document', () => {
  const doc = jsonOf({ results: [wf(api, [finding('FAIL', 'T1')])] });

  it('has schemaVersion, the tool, the header and every list names, in order', () => {
    expect(Object.keys(doc)).toEqual([
      'schemaVersion',
      'tool',
      'checked',
      'workloads',
      'notChecked',
      'assumptions',
      'waivers',
      'unchecked',
      'configErrors',
      'summary',
    ]);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.tool).toEqual({ name: 'tripcurve', version: '0.1.1' });
    expect(doc.checked).toEqual({ path: '.', filesRead: 3 });
  });

  it('the summary is flat with the eight counts, outcome, clean, waivedDates and exitCode', () => {
    expect(Object.keys(doc.summary)).toEqual([
      'failed',
      'warning',
      'unresolved',
      'versionDependent',
      'notEvaluated',
      'waived',
      'notApplicable',
      'passed',
      'outcome',
      'clean',
      'waivedDates',
      'exitCode',
    ]);
    expect(doc.summary.failed).toBe(1);
    expect(doc.summary.clean).toBe(false);
    expect(doc.summary.exitCode).toBe(1);
  });

  it('a workload has its name, kind, namespace and file, and an event source mapping has no namespace', () => {
    const t4 = jsonOf({
      results: [wf(queue('orders'), [finding('FAIL', 'T4', queue('orders'))], 'infra/queue.tf')],
    });
    expect(t4.workloads[0]).toMatchObject({
      name: 'orders',
      kind: 'event source mapping',
      file: 'infra/queue.tf',
      line: 2,
    });
    expect('namespace' in t4.workloads[0]).toBe(false);
    expect(doc.workloads[0]).toMatchObject({ name: 'api', kind: 'Deployment', namespace: 'shop' });
  });

  it('is the same document on every call (deterministic)', () => {
    const report = buildReport({ results: [wf(api, [finding('FAIL')])], today: TODAY });
    expect(renderJson(report)).toBe(renderJson(report));
  });
});

describe('result values', () => {
  const fixed = defaultSource({
    citation: 'Node keepAliveTimeout 5 s + 1 s',
    range: 'Node 22.x from 22.12',
    basisText: 'measured on 22.23.2',
  });
  const chain: ChainStep[] = [
    {
      label: 'idle close',
      value: makeSourcedValue({ value: 6, unit: 's', source: fixed, basis: 'measured-on' }),
      decidedBy: fileSource(inputText('src/server.ts'), 7),
    },
    { label: 'source', value: makeUnresolved('not linked', 'link it') },
    { label: 'drain none', value: { note: 'none declared' } },
    {
      label: 'source',
      detail: 'no setting found in 2 files read',
      value: inputText('a.ts'),
      more: [inputText('b.ts')],
    },
  ];
  const f = makeFinding({
    rule: 'T1',
    subject: api,
    kind: 'UNRESOLVED',
    headline: 'h',
    chain,
    declare: ['declare it'],
  });
  const result = jsonOf({ results: [wf(api, [f])] }).workloads[0].results[0];

  it('a sourced value carries unit, source, basis words, confidence and the deciding source', () => {
    expect(result.chain[0]).toEqual({
      label: 'idle close',
      valueType: 'value',
      value: 6,
      unit: 's',
      source: {
        type: 'default',
        citation: 'Node keepAliveTimeout 5 s + 1 s',
        range: 'Node 22.x from 22.12',
        basis: 'measured on 22.23.2',
      },
      confidence: 'cited',
      decidedBy: { type: 'file', file: 'src/server.ts', line: 7 },
    });
  });

  it('an unresolved value is null with its reason and what to declare, never a number', () => {
    expect(result.chain[1]).toEqual({
      label: 'source',
      valueType: 'unresolved',
      value: null,
      reason: 'not linked',
      declareHint: 'link it',
    });
  });

  it('a note, and a list of file names (one entry each, the detail on the first), keep their order', () => {
    expect(result.chain[2]).toEqual({
      label: 'drain none',
      valueType: 'note',
      value: 'none declared',
    });
    expect(result.chain.slice(3)).toEqual([
      {
        label: 'source',
        detail: 'no setting found in 2 files read',
        valueType: 'text',
        value: 'a.ts',
      },
      { label: 'source', valueType: 'text', value: 'b.ts' },
    ]);
    expect(result.declare).toEqual(['declare it']);
  });

  it('a default source has no file and a stdin source has a document and a line', () => {
    const stdinValue = makeSourcedValue({
      value: 60,
      unit: 's',
      source: stdinSource(2, 9),
      basis: 'declared',
    });
    const r = jsonOf({
      results: [
        wf(api, [finding('PASS', 'T1', api, 'ok', [{ label: 'LB idle', value: stdinValue }])]),
      ],
    }).workloads[0].results[0];
    expect(r.chain[0].source).toEqual({ type: 'stdin', document: 2, line: 9, basis: 'declared' });
  });

  it('branches are listed with their outcome and chain', () => {
    const v = makeSourcedValue({ value: 6, unit: 's', source: fixed, basis: 'measured-on' });
    const withBranches = makeFinding({
      rule: 'T1',
      subject: api,
      kind: 'VERSION-DEPENDENT',
      headline: 'depends on the Node version',
      chain: [],
      branches: [
        {
          range: 'Node 22.x from 22.12',
          outcome: 'FAIL',
          chain: [{ label: 'idle close', value: v }],
        },
        { range: 'Node 24.x', outcome: 'unresolved: to be measured', chain: [] },
      ],
    });
    const r = jsonOf({ results: [wf(api, [withBranches])] }).workloads[0].results[0];
    expect(r.branches.map((b: { range: string; outcome: string }) => [b.range, b.outcome])).toEqual(
      [
        ['Node 22.x from 22.12', 'FAIL'],
        ['Node 24.x', 'unresolved: to be measured'],
      ],
    );
    expect(r.branches[0].chain[0].value).toBe(6);
  });
});

describe('waivers in every state', () => {
  const states = jsonOf({
    results: [
      wf(api, [finding('FAIL', 'T2', api, 'no drain'), finding('FAIL', 'T3', api, 'grace')]),
    ],
    waiverRecords: [
      entry(VALID_ENTRY), // applied
      entry({ ...VALID_ENTRY, workload: 'ghost' }), // invalid: no such workload
      entry({ ...VALID_ENTRY, rule: 'T1' }), // unmatched: no T1 finding
      entry({ rule: 'T3', workload: 'api', until: '2020-01-01', reason: 'old' }), // expired
    ],
  });

  it('lists every one with its state, in the order the readers gave them', () => {
    expect(states.waivers.map((w: { state: string }) => w.state)).toEqual([
      'applied',
      'invalid',
      'unmatched',
      'expired',
    ]);
  });

  it('an invalid waiver says what is wrong in tripcurve words; the others have no problem field', () => {
    const invalid = states.waivers[1];
    expect(invalid.problem).toBe('names a workload that was not read');
    expect(states.waivers[0].problem).toBeUndefined();
    expect(states.waivers[0]).toMatchObject({
      rule: 'T2',
      workload: { name: 'api' },
      until: '2027-01-31',
      reason: 'drains in sidecar',
      mechanism: 'config',
      source: { type: 'declared', file: 'tripcurve.yaml', line: 3 },
    });
  });

  it('an inline waiver is listed with its inline mechanism and the line of the comment', () => {
    const doc = jsonOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'no drain')])],
      waiverRecords: [
        inline('tripcurve: ignore T2 reason="r" until=2027-01-31', 'k8s/web.yaml', 2),
      ],
      intakeFiles: [],
    });
    expect(doc.waivers).toHaveLength(1);
    expect(doc.waivers[0].mechanism).toBe('inline');
    expect(doc.waivers[0].source).toEqual({ type: 'file', file: 'k8s/web.yaml', line: 2 });
  });

  it('a waived result keeps its original kind and headline, and counts as waived, never passed', () => {
    const waived = jsonOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'no drain delay before SIGTERM')])],
      waiverRecords: [entry(VALID_ENTRY)],
    });
    const r = waived.workloads[0].results[0];
    expect(r).toMatchObject({
      kind: 'WAIVED',
      originalKind: 'FAIL',
      headline: 'no drain delay before SIGTERM',
      waiver: { until: '2027-01-31', reason: 'drains in sidecar', mechanism: 'config' },
    });
    expect(waived.summary).toMatchObject({
      waived: 1,
      passed: 0,
      outcome: 'NoFailures',
      clean: true,
    });
  });

  it('an expired waiver is on the result that it no longer covers, which keeps its own kind', () => {
    const expired = jsonOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'no drain')])],
      waiverRecords: [entry({ ...VALID_ENTRY, until: '2026-11-01' })],
    });
    const r = expired.workloads[0].results[0];
    expect(r.kind).toBe('FAIL');
    expect(r.expiredWaiver).toMatchObject({ until: '2026-11-01', reason: 'drains in sidecar' });
    expect(r.waiver).toBeUndefined();
    expect(expired.summary.clean).toBe(false);
  });
});

describe('the other lists', () => {
  it('an unchecked file has its reason words and code, and a line only for a parse error', () => {
    const doc = jsonOf({
      results: [wf(api, [finding('PASS')])],
      unchecked: [unchecked('k8s/a.yaml', 'parse-error', 14), unchecked('k8s/b.yaml', 'over-size')],
    });
    expect(doc.unchecked).toEqual([
      {
        type: 'file',
        file: 'k8s/a.yaml',
        reason: 'YAML syntax error',
        reasonCode: 'parse-error',
        line: 14,
      },
      {
        type: 'file',
        file: 'k8s/b.yaml',
        reason: 'larger than the 5 MB limit',
        reasonCode: 'over-size',
      },
    ]);
    expect(doc.summary).toMatchObject({
      unresolved: 2,
      outcome: 'Incomplete',
      clean: false,
      exitCode: 1,
    });
  });

  it('standard input is a stream with documents, and its files and sources say <stdin>', () => {
    const stdinUnchecked = {
      path: '<stdin>' as const,
      reasonCode: 'parse-error' as const,
      line: 3,
    };
    const doc = jsonOf({
      checked: '<stdin>',
      results: [
        {
          workload: api,
          file: stdinSource(1, 4),
          findings: [finding('FAIL')],
        },
      ],
      unchecked: [stdinUnchecked],
    });
    expect(doc.checked.path).toBe('<stdin>');
    expect(doc.workloads[0]).toMatchObject({ file: '<stdin>', document: 1, line: 4 });
    expect(doc.unchecked[0]).toMatchObject({ type: 'stdin', file: '<stdin>' });
  });

  it('a configuration error has its reason words, its code and the form it expects', () => {
    const doc = jsonOf({
      configErrors: [
        { ...configError('workloads[0].longest_request_s'), expected: 'a number of seconds' },
        configError('colour', 9, 'unknown-key'),
      ],
      results: [wf(api, [finding('PASS')])],
    });
    expect(doc.configErrors).toEqual([
      {
        file: 'tripcurve.yaml',
        line: 3,
        key: 'workloads[0].longest_request_s',
        reason: 'has a value that is not valid',
        reasonCode: 'bad-value',
        expected: 'a number of seconds',
      },
      {
        file: 'tripcurve.yaml',
        line: 9,
        key: 'colour',
        reason: 'is not a key tripcurve knows',
        reasonCode: 'unknown-key',
      },
    ]);
    expect(doc.workloads).toEqual([]);
    expect(doc.summary).toMatchObject({
      outcome: 'ConfigError',
      clean: false,
      exitCode: 2,
      failed: 0,
      passed: 0,
    });
  });

  it('the no-files case sets noFiles; the nothing-checked case has no workloads and lists what was not checked', () => {
    const e1 = jsonOf({ noRecognisedFiles: true, filesRead: 0, checked: './docs' });
    expect(e1.noFiles).toEqual({ checked: './docs' });
    expect(e1.summary.outcome).toBe('NothingChecked');
    const e10 = jsonOf({
      results: [],
      notChecked: [
        {
          subjectKind: 'workload',
          subject: inputText('w'),
          kind: 'Deployment',
          file: inputText('k8s/x.yaml'),
          line: 4,
          reasonCode: 'no-recognised-lb',
        },
        {
          subjectKind: 'ingress',
          kind: 'Ingress',
          file: inputText('k8s/i.yaml'),
          reasonCode: 'not-alb-ingress',
        },
      ],
    });
    expect(e10.noFiles).toBeUndefined();
    expect(e10.workloads).toEqual([]);
    expect(e10.notChecked).toEqual([
      {
        subjectKind: 'workload',
        name: 'w',
        kind: 'Deployment',
        file: 'k8s/x.yaml',
        line: 4,
        reason: 'no load balancer found in the checked files',
        reasonCode: 'no-recognised-lb',
      },
      {
        subjectKind: 'ingress',
        kind: 'Ingress',
        file: 'k8s/i.yaml',
        reason: 'not recognised as an ALB Ingress',
        reasonCode: 'not-alb-ingress',
      },
    ]);
  });

  it('assumptions are their text, each once', () => {
    const doc = jsonOf({
      results: [wf(api, [finding('PASS')])],
      assumptions: [
        { text: 'a', reason: 'r' },
        { text: 'a', reason: 'r' },
      ],
    });
    expect(doc.assumptions).toEqual(['a', expect.stringContaining('zero-downtime')]);
  });
});

describe('input text is data: escaped, ASCII, never cut', () => {
  const nasty = 'w"b\\‮\ud800\u{1f600}\u001b[2J\n\u007f';
  const text = renderJson(
    buildReport({
      results: [
        wf(
          workload(nasty, 'ns '),
          [finding('FAIL', 'T1', workload(nasty, 'ns '), 'h', goodChain(`k8s/${nasty}.yaml`, 3))],
          `k8s/${nasty}.yaml`,
        ),
      ],
      unchecked: [unchecked(`k8s/${nasty}.yaml`)],
    }),
  );

  it('contains only printable ASCII and newlines, and parses', () => {
    expect(text).toMatch(/^[\n\x20-\x7e]*$/);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('round-trips the name with the lone surrogate replaced by U+FFFD', () => {
    const doc = parse(text);
    expect(doc.workloads[0].name).toBe('w"b\\‮�\u{1f600}\u001b[2J\n\u007f');
    expect(doc.workloads[0].namespace).toBe('ns ');
  });

  it('does not cut a long name', () => {
    const long = 'n'.repeat(5000);
    const doc = jsonOf({ results: [wf(workload(long), [finding('PASS')])] });
    expect(doc.workloads[0].name).toHaveLength(5000);
  });

  it('prints no input in its own voice: a hostile name never reaches a tripcurve text field', () => {
    const doc = parse(text);
    expect(doc.workloads[0].results[0].headline).toBe('h');
    expect(doc.summary.outcome).toBe('Incomplete');
  });
});
