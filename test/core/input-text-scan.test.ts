import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findRawReaders,
  listSources,
  PRINTING_PREFIXES,
  relativeSlash,
} from '../support/raw-reader-scan.js';

// the raw string of an InputText may leave SafeText only through
// `unwrapForIo`. This scan fails when a source file other than safe-text.ts,
// and other than the allowlist below, mentions that name. It also keeps the
// printing components (report, cli) off it entirely, whatever the allowlist.
//
// The scan is a guard against accidents, not against a developer who defeats
// it on purpose (the design says so too).

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Files allowed to read the raw text of an InputText, each with the reason.
 * Add a file here only when it must open a file by a path or compare raw text
 * in a way compareInputText/inputTextEquals cannot. Never a printing component.
 */
const ALLOWED_RAW_READERS: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'src/core/safe-text.ts', reason: 'the choke point itself' },
  { prefix: 'src/parse/intake', reason: 'intake opens files by their path' },
];

describe('no module outside SafeText reads the raw text of an InputText', () => {
  const files = listSources(SRC).map((f) => ({
    path: relativeSlash(ROOT, f),
    text: readFileSync(f, 'utf8'),
  }));

  it('scans real sources', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.path === 'src/core/safe-text.ts')).toBe(true);
  });

  it('finds no offender in src/', () => {
    expect(findRawReaders(files, ALLOWED_RAW_READERS)).toEqual([]);
  });

  it('the allowlist never names a printing component', () => {
    for (const a of ALLOWED_RAW_READERS) {
      expect(PRINTING_PREFIXES.some((p) => a.prefix.startsWith(p))).toBe(false);
    }
  });

  // The scan must be able to fail: feed it files that break the rule.
  it('flags an ordinary module that unwraps', () => {
    const bad = [
      { path: 'src/link/linker.ts', text: "import { unwrapForIo } from '../core/safe-text.js';" },
    ];
    expect(findRawReaders(bad, ALLOWED_RAW_READERS)).toEqual(['src/link/linker.ts']);
  });

  it('flags a printing component even if it were allowlisted', () => {
    const bad = [{ path: 'src/report/human.ts', text: 'unwrapForIo(x)' }];
    expect(findRawReaders(bad, [{ prefix: 'src/report/' }])).toEqual(['src/report/human.ts']);
  });

  it('flags the parser-side raw accessors in a printing component', () => {
    const bad = [
      { path: 'src/report/human.ts', text: 'const s = rawInputTextForParser(t);' },
      { path: 'src/cli/app.ts', text: "import { rawTextForParser } from '../parse/index.js';" },
    ];
    expect(findRawReaders(bad, ALLOWED_RAW_READERS)).toEqual([
      'src/report/human.ts',
      'src/cli/app.ts',
    ]);
  });

  it('scans the report and the cli sources, which exist', () => {
    expect(files.some((f) => f.path.startsWith('src/report/'))).toBe(true);
    expect(files.some((f) => f.path.startsWith('src/cli/'))).toBe(true);
    expect(files.some((f) => f.path === 'src/cli/main.ts')).toBe(true);
    expect(files.some((f) => f.path === 'src/report/human.ts')).toBe(true);
  });

  it('flags the CLI too', () => {
    const bad = [{ path: 'src/cli/main.ts', text: 'const s = unwrapForIo(t);' }];
    expect(findRawReaders(bad, ALLOWED_RAW_READERS)).toEqual(['src/cli/main.ts']);
  });

  it('allows the named intake file and the choke point', () => {
    const ok = [
      { path: 'src/parse/intake.ts', text: 'unwrapForIo(p)' },
      { path: 'src/core/safe-text.ts', text: 'export function unwrapForIo' },
    ];
    expect(findRawReaders(ok, ALLOWED_RAW_READERS)).toEqual([]);
  });

  it('the public core index does not re-export the unwrap', () => {
    const index = readFileSync(join(SRC, 'core', 'index.ts'), 'utf8');
    expect(index).not.toContain('unwrapForIo');
  });
});
