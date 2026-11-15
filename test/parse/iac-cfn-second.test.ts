// B12 review, second pass (R1 to R4 and two survivors): every reproduction is a test that failed before its fix.
import { afterEach, describe, expect, it } from 'vitest';
import { intake, isCfnTemplateValue, readIac } from '../../src/parse/index.js';
import { runBuilt } from '../support/e2e.js';
import { txt } from '../support/render.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});
function tree(files: Record<string, string | Uint8Array>): Tree {
  const t = makeTree();
  trees.push(t);
  for (const [p, c] of Object.entries(files)) t.write(p, c);
  return t;
}
const run = (files: Record<string, string | Uint8Array>) => {
  const i = intake({ root: tree(files).root });
  return {
    files: i.files.map((f) => `${txt(f.canonicalPath)}=${f.class}`),
    unchecked: [...i.unchecked, ...readIac(i).unchecked].map((u) => [
      txt(u.path as never),
      u.reasonCode,
    ]),
  };
};
const HEAD = 'AWSTemplateFormatVersion: "2010-09-09"\n';
const TPL = `${HEAD}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 60\n`;

describe('R1: ordinary YAML is never reported as an unreadable template', () => {
  const serverless = `service: x
defaults: &d
  timeout: 5
resources:
  Resources:
    Q:
      Type: AWS::SQS::Queue
      <<: *d
`;
  const compose = `x-base: &b
  image: a
services:
  a:
    <<: *b
    environment:
      Transform: x
      Resources: y
`;
  const workflow = `name: ci
env: &e
  A: 1
jobs:
  build:
    env: *e
    steps:
      - uses: x
        with:
          Resources: x
          Transform: y
`;
  const openapi = `openapi: 3.0.0
info: {title: t, version: "1"}
x-defs: &d {type: string}
paths:
  /a:
    get:
      x-amazon-apigateway-integration:
        Transform: AWS::Serverless-2016-10-31
        Resources: [a]
        schema: *d
`;
  it.each([
    ['serverless.yml with resources: Resources: and a merge key', 'serverless.yml', serverless],
    ['a docker-compose file with an anchor and a merge key', 'docker-compose.yml', compose],
    ['a GitHub workflow with an alias and a nested Resources key', 'ci.yml', workflow],
    ['an OpenAPI file with an alias and nested template keys', 'openapi.yaml', openapi],
    [
      'a file whose top-level keys are indented, with an alias, that is not a template',
      'x.yaml',
      '  Resources: x\n  a: &a 1\n  b: *a\n',
    ],
  ])('%s is silent, as on main', (_n, name, text) => {
    expect(run({ [name]: text })).toEqual({ files: [], unchecked: [] });
  });

  it('a values file with a top-level Resources key and no AWS:: type is not parsed for a template, so an alias in it is silent', () => {
    expect(run({ 'values.yaml': 'Resources:\n  a: &a 1\n  b: *a\n' })).toEqual({
      files: [],
      unchecked: [],
    });
    // a template with only Resources and a typed resource is still found
    expect(run({ 't.yaml': 'Resources:\n  Q:\n    Type: AWS::SQS::Queue\n' }).files).toEqual([
      't.yaml=cfn-template',
    ]);
  });

  it('a cdk.json with template words in it is silent', () => {
    const cdk = '{"app":"npx ts-node bin/x.ts","context":{"Resources":"AWS::x","Type":"AWS::y"}}';
    expect(run({ 'cdk.json': cdk })).toEqual({ files: [], unchecked: [] });
  });

  it('a real template that uses an alias is still reported, and an indented real template is read', () => {
    expect(run({ 't.yaml': `${TPL}X: &a 1\nY: *a\n` }).unchecked).toEqual([
      ['t.yaml', 'cfn-unreadable'],
    ]);
    expect(run({ 't.yaml': TPL.replace(/^(?=.)/gm, '  ') }).files).toEqual(['t.yaml=cfn-template']);
  });

  it('a candidate that does not parse is reported with the YAML parse-error rule', () => {
    expect(run({ 't.yaml': `${TPL}  bad: [\n` }).unchecked).toEqual([['t.yaml', 'parse-error']]);
  });

  it('the probe costs a candidate no more than main did: a tree of values files with a nested Resources key is as cheap as one without', () => {
    const body = (key: string) =>
      `image:\n  tag: x\nresources:\n  limits:\n    cpu: 1\n  ${key}:\n    memory: 2\n${'  extra: 1\n'.repeat(200)}`;
    const make = (key: string) => {
      const f: Record<string, string> = {};
      for (let i = 0; i < 300; i += 1) f[`v${i}/values.yaml`] = body(key);
      return tree(f).root;
    };
    const cpu = (root: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let k = 0; k < 5; k += 1) {
        const t0 = process.cpuUsage();
        intake({ root });
        const t = process.cpuUsage(t0);
        best = Math.min(best, (t.user + t.system) / 1000);
      }
      return best;
    };
    const withKey = cpu(make('Resources'));
    const without = cpu(make('Resourcez'));
    expect(withKey / Math.max(without, 1)).toBeLessThan(2);
  });
});

describe('R3: the sniff of an unreadable .json', () => {
  const pad = (n: number) => `"pad":"${'x'.repeat(n)}"`;
  const utf16 = (s: string) =>
    Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]));

  it('a UTF-16 file (BOM, NUL bytes) is reported, never ignored', () => {
    expect(
      run({
        't.json': utf16('{"AWSTemplateFormatVersion":"2010-09-09","Resources":{}}'),
      }).unchecked,
    ).toEqual([['t.json', 'unreadable']]);
  });

  it('a UTF-16 byte-order mark alone (no NUL byte, no marker) is reported, either byte order', () => {
    expect(run({ 'le.json': Uint8Array.from([0xff, 0xfe, 0x61, 0x62]) }).unchecked).toEqual([
      ['le.json', 'unreadable'],
    ]);
    expect(run({ 'be.json': Uint8Array.from([0xfe, 0xff, 0x61, 0x62]) }).unchecked).toEqual([
      ['be.json', 'unreadable'],
    ]);
  });

  it('NUL bytes in the head are reported even with no marker (the text cannot be searched)', () => {
    expect(run({ 'n.json': Uint8Array.from([0x7b, 0x00, 0x41, 0x7d]) }).unchecked).toEqual([
      ['n.json', 'unreadable'],
    ]);
  });

  it('latin-1 without a marker is still ignored', () => {
    expect(
      run({ 'l.json': Uint8Array.from(Buffer.from('{"name":"caf\u00e9"}', 'latin1')) }),
    ).toEqual({ files: [], unchecked: [] });
  });

  it('a template whose markers sit after a large Mappings section (beyond 64 KB) is still reported', () => {
    const text = `{"Mappings":{${pad(200_000)}},"AWSTemplateFormatVersion":"2010-09-09","Caf":"\u00e9"}`;
    expect(run({ 'm.json': Uint8Array.from(Buffer.from(text, 'latin1')) }).unchecked).toEqual([
      ['m.json', 'unreadable'],
    ]);
  });

  it('"Resources" with "AWS::" alone is a marker', () => {
    const text = '{"Resources":{"Q":{"Properties":{},"T":"AWS::SQS::Queue"}},"d":"caf\u00e9"}';
    expect(run({ 'r.json': Uint8Array.from(Buffer.from(text, 'latin1')) }).unchecked).toEqual([
      ['r.json', 'unreadable'],
    ]);
  });

  it('the window is bounded: a marker after 1 MB is not looked for', () => {
    const text = `{${pad(1_100_000)},"AWSTemplateFormatVersion":"1","d":"caf\u00e9"}`;
    expect(run({ 'b.json': Uint8Array.from(Buffer.from(text, 'latin1')) }).unchecked).toEqual([]);
  });
});

describe('R4: the new reason codes in the JSON and SARIF output', () => {
  const files = {
    'macro/t.yaml': `${HEAD}Transform: AWS::Include\nResources: {}\n`,
    'alias/t.yaml': `${TPL}X: &a 1\nY: *a\n`,
    'both/t.yaml': `${TPL}apiVersion: v1\nkind: ConfigMap\n`,
    'dup/t.json': '{"AWSTemplateFormatVersion":"1","a":1,"a":2}',
  };
  it('JSON lists each with its code and fixed words', () => {
    const t = tree(files);
    const json = runBuilt(['.', '--format', 'json'], { cwd: t.root });
    const doc = JSON.parse(json.stdout) as {
      unchecked: { file: string; reason: string; reasonCode: string }[];
    };
    const byFile = Object.fromEntries(doc.unchecked.map((u) => [u.file, u]));
    expect(byFile['macro/t.yaml']).toMatchObject({
      reasonCode: 'cfn-transform',
      reason: 'uses a CloudFormation transform or macro that can rewrite the template',
    });
    expect(byFile['alias/t.yaml']).toMatchObject({
      reasonCode: 'cfn-unreadable',
      reason: 'CloudFormation or SAM syntax that tripcurve does not read',
    });
    expect(byFile['both/t.yaml']?.reasonCode).toBe('template-ambiguous');
    expect(byFile['dup/t.json']).toMatchObject({
      reasonCode: 'json-parse-error',
      reason: 'JSON syntax error (or a key written twice)',
    });
  });

  it('SARIF has a warning result at each file', () => {
    const t = tree(files);
    const sarif = runBuilt(['.', '--format', 'sarif'], { cwd: t.root });
    const log = JSON.parse(sarif.stdout) as {
      runs: {
        results: {
          level: string;
          locations?: { physicalLocation: { artifactLocation: { uri: string } } }[];
        }[];
      }[];
    };
    const uris = (log.runs[0]?.results ?? [])
      .filter((r) => r.level === 'warning')
      .map((r) => r.locations?.[0]?.physicalLocation.artifactLocation.uri);
    for (const f of Object.keys(files)) expect(uris).toContain(f);
  });
});

describe('survivors: the template shape rule', () => {
  it('a Transform string starting AWS:: makes a template even with no Resources and no header', () => {
    expect(isCfnTemplateValue({ Transform: 'AWS::Include' })).toBe(true);
    expect(isCfnTemplateValue({ Transform: 'lower' })).toBe(false);
    expect(run({ 't.yaml': 'Transform: AWS::Include\n' }).unchecked).toEqual([
      ['t.yaml', 'cfn-transform'],
    ]);
  });

  it('Transform with a Resources key of any form makes a template with no header and no AWS:: Transform', () => {
    expect(isCfnTemplateValue({ Transform: 'MyMacro', Resources: null })).toBe(true);
    expect(
      isCfnTemplateValue({ Transform: 'MyMacro', Resources: { Q: { Type: 'AWS::SQS::Queue' } } }),
    ).toBe(true);
    expect(isCfnTemplateValue({ Transform: 'MyMacro', Other: {} })).toBe(false);
    expect(
      run({ 't.yaml': 'Transform: MyMacro\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n' })
        .unchecked,
    ).toEqual([['t.yaml', 'cfn-transform']]);
  });
});

describe('third pass: flow style, and every branch of the top-indent scan', () => {
  const indented = TPL.replace(/^(?=.)/gm, '  ');
  const crlf = (s: string) => s.replaceAll('\n', '\r\n');

  it('a flow-style template with unquoted keys is read (a .yaml file may be JSON-like)', () => {
    const flow =
      '{AWSTemplateFormatVersion: "2010-09-09", Resources: {Q: {Type: AWS::SQS::Queue, Properties: {VisibilityTimeout: 60}}}}\n';
    expect(run({ 't.yaml': flow }).files).toEqual(['t.yaml=cfn-template']);
    const multi =
      '{\n  AWSTemplateFormatVersion: "2010-09-09",\n  Resources: {Q: {Type: AWS::SQS::Queue}}\n}\n';
    expect(run({ 'u.yaml': multi }).files).toEqual(['u.yaml=cfn-template']);
  });

  it('(a) a CRLF template with indented keys that starts with a blank CRLF line is read', () => {
    expect(run({ 't.yaml': crlf(`\n${indented}`) }).files).toEqual(['t.yaml=cfn-template']);
  });

  it('(b) a second-document template with indented keys after a non-template document is found (and, being one of two documents, reported)', () => {
    expect(run({ 't.yaml': `kind: other\nname: y\n---\n${indented}` }).unchecked).toEqual([
      ['t.yaml', 'cfn-unreadable'],
    ]);
  });

  it('(c) a %YAML directive before an indented template is read', () => {
    expect(run({ 't.yaml': `%YAML 1.2\n---\n${indented}` }).files).toEqual(['t.yaml=cfn-template']);
  });

  it('(d) a Resources-only file is a candidate with AWS:: types and silent without any', () => {
    expect(run({ 'a.yaml': 'Resources:\n  Q:\n    Type: AWS::SQS::Queue\n' }).files).toEqual([
      'a.yaml=cfn-template',
    ]);
    expect(run({ 'b.yaml': 'Resources:\n  a: &x 1\n  b: *x\n' })).toEqual({
      files: [],
      unchecked: [],
    });
  });

  it('(d) the AWS:: condition is observable: a Resources-only file with no AWS:: text is not parsed at all, so a broken one is silent', () => {
    expect(run({ 'c.yaml': 'Resources:\n  a: [\n' })).toEqual({ files: [], unchecked: [] });
    expect(run({ 'd.yaml': 'Resources:\n  a: [\n  t: AWS::x\n' }).unchecked).toEqual([
      ['d.yaml', 'parse-error'],
    ]);
  });

  it('a candidate that is not a template (Resources-only, AWS:: text elsewhere) with an alias is silent: the probe ignores it before template mode', () => {
    expect(run({ 'n.yaml': 'Resources: x\nnote: AWS::foo\na: &a 1\nb: *a\n' })).toEqual({
      files: [],
      unchecked: [],
    });
  });

  it('(e) a values file with top-level Transform and Resources keys and an alias is reported (cfn-unreadable): the shape is a template shape', () => {
    expect(run({ 'v.yaml': 'Transform: x\nResources:\n  a: &x 1\n  b: *x\n' }).unchecked).toEqual([
      ['v.yaml', 'cfn-unreadable'],
    ]);
  });
});
