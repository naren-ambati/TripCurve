// B5: a printed basis must claim exactly what the evidence holds (the B3 and B4 lesson). Every shipped
// Terraform entry is checked against the dated lookups kept in the repository (docs/lookups-b5.txt): the
// quoted sentences must be in that file word for word, the numbers must be the numbers in them, the date
// and the URL must be theirs, and an entry may claim "schema Default" only for what the provider SOURCE
// was read for. The documented ranges the reader applies are checked against the same file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { passBlocker } from '../../src/core/index.js';
import { ALB_IDLE_MAX_S, ALB_IDLE_MIN_S } from '../../src/core/limits.js';
import {
  basisWords,
  defaultKnowledgeBase,
  sourcedValueFromEntry,
  supportsPass,
  unknownInterval,
} from '../../src/kb/index.js';
import { TF_INT_RANGES } from '../../src/parse/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const LOOKUPS = readFileSync(join(ROOT, 'docs', 'lookups-b5.txt'), 'utf8');
const kb = defaultKnowledgeBase();

function entry(id: string) {
  const e = kb.entry(id);
  if (e === undefined) throw new Error(`no entry ${id}`);
  return e;
}

/** What each entry quotes, word for word, and the number it stands on. */
const EVIDENCE: readonly {
  id: string;
  value: number;
  quotes: readonly string[];
  /** Words an entry may not use, because the lookups hold no evidence for them. */
  forbidden: readonly string[];
  /** The provider source line that is the schema Default; set exactly for the entries that claim one. */
  sourceLine?: string;
}[] = [
  {
    id: 'terraform-lb-idle-timeout-default',
    value: 60,
    quotes: [
      '`idle_timeout` - (Optional) Time in seconds that the connection is allowed to be idle. Only valid for Load Balancers of type `application`. Default: 60.',
      '`load_balancer_type` - (Optional) Type of load balancer to create. Possible values are `application`, `gateway`, or `network`. The default value is `application`.',
    ],
    forbidden: [],
    sourceLine:
      '"idle_timeout": { Type: schema.TypeInt, Optional: true, Default: 60, DiffSuppressFunc: suppressIfLBTypeNot(awstypes.LoadBalancerTypeEnumApplication) }',
  },
  {
    id: 'terraform-sqs-visibility-default',
    value: 30,
    quotes: [
      '`visibility_timeout_seconds` - (Optional) Visibility timeout for the queue. An integer from 0 to 43200 (12 hours). The default for this attribute is 30.',
      '"visibility_timeout_seconds": { Type: schema.TypeInt, Optional: true, Default: defaultQueueVisibilityTimeout, ValidateFunc: validation.IntBetween(0, 43_200) }',
      'The default visibility timeout for a queue is 30 seconds',
    ],
    forbidden: [],
    sourceLine:
      '"visibility_timeout_seconds": { Type: schema.TypeInt, Optional: true, Default: defaultQueueVisibilityTimeout, ValidateFunc: validation.IntBetween(0, 43_200) }',
  },
  {
    id: 'terraform-lambda-timeout-default',
    value: 3,
    quotes: [
      '`timeout` - (Optional) Amount of time your Lambda Function has to run in seconds. Defaults to 3. Valid between 1 and 900.',
      'The default value for this setting is 3 seconds, but you can adjust this in increments of 1 second up to a maximum value of 900 seconds (15 minutes).',
    ],
    forbidden: [],
    sourceLine:
      'names.AttrTimeout: { Type: schema.TypeInt, Optional: true, Default: 3, ValidateFunc: validation.IntBetween(1, 900) }',
  },
  {
    id: 'lambda-sqs-batching-window-default',
    value: 0,
    quotes: [
      'For Kinesis, DynamoDB, and Amazon SQS event sources, the default batching window is 0 seconds.',
      '"maximum_batching_window_in_seconds": { Type: schema.TypeInt, Optional: true }',
    ],
    forbidden: [],
  },
];

describe('every Terraform entry is backed by the dated lookups', () => {
  for (const ev of EVIDENCE) {
    const e = entry(ev.id);
    it(`${ev.id}: the quoted sentences are in the lookups file word for word`, () => {
      for (const q of ev.quotes) {
        expect(LOOKUPS, q).toContain(q);
        expect(e.notes, q).toContain(q);
      }
    });

    it(`${ev.id}: the value is the number in the quotation, and the unit is seconds`, () => {
      expect(e.value).toBe(ev.value);
      expect(e.unit).toBe('s');
      expect(ev.quotes.join(' ')).toMatch(new RegExp(`\\b${ev.value}\\b`));
    });

    it(`${ev.id}: the URL and the date are the lookups' (read 2026-11-12)`, () => {
      expect(LOOKUPS).toContain(e.docUrl.replace('https://', ''));
      expect(e.docDate).toBe('2026-11-12');
      expect(LOOKUPS).toContain('read 2026-11-12');
      expect(e.notes).toContain('2026-11-12');
    });

    it(`${ev.id}: claims nothing the lookups do not hold`, () => {
      for (const w of ev.forbidden) expect(e.notes ?? '', w).not.toContain(w);
      // an entry claims a schema Default exactly when its source line is in the lookups and in its notes
      const claims = /schema Default/.test(e.notes ?? '');
      expect(claims, 'claims a schema Default').toBe(ev.sourceLine !== undefined);
      if (ev.sourceLine !== undefined) {
        expect(LOOKUPS, ev.sourceLine).toContain(ev.sourceLine);
        expect(e.notes, ev.sourceLine).toContain(ev.sourceLine);
      }
      expect(e.basis).toBe('documented');
      expect(basisWords(e)).toBe('documented');
      expect(e.scriptRef).toHaveProperty('notMeasurableLocally');
    });
  }

  it('every provider source file an entry cites is named in the lookups', () => {
    for (const f of [
      'internal/service/sqs/queue.go',
      'internal/service/lambda/function.go',
      'internal/service/elbv2/load_balancer.go',
      'internal/service/lambda/event_source_mapping.go',
    ]) {
      expect(LOOKUPS).toContain(f);
    }
    const cited = kb.entries.filter(
      (e) => e.docUrl && /internal\/service\/[a-z0-9_/]+\.go/.test(e.notes ?? ''),
    );
    for (const e of cited) {
      for (const m of (e.notes ?? '').matchAll(/internal\/service\/[a-z0-9_/]+\.go/g)) {
        expect(LOOKUPS, `${e.id}: ${m[0]}`).toContain(m[0]);
      }
    }
  });
});

describe('what each default may support', () => {
  it('the three defaults that follow from the file may support PASS', () => {
    for (const id of [
      'terraform-lb-idle-timeout-default',
      'terraform-sqs-visibility-default',
      'terraform-lambda-timeout-default',
    ]) {
      const e = entry(id);
      expect(supportsPass(e), id).toBe(true);
      const v = sourcedValueFromEntry(e);
      expect(v?.basis, id).toBe('documented');
      expect(v && passBlocker([{ label: 'x', value: v }]), id).toBeUndefined();
    }
  });

  it('the batching window default has no provider default: used only as an ASSUMED value, which blocks PASS', () => {
    const e = entry('lambda-sqs-batching-window-default');
    expect(e.notes).toContain('NO schema default');
    expect(e.notes).toContain('does not establish 0');
    const assumed = sourcedValueFromEntry(e, { assumed: true });
    expect(assumed?.basis).toBe('assumed');
    expect(assumed && passBlocker([{ label: 'x', value: assumed }])).toBe('assumed-value');
  });

  it('every subject has exactly one entry, found by an unknown version', () => {
    for (const subject of [
      'terraform-lb-idle-timeout',
      'terraform-sqs-visibility',
      'terraform-lambda-timeout',
      'lambda-sqs-batching-window',
    ] as const) {
      expect(kb.lookup(subject, unknownInterval()).matches, subject).toHaveLength(1);
    }
  });
});

describe('the documented ranges the reader applies', () => {
  it('are in the lookups (the ALB range is in core/limits.ts, looked up 2026-11-11)', () => {
    expect(LOOKUPS).toContain('An integer from 0 to 43200');
    expect(TF_INT_RANGES.visibility_timeout_seconds).toEqual({ min: 0, max: 43_200 });
    expect(LOOKUPS).toContain('Valid between 1 and 900');
    expect(TF_INT_RANGES.timeout).toEqual({ min: 1, max: 900 });
    expect(LOOKUPS).toContain('(between 0 and 300)');
    expect(TF_INT_RANGES.maximum_batching_window_in_seconds).toEqual({ min: 0, max: 300 });
    expect(TF_INT_RANGES.idle_timeout).toEqual({ min: ALB_IDLE_MIN_S, max: ALB_IDLE_MAX_S });
  });
});
