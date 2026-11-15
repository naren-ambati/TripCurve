// B12 review 1: every reproduction is a test that failed before its fix.
import { chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText } from '../../src/core/index.js';
import { linkDeclaredLb } from '../../src/link/index.js';
import { intake, readIac, uncheckedReasonWords } from '../../src/parse/index.js';
import { explainRule } from '../../src/report/index.js';
import { analyseFiles, cleanupTrees, lineOf, renderChain, ruleOf } from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { txt } from '../support/render.js';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

registerTfCleanup();
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) {
    try {
      chmodSync(t.root, 0o755);
    } catch {
      // nothing to restore
    }
    t.cleanup();
  }
  cleanupTrees();
});
function tree(files: Record<string, string | Uint8Array>): Tree {
  const t = makeTree();
  trees.push(t);
  for (const [p, c] of Object.entries(files)) t.write(p, c);
  return t;
}
const reasons = (files: Record<string, string | Uint8Array>) =>
  intake({ root: tree(files).root }).unchecked.map((u) => [txt(u.path as never), u.reasonCode]);
/** Not checked after intake and the template reader: what the report lists. */
const listed = (files: Record<string, string | Uint8Array>) => {
  const i = intake({ root: tree(files).root });
  return [...i.unchecked, ...readIac(i).unchecked].map((u) => [txt(u.path as never), u.reasonCode]);
};

const HEAD = 'AWSTemplateFormatVersion: "2010-09-09"\n';

describe('a whole-template check never depends on Resources', () => {
  it.each([
    [
      'a Transform mapping and no Resources',
      `${HEAD}Transform:\n  Name: AWS::Include\n  Parameters:\n    Location: s3://b/all.yaml\n`,
    ],
    ['a Transform string and no Resources', `${HEAD}Transform: AWS::Include\n`],
    ['a Transform list and no Resources', `${HEAD}Transform: [AWS::LanguageExtensions]\n`],
    [
      'Fn::Transform in Outputs and no Resources',
      `${HEAD}Outputs:\n  O:\n    Value:\n      Fn::Transform:\n        Name: M\n`,
    ],
    ['a macro and Resources that is null', `${HEAD}Transform: AWS::Include\nResources:\n`],
    ['a macro and Resources that is a list', `${HEAD}Transform: AWS::Include\nResources:\n  - a\n`],
  ])('%s is listed as not checked (cfn-transform)', (_n, text) => {
    expect(listed({ 't.yaml': text })).toEqual([['t.yaml', 'cfn-transform']]);
    expect(readIac(intake({ root: tree({ 't.yaml': text }).root })).incompleteTemplates).toBe(true);
  });

  it.each([
    ['null', 'Resources:\n'],
    ['a list', 'Resources:\n  - a\n'],
    ['a scalar', 'Resources: nope\n'],
  ])('Resources that is %s is listed as not checked (cfn-unreadable)', (_n, resources) => {
    expect(listed({ 't.yaml': HEAD + resources })).toEqual([['t.yaml', 'cfn-unreadable']]);
  });

  it('a template with a version header and no Resources and no transform reads as zero resources, listed as nothing', () => {
    // CloudFormation requires Resources (docs/lookups-b12.txt), so such a file is not deployable; it holds nothing to check.
    const r = readIac(intake({ root: tree({ 't.yaml': HEAD }).root }));
    expect(r.resources).toEqual([]);
    expect(r.unchecked).toEqual([]);
  });

  it('the repro through the command: a macro and no Resources is not "All checks passed"', () => {
    const t = tree({ 't.yaml': `${HEAD}Transform:\n  Name: AWS::Include\n` });
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.stdout).not.toContain('All checks passed');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('t.yaml');
  });
});

describe('an unreadable .json is reported unless its content says it cannot be a template', () => {
  const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));
  const big = (s: string) => `{${s},"pad":"${'x'.repeat(5_100_000)}"}`;

  it('permission denied is reported, as for .yaml', () => {
    const t = tree({ 'a.json': '{}' });
    chmodSync(join(t.root, 'a.json'), 0o000);
    expect(
      intake({ root: t.root }).unchecked.map((u) => [txt(u.path as never), u.reasonCode]),
    ).toEqual([['a.json', 'unreadable']]);
  });

  it('a link to a .json outside the root is reported (outside-root)', () => {
    const outside = tree({ 'o.json': '{}' });
    const t = tree({});
    symlinkSync(join(outside.root, 'o.json'), join(t.root, 'l.json'));
    expect(
      intake({ root: t.root }).unchecked.map((u) => [txt(u.path as never), u.reasonCode]),
    ).toEqual([['l.json', 'outside-root']]);
  });

  it('a broken link named .json is reported (unreadable)', () => {
    const t = tree({});
    symlinkSync(join(t.root, 'nowhere.json'), join(t.root, 'l.json'));
    expect(intake({ root: t.root }).unchecked.map((u) => u.reasonCode)).toEqual(['unreadable']);
  });

  it.each([
    [
      'over 5 MB with AWSTemplateFormatVersion',
      big('"AWSTemplateFormatVersion":"2010-09-09"'),
      true,
    ],
    ['over 5 MB with AWS::Serverless', big('"Transform":"AWS::Serverless-2016-10-31"'), true],
    ['over 5 MB with "Type" and "AWS::', big('"Resources":{"Q":{"Type":"AWS::SQS::Queue"}}'), true],
    ['over 5 MB without a marker', big('"a":1'), false],
    ['over 5 MB with only "Type"', big('"Type":"x"'), false],
  ])('%s', (_n, text, reported) => {
    expect(reasons({ 'big.json': text })).toEqual(reported ? [['big.json', 'over-size']] : []);
  });

  it.each([
    [
      'latin-1 with the marker',
      latin1('{"AWSTemplateFormatVersion":"2010-09-09","Description":"caf\u00e9"}'),
      true,
    ],
    ['latin-1 without a marker', latin1('{"name":"caf\u00e9"}'), false],
  ])('%s', (_n, bytes, reported) => {
    expect(reasons({ 'l.json': bytes })).toEqual(reported ? [['l.json', 'unreadable']] : []);
  });

  it('a marker inside the sniff window is reported (the window itself is tested in iac-cfn-second.test.ts)', () => {
    expect(
      reasons({
        'b.json': latin1(`{"AWSTemplateFormatVersion":"1","pad":"${'x'.repeat(70_000)}\u00e9"}`),
      }),
    ).toEqual([['b.json', 'unreadable']]);
  });
});

describe('m3: --explain tells what the rules now read', () => {
  const t4 = explainRule('T4') as string;
  const t1 = explainRule('T1') as string;
  it('T4 no longer says the values are read from Terraform only, and lists the CloudFormation defaults', () => {
    expect(t4).toContain('or from a SAM or CloudFormation template');
    expect(t4).toContain('cfn-sqs-visibility-default');
    expect(t4).toContain('cfn-lambda-timeout-default');
    expect(t4).toContain('SAM');
  });
  it('T1 lists the CloudFormation idle default and says a CloudFormation load balancer is not yet linked', () => {
    expect(t1).toContain('cfn-lb-idle-timeout-default');
    expect(t1).toMatch(/CloudFormation load balancer[^.]*not (?:yet )?linked/);
  });
});

describe('m4: the two survivors', () => {
  const sam = (events: string, globals = ''): Record<string, string> => ({
    't.yaml': `${HEAD}Transform: AWS::Serverless-2016-10-31\n${globals}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      Handler: h\n      Events:\n${events}`,
  });
  it('an event with a Condition key is one UNRESOLVED mapping, never a read mapping', () => {
    const r = readTf(
      sam(
        '        E:\n          Condition: Make\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n          \n',
      ),
    );
    const m = r.resources.filter((x) => x.type === 'aws_lambda_event_source_mapping');
    expect(m).toHaveLength(1);
    expect(m[0]?.problem?.reason).toContain('SAM event');
  });
  it('Globals.Function without a Timeout leaves the function at the documented 3 s', () => {
    const files = sam(
      '        E:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n            MaximumBatchingWindowInSeconds: 5\n',
      'Globals:\n  Function:\n    Runtime: nodejs22.x\n',
    );
    expect(show(find(readTf(files), 'aws_lambda_function', 'F'), 'timeout')).toBe('absent');
    const f = ruleOf(analyseFiles(files, { base: {} }).result, 'T4');
    expect(lineOf(f)).toBe('PASS visibility 30 s covers 23 s');
    expect(renderChain(f)[1]).toContain('documented');
  });
});

describe('m5: no silent miss, and the right words', () => {
  const classes = (files: Record<string, string>) =>
    intake({ root: tree(files).root }).files.map((f) => `${txt(f.canonicalPath)}=${f.class}`);
  const body = `AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 60\n`;
  const indent = (s: string) => s.replace(/^(?=.)/gm, '  ');

  it('(a) a template whose top-level keys are indented is read', () => {
    expect(classes({ 't.yaml': indent(body) })).toEqual(['t.yaml=cfn-template']);
    const r = readIac(intake({ root: tree({ 't.yaml': indent(body) }).root }));
    expect(r.resources).toHaveLength(1);
  });
  it('(a) a typed Resources without a header, indented, is read too', () => {
    expect(classes({ 't.yaml': indent('Resources:\n  Q:\n    Type: AWS::SQS::Queue\n') })).toEqual([
      't.yaml=cfn-template',
    ]);
  });
  it('(a) a ConfigMap that carries a template, however indented, stays Kubernetes; a template that carries a manifest stays a template', () => {
    const cm = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  a.yaml: |\n${indent(indent(body))}`;
    expect(classes({ 'cm.yaml': cm })).toEqual(['cm.yaml=k8s-yaml']);
    const tpl = `${body}Metadata:\n  Text: |\n    apiVersion: v1\n    kind: ConfigMap\n`;
    expect(classes({ 't.yaml': tpl })).toEqual(['t.yaml=cfn-template']);
  });
  it('(a) a document that is both is still reported', () => {
    expect(reasons({ 'x.yaml': `${body}apiVersion: v1\nkind: ConfigMap\n` })).toEqual([
      ['x.yaml', 'template-ambiguous'],
    ]);
  });

  it('(c) an unreadable template does not make a Terraform load balancer "not read"; no Terraform word is shown for it', () => {
    const files = {
      't.yaml': `${HEAD}Resources:\n  Q: !Ref X\n`,
      'u.yaml': `${HEAD}Transform: AWS::Include\n`,
    };
    const iac = readTf(files);
    expect(iac.incomplete).toBe(false);
    expect(iac.incompleteTemplates).toBe(true);
    expect(
      linkDeclaredLb(iac, fileSource(inputText('tripcurve.yaml'), 1), inputText('aws_lb.x')),
    ).toEqual({
      state: 'unresolved',
      by: 'declared',
      reason: 'no-resource',
    });
  });

  it('(d) a JSON file with a key written twice is a JSON syntax error, not a YAML one', () => {
    const r = intake({
      root: tree({ 'a.json': `{"AWSTemplateFormatVersion":"1","a":1,"a":2}` }).root,
    });
    expect(r.unchecked.map((u) => u.reasonCode)).toEqual(['json-parse-error']);
    expect(uncheckedReasonWords('json-parse-error')).toBe(
      'JSON syntax error (or a key written twice)',
    );
  });

  it('(e) a Lambda Timeout above the 900 s cap stays UNRESOLVED (conservative)', () => {
    const t = `${HEAD}Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      Timeout: 901\n`;
    expect(show(find(readTf({ 't.yaml': t }), 'aws_lambda_function', 'F'), 'timeout')).toContain(
      'outside the documented range 1 to 900',
    );
  });
});
