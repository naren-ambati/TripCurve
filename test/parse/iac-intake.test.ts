// Terraform at the file boundary (bolt B5): which files reach the reader, and how an unreadable one is
// worded. Plus linking and the whole analysis scale with the number of resources.
import { describe, expect, it } from 'vitest';
import { analyse } from '../../src/analyse.js';
import {
  classifyShowJson,
  intake,
  isOverrideName,
  uncheckedReasonWords,
} from '../../src/parse/index.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree } from '../support/tmp-tree.js';

describe('classification', () => {
  it('*.tf.json is read as JSON with positions (documents), *.tf as text', () => {
    const t = makeTree();
    try {
      t.write('a.tf.json', '{\n  "resource": {}\n}\n');
      t.write('b.tf', 'resource "aws_lb" "x" {}\n');
      const r = intake({ root: t.root });
      const json = r.files.find((f) => f.class === 'terraform-json');
      expect(json?.documents).toHaveLength(1);
      expect(r.files.find((f) => f.class === 'terraform')?.documents).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it('a .json file is sniffed for terraform show output only when it is the one file named as the root', () => {
    const t = makeTree();
    try {
      const text = '{"format_version":"1.2","planned_values":{}}';
      const path = t.write('out/plan.json', text);
      t.write('lock/other.json', text);
      expect(intake({ root: path }).files.map((f) => f.class)).toEqual(['terraform-json']);
      expect(intake({ root: t.root }).files).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('the sniff wants format_version and one of the plan or state keys, and ignores other JSON', () => {
    expect(classifyShowJson('{"format_version":"1","values":{}}')).toBe('terraform-json');
    expect(classifyShowJson('{"format_version":"1","configuration":{}}')).toBe('terraform-json');
    expect(classifyShowJson('{"name":"x","version":"1"}')).toBeUndefined();
    expect(classifyShowJson('{"values":{}}')).toBeUndefined();
  });

  it('the .terraform folder is not walked, like node_modules', () => {
    const t = makeTree();
    try {
      t.write('.terraform/modules/m/main.tf', 'resource "aws_lb" "x" {}\n');
      t.write('main.tf', 'resource "aws_lb" "y" {}\n');
      expect(intake({ root: t.root }).files.map((f) => f.class)).toEqual(['terraform']);
    } finally {
      t.cleanup();
    }
  });

  it('a Terraform JSON file that does not parse is reported, like any YAML-class file', () => {
    const t = makeTree();
    try {
      t.write('a.tf.json', '{"resource": ');
      expect(intake({ root: t.root }).unchecked.map((u) => u.reasonCode)).toEqual([
        'json-parse-error',
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('override file names', () => {
    for (const n of ['override.tf', 'override.tf.json', 'a_override.tf', 'x_override.tf.json']) {
      expect(isOverrideName(n), n).toBe(true);
    }
    for (const n of [
      'overrides.tf',
      'main.tf',
      'override.txt',
      'xoverride.tf',
      'override.tf.bak',
    ]) {
      expect(isOverrideName(n), n).toBe(false);
    }
  });

  it('the unreadable-Terraform reason has fixed words', () => {
    expect(uncheckedReasonWords('terraform-unreadable')).toBe(
      'Terraform syntax that tripcurve does not read',
    );
  });
});

describe('the whole analysis scales linearly with the number of mappings', () => {
  const ratio = (make: (n: number) => string): number =>
    scalingRatio((n) => {
      const t = makeTree();
      try {
        t.write('a.tf', make(n));
        analyse(intake({ root: t.root }));
      } finally {
        t.cleanup();
      }
    }, 300);

  it(
    'each mapping names its queue and function (linking by name must not rescan)',
    () => {
      expect(
        ratio((n) =>
          Array.from(
            { length: n },
            (_v, i) =>
              `resource "aws_sqs_queue" "q${i}" {\n  visibility_timeout_seconds = 100\n}\nresource "aws_lambda_function" "f${i}" {\n  timeout = 3\n}\nresource "aws_lambda_event_source_mapping" "m${i}" {\n  event_source_arn = aws_sqs_queue.q${i}.arn\n  function_name = aws_lambda_function.f${i}.arn\n  maximum_batching_window_in_seconds = 0\n}\n`,
          ).join(''),
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'many load balancers with the same shape',
    () => {
      expect(
        ratio((n) =>
          Array.from(
            { length: n },
            (_v, i) => `resource "aws_lb" "l${i}" {\n  name = "lb-${i}"\n}\n`,
          ).join(''),
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});
