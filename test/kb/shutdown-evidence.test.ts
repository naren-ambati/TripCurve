// B4: a printed basis must claim exactly what the evidence holds (the B3 lesson). Every shipped
// shutdown-chain entry (gunicorn graceful_timeout, the explicit values, uvicorn's explicit value,
// lightship's shutdownDelay, the Kubernetes default) is checked against the raw measurement lines
// and the dated lookups, so a text can never claim a release, a worker class, a value or a
// source that was not run or read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  basisWords,
  citationFor,
  defaultKnowledgeBase,
  explicitBasisWords,
  parseCondition,
  parseVersion,
  supportsPass,
} from '../../src/kb/index.js';

const RESULTS = join(import.meta.dirname, '..', '..', 'measure', 'results');
const kb = defaultKnowledgeBase();

interface Line {
  readonly n: number;
  readonly entry: string;
  readonly version: string;
  readonly caseName: string;
  readonly kind: string | undefined;
  readonly measured: Record<string, unknown>;
}

const LINES: Line[] = [
  ...readFileSync(join(RESULTS, '2026-11-11-b4.jsonl'), 'utf8').split('\n'),
  ...readFileSync(join(RESULTS, '2026-11-11-b4-more.jsonl'), 'utf8').split('\n'),
]
  .filter((l) => l.trim() !== '')
  .map((text, i) => {
    const r = JSON.parse(text) as {
      entry: string;
      version: string;
      case: { name?: string; mode?: string; kind?: string };
      measured: Record<string, unknown>;
    };
    return {
      n: i + 1,
      entry: r.entry,
      version: r.version,
      caseName: r.case.name ?? r.case.mode ?? '',
      kind: r.case.kind,
      measured: r.measured,
    };
  });

const LOOKUPS = readFileSync(join(RESULTS, '2026-11-11-lookups-b4.txt'), 'utf8');

/** gunicorn worker class to the name of the measured case. */
const CASE_OF_CLASS: Readonly<Record<string, string>> = {
  sync: 'sync',
  gthread: 'gthread',
  uvicorn: 'uvicorn-worker',
};

function closedMs(line: Line): number {
  return line.measured.sigtermToConnectionClosedMs as number;
}

function runs(versionPrefix: string, caseName: string, kind: string): Line[] {
  return LINES.filter(
    (l) =>
      l.entry.startsWith('shutdown-graceful-ceiling') &&
      l.version.startsWith(versionPrefix) &&
      l.caseName === caseName &&
      l.kind === kind,
  );
}

function entriesOf(subject: string) {
  const found = kb.entries.filter((e) => e.subject === subject);
  expect(found.length, `entries of ${subject}`).toBeGreaterThan(0);
  return found;
}

describe('the result file is read', () => {
  it('holds the three kinds of runs', () => {
    expect(LINES).toHaveLength(75 + 36);
    expect(LINES.filter((l) => l.entry === 'shutdown-graceful-ceiling')).toHaveLength(69);
    expect(LINES.filter((l) => l.entry === 'shutdown-graceful-ceiling-more')).toHaveLength(36);
    expect(LINES.filter((l) => l.entry === 'lightship-shutdown-delay')).toHaveLength(6);
  });
});

describe('gunicorn graceful_timeout: 30 s, for exactly the classes and releases that were run', () => {
  for (const e of entriesOf('gunicorn-graceful-timeout')) {
    it(`${e.id}: every claimed release and class has three long runs that end at the value`, () => {
      expect(e.basis).toBe('measured');
      expect(e.measuredVersions).toBeDefined();
      const classes = parseCondition(e.applies.condition ?? '') ?? [];
      expect([...classes].sort()).toEqual(['gthread', 'sync', 'uvicorn']);
      for (const version of e.measuredVersions ?? []) {
        for (const cls of classes) {
          const found = runs(`gunicorn ${version}`, CASE_OF_CLASS[cls] as string, 'long');
          expect(found.length, `${version} ${cls}`).toBeGreaterThanOrEqual(3);
          for (const r of found) {
            expect(closedMs(r), `${version} ${cls} line ${r.n}`).toBeGreaterThanOrEqual(
              (e.value as number) * 1000,
            );
            expect(closedMs(r), `${version} ${cls} line ${r.n}`).toBeLessThanOrEqual(
              (e.value as number) * 1000 + (e.toleranceMs ?? 0),
            );
            // the request was cut off, never completed, and the connection ended by FIN
            expect(r.measured.responseComplete).toBe(false);
            expect(r.measured.connectionClose).toBe('fin');
          }
        }
      }
    });

    it(`${e.id}: the release range starts at a run release and covers its own line only`, () => {
      const [first] = e.measuredVersions ?? [];
      const interval = parseVersion(first ?? '0');
      expect(e.applies.versionRange.startsWith(`>=${first}`)).toBe(true);
      expect(interval.lower.major).toBeGreaterThan(0);
      expect(e.applies.versionRange).toContain(`<${interval.lower.major + 1}.0.0`);
    });

    it(`${e.id}: --timeout did not move the ceiling (the worker timeout is not the graceful timeout)`, () => {
      for (const version of e.measuredVersions ?? []) {
        const found = runs(`gunicorn ${version}`, 'sync-timeout120', 'long');
        expect(found.length).toBeGreaterThanOrEqual(3);
        for (const r of found) expect(closedMs(r)).toBeLessThan(31_000);
      }
    });

    it(`${e.id}: prints its measured basis, and supports PASS`, () => {
      expect(basisWords(e)).toBe(`measured on ${e.measuredVersions?.join('')}`);
      expect(supportsPass(e)).toBe(true);
    });
  }
});

/** The case of each (class, source) pair that was run with an explicit graceful timeout of 10. */
const EXPLICIT_CASES: Readonly<Record<string, Readonly<Record<string, string[]>>>> = {
  sync: {
    command: ['sync-graceful10', 'sync-w2-graceful10'],
    env: ['sync-env-graceful10'],
    'config-file': ['sync-conf-graceful10'],
  },
  gthread: { command: ['gthread-graceful10'] },
  uvicorn: { command: ['uvicorn-worker-graceful10'] },
};

describe('the explicit gunicorn graceful timeout: 10 s, only in the classes and sources that were run', () => {
  const explicit = entriesOf('gunicorn-graceful-timeout-explicit');
  it('every (class, source) an entry claims has runs, and no pair that was not run is claimed', () => {
    const claimed = new Set<string>();
    for (const e of explicit) {
      expect(e.measuredSpan).toEqual({ min: 10, max: 10 });
      expect(e.sources, e.id).toBeDefined();
      for (const cls of parseCondition(e.applies.condition ?? '') ?? []) {
        for (const src of e.sources ?? []) {
          claimed.add(`${cls}/${src}/${e.measuredVersions?.join('')}`);
          const cases = EXPLICIT_CASES[cls]?.[src];
          expect(cases, `${e.id}: ${cls} from ${src} was run`).toBeDefined();
          for (const version of e.measuredVersions ?? []) {
            for (const name of cases ?? []) {
              const found = runs(`gunicorn ${version}`, name, 'long');
              expect(found.length, `${version} ${name}`).toBeGreaterThanOrEqual(3);
              for (const r of found) {
                expect(closedMs(r)).toBeGreaterThanOrEqual(10_000);
                expect(closedMs(r)).toBeLessThanOrEqual(10_000 + (e.toleranceMs ?? 0));
                expect(r.measured.responseComplete).toBe(false);
              }
            }
          }
        }
      }
      expect(explicitBasisWords(e)).toBe(`measured at 10 s on ${e.measuredVersions?.join('')}`);
    }
    for (const v of ['26.2.0', '27.0.0']) {
      expect([...claimed].filter((c) => c.endsWith(`/${v}`)).sort()).toEqual(
        ['gthread/command', 'sync/command', 'sync/config-file', 'sync/env', 'uvicorn/command'].map(
          (c) => `${c}/${v}`,
        ),
      );
    }
  });

  it('the notes cite the file the new runs are in', () => {
    for (const e of explicit)
      expect(e.notes, e.id).toContain('measure/results/2026-11-11-b4-more.jsonl');
  });
});

describe('the default gunicorn graceful timeout holds for any worker count that was run (-w 1 and -w 2)', () => {
  it('-w 2 runs end at 30 s on both releases', () => {
    for (const version of ['26.2.0', '27.0.0']) {
      const found = runs(`gunicorn ${version}`, 'sync-w2', 'long');
      expect(found).toHaveLength(3);
      for (const r of found) {
        expect(closedMs(r)).toBeGreaterThanOrEqual(30_000);
        expect(closedMs(r)).toBeLessThanOrEqual(30_000 + 120);
      }
    }
    for (const e of entriesOf('gunicorn-graceful-timeout')) {
      expect(e.notes, e.id).toContain('measure/results/2026-11-11-b4-more.jsonl');
    }
  });
});

describe('the explicit uvicorn --timeout-graceful-shutdown: 5 s, and no default ceiling', () => {
  const [e] = entriesOf('uvicorn-graceful-timeout-explicit');
  it('claims only the 5 s that was run, on 0.54.0', () => {
    expect(e?.measuredSpan).toEqual({ min: 5, max: 5 });
    expect(e?.measuredVersions).toEqual(['0.54.0']);
    const found = LINES.filter(
      (l) => l.version === 'uvicorn 0.54.0' && l.caseName === 'uvicorn-graceful5',
    );
    expect(found).toHaveLength(3);
    for (const r of found) {
      expect(closedMs(r)).toBeGreaterThanOrEqual(5_000);
      expect(closedMs(r)).toBeLessThanOrEqual(5_000 + (e?.toleranceMs ?? 0));
      expect(r.measured.responseComplete).toBe(false);
    }
    expect(e === undefined ? '' : explicitBasisWords(e)).toBe('measured at 5 s on 0.54.0');
  });

  it('has no default entry, because the measured default is "no ceiling" (the request finished in full)', () => {
    expect(kb.entries.some((x) => (x.subject as string) === 'uvicorn-graceful-timeout')).toBe(
      false,
    );
    const found = LINES.filter(
      (l) => l.version === 'uvicorn 0.54.0' && l.caseName === 'uvicorn' && l.kind === 'long',
    );
    expect(found).toHaveLength(3);
    for (const r of found) {
      expect(r.measured.responseComplete).toBe(true);
      expect(closedMs(r)).toBeGreaterThan(59_000);
    }
  });
});

describe('lightship shutdownDelay: 5000 ms under Kubernetes, measured on 9.1.0', () => {
  const [e] = entriesOf('lightship-shutdown-delay');
  it('every claimed release has three Kubernetes-mode runs at the value', () => {
    expect(e?.unit).toBe('ms');
    expect(e?.measuredVersions).toEqual(['9.1.0']);
    for (const version of e?.measuredVersions ?? []) {
      const found = LINES.filter(
        (l) =>
          l.entry === 'lightship-shutdown-delay' &&
          l.version === `lightship ${version}` &&
          l.caseName === 'k8s',
      );
      expect(found).toHaveLength(3);
      for (const r of found) {
        const started = r.measured.sigtermToHandlerStartMs as number;
        expect(started).toBeGreaterThanOrEqual(e?.value as number);
        expect(started).toBeLessThanOrEqual((e?.value as number) + (e?.toleranceMs ?? 0));
      }
    }
  });

  it('the local mode (0) is a documented fact about the same runs, and is not an entry', () => {
    const local = LINES.filter(
      (l) => l.entry === 'lightship-shutdown-delay' && l.caseName === 'local',
    );
    expect(local).toHaveLength(3);
    for (const r of local) expect(r.measured.sigtermToHandlerStartMs as number).toBeLessThan(10);
  });

  it('covers one major line from the measured release (the B2 convention), and prints it', () => {
    expect(e?.applies.versionRange).toBe('>=9.1.0 <10.0.0');
    expect(e === undefined ? '' : citationFor(e)).toBe(
      'default: lightship shutdownDelay (lightship 9.x; measured on 9.1.0)',
    );
  });
});

describe('the Kubernetes default grace period: 30 s, documented, not measurable locally', () => {
  const [e] = entriesOf('k8s-grace-period');
  it('quotes the page that says so, and is dated', () => {
    expect(e?.value).toBe(30);
    expect(e?.basis).toBe('documented');
    expect(e?.docDate).toBe('2026-11-12');
    expect(LOOKUPS).toContain('The default terminationGracePeriodSeconds setting is 30 seconds.');
    expect(LOOKUPS).toContain(e?.docUrl as string);
    expect(typeof e?.scriptRef).toBe('object');
  });

  it('prints the citation of the expected report layout and supports PASS', () => {
    expect(e === undefined ? '' : citationFor(e)).toBe(
      'default: Kubernetes terminationGracePeriodSeconds (documented)',
    );
    expect(e !== undefined && supportsPass(e)).toBe(true);
  });
});

describe('every shutdown entry names the evidence it rests on', () => {
  it('each measured entry cites the result file, and each documented URL is in the lookups file', () => {
    const subjects = new Set([
      'gunicorn-graceful-timeout',
      'gunicorn-graceful-timeout-explicit',
      'uvicorn-graceful-timeout-explicit',
      'lightship-shutdown-delay',
      'k8s-grace-period',
    ]);
    for (const e of kb.entries.filter((x) => subjects.has(x.subject))) {
      if (e.basis === 'measured') {
        expect(e.notes, e.id).toMatch(/measure\/results\/2026-11-11-b4(-more)?\.jsonl/);
        expect(e.scriptRef, e.id).toMatch(/^measure\/(shutdown|lightship)-b4(-more)?\.mjs$/);
      }
      expect(e.docDate, e.id).toBe('2026-11-12');
    }
    for (const url of [
      'https://gunicorn.org/reference/settings/',
      'https://uvicorn.dev/settings/',
      'https://github.com/gajus/lightship/blob/main/README.md',
    ]) {
      expect(LOOKUPS).toContain(url);
    }
  });
});
