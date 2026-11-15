import { defineConfig } from 'vitest/config';

// Coverage floor: 80% lines on the core pipeline code. The
// pipeline folders are parse, link, resolve, evaluate and report, plus the
// shared model (core) and the knowledge base (kb) they stand on. Fixtures,
// measurement scripts, the CLI wrapper and the Action are excluded.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Only a hang guard, never a pass criterion: vitest's default of 5 s failed correct tests (a child
    // process, 2000 seeded cases) when other processes drove the machine load to 9 or more. A test that
    // really hangs still fails, only later. Scaling tests set their own, longer guard (test/support/scaling.ts).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Builds the CLI once, for the golden and end-to-end tests that run it as a child process.
    globalSetup: ['test/support/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/kb/**/*.ts',
        'src/parse/**/*.ts',
        'src/analyse.ts',
        'src/link/**/*.ts',
        'src/resolve/**/*.ts',
        'src/evaluate/**/*.ts',
        'src/waive/**/*.ts',
        'src/report/**/*.ts',
      ],
      exclude: ['**/*.d.ts', 'test/**', 'measure/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80 },
    },
  },
});
