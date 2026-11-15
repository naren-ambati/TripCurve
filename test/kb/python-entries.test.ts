// The gunicorn and uvicorn entries (bolt B2): every value comes from a measurement, with the
// version it was measured on, and a release no entry covers has no match.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pythonKb from '../../src/kb/data/python-servers.json' with { type: 'json' };
import {
  citationFor,
  defaultKnowledgeBase,
  loadKnowledgeBase,
  parseVersion,
  supportsPass,
  unknownInterval,
} from '../../src/kb/index.js';

const kb = defaultKnowledgeBase();
const ROOT = join(import.meta.dirname, '..', '..');
const JSONL = (name: string) =>
  readFileSync(join(ROOT, 'measure', 'results', name), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          entry: string;
          version: string;
          measured: Record<string, number | boolean>;
        },
    );

function entry(id: string) {
  const e = kb.entry(id);
  if (e === undefined) throw new Error(`missing ${id}`);
  return e;
}

describe('gunicorn with the uvicorn worker: 2 s, measured on 26.2.0 and on 27.0.0', () => {
  it('prints the citation of the expected report layout', () => {
    expect(citationFor(entry('gunicorn-keepalive-uvicorn-worker-26x'))).toBe(
      'default: gunicorn keepalive, uvicorn worker (gunicorn 26.x; measured on 26.2.0)',
    );
    expect(citationFor(entry('gunicorn-keepalive-uvicorn-worker-27x'))).toBe(
      'default: gunicorn keepalive, uvicorn worker (gunicorn 27.x; measured on 27.0.0)',
    );
  });

  it('covers one release line from the measured version up, and nothing older', () => {
    const at = (v: string) =>
      kb
        .lookup('gunicorn-keepalive', parseVersion(v), { workerClass: 'uvicorn' })
        .matches.map((m) => m.entry.id);
    expect(at('26.2.0')).toEqual(['gunicorn-keepalive-uvicorn-worker-26x']);
    expect(at('26.2.2')).toEqual(['gunicorn-keepalive-uvicorn-worker-26x']);
    expect(at('26.1.0')).toEqual([]);
    expect(at('27.0.0')).toEqual(['gunicorn-keepalive-uvicorn-worker-27x']);
    expect(at('28.0.0')).toEqual([]);
    expect(at('25.9.0')).toEqual([]);
  });

  it('every value is a number backed by the measured lines of the results files', () => {
    const b0 = JSONL('2026-11-11-b0.jsonl').filter(
      (r) => r.entry === 'gunicorn-keepalive-uvicorn-worker',
    );
    expect(b0.map((r) => r.measured.idleCloseMs)).toEqual([2002, 2001, 2003, 2002, 2001, 2003]);
    for (const id of [
      'gunicorn-keepalive-uvicorn-worker-26x',
      'gunicorn-keepalive-uvicorn-worker-27x',
    ]) {
      const e = entry(id);
      expect(e.value).toBe(2);
      expect(e.basis).toBe('measured');
      expect(e.toleranceMs).toBe(6);
      expect(supportsPass(e)).toBe(true);
    }
  });
});

describe('gunicorn gthread: 2 s, measured on 26.2.0 and on 27.0.0 (bolt B2)', () => {
  it('prints the gthread citation', () => {
    expect(citationFor(entry('gunicorn-keepalive-gthread-26x'))).toBe(
      'default: gunicorn keepalive, gthread worker (gunicorn 26.x; measured on 26.2.0)',
    );
  });

  it('matches the gthread class only, never the uvicorn worker or gevent', () => {
    const v = parseVersion('26.2.0');
    const ids = (cls: string) =>
      kb.lookup('gunicorn-keepalive', v, { workerClass: cls }).matches.map((m) => m.entry.id);
    expect(ids('gthread')).toEqual(['gunicorn-keepalive-gthread-26x']);
    expect(ids('uvicorn')).toEqual(['gunicorn-keepalive-uvicorn-worker-26x']);
    expect(ids('gevent')).toEqual([]);
    expect(ids('eventlet')).toEqual([]);
    expect(ids('tornado')).toEqual([]);
  });

  it('the values equal the measured lines (2.0 s, within the tolerance)', () => {
    const b2 = JSONL('2026-11-11-b2.jsonl');
    const gthread = b2.filter((r) => r.entry === 'gunicorn-gthread-default');
    expect(gthread).toHaveLength(12);
    const worst = Math.max(
      ...gthread.map((r) => Math.abs((r.measured.idleCloseMs as number) - 2000)),
    );
    expect(worst).toBeLessThanOrEqual(5);
    for (const id of ['gunicorn-keepalive-gthread-26x', 'gunicorn-keepalive-gthread-27x']) {
      const e = entry(id);
      expect(e.value).toBe(2);
      expect(e.toleranceMs).toBeGreaterThanOrEqual(worst + 1);
    }
  });
});

describe('gunicorn sync worker: not applicable, measured on 26.2.0 and 27.0.0', () => {
  it('the cited lines show Connection: close and a close at 0 ms in every run', () => {
    const lines = JSONL('2026-11-11-b2.jsonl').filter((r) => r.entry === 'gunicorn-sync-worker');
    expect(lines).toHaveLength(6);
    for (const r of lines) {
      expect(r.measured.closesAfterResponse).toBe(true);
      expect(r.measured.connectionCloseHeader).toBe(true);
      expect(r.measured.closeMs).toBe(0);
    }
  });

  it('the entries hold no number and never support PASS', () => {
    for (const id of ['gunicorn-sync-worker-26x', 'gunicorn-sync-worker-27x']) {
      const e = entry(id);
      expect(e.value).toBe('n/a');
      expect(e.basis).toBe('measured');
      expect(supportsPass(e)).toBe(false);
    }
  });
});

describe('uvicorn alone: 5 s, measured on 0.54.0', () => {
  it('prints its citation and covers only the 0.54 line', () => {
    const e = entry('uvicorn-keepalive-0-54x');
    expect(citationFor(e)).toBe('default: uvicorn keepalive (uvicorn 0.54.x; measured on 0.54.0)');
    expect(e.value).toBe(5);
    expect(e.toleranceMs).toBe(4);
    const at = (v: string) =>
      kb.lookup('uvicorn-keepalive', parseVersion(v)).matches.map((m) => m.entry.id);
    expect(at('0.54.0')).toEqual(['uvicorn-keepalive-0-54x']);
    expect(at('0.53.9')).toEqual([]);
    expect(at('0.55.0')).toEqual([]);
  });
});

describe('an unknown release is never matched to a measured range', () => {
  it('the unknown interval overlaps the entries but is not covered', () => {
    const r = kb.lookup('gunicorn-keepalive', unknownInterval(), { workerClass: 'uvicorn' });
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.covered).toBe(false);
    expect(kb.lookup('uvicorn-keepalive', unknownInterval()).covered).toBe(false);
  });

  it('no entry is a placeholder: none is `to be measured`', () => {
    expect(kb.releaseBlockers()).toEqual([]);
  });
});

describe('explicit keepalive entries (bolt B2): the idle close equals the setting where measured', () => {
  const b2 = JSONL('2026-11-11-b2.jsonl') as unknown as Array<{
    entry: string;
    version: string;
    case?: { sources?: Record<string, unknown>; args?: string };
    measured: { idleCloseMs: number };
  }>;
  const explicit = JSONL('2026-11-11-b2-explicit.jsonl') as unknown as typeof b2;
  const ids = [
    'gunicorn-explicit-keepalive-uvicorn-worker-26x',
    'gunicorn-explicit-keepalive-uvicorn-worker-27x',
    'gunicorn-explicit-keepalive-gthread-26x',
    'gunicorn-explicit-keepalive-gthread-27x',
  ];

  it('each entry is measured, holds no default number, and never supports a default verdict', () => {
    for (const id of ids) {
      const e = entry(id);
      expect(e.subject).toBe('gunicorn-keepalive-explicit');
      expect(e.basis).toBe('measured');
      expect(e.value).toBe('n/a');
      expect(supportsPass(e)).toBe(false);
    }
  });

  it('covers one release line from the measured version up, per class', () => {
    const at = (v: string, cls: string) =>
      kb
        .lookup('gunicorn-keepalive-explicit', parseVersion(v), { workerClass: cls })
        .matches.map((m) => m.entry.id);
    expect(at('26.2.0', 'uvicorn')).toEqual(['gunicorn-explicit-keepalive-uvicorn-worker-26x']);
    expect(at('27.3.0', 'gthread')).toEqual(['gunicorn-explicit-keepalive-gthread-27x']);
    expect(at('26.1.9', 'gthread')).toEqual([]);
    expect(at('26.2.0', 'gevent')).toEqual([]);
    expect(at('26.2.0', 'sync')).toEqual([]);
    expect(
      kb
        .lookup('uvicorn-keepalive-explicit', parseVersion('0.54.3'))
        .matches.map((m) => m.entry.id),
    ).toEqual(['uvicorn-explicit-keepalive-0-54x']);
    expect(kb.lookup('uvicorn-keepalive-explicit', parseVersion('0.53.0')).matches).toEqual([]);
    expect(kb.lookup('uvicorn-keepalive-explicit', parseVersion('0.55.0')).matches).toEqual([]);
  });

  it('the cited lines are what the entries say: every idle close is at or above the setting, within the tolerance', () => {
    const within = (lines: typeof b2, nominalMs: number, tolerance: number) => {
      expect(lines.length).toBeGreaterThan(0);
      for (const r of lines) {
        expect(r.measured.idleCloseMs).toBeGreaterThanOrEqual(nominalMs);
        expect(r.measured.idleCloseMs).toBeLessThanOrEqual(nominalMs + tolerance - 1);
      }
    };
    const sources = (line: (typeof b2)[number]) => JSON.stringify(line.case?.sources ?? {});
    // uvicorn worker, B2 lines 13 to 24 (26.2.0) and 76 to 87 (27.0.0): 3, 5, 7, 9 s
    for (const [from, to, v, tol] of [
      [13, 24, '26.2.0', 6],
      [76, 87, '27.0.0', 6],
    ] as const) {
      const lines = b2.slice(from - 1, to);
      for (const r of lines) expect(r.version).toContain(v);
      for (const [key, s] of [
        ['cli', 3],
        ['env', 5],
        ['file', 7],
        ['default', 9],
      ] as const) {
        within(
          lines.filter((r) => sources(r) === JSON.stringify({ [key]: s })),
          s * 1000,
          tol,
        );
      }
    }
    // gthread: the tolerance is proportional (toleranceRelative x value + 1 ms), derived in the entry notes
    const rel = entry('gunicorn-explicit-keepalive-gthread-26x').toleranceRelative ?? 0;
    expect(rel).toBe(0.004);
    const proportional = (seconds: number) => Math.round(seconds * 1000 * rel) + 1;
    expect(proportional(300)).toBe(1201);
    // explicit lines 1 to 6 (26.2.0) and 7 to 12 (27.0.0): 7 s and 75 s; 300 s in the -300 file
    for (const [from, to, v] of [
      [1, 6, '26.2.0'],
      [7, 12, '27.0.0'],
    ] as const) {
      const lines = explicit.slice(from - 1, to);
      for (const r of lines) expect(r.version).toBe(`gunicorn ${v}`);
      within(
        lines.filter((r) => r.case?.args?.endsWith('keep-alive 7')),
        7000,
        proportional(7),
      );
      within(
        lines.filter((r) => r.case?.args?.endsWith('keep-alive 75')),
        75000,
        proportional(75),
      );
    }
    const at300 = JSONL('2026-11-11-b2-explicit-300.jsonl') as unknown as typeof b2;
    const gthread300 = at300.filter((r) => r.entry === 'gunicorn-gthread-explicit-keepalive');
    expect(gthread300).toHaveLength(4);
    within(gthread300, 300000, proportional(300));
    // the uvicorn worker and uvicorn alone at 300 s
    const worker300 = at300.filter((r) => r.entry === 'gunicorn-uvicorn-worker-explicit-keepalive');
    expect(worker300).toHaveLength(4);
    within(worker300, 300000, 6);
    const alone300 = at300.filter((r) => r.entry === 'uvicorn-explicit-keepalive');
    expect(alone300).toHaveLength(2);
    within(alone300, 300000, 6);
    // uvicorn alone, explicit lines 16 to 27: 7 s from the flag and from the environment
    const alone = explicit.slice(15, 27);
    expect(alone).toHaveLength(12);
    for (const r of alone) expect(r.version).toBe('uvicorn 0.54.0');
    within(alone, 7000, entry('uvicorn-explicit-keepalive-0-54x').toleranceMs ?? 0);
    // the uvicorn worker on 27.0.0 at 75 s, explicit lines 13 to 15
    const worker75 = explicit.slice(12, 15);
    for (const r of worker75) expect(r.version).toContain('gunicorn 27.0.0');
    within(worker75, 75000, 6);
    expect(entry('gunicorn-explicit-keepalive-gthread-26x').toleranceMs).toBe(1201);
    expect(entry('gunicorn-explicit-keepalive-gthread-27x').toleranceMs).toBe(1201);
  });
});

describe('measured spans of the explicit entries', () => {
  const span = (id: string) => entry(id).measuredSpan;
  it('each explicit entry records the smallest and largest explicit value measured', () => {
    expect(span('gunicorn-explicit-keepalive-uvicorn-worker-26x')).toEqual({ min: 3, max: 300 });
    expect(span('gunicorn-explicit-keepalive-uvicorn-worker-27x')).toEqual({ min: 3, max: 300 });
    expect(span('gunicorn-explicit-keepalive-gthread-26x')).toEqual({ min: 7, max: 300 });
    expect(span('gunicorn-explicit-keepalive-gthread-27x')).toEqual({ min: 7, max: 300 });
    expect(span('uvicorn-explicit-keepalive-0-54x')).toEqual({ min: 7, max: 300 });
  });

  it('the loader refuses an explicit entry with no span, or a span on another entry', () => {
    const base = JSON.parse(JSON.stringify((pythonKb as { entries: unknown[] }).entries)) as Array<
      Record<string, unknown>
    >;
    const explicit = base.find((e) => e.id === 'uvicorn-explicit-keepalive-0-54x') as Record<
      string,
      unknown
    >;
    const { measuredSpan: _drop, ...without } = explicit;
    expect(() => loadKnowledgeBase([{ schemaVersion: 1, entries: [without] }])).toThrow(
      /measuredSpan/,
    );
    const plain = base.find((e) => e.id === 'uvicorn-keepalive-0-54x') as Record<string, unknown>;
    expect(() =>
      loadKnowledgeBase([
        { schemaVersion: 1, entries: [{ ...plain, measuredSpan: { min: 1, max: 2 } }] },
      ]),
    ).toThrow(/measuredSpan/);
    expect(() =>
      loadKnowledgeBase([
        { schemaVersion: 1, entries: [{ ...explicit, measuredSpan: { min: 9, max: 3 } }] },
      ]),
    ).toThrow(/measuredSpan/);
  });

  it('the loader refuses a relative tolerance that is not a fraction', () => {
    const e = (kb.entry('gunicorn-explicit-keepalive-gthread-26x') ?? {}) as Record<
      string,
      unknown
    >;
    for (const bad of [0, 1, 2, -0.1, '0.2']) {
      expect(() =>
        loadKnowledgeBase([{ schemaVersion: 1, entries: [{ ...e, toleranceRelative: bad }] }]),
      ).toThrow(/toleranceRelative/);
    }
  });

  it('the values the span ends name were measured in the cited files', () => {
    const b2 = JSONL('2026-11-11-b2.jsonl') as unknown as Array<{
      case?: { sources?: Record<string, number> };
    }>;
    const seen = new Set(b2.flatMap((r) => Object.values(r.case?.sources ?? {})));
    expect(seen.has(3)).toBe(true);
  });
});

describe('httptools evidence in the notes (round 4): identical to h11 within a few ms', () => {
  const rows = JSONL('2026-11-11-b2-httptools.jsonl') as unknown as Array<{
    entry: string;
    case?: { args?: string };
    observed?: { protocolClass?: string };
    measured: { idleCloseMs: number };
  }>;

  it('every line was served by the implementation it says, and is within 5 ms above the nominal value', () => {
    expect(rows).toHaveLength(36);
    const nominal = (args: string): number => {
      const m = /(?:--keep-alive|--timeout-keep-alive) (\d+)/.exec(args);
      if (m) return Number(m[1]) * 1000;
      return args.includes('--http') || args === '(none)'
        ? args === '(none)'
          ? 2000
          : 5000
        : 5000;
    };
    for (const [i, r] of rows.entries()) {
      const args = r.case?.args ?? '';
      const want = r.entry.startsWith('gunicorn')
        ? /keep-alive (\d+)/.exec(args)
          ? nominal(args)
          : 2000
        : nominal(args);
      expect(r.measured.idleCloseMs, `line ${i + 1}`).toBeGreaterThanOrEqual(want);
      expect(r.measured.idleCloseMs, `line ${i + 1}`).toBeLessThanOrEqual(want + 5);
    }
    const classes = new Set(rows.map((r) => r.observed?.protocolClass?.split('.').pop()));
    expect([...classes].sort()).toEqual(['H11Protocol', 'HttpToolsProtocol']);
  });

  it('the entries cite the file and the uvloop caveat', () => {
    for (const id of [
      'gunicorn-keepalive-uvicorn-worker-26x',
      'gunicorn-explicit-keepalive-uvicorn-worker-27x',
      'uvicorn-keepalive-0-54x',
      'uvicorn-explicit-keepalive-0-54x',
    ]) {
      const notes = entry(id).notes ?? '';
      expect(notes, id).toContain('2026-11-11-b2-httptools.jsonl');
      expect(notes, id).toContain('uvloop');
    }
  });
});
