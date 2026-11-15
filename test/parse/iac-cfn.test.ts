// The CloudFormation and SAM reader: the four values as literals, the
// same-template links, and every form that is not a literal. Honesty first: a value that is absent is a claim of
// absence, so the Globals, Transform, Condition and parameter guards each have a test that fails without them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  intake,
  readIac,
  type TfResource,
  tfAttr,
  uncheckedReasonWords,
} from '../../src/parse/index.js';
import { txt } from '../support/render.js';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';

registerTfCleanup();

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'iac');
const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const read = (files: Record<string, string>) => readTf(files);

/** The one mapping of a result. */
function mapping(files: Record<string, string>, name?: string): TfResource {
  const r = read(files).resources.filter((x) => x.type === 'aws_lambda_event_source_mapping');
  const hit = name === undefined ? r[0] : r.find((x) => txt(x.name) === name);
  if (hit === undefined) throw new Error('no mapping was read');
  return hit;
}

const FN_BODY = `      Handler: index.handler
      Runtime: nodejs22.x
      Role: arn:aws:iam::000000000000:role/x
      Code:
        ZipFile: "x"
`;

function queueWith(value: string): Record<string, string> {
  return {
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: ${value}
`,
  };
}
const visibility = (value: string): string => {
  const r = find(read(queueWith(value)), 'aws_sqs_queue', 'Q');
  return show(r, 'visibility_timeout_seconds');
};

describe('the SAM demo and the plain CloudFormation form read into the one model', () => {
  it('a SAM SQS event is one mapping named after the function and the event, with the three values and lines', () => {
    const m = mapping({ 'template.yaml': fixture('sam/orders/template.yaml') });
    expect(txt(m.name)).toBe('OrdersFunction/OrdersEvent');
    expect(m.form).toBe('cfn');
    expect(show(m, 'event_source_arn')).toBe('ref aws_sqs_queue.OrdersQueue @ template.yaml:19');
    expect(show(m, 'function_name')).toBe(
      'ref aws_lambda_function.OrdersFunction @ template.yaml:9',
    );
    expect(show(m, 'maximum_batching_window_in_seconds')).toBe('5 s @ template.yaml:21');
    const r = read({ 'template.yaml': fixture('sam/orders/template.yaml') });
    expect(show(find(r, 'aws_sqs_queue', 'OrdersQueue'), 'visibility_timeout_seconds')).toBe(
      '60 s @ template.yaml:7',
    );
    expect(show(find(r, 'aws_lambda_function', 'OrdersFunction'), 'timeout')).toBe(
      '30 s @ template.yaml:14',
    );
  });

  it('plain CloudFormation with an AWS::Lambda::EventSourceMapping, in YAML and in JSON, gives the same values', () => {
    const y = read({ 'template.yaml': fixture('cfn/orders/template.yaml') });
    const j = read({ 'template.json': fixture('cfn/orders-json/template.json') });
    for (const r of [y, j]) {
      const m = find(r, 'aws_lambda_event_source_mapping', 'OrdersMapping');
      expect(show(m, 'maximum_batching_window_in_seconds').startsWith('5 s @ ')).toBe(true);
      expect(show(m, 'event_source_arn').startsWith('ref aws_sqs_queue.OrdersQueue @ ')).toBe(true);
      expect(show(m, 'function_name').startsWith('ref aws_lambda_function.OrdersFunction @ ')).toBe(
        true,
      );
      expect(show(find(r, 'aws_sqs_queue', 'OrdersQueue'), 'visibility_timeout_seconds')).toMatch(
        /^60 s @ template\.(?:yaml|json):\d+$/,
      );
      expect(show(find(r, 'aws_lambda_function', 'OrdersFunction'), 'timeout')).toMatch(
        /^30 s @ template\.(?:yaml|json):\d+$/,
      );
    }
  });

  it('a JSON template carries a real line for every value (the file is read as positions)', () => {
    const r = read({ 'template.json': fixture('cfn/orders-json/template.json') });
    const q = find(r, 'aws_sqs_queue', 'OrdersQueue');
    const text = fixture('cfn/orders-json/template.json').split('\n');
    const line = Number(/:(\d+)$/.exec(show(q, 'visibility_timeout_seconds'))?.[1]);
    expect(text[line - 1]).toContain('"VisibilityTimeout": 60');
  });
});

describe('literals: only a whole number whose source text is plain digits', () => {
  it.each([
    ['60', '60 s @ t.yaml:6'],
    ['0', '0 s @ t.yaml:6'],
    ['43200', '43200 s @ t.yaml:6'],
  ])('%s is read', (text, expected) => {
    expect(visibility(text)).toBe(expected);
  });

  it.each([
    ['0x3C', 'hexadecimal'],
    ['0o74', 'octal'],
    ['1e2', 'exponent'],
    ['060', 'leading zero'],
    ['60.0', 'a decimal point'],
    ['+60', 'a sign'],
    ['-1', 'negative'],
    ['"60"', 'a quoted number'],
    ["'60'", 'a single-quoted number'],
    ['!!int 60', 'an explicit tag'],
    ['!Bogus 60', 'an unknown tag (the library would hand over the bare value)'],
    ['!Ref Param', 'a Ref'],
    ['43201', 'out of range'],
    ['.inf', 'infinity'],
    ['true', 'a boolean'],
    ['[60]', 'a list'],
    ['{Ref: X}', 'a long-form Ref'],
    ['', 'null'],
  ])('%s (%s) is unresolved, never a literal', (text) => {
    expect(visibility(text).startsWith('? ')).toBe(true);
  });

  it('an unknown tag is unresolved with the intrinsic reason, not read as its bare value 60', () => {
    expect(visibility('!Bogus 60')).toBe(
      '? VisibilityTimeout uses an intrinsic function, a condition or a tag that tripcurve does not evaluate',
    );
  });

  it('an absent VisibilityTimeout is absent (the resolver supplies the documented default)', () => {
    const r = read({
      't.yaml':
        'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n',
    });
    expect(show(find(r, 'aws_sqs_queue', 'Q'), 'visibility_timeout_seconds')).toBe('absent');
  });
});

describe('intrinsic functions and parameters are unresolved with a fixed reason', () => {
  const r = read({ 't.yaml': fixture('cfn/intrinsics/template.yaml') });
  it.each(['QueueIf', 'QueueSub', 'QueueBogus', 'QueueLong'])('%s', (name) => {
    expect(show(find(r, 'aws_sqs_queue', name), 'visibility_timeout_seconds')).toBe(
      '? VisibilityTimeout uses an intrinsic function, a condition or a tag that tripcurve does not evaluate',
    );
  });

  it('a Ref to a Parameter is unresolved even when the parameter has a Default (a deploy can override it)', () => {
    const p = read({ 't.yaml': fixture('cfn/parameter-ref/template.yaml') });
    expect(show(find(p, 'aws_sqs_queue', 'OrdersQueue'), 'visibility_timeout_seconds')).toBe(
      '? VisibilityTimeout refers to a template parameter (parameter files are not read, and a deploy can override a default)',
    );
  });

  it('the input text of a tag or key never reaches a reason', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: !Evil-forged 60
`;
    const text = show(
      find(read({ 't.yaml': t }), 'aws_sqs_queue', 'Q'),
      'visibility_timeout_seconds',
    );
    expect(text).not.toContain('Evil');
    expect(text).not.toContain('forged');
  });
});

describe('the SAM Globals guard: an absent Timeout is a default only when Globals was read in full', () => {
  const sam = (globals: string, own = ''): Record<string, string> => ({
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
${globals}Resources:
  F:
    Type: AWS::Serverless::Function
    Properties:
${FN_BODY}${own}`,
  });
  const timeout = (files: Record<string, string>): string =>
    show(find(read(files), 'aws_lambda_function', 'F'), 'timeout');

  it('Globals.Function.Timeout applies to a function without its own, with the Globals line', () => {
    expect(timeout(sam('Globals:\n  Function:\n    Timeout: 30\n'))).toBe('30 s @ t.yaml:5');
  });

  it("the function's own Timeout replaces Globals (primitive types are replaced)", () => {
    expect(timeout(sam('Globals:\n  Function:\n    Timeout: 30\n', '      Timeout: 12\n'))).toMatch(
      /^12 s @ t\.yaml:\d+$/,
    );
  });

  it.each([
    ['Globals is a string', 'Globals: nope\n'],
    ['Globals is empty', 'Globals:\n'],
    ['Globals is a list', 'Globals:\n  - Function: {Timeout: 30}\n'],
    ['Globals is an intrinsic', 'Globals: !Ref X\n'],
    ['Globals.Function is a list', 'Globals:\n  Function:\n    - Timeout: 30\n'],
    ['Globals.Function is a string', 'Globals:\n  Function: x\n'],
    ['Globals.Function is empty', 'Globals:\n  Function:\n'],
    ['Globals.Function is an intrinsic', 'Globals:\n  Function: !If [c, {Timeout: 30}, {}]\n'],
    ['Globals.Function.Timeout is a parameter', 'Globals:\n  Function:\n    Timeout: !Ref T\n'],
    ['Globals.Function.Timeout is a string', 'Globals:\n  Function:\n    Timeout: "30"\n'],
    ['Globals.Function.Timeout is hexadecimal', 'Globals:\n  Function:\n    Timeout: 0x1E\n'],
  ])('%s: the function Timeout is unresolved, never the Lambda default', (_n, globals) => {
    expect(timeout(sam(globals)).startsWith('? ')).toBe(true);
    expect(timeout(sam(globals))).not.toBe('absent');
  });

  it('an unread Globals gives the Globals reason', () => {
    expect(timeout(sam('Globals: nope\n'))).toBe(
      '? Timeout the SAM Globals section is not in a form tripcurve reads fully (a Globals.Function that is not a plain mapping, or an intrinsic function in it)',
    );
  });

  it('no Globals and no Timeout is absent: the documented default is the resolver\u2019s', () => {
    expect(timeout(sam(''))).toBe('absent');
    expect(timeout(sam('Globals:\n  Api:\n    Cors: "*"\n'))).toBe('absent');
  });

  it('a plain AWS::Lambda::Function in a SAM template does not take Globals', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Timeout: 30
Resources:
  F:
    Type: AWS::Lambda::Function
    Properties:
${FN_BODY}`;
    expect(show(find(read({ 't.yaml': t }), 'aws_lambda_function', 'F'), 'timeout')).toBe('absent');
  });

  it('the Globals section of the fixture is read from its own line', () => {
    const m = read({ 't.yaml': fixture('sam/globals-timeout/template.yaml') });
    expect(show(find(m, 'aws_lambda_function', 'OrdersFunction'), 'timeout')).toBe(
      '30 s @ t.yaml:5',
    );
  });
});

describe('the Transform guard: any other transform or macro makes the whole template unresolved', () => {
  const withTransform = (line: string): Record<string, string> => ({
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
${line}Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
`,
  });
  const attr = (files: Record<string, string>): string =>
    show(find(read(files), 'aws_sqs_queue', 'Q'), 'visibility_timeout_seconds');
  const WHY =
    '? the template uses a transform or macro other than AWS::Serverless-2016-10-31 (or Fn::Transform), which can rewrite its resources';

  it.each([
    'Transform: AWS::Include\n',
    'Transform: AWS::LanguageExtensions\n',
    'Transform: MyMacro\n',
    'Transform:\n  - AWS::LanguageExtensions\n  - AWS::Serverless-2016-10-31\n',
    'Transform: [AWS::Serverless-2016-10-31]\n',
    'Transform: AWS::Serverless-2016-10-31x\n',
    'Transform: aws::serverless-2016-10-31\n',
    'Transform: !Ref X\n',
    'Transform:\n',
  ])('%s', (line) => {
    expect(attr(withTransform(line))).toBe(WHY);
  });

  it('exactly the SAM transform reads the values', () => {
    expect(attr(withTransform('Transform: AWS::Serverless-2016-10-31\n'))).toBe('60 s @ t.yaml:7');
  });

  it('Fn::Transform anywhere in the template is the same', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
  R:
    Type: AWS::SNS::Topic
    Properties:
      Tags:
        - Key: a
          Value:
            Fn::Transform:
              Name: AWS::Include
              Parameters: {Location: s3://x/y}
`;
    expect(attr({ 't.yaml': t })).toBe(WHY);
  });

  it('the file is listed as not checked, with a fixed reason, and the read says it is incomplete', () => {
    const t = read({ 't.yaml': fixture('cfn/other-transform/template.yaml') });
    expect(t.unchecked.map((u) => u.reasonCode)).toEqual(['cfn-transform']);
    expect(t.incompleteTemplates).toBe(true);
    expect(t.incomplete).toBe(false);
    expect(uncheckedReasonWords('cfn-transform')).toBe(
      'uses a CloudFormation transform or macro that can rewrite the template',
    );
  });

  it('the mapping of a template with another transform is unresolved, never linked', () => {
    const m = mapping({ 't.yaml': fixture('cfn/other-transform/template.yaml') });
    expect(m.problem?.reason).toContain('transform or macro');
    expect(tfAttr(m, 'event_source_arn')?.kind).toBe('unresolved');
  });

  it('an AWS::Serverless resource without the SAM transform is not trusted', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  F:
    Type: AWS::Serverless::Function
    Properties:
      Timeout: 5
`;
    const r = read({ 't.yaml': t });
    expect(show(find(r, 'aws_lambda_function', 'F'), 'timeout')).toContain('SAM transform');
  });

  it('a resource without a readable Type makes the template untrusted', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
  Odd: 5
`;
    expect(attr({ 't.yaml': t })).toContain('without a readable Type');
  });
});

describe('a Condition on the resource, and Properties that are not a plain mapping', () => {
  it('a resource with a Condition may not exist: every value is unresolved', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Conditions:
  Make: !Equals [a, a]
Resources:
  Q:
    Type: AWS::SQS::Queue
    Condition: Make
    Properties:
      VisibilityTimeout: 60
`;
    const q = find(read({ 't.yaml': t }), 'aws_sqs_queue', 'Q');
    expect(show(q, 'visibility_timeout_seconds')).toBe(
      '? the resource has a Condition, so it may not exist',
    );
    expect(tfAttr(q, 'visibility_timeout_seconds')?.kind).toBe('unresolved');
  });

  it('Properties that are an intrinsic function or a list are unresolved, not absent', () => {
    for (const props of ['!If [c, {VisibilityTimeout: 60}, {}]', '[1, 2]', '5']) {
      const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties: ${props}
`;
      const q = find(read({ 't.yaml': t }), 'aws_sqs_queue', 'Q');
      expect(tfAttr(q, 'visibility_timeout_seconds')?.kind).toBe('unresolved');
    }
  });
});

describe('links: a Ref or GetAtt is followed only inside the same template, and only to link', () => {
  const mapWith = (source: string, fn: string, extra = ''): Record<string, string> => ({
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  P:
    Type: String
Resources:
  Q:
    Type: AWS::SQS::Queue
  K:
    Type: AWS::Kinesis::Stream
  N:
    Type: AWS::CloudFormation::Stack
  F:
    Type: AWS::Lambda::Function
    Properties:
${FN_BODY}  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      EventSourceArn: ${source}
      FunctionName: ${fn}
${extra}`,
  });
  const arn = (source: string): string =>
    show(
      find(read(mapWith(source, '!Ref F')), 'aws_lambda_event_source_mapping', 'M'),
      'event_source_arn',
    );
  const fn = (name: string): string =>
    show(
      find(read(mapWith('!GetAtt Q.Arn', name)), 'aws_lambda_event_source_mapping', 'M'),
      'function_name',
    );

  it('the queue is GetAtt Arn of a queue of this template', () => {
    expect(arn('!GetAtt Q.Arn')).toMatch(/^ref aws_sqs_queue\.Q @ /);
    expect(arn('{"Fn::GetAtt": [Q, Arn]}')).toMatch(/^ref aws_sqs_queue\.Q @ /);
    expect(arn('{Fn::GetAtt: Q.Arn}')).toMatch(/^ref aws_sqs_queue\.Q @ /);
  });

  it.each([
    ['!Ref Q', 'is not a reference tripcurve follows'],
    ['!GetAtt Q.QueueName', 'is not a reference tripcurve follows'],
    ['!GetAtt K.Arn', 'is a stream (Kinesis or DynamoDB)'],
    ['!GetAtt N.Outputs.Q', 'refers to a nested stack'],
    ['!GetAtt F.Arn', 'refers to a resource of another type'],
    ['!Ref P', 'refers to a template parameter'],
    ['!GetAtt Nope.Arn', 'refers to something that is not a resource of this template'],
    ['!Ref AWS::Region', 'refers to something that is not a resource of this template'],
    ['arn:aws:sqs:us-east-1:000000000000:q', 'is not a reference tripcurve follows'],
    ['!Sub "arn:aws:sqs:us-east-1:000000000000:${P}"', 'uses an intrinsic function'],
    ['!ImportValue Q', 'uses an intrinsic function'],
    ['!Select [0, [a]]', 'uses an intrinsic function'],
    ['!Join ["", [a]]', 'uses an intrinsic function'],
    ['!FindInMap [a, b, c]', 'uses an intrinsic function'],
    ['!If [c, !GetAtt Q.Arn, !GetAtt Q.Arn]', 'uses an intrinsic function'],
  ])('event source %s is unresolved (%s)', (source, why) => {
    const text = arn(source);
    expect(text.startsWith('? EventSourceArn ')).toBe(true);
    expect(text).toContain(why);
  });

  it('the function is a Ref or GetAtt Arn of a function of this template', () => {
    expect(fn('!Ref F')).toMatch(/^ref aws_lambda_function\.F @ /);
    expect(fn('!GetAtt F.Arn')).toMatch(/^ref aws_lambda_function\.F @ /);
    expect(fn('my-function')).toContain('is not a reference tripcurve follows');
    expect(fn('!Ref P')).toContain('refers to a template parameter');
    expect(fn('!GetAtt F.Nope')).toContain('is not a reference tripcurve follows');
    expect(fn('!Ref Q')).toContain('refers to a resource of another type');
  });

  it('an absent EventSourceArn or FunctionName is unresolved, not linked', () => {
    const t = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  M:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      MaximumBatchingWindowInSeconds: 5
`;
    const m = find(read({ 't.yaml': t }), 'aws_lambda_event_source_mapping', 'M');
    expect(show(m, 'event_source_arn').startsWith('? ')).toBe(true);
    expect(show(m, 'function_name').startsWith('? ')).toBe(true);
  });

  it('the nested stack fixture: an output of a nested stack is not read', () => {
    const m = find(
      read({ 't.yaml': fixture('cfn/nested-stack/template.yaml') }),
      'aws_lambda_event_source_mapping',
      'OrdersMapping',
    );
    expect(show(m, 'event_source_arn')).toBe(
      '? EventSourceArn refers to a nested stack, which is not read',
    );
  });

  it('the Kinesis fixture: a stream is not followed', () => {
    const m = find(
      read({ 't.yaml': fixture('cfn/kinesis/template.yaml') }),
      'aws_lambda_event_source_mapping',
      'EventsMapping',
    );
    expect(show(m, 'event_source_arn')).toBe(
      '? EventSourceArn is a stream (Kinesis or DynamoDB), which tripcurve does not follow: only an SQS queue is',
    );
  });
});

describe('SAM Events', () => {
  const sam = (events: string): Record<string, string> => ({
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  Q:
    Type: AWS::SQS::Queue
  F:
    Type: AWS::Serverless::Function
    Properties:
${FN_BODY}      Events:
${events}`,
  });
  const mappings = (files: Record<string, string>) =>
    read(files).resources.filter((r) => r.type === 'aws_lambda_event_source_mapping');

  it('each SQS event is one mapping; other event types (Api, Schedule) are not mappings', () => {
    const r = mappings(
      sam(`        A:
          Type: SQS
          Properties:
            Queue: !GetAtt Q.Arn
        B:
          Type: Api
          Properties:
            Path: /x
            Method: get
        C:
          Type: SQS
          Properties:
            Queue: !GetAtt Q.Arn
            MaximumBatchingWindowInSeconds: 20
`),
    );
    expect(r.map((x) => txt(x.name))).toEqual(['F/A', 'F/C']);
    expect(show(r[0] as TfResource, 'maximum_batching_window_in_seconds')).toBe('absent');
    expect(show(r[1] as TfResource, 'maximum_batching_window_in_seconds')).toMatch(/^20 s @/);
  });

  it('a Kinesis or DynamoDB event is a mapping whose source is unresolved (a stream)', () => {
    const r = mappings(
      sam(
        '        K:\n          Type: Kinesis\n          Properties:\n            Stream: !GetAtt S.Arn\n            StartingPosition: LATEST\n',
      ),
    );
    expect(show(r[0] as TfResource, 'event_source_arn')).toContain('is a stream');
  });

  it.each([
    ['an event whose Type is a parameter', '        A:\n          Type: !Ref T\n'],
    ['an event that is not a mapping', '        A: 5\n'],
    ['an event whose Type is missing', '        A:\n          Properties: {}\n'],
    ['Events that are an intrinsic', '        Fn::If: [c, {}, {}]\n'],
  ])('%s is one unresolved mapping, never dropped', (_n, events) => {
    const r = mappings(sam(events));
    expect(r).toHaveLength(1);
    expect(r[0]?.problem).toBeDefined();
  });

  it('a SQS event with a Queue that is not a GetAtt of a queue is unresolved', () => {
    const r = mappings(
      sam('        A:\n          Type: SQS\n          Properties:\n            Queue: !Ref Q\n'),
    );
    expect(show(r[0] as TfResource, 'event_source_arn')).toContain(
      'is not a reference tripcurve follows',
    );
  });

  it('a function with a Condition makes its events unresolved', () => {
    const files = sam(
      '        A:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n',
    );
    const t = (files['t.yaml'] as string).replace(
      '    Type: AWS::Serverless::Function\n',
      '    Type: AWS::Serverless::Function\n    Condition: C\n',
    );
    const r = mappings({ 't.yaml': t });
    expect(r[0]?.problem?.reason).toContain('Condition');
  });

  it('the function of an event is the enclosing function, by reference', () => {
    const r = mappings(
      sam(
        '        A:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n',
      ),
    );
    expect(show(r[0] as TfResource, 'function_name')).toMatch(/^ref aws_lambda_function\.F @ /);
  });
});

describe('the load balancer idle timeout attribute', () => {
  const alb = (attrs: string, extra = ''): Record<string, string> => ({
    't.yaml': `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  L:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties:
${extra}      LoadBalancerAttributes:
${attrs}`,
  });
  const idle = (attrs: string, extra = ''): string =>
    show(find(read(alb(attrs, extra)), 'aws_lb', 'L'), 'idle_timeout');
  const entry = (key: string, value: string): string =>
    `        - Key: ${key}\n          Value: ${value}\n`;

  it('reads the entry with the idle key, as a string or a number, with its line', () => {
    expect(idle(entry('idle_timeout.timeout_seconds', '"120"'))).toBe('120 s @ t.yaml:8');
    expect(idle(entry('idle_timeout.timeout_seconds', '120'))).toBe('120 s @ t.yaml:8');
    expect(
      idle(
        entry('deletion_protection.enabled', '"true"') +
          entry('idle_timeout.timeout_seconds', "'75'"),
      ),
    ).toMatch(/^75 s @ t\.yaml:\d+$/);
  });

  it('the fixtures: with the attribute 120 s; without it absent (the resolver supplies 60 s for an application LB)', () => {
    const a = find(read({ 'a.yaml': fixture('cfn/alb/with-idle.yaml') }), 'aws_lb', 'Alb');
    expect(show(a, 'idle_timeout')).toBe('120 s @ a.yaml:11');
    const b = find(read({ 'b.yaml': fixture('cfn/alb/without-idle.yaml') }), 'aws_lb', 'Alb');
    expect(show(b, 'idle_timeout')).toBe('absent');
  });

  it('no entry with the idle key, every entry read: absent', () => {
    expect(idle(entry('deletion_protection.enabled', '"true"'))).toBe('absent');
  });

  it.each([
    ['0x78', 'hexadecimal'],
    ['"0120"', 'a leading zero'],
    ['"1e2"', 'an exponent'],
    ['"12 "', 'padding'],
    ['"-5"', 'negative'],
    ['"120.0"', 'a decimal'],
    ['5000', 'out of range 1 to 4000'],
    ['0', 'out of range'],
    ['!Ref Idle', 'a Ref'],
    ['!Sub "${AWS::Region}"', 'a Sub'],
    ['!If [c, "10", "20"]', 'an If'],
    ['|\n            120', 'a block scalar'],
  ])('value %s (%s) is unresolved', (value) => {
    expect(idle(entry('idle_timeout.timeout_seconds', value)).startsWith('? ')).toBe(true);
  });

  it('a tagged value or key is never the bare value the yaml library would hand over (an unknown tag drops the tag)', () => {
    expect(idle(entry('idle_timeout.timeout_seconds', '!Bogus "120"'))).toContain(
      'uses an intrinsic function',
    );
    expect(idle(entry('!Bogus idle_timeout.timeout_seconds', '"120"'))).toContain(
      'could be the idle timeout',
    );
    const type = show(
      find(
        read(
          alb(entry('deletion_protection.enabled', '"true"'), '      Type: !Bogus application\n'),
        ),
        'aws_lb',
        'L',
      ),
      'load_balancer_type',
    );
    expect(type).toContain('uses an intrinsic function');
  });

  it('a Key that is not a literal could be the idle key: unresolved, not absent', () => {
    expect(idle(entry('!Ref K', '"120"'))).toContain('could be the idle timeout');
    expect(idle(entry('!Sub "idle_${X}"', '"120"'))).toContain('could be the idle timeout');
  });

  it('an entry that is not a plain Key/Value mapping, or a list item that is an If, is unresolved', () => {
    expect(
      idle(
        '        - !If [c, {Key: idle_timeout.timeout_seconds, Value: "10"}, !Ref AWS::NoValue]\n',
      ),
    ).toContain('not a plain list of Key and Value entries');
    expect(idle('        - just a string\n')).toContain('not a plain list');
  });

  it('LoadBalancerAttributes that are not a list is unresolved', () => {
    const files = {
      't.yaml':
        'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  L:\n    Type: AWS::ElasticLoadBalancingV2::LoadBalancer\n    Properties:\n      LoadBalancerAttributes: !Ref Attrs\n',
    };
    expect(show(find(read(files), 'aws_lb', 'L'), 'idle_timeout')).toContain(
      'uses an intrinsic function',
    );
    const files2 = { 't.yaml': files['t.yaml'].replace('!Ref Attrs', '{a: b}') };
    expect(show(find(read(files2), 'aws_lb', 'L'), 'idle_timeout')).toContain('not a plain list');
  });

  it('the idle key written twice is unresolved (duplicate)', () => {
    expect(
      idle(
        entry('idle_timeout.timeout_seconds', '"10"') +
          entry('idle_timeout.timeout_seconds', '"20"'),
      ),
    ).toContain('is written more than once');
  });

  it('the type is read as a literal: absent, application and network are told apart by the resolver; a Ref is unresolved', () => {
    const type = (v: string | undefined): string => {
      const extra = v === undefined ? '' : `      Type: ${v}\n`;
      return show(
        find(read(alb(entry('deletion_protection.enabled', '"true"'), extra)), 'aws_lb', 'L'),
        'load_balancer_type',
      );
    };
    expect(type(undefined)).toBe('absent');
    expect(type('network')).toMatch(/^"network" @/);
    expect(type('!Ref T')).toContain('uses an intrinsic function');
  });
});

describe('logical ids are per template: two templates in one folder are two stacks', () => {
  it('the same logical id in two files of one folder is not "declared twice" (that is a Terraform rule)', () => {
    const one =
      'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 60\n';
    const r = read({ 'infra/a.yaml': one, 'infra/b.yaml': one.replace('60', '90') });
    const qs = r.resources.filter((x) => x.type === 'aws_sqs_queue');
    expect(qs.map((x) => show(x, 'visibility_timeout_seconds'))).toEqual([
      '60 s @ infra/a.yaml:6',
      '90 s @ infra/b.yaml:6',
    ]);
  });
});

describe('what is not a template, and what is never read', () => {
  const classes = (files: Record<string, string>): string[] => {
    const t = makeTreeIntake(files);
    return t.map((f) => `${txt(f.canonicalPath)}=${f.class}`);
  };

  it('CDK code, cdk.out, parameters.json, samconfig.toml and a nested-stack TemplateURL are ignored', () => {
    const tpl = fixture('cfn/orders/template.yaml');
    expect(
      classes({
        'cdk.out/Stack.template.json': fixture('cfn/orders-json/template.json'),
        'cdk.out/manifest.json': '{"version":"36.0.0"}',
        'parameters.json': '[{"ParameterKey":"Visibility","ParameterValue":"60"}]',
        'samconfig.toml': 'version = 0.1\n',
        'lib/stack.ts': 'export class Stack {}\n',
        'template.yaml': tpl,
      }),
    ).toEqual(['lib/stack.ts=node-source', 'template.yaml=cfn-template']);
  });

  it('a .json template in a tree is read; other JSON (tsconfig, data) is ignored', () => {
    expect(
      classes({
        'infra/stack.json': fixture('cfn/orders-json/template.json'),
        'tsconfig.json': '{"compilerOptions":{"strict":true}}',
        'data.json': '{"Resources":{"a":1},"Type":"AWS::x"}',
        'list.json': '[1,2,3]',
      }),
    ).toEqual(['infra/stack.json=cfn-template']);
  });

  it('package.json that mentions a template stays package.json; a JSON template does not collide with it', () => {
    const pkg = '{"name":"x","description":"AWSTemplateFormatVersion Resources Type AWS::"}';
    expect(classes({ 'package.json': pkg })).toEqual(['package.json=package-json']);
  });

  it('a package-lock.json is a lock file, not a template', () => {
    const lock =
      '{"name":"x","lockfileVersion":3,"packages":{"":{"description":"\\"Resources\\" \\"Type\\" \\"AWS::\\""}}}';
    expect(classes({ 'package-lock.json': lock })).toEqual(['package-lock.json=node-lock']);
  });

  it('a Terraform plan given as the root is a plan, even when it mentions a template; a plan that is also a template is reported', () => {
    const t = makeTreeIntake;
    const plan =
      '{"format_version":"1.2","planned_values":{"root_module":{}},"note":"\\"Resources\\" \\"Type\\" \\"AWS::x\\""}';
    expect(t({ 'plan.json': plan }, 'plan.json').map((f) => f.class)).toEqual(['terraform-json']);
    const both =
      '{"format_version":"1.2","values":{},"AWSTemplateFormatVersion":"2010-09-09","Resources":{"a":{"Type":"AWS::SQS::Queue"}}}';
    const r = intake({ root: writeRoot({ 'both.json': both }, 'both.json') });
    expect(r.unchecked.map((u) => u.reasonCode)).toEqual(['template-ambiguous']);
    expect(r.files).toEqual([]);
  });

  it('a template that is also a Terraform-plan-looking text but is a template by shape is read as a template', () => {
    const tpl =
      '{"AWSTemplateFormatVersion":"2010-09-09","Description":"format_version values planned_values configuration","Resources":{"Q":{"Type":"AWS::SQS::Queue"}}}';
    expect(makeTreeIntake({ 'stack.json': tpl }, 'stack.json').map((f) => f.class)).toEqual([
      'cfn-template',
    ]);
  });

  it('a Kubernetes manifest is never a template, and a template is never a Kubernetes manifest', () => {
    const deploy =
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\nspec:\n  replicas: 1\n';
    expect(classes({ 'k.yaml': deploy })).toEqual(['k.yaml=k8s-yaml']);
    expect(classes({ 't.yaml': fixture('cfn/orders/template.yaml') })).toEqual([
      't.yaml=cfn-template',
    ]);
  });

  it('a ConfigMap that carries a template as text is Kubernetes, and a template that carries a manifest as text is a template', () => {
    const cm = `apiVersion: v1
kind: ConfigMap
metadata:
  name: tpl
data:
  stack.yaml: |
    AWSTemplateFormatVersion: "2010-09-09"
    Transform: AWS::Serverless-2016-10-31
    Resources:
      Q:
        Type: AWS::SQS::Queue
`;
    expect(classes({ 'cm.yaml': cm })).toEqual(['cm.yaml=k8s-yaml']);
    const tpl = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Manifest:
    Type: AWS::CloudFormation::Stack
    Metadata:
      Text: |
        apiVersion: v1
        kind: ConfigMap
`;
    expect(classes({ 't.yaml': tpl })).toEqual(['t.yaml=cfn-template']);
  });

  it('a file that could be both at the top level is reported, not guessed', () => {
    const both =
      'AWSTemplateFormatVersion: "2010-09-09"\nResources: {}\napiVersion: v1\nkind: ConfigMap\n';
    const r = intake({ root: writeRoot({ 'x.yaml': both }) });
    expect(r.unchecked.map((u) => [txt(u.path as never), u.reasonCode])).toEqual([
      ['x.yaml', 'template-ambiguous'],
    ]);
    expect(uncheckedReasonWords('template-ambiguous')).toContain('read as none');
  });

  it('a YAML file with a top-level Resources key that is not a template is ignored', () => {
    expect(classes({ 'a.yaml': 'Resources:\n  - a\n  - b\n' })).toEqual([]);
    expect(classes({ 'b.yaml': 'Resources:\n  web:\n    cpu: 2\n' })).toEqual([]);
    expect(classes({ 'c.yaml': 'Transform: lower\nname: x\n' })).toEqual([]);
  });

  it('typed resources without a version header or a transform are a template by shape', () => {
    expect(classes({ 'a.yaml': 'Resources:\n  Q:\n    Type: AWS::SQS::Queue\n' })).toEqual([
      'a.yaml=cfn-template',
    ]);
    expect(classes({ 'b.yaml': 'Resources:\n  Q:\n    Type: Foo\n' })).toEqual([]);
  });

  it('a template split into several documents is not read, and is reported', () => {
    const r = intake({
      root: writeRoot({
        't.yaml': `${fixture('cfn/orders/template.yaml')}---\nAWSTemplateFormatVersion: "2010-09-09"\nResources: {}\n`,
      }),
    });
    expect(r.unchecked.map((u) => u.reasonCode)).toEqual(['cfn-unreadable']);
    expect(readIac(r).resources).toEqual([]);
    expect(readIac(r).incompleteTemplates).toBe(true);
  });

  it('a .json file that cannot be read is ignored, like any file that is not known to be ours', () => {
    const r = intake({
      root: writeRoot({ 'weird.json': new Uint8Array([0xe9, 0x41, 0x7b]) }),
    });
    expect(r.unchecked).toEqual([]);
  });
});

import { makeTree } from '../support/tmp-tree.js';

const roots: { cleanup(): void }[] = [];
afterEach(() => {
  for (const t of roots.splice(0)) t.cleanup();
});
function writeRoot(files: Record<string, string | Uint8Array>, root?: string): string {
  const t = makeTree();
  roots.push(t);
  let last = t.root;
  for (const [p, c] of Object.entries(files)) last = t.write(p, c);
  return root === undefined ? t.root : last;
}
function makeTreeIntake(files: Record<string, string>, root?: string) {
  return intake({ root: writeRoot(files, root) }).files;
}
