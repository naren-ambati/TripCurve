import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatInterval, parseVersion, unknownInterval } from '../../src/kb/index.js';
import { readConfig } from '../../src/parse/config/index.js';
import { type InputFile, intake } from '../../src/parse/intake/index.js';
import { readKubernetes } from '../../src/parse/k8s/index.js';
import {
  hintFromDeclaration,
  hintFromDockerfile,
  hintFromImage,
  interpretNodeImage,
  REASON_DIGEST_ONLY,
  REASON_ENGINES_FORM,
  REASON_NOT_NODE_IMAGE,
  REASON_PINNED_BY_DIGEST as REASON_PINNED,
  REASON_TAG_NOT_EXACT,
  REASON_VARIABLE,
  readPackageEngines,
} from '../../src/parse/node/index.js';
import { txt, where } from '../support/render.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function onlyFile(path: string, text: string): InputFile {
  const t = makeTree();
  trees.push(t);
  t.write(path, text);
  const f = intake({ root: t.root }).files[0];
  if (!f) throw new Error('no file read');
  return f;
}
const shown = (o: ReturnType<typeof interpretNodeImage>) =>
  'interval' in o ? formatInterval(o.interval) : o.unknownReason;

describe('interpretNodeImage', () => {
  it('reads an exact version from an official node tag', () => {
    expect(shown(interpretNodeImage('node:22.23'))).toBe('22.23.0 up to, not including, 22.24.0');
    expect(shown(interpretNodeImage('node:22.23.2'))).toBe('22.23.2 up to, not including, 22.23.3');
    expect(interpretNodeImage('docker.io/library/node:24.22.3')).toEqual({
      interval: parseVersion('24.22.3'),
    });
    expect(interpretNodeImage('library/node:20.1')).toEqual({ interval: parseVersion('20.1') });
  });
  it('turns a tag that pins fewer parts into an interval', () => {
    expect(interpretNodeImage('node:22')).toEqual({ interval: parseVersion('22') });
    expect(shown(interpretNodeImage('node:22'))).toBe('22.0.0 up to, not including, 23.0.0');
    expect(interpretNodeImage('node:22.23')).toEqual({ interval: parseVersion('22.23') });
  });
  it('turns lts, current, latest and a missing tag into all versions', () => {
    for (const ref of [
      'node:lts',
      'node:current',
      'node:latest',
      'node',
      'docker.io/library/node',
    ]) {
      expect(interpretNodeImage(ref), ref).toEqual({ interval: unknownInterval() });
    }
    expect(shown(interpretNodeImage('node:lts'))).toBe('all versions');
  });
  it('one variant suffix from the tag grammar does not change the version (B3)', () => {
    const cases: [string, string][] = [
      ['node:22-alpine', '22'],
      ['node:22.23-slim', '22.23'],
      ['node:22.23.2-bookworm', '22.23.2'],
      ['node:22.23.2-bookworm-slim', '22.23.2'],
      ['node:22-alpine3.20', '22'],
      ['node:22-alpine3.9', '22'],
      ['node:24-bullseye-slim', '24'],
      ['node:22.23.2-trixie', '22.23.2'],
      ['node:22.23.2-trixie-slim', '22.23.2'],
      ['node:22.23.2-bullseye', '22.23.2'],
    ];
    for (const [ref, version] of cases) {
      expect(interpretNodeImage(ref), ref).toEqual({ interval: parseVersion(version) });
    }
    expect(interpretNodeImage('node:lts-alpine')).toEqual({ interval: unknownInterval() });
    expect(interpretNodeImage('node:latest-slim')).toEqual({ interval: unknownInterval() });
  });
  it('is unknown, with a fixed reason, for a suffix or form outside the grammar', () => {
    const cases: string[] = [
      'node:22.23-alpinish',
      'node:22.23.2-custom',
      'node:22-windowsservercore-ltsc2022',
      'node:22-alpine-alpine',
      'node:22-alpine-slim',
      'node:22-bullseye-slim-alpine',
      'node:22-alpine3.200',
      'node:22-alpine3',
      'node:22-buster',
      'node:22-noble',
      'node:22-bookworm-bookworm',
      'node:22-',
      'node:22--slim',
      'node:lts-iron',
      'node:v22.23',
      'node:22.23.2.1',
      'node:22.x',
      'node:22.023.2',
      'node:022',
      'node:22.00',
      'node:iron',
      'node:Latest',
      'node:',
    ];
    for (const ref of cases) {
      expect(shown(interpretNodeImage(ref)), ref).toBe(REASON_TAG_NOT_EXACT);
    }
  });
  it('is unknown, with its own fixed reason, for a digest, another image or a variable', () => {
    const cases: [string, string][] = [
      ['node@sha256:abc', REASON_DIGEST_ONLY],
      ['@sha256:abc', REASON_DIGEST_ONLY],
      ['python:3.12', REASON_NOT_NODE_IMAGE],
      ['ghcr.io/acme/node:22.23', REASON_NOT_NODE_IMAGE],
      ['registry.local:5000/node:22.23', REASON_NOT_NODE_IMAGE],
      [`node:\${V}`, REASON_VARIABLE],
      ['', REASON_DIGEST_ONLY],
    ];
    for (const [ref, reason] of cases) expect(shown(interpretNodeImage(ref)), ref).toBe(reason);
  });
  it('a tag written with a digest is unknown: the runtime pulls the digest, the tag is only a label (m1)', () => {
    for (const ref of [
      'node:22.23.2@sha256:abc',
      'node:22.23@sha256:abc',
      'docker.io/library/node:22.23@sha256:abc',
      'node:lts@sha256:abc',
    ]) {
      expect(interpretNodeImage(ref), ref).toEqual({ unknownReason: REASON_PINNED });
    }
    // another image keeps its own reason; a digest alone keeps its own
    expect(interpretNodeImage('python:3.12@sha256:abc')).toEqual({
      unknownReason: REASON_NOT_NODE_IMAGE,
    });
    expect(interpretNodeImage('node@sha256:abc')).toEqual({ unknownReason: REASON_DIGEST_ONLY });
  });
  it('the same holds for a Dockerfile FROM with a tag and a digest', () => {
    const file = onlyFile('Dockerfile', 'FROM node:22.23@sha256:abc\n');
    expect(hintFromDockerfile(file)?.unknownReason).toBe(REASON_PINNED);
  });
  it('never throws on odd text', () => {
    for (const odd of ['::', '/', ':', '@@', 'node:', 'a/b/c:d:e', '\u0000', 'x'.repeat(100_000)]) {
      expect(() => interpretNodeImage(odd)).not.toThrow();
    }
    expect(interpretNodeImage('node:')).toMatchObject({ unknownReason: REASON_TAG_NOT_EXACT });
    expect(interpretNodeImage(`node:22${'-slim'.repeat(50_000)}`)).toMatchObject({
      unknownReason: REASON_TAG_NOT_EXACT,
    });
  });
});

describe('hints from each evidence source (one hint per source, none chosen)', () => {
  it('reads the image tag of the demo web container with its source', () => {
    const k = readKubernetes(intake({ root: join(FIXTURES, 'k8s', 'web') }));
    const container = k.workloads[0]?.containers[0];
    if (!container) throw new Error('no container');
    const h = hintFromImage(container.image, container.source);
    expect(h.sourceKind).toBe('image-tag');
    expect(h.interval).toEqual(parseVersion('22.23'));
    expect(h.text && txt(h.text)).toBe('node:22.23');
    expect(where(h.sourceRef)).toBe('web.yaml:22');
  });
  it('gives an unknown hint when the container has no readable image', () => {
    const k = readKubernetes(intake({ root: join(FIXTURES, 'k8s', 'web') }));
    const container = k.workloads[0]?.containers[0];
    if (!container) throw new Error('no container');
    const none = hintFromImage(undefined, container.source);
    expect(none.interval).toBeUndefined();
    expect(none.unknownReason).toBeDefined();
    const bad = hintFromImage({ unresolved: true, reason: 'x' }, container.source);
    expect(bad.interval).toBeUndefined();
  });
  it('reads a runtime.node declaration, as declared', () => {
    const cfg = readConfig(intake({ root: join(FIXTURES, 'config', 'valid') }));
    const decl = cfg.declarations.find((d) => d.key === 'runtime.node');
    if (!decl) throw new Error('no declaration');
    const h = hintFromDeclaration(decl);
    expect(h.sourceKind).toBe('declaration');
    expect(h.interval).toEqual(parseVersion('22.23.2'));
    expect(h.sourceRef.type).toBe('declared');
    expect(where(h.sourceRef)).toBe('tripcurve.yaml:11');
  });
  it('an undeclarable version text is unknown, not "all versions"', () => {
    const t = makeTree();
    trees.push(t);
    t.write(
      'tripcurve.yaml',
      'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "lts"\n',
    );
    const cfg = readConfig(intake({ root: t.root }));
    const decl = cfg.declarations[0];
    if (!decl) throw new Error('no declaration');
    const h = hintFromDeclaration(decl);
    expect(h.interval).toBeUndefined();
    expect(h.unknownReason).toBeDefined();
  });
});

describe('hintFromDockerfile', () => {
  const hintOf = (text: string) => hintFromDockerfile(onlyFile('Dockerfile', text));
  it('reads the FROM line, with its line number', () => {
    const h = hintOf('# comment\nFROM node:22.23.2\nRUN npm ci\n');
    expect(h?.interval).toEqual(parseVersion('22.23.2'));
    expect(h && where(h.sourceRef)).toBe('Dockerfile:2');
    expect(h?.sourceKind).toBe('linked-dockerfile');
  });
  it('uses the last stage, and follows FROM <earlier stage> back to its image', () => {
    const multi = 'FROM node:20.1 AS build\nRUN x\nFROM node:22.23 AS run\nCOPY --from=build a b\n';
    expect(hintOf(multi)?.interval).toEqual(parseVersion('22.23'));
    const chain = 'FROM node:22.23.2 AS base\nFROM base AS final\nCMD x\n';
    const h = hintOf(chain);
    expect(h?.interval).toEqual(parseVersion('22.23.2'));
    expect(h && where(h.sourceRef)).toBe('Dockerfile:1');
    const toOther = 'FROM node:22.23 AS build\nFROM python:3.12 AS run\n';
    expect(hintOf(toOther)?.unknownReason).toBe(REASON_NOT_NODE_IMAGE);
  });
  it('handles a platform flag, a continuation and lower case', () => {
    expect(hintOf('from --platform=linux/amd64 \\\n  node:22.23.2 as app\n')?.interval).toEqual(
      parseVersion('22.23.2'),
    );
  });
  it('is unknown for a variable tag and scratch, all versions for a missing tag, and absent with no FROM', () => {
    expect(hintOf('ARG V=22\nFROM node:$' + '{V}\n')?.unknownReason).toBe(REASON_VARIABLE);
    expect(hintOf('FROM scratch\n')?.unknownReason).toBe(REASON_NOT_NODE_IMAGE);
    expect(hintOf('FROM node\n')?.interval).toEqual(unknownInterval()); // no tag means latest
    expect(hintOf('RUN echo\n')).toBeUndefined();
    expect(hintOf('FROM\n')).toBeUndefined();
  });
  it('never loops on a stage that names itself', () => {
    expect(hintOf('FROM a AS a\n')?.unknownReason).toBe(REASON_NOT_NODE_IMAGE);
    expect(hintOf('FROM b AS a\nFROM a AS b\n')?.unknownReason).toBe(REASON_NOT_NODE_IMAGE);
  });
});

describe('readPackageEngines', () => {
  const read = (text: string) => readPackageEngines(onlyFile('package.json', text));
  it('reads engines.node in the grammar, with the line it is on', () => {
    const r = read('{\n  "name": "x",\n  "engines": {\n    "node": ">=22.19.0 <23.0.0"\n  }\n}\n');
    expect(r.hint?.sourceKind).toBe('engines');
    expect(r.hint && formatInterval(r.hint.interval ?? parseVersion('0'))).toBe(
      '22.19.0 up to, not including, 23.0.0',
    );
    expect(r.hint && where(r.hint.sourceRef)).toBe('package.json:4');
    expect(r.hint?.text && txt(r.hint.text)).toBe('>=22.19.0 <23.0.0');
  });
  it('knows no interval for a range outside the grammar, so it cannot narrow', () => {
    const r = read('{"engines": {"node": "^22 || ^24"}}');
    expect(r.hint?.interval).toBeUndefined();
    expect(r.hint?.unknownReason).toBe(REASON_ENGINES_FORM);
  });
  it('gives no hint when there is no engines.node, and reads the last of a duplicate key', () => {
    expect(read('{"name": "x"}')).toEqual({});
    expect(read('{"engines": []}')).toEqual({});
    expect(read('{"engines": {"npm": "10"}}')).toEqual({});
    expect(read('[]')).toEqual({});
    const dup = read('{"engines": {"node": ">=1.0.0"},\n"engines": {"node": ">=22.19.0"}}');
    expect(dup.hint?.interval && formatInterval(dup.hint.interval)).toBe('22.19.0 and later');
    expect(dup.hint?.text && txt(dup.hint.text)).toBe('>=22.19.0');
    expect(dup.hint && where(dup.hint.sourceRef)).toBe('package.json:2');
  });
  it('a non-text engines.node is unknown', () => {
    expect(read('{"engines": {"node": 22}}').hint?.interval).toBeUndefined();
  });
  it('reports bad JSON as parse-error and deep nesting as over-depth, never crashing', () => {
    expect(read('{"engines": ').unchecked?.reasonCode).toBe('parse-error');
    const deep = `{"a": ${'['.repeat(200_000)}${']'.repeat(200_000)}, "engines": {"node": ">=22.19.0"}}`;
    const r = read(deep);
    expect(r.unchecked?.reasonCode).toBe('over-depth');
    expect(r.hint).toBeUndefined();
  });
});
