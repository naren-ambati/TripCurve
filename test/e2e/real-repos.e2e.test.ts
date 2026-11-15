// The real-repository check: the built command run on trimmed copies of four
// permissively licensed public repositories (`test/fixtures/real/`, README there). Each expected file
// holds real output that was read against the real files and judged correct BEFORE it was written; the
// README's results table says how each line was judged. If the output changes, a person must judge the
// new output again, not just regenerate the file.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const REAL = join(import.meta.dirname, '..', 'fixtures', 'real');
const DECLARED = join(import.meta.dirname, '..', 'fixtures', 'real-declared');

/** Files of a copy that are ours (not upstream's): never part of what is checked. */
const OURS = new Set(['NOTICE', 'expected.txt', 'expected-declared.txt']);

interface Copy {
  readonly dir: string;
  readonly files: number;
  readonly summary: string;
  /** The exit code the judged output has: 1 for a run that is not clean, 0 for a clean run. */
  readonly exit: 0 | 1;
  /** The expected output prints a PASS word (a verified result: B17 made the publikes pair one). */
  readonly pass: boolean;
}

const COPIES: readonly Copy[] = [
  {
    dir: 'peermetrics__peermetrics',
    files: 4,
    summary: 'Summary: 1 failed, 4 unresolved, 1 not evaluated; not a clean result',
    exit: 1,
    pass: false,
  },
  {
    dir: 'akhileshmishrabiz__DevOpsDojo',
    files: 9,
    summary: 'Summary: 3 unresolved; not a clean result',
    exit: 1,
    pass: false,
  },
  {
    dir: 'sorah__publikes',
    files: 4,
    // B17: a folder-scoped link and exact arithmetic (60 + (30 * 6) = 240) make this a verified PASS
    summary: 'All checks passed (1), 0 not applicable.',
    exit: 0,
    pass: true,
  },
  {
    dir: 'DanielDaCosta__apiGateway-sqs-lambda',
    files: 4,
    // B17: a folder-scoped link, and a FAIL that does not need the batching window
    summary: 'Summary: 1 failed; not a clean result',
    exit: 1,
    pass: false,
  },
];

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

/** Every file under a directory, as paths relative to it, in sorted order. */
function filesUnder(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(root, full));
    else out.push(relative(root, full));
  }
  return out.sort();
}

describe.each(COPIES)('real repository $dir', (copy) => {
  const cwd = join(REAL, copy.dir);
  const expected = readFileSync(join(cwd, 'expected.txt'), 'utf8');
  const run = runBuilt(['.'], { cwd });

  it('prints exactly the judged expected output', () => {
    expect(run.stdout).toBe(expected);
  });

  it('exits as judged (1 when not clean) and writes nothing to stderr', () => {
    expect(run.status).toBe(copy.exit);
    expect(run.stderr).toBe('');
  });

  it('reads the files of the copy and ends with the expected summary', () => {
    expect(expected.split('\n')[0]).toBe(
      `tripcurve 0.1.0   checked "."   ${copy.files} files read`,
    );
    expect(expected.replace(/\s+/g, ' ')).toContain(copy.summary);
  });

  it('prints a pass word only where the files establish every value the check rests on', () => {
    // a PASS is allowed here only for the publikes pair, whose queue, function and window are all literals
    // (the visibility is computed from literals, and the output shows the computation)
    expect(/\bPASS\b/.test(expected)).toBe(copy.pass);
    expect(/All checks passed/.test(expected)).toBe(copy.pass);
  });

  it('gives the same verdict in JSON, with the same exit code', () => {
    const json = runBuilt(['.', '--format', 'json'], { cwd });
    expect(json.status).toBe(copy.exit);
    expect(json.stderr).toBe('');
    const doc = JSON.parse(json.stdout) as { summary: { clean: boolean; exitCode: number } };
    expect(doc.summary.clean).toBe(copy.exit === 0);
    expect(doc.summary.exitCode).toBe(copy.exit);
  });
});

describe('the DevOpsDojo copy with the declarations of the check', () => {
  // The upstream manifest names an image that no file builds, so the Node source cannot be linked
  // without a declaration. The declaration file is ours (test/fixtures/real-declared/) and is put in a
  // temporary copy as `tripcurve.yaml`, so the upstream copy stays byte-identical and no absolute path
  // appears in the output.
  const dir = join(REAL, 'akhileshmishrabiz__DevOpsDojo');
  const expected = readFileSync(join(dir, 'expected-declared.txt'), 'utf8');

  const declaredRun = () => {
    const tree = makeTree('tripcurve-real-');
    trees.push(tree);
    cpSync(dir, tree.root, {
      recursive: true,
      filter: (src) => !OURS.has(relative(dir, src)),
    });
    cpSync(join(DECLARED, 'devopsdojo-frontend.yaml'), join(tree.root, 'tripcurve.yaml'));
    return runBuilt(['.'], { cwd: tree.root });
  };

  it('prints exactly the judged expected output', () => {
    expect(declaredRun().stdout).toBe(expected);
  });

  it('exits 1 and writes nothing to stderr', () => {
    const run = declaredRun();
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('reads server.js and shows the Node default as VERSION-DEPENDENT, never PASS', () => {
    expect(expected).toContain('VERSION-DEPENDENT T1');
    expect(expected).toContain('("frontend/server.js")');
    expect(expected).toContain('idle close 6 s would FAIL (measured on 20.20.2)');
    expect(expected).not.toMatch(/\bPASS\b/);
  });
});

describe('the copies are what the NOTICE says they are', () => {
  it.each(COPIES)('$dir: licence, notice and file list', ({ dir }) => {
    const root = join(REAL, dir);
    const repo = dir.replace('__', '/');
    const licence = readFileSync(join(root, 'LICENSE'), 'utf8');
    expect(licence).toMatch(/^(The )?MIT License/);
    expect(licence).toContain('Permission is hereby granted, free of charge');

    const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
    expect(notice).toContain(`https://github.com/${repo}`);
    expect(notice).toMatch(/Commit: {3}[0-9a-f]{40}\n/);
    expect(notice).toMatch(/Copied: {3}2026-11-12 \(UTC\)\n/);
    expect(notice).toMatch(/Licence: {2}MIT /);
    expect(notice).toContain('Trimmed: only files tripcurve reads; unchanged otherwise');

    const listed = notice
      .split('\n')
      .filter((l) => l.startsWith('  - '))
      .map((l) => l.slice(4))
      .sort();
    const actual = filesUnder(root).filter((f) => f !== 'LICENSE' && !OURS.has(f));
    expect(actual).toEqual(listed);
  });

  it('no secret-like file was copied', () => {
    const all = COPIES.flatMap((c) => filesUnder(join(REAL, c.dir)));
    for (const f of all) {
      expect(f).not.toMatch(/secret|\.env|credential|\.pem$|\.key$|policy\.json$|\.tfvars$/i);
    }
    expect(existsSync(join(REAL, 'peermetrics__peermetrics', 'k8s', 'overlays'))).toBe(false);
  });
});
