// The container image definition, checked as files (B29). The image itself is built and smoke-tested by
// scripts/docker-smoke.mjs, locally and in .github/workflows/release.yml; this file pins what the Dockerfile and
// .dockerignore must say so a change to them is a deliberate one.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
const lines = dockerfile.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
const froms = lines.filter((l) => l.startsWith('FROM '));

describe('Dockerfile', () => {
  it('has two stages from the same node:22-alpine image, both pinned to one digest', () => {
    expect(froms).toHaveLength(2);
    const digests = froms.map(
      (l) => /^FROM node:22-alpine@(sha256:[0-9a-f]{64})(?: AS \w+)?$/.exec(l)?.[1],
    );
    expect(digests[0]).toBeDefined();
    expect(digests[1]).toBe(digests[0]);
  });

  it('every npm ci runs with --ignore-scripts, and the runtime stage installs without dev dependencies', () => {
    const cis = lines.filter((l) => /npm ci/.test(l));
    expect(cis).toHaveLength(2);
    for (const l of cis) expect(l).toContain('--ignore-scripts');
    expect(cis[1]).toContain('--omit=dev');
  });

  it('runs as the unprivileged node user, from /repo, with the built CLI as the entrypoint and /repo as the default path', () => {
    const after = lines.slice(lines.indexOf(froms[1] as string));
    expect(after).toContain('USER node');
    expect(after.indexOf('USER node')).toBeLessThan(after.indexOf('WORKDIR /repo'));
    expect(after).toContain('ENTRYPOINT ["node", "/app/dist/cli/main.js"]');
    expect(after).toContain('CMD ["/repo"]');
  });

  it('copies only the build inputs and the built dist: every COPY source is on the allow-list', () => {
    const allowed = new Set([
      'package.json',
      'npm-shrinkwrap.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'src',
    ]);
    const copies = lines.filter((l) => l.startsWith('COPY '));
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) {
      if (c.startsWith('COPY --from=build ')) {
        expect(c).toBe('COPY --from=build /app/dist ./dist');
        continue;
      }
      const sources = c
        .replace(/^COPY /, '')
        .split(/\s+/)
        .slice(0, -1);
      for (const source of sources) expect(allowed.has(source), c).toBe(true);
    }
  });

  it('names the source repository in a label and carries no licence label (none is granted yet)', () => {
    expect(dockerfile).toContain(
      'org.opencontainers.image.source="https://github.com/naren-ambati/TripCurve"',
    );
    expect(dockerfile).not.toContain('image.licenses');
  });

  it('copies package.json and the shrinkwrap before each npm ci', () => {
    for (const [i, l] of lines.entries()) {
      if (!/npm ci/.test(l)) continue;
      const before = lines.slice(0, i).join('\n');
      expect(before, l).toContain('COPY package.json npm-shrinkwrap.json');
    }
  });
});

describe('.dockerignore', () => {
  it('is an allow-list: everything is excluded, then exactly the build inputs are let in', () => {
    const rules = ignore.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(rules[0]).toBe('*');
    expect(rules.slice(1).sort()).toEqual(
      [
        '!npm-shrinkwrap.json',
        '!package.json',
        '!src',
        '!tsconfig.build.json',
        '!tsconfig.json',
      ].sort(),
    );
  });
});

describe('the smoke test', () => {
  it('exists and is the one the release workflow runs before any push', () => {
    expect(existsSync(join(ROOT, 'scripts', 'docker-smoke.mjs'))).toBe(true);
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')).toContain(
      'node scripts/docker-smoke.mjs',
    );
  });
  it('runs every container with no network and the fixture mounted read-only', () => {
    const smoke = readFileSync(join(ROOT, 'scripts', 'docker-smoke.mjs'), 'utf8');
    expect(smoke).toContain("'--network', 'none'");
    expect(smoke).toContain(':/repo:ro');
  });
  it('makes its temporary directory readable by the container user (a Linux bind mount keeps host modes)', () => {
    const smoke = readFileSync(join(ROOT, 'scripts', 'docker-smoke.mjs'), 'utf8');
    expect(smoke).toContain('chmodSync(empty, 0o755)');
  });
});
