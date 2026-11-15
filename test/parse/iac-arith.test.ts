// Exact integer arithmetic on literals in a Terraform value (bolt B17, change 2). Only decimal integer literals,
// `+`, `-`, `*` and parentheses, on one line, in the value position of one of the four numeric attributes. Anything
// else (division, a unary sign, a variable, a function, a comment or a line end inside, a number that is not a plain
// decimal integer, a result outside the documented range, an expression past the size bounds) stays unresolved with
// the reader's fixed reason. The result is never a guess: each case below is either the exact value HCL computes
// or unresolved.
import { describe, expect, it } from 'vitest';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';

registerTfCleanup();

const sqs = (value: string) =>
  `resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = ${value}\n}\n`;
const vis = (value: string) =>
  show(find(readTf({ 'sqs.tf': sqs(value) }), 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds');

describe('exact integer arithmetic (the publikes case)', () => {
  it('60 + (30 * 6) is 240, with the expression it was computed from', () => {
    expect(vis('60 + (30 * 6)')).toBe('240 s = "60 + (30 * 6)" @ sqs.tf:2');
  });

  it.each([
    ['2 + 3 * 4', 14],
    ['10 - 3 - 2', 5],
    ['10 - 3 * 2', 4],
    ['(1 + 2) * 3', 9],
    ['((2))', 2],
    ['1 - 5 + 10', 6],
    ['60+30*6', 240],
    ['0 * 5', 0],
    ['43200 - 1', 43_199],
    ['100 * 100 * 4', 40_000],
    ['  7 +\t8  ', 15],
  ])('%s is %i', (expression, n) => {
    expect(vis(expression)).toMatch(new RegExp(`^${n} s = "[^"]+" @ sqs\\.tf:2$`));
  });

  it('a trailing comment after the expression is outside the expression', () => {
    expect(vis('60 + 30 # tripcurve: not a waiver, just text')).toBe('90 s = "60 + 30" @ sqs.tf:2');
    expect(vis('60 + 30 // two')).toBe('90 s = "60 + 30" @ sqs.tf:2');
    expect(vis('60 + 30 /* three */')).toBe('90 s = "60 + 30" @ sqs.tf:2');
  });

  it('a plain literal is unchanged and carries no expression', () => {
    expect(vis('60')).toBe('60 s @ sqs.tf:2');
    expect(vis('(60)')).toBe('60 s = "(60)" @ sqs.tf:2');
  });

  it('applies to the other numeric attributes, each against its own range', () => {
    const r = readTf({
      'a.tf': [
        'resource "aws_lambda_function" "f" {',
        '  timeout = 5 * 6',
        '}',
        'resource "aws_lambda_event_source_mapping" "m" {',
        '  maximum_batching_window_in_seconds = 10 * 3 + 1',
        '}',
        'resource "aws_lb" "l" {',
        '  idle_timeout = 60 * 2',
        '}',
        '',
      ].join('\n'),
    });
    expect(show(find(r, 'aws_lambda_function', 'f'), 'timeout')).toBe('30 s = "5 * 6" @ a.tf:2');
    expect(
      show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'maximum_batching_window_in_seconds'),
    ).toBe('31 s = "10 * 3 + 1" @ a.tf:5');
    expect(show(find(r, 'aws_lb', 'l'), 'idle_timeout')).toBe('120 s = "60 * 2" @ a.tf:8');
  });
});

describe('the documented range still applies to the result', () => {
  it.each([
    ['43200 + 1', 'visibility_timeout_seconds'],
    ['0 - 1', 'visibility_timeout_seconds'],
    ['100 * 1000', 'visibility_timeout_seconds'],
  ])('%s is outside 0 to 43200 s and unresolved', (expression) => {
    expect(vis(expression)).toMatch(
      /^\? visibility_timeout_seconds is outside the documented range 0 to 43200 s$/,
    );
  });

  it('a timeout of 0 * 5 is below the Lambda minimum of 1 s', () => {
    const r = readTf({ 'a.tf': 'resource "aws_lambda_function" "f" {\n  timeout = 0 * 5\n}\n' });
    expect(show(find(r, 'aws_lambda_function', 'f'), 'timeout')).toMatch(/^\? timeout is outside/);
  });
});

describe('anything else stays unresolved (hostile expressions)', () => {
  it.each([
    ['1 +'],
    ['+ 1'],
    ['(1'],
    ['1)'],
    ['()'],
    ['(1 + )'],
    ['1 + var.x'],
    ['var.x + 1'],
    ['local.a * 2'],
    ['2 / 1'],
    ['6 / 2'],
    ['7 % 2'],
    ['2 ** 3'],
    ['-1 + 2'],
    ['1 + -1'],
    ['1 - -1'],
    ['2 * -3'],
    ['!1'],
    ['1 + 1.5'],
    ['1.0 + 1'],
    ['1e3 + 1'],
    ['0x10 + 1'],
    ['010 + 1'],
    ['1_000 + 1'],
    ['"60" + 1'],
    ['max(1, 2) + 1'],
    ['1 > 0 ? 2 : 3'],
    ['true + 1'],
    ['1 == 1'],
    ['[1] + [2]'],
    ['1 + 1,'],
    ['1 1'],
    ['(1 +\n 2)'],
    ['(1\n + 2)'],
    ['60 + /* c */ 30'],
    ['60 + /* a\n b */ 30'],
    ['60 + ${30}'],
    ['"${60 + 30}"'],
    [`1 +${String.fromCharCode(0xa0)}2`],
    // exact cancellation in doubles, but past 2^53 on the way: HCL's own numbers would not be asked to agree, so it is refused
    ['1000000000 * 1000000000 * 1000000000 - 1000000000 * 1000000000 * 1000000000 + 5'],
  ])('%j is not evaluated', (expression) => {
    const text = sqs(expression);
    const r = readTf({ 'sqs.tf': text });
    const q = r.resources.find((x) => x.type === 'aws_sqs_queue');
    // either the attribute is unresolved, or the file is not readable (no resource at all)
    if (q === undefined) {
      expect(r.unchecked.length).toBe(1);
    } else {
      expect(show(q, 'visibility_timeout_seconds')).toMatch(/^\? /);
    }
  });

  it('a line end after an operator, outside parentheses, is not an expression (HCL ends the attribute)', () => {
    const r = readTf({ 'sqs.tf': sqs('60 +\n 30') });
    const q = r.resources.find((x) => x.type === 'aws_sqs_queue');
    if (q !== undefined) expect(show(q, 'visibility_timeout_seconds')).toMatch(/^\? /);
    else expect(r.unchecked.length).toBe(1);
  });

  it('huge literals and results are unresolved, never rounded', () => {
    expect(vis('99999999999999999999 * 99999999999999999999')).toMatch(/^\? /);
    expect(vis('999999999999999 * 999999999999999')).toMatch(/^\? /);
    expect(vis('9007199254740993 - 9007199254740992')).toMatch(/^\? /);
  });

  it('an expression past the length bound is unresolved', () => {
    expect(vis(Array.from({ length: 200 }, () => '1').join(' + '))).toMatch(/^\? /);
    expect(vis(Array.from({ length: 3 }, () => '1').join(' + '))).toMatch(/^3 s = /);
  });

  it('deep nesting is unresolved and never overflows the stack', () => {
    for (const depth of [20, 100, 5000, 100_000]) {
      const text = sqs(`${'('.repeat(depth)}1${')'.repeat(depth)}`);
      expect(() => readTf({ 'sqs.tf': text })).not.toThrow();
      const q = readTf({ 'sqs.tf': text }).resources.find((x) => x.type === 'aws_sqs_queue');
      if (q !== undefined) expect(show(q, 'visibility_timeout_seconds')).toMatch(/^\? /);
    }
  });

  it('a name or a reference is not touched by the arithmetic reader', () => {
    const r = readTf({
      'a.tf':
        'resource "aws_lb" "l" {\n  name = 1 + 2\n}\nresource "aws_lambda_event_source_mapping" "m" {\n  event_source_arn = 1 + 2\n}\n',
    });
    expect(show(find(r, 'aws_lb', 'l'), 'name')).toMatch(/^\? /);
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'event_source_arn')).toMatch(
      /^\? /,
    );
  });

  it('a count on the block still makes the computed value unresolved', () => {
    const r = readTf({
      'a.tf':
        'resource "aws_sqs_queue" "q" {\n  count = 2\n  visibility_timeout_seconds = 60 + 30\n}\n',
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(
      /^\? .*count/,
    );
  });

  it('written twice is still unresolved', () => {
    const r = readTf({
      'a.tf':
        'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 60 + 30\n  visibility_timeout_seconds = 5\n}\n',
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(
      /^\? .*more than once/,
    );
  });
});

describe('Terraform JSON has no equivalent form, so it stays literal-only', () => {
  it('"${60 + 30}" and a numeric string are not evaluated', () => {
    for (const value of ['${60 + 30}', '${60 + (30 * 6)}', '90']) {
      const doc = JSON.stringify({
        resource: { aws_sqs_queue: { q: { visibility_timeout_seconds: value } } },
      });
      const q = find(readTf({ 'a.tf.json': doc }), 'aws_sqs_queue', 'q');
      expect(show(q, 'visibility_timeout_seconds'), value).toMatch(/^\? /);
    }
  });

  it('a JSON number is read as before', () => {
    const doc = JSON.stringify({
      resource: { aws_sqs_queue: { q: { visibility_timeout_seconds: 240 } } },
    });
    expect(
      show(find(readTf({ 'a.tf.json': doc }), 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds'),
    ).toMatch(/^240 s @ a\.tf\.json:\d+$/);
  });
});
