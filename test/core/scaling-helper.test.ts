// The scaling check replaces wall-clock budgets, so it must itself be able
// to fail: quadratic work has to exceed the limit and linear work stay under.
import { describe, expect, it } from 'vitest';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

function linear(n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x = (x + i) % 7919;
  return x;
}

function quadratic(n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) x = (x + i * j) % 7919;
  return x;
}

describe('scalingRatio', () => {
  it(
    'tells linear work from quadratic work',
    () => {
      // Noise only ever raises a ratio (a slower large run, a faster small one is not possible
      // beyond the fastest-of-three already taken), so the lowest of three measurements is the
      // least disturbed one. A genuinely quadratic function has no low measurement.
      const lowest = Math.min(...[1, 2, 3].map(() => scalingRatio((n) => linear(n), 20_000_000)));
      expect(lowest).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(scalingRatio((n) => quadratic(n), 1000)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

// B16: on Node 24.22.3 two scaling tests failed (ratios 8.05, 9.3 to 11.9) although the work is linear:
// the cost of a V8 string or heap step jumps once, at one size, and the one 4x step that straddled the
// jump read as 12x (measured with probe runs on 2026-11-12; the ratios on either side of the jump were 3 to 5).
// A simulated clock makes that deterministic. Real quadratic work breaches at every step, so the
// ratio of the next 4x step (n*4 to n*16) separates the two.
describe('scalingRatio with a simulated clock (B16)', () => {
  function simulate(costMs: (n: number) => number) {
    let t = 0;
    return {
      now: () => t,
      work: (n: number) => {
        t += costMs(n);
      },
    };
  }

  it('a single cost jump inside one 4x step does not read as quadratic work', () => {
    // linear at 0.1 ms per unit, three times dearer from size 2000 up: the step n=1000 to 4n=4000 reads 12
    const sim = simulate((n) => (n >= 2000 ? 0.3 : 0.1) * n);
    expect(scalingRatio(sim.work, 1000, sim.now)).toBeLessThan(LINEAR_RATIO_LIMIT);
  });

  it('quadratic work still breaches the limit at every step, with or without a jump', () => {
    const plain = simulate((n) => (n * n) / 10_000);
    expect(scalingRatio(plain.work, 1000, plain.now)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
    const jumped = simulate((n) => ((n >= 2000 ? 3 : 1) * n * n) / 10_000);
    expect(scalingRatio(jumped.work, 1000, jumped.now)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
  });

  // Review of B16 (m1): work that is linear below a size T and quadratic above it. The step below (n/4 to n) is
  // linear and reads 4, while the real step n to 4n reads 64 or more. A one-off jump reads about 12; quadratic
  // work reads 16 or more, so the lower step may rescue a breach only when the breach is below 16.
  for (const k of [1e3, 1e2]) {
    for (const t of [1500, 2000, 3000, 3900]) {
      it(`linear below ${t} and quadratic above (k = ${k}) still breaches`, () => {
        const sim = simulate((n) => (n < t ? n / 10 : (n * n) / k));
        expect(scalingRatio(sim.work, 1000, sim.now)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
      });
    }
  }

  it('n to the power 1.8 breaches (a ratio of about 12 at every step)', () => {
    const sim = simulate((n) => n ** 1.8 / 100);
    expect(scalingRatio(sim.work, 1000, sim.now)).toBeGreaterThan(LINEAR_RATIO_LIMIT);
  });

  it('n log n work passes', () => {
    const sim = simulate((n) => (n * Math.log2(n)) / 100);
    expect(scalingRatio(sim.work, 1000, sim.now)).toBeLessThan(LINEAR_RATIO_LIMIT);
  });

  it('plain linear work reads 4', () => {
    const sim = simulate((n) => n / 10);
    expect(scalingRatio(sim.work, 1000, sim.now)).toBeCloseTo(4, 5);
  });
});
