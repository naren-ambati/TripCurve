// T4 over CloudFormation and SAM, 500 seeded mixtures: the verdict is the arithmetic when every
// value is a plain integer (or an absent value whose default follows from the template), and UNRESOLVED when any
// visibility or timeout is written in a form that is not a literal, whatever the numbers are. A window that is not a
// literal only matters for PASS (bolt B17). The oracle is independent of the reader.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, ruleOf } from '../support/analyse.js';
import { makeRng } from '../support/prng.js';

afterEach(cleanupTrees);

type Form = { text: string | undefined; value: number | 'absent' | 'bad' };
const BAD = [
  '!Ref P',
  '!If [c, 1, 2]',
  '!Sub "5"',
  '!Bogus 5',
  '0x10',
  '1e1',
  '"7"',
  '060',
  '!!int 5',
  '[5]',
];

function form(rng: ReturnType<typeof makeRng>, lo: number, hi: number, absentOk: boolean): Form {
  const r = rng.int(0, 9);
  if (r === 0 && absentOk) return { text: undefined, value: 'absent' };
  if (r <= 2) return { text: rng.pick(BAD), value: 'bad' };
  const n = rng.int(lo, hi);
  return { text: String(n), value: n };
}

describe('T4 over a template: the oracle agrees', () => {
  it.each(['sam', 'cfn'] as const)('%s', (kind) => {
    const rng = makeRng(kind === 'sam' ? 20261113 : 20261114);
    const seen = { PASS: 0, FAIL: 0, UNRESOLVED: 0 };
    for (let n = 0; n < 500; n += 1) {
      const v = form(rng, 0, 600, true);
      const t = form(rng, 1, 60, true);
      const w = form(rng, 0, 60, true);
      const prop = (name: string, f: Form): string =>
        f.text === undefined ? '' : `      ${name}: ${f.text}\n`;
      const head =
        'AWSTemplateFormatVersion: "2010-09-09"\n' +
        (kind === 'sam' ? 'Transform: AWS::Serverless-2016-10-31\n' : '');
      const fnType = kind === 'sam' ? 'AWS::Serverless::Function' : 'AWS::Lambda::Function';
      const body =
        `${head}Resources:\n  Q:\n    Type: AWS::SQS::Queue\n${v.text === undefined ? '' : `    Properties:\n${prop('VisibilityTimeout', v)}`}` +
        `  F:\n    Type: ${fnType}\n    Properties:\n      Handler: h\n${prop('Timeout', t)}` +
        (kind === 'sam'
          ? `      Events:\n        E:\n          Type: SQS\n          Properties:\n            Queue: !GetAtt Q.Arn\n${w.text === undefined ? '' : `            MaximumBatchingWindowInSeconds: ${w.text}\n`}`
          : `  M:\n    Type: AWS::Lambda::EventSourceMapping\n    Properties:\n      EventSourceArn: !GetAtt Q.Arn\n      FunctionName: !Ref F\n${prop('MaximumBatchingWindowInSeconds', w)}`);
      const f = ruleOf(analyseFiles({ 't.yaml': body }, { base: {} }).result, 'T4');
      const vis = v.value === 'absent' ? 30 : v.value;
      const tim = t.value === 'absent' ? 3 : t.value;
      let want: 'PASS' | 'FAIL' | 'UNRESOLVED';
      // B17: a window that is not established (absent or not a literal) can only raise the need, so visibility
      // below 6 x timeout fails whatever it is; at or above, only PASS needs the window
      if (vis === 'bad' || tim === 'bad') want = 'UNRESOLVED';
      else if (w.value === 'bad' || w.value === 'absent')
        want = vis < 6 * tim ? 'FAIL' : 'UNRESOLVED';
      else want = vis >= 6 * tim + w.value ? 'PASS' : 'FAIL';
      const where = `${kind} case ${n}: ${JSON.stringify([v, t, w])}`;
      expect(f.kind, where).toBe(want);
      seen[want] += 1;
      if (f.kind === 'PASS' || f.kind === 'FAIL') expect(f.demotedFrom, where).toBeUndefined();
    }
    expect(seen.PASS).toBeGreaterThan(15);
    expect(seen.FAIL).toBeGreaterThan(15);
    expect(seen.UNRESOLVED).toBeGreaterThan(100);
  });
});
