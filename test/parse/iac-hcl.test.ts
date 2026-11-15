// The Terraform reader: four resource types, eight attributes, literals
// only. Anything the reader does not fully understand is unresolved or the file is not read; absence is
// reported as absence and nothing is guessed.
import { describe, expect, it } from 'vitest';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';

registerTfCleanup();

const sqs = (body: string) => `resource "aws_sqs_queue" "q" {\n${body}}\n`;
const visibility = (files: Record<string, string>) =>
  show(find(readTf(files), 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds');

describe('literals', () => {
  it('reads the four attributes with their lines', () => {
    const r = readTf({
      'infra/queue.tf': [
        'resource "aws_sqs_queue" "q" {',
        '  visibility_timeout_seconds = 60',
        '}',
        'resource "aws_lambda_function" "f" {',
        '  timeout = 30',
        '}',
        'resource "aws_lambda_event_source_mapping" "m" {',
        '  maximum_batching_window_in_seconds = 5',
        '}',
        'resource "aws_lb" "main" {',
        '  idle_timeout = 120',
        '  name         = "main-alb"',
        '}',
        '',
      ].join('\n'),
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe(
      '60 s @ infra/queue.tf:2',
    );
    expect(show(find(r, 'aws_lambda_function', 'f'), 'timeout')).toBe('30 s @ infra/queue.tf:5');
    expect(
      show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'maximum_batching_window_in_seconds'),
    ).toBe('5 s @ infra/queue.tf:8');
    expect(show(find(r, 'aws_lb', 'main'), 'idle_timeout')).toBe('120 s @ infra/queue.tf:11');
    expect(show(find(r, 'aws_lb', 'main'), 'name')).toBe('"main-alb" @ infra/queue.tf:12');
    expect(r.unchecked).toEqual([]);
    expect(r.incomplete).toBe(false);
  });

  it('reports the resource header line as the source of the resource', () => {
    const r = readTf({ 'a.tf': `\n\n${sqs('')}` });
    expect(find(r, 'aws_sqs_queue', 'q').source).toMatchObject({ type: 'file', line: 3 });
  });

  it('reads bare labels, a one-line block and Windows line ends', () => {
    expect(
      visibility({ 'a.tf': 'resource aws_sqs_queue q { visibility_timeout_seconds = 7 }\n' }),
    ).toBe('7 s @ a.tf:1');
    expect(
      visibility({ 'a.tf': sqs('  visibility_timeout_seconds = 7\n').replaceAll('\n', '\r\n') }),
    ).toBe('7 s @ a.tf:2');
  });

  it('reads an attribute written after nested blocks and other attributes', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  tags = {\n    a = "}"\n  }\n  redrive_policy = jsonencode({ x = 1 })\n  timeouts {\n    create = "1m"\n  }\n  visibility_timeout_seconds = 9\n',
        ),
      }),
    ).toBe('9 s @ a.tf:9');
  });

  it('ignores other resource types and other top-level blocks', () => {
    const r = readTf({
      'a.tf':
        'variable "v" {\n  default = 1\n}\nprovider "aws" {\n  region = "x"\n}\nresource "aws_s3_bucket" "b" {\n  timeout = 4\n}\n' +
        sqs('  visibility_timeout_seconds = 1\n'),
    });
    expect(r.resources).toHaveLength(1);
  });
});

describe('absence is absence', () => {
  it('an attribute that is not written is absent, never a default', () => {
    expect(visibility({ 'a.tf': sqs('  name = "q"\n') })).toBe('absent');
  });

  it('an attribute only in a comment is absent', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  # visibility_timeout_seconds = 99\n  // visibility_timeout_seconds = 98\n  /* visibility_timeout_seconds = 97 */\n',
        ),
      }),
    ).toBe('absent');
  });

  it('an attribute only inside a heredoc or a string is absent', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  policy = <<EOT\nvisibility_timeout_seconds = 5\nEOT\n  note = "visibility_timeout_seconds = 5"\n',
        ),
      }),
    ).toBe('absent');
  });

  it('an attribute inside a nested block is not the top-level attribute', () => {
    expect(
      visibility({ 'a.tf': sqs('  nested {\n    visibility_timeout_seconds = 5\n  }\n') }),
    ).toBe('absent');
  });
});

describe('values that are not literal numbers are unresolved', () => {
  it.each([
    ['a variable', 'var.t'],
    ['a local', 'local.t'],
    // integer arithmetic on literals is read since B17 (iac-arith.test.ts); division and names are not
    ['a division', '60 / 1'],
    ['a sum with a variable', '30 + var.x'],
    ['a function call', 'tonumber("60")'],
    ['a negative number', '-5'],
    ['a string', '"60"'],
    ['a fraction', '60.5'],
    ['an exponent', '6e1'],
    ['a conditional', 'true ? 60 : 30'],
    ['null', 'null'],
    ['a reference to a resource', 'aws_x.y.z'],
    ['an indexed list', '[60][0]'],
    ['a heredoc', '<<EOT\n60\nEOT'],
    ['a huge number', '99999999999999999999'],
  ])('%s', (_name, expr) => {
    expect(visibility({ 'a.tf': sqs(`  visibility_timeout_seconds = ${expr}\n`) })).toMatch(/^\? /);
  });

  it('an expression across several lines inside brackets is still one unresolved value', () => {
    const out = visibility({
      'a.tf': sqs('  visibility_timeout_seconds = max([\n    1,\n    60,\n  ]...)\n  name = "q"\n'),
    });
    expect(out).toMatch(/^\? /);
  });

  it('a block comment that hides a newline does not make a literal out of an expression', () => {
    expect(visibility({ 'a.tf': sqs('  visibility_timeout_seconds = 5 /*\n*/ + 10\n') })).toMatch(
      /^\? /,
    );
  });

  it('a value outside the documented range is unresolved, with the range', () => {
    expect(visibility({ 'a.tf': sqs('  visibility_timeout_seconds = 43201\n') })).toBe(
      '? visibility_timeout_seconds is outside the documented range 0 to 43200 s',
    );
    expect(visibility({ 'a.tf': sqs('  visibility_timeout_seconds = 43200\n') })).toBe(
      '43200 s @ a.tf:2',
    );
    const lambda = readTf({ 'a.tf': 'resource "aws_lambda_function" "f" {\n  timeout = 0\n}\n' });
    expect(show(find(lambda, 'aws_lambda_function', 'f'), 'timeout')).toMatch(
      /outside the documented range 1 to 900/,
    );
  });

  it('an attribute written twice is unresolved', () => {
    expect(
      visibility({
        'a.tf': sqs('  visibility_timeout_seconds = 5\n  visibility_timeout_seconds = 6\n'),
      }),
    ).toMatch(/^\? .*more than once/);
  });

  it('a name with a template or an escape is not a literal name', () => {
    const r = readTf({
      'a.tf':
        'resource "aws_lb" "a" {\n  name = "x-${var.env}"\n}\nresource "aws_lb" "b" {\n  name = "y\\"z"\n}\n',
    });
    expect(show(find(r, 'aws_lb', 'a'), 'name')).toMatch(/^\? /);
    expect(show(find(r, 'aws_lb', 'b'), 'name')).toMatch(/^\? /);
  });
});

describe('references', () => {
  const mapping = (attrs: string) =>
    `resource "aws_lambda_event_source_mapping" "m" {\n${attrs}}\n`;
  const read = (attrs: string, name: 'event_source_arn' | 'function_name') =>
    show(find(readTf({ 'a.tf': mapping(attrs) }), 'aws_lambda_event_source_mapping', 'm'), name);

  it('a plain reference to the queue and to the function is read', () => {
    expect(read('  event_source_arn = aws_sqs_queue.orders.arn\n', 'event_source_arn')).toBe(
      'ref aws_sqs_queue.orders @ a.tf:2',
    );
    expect(read('  function_name = aws_lambda_function.f.function_name\n', 'function_name')).toBe(
      'ref aws_lambda_function.f @ a.tf:2',
    );
  });

  it.each([
    ['a literal ARN', 'event_source_arn = "arn:aws:sqs:us-east-1:000000000000:orders"'],
    ['a stream', 'event_source_arn = aws_kinesis_stream.s.arn'],
    ['another attribute', 'event_source_arn = aws_sqs_queue.orders.id'],
    ['an index', 'event_source_arn = aws_sqs_queue.orders[0].arn'],
    ['a legacy template', 'event_source_arn = "${aws_sqs_queue.orders.arn}"'],
    ['a function call', 'event_source_arn = lower(aws_sqs_queue.orders.arn)'],
    ['a variable', 'event_source_arn = var.arn'],
    ['a module output', 'event_source_arn = module.q.arn'],
  ])('%s is unresolved', (_n, line) => {
    expect(read(`  ${line}\n`, 'event_source_arn')).toMatch(/^\? /);
  });
});

describe('a block that is not exactly one instance with the attributes it shows (allow-list)', () => {
  it.each([
    ['count', '  count = 2\n'],
    ['for_each', '  for_each = toset(["a"])\n'],
    ['a dynamic block', '  dynamic "x" {\n    for_each = []\n    content {}\n  }\n'],
    ['ignore_changes', '  lifecycle {\n    ignore_changes = [visibility_timeout_seconds]\n  }\n'],
    [
      'a lifecycle condition block',
      '  lifecycle {\n    precondition {\n      condition = true\n      error_message = "x"\n    }\n  }\n',
    ],
    ['a computed lifecycle flag', '  lifecycle {\n    prevent_destroy = var.p\n  }\n'],
  ])('%s makes every value unresolved, the literal too', (_n, extra) => {
    const out = visibility({ 'a.tf': sqs(`  visibility_timeout_seconds = 60\n${extra}`) });
    expect(out).toMatch(/^\? /);
  });

  it('a lifecycle block of create_before_destroy and prevent_destroy only is understood', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  visibility_timeout_seconds = 60\n  lifecycle {\n    create_before_destroy = true\n    prevent_destroy = false\n  }\n',
        ),
      }),
    ).toBe('60 s @ a.tf:2');
  });
});

describe('override files', () => {
  it.each(['override.tf', 'main_override.tf'])(
    '%s makes a resource it names unresolved in every file of its folder',
    (name) => {
      const r = readTf({
        'infra/queue.tf': sqs('  visibility_timeout_seconds = 60\n'),
        [`infra/${name}`]: sqs('  visibility_timeout_seconds = 5\n'),
      });
      for (const q of r.resources)
        expect(show(q, 'visibility_timeout_seconds')).toMatch(/^\? .*override/);
    },
  );

  it('an override file in another folder changes nothing here', () => {
    const r = readTf({
      'a/queue.tf': sqs('  visibility_timeout_seconds = 60\n'),
      'b/override.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    const a = r.resources.find((x) => x.source.type === 'file' && x.dir === 'a');
    expect(a && show(a, 'visibility_timeout_seconds')).toBe('60 s @ a/queue.tf:2');
  });
});

describe('an override file that cannot be read', () => {
  it('makes every resource of its folder unresolved: which one it changes is unknown', () => {
    const r = readTf({
      'infra/queue.tf': sqs('  visibility_timeout_seconds = 60\n'),
      'infra/override.tf': 'resource "aws_sqs_queue" "q" {\n  x = "abc\n}\n',
      'other/queue.tf': sqs('  visibility_timeout_seconds = 61\n'),
    });
    const shown = r.resources
      .map((x) => `${x.dir}: ${show(x, 'visibility_timeout_seconds')}`)
      .sort();
    expect(shown).toEqual([
      'infra: ? an override file changes this resource',
      'other: 61 s @ other/queue.tf:2',
    ]);
  });
});

describe('a file the reader cannot read', () => {
  it.each([
    [
      'an unterminated string',
      'resource "aws_sqs_queue" "q" {\n  name = "abc\n  visibility_timeout_seconds = 5\n}\n',
    ],
    [
      'an unterminated heredoc',
      'resource "aws_sqs_queue" "q" {\n  p = <<EOT\nabc\n  visibility_timeout_seconds = 5\n}\n',
    ],
    ['an unterminated block comment', 'resource "aws_sqs_queue" "q" {\n}\n/* never closed\n'],
    [
      'a missing closing brace',
      'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 5\n',
    ],
    ['a mismatched bracket', 'resource "aws_sqs_queue" "q" {\n  x = (1]\n}\n'],
    ['an extra closing brace', 'resource "aws_sqs_queue" "q" {\n}\n}\n'],
    [
      'a top-level assignment',
      'x = 1\nresource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 5\n}\n',
    ],
    [
      'a resource with one label',
      'resource "aws_sqs_queue" {\n  visibility_timeout_seconds = 5\n}\n',
    ],
    [
      'a stray character',
      'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 5 @\n}\n',
    ],
    [
      'an unterminated template',
      'resource "aws_sqs_queue" "q" {\n  n = "a${b"\n  visibility_timeout_seconds = 5\n}\n',
    ],
  ])('%s: the file is not checked and yields no resource', (_n, text) => {
    const r = readTf({
      'bad.tf': text,
      'good.tf': 'resource "aws_lambda_function" "f" {\n  timeout = 4\n}\n',
    });
    expect(r.resources.map((x) => x.type)).toEqual(['aws_lambda_function']);
    expect(r.unchecked).toHaveLength(1);
    expect(r.unchecked[0]?.reasonCode).toBe('terraform-unreadable');
    expect(r.incomplete).toBe(true);
  });

  it('a file over the size limit is not read, and the reader says it is incomplete', () => {
    const r = readTf({ 'big.tf': `# ${'x'.repeat(5_000_001)}\n`, 'ok.tf': sqs('') });
    expect(r.incomplete).toBe(true);
  });
});

describe('strings, heredocs and comments hide nothing and invent nothing', () => {
  it('braces and quotes inside a string do not end the block', () => {
    expect(
      visibility({
        'a.tf': sqs('  note = "} resource \\"x\\" {"\n  visibility_timeout_seconds = 3\n'),
      }),
    ).toBe('3 s @ a.tf:3');
  });

  it('an interpolation with its own strings and braces is skipped whole', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  note = "a ${lookup({ k = "}" }, "k")} b"\n  visibility_timeout_seconds = 3\n',
        ),
      }),
    ).toBe('3 s @ a.tf:3');
  });

  it('a heredoc closes only on its delimiter alone, and an interpolation in it does not close it', () => {
    const text = sqs(
      '  policy = <<-EOT\n    ${ "x" }\n    EOT_NOT\n    EOT\n  visibility_timeout_seconds = 3\n',
    );
    expect(visibility({ 'a.tf': text })).toBe('3 s @ a.tf:6');
  });

  it('a heredoc line that only looks like a closing line inside an interpolation does not close it', () => {
    const text = sqs('  policy = <<EOT\n${\nEOT\n}\nEOT\n  visibility_timeout_seconds = 3\n');
    expect(visibility({ 'a.tf': text })).toBe('3 s @ a.tf:7');
  });

  it('an escaped $${ is text, not a template', () => {
    expect(
      visibility({
        'a.tf': sqs('  note = "$${not_a_template"\n  visibility_timeout_seconds = 3\n'),
      }),
    ).toBe('3 s @ a.tf:3');
  });

  it('unicode in strings and comments is read; a non-ASCII identifier makes the file unreadable', () => {
    expect(
      visibility({ 'a.tf': sqs('  note = "é中文 😀"\n  # ‮\n  visibility_timeout_seconds = 3\n') }),
    ).toBe('3 s @ a.tf:4');
    expect(readTf({ 'a.tf': sqs('  né = 1\n') }).unchecked).toHaveLength(1);
  });

  it('a commented-out resource is not a resource', () => {
    expect(
      readTf({
        'a.tf': '# resource "aws_sqs_queue" "q" {\n#   visibility_timeout_seconds = 5\n# }\n',
      }).resources,
    ).toEqual([]);
  });
});

// Review B5: HCL closes a heredoc when the line, trimmed of white space (Go's TrimSpace), equals the
// marker, for `<<EOT` and `<<-EOT` alike. A close that is not recognised swallows the attributes that follow.
describe('a heredoc closes exactly as HCL closes it', () => {
  const after = (close: string, marker = '<<EOT') =>
    visibility({
      'a.tf': sqs(`  p = ${marker}\n{}\n${close}\n  visibility_timeout_seconds = 10\n`),
    });

  it.each([
    ['an indented close of <<EOT', '  EOT', '<<EOT'],
    ['an indented close of <<-EOT', '    EOT', '<<-EOT'],
    ['a close with trailing spaces', 'EOT   ', '<<EOT'],
    ['a close with trailing spaces after <<-', '  EOT  ', '<<-EOT'],
    ['a close with tabs both sides', '\tEOT\t', '<<EOT'],
    ['a close with a trailing carriage return', 'EOT\r', '<<EOT'],
    ['a close with a no-break space (Go white space)', '\u00a0EOT', '<<EOT'],
  ])('%s', (_n, close, marker) => {
    expect(after(close, marker)).toBe('10 s @ a.tf:5');
  });

  it.each([
    ['text after the marker', 'EOT x'],
    ['a longer word', 'EOTX'],
    ['the marker in another case', 'eot'],
  ])('%s does not close it: the file ends inside the heredoc and is unreadable', (_n, close) => {
    const r = readTf({ 'a.tf': sqs(`  p = <<EOT\n${close}\n  visibility_timeout_seconds = 10\n`) });
    expect(r.resources).toEqual([]);
    expect(r.unchecked).toHaveLength(1);
  });

  it('a byte-order mark is not white space to Go, so it does not close the heredoc', () => {
    const r = readTf({
      'a.tf': sqs('  p = <<EOT\n\ufeffEOT\n  visibility_timeout_seconds = 10\n'),
    });
    expect(r.resources).toEqual([]);
  });

  it('an EOT that an earlier close left unread is not carried into a later heredoc (the reviewer case)', () => {
    const text = [
      'resource "aws_sqs_queue" "q" {',
      '  policy = <<EOF',
      '{}',
      '  EOF',
      '  visibility_timeout_seconds = 10',
      '}',
      'resource "aws_sns_topic" "t" {',
      '  policy = <<EOF',
      '{}',
      'EOF',
      '}',
      '',
    ].join('\n');
    expect(
      show(find(readTf({ 'a.tf': text }), 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds'),
    ).toBe('10 s @ a.tf:5');
  });

  it('after a close, the rest of the closing line is not code: a newline follows', () => {
    expect(
      visibility({ 'a.tf': sqs('  p = <<EOT\nx\nEOT  \r\n  visibility_timeout_seconds = 10\n') }),
    ).toBe('10 s @ a.tf:5');
  });
});

// Review B5 audit: other places where a boundary could differ from HCL's scanner.
describe('line ends and escapes that HCL rejects make the file unreadable, never a different reading', () => {
  it.each([
    ['a lone carriage return in code', sqs('  visibility_timeout_seconds = 5\r  x = 1\n')],
    [
      'a carriage return inside a quoted string',
      sqs('  n = "a\rb"\n  visibility_timeout_seconds = 5\n'),
    ],
    [
      'a backslash before a carriage return',
      sqs('  n = "a\\\r"\n  visibility_timeout_seconds = 5\n'),
    ],
    ['a vertical tab', sqs('  visibility_timeout_seconds =\u000b5\n')],
    ['a form feed', sqs('  visibility_timeout_seconds =\u000c5\n')],
    ['a no-break space in code', sqs('  visibility_timeout_seconds =\u00a05\n')],
    ['a template strip marker', sqs('  n = "${~ x }"\n  visibility_timeout_seconds = 5\n')],
    ['a quote character', sqs("  n = 'x'\n  visibility_timeout_seconds = 5\n")],
  ])('%s', (_n, text) => {
    const r = readTf({ 'a.tf': text });
    expect(r.resources).toEqual([]);
    expect(r.unchecked).toHaveLength(1);
  });

  it('a %{ directive and an escaped %%{ in a string and in a heredoc are skipped like ${', () => {
    const text = sqs(
      '  a = "x %{ if true }y%{ endif } %%{z"\n  p = <<EOT\n%{ if true }\nx\n%{ endif }\nEOT\n  visibility_timeout_seconds = 4\n',
    );
    expect(visibility({ 'a.tf': text })).toBe('4 s @ a.tf:8');
  });

  it('a << inside a string is text, and a comment inside a heredoc is text', () => {
    expect(
      visibility({
        'a.tf': sqs(
          '  a = "<<EOT"\n  p = <<EOT\n# comment\n// comment\n/* x\nEOT\n  visibility_timeout_seconds = 4\n',
        ),
      }),
    ).toBe('4 s @ a.tf:8');
  });

  it('every backslash escape in a string keeps the string open on its line', () => {
    expect(
      visibility({ 'a.tf': sqs('  n = "a\\"b\\\\"\n  visibility_timeout_seconds = 4\n') }),
    ).toMatch(/^(4 s @ a.tf:3|\? )/);
  });
});

describe('duplicate resources and files Terraform ignores', () => {
  it('one address in two files of one folder is declared twice: unresolved in both (m1)', () => {
    const r = readTf({
      'infra/a.tf': sqs('  visibility_timeout_seconds = 600\n'),
      'infra/b.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    expect(r.resources).toHaveLength(2);
    for (const q of r.resources) {
      expect(show(q, 'visibility_timeout_seconds')).toBe(
        '? the same Terraform resource is declared twice',
      );
    }
  });

  it('a .tf and a .tf.json of one folder that declare one address are a duplicate too (m1)', () => {
    const r = readTf({
      'a.tf': sqs('  visibility_timeout_seconds = 600\n'),
      'a.tf.json': '{"resource":{"aws_sqs_queue":{"q":{"visibility_timeout_seconds":5}}}}',
    });
    for (const q of r.resources)
      expect(show(q, 'visibility_timeout_seconds')).toMatch(/^\? .*twice/);
  });

  it('the same name in two folders is two modules, not a duplicate (m1)', () => {
    const r = readTf({
      'a/q.tf': sqs('  visibility_timeout_seconds = 600\n'),
      'b/q.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    expect(r.resources.map((q) => show(q, 'visibility_timeout_seconds')).sort()).toEqual([
      '5 s @ b/q.tf:2',
      '600 s @ a/q.tf:2',
    ]);
  });

  it('Terraform ignores a file whose name starts with a dot, so it is not read, and not reported (m2)', () => {
    const r = readTf({
      '.hidden.tf': 'resource "aws_sqs_queue" "q" {\n  n = "abc\n}\n',
      '.hidden.tf.json': '{"resource": ',
      'ok.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    expect(r.resources).toHaveLength(1);
    expect(r.unchecked).toEqual([]);
    expect(r.incomplete).toBe(false);
  });

  it('a dotfile does not make a duplicate or an override (m2)', () => {
    const r = readTf({
      '.override.tf': sqs('  visibility_timeout_seconds = 1\n'),
      '.copy.tf': sqs('  visibility_timeout_seconds = 2\n'),
      'q.tf': sqs('  visibility_timeout_seconds = 5\n'),
    });
    expect(r.resources.map((q) => show(q, 'visibility_timeout_seconds'))).toEqual(['5 s @ q.tf:2']);
  });
});
