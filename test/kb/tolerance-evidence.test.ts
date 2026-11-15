// B8: a stated tolerance is the largest observed deviation plus the resolution (the B1 rule,
// docs/limits.md), over the recorded observations of the entry. This test recomputes every
// tolerance B8 derived from the result files, so a tolerance that a recorded run exceeds, one that
// is wider than the rule gives, or one chosen by hand, fails here.
//
// Which observations count (B8): only runs made one at a time, because the lane now
// runs one script at a time and a timing taken beside another timing is not taken under the
// lane's conditions. Parallel runs stay in the folder as evidence and are not a basis. Every
// result file must be listed below, so a new file has to be classified before this test passes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derivedToleranceMs, inRange, parseRange } from '../../measure/lib/lanes-core.mjs';
import { defaultKnowledgeBase } from '../../src/kb/index.js';

const RESULTS = join(import.meta.dirname, '..', '..', 'measure', 'results');
const kb = defaultKnowledgeBase();

/** Taken one script at a time: B2 (run-b2*.sh run one case after another) and the B8 lane runs at --jobs=1 or alone. */
const BASIS = new Set([
  '2026-11-11-b0.jsonl',
  '2026-11-11-b2.jsonl',
  '2026-11-11-b2-explicit.jsonl',
  '2026-11-11-b2-httptools.jsonl',
  '2026-11-11-b3.jsonl',
  '2026-11-11-b3-points.jsonl',
  '2026-11-11-b3-versions.jsonl',
  '2026-11-12-lanes-pinned.jsonl',
  '2026-11-12-lanes-pinned-pre-review.jsonl',
  '2026-11-12-lanes-latest.jsonl',
  '2026-11-12-lanes-latest-pre-review.jsonl',
  '2026-11-12-lanes-latest-isolated.jsonl',
  '2026-11-12-lanes-tolerance-observations-jobs1.jsonl',
  '2026-11-12-lanes-review-observations-jobs1.jsonl',
  '2026-11-12-lanes-review-observations2-jobs1.jsonl',
]);
/** Taken beside other timings: run-b2-explicit-300.sh runs five cases at once, run-b4.sh and run-b4-more.sh run two or three lanes at once, and the lane runs at --jobs=2 and --jobs=4. */
const EVIDENCE_ONLY = new Set([
  '2026-11-11-b2-explicit-300.jsonl',
  '2026-11-11-b4.jsonl',
  '2026-11-11-b4-more.jsonl',
  '2026-11-12-lanes-pinned-jobs2.jsonl',
  '2026-11-12-lanes-pinned-jobs4.jsonl',
  '2026-11-12-lanes-latest-jobs2.jsonl',
  // taken while the lane default was 2: its two cases (the 5 s ceiling and the no-ceiling one) ran at once
  '2026-11-12-lanes-tolerance-observations-jobs2-uvicorn.jsonl',
  // a --jobs=1 run taken after the load-line code existed but with no load line kept: unknown load cannot meet the basis bar (B8 second)
  '2026-11-12-lanes-pinned-review-run1-fail.jsonl',
  // the B15 release-check run: quiet host, --jobs=1, but added after the tolerances were derived; kept as evidence, not as a basis
  '2026-11-12-lanes-pinned-b15.jsonl',
  // the B26 release-check run of the latest lane (2026-11-15, quiet host, --jobs=1, LANE PASS, exit 0): added after the tolerances were derived; evidence, not a basis
  '2026-11-15-lanes-latest-b26.jsonl',
]);

/** A run made while the host load was high (or aborted for it) is evidence, never a basis. */
const isEvidence = (f: string) =>
  EVIDENCE_ONLY.has(f) || /-busy\.jsonl$|-loaded-[a-z]+\.jsonl$/.test(f);

interface Obs {
  readonly file: string;
  readonly version: string;
  readonly valueS: number;
  readonly deviationMs: number;
}
type Line = { file: string; r: Record<string, unknown> };

function lines(files: (f: string) => boolean): Line[] {
  const out: Line[] = [];
  for (const file of readdirSync(RESULTS).filter((f) => f.endsWith('.jsonl') && files(f))) {
    for (const l of readFileSync(join(RESULTS, file), 'utf8').split('\n')) {
      if (l.trim() !== '') out.push({ file, r: JSON.parse(l) as Record<string, unknown> });
    }
  }
  return out;
}
const basisLines = () => lines((f) => BASIS.has(f));
const num = (v: unknown): number => Number(v);
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;

function gthread(major: string, from: Line[]): Obs[] {
  const obs: Obs[] = [];
  for (const { file, r } of from) {
    if (r.entry !== 'gunicorn-gthread-explicit-keepalive') continue;
    if (!String(r.version).startsWith(`gunicorn ${major}.`)) continue;
    const k = /--keep-alive (\d+)$/.exec(String(rec(r.case).args))?.[1];
    if (k === undefined) continue;
    obs.push({
      file,
      version: String(r.version),
      valueS: Number(k),
      deviationMs: num(rec(r.measured).idleCloseMs) - Number(k) * 1000,
    });
  }
  return obs;
}

function uvicornGraceful(from: Line[]): Obs[] {
  const obs: Obs[] = [];
  for (const { file, r } of from) {
    const c = rec(r.case);
    if (r.entry !== 'shutdown-graceful-ceiling' || c.name !== 'uvicorn-graceful5') continue;
    if (c.kind !== 'long') continue;
    obs.push({
      file,
      version: String(r.version),
      valueS: 5,
      deviationMs: num(rec(r.measured).sigtermToConnectionClosedMs) - 5000,
    });
  }
  return obs;
}

function lightship(from: Line[]): Obs[] {
  const obs: Obs[] = [];
  for (const { file, r } of from) {
    if (r.entry !== 'lightship-shutdown-delay' || rec(r.case).mode !== 'k8s') continue;
    obs.push({
      file,
      version: String(r.version),
      valueS: 5,
      deviationMs: num(rec(r.measured).sigtermToHandlerStartMs) - 5000,
    });
  }
  return obs;
}

function inRangeOf(range: string, version: string): boolean {
  const r = parseRange(range);
  return r !== null && inRange(r, version);
}
const NODE_COUNTS = {
  'node-idle-close-18x': 7,
  'node-idle-close-20x': 7,
  'node-idle-close-22x': 27,
  'node-idle-close-24x': 22,
  'node-idle-close-26x': 12,
  'node-explicit-keepalive-18x': 21,
  'node-explicit-keepalive-20x': 21,
  'node-explicit-keepalive-22x': 105,
  'node-explicit-keepalive-24x': 78,
  'node-explicit-keepalive-26x': 48,
  'node-explicit-buffer-22x-0': 27,
  'node-explicit-buffer-22x-1': 12,
  'node-explicit-buffer-24x-0': 24,
  'node-explicit-buffer-24x-1': 12,
  'node-explicit-buffer-26x-0': 24,
  'node-explicit-buffer-26x-1': 12,
} as Record<string, number>;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const at = (obs: Obs[], v: number) => obs.filter((o) => o.valueS === v).map((o) => o.deviationMs);

/**
 * Basis files from before the lane printed the host load. They are accepted as taken one at a time
 * (B2 ran its cases one after another; B3 and the early B8 runs were --jobs=1 or alone) with no load
 * recorded. Nothing made after the load line existed may be listed here: a file with a paired .txt
 * must show non-busy load lines instead.
 */
const BEFORE_LOAD_LINE = new Set([
  '2026-11-11-b0.jsonl',
  '2026-11-11-b2.jsonl',
  '2026-11-11-b2-explicit.jsonl',
  '2026-11-11-b2-httptools.jsonl',
  '2026-11-11-b3.jsonl',
  '2026-11-11-b3-points.jsonl',
  '2026-11-11-b3-versions.jsonl',
  '2026-11-12-lanes-pinned-pre-review.jsonl',
  '2026-11-12-lanes-latest-pre-review.jsonl',
  '2026-11-12-lanes-latest-isolated.jsonl',
  '2026-11-12-lanes-tolerance-observations-jobs1.jsonl',
  '2026-11-12-lanes-review-observations-jobs1.jsonl',
  '2026-11-12-lanes-review-observations2-jobs1.jsonl',
]);

function loadLines(jsonl: string): { one: number; cores: number; busyText: boolean }[] | null {
  const txt = join(RESULTS, jsonl.replace(/\.jsonl$/, '.txt'));
  let text: string;
  try {
    text = readFileSync(txt, 'utf8');
  } catch {
    return null;
  }
  const found = [
    ...text.matchAll(
      /host load average \(1, 5, 15 min\) at (?:start|end): (\S+) \S+ \S+ on (\d+) cores(; host is busy[^\n]*)?/g,
    ),
  ];
  return found.map((m) => ({
    one: Number(m[1]),
    cores: Number(m[2]),
    busyText: m[3] !== undefined,
  }));
}

describe('m1: every basis file was taken on a quiet host, or predates the load line', () => {
  it('a basis file with load lines has a start and an end, none busy', () => {
    for (const f of BASIS) {
      const l = loadLines(f);
      if (l === null || l.length === 0) continue;
      expect(l.length, `${f} needs a start and an end load line`).toBeGreaterThanOrEqual(2);
      for (const x of l) {
        expect(x.busyText, `${f} says the host was busy`).toBe(false);
        expect(x.one, `${f} load ${x.one} on ${x.cores} cores`).toBeLessThanOrEqual(x.cores / 2);
      }
    }
  });

  it('a basis file with no load lines is on the explicit list of runs from before the load line', () => {
    for (const f of BASIS) {
      const l = loadLines(f);
      if (l === null || l.length === 0)
        expect(BEFORE_LOAD_LINE.has(f), `${f} has no load lines and is not on the list`).toBe(true);
      else
        expect(BEFORE_LOAD_LINE.has(f), `${f} has load lines, so it must not be on the list`).toBe(
          false,
        );
    }
    for (const f of BEFORE_LOAD_LINE)
      expect(BASIS.has(f), `${f} is listed but not a basis`).toBe(true);
  });

  it('the official lane runs have load lines and are quiet', () => {
    for (const f of ['2026-11-12-lanes-pinned.jsonl', '2026-11-12-lanes-latest.jsonl']) {
      expect(loadLines(f)?.length ?? 0, f).toBeGreaterThanOrEqual(2);
    }
  });

  it('a busy or unknown-load file would be refused (the check can fail)', () => {
    const quiet = (one: number, cores: number, busyText: boolean) => ({ one, cores, busyText });
    const refused = (x: { one: number; cores: number; busyText: boolean }) =>
      x.busyText || x.one > x.cores / 2;
    expect(refused(quiet(2.4, 10, false))).toBe(false);
    expect(refused(quiet(5.1, 10, false))).toBe(true);
    expect(refused(quiet(0.1, 10, true))).toBe(true);
    expect(BEFORE_LOAD_LINE.has('2026-11-12-lanes-pinned-review-run1-fail.jsonl')).toBe(false);
    expect(BASIS.has('2026-11-12-lanes-pinned-review-run1-fail.jsonl')).toBe(false);
  });
});

describe('which result files are a basis', () => {
  it('every result file is classified exactly once', () => {
    const all = readdirSync(RESULTS).filter((f) => f.endsWith('.jsonl'));
    for (const f of all) {
      expect(BASIS.has(f) !== isEvidence(f), `${f} must be in exactly one list`).toBe(true);
    }
    for (const f of [...BASIS, ...EVIDENCE_ONLY])
      expect(all, `${f} is listed but missing`).toContain(f);
  });
});

describe('gthread explicit keepalive tolerance (gunicorn 26.x and 27.x)', () => {
  const ids = [
    'gunicorn-explicit-keepalive-gthread-26x',
    'gunicorn-explicit-keepalive-gthread-27x',
  ];
  const all = [...gthread('26', basisLines()), ...gthread('27', basisLines())];
  const parallel = gthread('26', lines(isEvidence));

  it('has the observations the derivation names, per value', () => {
    expect([...new Set(all.map((o) => o.valueS))].sort((a, b) => a - b)).toEqual([7, 75, 300]);
    expect(Object.fromEntries([7, 75, 300].map((v) => [v, at(all, v).length]))).toEqual({
      7: 36,
      75: 6,
      300: 6,
    });
    expect(all.some((o) => o.file.includes('b2'))).toBe(true);
    expect(all.some((o) => o.file.includes('lanes'))).toBe(true);
    // parallel runs exist and are not in the basis
    expect(parallel.length).toBeGreaterThan(0);
    expect(all.some((o) => isEvidence(o.file))).toBe(false);
  });

  it('the deviation grows with the value, so the form is proportional (not a constant overhead)', () => {
    expect(median(at(all, 75))).toBeGreaterThan(5 * median(at(all, 7)));
    expect(median(at(all, 300))).toBeGreaterThan(4 * median(at(all, 75)));
  });

  it('the relative rate is the largest observed relative deviation, rounded up to 0.001', () => {
    const worst = Math.max(...all.map((o) => o.deviationMs / (o.valueS * 1000)));
    const rate = Math.ceil(worst * 1000) / 1000;
    for (const id of ids) {
      expect(kb.entry(id)?.toleranceRelative, id).toBe(rate);
      expect(kb.entry(id)?.toleranceMs, id).toBe(Math.ceil(300 * 1000 * rate + 1));
    }
  });

  it('a value that has observations of its own has its own tolerance: its largest deviation plus 1 ms', () => {
    for (const id of ids) {
      const e = kb.entry(id);
      const major = id.includes('26x') ? '26' : '27';
      const mine = gthread(major, basisLines());
      for (const v of [7, 75, 300]) {
        const dev = at([...mine, ...gthread(major === '26' ? '27' : '26', basisLines())], v);
        // the two lines share one tolerance, from the observations of both
        expect(e?.toleranceMsAt?.[String(v)], `${id} at ${v} s`).toBe(derivedToleranceMs(dev, 1));
      }
    }
  });

  it('every tolerance a lane case uses is inside what the observations allow and leaves no 1 s blind spot', () => {
    for (const id of ids) {
      for (const o of all) {
        expect(o.deviationMs, `${o.file} ${o.valueS} s`).toBeLessThanOrEqual(
          kb.entry(id)?.toleranceMsAt?.[String(o.valueS)] ?? 0,
        );
      }
      for (const v of [7, 75, 300]) {
        expect(kb.entry(id)?.toleranceMsAt?.[String(v)] ?? 99999, `${id} at ${v} s`).toBeLessThan(
          1000,
        );
      }
    }
  });
});

describe('uvicorn --timeout-graceful-shutdown tolerance (0.54.x)', () => {
  const all = uvicornGraceful(basisLines());

  it('has the observations the derivation names, none of them from parallel runs', () => {
    expect(all.length).toBe(22);
    expect(all.some((o) => o.file.includes('lanes'))).toBe(true);
    expect(all.some((o) => isEvidence(o.file))).toBe(false);
    expect(uvicornGraceful(lines(isEvidence)).length).toBeGreaterThan(0);
  });

  it('is the largest observed deviation plus the 10 ms polling resolution', () => {
    const e = kb.entry('uvicorn-explicit-graceful-timeout-0-54x');
    expect(e?.toleranceMs).toBe(
      derivedToleranceMs(
        all.map((o) => o.deviationMs),
        10,
      ),
    );
    for (const o of all) expect(o.deviationMs).toBeLessThanOrEqual(e?.toleranceMs ?? 0);
  });
});

describe('lightship shutdown delay tolerance (9.x)', () => {
  const all = lightship(basisLines());

  it('has the observations the derivation names, none of them from parallel runs', () => {
    expect(all.length).toBe(14);
    expect(all.some((o) => isEvidence(o.file))).toBe(false);
  });

  it('is the largest observed deviation plus the 20 ms polling resolution of the script', () => {
    const e = kb.entry('lightship-shutdown-delay-9x');
    expect(e?.toleranceMs).toBe(
      derivedToleranceMs(
        all.map((o) => o.deviationMs),
        20,
      ),
    );
    // the tolerance is never below the script's own resolution
    expect(e?.toleranceMs ?? 0).toBeGreaterThanOrEqual(20);
    for (const o of all) expect(o.deviationMs).toBeLessThanOrEqual(e?.toleranceMs ?? 0);
  });
});

/** Node: the deviation of each basis run from what its entry predicts (default: value; explicit: K + value; buffer: K + buffer). */
function nodeObservations(from: Line[]): Record<string, number[]> {
  const entries = kb.entries.filter(
    (e) =>
      e.applies.runtime === 'node' && typeof e.scriptRef === 'string' && e.basis === 'measured',
  );
  const out: Record<string, number[]> = Object.fromEntries(entries.map((e) => [e.id, []]));
  for (const { r } of from) {
    const version = String(r.version);
    const ms = rec(r.measured).idleCloseMs;
    if (!/^\d+\.\d+\.\d+$/.test(version) || typeof ms !== 'number') continue;
    let explicit: { k: number; buffer: number | null } | null = null;
    if (r.case !== undefined && r.case !== 'default') {
      const m =
        /^(?:assign|createServer-options) keepAliveTimeout=(\d+)(?: keepAliveTimeoutBuffer=(\d+))?$/.exec(
          String(r.case),
        );
      if (m === null) continue;
      explicit = { k: Number(m[1]) / 1000, buffer: m[2] === undefined ? null : Number(m[2]) };
    }
    for (const e of entries) {
      if (!inRangeOf(e.applies.versionRange, version) || typeof e.value !== 'number') continue;
      const list = out[e.id] as number[];
      if (explicit === null && e.subject === 'node-idle-close') list.push(ms - e.value * 1000);
      else if (explicit !== null && (e.measuredKs ?? []).includes(explicit.k)) {
        if (e.subject === 'node-keepalive-explicit' && explicit.buffer === null)
          list.push(ms - explicit.k * 1000 - e.value * 1000);
        if (e.subject === 'node-keepalive-buffer-explicit' && explicit.buffer === e.value * 1000)
          list.push(ms - explicit.k * 1000 - e.value * 1000);
      }
    }
  }
  return out;
}

describe('Node tolerances (every Node entry, from the basis files only)', () => {
  const obs = nodeObservations(basisLines());
  const ids = Object.keys(obs);
  const COUNTS: Record<string, number> = NODE_COUNTS;

  it('covers every measured Node entry, each with basis observations, the shipped counts pinned', () => {
    // B16: an entry that is not pinned below still has to have observations. A new measured Node entry with
    // none has no quiet basis run: it may not be added until one exists. A `to-be-measured` placeholder is not
    // a way round it: it is a release blocker, and the shipped-knowledge-base test refuses it
    // (test/kb/knowledge-base.test.ts). The same rule is in docs/add-a-knowledge-base-entry.md.
    const nodeScripts = kb.entries.filter(
      (e) =>
        e.applies.runtime === 'node' && typeof e.scriptRef === 'string' && e.basis === 'measured',
    );
    expect(ids.sort()).toEqual(nodeScripts.map((e) => e.id).sort());
    for (const id of ids) {
      expect(
        (obs[id] as number[]).length,
        `${id}: no basis observations. The entry may not be added until a result file taken one at a time on a quiet host is listed in BASIS (a to-be-measured placeholder is a release blocker and is refused).`,
      ).toBeGreaterThan(0);
    }
    for (const [id, n] of Object.entries(COUNTS)) {
      expect((obs[id] as number[] | undefined)?.length, id).toBe(n);
    }
  });

  it('each tolerance is the largest absolute deviation plus the 1 ms resolution', () => {
    for (const id of ids) {
      const dev = (obs[id] as number[]).map(Math.abs);
      if (dev.length === 0) continue; // reported, with the reason, by the previous test
      expect(kb.entry(id)?.toleranceMs, id).toBe(derivedToleranceMs(dev, 1));
      for (const d of dev) expect(d, id).toBeLessThanOrEqual(kb.entry(id)?.toleranceMs ?? 0);
    }
  });

  it('every Node tolerance is far below 1 s, so the 1 s buffer question stays decidable', () => {
    for (const id of ids) expect(kb.entry(id)?.toleranceMs ?? 9999, id).toBeLessThan(100);
  });
});

describe('the derivation rule itself can fail', () => {
  /** What the rule demands of a stated tolerance: it is exactly the derived one, no wider and no tighter. */
  const tight = (tolerance: number, deviations: number[], resolution: number) =>
    tolerance === derivedToleranceMs(deviations, resolution);

  it('gives the largest deviation plus the resolution, rounded up, and refuses no observations', () => {
    expect(derivedToleranceMs([2, 24, 13], 1)).toBe(25);
    expect(derivedToleranceMs([109.7, 198], 10)).toBe(208);
    expect(derivedToleranceMs([4.2], 1)).toBe(6);
    expect(() => derivedToleranceMs([], 1)).toThrow(/no observations/);
  });

  it('a planted observation set fails an over-wide tolerance (1201 ms at 7 s lets a 1 s error through) and a too tight one', () => {
    const planted = [2, 5, 8, 24];
    expect(tight(25, planted, 1)).toBe(true);
    expect(tight(1201, planted, 1)).toBe(false);
    expect(tight(24, planted, 1)).toBe(false);
    // and a tolerance that wide cannot see a run that is a whole second out
    expect(1000 <= 1201).toBe(true);
    expect(1000 <= 25).toBe(false);
  });

  it('the shipped tolerances pass the same check', () => {
    const e = kb.entry('uvicorn-explicit-graceful-timeout-0-54x');
    expect(
      tight(
        e?.toleranceMs ?? 0,
        uvicornGraceful(basisLines()).map((o) => o.deviationMs),
        10,
      ),
    ).toBe(true);
  });
});
