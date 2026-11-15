// B3: a measured basis must state exactly what was measured. Every shipped Node entry
// lists the releases and the explicit values K that were run (`measuredVersions`, `measuredKs`);
// this test reads the result files and checks that each of those runs exists, in the right case,
// with the idle close the entry's rule predicts, so a text can never claim a release or a value
// that was not run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  basisWords,
  defaultKnowledgeBase,
  explicitBasisWords,
  parseRange,
} from '../../src/kb/index.js';
import { containsVersion } from '../../src/kb/version-interval.js';

const RESULTS = join(import.meta.dirname, '..', '..', 'measure', 'results');
const FILES = [
  '2026-11-11-b0.jsonl',
  '2026-11-11-b3.jsonl',
  '2026-11-11-b3-versions.jsonl',
  '2026-11-11-b3-points.jsonl',
];

interface Run {
  readonly version: string;
  readonly kind: 'default' | 'explicit' | 'options';
  /** Milliseconds; for the default kind, undefined. */
  readonly keepAliveMs?: number;
  readonly bufferMs?: number;
  readonly idleMs: number;
  readonly file: string;
}

function loadRuns(): Run[] {
  const runs: Run[] = [];
  for (const file of FILES) {
    const text = readFileSync(join(RESULTS, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const r = JSON.parse(line) as {
        entry?: string;
        version?: string;
        case?: string;
        measured?: { idleCloseMs?: number };
      };
      const idleMs = r.measured?.idleCloseMs;
      if (typeof r.version !== 'string' || typeof idleMs !== 'number') continue;
      if (r.case === undefined) {
        // bolt B0 lines: only the Node defaults have no `case`
        if (r.entry?.startsWith('node-idle-close-')) {
          runs.push({ version: r.version, kind: 'default', idleMs, file });
        }
        continue;
      }
      if (r.case === 'default') {
        runs.push({ version: r.version, kind: 'default', idleMs, file });
        continue;
      }
      const m =
        /^(assign|createServer-options) keepAliveTimeout=(\d+)(?: keepAliveTimeoutBuffer=(\d+))?$/.exec(
          r.case,
        );
      if (m === null) continue;
      runs.push({
        version: r.version,
        kind: m[1] === 'assign' ? 'explicit' : 'options',
        keepAliveMs: Number(m[2]),
        ...(m[3] === undefined ? {} : { bufferMs: Number(m[3]) }),
        idleMs,
        file,
      });
    }
  }
  return runs;
}

const RUNS = loadRuns();
const kb = defaultKnowledgeBase();
const nodeEntries = kb.entries.filter(
  (e) => e.subject.startsWith('node-') && e.basis === 'measured',
);

describe('the result files are read', () => {
  it('holds runs of every kind', () => {
    expect(RUNS.filter((r) => r.kind === 'default').length).toBeGreaterThan(20);
    expect(RUNS.filter((r) => r.kind === 'explicit').length).toBeGreaterThan(40);
  });
});

describe('every measured Node entry claims only runs that exist', () => {
  it('there are measured Node entries to check', () => {
    expect(nodeEntries.length).toBeGreaterThan(10);
  });

  for (const e of nodeEntries) {
    it(`${e.id}: its releases lie in its range and each was run`, () => {
      const versions = e.measuredVersions;
      expect(versions, 'measuredVersions is required').toBeDefined();
      const range = parseRange(e.applies.versionRange);
      if (range === undefined || versions === undefined) throw new Error('range');
      for (const v of versions) {
        const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
        expect(
          containsVersion(range, { major, minor, patch }),
          `${v} is in ${e.applies.versionRange}`,
        ).toBe(true);
      }
      expect(e.measuredOn?.version, 'measuredOn names a listed release').toSatisfy((x: string) =>
        versions.some((v) => x.includes(v)),
      );
      const tolerance = e.toleranceMs ?? 0;
      const value = e.value as number;
      for (const version of versions) {
        if (e.subject === 'node-idle-close') {
          const runs = RUNS.filter((r) => r.version === version && r.kind === 'default');
          expect(runs.length, `${version}: default runs`).toBeGreaterThanOrEqual(3);
          for (const r of runs) {
            // one run on 22.18.0 closed 1 ms early (the clock resolution): allow it
            expect(r.idleMs, `${version} default`).toBeGreaterThanOrEqual(value * 1000 - 1);
            expect(r.idleMs, `${version} default`).toBeLessThanOrEqual(value * 1000 + tolerance);
          }
          continue;
        }
        const ks = e.measuredKs;
        expect(ks, 'measuredKs is required for an explicit entry').toBeDefined();
        for (const k of ks ?? []) {
          const buffered = e.subject === 'node-keepalive-buffer-explicit';
          const runs = RUNS.filter(
            (r) =>
              r.version === version &&
              r.kind === 'explicit' &&
              r.keepAliveMs === k * 1000 &&
              (buffered ? r.bufferMs === value * 1000 : r.bufferMs === undefined),
          );
          expect(runs.length, `${e.id}: ${version} at K = ${k} s`).toBeGreaterThanOrEqual(3);
          for (const r of runs) {
            expect(r.idleMs, `${version} K = ${k} s`).toBeGreaterThanOrEqual(
              (k + value) * 1000 - 1,
            );
            expect(r.idleMs, `${version} K = ${k} s`).toBeLessThanOrEqual(
              (k + value) * 1000 + tolerance,
            );
          }
        }
      }
    });
  }

  for (const e of nodeEntries.filter((x) => x.measuredOptions !== undefined)) {
    it(`${e.id}: its options-form runs exist (B3 second review m-a)`, () => {
      const tolerance = e.toleranceMs ?? 0;
      const value = e.value as number;
      for (const group of e.measuredOptions ?? []) {
        expect(e.measuredVersions, 'options runs are of listed releases').toEqual(
          expect.arrayContaining([...group.versions]),
        );
        for (const version of group.versions) {
          const runs = RUNS.filter(
            (r) =>
              r.version === version &&
              r.kind === 'options' &&
              r.keepAliveMs === group.k * 1000 &&
              r.bufferMs === undefined,
          );
          expect(
            runs.length,
            `${e.id}: options form, ${version} at K = ${group.k} s`,
          ).toBeGreaterThanOrEqual(3);
          for (const r of runs) {
            expect(r.idleMs).toBeGreaterThanOrEqual((group.k + value) * 1000 - 1);
            expect(r.idleMs).toBeLessThanOrEqual((group.k + value) * 1000 + tolerance);
          }
        }
      }
    });
  }

  it('only the buffer-unset explicit entries claim options-form runs, and none claims a buffer there', () => {
    for (const e of nodeEntries) {
      if (e.subject !== 'node-keepalive-explicit') expect(e.measuredOptions, e.id).toBeUndefined();
    }
    const claimed = nodeEntries.filter((e) => e.measuredOptions !== undefined).map((e) => e.id);
    expect(claimed).toEqual([
      'node-explicit-keepalive-22x',
      'node-explicit-keepalive-24x',
      'node-explicit-keepalive-26x',
    ]);
  });

  it('the printed basis names the count and the bounds of the releases, and every K', () => {
    for (const e of nodeEntries) {
      const versions = e.measuredVersions ?? [];
      const words = e.subject === 'node-idle-close' ? basisWords(e) : explicitBasisWords(e);
      const first = versions[0];
      const last = versions[versions.length - 1];
      expect(words, e.id).toContain(
        versions.length === 1
          ? String(first)
          : `${versions.length} releases from ${first} to ${last}`,
      );
      for (const k of e.measuredKs ?? []) expect(words, e.id).toMatch(new RegExp(`\\b${k}\\b`));
    }
  });
});
