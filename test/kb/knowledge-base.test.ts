import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RESULTS_DIR = join(import.meta.dirname, '..', '..', 'measure', 'results');

import { type ChainStep, inputText, makeFinding, type WorkloadRef } from '../../src/core/index.js';
import {
  basisWords,
  citationFor,
  defaultKnowledgeBase,
  type KbEntry,
  KbSchemaError,
  loadKbEntries,
  loadKnowledgeBase,
  lookup,
  parseVersion,
  sourcedValueFromEntry,
  supportsPass,
  unknownInterval,
} from '../../src/kb/index.js';
import { makeRng } from '../support/prng.js';

// Hand-fixed entries: these tests never read the shipped data, so a change to
// a shipped value cannot make them pass or fail by accident.
const base = {
  subject: 'node-idle-close',
  value: 6,
  unit: 's',
  citationName: 'Test source',
  docUrl: 'https://example.invalid/doc',
  docDate: '2026-01-02',
  scriptRef: 'measure/x.mjs',
  toleranceMs: 4,
} as const;

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    basis: 'documented',
    applies: { runtime: 'node', versionRange: '>=22.19.0 <23.0.0' },
    ...over,
  };
}

function file(...entries: Record<string, unknown>[]) {
  return { schemaVersion: 1, entries };
}

const LINE22 = entry({ id: 'line-22', rangeLabel: 'Test 22.x' });
const LINE24 = entry({
  id: 'line-24',
  applies: { runtime: 'node', versionRange: '>=24.22.3 <25.0.0' },
  rangeLabel: 'Test 24.x',
  basis: 'measured',
  measuredOn: { version: '24.22.3', date: '2026-01-02', platform: 'test' },
});

describe('the loader rejects what is missing and names the entry id', () => {
  const required: Array<[string, (e: Record<string, unknown>) => void]> = [
    ['subject', (e) => Reflect.deleteProperty(e, 'subject')],
    ['value', (e) => Reflect.deleteProperty(e, 'value')],
    ['unit', (e) => Reflect.deleteProperty(e, 'unit')],
    ['applies', (e) => Reflect.deleteProperty(e, 'applies')],
    ['applies.versionRange', (e) => Reflect.deleteProperty(e.applies as object, 'versionRange')],
    ['applies.runtime', (e) => Reflect.deleteProperty(e.applies as object, 'runtime')],
    ['citationName', (e) => Reflect.deleteProperty(e, 'citationName')],
    ['docUrl', (e) => Reflect.deleteProperty(e, 'docUrl')],
    ['docDate', (e) => Reflect.deleteProperty(e, 'docDate')],
    ['basis', (e) => Reflect.deleteProperty(e, 'basis')],
    ['scriptRef', (e) => Reflect.deleteProperty(e, 'scriptRef')],
    ['toleranceMs', (e) => Reflect.deleteProperty(e, 'toleranceMs')],
  ];

  it.each(required)('rejects an entry missing %s, naming it', (field, remove) => {
    const e = entry({ id: 'victim-entry' });
    remove(e);
    try {
      loadKbEntries([file(e)]);
      expect.unreachable('should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(KbSchemaError);
      const problems = (err as KbSchemaError).problems;
      expect(problems.every((p) => p.entryId === 'victim-entry')).toBe(true);
      expect(problems.some((p) => p.field === field)).toBe(true);
      expect((err as Error).message).toContain('victim-entry');
    }
  });

  it('names an entry that has no id by its position', () => {
    const e = entry({ id: 'x' });
    Reflect.deleteProperty(e, 'id');
    expect(() => loadKbEntries([file(LINE22, e)])).toThrow(/#1 \(no id\)/);
  });

  it('rejects malformed values: bad id, subject, number, unit, url, date, range, extra field', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['id', entry({ id: 'Not_Kebab' })],
      ['subject', entry({ id: 'a', subject: 'made-up' })],
      ['value', entry({ id: 'a', value: -1 })],
      ['value', entry({ id: 'a', value: '6' })],
      ['value', entry({ id: 'a', value: Number.NaN })],
      ['unit', entry({ id: 'a', unit: 'minutes' })],
      ['docUrl', entry({ id: 'a', docUrl: 'http://example.invalid/' })],
      ['docUrl', entry({ id: 'a', docUrl: 'not a url' })],
      ['docDate', entry({ id: 'a', docDate: '2026-02-30' })],
      ['docDate', entry({ id: 'a', docDate: '11/11/2026' })],
      [
        'applies.versionRange',
        entry({ id: 'a', applies: { runtime: 'node', versionRange: '22.x' } }),
      ],
      [
        'applies.condition',
        entry({ id: 'a', applies: { runtime: 'node', versionRange: '*', condition: 'x == 1' } }),
      ],
      ['basis', entry({ id: 'a', basis: 'guessed' })],
      ['toleranceMs', entry({ id: 'a', toleranceMs: 0 })],
      ['toleranceMs', entry({ id: 'a', toleranceMs: '4' })],
      ['toleranceTypo', entry({ id: 'a', toleranceTypo: 4 })],
    ];
    for (const [field, e] of cases) {
      try {
        loadKbEntries([file(e)]);
        expect.unreachable(`${field} should have been rejected`);
      } catch (err) {
        expect(err, field).toBeInstanceOf(KbSchemaError);
        expect(
          (err as KbSchemaError).problems.some((p) => p.field === field),
          field,
        ).toBe(true);
      }
    }
  });

  it('requires measuredOn exactly when basis is measured', () => {
    expect(() => loadKbEntries([file(entry({ id: 'a', basis: 'measured' }))])).toThrow(
      /measuredOn/,
    );
    expect(() =>
      loadKbEntries([
        file(
          entry({ id: 'a', measuredOn: { version: '1.0.0', date: '2026-01-02', platform: 'p' } }),
        ),
      ]),
    ).toThrow(/measuredOn/);
    expect(() => loadKbEntries([file(LINE24)])).not.toThrow();
  });

  it('allows the not-measurable-locally reason only for the ALB idle and grace entries', () => {
    const reason = { notMeasurableLocally: 'cannot run on localhost' };
    const alb = {
      id: 'alb',
      subject: 'alb-idle-timeout',
      value: 60,
      unit: 's',
      applies: { runtime: 'alb', versionRange: '*' },
      citationName: 'ALB idle timeout',
      docUrl: 'https://example.invalid/',
      docDate: '2026-01-02',
      basis: 'documented',
      scriptRef: reason,
    };
    expect(() => loadKbEntries([file(alb)])).not.toThrow();
    expect(() => loadKbEntries([file({ ...alb, subject: 'k8s-grace-period' })])).not.toThrow();
    expect(() => loadKbEntries([file({ ...alb, subject: 'uvicorn-keepalive' })])).toThrow(
      /scriptRef/,
    );
    expect(() =>
      loadKbEntries([file({ ...alb, scriptRef: { notMeasurableLocally: '' } })]),
    ).toThrow(/scriptRef/);
    expect(() => loadKbEntries([file({ ...alb, toleranceMs: 4 })])).toThrow(/toleranceMs/);
  });

  it('keeps one Node entry to one release line', () => {
    const spanning = entry({
      id: 'span',
      applies: { runtime: 'node', versionRange: '>=22.19.0 <25.0.0' },
    });
    expect(() => loadKbEntries([file(spanning)])).toThrow(/span release lines/);
    const star = entry({ id: 'star', applies: { runtime: 'node', versionRange: '*' } });
    expect(() => loadKbEntries([file(star)])).toThrow(/release line/);
    const open = entry({ id: 'open', applies: { runtime: 'node', versionRange: '>=27.0.0' } });
    expect(() => loadKbEntries([file(open)])).not.toThrow();
    const midLine = entry({
      id: 'mid',
      applies: { runtime: 'node', versionRange: '>=22.19.0 <24.1.0' },
    });
    expect(() => loadKbEntries([file(midLine)])).toThrow(/span release lines/);
  });

  it('rejects a duplicate id, a bad file shape and a wrong schema version', () => {
    expect(() => loadKbEntries([file(LINE22, LINE22)])).toThrow(/not unique/);
    expect(() => loadKbEntries([{ schemaVersion: 2, entries: [] }])).toThrow(KbSchemaError);
    expect(() => loadKbEntries([{ entries: [] }])).toThrow(KbSchemaError);
    expect(() => loadKbEntries([null])).toThrow(KbSchemaError);
    expect(() => loadKbEntries([file(5 as never)])).toThrow(KbSchemaError);
  });

  it('reports every bad entry, not just the first', () => {
    try {
      loadKbEntries([file(entry({ id: 'one', unit: 'x' }), entry({ id: 'two', unit: 'y' }))]);
      expect.unreachable('should be rejected');
    } catch (err) {
      const ids = new Set((err as KbSchemaError).problems.map((p) => p.entryId));
      expect(ids).toEqual(new Set(['one', 'two']));
    }
  });
});

describe('lookup', () => {
  const kb = loadKnowledgeBase([file(LINE22, LINE24)]);

  it('returns the entry that covers an exact version, with the citation', () => {
    const r = kb.lookup('node-idle-close', parseVersion('22.23.2'));
    expect(r.matches.map((m) => m.entry.id)).toEqual(['line-22']);
    expect(r.matches[0]?.citation).toBe('default: Test source (Test 22.x; documented)');
    expect(r.covered).toBe(true);
  });

  it('never returns a nearest range: a version outside every range has no match', () => {
    for (const text of [
      '22.18.0',
      '22.18.99',
      '23.0.0',
      '24.22.2',
      '25.0.0',
      '20.0.0',
      '21.99.99',
      '27.0.0',
    ]) {
      const r = kb.lookup('node-idle-close', parseVersion(text));
      expect(r.matches, text).toEqual([]);
      expect(r.covered, text).toBe(false);
    }
  });

  it('a boundary version belongs to the range it starts, and not to the one below', () => {
    expect(kb.lookup('node-idle-close', parseVersion('22.19.0')).matches).toHaveLength(1);
    expect(kb.lookup('node-idle-close', parseVersion('24.22.3')).matches).toHaveLength(1);
  });

  it('returns every overlapping entry for an unknown version, and says it is not covered', () => {
    const r = kb.lookup('node-idle-close', unknownInterval());
    expect(r.matches.map((m) => m.entry.id)).toEqual(['line-22', 'line-24']);
    expect(r.covered).toBe(false);
  });

  it('a partial version that only half overlaps an entry is not covered', () => {
    const r = kb.lookup('node-idle-close', parseVersion('22'));
    expect(r.matches.map((m) => m.entry.id)).toEqual(['line-22']);
    expect(r.matches[0]?.overlap.lower).toEqual({ major: 22, minor: 19, patch: 0 });
    expect(r.covered).toBe(false); // 22.0.0 to 22.18.x has no entry
  });

  it('a partial version inside one entry is covered', () => {
    const r = kb.lookup('node-idle-close', parseVersion('22.23'));
    expect(r.covered).toBe(true);
  });

  it('does not return entries of another subject', () => {
    expect(kb.lookup('alb-idle-timeout', unknownInterval()).matches).toEqual([]);
  });

  it('property: matches are exactly the entries whose range contains a probed version, never a nearest one', () => {
    const rng = makeRng(8);
    for (let i = 0; i < 500; i += 1) {
      const major = rng.int(20, 27);
      const minor = rng.int(0, 30);
      const patch = rng.int(0, 5);
      const r = kb.lookup('node-idle-close', parseVersion(`${major}.${minor}.${patch}`));
      const in22 = major === 22 && (minor > 19 || (minor === 19 && patch >= 0));
      const in24 = major === 24 && (minor > 22 || (minor === 22 && patch >= 3));
      const ids = r.matches.map((m) => m.entry.id);
      expect(ids, `${major}.${minor}.${patch}`).toEqual(
        in22 ? ['line-22'] : in24 ? ['line-24'] : [],
      );
      expect(r.covered).toBe(in22 || in24);
    }
  });

  it('an empty interval matches nothing and is not covered', () => {
    const empty = {
      lower: { major: 5, minor: 0, patch: 0 },
      upper: { major: 5, minor: 0, patch: 0 },
    };
    expect(kb.lookup('node-idle-close', empty)).toEqual({ matches: [], covered: false });
  });
});

describe('conditions (worker class)', () => {
  const conditional = {
    id: 'gunicorn-keepalive-test',
    subject: 'gunicorn-keepalive',
    value: 2,
    unit: 's',
    applies: {
      runtime: 'gunicorn',
      versionRange: '*',
      condition: 'workerClass in [gthread, uvicorn]',
    },
    citationName: 'gunicorn keepalive',
    docUrl: 'https://example.invalid/',
    docDate: '2026-01-02',
    basis: 'documented',
    scriptRef: 'measure/g.mjs',
    toleranceMs: 4,
  };
  const kb = loadKnowledgeBase([file(conditional)]);

  it('applies when the fact matches and is skipped when it does not', () => {
    expect(
      kb.lookup('gunicorn-keepalive', unknownInterval(), { workerClass: 'uvicorn' }).covered,
    ).toBe(true);
    expect(
      kb.lookup('gunicorn-keepalive', unknownInterval(), { workerClass: 'sync' }).matches,
    ).toEqual([]);
  });

  it('with no fact it returns the entry flagged, and does not count it as covering', () => {
    const r = kb.lookup('gunicorn-keepalive', unknownInterval());
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.conditionUnverified).toBe(true);
    expect(r.covered).toBe(false);
  });
});

describe('basis words, PASS support and release blockers', () => {
  const entries = loadKbEntries([
    file(
      entry({
        id: 'm',
        basis: 'measured',
        measuredOn: { version: '22.23.2', date: '2026-01-02', platform: 'p' },
        rangeLabel: 'R',
      }),
      entry({
        id: 'd',
        basis: 'documented',
        applies: { runtime: 'node', versionRange: '>=23.0.0 <24.0.0' },
      }),
      entry({
        id: 's',
        basis: 'from-source',
        applies: { runtime: 'node', versionRange: '>=24.0.0 <25.0.0' },
      }),
      entry({
        id: 'c',
        basis: 'from-changelogs',
        applies: { runtime: 'node', versionRange: '>=25.0.0 <26.0.0' },
      }),
      entry({
        id: 't',
        basis: 'to-be-measured',
        applies: { runtime: 'node', versionRange: '>=26.0.0 <27.0.0' },
      }),
    ),
  ]);
  const byId = (id: string): KbEntry => {
    const e = entries.find((x) => x.id === id);
    if (!e) throw new Error(id);
    return e;
  };

  it('prints the interaction-spec basis words', () => {
    expect(citationFor(byId('m'))).toBe('default: Test source (R; measured on 22.23.2)');
    expect(citationFor(byId('d'))).toBe('default: Test source (documented)');
    expect(citationFor(byId('s'))).toBe('default: Test source (from source, not measured)');
    expect(citationFor(byId('c'))).toBe('default: Test source (from changelogs, not measured)');
    expect(citationFor(byId('t'))).toBe('default: Test source (to be measured)');
  });

  it('a to-be-measured entry loads but never supports PASS; the others may', () => {
    expect(supportsPass(byId('t'))).toBe(false);
    for (const id of ['m', 'd', 's', 'c']) expect(supportsPass(byId(id)), id).toBe(true);
  });

  it('lists to-be-measured entries as release blockers', () => {
    const kb = loadKnowledgeBase([
      file(
        entry({ id: 'a' }),
        entry({
          id: 'b',
          basis: 'to-be-measured',
          applies: { runtime: 'node', versionRange: '>=26.0.0 <27.0.0' },
        }),
      ),
    ]);
    expect(kb.releaseBlockers().map((e) => e.id)).toEqual(['b']);
  });

  const subject: WorkloadRef = {
    kind: 'Deployment',
    namespace: inputText('d'),
    name: inputText('w'),
  };

  it('a value built from a to-be-measured entry cannot support a PASS finding (end to end)', () => {
    const value = sourcedValueFromEntry(byId('t'));
    if (!value) throw new Error('expected a value');
    expect(value.basis).toBe('to-be-measured');
    const chain: ChainStep[] = [{ label: 'idle close', value }];
    const f = makeFinding({ rule: 'T1', subject, kind: 'PASS', headline: 'h', chain });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotionReason).toBe('to-be-measured-default');
  });

  it('a value built from a measured or documented entry may support a PASS', () => {
    for (const id of ['m', 'd', 's', 'c']) {
      const value = sourcedValueFromEntry(byId(id));
      if (!value) throw new Error('expected a value');
      const f = makeFinding({
        rule: 'T1',
        subject,
        kind: 'PASS',
        headline: 'h',
        chain: [{ label: 'x', value }],
      });
      expect(f.kind, id).toBe('PASS');
    }
  });

  it('an assumed default is never a PASS, whatever the entry basis', () => {
    const value = sourcedValueFromEntry(byId('d'), { assumed: true });
    if (!value) throw new Error('expected a value');
    expect(value.basis).toBe('assumed');
    expect(value.confidence).toBe('assumed');
    const f = makeFinding({
      rule: 'T1',
      subject,
      kind: 'PASS',
      headline: 'h',
      chain: [{ label: 'LB idle', value }],
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotionReason).toBe('assumed-value');
  });

  it('an n/a entry has no number to source', () => {
    const na = loadKbEntries([file(entry({ id: 'na', value: 'n/a' }))])[0];
    if (!na) throw new Error('expected an entry');
    expect(sourcedValueFromEntry(na)).toBeUndefined();
    expect(supportsPass(na)).toBe(false);
  });
});

describe('the shipped knowledge base (B0 seeds)', () => {
  const kb = defaultKnowledgeBase();
  const get = (id: string): KbEntry => {
    const e = kb.entry(id);
    if (!e) throw new Error(`missing seed ${id}`);
    return e;
  };

  it('loads, and is validated by the same loader: every entry of every data file is loaded, once', () => {
    // Computed from the data files, not listed by hand (B16): a new entry needs no edit here, and a data
    // file that default-knowledge-base.ts does not import (or an entry the loader drops) still fails.
    const dir = join(import.meta.dirname, '..', '..', 'src', 'kb', 'data');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const fromFiles = files
      .flatMap(
        (f) =>
          (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { entries: { id: string }[] }).entries,
      )
      .map((e) => e.id)
      .sort();
    const loaded = kb.entries.map((e) => e.id).sort();
    expect(new Set(loaded).size, 'ids are unique').toBe(loaded.length);
    expect(loaded).toEqual(fromFiles);
    for (const id of loaded) expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // a few anchors, so an emptied folder cannot pass
    for (const id of [
      'alb-idle-timeout-default',
      'node-idle-close-22x',
      'uvicorn-keepalive-0-54x',
    ]) {
      expect(loaded, id).toContain(id);
    }
  });

  it('the default idle close, one entry per release line from the lowest measured version (bolt B3)', () => {
    const expected: [string, number, string, string][] = [
      ['node-idle-close-18x', 5, '>=18.20.8 <19.0.0', '18.20.8'],
      ['node-idle-close-20x', 6, '>=20.20.2 <21.0.0', '20.20.2'],
      ['node-idle-close-22x', 6, '>=22.12.0 <23.0.0', '22.23.5'],
      ['node-idle-close-24x', 6, '>=24.0.0 <25.0.0', '24.22.3'],
      ['node-idle-close-26x', 6, '>=26.0.0 <27.0.0', '26.13.1'],
    ];
    for (const [id, value, range, measured] of expected) {
      const e = get(id);
      expect(e.value, id).toBe(value);
      expect(e.unit, id).toBe('s');
      expect(e.applies.versionRange, id).toBe(range);
      expect(e.basis, id).toBe('measured');
      expect(e.measuredOn?.version, id).toBe(measured);
      // the exact figure is derived from the result files in tolerance-evidence.test.ts
      expect(e.toleranceMs, id).toBeGreaterThanOrEqual(4);
      expect(e.toleranceMs, id).toBeLessThan(100);
      // The notes cite the lines the value rests on and say the interior was not measured release by release.
      // names a result file that exists (B16: not a fixed date, so an entry measured on another day passes)
      const named = [
        ...String(e.notes).matchAll(/measure\/results\/([\w.-]+\.(?:jsonl|txt))/g),
      ].map((m) => m[1] as string);
      expect(named.length, `${id}: notes name a result file`).toBeGreaterThan(0);
      for (const f of named) {
        expect(existsSync(join(RESULTS_DIR, f)), `${id}: ${f} exists`).toBe(true);
      }
      expect(e.notes, id).toContain('not measured release by release');
    }
  });

  it('the explicit-setting entries carry their measured span in seconds', () => {
    const span = (id: string) => get(id).measuredSpan;
    for (const id of ['22x', '24x', '26x']) {
      expect(span(`node-explicit-keepalive-${id}`)).toEqual({ min: 7, max: 65 });
      // buffer 1000: K = 7 s only; buffer 0: K = 7 and 65 s
      expect(span(`node-explicit-buffer-${id}-1`)).toEqual({ min: 7, max: 7 });
      expect(span(`node-explicit-buffer-${id}-0`)).toEqual({ min: 7, max: 65 });
    }
    // 18.x and 20.x: K = 7, 12 and 65 s were each measured on the one release run (B3 points).
    expect(span('node-explicit-keepalive-18x')).toEqual({ min: 7, max: 65 });
    expect(span('node-explicit-keepalive-20x')).toEqual({ min: 7, max: 65 });
    // 18.x closes at exactly K; every later line adds one second.
    expect(get('node-explicit-keepalive-18x').value).toBe(0);
    for (const id of ['20x', '22x', '24x', '26x']) {
      expect(get(`node-explicit-keepalive-${id}`).value, id).toBe(1);
    }
  });

  it('the buffer property entries start where the property first appears', () => {
    expect(get('node-explicit-buffer-22x-0').applies.versionRange).toBe('>=22.19.0 <23.0.0');
    expect(get('node-explicit-buffer-24x-0').applies.versionRange).toBe('>=24.6.0 <25.0.0');
    expect(get('node-explicit-buffer-26x-0').applies.versionRange).toBe('>=26.0.0 <27.0.0');
  });

  it('the old-Node headersTimeout trap is from changelogs, not measured', () => {
    const expected: [string, number, string][] = [
      ['node-headers-trap-10x', 40, '>=10.15.2 <11.0.0'],
      ['node-headers-trap-12x', 60, '>=12.0.0 <12.19.0'],
      ['node-headers-trap-13x', 60, '>=13.0.0 <13.13.0'],
    ];
    for (const [id, value, range] of expected) {
      const e = get(id);
      expect(e.basis, id).toBe('from-changelogs');
      expect(e.value, id).toBe(value);
      expect(e.applies.versionRange, id).toBe(range);
      expect(supportsPass(e), id).toBe(true);
      expect(basisWords(e), id).toBe('from changelogs, not measured');
    }
  });

  it('ALB idle default: 60 s, documented, with a stated reason in place of a script', () => {
    const e = get('alb-idle-timeout-default');
    expect(e.value).toBe(60);
    expect(e.basis).toBe('documented');
    expect(e.scriptRef).toEqual({ notMeasurableLocally: expect.stringContaining('localhost') });
    expect(e.docUrl).toBe(
      'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html',
    );
    expect(e.docDate).toBe('2026-11-11');
  });

  it('prints the expected report layout citation for the demo version', () => {
    const r = lookup('node-idle-close', parseVersion('22.23'));
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.citation).toBe(
      'default: Node keepAliveTimeout 5 s + 1 s (Node 22.x from 22.12; measured on 5 releases from 22.12.0 to 22.23.5)',
    );
    expect(r.covered).toBe(true);
  });

  it('prints the ALB citation of the expected report layout', () => {
    const r = lookup('alb-idle-timeout', unknownInterval());
    expect(r.matches[0]?.citation).toBe('default: ALB idle timeout (AWS docs, ALB; documented)');
  });

  it('gives no entry, and so UNRESOLVED upstream, for Node versions below each measured lower bound', () => {
    for (const text of [
      '18.20.7',
      '18.19.0',
      '20.11.0',
      '20.20.1',
      '22.11.0',
      '22.12', // 22.12.0 is the lower bound: the partial 22.12 is covered, 22.11 is not
      '24.0', // 24.0.0 is the lower bound
      '17.9.0',
      '19.9.0',
      '21.7.0',
      '23.5.0',
      '25.1.0',
      '27.0.0',
    ]) {
      const r = lookup('node-idle-close', parseVersion(text));
      const covered = text === '22.12' || text === '24.0';
      expect(r.matches.length > 0, text).toBe(covered);
      expect(r.covered, text).toBe(covered);
    }
  });

  it('gives the entry for the measured versions and above, up to the end of the line', () => {
    for (const text of [
      '18.20.8',
      '18.99.0',
      '20.20.2',
      '20.99.9',
      '22.12.0',
      '22.18.0',
      '22.19.0',
      '22.23.2',
      '22.23.5',
      '22.99.0',
      '24.0.0',
      '24.5.0',
      '24.22.3',
      '24.30.0',
      '26.0.0',
      '26.13.1',
      '26.99.9',
    ]) {
      const r = lookup('node-idle-close', parseVersion(text));
      expect(r.matches, text).toHaveLength(1);
      expect(r.covered, text).toBe(true);
    }
  });

  it('a bare major tag like node:22 matches but is not covered, so it cannot be resolved by this entry alone', () => {
    const r = lookup('node-idle-close', parseVersion('22'));
    expect(r.matches).toHaveLength(1);
    expect(r.covered).toBe(false);
  });

  it('no seed is to-be-measured, and none says measured without a version and date', () => {
    expect(kb.releaseBlockers()).toEqual([]);
    for (const e of kb.entries) {
      if (e.basis === 'measured') {
        expect(e.measuredOn?.version, e.id).toBeTruthy();
        expect(e.measuredOn?.date, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('the Node entries do not overlap each other: each lower bound matches only its own entry', () => {
    const nodes = kb.entries.filter((e) => e.subject === 'node-idle-close');
    expect(nodes.length).toBeGreaterThanOrEqual(5);
    for (const e of nodes) {
      const lowerText = e.applies.versionRange.slice(2, e.applies.versionRange.indexOf(' '));
      const r = lookup('node-idle-close', parseVersion(lowerText));
      expect(r.matches.map((m) => m.entry.id)).toEqual([e.id]);
    }
  });
});
