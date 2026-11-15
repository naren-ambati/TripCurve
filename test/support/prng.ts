// A small seeded generator for property-style tests (no new
// dependency). mulberry32: deterministic for a given seed, so a failing case
// can be replayed from its seed and index.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
  };
}

/** A string of random UTF-16 code units, lone surrogates and controls included. */
export function randomHostileString(rng: Rng, maxLength: number): string {
  const length = rng.int(0, maxLength);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const kind = rng.int(0, 5);
    if (kind === 0) out += String.fromCharCode(rng.int(0, 0x1f));
    else if (kind === 1) out += String.fromCharCode(rng.int(0x20, 0x7e));
    else if (kind === 2) out += String.fromCharCode(rng.int(0x7f, 0xff));
    else if (kind === 3)
      out += String.fromCharCode(rng.int(0x100, 0xffff)); // may be a lone surrogate
    else if (kind === 4) out += String.fromCodePoint(rng.int(0x10000, 0x10ffff));
    else out += rng.pick(['"', '\\', '\n', '\x1b', '‮', '\u0000']);
  }
  return out;
}
