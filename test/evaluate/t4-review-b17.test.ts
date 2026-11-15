// B17 review findings. (1) A root that is one Terraform file does not read the rest of its module: no result may rest
// on a value of that module (a sibling override could change it either way), so every result is UNRESOLVED, a FAIL
// included. (2) The PASS-grade guard of the window-free FAIL. (3) The refusal text of a numeric attribute.
import { afterEach, describe, expect, it } from 'vitest';
import { analyse } from '../../src/analyse.js';
import { loadKnowledgeBase } from '../../src/kb/index.js';
import { intake } from '../../src/parse/index.js';
import { analyseFiles, cleanupTrees, ruleOf } from '../support/analyse.js';
import { find, readTf, registerTfCleanup, show } from '../support/terraform.js';
import { makeTree } from '../support/tmp-tree.js';

afterEach(cleanupTrees);
registerTfCleanup();

const all = (v: string, w = '5') =>
  [
    'resource "aws_sqs_queue" "q" {',
    `  visibility_timeout_seconds = ${v}`,
    '}',
    'resource "aws_lambda_function" "f" {',
    '  timeout = 30',
    '}',
    'resource "aws_lambda_event_source_mapping" "m" {',
    '  event_source_arn = aws_sqs_queue.q.arn',
    '  function_name    = aws_lambda_function.f.arn',
    `  maximum_batching_window_in_seconds = ${w}`,
    '}',
    '',
  ].join('\n');

function t4For(files: Record<string, string>, root: string) {
  const t = makeTree();
  try {
    for (const [p, x] of Object.entries(files)) t.write(p, x);
    return ruleOf(analyse(intake({ root: `${t.root}/${root}` })), 'T4');
  } finally {
    t.cleanup();
  }
}

describe('a root that is one Terraform file (review minor 1)', () => {
  const sibling = {
    'cases/e/override.tf': 'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 1\n}\n',
  };

  it('is UNRESOLVED with a fixed reason where the folder gives PASS, and the folder with the override is UNRESOLVED', () => {
    const files = { 'cases/e/all.tf': all('190') };
    expect(t4For(files, 'cases/e').kind).toBe('PASS');
    const f = t4For({ ...files, ...sibling }, 'cases/e/all.tf');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('only one file of the module was given; check the folder');
    expect(t4For({ ...files, ...sibling }, 'cases/e').kind).toBe('UNRESOLVED');
  });

  it('even without a sibling file: one file is never PASS', () => {
    expect(t4For({ 'cases/e/all.tf': all('190') }, 'cases/e/all.tf').kind).toBe('UNRESOLVED');
  });

  it('a FAIL does not stand either: a sibling override could raise the visibility', () => {
    const f = t4For({ 'cases/e/all.tf': all('60') }, 'cases/e/all.tf');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('only one file of the module was given');
    const g = t4For({ 'cases/e/all.tf': all('60', '5') }, 'cases/e');
    expect(g.kind).toBe('FAIL');
  });

  it('a Terraform file inside a tree walk is still a whole folder', () => {
    expect(ruleOf(analyseFiles({ 'a.tf': all('190') }, { base: {} }).result, 'T4').kind).toBe(
      'PASS',
    );
  });
});

describe('the window-free FAIL needs PASS-grade visibility and timeout (review minor 2)', () => {
  const kbWith = (basis: 'to-be-measured' | 'documented', subject: string) =>
    loadKnowledgeBase([
      {
        schemaVersion: 1,
        entries: [
          {
            id: `${subject}-x`,
            subject,
            value: subject === 'terraform-sqs-visibility' ? 30 : 3,
            unit: 's',
            applies: { runtime: 'terraform', versionRange: '*' },
            citationName: 'test',
            rangeLabel: 'test',
            docUrl: 'https://example.test/x',
            docDate: '2026-11-12',
            basis,
            ...(basis === 'to-be-measured'
              ? { scriptRef: 'measure/x.mjs', toleranceMs: 4 }
              : { scriptRef: { notMeasurableLocally: 'a cloud service' } }),
          },
        ],
      },
    ]);
  const mapping =
    'resource "aws_sqs_queue" "q" {\n}\nresource "aws_lambda_function" "f" {\n  timeout = 30\n}\n' +
    'resource "aws_lambda_event_source_mapping" "m" {\n  event_source_arn = aws_sqs_queue.q.arn\n  function_name = aws_lambda_function.f.arn\n}\n';

  it('a to-be-measured default visibility (30 s < 6 x 30 s, no window) is UNRESOLVED, never FAIL', () => {
    // expected: UNRESOLVED, because the visibility is a placeholder; with a documented default it IS a FAIL
    const placeholder = ruleOf(
      analyseFiles(
        { 'a.tf': mapping },
        { base: {}, kb: kbWith('to-be-measured', 'terraform-sqs-visibility') },
      ).result,
      'T4',
    );
    expect(placeholder.kind).toBe('UNRESOLVED');
    expect(placeholder.headline).not.toMatch(/less than/);
    const documented = ruleOf(
      analyseFiles(
        { 'a.tf': mapping },
        { base: {}, kb: kbWith('documented', 'terraform-sqs-visibility') },
      ).result,
      'T4',
    );
    expect(documented.kind).toBe('FAIL');
  });

  it('a to-be-measured default timeout (literal visibility 5 s < 6 x 3 s, no window) is UNRESOLVED, never FAIL', () => {
    const text = mapping
      .replace(
        'resource "aws_sqs_queue" "q" {\n}',
        'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = 5\n}',
      )
      .replace('  timeout = 30\n', '');
    const kb = kbWith('to-be-measured', 'terraform-lambda-timeout');
    const f = ruleOf(analyseFiles({ 'a.tf': text }, { base: {}, kb }).result, 'T4');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).not.toMatch(/less than/);
    const ok = ruleOf(
      analyseFiles(
        { 'a.tf': text },
        { base: {}, kb: kbWith('documented', 'terraform-lambda-timeout') },
      ).result,
      'T4',
    );
    expect(ok.kind).toBe('FAIL');
  });
});

describe('the refusal text of a numeric attribute (review info)', () => {
  it('no longer says an expression is never read', () => {
    const r = readTf({
      'a.tf': 'resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = var.v\n}\n',
    });
    const text = show(find(r, 'aws_sqs_queue', 'q'), 'visibility_timeout_seconds');
    expect(text).toBe(
      '? visibility_timeout_seconds is not a whole number written as a literal (a variable, a function, an expression with anything but integer literals, or another form)',
    );
  });
});
