// Inline waivers attach by LINE ("the workload or resource whose block contains the
// comment line"). The blocks here are real files read by intake and the Terraform reader; the findings are
// built by hand and placed at the line a workload starts on, so each case is about which object a comment
// belongs to and nothing else.
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText } from '../../src/core/index.js';
import type { WorkloadFindings } from '../../src/evaluate/index.js';
import { intake, readConfig, readIac } from '../../src/parse/index.js';
import { type AppliedWaiver, applyWaivers, WAIVER_PROBLEMS } from '../../src/waive/index.js';
import { finding, queue, workload } from '../support/report-fixtures.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

const TODAY = '2026-11-12';
const WAIVE = (rule: string, reason = 'ok'): string =>
  `# tripcurve: ignore ${rule} reason="${reason}" until=2027-01-31`;

interface Place {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly rule?: 'T1' | 'T2' | 'T3' | 'T4';
  readonly queue?: boolean;
}

/** One FAIL result for each place: a workload (or an event source mapping) that starts on that line. */
function run(files: Record<string, string>, places: readonly Place[]) {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const read = intake({ root: t.root });
  const results: WorkloadFindings[] = places.map((p) => {
    const rule = p.rule ?? (p.queue ? 'T4' : 'T2');
    const subject = p.queue ? queue(p.name) : workload(p.name);
    return {
      workload: subject,
      file: fileSource(inputText(p.file), p.line),
      findings: [finding('FAIL', rule, subject)],
    };
  });
  const out = applyWaivers({
    results,
    records: readConfig(read).waiverRecords,
    knownWorkloads: results.flatMap((r) => ('mapping' in r.workload ? [] : [r.workload])),
    intake: read,
    terraform: readIac(read).resources,
    today: TODAY,
  });
  return {
    states: out.waivers.map((w) => w.state),
    problems: out.waivers.map((w) => w.problem),
    kinds: out.results.map((r) => r.findings.map((f) => f.kind).join()),
    waivers: out.waivers,
  };
}

const DEPLOY = (name: string, extra = ''): string =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n${extra}spec: {}\n`;

describe('a YAML object owns every line of its document', () => {
  it('a comment anywhere in the document applies to the workload in it', () => {
    for (const where of ['top', 'middle', 'end'] as const) {
      const text =
        where === 'top'
          ? `${WAIVE('T2')}\n${DEPLOY('api')}`
          : where === 'middle'
            ? DEPLOY('api', `  ${WAIVE('T2')}\n`)
            : `${DEPLOY('api')}${WAIVE('T2')}\n`;
      const r = run({ 'k8s/api.yaml': text }, [{ name: 'api', file: 'k8s/api.yaml', line: 2 }]);
      expect(r.states, where).toEqual(['applied']);
      expect(r.kinds, where).toEqual(['WAIVED']);
    }
  });

  it('a comment after a value on the same line applies', () => {
    const text = `apiVersion: apps/v1\nkind: Deployment # tripcurve: ignore T2 reason="a" until=2027-01-31\nmetadata:\n  name: api\n`;
    expect(
      run({ 'k8s/api.yaml': text }, [{ name: 'api', file: 'k8s/api.yaml', line: 2 }]).states,
    ).toEqual(['applied']);
  });

  it('a comment inside the document above or below a --- belongs to that document', () => {
    // directly after the `---` (line 6) is inside the second document; the one at the top of the file is inside the first
    const text = `${WAIVE('T2', 'for a')}\n${DEPLOY('a')}---\n${WAIVE('T2', 'for b')}\n${DEPLOY('b')}`;
    const places = [
      { name: 'a', file: 'k8s/x.yaml', line: 3 },
      { name: 'b', file: 'k8s/x.yaml', line: 10 },
    ];
    const r = run({ 'k8s/x.yaml': text }, places);
    expect(r.states).toEqual(['applied', 'applied']);
    expect(r.kinds).toEqual(['WAIVED', 'WAIVED']);
  });

  it('a comment directly before a --- sits between two documents: invalid, and suppresses nothing', () => {
    // the reviewer's case (a/k8s/two.yaml): the comment ends the first document, written for the second
    const text = `${DEPLOY('one')}${WAIVE('T2', 'meant for two')}\n---\n${DEPLOY('two')}`;
    const places = [
      { name: 'one', file: 'k8s/x.yaml', line: 2 },
      { name: 'two', file: 'k8s/x.yaml', line: 9 },
    ];
    const r = run({ 'k8s/x.yaml': text }, places);
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['between-blocks']]);
    expect(r.kinds).toEqual(['FAIL', 'FAIL']);
  });

  it('blank lines and other comments between the comment and the --- change nothing', () => {
    const text = `${DEPLOY('one')}${WAIVE('T2')}\n\n# note\n\n---\n${DEPLOY('two')}`;
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'one', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['between-blocks']]);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('a comment above real content, even just before the --- is not between when content follows it', () => {
    const text = `${DEPLOY('one', `  ${WAIVE('T2')}\n`)}---\n${DEPLOY('two')}`;
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'one', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.states).toEqual(['applied']);
  });

  it.each([
    ['a ... marker then ---', '...\n---\n'],
    ['a ... marker, a %YAML directive, then ---', '...\n%YAML 1.2\n---\n'],
    ['a ... marker alone', '...\n'],
  ])('N1: a comment directly before %s sits between two documents', (_name, ending) => {
    const text = `${DEPLOY('one')}${WAIVE('T2', 'meant for two')}\n${ending}${DEPLOY('two')}`;
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'one', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['between-blocks']]);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('N1: a comment inside the document, above a ... marker that follows content, is still between', () => {
    const text = `${DEPLOY('one', `  ${WAIVE('T2')}\n`)}...\n---\n${DEPLOY('two')}`;
    // the comment has content (`spec: {}`) after it, so it is inside `one`
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'one', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.states).toEqual(['applied']);
  });

  it('a comment at the very end of the last document has no block after it and stays in its block', () => {
    const r = run({ 'k8s/x.yaml': `${DEPLOY('one')}${WAIVE('T2')}\n` }, [
      { name: 'one', file: 'k8s/x.yaml', line: 2 },
    ]);
    expect(r.states).toEqual(['applied']);
  });

  it('a comment before the - of the next List item, at that indent, sits between two items', () => {
    const list = (comment: string): string =>
      [
        'apiVersion: v1',
        'kind: List',
        'items:',
        '  - kind: Deployment',
        '    metadata:',
        '      name: one',
        comment,
        '  - kind: Deployment',
        '    metadata:',
        '      name: two',
        '',
      ].join('\n');
    const places = [
      { name: 'one', file: 'k8s/list.yaml', line: 4 },
      { name: 'two', file: 'k8s/list.yaml', line: 8 },
    ];
    const at = (indent: number) =>
      run({ 'k8s/list.yaml': list(`${' '.repeat(indent)}${WAIVE('T2')}`) }, places);
    // at the item's indent (2), or less: between
    for (const indent of [0, 2]) {
      const r = at(indent);
      expect(r.problems, `indent ${indent}`).toEqual([WAIVER_PROBLEMS['between-blocks']]);
      expect(r.kinds).toEqual(['FAIL', 'FAIL']);
    }
    // deeper than the next item's dash: still inside the first item's content
    const deeper = at(6);
    expect(deeper.states).toEqual(['applied']);
    expect(deeper.kinds).toEqual(['WAIVED', 'FAIL']);
  });

  it('a comment in a neighbouring document of another kind (a Service) names no workload', () => {
    const text = `${DEPLOY('api')}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\n  ${WAIVE('T2')}\n`;
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'api', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['outside-block']]);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('a comment in a document that did not parse does not belong to the workload above it', () => {
    const text = `${DEPLOY('api')}---\nkey: [unclosed\n${WAIVE('T2')}\n---\nkind: Other\n`;
    const r = run({ 'k8s/x.yaml': text }, [{ name: 'api', file: 'k8s/x.yaml', line: 2 }]);
    expect(r.kinds).toEqual(['FAIL']);
    expect(r.states).toEqual(['invalid']);
  });

  it('a comment in a document that two workloads came from names neither (several-findings guard)', () => {
    const text = DEPLOY('api', `  ${WAIVE('T2')}\n`);
    const r = run({ 'k8s/x.yaml': text }, [
      { name: 'a', file: 'k8s/x.yaml', line: 2 },
      { name: 'b', file: 'k8s/x.yaml', line: 2 },
    ]);
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['several-findings']]);
    expect(r.kinds).toEqual(['FAIL', 'FAIL']);
  });

  it('a comment in tripcurve.yaml names no workload', () => {
    const r = run(
      { 'tripcurve.yaml': `version: 1\n${WAIVE('T2')}\n`, 'k8s/api.yaml': DEPLOY('api') },
      [{ name: 'api', file: 'k8s/api.yaml', line: 2 }],
    );
    expect(r.states).toEqual(['invalid']);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('a comment in a Kubernetes file with no workload is listed, never dropped', () => {
    const r = run(
      { 'k8s/svc.yaml': `apiVersion: v1\nkind: Service\n${WAIVE('T1')}\nmetadata:\n  name: x\n` },
      [],
    );
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['outside-block']]);
  });

  it('a comment for a rule the workload passes (or has no result for) is unmatched', () => {
    const text = DEPLOY('api', `  ${WAIVE('T3')}\n`);
    const r = run({ 'k8s/api.yaml': text }, [
      { name: 'api', file: 'k8s/api.yaml', line: 2, rule: 'T2' },
    ]);
    expect(r.states).toEqual(['unmatched']);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('two comments for one finding cover neither', () => {
    const text = DEPLOY('api', `  ${WAIVE('T2', 'one')}\n  ${WAIVE('T2', 'two')}\n`);
    const r = run({ 'k8s/api.yaml': text }, [{ name: 'api', file: 'k8s/api.yaml', line: 2 }]);
    expect(r.states).toEqual(['invalid', 'invalid']);
    expect(r.problems[0]).toBe(WAIVER_PROBLEMS['shared-finding']);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('an inline waiver carries its comment line as its source and the block workload as its name', () => {
    const r = run({ 'k8s/api.yaml': DEPLOY('api', `  ${WAIVE('T2')}\n`) }, [
      { name: 'api', file: 'k8s/api.yaml', line: 2 },
    ]);
    const w = r.waivers[0] as AppliedWaiver;
    expect(w.mechanism).toBe('inline');
    expect(w.source.type === 'file' && w.source.line).toBe(5);
  });
});

describe('a YAML List is one object per item', () => {
  const LIST = (middle: string): string =>
    [
      'apiVersion: v1',
      'kind: List',
      'items:',
      '  - kind: Deployment',
      '    metadata:',
      '      name: one',
      ...middle.split('\n').filter(Boolean),
      '  - kind: Deployment',
      '    metadata:',
      '      name: two',
      '',
    ].join('\n');
  const places: Place[] = [
    { name: 'one', file: 'k8s/list.yaml', line: 4 },
    { name: 'two', file: 'k8s/list.yaml', line: 8 },
  ];

  it('a comment in an item applies to that item only', () => {
    const first = run({ 'k8s/list.yaml': LIST(`      ${WAIVE('T2')}`) }, places);
    expect(first.kinds).toEqual(['WAIVED', 'FAIL']);
    const second = run({ 'k8s/list.yaml': `${LIST('')}      ${WAIVE('T2')}\n` }, [
      places[0] as Place,
      { name: 'two', file: 'k8s/list.yaml', line: 7 },
    ]);
    expect(second.kinds).toEqual(['FAIL', 'WAIVED']);
  });

  it('a comment above the first item (the list header) names no object', () => {
    const text = `apiVersion: v1\n${WAIVE('T2')}\nkind: List\nitems:\n  - kind: Deployment\n    metadata:\n      name: one\n`;
    const r = run({ 'k8s/list.yaml': text }, [{ name: 'one', file: 'k8s/list.yaml', line: 5 }]);
    expect(r.states).toEqual(['invalid']);
    expect(r.kinds).toEqual(['FAIL']);
  });
});

const TF = (attrs: string): string =>
  `resource "aws_sqs_queue" "orders" {\n  visibility_timeout_seconds = 30\n}\n\nresource "aws_lambda_event_source_mapping" "orders" {\n${attrs}  batch_size = 10\n}\n`;

describe('a Terraform resource owns the lines from its header to its closing brace', () => {
  const mapping: Place = { name: 'orders', file: 'infra/q.tf', line: 5, queue: true };

  it.each([
    ['#', '  # tripcurve: ignore T4 reason="a" until=2027-01-31\n'],
    ['//', '  // tripcurve: ignore T4 reason="a" until=2027-01-31\n'],
  ])('a %s comment inside the mapping block applies to its T4 result', (_mark, line) => {
    const r = run({ 'infra/q.tf': TF(line) }, [mapping]);
    expect(r.states).toEqual(['applied']);
    expect(r.kinds).toEqual(['WAIVED']);
  });

  it('a comment after the closing brace on the same line applies; one on the line below does not', () => {
    const same = `${TF('').trimEnd()} # tripcurve: ignore T4 reason="a" until=2027-01-31\n`;
    expect(run({ 'infra/q.tf': same }, [mapping]).states).toEqual(['applied']);
    const below = `${TF('')}# tripcurve: ignore T4 reason="a" until=2027-01-31\n`;
    expect(run({ 'infra/q.tf': below }, [mapping]).states).toEqual(['invalid']);
  });

  it('a comment inside another resource (the queue) is not inside the mapping', () => {
    const text = TF('').replace(
      '  visibility_timeout_seconds = 30\n',
      '  visibility_timeout_seconds = 30 # tripcurve: ignore T4 reason="a" until=2027-01-31\n',
    );
    const r = run({ 'infra/q.tf': text }, [mapping]);
    expect(r.states).toEqual(['invalid']);
    expect(r.problems).toEqual([WAIVER_PROBLEMS['outside-block']]);
    expect(r.kinds).toEqual(['FAIL']);
  });

  it('a comment between resources names no resource', () => {
    const text = `# tripcurve: ignore T4 reason="a" until=2027-01-31\n${TF('')}`;
    expect(run({ 'infra/q.tf': text }, [mapping]).states).toEqual(['invalid']);
  });
});
