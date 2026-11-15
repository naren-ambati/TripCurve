// The built command on Terraform input (bolt B5): `terraform show -json` on standard input and as a file,
// a `*.tf.json` file, a hostile tree, and the files the reader cannot read.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { makeTree } from '../support/tmp-tree.js';

const plan = (visibility: number) => ({
  format_version: '1.2',
  terraform_version: '1.9.0',
  planned_values: {
    root_module: {
      resources: [
        {
          address: 'aws_sqs_queue.orders',
          mode: 'managed',
          type: 'aws_sqs_queue',
          name: 'orders',
          values: { visibility_timeout_seconds: visibility },
        },
        {
          address: 'aws_lambda_function.orders',
          mode: 'managed',
          type: 'aws_lambda_function',
          name: 'orders',
          values: { timeout: 30 },
        },
        {
          address: 'aws_lambda_event_source_mapping.orders',
          mode: 'managed',
          type: 'aws_lambda_event_source_mapping',
          name: 'orders',
          values: { maximum_batching_window_in_seconds: 5 },
        },
      ],
    },
  },
  configuration: {
    root_module: {
      resources: [
        {
          address: 'aws_lambda_event_source_mapping.orders',
          expressions: {
            event_source_arn: { references: ['aws_sqs_queue.orders.arn', 'aws_sqs_queue.orders'] },
            function_name: {
              references: ['aws_lambda_function.orders.arn', 'aws_lambda_function.orders'],
            },
          },
        },
      ],
    },
  },
});

describe('terraform show -json on standard input', () => {
  it('prints the T4 FAIL with a stream source, and exits 1', () => {
    const run = runBuilt(['-'], { input: JSON.stringify(plan(60)) });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(1);
    expect(run.stdout).toBe(
      [
        'tripcurve 0.1.1   checked <stdin>   1 stream, 1 document read',
        '',
        'Workload "orders" (event source mapping) in <stdin> document 1',
        '  FAIL T4  visibility 60 s is less than 6 x 30 s + 5 s = 185 s',
        '           visibility 60 s  <stdin> document 1, line 1',
        '           timeout 30 s     <stdin> document 1, line 1',
        '           batching 5 s     <stdin> document 1, line 1',
        '',
        'Assumptions',
        '  - Green never means zero-downtime: the SIGTERM race and the deregistration',
        '    delay are outside these rules.',
        '',
        'Summary: 1 failed; not a clean result',
        '',
      ].join('\n'),
    );
  });

  it('a passing plan exits 0', () => {
    const run = runBuilt(['-'], { input: JSON.stringify(plan(190)) });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'PASS T4  visibility 190 s covers 185 s (<stdin> document 1, line 1)',
    );
  });
});

describe('files on the command line', () => {
  it('a plan file named as the path', () => {
    const t = makeTree();
    try {
      const path = t.write('plan.json', `${JSON.stringify(plan(190), null, 2)}\n`);
      const run = runBuilt([path]);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('Workload "orders" (event source mapping) in "plan.json"');
    } finally {
      t.cleanup();
    }
  });

  it('a *.tf.json file in a tree, and a Terraform file that cannot be read beside it', () => {
    const t = makeTree();
    try {
      t.write(
        'infra/queue.tf.json',
        JSON.stringify({
          resource: {
            aws_sqs_queue: { q: { visibility_timeout_seconds: 190 } },
            aws_lambda_function: { f: { timeout: 30 } },
            aws_lambda_event_source_mapping: {
              orders: {
                event_source_arn: '${aws_sqs_queue.q.arn}',
                function_name: '${aws_lambda_function.f.arn}',
                maximum_batching_window_in_seconds: 5,
              },
            },
          },
        }),
      );
      const clean = runBuilt(['.'], { cwd: t.root });
      expect(clean.status).toBe(0);
      expect(clean.stdout).toContain(
        'PASS T4  visibility 190 s covers 185 s ("infra/queue.tf.json":1)',
      );
      t.write('infra/bad.tf', 'resource "aws_sqs_queue" "q" {\n  n = "abc\n}\n');
      const run = runBuilt(['.'], { cwd: t.root });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('Files not checked');
      expect(run.stdout).not.toContain('All checks passed');
      expect(run.stderr).toBe('');
    } finally {
      t.cleanup();
    }
  });

  it('a hostile tree of Terraform never crashes the command and never prints PASS', () => {
    const t = makeTree();
    try {
      t.write('a.tf', '{'.repeat(2_000_000));
      t.write('b.tf', '"${'.repeat(500_000));
      t.write('c.tf.json', '{"resource": ');
      t.write(
        'd.tf',
        `resource "aws_lambda_event_source_mapping" "m" {\n  event_source_arn = ${'('.repeat(100_000)}\n}\n`,
      );
      const run = runBuilt(['.'], { cwd: t.root });
      expect(run.status).toBe(2); // nothing was checked
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('Files not checked');
      expect(run.stdout).not.toContain('PASS');
      expect(run.stdout).not.toContain('All checks passed');
    } finally {
      t.cleanup();
    }
  });

  it('the .terraform folder is never read', () => {
    const t = makeTree();
    try {
      t.write(
        join('.terraform', 'modules', 'm', 'main.tf'),
        'resource "aws_sqs_queue" "q" {}\nresource "aws_lambda_event_source_mapping" "m" {}\n',
      );
      const run = runBuilt(['.'], { cwd: t.root });
      expect(run.stdout).toContain('No Kubernetes, server or Terraform files found');
    } finally {
      t.cleanup();
    }
  });
});
