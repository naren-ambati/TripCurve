// Checks that work grows linearly with input size without a wall-clock
// budget (which would depend on the machine and its load). The work is
// timed at size n and 4n, taking the fastest of five runs to filter
// scheduling noise; linear work grows about 4x, quadratic work about 16x,
// so a ratio of 8 (the geometric middle) separates the two with room for
// the noise of other test files running in parallel (a 2x step with a
// limit of 3 failed linear work at 3.07 to 3.35 under that load).

export const LINEAR_RATIO_LIMIT = 8;
const STEP = 4;

// A scaling check runs its work at least ten times, and grows the size until it can be timed. This
// is only the hang guard for such a test; it is never a pass criterion. 60 s was exceeded by correct
// tests at a machine load of 38, so the guard is 300 s.
export const SCALING_TEST_TIMEOUT_MS = 300_000;

// CPU time of this process (user + system), in milliseconds. Wall-clock time counts every moment the
// process waits for a core, and when the machine is oversubscribed that wait lands unevenly on the
// small and the large run (linear work measured 8.3 to 13 against the limit of 8 at a load of 24 busy
// loops on 10 cores, even with 100 ms runs). CPU time leaves the waiting out and still grows 4x for
// linear and 16x for quadratic work. It needs the tests to run in separate processes (vitest's `forks`
// pool, the default), so another test's CPU is not counted; `scaling-helper.test.ts` shows the
// helper still tells quadratic from linear work.
function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

// Fastest of five runs: scheduling noise only ever adds time.
function fastest(run: () => void, now: () => number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = now();
    run();
    best = Math.min(best, now() - t0);
  }
  return best;
}

// A ratio of two tiny timings is mostly noise (a few ms of jitter swings
// it), so the size is doubled until the smaller run takes at least this
// long. The size never shrinks below the caller's, so a test still covers
// at least the input it names.
//
// 20 ms was too short to time under load: linear work measured 8.3 to 10.6 against the limit of 8 (24
// busy loops on 10 cores), and a longer small run dilutes a fixed-size pause, so it is 50 ms (100 ms made the quadratic self-test of the helper take 46 s).
// LINEAR_RATIO_LIMIT is not touched: quadratic work still measures about 16.
const MIN_TIMED_MS = 50;
const MAX_DOUBLINGS = 6;
const MIN_LOWER_STEP_MS = 5;
/** The ratio of a 4x step of quadratic work. A breach at or above it is never rescued by the step below. */
const QUADRATIC_RATIO = 16;

/** Returns time(4n) / time(n) for the given work, with n >= size. */
export function scalingRatio(
  work: (size: number) => void,
  size: number,
  now: () => number = cpuMs,
): number {
  let n = size;
  let small = fastest(() => work(n), now);
  for (let i = 0; i < MAX_DOUBLINGS && small < MIN_TIMED_MS; i++) {
    n *= 2;
    small = fastest(() => work(n), now);
  }
  const large = fastest(() => work(STEP * n), now);
  const ratio = large / Math.max(small, 1);
  if (ratio < LINEAR_RATIO_LIMIT) return ratio;
  // Over the limit: measure once more and keep the lower ratio. Noise only ever adds time, so
  // a spurious breach rarely repeats, while real quadratic work (about 16x) breaches both times.
  const again =
    fastest(() => work(STEP * n), now) /
    Math.max(
      fastest(() => work(n), now),
      1,
    );
  const lower = Math.min(ratio, again);
  if (lower < LINEAR_RATIO_LIMIT) return lower;
  // A one-off cost jump reads about 12; quadratic work reads 16 or more (review of B16, m1: work that is linear
  // below some size and quadratic above it has a linear step below, so the step below must not rescue it).
  if (lower >= QUADRATIC_RATIO) return lower;
  // Still over the limit: the cost of a V8 string or heap step can jump once, at one size, and the one 4x
  // step that straddles it reads about 12 for linear work (Node 24.22.3, B16). Quadratic work breaches at
  // every 4x step, so the step below (n/4 to n) is measured too and the lowest ratio kept. The step below is
  // used, not the one above, because 16 times the size would cost 256 times as much for quadratic work. It
  // counts only when its smaller run is long enough to time (MIN_LOWER_STEP_MS); otherwise the breach stands.
  const lowerSize = Math.floor(n / STEP);
  const lowerSmall = fastest(() => work(lowerSize), now);
  if (lowerSize < 1 || lowerSmall < MIN_LOWER_STEP_MS) return lower;
  return Math.min(lower, small / lowerSmall);
}
