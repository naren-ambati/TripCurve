// T4 property tests: the rule is the arithmetic and nothing else, whatever mixture of literal,
// default, assumed and unresolved inputs the files give. The oracle below is written separately from the rule:
//   - visibility or timeout unresolved                   -> UNRESOLVED
//   - else the window not established (absent, a variable, out of range):
//       visibility < 6 x timeout                         -> FAIL (B17: a window only raises the need, window >= 0)
//       otherwise                                        -> UNRESOLVED (only PASS needs the window)
//   - else visibility >= 6 x timeout + window            -> PASS, otherwise FAIL
// with the documented defaults 30 s (visibility) and 3 s (timeout) when those are not written.
import { afterEach, describe, expect, it } from 'vitest';
import { analyse } from '../../src/analyse.js';
import { intakeStreamBytes } from '../../src/parse/index.js';
import { analyseFiles, cleanupTrees, ruleOf } from '../support/analyse.js';
import { makeRng, type Rng } from '../support/prng.js';

afterEach(cleanupTrees);

type Input =
  | { kind: 'literal'; n: number }
  | { kind: 'absent' }
  | { kind: 'variable' }
  | { kind: 'range' };

function pick(rng: Rng, lo: number, hi: number): Input {
  const r = rng.next();
  if (r < 0.62) return { kind: 'literal', n: rng.int(lo, hi) };
  if (r < 0.77) return { kind: 'absent' };
  if (r < 0.9) return { kind: 'variable' };
  return { kind: 'range' };
}

function text(i: Input, name: string, outOfRange: number): string {
  switch (i.kind) {
    case 'literal':
      return `  ${name} = ${i.n}\n`;
    case 'absent':
      return '';
    case 'variable':
      return `  ${name} = var.x\n`;
    case 'range':
      return `  ${name} = ${outOfRange}\n`;
  }
}

function expected(v: Input, t: Input, w: Input): 'PASS' | 'FAIL' | 'UNRESOLVED' {
  if ([v, t].some((x) => x.kind === 'variable' || x.kind === 'range')) return 'UNRESOLVED';
  const vis = v.kind === 'literal' ? v.n : 30;
  const to = t.kind === 'literal' ? t.n : 3;
  if (w.kind !== 'literal') return vis < 6 * to ? 'FAIL' : 'UNRESOLVED';
  return vis >= 6 * to + w.n ? 'PASS' : 'FAIL';
}

function files(v: Input, t: Input, w: Input): string {
  return [
    `resource "aws_sqs_queue" "q" {\n${text(v, 'visibility_timeout_seconds', 43_201)}}\n`,
    `resource "aws_lambda_function" "f" {\n${text(t, 'timeout', 901)}}\n`,
    'resource "aws_lambda_event_source_mapping" "m" {\n  event_source_arn = aws_sqs_queue.q.arn\n  function_name = aws_lambda_function.f.arn\n' +
      text(w, 'maximum_batching_window_in_seconds', 301) +
      '}\n',
  ].join('');
}

describe('T4 over Terraform source: 400 seeded mixtures', () => {
  it('matches the oracle, and reaches every outcome', () => {
    const rng = makeRng(20261112);
    const seen = { PASS: 0, FAIL: 0, UNRESOLVED: 0 };
    let failsWithoutWindow = 0;
    for (let n = 0; n < 400; n += 1) {
      // keep the numbers where PASS and FAIL are both common
      const v = pick(rng, 0, 600);
      const t = pick(rng, 1, 60);
      const w = pick(rng, 0, 60);
      const f = ruleOf(analyseFiles({ 'a.tf': files(v, t, w) }, { base: {} }).result, 'T4');
      const want = expected(v, t, w);
      const where = `case ${n}: ${JSON.stringify([v, t, w])}`;
      expect(f.kind, where).toBe(want);
      seen[want] += 1;
      if (want === 'FAIL' && w.kind !== 'literal') failsWithoutWindow += 1;
      // a PASS or FAIL rests on verified values only
      if (f.kind === 'PASS' || f.kind === 'FAIL') expect(f.demotedFrom, where).toBeUndefined();
    }
    expect(seen.PASS).toBeGreaterThan(20);
    expect(failsWithoutWindow).toBeGreaterThan(10);
    expect(seen.FAIL).toBeGreaterThan(20);
    expect(seen.UNRESOLVED).toBeGreaterThan(40);
  });
});

describe('T4 over terraform show -json: 1500 seeded cases, exact boundary', () => {
  it('PASS exactly when visibility >= 6 x timeout + window', () => {
    const rng = makeRng(77);
    let boundary = 0;
    for (let n = 0; n < 1500; n += 1) {
      const t = rng.int(1, 900);
      const w = rng.int(0, 300);
      const need = 6 * t + w;
      // half the cases sit within one second of the boundary
      const v =
        n % 2 === 0 ? Math.max(0, Math.min(43_200, need + rng.int(-1, 1))) : rng.int(0, 43_200);
      const doc = {
        format_version: '1.2',
        planned_values: {
          root_module: {
            resources: [
              {
                address: 'aws_sqs_queue.q',
                mode: 'managed',
                type: 'aws_sqs_queue',
                name: 'q',
                values: { visibility_timeout_seconds: v },
              },
              {
                address: 'aws_lambda_function.f',
                mode: 'managed',
                type: 'aws_lambda_function',
                name: 'f',
                values: { timeout: t },
              },
              {
                address: 'aws_lambda_event_source_mapping.m',
                mode: 'managed',
                type: 'aws_lambda_event_source_mapping',
                name: 'm',
                values: { maximum_batching_window_in_seconds: w },
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
                  function_name: {
                    references: ['aws_lambda_function.f.arn', 'aws_lambda_function.f'],
                  },
                },
              },
            ],
          },
        },
      };
      const result = analyse(intakeStreamBytes(new TextEncoder().encode(JSON.stringify(doc))));
      const f = ruleOf(result, 'T4');
      const where = `v=${v} t=${t} w=${w}`;
      expect(f.kind, where).toBe(v >= need ? 'PASS' : 'FAIL');
      if (v === need || v === need - 1) boundary += 1;
      if (f.kind === 'FAIL')
        expect(f.headline, where).toBe(
          `visibility ${v} s is less than 6 x ${t} s + ${w} s = ${need} s`,
        );
      else expect(f.headline, where).toBe(`visibility ${v} s covers ${need} s`);
    }
    expect(boundary).toBeGreaterThan(100);
  });
});

describe('metamorphic: a window can only raise the need (B17)', () => {
  it('visibility < 6 x timeout fails for every window and for none; at or above it the window decides', () => {
    const rng = makeRng(20261113);
    const run = (v: number, t: number, w: string | undefined) =>
      ruleOf(
        analyseFiles(
          {
            'a.tf':
              `resource "aws_sqs_queue" "q" {\n  visibility_timeout_seconds = ${v}\n}\n` +
              `resource "aws_lambda_function" "f" {\n  timeout = ${t}\n}\n` +
              'resource "aws_lambda_event_source_mapping" "m" {\n  event_source_arn = aws_sqs_queue.q.arn\n  function_name = aws_lambda_function.f.arn\n' +
              (w === undefined ? '' : `  maximum_batching_window_in_seconds = ${w}\n`) +
              '}\n',
          },
          { base: {} },
        ).result,
        'T4',
      );
    for (let n = 0; n < 120; n += 1) {
      const t = rng.int(1, 60);
      const v = rng.int(0, 400);
      const windows = [undefined, 'var.w', ...[0, 1, rng.int(0, 300), 300].map(String)];
      for (const w of windows) {
        const f = run(v, t, w);
        const where = `v=${v} t=${t} w=${w}`;
        if (v < 6 * t) {
          expect(f.kind, where).toBe('FAIL');
        } else if (w === undefined || w === 'var.w') {
          expect(f.kind, where).toBe('UNRESOLVED');
        } else {
          expect(f.kind, where).toBe(v >= 6 * t + Number(w) ? 'PASS' : 'FAIL');
        }
      }
    }
  });
});
