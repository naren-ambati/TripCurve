// Hostile Terraform (bolt B5): the reader is bounded (never recurses, work grows with the text) and never
// crashes, never freezes, and never reads a value out of text that is not code. Scaling is checked with
// test/support/scaling.ts, never a wall-clock budget.
import { describe, expect, it } from 'vitest';
import { hclWaiverComments, readHcl, streamOrigin } from '../../src/parse/iac/read-hcl.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';

registerTfCleanup();

const origin = streamOrigin(1);
const read = (text: string) => readHcl(text, origin);
const sqs = (body: string) => `resource "aws_sqs_queue" "q" {\n${body}}\n`;

describe('hostile files are bounded and never crash', () => {
  const cases: [string, string][] = [
    ['a million open braces', '{'.repeat(1_000_000)],
    ['a million open brackets in a block', sqs(`  x = ${'['.repeat(1_000_000)}\n`)],
    ['a million nested templates', `x = "${'${"'.repeat(500_000)}`],
    ['a million nested closers', sqs(`  x = ${'('.repeat(300_000)}${')'.repeat(300_000)}\n`)],
    [
      'deeply nested blocks',
      `resource "aws_sqs_queue" "q" {\n${'a {\n'.repeat(200_000)}${'}\n'.repeat(200_001)}`,
    ],
    ['a million heredoc openers', '<<A\n'.repeat(500_000)],
    [
      'a very long line',
      `resource "aws_sqs_queue" "q" {\n  note = "${'a'.repeat(3_000_000)}"\n}\n`,
    ],
    ['a very long identifier', `${'a'.repeat(2_000_000)} {}`],
    ['only newlines', '\n'.repeat(2_000_000)],
    ['an unterminated string', sqs('  note = "abc\n')],
    ['an unterminated heredoc', sqs('  p = <<EOT\nabc\n')],
    ['an unterminated block comment', `/* ${'x'.repeat(10)}`],
    ['an unterminated template', sqs('  n = "a ${ b\n')],
    ['a heredoc marker at the end of the file', sqs('  p = <<EOT')],
    ['a lone surrogate', sqs('  n = "\ud800"\n')],
    ['control characters', sqs('  n = "\u0001\u0002"\n\u0000')],
    ['a byte-order mark inside', sqs('  ﻿ x = 1\n')],
    ['carriage returns only', sqs('  x = 1\r').replaceAll('\n', '\r')],
    ['an escaped backslash at the end of a line', sqs('  x = "\\\n"\n')],
  ];
  it.each(cases)('%s', (_name, text) => {
    const result = read(text);
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) expect(result.line).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(hclWaiverComments(text))).toBe(true);
  });

  it('a hostile tree of files is read without a crash and none yields a value', () => {
    const r = readTf({
      'a.tf': '{'.repeat(100_000),
      'b.tf': sqs('  visibility_timeout_seconds = "\n'),
      'c.tf': '"${'.repeat(100_000),
      'd.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    expect(r.resources).toHaveLength(1);
    expect(r.unchecked).toHaveLength(3);
    expect(r.incomplete).toBe(true);
  });
});

describe('comment and string tricks do not change what is read', () => {
  it('a comment opener inside a string is not a comment', () => {
    const r = readTf({ 'a.tf': sqs('  url = "http://x/* y"\n  visibility_timeout_seconds = 4\n') });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe('4 s @ a.tf:3');
  });

  it('a hash inside a string does not hide the rest of the line', () => {
    const r = readTf({ 'a.tf': sqs('  note = "#" visibility_timeout_seconds = 4\n') });
    // `note = "#" visibility_timeout_seconds = 4` is one attribute (note) with a longer expression
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe('absent');
  });

  it('a closing brace in a comment does not end the block', () => {
    const r = readTf({
      'a.tf': sqs('  # }\n  // }\n  /* } */\n  visibility_timeout_seconds = 4\n'),
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe('4 s @ a.tf:5');
  });

  it('a resource written inside a heredoc or a string is not a resource', () => {
    const r = readTf({
      'a.tf':
        'locals {\n  text = <<EOT\nresource "aws_sqs_queue" "fake" {\n  visibility_timeout_seconds = 1\n}\nEOT\n}\n',
    });
    expect(r.resources).toEqual([]);
  });

  it('inline waiver comments are read only where they are real comments', () => {
    const text = [
      '# tripcurve: ignore T4 reason="a" until=2027-01-31',
      'resource "aws_sqs_queue" "q" {',
      '  note = "# tripcurve: ignore T4 reason=\\"b\\" until=2027-01-31"',
      '  p = <<EOT',
      '# tripcurve: ignore T4 reason="c" until=2027-01-31',
      'EOT',
      '  visibility_timeout_seconds = 4 // tripcurve: ignore T4 reason="d" until=2027-01-31',
      '}',
      '/* # tripcurve: ignore T4 */',
    ].join('\n');
    expect(hclWaiverComments(text).map((c) => c.line)).toEqual([1, 7]);
  });
});

describe('the reader scales linearly (no wall-clock budget)', () => {
  const ratioOf = (make: (n: number) => string): number =>
    scalingRatio((n) => {
      read(make(n));
    }, 2_000);

  it(
    'with the number of resources',
    () => {
      expect(
        ratioOf((n) =>
          Array.from(
            { length: n },
            (_v, i) =>
              `resource "aws_sqs_queue" "q${i}" {\n  visibility_timeout_seconds = ${i % 99}\n}\n`,
          ).join(''),
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'with the number of attributes in one block',
    () => {
      expect(
        ratioOf((n) => sqs(Array.from({ length: n }, (_v, i) => `  a${i} = ${i}\n`).join(''))),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'with the depth of nesting',
    () => {
      expect(
        ratioOf((n) => `resource "aws_sqs_queue" "q" {\n${'a {\n'.repeat(n)}${'}\n'.repeat(n)}}\n`),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'with the length of a heredoc',
    () => {
      expect(ratioOf((n) => sqs(`  p = <<EOT\n${'line\n'.repeat(n)}EOT\n`))).toBeLessThan(
        LINEAR_RATIO_LIMIT,
      );
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'with the number of nested templates',
    () => {
      expect(ratioOf((n) => sqs(`  x = ${'"${'.repeat(n)}${'}"'.repeat(n)}\n`))).toBeLessThan(
        LINEAR_RATIO_LIMIT,
      );
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'with many resources that all name each other (the lookups used for linking)',
    () => {
      expect(
        ratioOf((n) =>
          Array.from(
            { length: n },
            (_v, i) =>
              `resource "aws_lambda_event_source_mapping" "m${i}" {\n  event_source_arn = aws_sqs_queue.q${i}.arn\n}\n`,
          ).join(''),
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});
