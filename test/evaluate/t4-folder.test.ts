// Folder-scoped Terraform linking (bolt B17, change 1; widened from "the same file" to "the same folder").
// Terraform reads every `.tf` and `.tf.json` file of one directory as ONE module ("Terraform evaluates all of the
// configuration files in a module, effectively treating the entire module as a single document", Terraform
// documentation, Files and configuration structure, read 2026-11-12), and "nested directories are treated as
// completely separate modules". So a reference links within its own folder and never into a subfolder, a parent
// folder, a sibling or a `module` block. Everything that made a value unresolved before still does.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, lineOf, renderChain, ruleOf } from '../support/analyse.js';

afterEach(cleanupTrees);

const queue = (v: string | undefined, name = 'orders') =>
  `resource "aws_sqs_queue" "${name}" {\n${v === undefined ? '' : `  visibility_timeout_seconds = ${v}\n`}}\n`;
const fn = (t: string | undefined, name = 'orders') =>
  `resource "aws_lambda_function" "${name}" {\n${t === undefined ? '' : `  timeout = ${t}\n`}}\n`;
const mapping = (window: string | undefined = '5', q = 'orders', f = 'orders') =>
  [
    'resource "aws_lambda_event_source_mapping" "orders" {',
    `  event_source_arn = aws_sqs_queue.${q}.arn`,
    `  function_name    = aws_lambda_function.${f}.arn`,
    ...(window === undefined ? [] : [`  maximum_batching_window_in_seconds = ${window}`]),
    '}',
    '',
  ].join('\n');

const t4 = (files: Record<string, string>) =>
  ruleOf(analyseFiles(files, { base: {} }).result, 'T4');

describe('a folder is one module', () => {
  it('queue, function and mapping in three files of one folder link, with the file of each value', () => {
    const f = t4({
      'infra/queue.tf': queue('60'),
      'infra/function.tf': fn('30'),
      'infra/mapping.tf': mapping('5'),
    });
    expect(lineOf(f)).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
    expect(renderChain(f)).toEqual([
      'visibility: 60 s @ "infra/queue.tf":2',
      'timeout: 30 s @ "infra/function.tf":2',
      'batching: 5 s @ "infra/mapping.tf":4',
    ]);
  });

  it('the files at the root of the checked folder form one module too', () => {
    const f = t4({ 'queue.tf': queue('190'), 'rest.tf': fn('30') + mapping('5') });
    expect(lineOf(f)).toBe('PASS visibility 190 s covers 185 s');
  });

  it('a .tf.json file and an HCL file of one folder are one module', () => {
    const json = JSON.stringify({
      resource: { aws_sqs_queue: { orders: { visibility_timeout_seconds: 190 } } },
    });
    const f = t4({ 'infra/queue.tf.json': json, 'infra/rest.tf': fn('30') + mapping('5') });
    expect(lineOf(f)).toBe('PASS visibility 190 s covers 185 s');
    const g = t4({
      'infra/queue.tf': queue('190') + fn('30'),
      'infra/map.tf.json': JSON.stringify({
        resource: {
          aws_lambda_event_source_mapping: {
            orders: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: the Terraform JSON reference form
              event_source_arn: '${aws_sqs_queue.orders.arn}',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: the Terraform JSON reference form
              function_name: '${aws_lambda_function.orders.arn}',
              maximum_batching_window_in_seconds: 5,
            },
          },
        },
      }),
    });
    expect(lineOf(g)).toBe('PASS visibility 190 s covers 185 s');
  });

  it('the same names in two folders are two modules, each linking its own', () => {
    const r = analyseFiles(
      {
        'a/q.tf': queue('60'),
        'a/rest.tf': fn('30') + mapping('5'),
        'b/q.tf': queue('9999'),
        'b/rest.tf': fn('30') + mapping('5'),
      },
      { base: {} },
    ).result;
    expect(r.results.map((x) => x.findings[0]?.kind).sort()).toEqual(['FAIL', 'PASS']);
  });
});

describe('a folder never links into another folder (a module is a directory)', () => {
  it.each([
    ['a subfolder', { 'main.tf': fn('30') + mapping('5'), 'modules/q/queue.tf': queue('600') }],
    ['the parent folder', { 'queue.tf': queue('600'), 'sub/main.tf': fn('30') + mapping('5') }],
    ['a sibling folder', { 'a/queue.tf': queue('600'), 'b/main.tf': fn('30') + mapping('5') }],
  ])('the queue in %s is not linked', (_n, files) => {
    const f = t4(files);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/the aws_sqs_queue the mapping names is not in the same folder/);
    expect(f.declare?.join(' ')).toContain('in the same folder');
  });

  it('the function in a subfolder is not linked either', () => {
    const f = t4({ 'queue.tf': queue('600') + mapping('5'), 'fn/f.tf': fn('30') });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/aws_lambda_function the mapping names is not in the same folder/);
  });

  it('a decoy of the same name in a subfolder changes nothing', () => {
    const f = t4({
      'queue.tf': queue('60'),
      'rest.tf': fn('30') + mapping('5'),
      'decoy/queue.tf': queue('43200'),
    });
    expect(lineOf(f)).toBe('FAIL visibility 60 s is less than 6 x 30 s + 5 s = 185 s');
  });
});

describe('what made a value unresolved still does', () => {
  it('a duplicate address across two files of the folder: Terraform rejects it, so neither is trusted', () => {
    const f = t4({
      'q1.tf': queue('60'),
      'q2.tf': queue('43200'),
      'rest.tf': fn('30') + mapping('5'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/visibility timeout not established/);
  });

  it('a duplicate between a .tf and a .tf.json file of the folder is rejected too', () => {
    const f = t4({
      'q.tf': queue('60'),
      'q.tf.json': JSON.stringify({
        resource: { aws_sqs_queue: { orders: { visibility_timeout_seconds: 43_200 } } },
      }),
      'rest.tf': fn('30') + mapping('5'),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('a variable, a local and a function in the other file give UNRESOLVED, never FAIL', () => {
    for (const v of ['var.v', 'local.v', 'max(1, 2)', '"60"']) {
      const f = t4({ 'q.tf': queue(v), 'rest.tf': fn('30') + mapping('5') });
      expect(f.kind, v).toBe('UNRESOLVED');
    }
  });

  it('count and for_each on a resource of another file', () => {
    for (const meta of ['count = 2', 'for_each = var.x']) {
      const f = t4({
        'q.tf': `resource "aws_sqs_queue" "orders" {\n  ${meta}\n  visibility_timeout_seconds = 60\n}\n`,
        'rest.tf': fn('30') + mapping('5'),
      });
      expect(f.kind, meta).toBe('UNRESOLVED');
    }
  });

  it('a dynamic block and an unread lifecycle setting on a resource of another file', () => {
    const f = t4({
      'q.tf':
        'resource "aws_sqs_queue" "orders" {\n  visibility_timeout_seconds = 60\n  lifecycle {\n    ignore_changes = all\n  }\n}\n',
      'rest.tf': fn('30') + mapping('5'),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('an unreadable file in the folder: a queue not found is reported as possibly there, never as absent', () => {
    const f = t4({
      'rest.tf': fn('30') + mapping('5'),
      'bad.tf': 'resource "aws_sqs_queue" "orders" {\n  x = "abc\n}\n',
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/a file of the same folder was not read/);
    expect(f.headline).not.toMatch(/is not in the same folder/);
  });

  it('an unreadable file in another folder does not change the reason', () => {
    const f = t4({
      'a/rest.tf': fn('30') + mapping('5'),
      'b/bad.tf': 'resource "aws_sqs_queue" "orders" {\n  x = "abc\n}\n',
    });
    expect(f.headline).toMatch(/is not in the same folder/);
  });
});

describe('override files merge into the module (Terraform: Override files)', () => {
  // "Terraform normally loads all of the .tf and .tf.json files within a directory ... For these rare situations,
  // Terraform has special handling of any configuration file whose name ends in _override.tf or _override.tf.json.
  // This special handling also applies to a file named literally override.tf or override.tf.json ... a top-level
  // block in an override file merges with a block in a normal configuration file that has the same block header ...
  // an attribute argument within an override block replaces any argument of the same name." (read 2026-11-12)
  it.each(['override.tf', 'prod_override.tf', 'override.tf.json', 'x_override.tf.json'])(
    'a resource that %s names, in another file of the folder, is unresolved',
    (name) => {
      const body = name.endsWith('.json')
        ? JSON.stringify({
            resource: { aws_sqs_queue: { orders: { visibility_timeout_seconds: 5 } } },
          })
        : queue('5');
      const f = t4({
        'queue.tf': queue('600'),
        'rest.tf': fn('30') + mapping('5'),
        [name]: body,
      });
      expect(f.kind).toBe('UNRESOLVED');
      expect(f.headline).toMatch(/an override file changes this resource/);
    },
  );

  it('an override of the function makes the timeout unresolved, the queue is still read', () => {
    const f = t4({
      'queue.tf': queue('190'),
      'fn.tf': fn('30'),
      'rest.tf': mapping('5'),
      'override.tf': fn('900'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(/timeout not established: .*override/);
  });

  it('an override of the mapping makes the whole mapping unresolved', () => {
    const f = t4({
      'q.tf': queue('190'),
      'fn.tf': fn('30'),
      'rest.tf': mapping('5'),
      'override.tf': mapping('300'),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('an override of another resource of the folder changes nothing here', () => {
    const f = t4({
      'q.tf': queue('190'),
      'fn.tf': fn('30'),
      'rest.tf': mapping('5'),
      'override.tf': queue('5', 'other'),
    });
    expect(lineOf(f)).toBe('PASS visibility 190 s covers 185 s');
  });

  it('an override file in another folder changes nothing here', () => {
    const f = t4({
      'a/q.tf': queue('190'),
      'a/rest.tf': fn('30') + mapping('5'),
      'b/override.tf': queue('5'),
    });
    expect(lineOf(f)).toBe('PASS visibility 190 s covers 185 s');
  });

  it('an override file that cannot be read makes every resource of its folder unresolved', () => {
    const f = t4({
      'q.tf': queue('190'),
      'rest.tf': fn('30') + mapping('5'),
      'override.tf': 'resource "aws_sqs_queue" "orders" {\n  x = "abc\n}\n',
    });
    expect(f.kind).toBe('UNRESOLVED');
  });
});

describe('the sources stay in the report', () => {
  it('a cross-file result names each file in the chain, and the mapping block names its own file', () => {
    const r = analyseFiles(
      { 'infra/queue.tf': queue('60'), 'infra/rest.tf': fn('30') + mapping('5') },
      { base: {} },
    ).result;
    expect(r.results[0]?.file).toMatchObject({ type: 'file', line: 4 });
  });
});
