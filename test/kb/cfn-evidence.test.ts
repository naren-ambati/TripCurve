// B12: a printed basis must claim exactly what the evidence holds. Every CloudFormation entry is checked against the
// dated lookups kept in the repository (docs/lookups-b12.txt): each quoted sentence must be in that file word
// for word, the number must be the number in it, and the date and the URL must be the lookup's. The documented
// ranges the reader applies are the ones in the same file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { passBlocker } from '../../src/core/index.js';
import {
  basisWords,
  defaultKnowledgeBase,
  sourcedValueFromEntry,
  supportsPass,
  unknownInterval,
} from '../../src/kb/index.js';

const LOOKUPS = readFileSync(
  join(import.meta.dirname, '..', '..', 'docs', 'lookups-b12.txt'),
  'utf8',
);
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const kb = defaultKnowledgeBase();

const EVIDENCE = [
  {
    id: 'cfn-lb-idle-timeout-default',
    subject: 'cfn-lb-idle-timeout' as const,
    value: 60,
    page: 'aws-properties-elasticloadbalancingv2-loadbalancer-loadbalancerattribute.html',
    numbers: ['The default is 60 seconds.'],
  },
  {
    id: 'cfn-sqs-visibility-default',
    subject: 'cfn-sqs-visibility' as const,
    value: 30,
    page: 'aws-resource-sqs-queue.html',
    numbers: ['uses the default value of 30 seconds.'],
  },
  {
    id: 'cfn-lambda-timeout-default',
    subject: 'cfn-lambda-timeout' as const,
    value: 3,
    page: 'aws-resource-lambda-function.html',
    numbers: ['The default is 3 seconds'],
  },
];

describe('the CloudFormation entries stand on the dated lookups', () => {
  it.each(EVIDENCE)('$id', ({ id, subject, value, page, numbers }) => {
    const e = kb.entry(id);
    if (e === undefined) throw new Error('missing entry');
    expect(e.subject).toBe(subject);
    expect(e.value).toBe(value);
    expect(e.basis).toBe('documented');
    expect(e.docDate).toBe('2026-11-12');
    expect(e.docUrl.endsWith(page)).toBe(true);
    expect(LOOKUPS).toContain(
      `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/${page}`,
    );
    for (const n of numbers) expect(flat(LOOKUPS)).toContain(n);
    const notes = flat(e.notes ?? '');
    const quoted = [...notes.matchAll(/\\?"([^"]{25,})\\?"/g)].map((m) => m[1] as string);
    expect(quoted.length).toBeGreaterThan(0);
    for (const q of quoted) expect(flat(LOOKUPS), q).toContain(q.replace(/\\$/, ''));
  });

  it('the SAM Timeout default quoted in the Lambda entry is in the lookups', () => {
    expect(flat(LOOKUPS)).toContain('Default: 3');
    expect(flat(LOOKUPS)).toContain(
      'is passed directly to the Timeout property of an AWS::Lambda::Function resource',
    );
  });

  it('each default supports PASS with its basis printed (documented), and none is a placeholder', () => {
    for (const { subject } of EVIDENCE) {
      const match = kb.lookup(subject, unknownInterval()).matches[0];
      if (match === undefined) throw new Error('no match');
      expect(match.entry.basis).not.toBe('to-be-measured');
      expect(supportsPass(match.entry)).toBe(true);
      expect(basisWords(match.entry)).toContain('documented');
      const value = sourcedValueFromEntry(match.entry);
      if (value === undefined) throw new Error('no value');
      expect(passBlocker([{ label: 'x', value }])).toBeUndefined();
    }
  });

  it('the batching window default is still only ever assumed (the lookups say 0 for SQS, B5 keeps it unresolved)', () => {
    expect(flat(LOOKUPS)).toContain('Default (Kinesis, DynamoDB, Amazon SQS event sources) : 0');
  });
});
