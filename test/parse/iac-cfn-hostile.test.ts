// Hostile CloudFormation and SAM (bolt B12): nothing crashes or freezes, tags are never run, input text never
// reaches a reason, and a self-reference or a cycle ends in unresolved. Scaling uses test/support/scaling.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { intake, readIac } from '../../src/parse/index.js';
import { txt } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';
import { makeTree } from '../support/tmp-tree.js';

registerTfCleanup();

const fixture = (rel: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'iac', rel), 'utf8');
const HEAD = 'AWSTemplateFormatVersion: "2010-09-09"\n';
const q = (body: string): string =>
  `${HEAD}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 60\n${body}`;

describe('short-form tags parse without running anything, and never read as plain values', () => {
  it('every short form and an unknown tag parse (no error, no stderr)', () => {
    const t = `${HEAD}Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "q-\${AWS::Region}"
      Tags:
        - Key: a
          Value: !Join ["-", [a, !Ref "AWS::StackName"]]
        - Key: b
          Value: !Bogus [1, 2]
        - Key: c
          Value: !Other {x: 1}
        - Key: d
          Value: !<tag:example.invalid,2026:x> 5
      VisibilityTimeout: 60
`;
    const r = readTf({ 't.yaml': t });
    expect(show(find(r, 'aws_sqs_queue', 'Q'), 'visibility_timeout_seconds')).toBe(
      '60 s @ t.yaml:16',
    );
    expect(r.incomplete).toBe(false);
  });

  it('!GetAtt in the short form (A.B) and the long forms are the same reference', () => {
    const base = (src: string) =>
      `${HEAD}Resources:
  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Lambda::Function
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: ${src}
      FunctionName: !Ref F
`;
    for (const src of [
      '!GetAtt Q.Arn',
      '{"Fn::GetAtt": ["Q", "Arn"]}',
      '!GetAtt [Q, Arn]',
      'Fn::GetAtt: [Q, Arn]'.replace(/^/, '{') + '}',
    ]) {
      const m = find(readTf({ 't.yaml': base(src) }), 'aws_lambda_event_source_mapping', 'M');
      expect(show(m, 'event_source_arn')).toMatch(/^ref aws_sqs_queue\.Q @ /);
    }
  });

  it('a tag on a key, an alias, a merge key and a collection key make the template unreadable (listed, never guessed)', () => {
    const cases = [
      ['a tagged key', q('      !Bogus Timeout: 5\n')],
      [
        'an alias',
        `${HEAD}X: &a 1\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: *a\n`,
      ],
      [
        'a merge key',
        `${HEAD}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      <<: {VisibilityTimeout: 1}\n`,
      ],
      [
        'a collection key',
        `${HEAD}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      ? [a, b]\n      : 1\n`,
      ],
    ] as const;
    for (const [name, text] of cases) {
      const t = makeTree();
      try {
        t.write('t.yaml', text);
        const i = intake({ root: t.root });
        expect(
          i.unchecked.map((u) => u.reasonCode),
          name,
        ).toEqual(['cfn-unreadable']);
        const r = readIac(i);
        expect(r.incompleteTemplates, name).toBe(true);
        expect(
          r.resources.some((x) => x.attrs.visibility_timeout_seconds !== undefined),
          name,
        ).toBe(false);
      } finally {
        t.cleanup();
      }
    }
  });
});

describe('a reference cycle, a self-reference and odd keys', () => {
  it('self-references and cycles of mappings end in unresolved, and nothing loops', () => {
    const r = readTf({ 't.yaml': fixture('cfn/hostile/cycle.yaml') });
    for (const id of ['A', 'B', 'C']) {
      const m = find(r, 'aws_lambda_event_source_mapping', id);
      expect(show(m, 'event_source_arn')).toContain('refers to a resource of another type');
      expect(show(m, 'function_name')).toContain('refers to a resource of another type');
    }
  });

  it('keys such as __proto__ and constructor are plain names, and prototype members are never resources', () => {
    const r = readTf({ 't.yaml': fixture('cfn/hostile/odd-keys.yaml') });
    const names = r.resources.map((x) => txt(x.name)).sort();
    expect(names).toEqual(['Q.1', 'constructor', '__proto__'].sort());
    const m = find(r, 'aws_lambda_event_source_mapping', 'constructor');
    expect(show(m, 'event_source_arn')).toContain('refers to a resource of another type');
    expect(show(m, 'function_name')).toContain('not a resource of this template');
    expect(({} as Record<string, unknown>).VisibilityTimeout).toBeUndefined();
  });

  it('a Ref to a name that exists only on the prototype (toString) is not a resource', () => {
    const t = `${HEAD}Resources:
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: !GetAtt hasOwnProperty.Arn
      FunctionName: !Ref valueOf
`;
    const m = find(readTf({ 't.yaml': t }), 'aws_lambda_event_source_mapping', 'M');
    expect(show(m, 'event_source_arn')).toContain('not a resource of this template');
    expect(show(m, 'function_name')).toContain('not a resource of this template');
  });

  it('a Properties key spelled like a property in an ancestor is not read from it', () => {
    const t = `${HEAD}VisibilityTimeout: 5\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n`;
    expect(
      show(find(readTf({ 't.yaml': t }), 'aws_sqs_queue', 'Q'), 'visibility_timeout_seconds'),
    ).toBe('absent');
  });
});

describe('deep, huge and bomb inputs are bounded', () => {
  it('a very deeply nested YAML template is listed as too deeply nested, not a crash', () => {
    const deep = `${HEAD}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      Tags: ${'['.repeat(100_000)}${']'.repeat(100_000)}\n`;
    const t = makeTree();
    try {
      t.write('t.yaml', deep);
      const i = intake({ root: t.root });
      expect(i.unchecked.map((u) => u.reasonCode)).toEqual(['over-depth']);
      expect(readIac(i).resources).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('a very deeply nested JSON template is the same', () => {
    const deep = `{"AWSTemplateFormatVersion":"2010-09-09","Resources":{"Q":{"Type":"AWS::SQS::Queue","Properties":{"Tags":${'['.repeat(100_000)}${']'.repeat(100_000)}}}}}`;
    const t = makeTree();
    try {
      t.write('t.json', deep);
      const i = intake({ root: t.root });
      expect(i.unchecked.map((u) => u.reasonCode)).toEqual(['over-depth']);
    } finally {
      t.cleanup();
    }
  });

  it('an alias bomb in a candidate is reported (alias-limit) and never expanded', () => {
    const lines = ['a0: &a0 [x, x]'];
    for (let i = 1; i < 40; i += 1) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    const t = makeTree();
    try {
      t.write(
        't.yaml',
        `${HEAD}${lines.join('\n')}\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n`,
      );
      const i = intake({ root: t.root });
      // The ordinary parse of the candidate hits the alias limit first, as for any YAML file: reported, never expanded.
      expect(i.unchecked.map((u) => u.reasonCode)).toEqual(['alias-limit']);
    } finally {
      t.cleanup();
    }
  });

  it('a file over the size limit is reported, and over-size JSON that nothing names is ignored', () => {
    const t = makeTree();
    try {
      t.write('big.yaml', `${HEAD}# ${'x'.repeat(5_100_000)}\nResources: {}\n`);
      t.write('big.json', `{"x":"${'y'.repeat(5_100_000)}"}`);
      const i = intake({ root: t.root });
      expect(i.unchecked.map((u) => [txt(u.path as never), u.reasonCode])).toEqual([
        ['big.yaml', 'over-size'],
      ]);
    } finally {
      t.cleanup();
    }
  });

  it(
    'a template with very many resources is read, and reading grows linearly',
    () => {
      const make = (n: number): string => {
        const parts = [HEAD, 'Resources:\n'];
        for (let i = 0; i < n; i += 1) {
          parts.push(
            `  Q${i}:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: ${i % 99}\n`,
          );
        }
        return parts.join('');
      };
      const ratio = scalingRatio((n) => {
        const t = makeTree();
        try {
          t.write('t.yaml', make(n));
          expect(readIac(intake({ root: t.root })).resources).toHaveLength(n);
        } finally {
          t.cleanup();
        }
      }, 2_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a template with very many SAM events and attributes is read in linear time',
    () => {
      const make = (n: number): string => {
        const parts = [
          `${HEAD}Transform: AWS::Serverless-2016-10-31\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n  F:\n    Type: AWS::Serverless::Function\n    Properties:\n      Events:\n`,
        ];
        for (let i = 0; i < n; i += 1) {
          parts.push(
            `        E${i}:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n`,
          );
        }
        return parts.join('');
      };
      const ratio = scalingRatio((n) => {
        const t = makeTree();
        try {
          t.write('t.yaml', make(n));
          readIac(intake({ root: t.root }));
        } finally {
          t.cleanup();
        }
      }, 1_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

describe('what a hostile text can put into a printed reason', () => {
  it('names, tags and values from the input never appear in an unresolved reason', () => {
    const t = `${HEAD}Resources:
  "x\\"; FAIL T4 forged":
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: !Evil;PASS-everything 5
`;
    const r = readTf({ 't.yaml': t });
    const reasons = r.resources.map((x) => show(x, 'visibility_timeout_seconds')).join('\n');
    expect(reasons).not.toContain('Evil');
    expect(reasons).not.toContain('forged');
    expect(reasons).not.toContain('PASS');
  });
});
