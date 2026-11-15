import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_IDS } from '../../src/core/index.js';
import { EXPLAIN_ENTRIES } from '../../src/evaluate/explain-entries.js';
import { explain } from '../../src/index.js';
import {
  basisWords,
  defaultKnowledgeBase,
  explicitBasisWords,
  type KbEntry,
  KnowledgeBase,
} from '../../src/kb/index.js';
import { explainRule, UNKNOWN_RULE_MESSAGE } from '../../src/report/index.js';

// `--explain` prints tripcurve's own text. The knowledge-base rows are generated
// from the knowledge-base data, so they cannot drift; the vendor quotes are checked against the notes
// they were taken from.

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const kb = defaultKnowledgeBase();

describe('the text of each rule', () => {
  it.each(RULE_IDS)(
    '%s has the rule, a vendor quote with its link, the defaults and when it does not apply',
    (rule) => {
      const text = explainRule(rule) as string;
      expect(text.startsWith(`${rule}  `)).toBe(true);
      expect(text).toContain('\nVendor guidance\n');
      expect(text).toMatch(/\n {2}https:\/\/\S+\n/);
      expect(text).toContain(`\nDefaults used by ${rule}\n`);
      expect(text).toContain(`\nWhen ${rule} does not apply or cannot decide\n`);
      expect(text.endsWith('\n')).toBe(true);
    },
  );

  it.each(RULE_IDS)(
    '%s is plain ASCII within 80 columns, and only a link is allowed to be longer',
    (rule) => {
      for (const line of (explainRule(rule) as string).split('\n')) {
        expect(line).toMatch(/^[\x20-\x7e]*$/);
        if (line.length > 80) expect(line).toMatch(/^ {2}https:\/\/\S+$/);
      }
    },
  );

  it('has an entry for exactly the rules there are', () => {
    expect(Object.keys(EXPLAIN_ENTRIES).sort()).toEqual([...RULE_IDS].sort());
  });

  it('T1 follows the shipped wording of the expected report layout', () => {
    const text = explainRule('T1') as string;
    expect(text).toContain(
      "T1  The app's effective idle close must exceed the load balancer's idle",
    );
    expect(text).toContain('AWS, Application Load Balancer attributes');
    expect(text).toContain(
      'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html\n',
    );
    expect(text).toContain('gunicorn sync worker');
  });

  it('T4 credits cdk-nag (rule, date, PR) and cfn-lint E3505 and is never described as new', () => {
    const text = explainRule('T4') as string;
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('LambdaEventSourceSQSVisibilityTimeout');
    expect(flat).toContain('added 2024-11-01, PR #1813');
    expect(flat).toContain('cfn-lint rule E3505');
    expect(flat).toContain('T4 is not new.');
    expect(flat).toContain('credited port');
    expect(text).toContain('  https://github.com/cdklabs/cdk-nag\n');
    for (const word of [
      /\bnovel\b/i,
      /\bfirst\b/i,
      /\bunique\b/i,
      /\bnew rule\b/i,
      /\binvented\b/i,
    ]) {
      expect(text).not.toMatch(word);
    }
    // only T4 carries a credit
    for (const rule of ['T1', 'T2', 'T3'] as const) {
      expect(explainRule(rule)).not.toContain('Credit');
    }
  });
});

describe('the knowledge-base values are generated from the knowledge base (they cannot drift)', () => {
  it.each(RULE_IDS)('%s lists every entry of its subjects, with value, basis and date', (rule) => {
    const text = (explainRule(rule) as string).replace(/\s+/g, ' ');
    const subjects = EXPLAIN_ENTRIES[rule].subjects as readonly string[];
    const entries = kb.entries.filter((e) => subjects.includes(e.subject));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(text, e.id).toContain(`- ${e.id}`);
      expect(text, e.id).toContain(e.value === 'n/a' ? 'n/a' : `${e.value} ${e.unit}`);
      const basis = e.subject.endsWith('-explicit') ? explicitBasisWords(e) : basisWords(e);
      expect(text, e.id).toContain(basis);
      expect(text, e.id).toContain(
        e.basis === 'measured' ? `dated ${e.measuredOn?.date}` : `source read ${e.docDate}`,
      );
    }
  });

  it('prints no entry of another rule', () => {
    const t4 = explainRule('T4') as string;
    expect(t4).not.toContain('node-idle-close');
    expect(t4).not.toContain('gunicorn');
    expect(explainRule('T1')).not.toContain('terraform-sqs-visibility');
  });

  const entry = (over: Partial<KbEntry> = {}): KbEntry => ({
    id: 'alb-idle-timeout-default',
    subject: 'alb-idle-timeout',
    value: 60,
    unit: 's',
    applies: { runtime: 'alb', versionRange: '*' },
    citationName: 'ALB idle timeout',
    rangeLabel: 'AWS docs, ALB',
    docUrl: 'https://example.invalid/doc',
    docDate: '2026-01-02',
    basis: 'documented',
    scriptRef: { notMeasurableLocally: 'cloud service' },
    ...over,
  });

  it('a changed entry changes the text: a value, a basis, a date', () => {
    const base = (explainRule('T1', new KnowledgeBase([entry()])) as string).replace(/\s+/g, ' ');
    expect(base).toContain(
      '- alb-idle-timeout-default, AWS docs, ALB: 60 s; documented; source read 2026-01-02;',
    );
    const changed = (
      explainRule('T1', new KnowledgeBase([entry({ value: 75, docDate: '2026-03-04' })])) as string
    ).replace(/\s+/g, ' ');
    expect(changed).toContain('75 s; documented; source read 2026-03-04;');
    expect(changed).not.toContain('60 s');
  });

  it('a deferred entry says it is deferred and not measured, with the reason from the entry', () => {
    const { scriptRef: _drop, ...rest } = entry();
    const text = explainRule(
      'T1',
      new KnowledgeBase([
        {
          ...rest,
          basis: 'from-changelogs',
          deferredTo: { bolt: 'B13', reason: 'no x64 runtime on this host' },
        } as KbEntry,
      ]),
    ) as string;
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('deferred to B13: not measured (no x64 runtime on this host)');
    expect(flat).not.toContain('not measurable locally');
  });

  it('the shipped old-Node trap entries are printed as deferred to B13, never as not measurable locally', () => {
    const flat = (explainRule('T1') as string).replace(/\s+/g, ' ');
    expect(flat).not.toContain(
      'node-headers-trap-10x, Node 10.x from 10.15.2: 40 s; from changelogs, not measured; source read 2026-11-02; not measurable locally',
    );
    expect(flat).toMatch(
      /node-headers-trap-10x.*?; deferred to B13: not measured \(Attempted in B13 \(2026-11-12\): cannot run on this host/,
    );
    expect(flat.match(/deferred to B13: not measured/g)?.length).toBe(3);
  });

  it('an entry whose basis is to be measured says it never supports PASS', () => {
    const text = explainRule(
      'T1',
      new KnowledgeBase([entry({ basis: 'to-be-measured' })]),
    ) as string;
    expect(text.replace(/\s+/g, ' ')).toContain('to be measured (never supports PASS)');
  });

  it('an entry with a condition shows it, so two entries of one range stay apart', () => {
    const text = explainRule(
      'T1',
      new KnowledgeBase([
        entry({
          id: 'a-uv',
          applies: { runtime: 'g', versionRange: '*', condition: 'workerClass in [uvicorn]' },
        }),
        entry({
          id: 'a-gt',
          applies: { runtime: 'g', versionRange: '*', condition: 'workerClass in [gthread]' },
        }),
      ]),
    ) as string;
    expect(text).toContain('(workerClass in [uvicorn])');
    expect(text).toContain('(workerClass in [gthread])');
  });

  it('an empty knowledge base still explains the rule and says there is no entry', () => {
    expect(explainRule('T2', new KnowledgeBase([]))).toContain('(no knowledge-base entry)');
  });
});

describe('the vendor quotes are the text of the notes they come from (claims against evidence)', () => {
  const sources = [
    read('docs/research.md'),
    read('docs/lookups-b5.txt'),
    read('measure/results/2026-11-11-lookups-b4.txt'),
  ].join('\n');

  it.each(RULE_IDS.flatMap((r) => EXPLAIN_ENTRIES[r].quotes.map((q) => [r, q] as const)))(
    '%s: %j is quoted verbatim from the notes, with its link and date',
    (_rule, q) => {
      expect(sources).toContain(q.quote);
      expect(sources).toContain(q.url);
      // a day, or the honest span when the notes give no single day
      expect(q.read).toMatch(/^\d{4}-\d{2}-\d{2}( to \d{4}-\d{2}-\d{2}, research notes)?$/);
    },
  );

  it('the quotes taken from the research notes print the span the notes give, not one day', () => {
    const research = read('docs/research.md');
    expect(research).toContain('sweep 2026-10-29, re-checks through 2026-11-02');
    for (const rule of ['T1', 'T2'] as const) {
      const text = (explainRule(rule) as string).replace(/\s+/g, ' ');
      expect(text).toContain('(read 2026-10-29 to 2026-11-02, research notes)');
      expect(text).not.toContain('(read 2026-11-02)');
    }
    expect((explainRule('T4') as string).replace(/\s+/g, ' ')).toContain(
      'checked 2026-10-29 to 2026-11-02',
    );
  });

  it('the credit names what the research notes record', () => {
    const research = read('docs/research.md');
    expect(research).toContain('LambdaEventSourceSQSVisibilityTimeout');
    expect(research).toContain('rule added 2024-11-01, PR #1813');
    expect(research).toContain('E3505');
  });
});

describe('an unknown rule', () => {
  it.each(['T9', 't1', '', ' T1', 'T1\u001b[2J', '../etc/passwd', 'x'.repeat(100_000)])(
    '%j gives no text, and the message echoes nothing',
    (rule) => {
      expect(explainRule(rule)).toBeUndefined();
    },
  );

  it('the fixed message names the four rules and holds no input', () => {
    expect(UNKNOWN_RULE_MESSAGE).toBe(
      'tripcurve: unknown rule. Rules are T1, T2, T3 and T4. See --help.\n',
    );
  });

  it('the library `explain` returns the text, or UnknownRule', () => {
    expect(explain('T3')).toBe(explainRule('T3'));
    expect(explain('T0')).toEqual({ unknownRule: true });
  });

  it('inherits nothing from the object prototype', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(explainRule(name)).toBeUndefined();
    }
  });
});
