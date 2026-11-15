// Rule T4: queue visibility >= 6 x function timeout + batching
// window, in seconds, over Terraform read from files. Every outcome, with the arithmetic.
import { afterEach, describe, expect, it } from 'vitest';
import { analyse } from '../../src/analyse.js';
import { passBlocker } from '../../src/core/index.js';
import { loadKnowledgeBase } from '../../src/kb/index.js';
import { intake } from '../../src/parse/index.js';
import { assembleReport, renderHuman } from '../../src/report/index.js';
import { analyseFiles, cleanupTrees, lineOf, renderChain, ruleOf } from '../support/analyse.js';
import { makeTree } from '../support/tmp-tree.js';

afterEach(cleanupTrees);

interface Parts {
  visibility?: string;
  timeout?: string;
  window?: string;
  queueLine?: string;
  functionLine?: string;
}

/** The three resources of the design mockup, with each attribute as written (`undefined` leaves it out). */
function orders(p: Parts = {}): string {
  const v = 'visibility' in p ? p.visibility : '60';
  const t = 'timeout' in p ? p.timeout : '30';
  const w = 'window' in p ? p.window : '5';
  return [
    'resource "aws_sqs_queue" "orders" {',
    ...(v === undefined ? [] : [`  visibility_timeout_seconds = ${v}`]),
    '}',
    'resource "aws_lambda_function" "orders" {',
    ...(t === undefined ? [] : [`  timeout = ${t}`]),
    '}',
    'resource "aws_lambda_event_source_mapping" "orders" {',
    p.queueLine ?? '  event_source_arn = aws_sqs_queue.orders.arn',
    p.functionLine ?? '  function_name    = aws_lambda_function.orders.arn',
    ...(w === undefined ? [] : [`  maximum_batching_window_in_seconds = ${w}`]),
    '}',
    '',
  ].join('\n');
}

function run(files: Record<string, string>) {
  return analyseFiles(files, { base: {} }).result;
}
const t4 = (files: Record<string, string>) => ruleOf(run(files), 'T4');

describe('the comparison is >= and in seconds', () => {
  it('FAIL: visibility 60 s is less than 6 x 30 s + 5 s = 185 s', () => {
    const f = t4({ 'infra/queue.tf': orders() });
    expect(lineOf(f)).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    expect(renderChain(f)).toEqual([
      'visibility: 60 s @ "infra/queue.tf":2',
      'timeout: 30 s @ "infra/queue.tf":5',
      'batching: 5 s @ "infra/queue.tf":10',
    ]);
  });

  it('PASS: visibility 190 s covers 185 s', () => {
    const f = t4({ 'infra/queue.tf': orders({ visibility: '190' }) });
    expect(lineOf(f)).toBe('PASS visibility 190 s covers 185 s');
  });

  it('equal passes, one second less fails', () => {
    expect(t4({ 'a.tf': orders({ visibility: '185' }) }).kind).toBe('PASS');
    const f = t4({ 'a.tf': orders({ visibility: '184' }) });
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('visibility 184 s is less than 6 x 30 s + 5 s = 185 s');
  });

  it('a window of 0 is a literal 0 and settles the result', () => {
    expect(lineOf(t4({ 'a.tf': orders({ visibility: '180', window: '0' }) }))).toBe(
      'PASS visibility 180 s covers 180 s',
    );
    expect(t4({ 'a.tf': orders({ visibility: '179', window: '0' }) }).kind).toBe('FAIL');
  });

  it('the largest documented values compare exactly', () => {
    expect(t4({ 'a.tf': orders({ visibility: '5700', timeout: '900', window: '300' }) }).kind).toBe(
      'PASS',
    );
    expect(t4({ 'a.tf': orders({ visibility: '5699', timeout: '900', window: '300' }) }).kind).toBe(
      'FAIL',
    );
  });
});

describe('defaults that follow from the file', () => {
  it('a queue with no visibility_timeout_seconds has the documented 30 s, and may PASS', () => {
    const f = t4({ 'a.tf': orders({ visibility: undefined, timeout: '4', window: '0' }) });
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('visibility 30 s covers 24 s');
    expect(renderChain(f)[0]).toBe(
      'visibility: 30 s @ default: Terraform aws_sqs_queue visibility_timeout_seconds (Terraform AWS provider docs; documented)',
    );
  });

  it('a queue with no visibility_timeout_seconds may FAIL with the default 30 s', () => {
    const f = t4({ 'a.tf': orders({ visibility: undefined, timeout: '10', window: '0' }) });
    expect(lineOf(f)).toBe('FAIL visibility 30 s is less than 6 x 10 s + 0 s = 60 s');
  });

  it('a function with no timeout has the documented 3 s', () => {
    const f = t4({ 'a.tf': orders({ visibility: '30', timeout: undefined, window: '12' }) });
    expect(lineOf(f)).toBe('PASS visibility 30 s covers 30 s');
    expect(renderChain(f)[1]).toContain('Terraform aws_lambda_function timeout');
  });
});

describe('a missing batching window is assumed 0 s and never decides', () => {
  it('says what it would mean, and is UNRESOLVED, not PASS', () => {
    const f = t4({ 'a.tf': orders({ visibility: '190', window: undefined }) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'batching window is not set in the files; assumed 0 s, so visibility 190 s covers 180 s (T4 would pass)',
    );
    expect(f.declare?.[0]).toMatch(/maximum_batching_window_in_seconds/);
    expect(renderChain(f)[2]).toBe(
      'batching assumed, not set in the files: 0 s @ default: Lambda event source mapping batching window (AWS docs, Lambda API; documented)',
    );
  });

  it('would FAIL: that no longer needs the window, so it is a FAIL (B17, see the next section)', () => {
    const f = t4({ 'a.tf': orders({ visibility: '60', window: undefined }) });
    expect(f.kind).toBe('FAIL');
  });

  it('lists the assumption exactly once for several mappings, and only when it was used', () => {
    // visibility 190 s covers 6 x 30 s, so the window is needed and the assumption is used
    const text =
      orders({ visibility: '190', window: undefined }) +
      orders({ visibility: '190', window: undefined }).replaceAll('"orders"', '"other"');
    const r = run({ 'a.tf': text });
    expect(
      r.assumptions.filter((a) => a.text.startsWith('The batching window is assumed to be 0 s')),
    ).toHaveLength(1);
    const none = run({ 'a.tf': orders() });
    expect(none.assumptions.filter((a) => a.text.includes('batching window'))).toEqual([]);
  });

  it('an assumed window beside an unresolved input does not say what T4 would be', () => {
    const f = t4({ 'a.tf': orders({ visibility: 'var.v', window: undefined }) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/^visibility timeout not established/);
  });
});

describe('a FAIL that does not depend on the batching window (B17, change 3)', () => {
  // The rule is visibility >= 6 x timeout + window with window >= 0 (documented range 0 to 300 s). A window can
  // only raise the need, so visibility below 6 x timeout fails for every window. Only PASS needs the window.
  const note = 'the batching window is not set, and any window only raises the need';

  it('FAIL when visibility is below 6 x timeout and the window is not set', () => {
    const f = t4({ 'a.tf': orders({ visibility: '60', window: undefined }) });
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe(`visibility 60 s is less than 6 x 30 s = 180 s; ${note}`);
    expect(f.demotedFrom).toBeUndefined();
    // the chain holds only what the verdict rests on: no assumed value
    expect(renderChain(f)).toEqual(['visibility: 60 s @ "a.tf":2', 'timeout: 30 s @ "a.tf":5']);
    expect(passBlocker(f.chain)).toBeUndefined();
  });

  it('the boundary: 179 s fails, 180 s is only UNRESOLVED (the window could be 0 and could be more)', () => {
    expect(t4({ 'a.tf': orders({ visibility: '179', window: undefined }) }).kind).toBe('FAIL');
    const f = t4({ 'a.tf': orders({ visibility: '180', window: undefined }) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/^batching window is not set in the files; assumed 0 s/);
  });

  it('visibility at or above 6 x timeout with the window not set stays UNRESOLVED, however large', () => {
    for (const v of ['180', '181', '43200']) {
      const f = t4({ 'a.tf': orders({ visibility: v, window: undefined }) });
      expect(f.kind, v).toBe('UNRESOLVED');
    }
  });

  it('the documented defaults count: the default visibility 30 s against a 30 s timeout fails (no window set)', () => {
    const f = t4({ 'a.tf': orders({ visibility: undefined, window: undefined }) });
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe(`visibility 30 s is less than 6 x 30 s = 180 s; ${note}`);
    expect(renderChain(f)[0]).toContain('default');
  });

  it('a window that is a variable is not known: the FAIL still holds, and says it is not known', () => {
    const f = t4({ 'a.tf': orders({ visibility: '60', window: 'var.w' }) });
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe(
      'visibility 60 s is less than 6 x 30 s = 180 s; the batching window is not known, and any window only raises the need',
    );
    expect(t4({ 'a.tf': orders({ visibility: '180', window: 'var.w' }) }).kind).toBe('UNRESOLVED');
  });

  it('does not list the assumed-window assumption: the FAIL does not rest on it', () => {
    const r = run({ 'a.tf': orders({ visibility: '60', window: undefined }) });
    expect(r.assumptions.filter((a) => a.text.includes('batching window'))).toEqual([]);
    // an UNRESOLVED result that shows the assumed window lists it, once
    const u = run({ 'a.tf': orders({ visibility: '190', window: undefined }) });
    expect(u.assumptions.filter((a) => a.text.includes('batching window'))).toHaveLength(1);
  });

  it('a window that is written keeps the full arithmetic, as before', () => {
    const f = t4({ 'a.tf': orders({ visibility: '60', window: '5' }) });
    expect(f.headline).toBe('visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
  });

  it('an unresolved visibility or timeout is never a FAIL, whatever the window', () => {
    for (const parts of [
      { visibility: 'var.v', window: undefined },
      { timeout: 'var.t', window: undefined },
      { visibility: '60', timeout: 'var.t', window: undefined },
    ] as Parts[]) {
      expect(t4({ 'a.tf': orders(parts) }).kind).toBe('UNRESOLVED');
    }
  });

  it('a default that is only a placeholder (to be measured) is never a FAIL, even without the window', () => {
    const kb = loadKnowledgeBase([
      {
        schemaVersion: 1,
        entries: [
          {
            id: 'terraform-sqs-visibility-tbm',
            subject: 'terraform-sqs-visibility',
            value: 30,
            unit: 's',
            applies: { runtime: 'terraform', versionRange: '*' },
            citationName: 'Terraform test',
            rangeLabel: 'test',
            docUrl: 'https://example.test/sqs',
            docDate: '2026-11-12',
            basis: 'to-be-measured',
            scriptRef: 'measure/x.mjs',
            toleranceMs: 4,
          },
          {
            id: 'terraform-lambda-timeout-tbm',
            subject: 'terraform-lambda-timeout',
            value: 3,
            unit: 's',
            applies: { runtime: 'terraform', versionRange: '*' },
            citationName: 'Terraform test',
            rangeLabel: 'test',
            docUrl: 'https://example.test/lambda',
            docDate: '2026-11-12',
            basis: 'documented',
            scriptRef: { notMeasurableLocally: 'a cloud service' },
          },
        ],
      },
    ]);
    const { result } = analyseFiles(
      { 'a.tf': orders({ visibility: undefined, window: undefined }) },
      { base: {}, kb },
    );
    const f = ruleOf(result, 'T4');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotedFrom).toBeUndefined();
  });

  it('a queue or function that is not linked is never a FAIL', () => {
    const f = t4({
      'a.tf': orders({
        visibility: '60',
        window: undefined,
        queueLine: '  event_source_arn = var.q',
      }),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('the run fails (exit code 1) and the FAIL is in the JSON', () => {
    const tree = makeTree();
    try {
      tree.write('a.tf', orders({ visibility: '60', window: undefined }));
      const read = intake({ root: tree.root });
      const report = assembleReport({ checked: '.', intake: read, analysis: analyse(read) });
      expect(report.summary.exitCode).toBe(1);
      expect(report.summary.counts.failed).toBe(1);
    } finally {
      tree.cleanup();
    }
  });
});

describe('the assumed window is marked in the chain and in the printed basis', () => {
  it('the batching step holds an ASSUMED value that prints its documented basis', () => {
    const f = t4({ 'a.tf': orders({ visibility: '190', window: undefined }) });
    const step = f.chain[2];
    const v = step?.value;
    expect(v && 'basis' in v ? v.basis : undefined).toBe('assumed');
    expect(v && 'confidence' in v ? v.confidence : undefined).toBe('assumed');
    expect(step?.detail).toBe('assumed, not set in the files');
    expect(f.demotedFrom).toBeUndefined();
    // the chain alone refuses a PASS: remove the rule's own guard and the factory still demotes it
    expect(passBlocker(f.chain)).toBe('assumed-value');
  });

  it('a window that is written is not marked assumed', () => {
    const f = t4({ 'a.tf': orders({ visibility: '190', window: '0' }) });
    expect(passBlocker(f.chain)).toBeUndefined();
  });
});

describe('any unresolved input gives UNRESOLVED', () => {
  it.each([
    [
      'a variable for the visibility',
      { visibility: 'var.v' },
      /^visibility timeout not established/,
    ],
    ['a local for the timeout', { timeout: 'local.t' }, /^function timeout not established/],
    // visibility 190 s is at or above 6 x 30 s: the window is then needed (below it T4 fails whatever the window)
    [
      'an expression for the window',
      { window: '5 / 5', visibility: '190' },
      /^batching window not established/,
    ],
    ['a value out of range', { timeout: '901' }, /outside the documented range 1 to 900/],
  ])('%s', (_n, parts: Parts, headline) => {
    const f = t4({ 'a.tf': orders(parts) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(headline);
  });

  it('a count on the queue makes the visibility unresolved even though it is a literal', () => {
    const text = orders().replace(
      'visibility_timeout_seconds = 60',
      'visibility_timeout_seconds = 600\n  count = 2',
    );
    expect(t4({ 'a.tf': text }).kind).toBe('UNRESOLVED');
  });

  it('a variable never gives a FAIL either', () => {
    expect(t4({ 'a.tf': orders({ visibility: 'var.v', timeout: '900' }) }).kind).toBe('UNRESOLVED');
  });
});

describe('the link between mapping, queue and function', () => {
  it.each([
    [
      'a literal ARN',
      { queueLine: '  event_source_arn = "arn:aws:sqs:us-east-1:000000000000:orders"' },
      /not a reference to an aws_sqs_queue/,
    ],
    [
      'a variable',
      { queueLine: '  event_source_arn = var.queue_arn' },
      /not a reference to an aws_sqs_queue/,
    ],
    [
      'a queue that is not written',
      { queueLine: '  event_source_arn = aws_sqs_queue.nowhere.arn' },
      /not in the same folder/,
    ],
    [
      'a stream',
      { queueLine: '  event_source_arn = aws_kinesis_stream.s.arn' },
      /not a reference to an aws_sqs_queue/,
    ],
    [
      'a function given by name',
      { functionLine: '  function_name = "orders"' },
      /not a reference to an aws_lambda_function/,
    ],
    [
      'a function that is not written',
      { functionLine: '  function_name = aws_lambda_function.nowhere.arn' },
      /not in the same folder/,
    ],
  ])('%s: T4 is UNRESOLVED and the values it could not link are not read', (_n, parts, reason) => {
    const f = t4({ 'a.tf': orders(parts) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(reason);
    expect(f.declare?.join(' ')).toContain('in the same folder');
  });

  it('a queue in another file of the same folder IS linked (B17: a folder is one module)', () => {
    const f = t4({
      'queue.tf': 'resource "aws_sqs_queue" "orders" {\n  visibility_timeout_seconds = 600\n}\n',
      'map.tf': `resource "aws_lambda_function"${orders().split('resource "aws_lambda_function"')[1]}`,
    });
    expect(f.kind).toBe('PASS');
  });

  it('a decoy in another folder with the same name does not change the linked values', () => {
    const decoy = 'resource "aws_sqs_queue" "orders" {\n  visibility_timeout_seconds = 43200\n}\n';
    const f = t4({ 'real/q.tf': orders(), 'decoy/q.tf': decoy });
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
  });

  it('two queues of one name in one scope (two folders do not share a scope) are different queues', () => {
    const r = run({ 'a/q.tf': orders(), 'b/q.tf': orders({ visibility: '9999' }) });
    expect(r.results.map((x) => x.findings[0]?.kind).sort()).toEqual(['FAIL', 'PASS']);
  });

  it('one mapping is one block, named after its resource, with the file of the mapping', () => {
    const r = run({ 'infra/queue.tf': orders() });
    expect(r.results).toHaveLength(1);
    const entry = r.results[0];
    expect(entry && 'mapping' in entry.workload).toBe(true);
    expect(entry?.file).toMatchObject({ type: 'file', line: 7 });
  });
});

describe('a heredoc close that HCL accepts does not swallow the attributes after it', () => {
  const policy = (close: string) =>
    [
      'resource "aws_lambda_function" "o" {',
      '  timeout = 3',
      '}',
      'resource "aws_lambda_event_source_mapping" "o" {',
      '  event_source_arn = aws_sqs_queue.o.arn',
      '  function_name = aws_lambda_function.o.arn',
      '  maximum_batching_window_in_seconds = 0',
      '}',
      'resource "aws_sqs_queue" "o" {',
      '  policy = <<EOF',
      '{}',
      close,
      '  visibility_timeout_seconds = 10',
      '}',
      'resource "aws_sns_topic" "t" {',
      '  policy = <<EOF',
      '{}',
      'EOF',
      '}',
      '',
    ].join('\n');

  it.each([
    ['an indented close', '  EOF'],
    ['a close with trailing spaces', 'EOF   '],
  ])('%s: visibility 10 s is read, T4 FAILs (it was a PASS on the default 30 s)', (_n, close) => {
    const f = t4({ 'a.tf': policy(close) });
    expect(lineOf(f)).toBe('FAIL visibility 10 s is less than 6 x 3 s + 0 s = 18 s');
  });
});

describe('the report', () => {
  function report(files: Record<string, string>) {
    const tree = makeTree();
    try {
      for (const [p, t] of Object.entries(files)) tree.write(p, t);
      const read = intake({ root: tree.root });
      return assembleReport({ checked: '.', intake: read, analysis: analyse(read) });
    } finally {
      tree.cleanup();
    }
  }

  it('prints the block header with the kind word, and a PASS run is clean', () => {
    const r = report({ 'infra/queue.tf': orders({ visibility: '190' }) });
    const text = renderHuman(r);
    expect(text).toContain('Workload "orders" (event source mapping) in "infra/queue.tf"');
    expect(text).toContain('  PASS T4  visibility 190 s covers 185 s ("infra/queue.tf":2)');
    expect(r.summary.exitCode).toBe(0);
  });

  it('an unreadable Terraform file is listed as not checked, so a passing run is not clean', () => {
    const r = report({
      'infra/queue.tf': orders({ visibility: '190' }),
      'infra/bad.tf': 'resource "aws_sqs_queue" "q" {\n  n = "abc\n}\n',
    });
    const text = renderHuman(r);
    expect(text).toContain('Files not checked');
    expect(text.replace(/\s+/g, ' ')).toContain(
      'skipped "infra/bad.tf": Terraform syntax that tripcurve does not read',
    );
    expect(r.summary.outcome).toBe('Incomplete');
    expect(r.summary.exitCode).toBe(1);
    expect(text).not.toContain('All checks passed');
  });

  it('a hostile mapping name and file name stay quoted, plain ASCII, within 80 columns and never at a line start', () => {
    const names = ['a b \u202e \u00e9', 'x'.repeat(200), '"; FAIL T4 forged', 'PASS T4 ok'];
    for (const name of names) {
      const text = orders({ visibility: '190' }).replaceAll(
        'resource "aws_lambda_event_source_mapping" "orders"',
        `resource "aws_lambda_event_source_mapping" "${name.replaceAll('"', "'")}"`,
      );
      const out = renderHuman(report({ [`infra/my queue ${name.slice(0, 5)}.tf`]: text }));
      for (const line of out.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(80);
        expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
        expect(line.trimStart().startsWith('"')).toBe(false);
      }
      expect(out).toContain('(event source mapping)');
    }
  });

  it('the by-name assumption keeps within 80 columns, and a path with spaces reads the same in the chain and in the assumption', () => {
    const name = 'a'.repeat(60);
    const file = `infra/${'my load balancer '.repeat(8)}lb.tf`;
    const tree = makeTree();
    try {
      tree.write(
        'k8s/ingress.yaml',
        [
          'apiVersion: networking.k8s.io/v1',
          'kind: Ingress',
          'metadata:',
          '  name: web',
          '  namespace: shop',
          '  annotations:',
          `    alb.ingress.kubernetes.io/load-balancer-name: ${name}`,
          'spec:',
          '  ingressClassName: alb',
          '  rules:',
          '    - http:',
          '        paths:',
          '          - path: /',
          '            pathType: Prefix',
          '            backend:',
          '              service:',
          '                name: web',
          '                port:',
          '                  number: 80',
          '',
        ].join('\n'),
      );
      tree.write(
        'k8s/web.yaml',
        'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\nspec:\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n        - name: web\n          image: node:22.23\n          ports:\n            - containerPort: 8080\n',
      );
      tree.write(
        'k8s/service.yaml',
        'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: shop\nspec:\n  selector:\n    app: web\n  ports:\n    - port: 80\n      targetPort: 8080\n',
      );
      tree.write(
        file,
        `resource "aws_lb" "${'b'.repeat(40)}" {\n  name = "${name}"\n  idle_timeout = 3\n}\n`,
      );
      const read = intake({ root: tree.root });
      const out = renderHuman(
        assembleReport({ checked: '.', intake: read, analysis: analyse(read) }),
      );
      expect(out).toContain('linked by name');
      for (const line of out.split('\n')) {
        expect(line.length, line).toBeLessThanOrEqual(80);
        expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
        expect(line.trimStart().startsWith('"')).toBe(false);
      }
      // a quoted run is never split across lines: every line of the assumption holds whole quotes
      const block = out.slice(
        out.indexOf('- Terraform load balancer linked by name'),
        out.indexOf('Summary'),
      );
      for (const line of block.split('\n')) {
        expect((line.match(/(?<!\\)"/g) ?? []).length % 2, line).toBe(0);
      }
      // a space is a space everywhere: no `\x20` stand-in in the assumption
      expect(out).not.toContain('\\x20');
      expect(out).toContain('my load balancer');
    } finally {
      tree.cleanup();
    }
  });

  it('Terraform with no mapping checks nothing and is never clean', () => {
    const r = report({ 'infra/lb.tf': 'resource "aws_lb" "m" {\n}\n' });
    expect(r.summary.outcome).toBe('NothingChecked');
    expect(r.summary.exitCode).toBe(2);
  });
});
