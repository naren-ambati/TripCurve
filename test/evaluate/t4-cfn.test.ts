// Rule T4 over SAM and CloudFormation: the same result as the Terraform `orders` case, and
// UNRESOLVED (never PASS or FAIL) for every value that is not established. Defaults follow only from a template
// that was read in full.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText, makeSourcedValue } from '../../src/core/index.js';
import { defaultKnowledgeBase } from '../../src/kb/index.js';
import { linkDeclaredLb, linkLbByName } from '../../src/link/index.js';
import { terraformIdle } from '../../src/resolve/index.js';
import {
  analyseFiles,
  cleanupTrees,
  lineOf,
  renderChain,
  renderValue,
  ruleOf,
} from '../support/analyse.js';
import { find, readTf, registerTfCleanup } from '../support/terraform.js';

afterEach(cleanupTrees);
registerTfCleanup();

const fixture = (rel: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'iac', rel), 'utf8');
const run = (files: Record<string, string>) => analyseFiles(files, { base: {} }).result;
const t4 = (files: Record<string, string>) => ruleOf(run(files), 'T4');

const HEAD = 'AWSTemplateFormatVersion: "2010-09-09"\n';
const FN = `    Properties:
      Handler: index.handler
      Runtime: nodejs22.x
      Role: arn:aws:iam::000000000000:role/x
      Code:
        ZipFile: "x"
`;

interface Parts {
  visibility?: string;
  timeout?: string;
  window?: string;
}
/** The plain CloudFormation mapping of `orders` with each value as written (`undefined` leaves the property out). */
function orders(p: Parts = {}): string {
  const v = 'visibility' in p ? p.visibility : '60';
  const t = 'timeout' in p ? p.timeout : '30';
  const w = 'window' in p ? p.window : '5';
  return `${HEAD}Resources:
  Q:
    Type: AWS::SQS::Queue
${v === undefined ? '' : `    Properties:\n      VisibilityTimeout: ${v}\n`}  F:
    Type: AWS::Lambda::Function
${FN}${t === undefined ? '' : `      Timeout: ${t}\n`}  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt Q.Arn
      FunctionName: !Ref F
${w === undefined ? '' : `      MaximumBatchingWindowInSeconds: ${w}\n`}`;
}

describe('the SAM demo gives the same T4 result as the Terraform orders case', () => {
  const f = t4({ 'template.yaml': fixture('sam/orders/template.yaml') });
  it('FAIL: visibility 60 s is less than 6 x 30 s + 5 s = 185 s, with the three lines', () => {
    expect(lineOf(f)).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    expect(renderChain(f)).toEqual([
      'visibility: 60 s @ "template.yaml":7',
      'timeout: 30 s @ "template.yaml":14',
      'batching: 5 s @ "template.yaml":21',
    ]);
  });

  it('plain CloudFormation, in YAML and in JSON, gives the same verdict', () => {
    const both: Record<string, string>[] = [
      { 'template.yaml': fixture('cfn/orders/template.yaml') },
      { 'template.json': fixture('cfn/orders-json/template.json') },
    ];
    for (const files of both) {
      expect(lineOf(t4(files))).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    }
  });

  it('PASS when the visibility covers the need (equal passes), FAIL one below', () => {
    expect(lineOf(t4({ 't.yaml': orders({ visibility: '185' }) }))).toBe(
      'PASS visibility 185 s covers 185 s',
    );
    expect(lineOf(t4({ 't.yaml': orders({ visibility: '184' }) }))).toBe(
      'FAIL visibility 184 s is less than 6 x 30 s + 5 s = 185 s',
    );
  });
});

describe('a default follows from a template that was read in full', () => {
  it('no VisibilityTimeout is the documented 30 s; no Timeout is the documented 3 s (FAIL / PASS on them)', () => {
    const f = t4({ 't.yaml': orders({ visibility: undefined }) });
    expect(lineOf(f)).toBe('FAIL visibility 30 s is less than 6 x 30 s + 5 s = 185 s');
    expect(renderChain(f)[0]).toContain(
      'default: CloudFormation AWS::SQS::Queue VisibilityTimeout',
    );
    const g = t4({ 't.yaml': orders({ timeout: undefined, visibility: '30' }) });
    expect(lineOf(g)).toBe('PASS visibility 30 s covers 23 s');
  });

  it('the default is cited with its basis (documented) and the CloudFormation page', () => {
    const f = t4({ 't.yaml': orders({ visibility: undefined }) });
    const text = renderChain(f)[0] as string;
    expect(text).toMatch(/documented|CloudFormation/);
  });

  it('a SAM function without Timeout takes Globals.Function.Timeout, with the Globals line', () => {
    const f = t4({ 't.yaml': fixture('sam/globals-timeout/template.yaml') });
    expect(lineOf(f)).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    expect(renderChain(f)[1]).toBe('timeout: 30 s @ "t.yaml":5');
  });
});

describe('UNRESOLVED, never PASS or FAIL, when a value is not established', () => {
  const unresolved = (files: Record<string, string>): string => {
    const f = t4(files);
    expect(f.kind).toBe('UNRESOLVED');
    return lineOf(f);
  };

  it('a missing batching window is the assumed 0 s (matches Terraform), and says what T4 would be', () => {
    expect(unresolved({ 't.yaml': orders({ window: undefined, visibility: '190' }) })).toBe(
      'UNRESOLVED batching window is not set in the files; assumed 0 s, so visibility 190 s covers 180 s (T4 would pass)',
    );
  });

  it('a window assumption names the template property, not Terraform, in the Assumptions', () => {
    // visibility 190 s covers 6 x 30 s, so the window is needed and the assumption is used (B17: a FAIL does not use it)
    const r = run({ 't.yaml': orders({ visibility: '190', window: undefined }) });
    const text = r.assumptions.map((a) => a.text).join('\n');
    expect(text).toContain('MaximumBatchingWindowInSeconds');
    expect(text).not.toContain('Terraform');
  });

  it('a Parameter Ref, even with a Default', () => {
    expect(unresolved({ 't.yaml': fixture('cfn/parameter-ref/template.yaml') })).toContain(
      'visibility timeout not established: VisibilityTimeout refers to a template parameter',
    );
  });

  it('!If, !Sub and an unknown tag', () => {
    for (const v of [
      '!If [c, 60, 120]',
      '!Sub "60"',
      '!Bogus 60',
      '!FindInMap [a, b, c]',
      '!ImportValue v',
    ]) {
      expect(unresolved({ 't.yaml': orders({ visibility: v }) })).toContain(
        'VisibilityTimeout uses an intrinsic function',
      );
    }
  });

  it('another transform or macro: every value of the template', () => {
    expect(unresolved({ 't.yaml': fixture('cfn/other-transform/template.yaml') })).toContain(
      'the template uses a transform or macro',
    );
  });

  it('a nested stack output as the source', () => {
    expect(unresolved({ 't.yaml': fixture('cfn/nested-stack/template.yaml') })).toContain(
      'nested stack',
    );
  });

  it('a Kinesis stream (as in Terraform)', () => {
    expect(unresolved({ 't.yaml': fixture('cfn/kinesis/template.yaml') })).toContain('is a stream');
  });

  it('a Condition on the queue', () => {
    const t = orders().replace(
      '  Q:\n    Type: AWS::SQS::Queue\n',
      '  Q:\n    Type: AWS::SQS::Queue\n    Condition: C\n',
    );
    expect(unresolved({ 't.yaml': t })).toContain('has a Condition');
  });

  it('an unlinked function (a name, not a Ref)', () => {
    const t = orders().replace('FunctionName: !Ref F', 'FunctionName: my-function');
    expect(unresolved({ 't.yaml': t })).toContain(
      'function timeout not established: FunctionName is not a reference tripcurve follows',
    );
  });

  it('SAM Globals in a form that is not read: the default Timeout is not assumed', () => {
    const t = fixture('sam/orders/template.yaml')
      .replace('      Timeout: 30\n', '')
      .replace('Resources:', 'Globals:\n  Function: !If [c, {}, {}]\nResources:');
    expect(unresolved({ 't.yaml': t })).toContain('Globals');
  });

  it('a SAM function with no Timeout and no Globals takes the documented 3 s, which is a verdict', () => {
    const t = fixture('sam/orders/template.yaml')
      .replace('      Timeout: 30\n', '')
      .replace('VisibilityTimeout: 60', 'VisibilityTimeout: 10');
    const f = t4({ 't.yaml': t });
    expect(lineOf(f)).toBe('FAIL visibility 10 s is less than 6 x 3 s + 5 s = 23 s');
  });

  it('a SAM event with a non-literal Type, never silently dropped', () => {
    const t = fixture('sam/orders/template.yaml').replace('Type: SQS', 'Type: !Ref EventType');
    const r = run({ 't.yaml': t });
    expect(r.model.queueWorkloads).toHaveLength(1);
    expect(ruleOf(r, 'T4').kind).toBe('UNRESOLVED');
  });
});

describe('the load balancer idle value of a template, when something links it', () => {
  const kb = defaultKnowledgeBase();
  const idleOf = (files: Record<string, string>) => {
    const r = find(readTf(files), 'aws_lb', 'Alb');
    return terraformIdle(r, kb).value;
  };

  it('a literal is read with its line', () => {
    expect(renderValue(idleOf({ 'a.yaml': fixture('cfn/alb/with-idle.yaml') }) as never)).toBe(
      '120 s @ "a.yaml":11',
    );
  });

  it('absent on an application load balancer is the documented 60 s from the CloudFormation entry', () => {
    const v = idleOf({ 'b.yaml': fixture('cfn/alb/without-idle.yaml') });
    expect(renderValue(v as never)).toContain('60 s @');
    expect(renderValue(v as never)).toMatch(/CloudFormation/);
  });

  it('absent on a network load balancer, or one whose Type is not a literal, is unresolved', () => {
    for (const type of ['network', 'gateway', '!Ref T']) {
      const t = fixture('cfn/alb/without-idle.yaml').replace(
        '    Properties:\n',
        `    Properties:\n      Type: ${type}\n`,
      );
      expect(renderValue(idleOf({ 'c.yaml': t }) as never).startsWith('? ')).toBe(true);
    }
  });

  it('a CloudFormation load balancer is never linked to an Ingress by a Terraform address or by name', () => {
    const iac = readTf({ 'a.yaml': fixture('cfn/alb/with-idle.yaml') });
    const evidence = fileSource(inputText('tripcurve.yaml'), 3);
    expect(linkDeclaredLb(iac, evidence, inputText('aws_lb.Alb'))).toEqual({
      state: 'unresolved',
      by: 'declared',
      reason: 'no-resource',
    });
    const annotation = makeSourcedValue({
      value: inputText('Alb'),
      unit: 'none',
      source: fileSource(inputText('k8s/ingress.yaml'), 5),
      basis: 'declared',
    });
    expect(linkLbByName(iac, annotation)).toBeUndefined();
  });
});
