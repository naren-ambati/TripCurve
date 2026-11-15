import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  containsVersion,
  describeGap,
  exactInterval,
  formatInterval,
  intersect,
  intervalsOverlap,
  isCovered,
  isEmpty,
  narrow,
  overlaps,
  parseRange,
  parseVersion,
  partitionInterval,
  unknownInterval,
  type Version,
  type VersionInterval,
} from '../../src/kb/index.js';
import { makeRng, type Rng, randomHostileString } from '../support/prng.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

const v = (major: number, minor: number, patch: number): Version => ({ major, minor, patch });

function range(text: string): VersionInterval {
  const parsed = parseRange(text);
  if (parsed === undefined) throw new Error(`test range does not parse: ${text}`);
  return parsed;
}

function mutate(rng: Rng, base: string): string {
  const chars = [...base];
  const edits = rng.int(0, 3);
  for (let e = 0; e < edits; e += 1) {
    const pos = rng.int(0, Math.max(0, chars.length - 1));
    const op = rng.int(0, 2);
    const junk = rng.pick(['.', 'x', '-', ' ', '9', 'v', '\n', '0', '>=']);
    if (op === 0) chars.splice(pos, 1);
    else if (op === 1) chars.splice(pos, 0, junk);
    else chars[pos] = junk;
  }
  return chars.join('');
}

const probes: Version[] = [];
for (const major of [0, 10, 20, 22, 23, 24, 25, 26, 27, 30]) {
  for (const minor of [0, 5, 18, 19, 23, 22, 13]) {
    for (const patch of [0, 1, 2, 3]) probes.push(v(major, minor, patch));
  }
}

function randomInterval(rng: Rng): VersionInterval {
  const kind = rng.int(0, 3);
  if (kind === 0) return unknownInterval();
  const major = rng.int(20, 27);
  const minor = rng.int(0, 25);
  const patch = rng.int(0, 4);
  if (kind === 1) return parseVersion(`${major}`);
  if (kind === 2) return parseVersion(`${major}.${minor}`);
  return parseVersion(`${major}.${minor}.${patch}`);
}

describe('parseVersion (exact subset in B1)', () => {
  it('turns an exact version into a one-version interval', () => {
    const i = parseVersion('22.23.2');
    expect(i.lower).toEqual(v(22, 23, 2));
    expect(i.upper).toEqual(v(22, 23, 3));
    expect(containsVersion(i, v(22, 23, 2))).toBe(true);
    expect(containsVersion(i, v(22, 23, 1))).toBe(false);
    expect(containsVersion(i, v(22, 23, 3))).toBe(false);
  });

  it('turns a partial version into the whole minor or major', () => {
    expect(parseVersion('22.23')).toEqual(range('>=22.23.0 <22.24.0'));
    expect(parseVersion('22')).toEqual(range('>=22.0.0 <23.0.0'));
  });

  it('accepts a leading v', () => {
    expect(parseVersion('v22.23.2')).toEqual(exactInterval(22, 23, 2));
  });

  it('takes anything else as unknown: all versions', () => {
    const texts = [
      '',
      'lts',
      'latest',
      'lts-slim',
      '22.x',
      '22.23.2-alpine',
      '22.23.2.1',
      '>=22',
      ' 22.23',
      '22.23 ',
      '-1.0.0',
      '1e3',
      'sha256:abc',
      '22..2',
      '٢٢.٢٣',
    ];
    for (const text of texts) {
      expect(parseVersion(text), JSON.stringify(text)).toEqual(unknownInterval());
    }
  });

  it('takes a part that is too long for an exact integer as unknown', () => {
    expect(parseVersion('1'.repeat(16))).toEqual(unknownInterval());
    expect(parseVersion(`22.${'9'.repeat(16)}.0`)).toEqual(unknownInterval());
    expect(parseVersion('9'.repeat(15)).lower.major).toBe(999999999999999);
  });

  it('never throws, on any text, and always returns a non-empty interval (property)', () => {
    const rng = makeRng(99);
    const shapes = ['22.23.2', '22.23', '22', 'v24.22.3', '26.13.1'];
    for (let i = 0; i < 2000; i += 1) {
      const text = i % 3 === 0 ? randomHostileString(rng, 40) : mutate(rng, rng.pick(shapes));
      let interval: VersionInterval | undefined;
      expect(() => {
        interval = parseVersion(text);
      }, JSON.stringify(text)).not.toThrow();
      expect(interval && isEmpty(interval), JSON.stringify(text)).toBe(false);
    }
  });

  it(
    'is linear on hostile 1 MB strings',
    () => {
      const ratio = scalingRatio((n) => {
        parseVersion(`${'1'.repeat(n)}.x`);
        parseVersion('1.'.repeat(n / 2));
      }, 1_000_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('property: an exact version is in its own interval and in no neighbour', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 500; i += 1) {
      const a = v(rng.int(0, 60), rng.int(0, 60), rng.int(0, 60));
      const interval = parseVersion(`${a.major}.${a.minor}.${a.patch}`);
      expect(containsVersion(interval, a)).toBe(true);
      expect(containsVersion(interval, v(a.major, a.minor, a.patch + 1))).toBe(false);
      if (a.patch > 0) {
        expect(containsVersion(interval, v(a.major, a.minor, a.patch - 1))).toBe(false);
      }
    }
  });
});

describe('parseRange (knowledge-base grammar)', () => {
  it('reads *, one comparator, or a lower and upper pair', () => {
    expect(parseRange('*')).toEqual(unknownInterval());
    expect(parseRange('>=22.19.0')?.upper).toBeNull();
    expect(parseRange('<23.0.0')?.lower).toEqual(v(0, 0, 0));
    const r = parseRange('>=22.19.0 <23.0.0');
    expect(r?.lower).toEqual(v(22, 19, 0));
    expect(r?.upper).toEqual(v(23, 0, 0));
  });

  it('rejects text outside the grammar, an empty range, and out-of-order comparators', () => {
    const bad = [
      '',
      '22',
      '>=22',
      '>22.0.0',
      '<=22.0.0',
      '>=22.19.0 <22.19.0',
      '>=23.0.0 <22.0.0',
      '<23.0.0 >=22.0.0',
      '>=22.0.0 >=23.0.0',
      '>=22.19.0  <23.0.0',
      ' *',
      '* ',
      '>=22.19.0 <23.0.0 ',
      '>=a.b.c',
      '>=22.0.0 <23.0.0 <24.0.0',
    ];
    for (const text of bad) {
      expect(parseRange(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

describe('overlap, intersect, narrow and coverage', () => {
  const r22 = '>=22.19.0 <23.0.0';

  it('22.23 and 22.23.2 overlap the 22.x line; 22.18.0 and 24 do not', () => {
    expect(overlaps(parseVersion('22.23'), r22)).toBe(true);
    expect(overlaps(parseVersion('22.23.2'), r22)).toBe(true);
    expect(overlaps(parseVersion('22.18.0'), r22)).toBe(false);
    expect(overlaps(parseVersion('24.22.3'), r22)).toBe(false);
    expect(overlaps(parseVersion('22.19.0'), r22)).toBe(true);
    expect(overlaps(parseVersion('23.0.0'), r22)).toBe(false); // the upper bound is exclusive
  });

  it('an unknown interval overlaps every non-empty range', () => {
    expect(overlaps(unknownInterval(), r22)).toBe(true);
    expect(overlaps(unknownInterval(), '>=99.0.0')).toBe(true);
  });

  it('a malformed range is a fault, not "no overlap"', () => {
    expect(() => overlaps(parseVersion('22'), 'oops')).toThrow(TypeError);
  });

  it('empty intervals overlap nothing', () => {
    const empty = intersect(parseVersion('22.23'), parseVersion('24'));
    expect(isEmpty(empty)).toBe(true);
    expect(intervalsOverlap(empty, unknownInterval())).toBe(false);
    expect(overlaps(empty, '*')).toBe(false);
  });

  it('narrow cuts by the grammar and ignores engines text it does not understand', () => {
    const i = parseVersion('22');
    expect(narrow(i, '>=22.19.0')).toEqual(range('>=22.19.0 <23.0.0'));
    expect(narrow(i, '^22.0.0')).toBe(i); // not understood: unchanged, which is safe (wider)
    expect(narrow(i, 'garbage \u0000')).toBe(i);
  });

  it('narrow only narrows (property)', () => {
    const rng = makeRng(31);
    for (let i = 0; i < 500; i += 1) {
      const a = randomInterval(rng);
      const engines = rng.pick([
        '>=20.0.0',
        '>=22.19.0 <23.0.0',
        '<25.0.0',
        '*',
        '>=26.13.1',
        'nonsense',
      ]);
      const n = narrow(a, engines);
      for (const probe of probes) {
        if (containsVersion(n, probe)) expect(containsVersion(a, probe), `${i}`).toBe(true);
      }
    }
  });

  it('isCovered: a gap is not covered, a complete cover is', () => {
    const line22 = range('>=22.19.0 <23.0.0');
    expect(isCovered(parseVersion('22.23'), [line22])).toBe(true);
    expect(isCovered(parseVersion('22'), [line22])).toBe(false); // 22.0 to 22.18 uncovered
    expect(isCovered(unknownInterval(), [line22])).toBe(false);
    const before = range('>=22.0.0 <22.19.0');
    expect(isCovered(parseVersion('22'), [line22, before])).toBe(true);
    expect(isCovered(parseVersion('22'), [before])).toBe(false);
    expect(isCovered(unknownInterval(), [range('*')])).toBe(true);
    expect(isCovered(unknownInterval(), [range('>=1.0.0')])).toBe(false);
    expect(isCovered(parseVersion('22'), [])).toBe(false);
    expect(isCovered(intersect(parseVersion('22'), parseVersion('24')), [range('*')])).toBe(false);
  });

  it('formats an interval for diagnostics', () => {
    expect(formatInterval(unknownInterval())).toBe('all versions');
    expect(formatInterval(parseVersion('22.23.2'))).toBe('22.23.2 up to, not including, 22.23.3');
  });
});

describe('interval properties', () => {
  it('overlap is symmetric, and a shared version proves an overlap', () => {
    const rng = makeRng(2026);
    for (let i = 0; i < 1000; i += 1) {
      const a = randomInterval(rng);
      const b = randomInterval(rng);
      expect(intervalsOverlap(a, b), `${i}`).toBe(intervalsOverlap(b, a));
      const common = probes.some((p) => containsVersion(a, p) && containsVersion(b, p));
      if (common) expect(intervalsOverlap(a, b), `${i}`).toBe(true);
    }
  });

  it('intersect is commutative and contains exactly the versions in both operands', () => {
    const rng = makeRng(77);
    for (let i = 0; i < 1000; i += 1) {
      const a = randomInterval(rng);
      const b = randomInterval(rng);
      const ab = intersect(a, b);
      expect(ab).toEqual(intersect(b, a));
      for (const p of probes) {
        expect(containsVersion(ab, p), `${i}`).toBe(containsVersion(a, p) && containsVersion(b, p));
      }
    }
  });

  it('compareVersions is antisymmetric and reflexive', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 500; i += 1) {
      const a = v(rng.int(0, 5), rng.int(0, 5), rng.int(0, 5));
      const b = v(rng.int(0, 5), rng.int(0, 5), rng.int(0, 5));
      expect(compareVersions(a, b) + compareVersions(b, a)).toBe(0);
      expect(compareVersions(a, a)).toBe(0);
    }
  });

  it('isCovered agrees with probing every version of a small window (property)', () => {
    const rng = makeRng(404);
    for (let i = 0; i < 600; i += 1) {
      const target =
        rng.int(0, 1) === 0
          ? parseVersion(`${rng.int(0, 3)}`)
          : parseVersion(`${rng.int(0, 3)}.${rng.int(0, 3)}`);
      const parts: VersionInterval[] = [];
      const n = rng.int(0, 4);
      for (let k = 0; k < n; k += 1) {
        const lo = v(rng.int(0, 3), rng.int(0, 3), rng.int(0, 2));
        const hi = v(lo.major + rng.int(0, 1), rng.int(0, 4), rng.int(0, 2));
        const parsed = parseRange(
          `>=${lo.major}.${lo.minor}.${lo.patch} <${hi.major}.${hi.minor}.${hi.patch}`,
        );
        if (parsed) parts.push(parsed);
      }
      // Every boundary used above lies in majors 0..4, minors 0..4, patches 0..3.
      let allIn = true;
      let any = false;
      for (let a = 0; a <= 4; a += 1) {
        for (let b = 0; b <= 4; b += 1) {
          for (let c = 0; c <= 3; c += 1) {
            const p = v(a, b, c);
            if (!containsVersion(target, p)) continue;
            any = true;
            if (!parts.some((q) => containsVersion(q, p))) allIn = false;
          }
        }
      }
      expect(isCovered(target, parts), `${i}`).toBe(any && allIn);
    }
  });
});

describe('partitionInterval: one segment per entry range and one per gap', () => {
  const part = (id: string, text: string) => ({ item: id, interval: range(text) });
  const shape = (segments: ReturnType<typeof partitionInterval<string>>) =>
    segments.map((x) => (x.kind === 'part' ? x.item : `gap ${describeGap(x.interval)}`));

  it('cuts an unknown version into ranges and gaps, in order, dropping nothing', () => {
    const segments = partitionInterval(unknownInterval(), [
      part('b', '>=24.0.0 <25.0.0'),
      part('a', '>=22.12.0 <23.0.0'),
    ]);
    expect(shape(segments)).toEqual([
      'gap before 22.12',
      'a',
      'gap 23 to before 24',
      'b',
      'gap 25 and later',
    ]);
  });

  it('a partial version inside one range is that range, with no gap', () => {
    expect(
      shape(partitionInterval(parseVersion('22.23'), [part('a', '>=22.12.0 <23.0.0')])),
    ).toEqual(['a']);
  });

  it('a partial version that starts before the range keeps the gap before it', () => {
    expect(shape(partitionInterval(parseVersion('22'), [part('a', '>=22.12.0 <23.0.0')]))).toEqual([
      'gap 22 to before 22.12',
      'a',
    ]);
  });

  it('a version outside every range is one gap, never the nearest range', () => {
    const segments = partitionInterval(parseVersion('20.11'), [part('a', '>=22.12.0 <23.0.0')]);
    expect(shape(segments)).toEqual(['gap 20.11 to before 20.12']);
  });

  it('with no parts the whole interval is one gap; an empty interval has no segments', () => {
    expect(shape(partitionInterval(parseVersion('22'), []))).toEqual(['gap 22 to before 23']);
    const empty = range('>=2.0.0 <3.0.0');
    expect(partitionInterval(intersect(empty, range('>=5.0.0 <6.0.0')), [part('a', '*')])).toEqual(
      [],
    );
  });

  it('parts that overlap are each kept: a version in two ranges has two candidates', () => {
    const segments = partitionInterval(parseVersion('22'), [
      part('a', '>=22.0.0 <22.20.0'),
      part('b', '>=22.10.0 <23.0.0'),
    ]);
    expect(shape(segments)).toEqual(['a', 'b']);
  });

  it('an open-ended range ends the walk: nothing is added after it', () => {
    expect(shape(partitionInterval(unknownInterval(), [part('a', '>=5.0.0')]))).toEqual([
      'gap before 5',
      'a',
    ]);
  });

  it('the segments tile the interval: every version is in exactly one gap or part', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 300; i += 1) {
      const target = rng.int(0, 1) === 0 ? unknownInterval() : parseVersion(`${rng.int(0, 3)}`);
      const parts: { item: string; interval: VersionInterval }[] = [];
      for (let k = 0; k < rng.int(0, 4); k += 1) {
        const lo = v(rng.int(0, 3), rng.int(0, 3), rng.int(0, 2));
        const hi = v(lo.major + rng.int(0, 1), rng.int(0, 4), rng.int(0, 2));
        const parsed = parseRange(
          `>=${lo.major}.${lo.minor}.${lo.patch} <${hi.major}.${hi.minor}.${hi.patch}`,
        );
        if (parsed) parts.push({ item: `p${k}`, interval: parsed });
      }
      const segments = partitionInterval(target, parts);
      for (let a = 0; a <= 4; a += 1) {
        for (let b = 0; b <= 4; b += 1) {
          for (let c = 0; c <= 3; c += 1) {
            const probe = v(a, b, c);
            if (!containsVersion(target, probe)) continue;
            const inGap = segments.filter(
              (x) => x.kind === 'gap' && containsVersion(x.interval, probe),
            );
            const inParts = segments.filter(
              (x) => x.kind === 'part' && containsVersion(x.interval, probe),
            );
            const expectedParts = parts.filter((p) => containsVersion(p.interval, probe)).length;
            expect(inParts.length, `${i} ${a}.${b}.${c}`).toBe(expectedParts);
            expect(inGap.length, `${i} ${a}.${b}.${c}`).toBe(expectedParts === 0 ? 1 : 0);
          }
        }
      }
    }
  });
});

describe('describeGap writes a label from the numbers only', () => {
  it('reads like a release line', () => {
    expect(describeGap(range('>=0.0.0 <22.12.0'))).toBe('before 22.12');
    expect(describeGap(range('>=19.0.0 <20.20.2'))).toBe('19 to before 20.20.2');
    expect(describeGap(range('>=27.0.0'))).toBe('27 and later');
    expect(describeGap(unknownInterval())).toBe('all versions');
    expect(describeGap(range('>=22.0.0 <22.12.0'))).toBe('22 to before 22.12');
  });

  it('is plain digits, dots and fixed words for every interval', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 200; i += 1) {
      const lo = v(rng.int(0, 40), rng.int(0, 40), rng.int(0, 40));
      const text =
        rng.int(0, 1) === 0
          ? `>=${lo.major}.${lo.minor}.${lo.patch}`
          : `>=${lo.major}.${lo.minor}.${lo.patch} <${lo.major + 1}.${rng.int(0, 9)}.${rng.int(0, 9)}`;
      expect(describeGap(range(text))).toMatch(/^[0-9a-z. ]+$/);
    }
  });
});
