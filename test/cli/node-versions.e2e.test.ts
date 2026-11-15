// The built command on images that pin no exact Node version:
// the expected demo for bolt B3 is "node:lts prints VERSION-DEPENDENT with one line per range".
// The structure is checked against the shipped knowledge base, so widening a range in the data
// does not break the test; exact output for fixed ranges is in the resolver tests.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  basisWords,
  defaultKnowledgeBase,
  parseRange,
  partitionInterval,
  unknownInterval,
} from '../../src/kb/index.js';
import { DEMO_FILES } from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const ROOT = join(import.meta.dirname, '..', '..');
const LTS = join(ROOT, 'test', 'fixtures', 'link', 'web-demo-lts');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function runWithImage(tag: string, extraServer = '') {
  const tree = makeTree();
  trees.push(tree);
  for (const [path, text] of Object.entries(DEMO_FILES)) {
    let body = text;
    if (path === 'k8s/web.yaml') body = body.replace('image: node:22.23', `image: ${tag}`);
    if (path === 'src/server.ts')
      body = body.replace('server.listen(8080);', `${extraServer}server.listen(8080);`);
    tree.write(path, body);
  }
  return runBuilt(['.'], { cwd: tree.root });
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('node:lts: VERSION-DEPENDENT with one line per range', () => {
  const run = runBuilt(['.'], { cwd: LTS });
  const kb = defaultKnowledgeBase();
  const entries = kb.entries.filter((e) => e.subject === 'node-idle-close');

  it('exits 1 with nothing on stderr, and never says PASS or clean', () => {
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(/PASS|All checks passed|No failures/);
    // the fixture has no preStop and no drain, so T2 fails and T3 is not evaluated (bolt B4)
    expect(run.stdout).toContain(
      'Summary: 1 failed, 1 version-dependent, 1 not evaluated; not a clean result',
    );
  });

  it('prints the headline, the image tag as quoted input and the instruction', () => {
    expect(run.stdout).toContain('  VERSION-DEPENDENT T1  Node version unknown\n');
    expect(run.stdout).toContain(
      '           Node version     image "node:lts" at "k8s/web.yaml":17\n',
    );
    expect(run.stdout).toContain('           every known Node range evaluated:\n');
    expect(flat(run.stdout)).toContain(
      'pin the image to an exact Node version tag, or declare runtime.node',
    );
  });

  it('has a line for every knowledge-base range, with its value, verdict and basis', () => {
    const text = flat(run.stdout);
    for (const e of entries) {
      const label = (e.rangeLabel ?? e.id).replace(/^Node /, '');
      expect(text, e.id).toContain(
        `${label} idle close ${e.value} s would FAIL (${basisWords(e)})`,
      );
    }
  });

  it('has a line for every stretch no entry covers, and each reads unresolved', () => {
    const parts = entries.flatMap((e) => {
      const interval = parseRange(e.applies.versionRange);
      return interval === undefined ? [] : [{ item: e.id, interval }];
    });
    const gaps = partitionInterval(unknownInterval(), parts).filter((s) => s.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(1);
    // a long label keeps its reason on the next line, so count in the flattened text
    const reasons = flat(run.stdout).split('unresolved: no knowledge-base entry covers this range');
    expect(reasons.length - 1).toBe(gaps.length);
  });

  it('is plain ASCII, at most 80 columns, and no line starts with a quote', () => {
    for (const line of run.stdout.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
      expect(line.startsWith('"')).toBe(false);
    }
  });

  it('is the same on a second run', () => {
    expect(runBuilt(['.'], { cwd: LTS }).stdout).toBe(run.stdout);
  });
});

describe('other tags that pin no exact version', () => {
  it.each(['node:current', 'node:latest', 'node', 'node:lts-alpine'])(
    '%s is all versions',
    (tag) => {
      const run = runWithImage(tag);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('  VERSION-DEPENDENT T1  Node version unknown\n');
    },
  );

  it('node:22 and node:22-alpine are 22.x: the part before the first measured version is unresolved', () => {
    for (const tag of ['node:22', 'node:22-alpine']) {
      const run = runWithImage(tag);
      expect(run.status, tag).toBe(1);
      expect(run.stdout, tag).toContain(
        '  VERSION-DEPENDENT T1  Node version spans several knowledge-base ranges\n',
      );
      expect(flat(run.stdout), tag).toContain(
        '22 to before 22.12 unresolved: no knowledge-base entry covers this range',
      );
      expect(flat(run.stdout), tag).toContain('22.x from 22.12 idle close 6 s would FAIL');
      expect(run.stdout, tag).not.toMatch(/PASS/);
    }
  });

  it('node:22-alpine with an explicit 65000 ms is still not PASS while part of 22.x is unmeasured', () => {
    const run = runWithImage('node:22-alpine', 'server.keepAliveTimeout = 65000;\n');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('VERSION-DEPENDENT T1');
    expect(flat(run.stdout)).toContain('22.x from 22.12 idle close 66 s would PASS');
    expect(run.stdout).not.toMatch(/\n {2}PASS T1/);
    expect(run.stdout).not.toContain('All checks passed');
  });

  it('a tag with an unknown suffix is unresolved with a fixed reason, never a version', () => {
    const run = runWithImage('node:22-custom');
    expect(run.status).toBe(1);
    expect(flat(run.stdout)).toContain('the tag names no version in a form tripcurve reads');
    expect(run.stdout).toContain('UNRESOLVED T1');
  });

  it('node:20.11 has no entry: UNRESOLVED, and the reason names the version asked about', () => {
    const run = runWithImage('node:20.11');
    expect(run.status).toBe(1);
    expect(flat(run.stdout)).toContain(
      'UNRESOLVED T1 idle close not established: no knowledge-base entry covers Node 20.11',
    );
  });
});
