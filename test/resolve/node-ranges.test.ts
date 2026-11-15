// planNodeRanges: one candidate per range, gaps and rules included. The
// ranges are data: the same code gives a different answer for a different knowledge base, and the
// shipped entries are checked at their own edges.
import { describe, expect, it } from 'vitest';
import {
  fileSource,
  inputText,
  isUnresolved,
  makeSourcedValue,
  type SourcedValue,
} from '../../src/core/index.js';
import {
  defaultKnowledgeBase,
  loadKnowledgeBase,
  parseVersion,
  unknownInterval,
} from '../../src/kb/index.js';
import { type NodeIdleSettings, planNodeRanges } from '../../src/resolve/node-ranges.js';

const FILE = fileSource(inputText('src/server.js'), 4);
const ms = (n: number): SourcedValue =>
  makeSourcedValue({ value: n, unit: 'ms', source: FILE, basis: 'declared' });
const NONE: NodeIdleSettings = { notBeforeListen: [] };

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    subject: 'node-idle-close',
    value: 6,
    unit: 's',
    citationName: 'Test source',
    docUrl: 'https://example.test/node',
    docDate: '2026-11-11',
    basis: 'measured',
    measuredOn: { version: '1.0.0', date: '2026-11-11', platform: 'test' },
    scriptRef: 'measure/x.mjs',
    toleranceMs: 4,
    ...over,
  };
}

function kbOf(...entries: Record<string, unknown>[]) {
  return loadKnowledgeBase([{ schemaVersion: 1, entries }]);
}

const LINE = (n: number, over: Record<string, unknown> = {}) =>
  entry({
    id: `idle-${n}x`,
    applies: { runtime: 'node', versionRange: `>=${n}.0.0 <${n + 1}.0.0` },
    rangeLabel: `Test ${n}.x`,
    ...over,
  });

const shown = (cs: ReturnType<typeof planNodeRanges>) =>
  cs.map((c) => [c.condition, isUnresolved(c.value) ? `? ${c.value.reason}` : c.value.value]);

describe('the ranges are data', () => {
  const plan = (kb: ReturnType<typeof kbOf>, version: string) =>
    planNodeRanges({
      interval: version === 'any' ? unknownInterval() : parseVersion(version),
      versionLabel: `Node ${version}`,
      kb,
      settings: NONE,
    });

  it('one entry per release line gives one candidate per line and one per gap', () => {
    const kb = kbOf(LINE(20, { value: 5 }), LINE(22));
    expect(shown(plan(kb, 'any'))).toEqual([
      ['before 20', '? no knowledge-base entry covers this range'],
      ['Test 20.x', 5],
      ['21 to before 22', '? no knowledge-base entry covers this range'],
      ['Test 22.x', 6],
      ['23 and later', '? no knowledge-base entry covers this range'],
    ]);
  });

  it('a different knowledge base changes the answer with no change to the code', () => {
    const narrow = kbOf(LINE(22));
    const wide = kbOf(
      LINE(22),
      entry({
        id: 'idle-21x',
        applies: { runtime: 'node', versionRange: '>=21.0.0 <22.0.0' },
        rangeLabel: 'Test 21.x',
      }),
    );
    expect(plan(narrow, '21.4')).toHaveLength(1);
    expect(isUnresolved(plan(narrow, '21.4')[0]?.value as never)).toBe(true);
    expect(plan(wide, '21.4').map((c) => c.value && !isUnresolved(c.value))).toEqual([true]);
  });

  it('a lone gap names the version asked about', () => {
    const [only] = plan(kbOf(LINE(22)), '20.11');
    expect(only && isUnresolved(only.value) && only.value.reason).toBe(
      'no knowledge-base entry covers Node 20.11',
    );
    expect(only?.supportsPass).toBe(false);
  });

  it('a partial version overlapping two ranges gets both, none dropped', () => {
    const kb = kbOf(
      entry({
        id: 'a',
        applies: { runtime: 'node', versionRange: '>=22.0.0 <22.10.0' },
        rangeLabel: 'Test A',
        value: 5,
      }),
      entry({
        id: 'b',
        applies: { runtime: 'node', versionRange: '>=22.10.0 <23.0.0' },
        rangeLabel: 'Test B',
        value: 6,
      }),
    );
    expect(shown(plan(kb, '22'))).toEqual([
      ['Test A', 5],
      ['Test B', 6],
    ]);
  });

  it('a `to be measured` entry is a candidate that cannot support PASS', () => {
    const kb = kbOf(LINE(22, { basis: 'to-be-measured', measuredOn: undefined }));
    const [c] = plan(kb, '22.1');
    expect(c?.supportsPass).toBe(false);
    expect(c?.basis).toBe('to-be-measured');
  });
});

describe('the shipped entries at their own edges', () => {
  const kb = defaultKnowledgeBase();
  const plan = (version: string, settings: NodeIdleSettings) =>
    planNodeRanges({
      interval: parseVersion(version),
      versionLabel: `Node ${version}`,
      kb,
      settings,
    });
  const value = (c: ReturnType<typeof planNodeRanges>[number] | undefined) =>
    c !== undefined && !isUnresolved(c.value) ? c.value.value : undefined;

  it('K at the smallest and largest measured value is K + 1 s; one ms outside is UNRESOLVED', () => {
    for (const version of ['22.23.2', '24.22.3', '26.13.1']) {
      const at = (k: number) => plan(version, { keepAlive: ms(k), notBeforeListen: [] })[0];
      expect(value(at(7000)), version).toBe(8);
      expect(value(at(65000)), version).toBe(66);
      expect(value(at(65001)), version).toBeUndefined();
      expect(value(at(6999)), version).toBeUndefined();
    }
  });

  it('the line where the second is not there (18.x) is exactly K, from 7 to 65 s', () => {
    const at = (k: number) => plan('18.20.8', { keepAlive: ms(k), notBeforeListen: [] })[0];
    expect(value(at(7000))).toBe(7);
    expect(value(at(65000))).toBe(65);
    expect(value(at(65001))).toBeUndefined();
  });

  it('every explicit entry is checked at its first measured version: the rule and its basis words', () => {
    for (const e of kb.entries.filter((x) => x.subject === 'node-keepalive-explicit')) {
      const lower = e.applies.versionRange.slice(2, e.applies.versionRange.indexOf(' '));
      const k = (e.measuredSpan?.min ?? 7) * 1000;
      const c = plan(lower, { keepAlive: ms(k), notBeforeListen: [] })[0];
      expect(value(c), e.id).toBe(k / 1000 + (e.value as number));
      expect(c?.supportsPass, e.id).toBe(true);
      expect(c?.basis, e.id).toBe('measured');
      expect(c?.decidedBy, e.id).toEqual(FILE);
    }
  });

  it('a released version in no range is UNRESOLVED for an explicit setting too', () => {
    for (const version of ['17.9.0', '19.1.0', '21.1.0', '23.1.0', '25.1.0', '27.0.0']) {
      const [c] = plan(version, { keepAlive: ms(65000), notBeforeListen: [] });
      expect(c && isUnresolved(c.value), version).toBe(true);
    }
  });
});
