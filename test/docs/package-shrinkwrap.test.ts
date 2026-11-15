// npm `overrides` do not ship in a package: a person who installs the tarball gets the
// dependency ranges, not our overrides, so `npm audit` was clean only in the checkout (a `minimatch` below 11.0.1
// has advisories). `npm-shrinkwrap.json` is the one lock file npm publishes and installs from, so the audited
// tree is the tree that ships. The tarball also shipped 104 `.js.map` files that point at `src/`, which is not shipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SHRINKWRAP = join(ROOT, 'npm-shrinkwrap.json');

interface Lock {
  lockfileVersion: number;
  packages: Record<
    string,
    {
      version?: string;
      resolved?: string;
      integrity?: string;
      hasInstallScript?: boolean;
      dev?: boolean;
      optional?: boolean;
    }
  >;
}

const atLeast = (version: string, floor: string): boolean => {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

describe('npm-shrinkwrap.json ships the audited tree', () => {
  it('exists, and package-lock.json does not (npm turns one into the other)', () => {
    expect(existsSync(SHRINKWRAP)).toBe(true);
    expect(existsSync(join(ROOT, 'package-lock.json'))).toBe(false);
  });

  it('is in the list of files `npm pack` would put in the tarball', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const files =
      (JSON.parse(out) as { files: { path: string }[] }[])[0]?.files.map((f) => f.path) ?? [];
    expect(files).toContain('npm-shrinkwrap.json');
    // the real tree, whatever an earlier build left in dist/
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
  });

  it('the build empties dist/ first, so a stale file from an earlier build cannot ship', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toMatch(
      /^node -e "fs\.rmSync\('dist',\{recursive:true,force:true\}\)" && tsc /,
    );
  });

  it('holds no minimatch below 11.0.1 (the first release with the advisories fixed)', () => {
    const lock = JSON.parse(readFileSync(SHRINKWRAP, 'utf8')) as Lock;
    const entries = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith('node_modules/minimatch'),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(atLeast(entry.version ?? '0.0.0', '11.0.1'), `${path} ${entry.version}`).toBe(true);
    }
  });

  // Measured on 2026-11-14 (docs/release-check-run-b21.txt): a fresh project that installs the packed tarball gets
  // minimatch 10.2.6 and `npm audit` reports 4 moderate advisories, not the 11.0.8 the shrinkwrap lists. npm keeps a
  // dependency's shrinkwrap entry only while it satisfies the range its dependent declares, and ts-morph's helper
  // declares ^10.0.1. So the shrinkwrap pins the rest of the tree for a consumer but cannot carry the override. This
  // test pins that fact: it fails when the dependent's range allows 11, so the claim in the docs is re-read then.
  it('known gap: the locked minimatch is outside the range its dependent declares, so a consumer does not get it', () => {
    const lock = JSON.parse(readFileSync(SHRINKWRAP, 'utf8')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const locked = lock.packages['node_modules/minimatch']?.version ?? '';
    const lockedMajor = Number(locked.split('.')[0]);
    const ranges = Object.entries(lock.packages)
      .map(([path, entry]) => ({ path, range: entry.dependencies?.minimatch }))
      .filter((d) => d.range !== undefined);
    expect(ranges.length).toBeGreaterThan(0);
    for (const { path, range } of ranges) {
      const declared = /^\^(\d+)\./.exec(range ?? '');
      expect(declared, `${path} ${range}`).not.toBeNull();
      expect(Number(declared?.[1]), `${path} declares ${range}`).toBeLessThan(lockedMajor);
    }
  });

  it('every dependency has an exact version, a resolved URL and an integrity hash, and none runs an install script', () => {
    const lock = JSON.parse(readFileSync(SHRINKWRAP, 'utf8')) as Lock;
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === '') continue;
      expect(entry.version, path).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.resolved, path).toMatch(/^https:\/\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
      // the one install script is `fsevents`, an optional macOS file-watching dependency of a development tool
      // (vite, through vitest): it is `dev` and `optional`, so it never installs for a person who installs tripcurve
      if (entry.hasInstallScript === true) {
        expect(path).toBe('node_modules/fsevents');
        expect(entry.dev).toBe(true);
        expect(entry.optional).toBe(true);
      }
    }
  });
});

describe('the tarball ships no source map', () => {
  it('tsconfig.build.json writes no .js.map or .d.ts.map', () => {
    const text = readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8');
    const config = JSON.parse(text) as { compilerOptions: Record<string, unknown> };
    expect(config.compilerOptions.sourceMap).toBe(false);
    expect(config.compilerOptions.declarationMap ?? false).toBe(false);
  });

  it('a build with that configuration (the one the tests run, in .cache/e2e-build) emits no .map file', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const built = walk(join(ROOT, '.cache', 'e2e-build'));
    expect(built.some((f) => f.endsWith('.js'))).toBe(true);
    expect(built.filter((f) => f.endsWith('.map'))).toEqual([]);
  });

  it('nothing in src, scripts or action reads a source map', () => {
    for (const dir of ['src', 'scripts', 'action']) {
      for (const f of walkText(join(ROOT, dir))) {
        expect(readFileSync(f, 'utf8'), f).not.toMatch(
          /sourceMappingURL|\.js\.map|source-map-support/,
        );
      }
    }
  });
});

function walkText(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walkText(full);
    return /\.(ts|mjs|js|json)$/.test(name) ? [full] : [];
  });
}

// Bolt B22: the docs name the shrinkwrap, not "the lockfile", and its package count is the real one.
describe('the docs state the shrinkwrap package count, computed from the file', () => {
  const lock = JSON.parse(readFileSync(SHRINKWRAP, 'utf8')) as Lock;
  const entries = Object.entries(lock.packages).filter(([key]) => key !== '');
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

  it('every package of the shrinkwrap has an integrity hash (the claim the docs make)', () => {
    expect(entries.filter(([, v]) => v.integrity === undefined || v.integrity === '')).toEqual([]);
  });
  for (const page of ['docs/security.md', 'docs/release-checklist.md']) {
    it(`${page} says "the shrinkwrap has N packages" with the real N and says all have integrity hashes`, () => {
      const m =
        /the shrinkwrap \(`npm-shrinkwrap\.json`\) has (\d+) packages, all with integrity hashes/i.exec(
          read(page),
        );
      expect(
        m,
        `${page} lacks the sentence "The shrinkwrap (\`npm-shrinkwrap.json\`) has N packages, all with integrity hashes"`,
      ).not.toBeNull();
      expect(Number(m?.[1])).toBe(entries.length);
    });
  }
  it('can fail: a wrong count does not equal the real one', () => {
    expect(entries.length + 1).not.toBe(entries.length);
  });
});
