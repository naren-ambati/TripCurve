// Terraform JSON: `*.tf.json`, and `terraform show -json` as a file or on stdin.
import { describe, expect, it } from 'vitest';
import { intake, readIac } from '../../src/parse/index.js';
import { txt } from '../support/render.js';
import { find, readTf, readTfStdin, registerTfCleanup, show } from '../support/terraform.js';
import { makeTree } from '../support/tmp-tree.js';

registerTfCleanup();

const pretty = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

describe('*.tf.json (the JSON syntax of Terraform)', () => {
  const doc = {
    resource: {
      aws_sqs_queue: { q: { name: 'q', visibility_timeout_seconds: 60 } },
      aws_lambda_function: { f: { timeout: 30 } },
      aws_lambda_event_source_mapping: {
        m: {
          event_source_arn: '${aws_sqs_queue.q.arn}',
          function_name: '${aws_lambda_function.f.arn}',
          maximum_batching_window_in_seconds: 5,
        },
      },
      aws_lb: { main: { name: 'main-alb', idle_timeout: 120 } },
    },
  };

  it('reads the same attributes as HCL, with lines', () => {
    const r = readTf({ 'infra/x.tf.json': pretty(doc) });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe(
      '60 s @ infra/x.tf.json:6',
    );
    expect(show(find(r, 'aws_lambda_function', 'f'), 'timeout')).toMatch(
      /^30 s @ infra\/x.tf.json:\d+$/,
    );
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'event_source_arn')).toMatch(
      /^ref aws_sqs_queue.q @ infra\/x.tf.json:\d+$/,
    );
    expect(show(find(r, 'aws_lb', 'main'), 'idle_timeout')).toMatch(/^120 s @/);
    expect(show(find(r, 'aws_lb', 'main'), 'name')).toMatch(/^"main-alb" @/);
    expect(r.unchecked).toEqual([]);
  });

  it('reads the array-of-objects form', () => {
    const r = readTf({
      'a.tf.json': pretty({
        resource: [{ aws_sqs_queue: [{ q: [{ visibility_timeout_seconds: 8 }] }] }],
      }),
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(
      /^8 s @ a.tf.json:\d+$/,
    );
  });

  it.each([
    ['a string number', { visibility_timeout_seconds: '60' }],
    ['a template', { visibility_timeout_seconds: '${var.t}' }],
    ['null', { visibility_timeout_seconds: null }],
    ['a fraction', { visibility_timeout_seconds: 6.5 }],
    ['out of range', { visibility_timeout_seconds: 99999 }],
    ['count', { visibility_timeout_seconds: 60, count: 2 }],
    ['for_each', { visibility_timeout_seconds: 60, for_each: {} }],
    ['a dynamic block', { visibility_timeout_seconds: 60, dynamic: { x: {} } }],
    ['ignore_changes', { visibility_timeout_seconds: 60, lifecycle: { ignore_changes: ['x'] } }],
  ])('%s is unresolved', (_n, body) => {
    const r = readTf({ 'a.tf.json': pretty({ resource: { aws_sqs_queue: { q: body } } }) });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(/^\? /);
  });

  it('an attribute written twice in the array form is unresolved', () => {
    const r = readTf({
      'a.tf.json': pretty({
        resource: {
          aws_sqs_queue: {
            q: [{ visibility_timeout_seconds: 5 }, { visibility_timeout_seconds: 6 }],
          },
        },
      }),
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(
      /^\? .*more than once/,
    );
  });

  it('an absent attribute is absent', () => {
    const r = readTf({
      'a.tf.json': pretty({ resource: { aws_sqs_queue: { q: { name: 'q' } } } }),
    });
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe('absent');
  });

  it('a file that is not JSON is not checked and makes the read incomplete', () => {
    const r = readTf({ 'a.tf.json': '{ "resource": ', 'b.tf.json': pretty(doc) });
    expect(r.incomplete).toBe(true);
    expect(r.resources.length).toBeGreaterThan(0);
  });

  it('a file of another shape yields nothing and does not crash', () => {
    for (const text of [
      '{}',
      '[]',
      '3',
      'null',
      '"x"',
      '{"resource": 5}',
      '{"resource": {"aws_sqs_queue": 3}}',
    ]) {
      expect(() => readTf({ 'a.tf.json': text })).not.toThrow();
    }
  });
});

describe('terraform show -json', () => {
  const plan = {
    format_version: '1.2',
    terraform_version: '1.9.0',
    planned_values: {
      root_module: {
        resources: [
          {
            address: 'aws_sqs_queue.q',
            mode: 'managed',
            type: 'aws_sqs_queue',
            name: 'q',
            values: { visibility_timeout_seconds: 60 },
          },
          {
            address: 'aws_lambda_function.f',
            mode: 'managed',
            type: 'aws_lambda_function',
            name: 'f',
            values: { timeout: 30 },
          },
          {
            address: 'aws_lambda_event_source_mapping.m',
            mode: 'managed',
            type: 'aws_lambda_event_source_mapping',
            name: 'm',
            values: { maximum_batching_window_in_seconds: 5 },
          },
        ],
      },
    },
    configuration: {
      root_module: {
        resources: [
          {
            address: 'aws_lambda_event_source_mapping.m',
            expressions: {
              event_source_arn: { references: ['aws_sqs_queue.q.arn', 'aws_sqs_queue.q'] },
              function_name: { references: ['aws_lambda_function.f.arn', 'aws_lambda_function.f'] },
            },
          },
        ],
      },
    },
  };

  it('on stdin: values from the plan with the stream line, references from the configuration', () => {
    const r = readTfStdin(pretty(plan));
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toMatch(
      /^60 s @ <stdin> document 1, line \d+$/,
    );
    expect(show(find(r, 'aws_lambda_function', 'f'), 'timeout')).toMatch(/^30 s @ <stdin>/);
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'event_source_arn')).toMatch(
      /^ref aws_sqs_queue.q @ <stdin>/,
    );
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'function_name')).toMatch(
      /^ref aws_lambda_function.f @ <stdin>/,
    );
  });

  it('a minified plan on one line has line 1 everywhere', () => {
    const r = readTfStdin(JSON.stringify(plan));
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe(
      '60 s @ <stdin> document 1, line 1',
    );
  });

  it('a value missing from the plan is unresolved, never a default', () => {
    const r = readTfStdin(
      pretty({
        ...plan,
        planned_values: {
          root_module: {
            resources: [
              {
                address: 'aws_sqs_queue.q',
                mode: 'managed',
                type: 'aws_sqs_queue',
                name: 'q',
                values: {},
              },
            ],
          },
        },
      }),
    );
    expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe(
      '? visibility_timeout_seconds is not a known value in the plan or state',
    );
  });

  it('a state (no configuration) holds no references: the mapping is not linked', () => {
    const { configuration: _c, ...state } = plan;
    const r = readTfStdin(pretty(state));
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'event_source_arn')).toMatch(
      /^\? /,
    );
  });

  it.each([
    ['one extra reference', ['aws_sqs_queue.q.arn', 'var.x']],
    ['two different resources', ['aws_sqs_queue.q.arn', 'aws_sqs_queue.other']],
    ['a stream', ['aws_kinesis_stream.s.arn', 'aws_kinesis_stream.s']],
    ['no references', []],
    ['three references', ['aws_sqs_queue.q.arn', 'aws_sqs_queue.q', 'aws_sqs_queue.q']],
  ])('references of %s are not a link', (_n, references) => {
    const copy = structuredClone(plan);
    (
      copy.configuration.root_module.resources[0] as {
        expressions: { event_source_arn: { references: string[] } };
      }
    ).expressions.event_source_arn.references = references;
    const r = readTfStdin(pretty(copy));
    expect(show(find(r, 'aws_lambda_event_source_mapping', 'm'), 'event_source_arn')).toMatch(
      /^\? /,
    );
  });

  it('a resource with an index (count or for_each) is unresolved; data sources and child modules are not read', () => {
    const copy = structuredClone(plan) as typeof plan & {
      planned_values: { root_module: { resources: unknown[]; child_modules?: unknown[] } };
    };
    copy.planned_values.root_module.resources.push({
      address: 'aws_sqs_queue.i[0]',
      mode: 'managed',
      type: 'aws_sqs_queue',
      name: 'i',
      index: 0,
      values: { visibility_timeout_seconds: 5 },
    });
    copy.planned_values.root_module.resources.push({
      address: 'data.aws_sqs_queue.d',
      mode: 'data',
      type: 'aws_sqs_queue',
      name: 'd',
      values: { visibility_timeout_seconds: 5 },
    });
    copy.planned_values.root_module.child_modules = [
      { resources: [{ mode: 'managed', type: 'aws_sqs_queue', name: 'c', values: {} }] },
    ];
    const r = readTfStdin(pretty(copy));
    expect(show(find(r, 'aws_sqs_queue', 'i'), 'visibility_timeout_seconds')).toMatch(
      /^\? .*count/,
    );
    expect(
      r.resources
        .filter((x) => x.type === 'aws_sqs_queue')
        .map((x) => txt(x.name))
        .sort(),
    ).toEqual(['i', 'q']);
  });

  it('as a file named on the command line, in any name ending .json', () => {
    const t = makeTree();
    try {
      const path = t.write('plan.json', pretty(plan));
      const r = readIac(intake({ root: path }));
      expect(show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds')).toBe(
        `60 s @ plan.json:${
          pretty(plan)
            .split('\n')
            .findIndex((l) => l.includes('visibility_timeout_seconds')) + 1
        }`,
      );
    } finally {
      t.cleanup();
    }
  });

  it('a .json file met while walking a tree is not sniffed (a lock file is never read for it)', () => {
    const r = readTf({
      'plan.json': pretty(plan),
      'x.tf': 'resource "aws_lambda_function" "f" {\n}\n',
    });
    expect(r.resources.map((x) => x.type)).toEqual(['aws_lambda_function']);
  });

  it('stdin that is not a plan, or not JSON, reads nothing and does not crash', () => {
    for (const text of [
      '',
      'not: json: at: all: [',
      '{"format_version": 3}',
      'apiVersion: v1\nkind: Pod\n',
    ]) {
      expect(readTfStdin(text).resources).toEqual([]);
    }
  });
});
