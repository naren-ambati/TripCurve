// Where the lightship release comes from: an exact pin in package.json, or the locked
// version in package-lock.json, npm-shrinkwrap.json, yarn.lock or pnpm-lock.yaml, found in the nearest folder
// that names the package at all (the rules of the Python pins, maintainer decision 2026-11-11). Only a release the
// measurement covers (9.1.0 and later 9.x) gives the default delay; anything else is UNRESOLVED.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, lineOf, ruleOf } from '../support/analyse.js';

afterEach(cleanupTrees);

const SERVER = [
  "import http from 'node:http';",
  "import { createLightship } from 'lightship';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
  'await createLightship();',
  '',
].join('\n');

const pkg = (version: string): string => JSON.stringify({ dependencies: { lightship: version } });
const lock = (version: string): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/lightship': { version } },
  });

function t2(files: Record<string, string>) {
  const { result } = analyseFiles({ 'src/server.ts': SERVER, ...files });
  return { f: ruleOf(result, 'T2'), assumptions: result.assumptions.map((a) => a.text) };
}
const reason = (f: ReturnType<typeof ruleOf>): string => {
  const step = f.chain.find((s) => s.label === 'reason');
  return step !== undefined && 'note' in step.value ? step.value.note : '';
};

describe('a known, covered release gives the measured default', () => {
  it.each([
    ['an exact pin in package.json', { 'package.json': pkg('9.1.0') }, 'package.json'],
    [
      'a locked version, with a range in package.json',
      { 'package.json': pkg('^9.0.0'), 'package-lock.json': lock('9.1.0') },
      'package-lock.json',
    ],
    ['npm-shrinkwrap.json', { 'npm-shrinkwrap.json': lock('9.1.0') }, 'npm-shrinkwrap.json'],
    ['yarn.lock', { 'yarn.lock': 'lightship@^9.1.0:\n  version "9.1.0"\n' }, 'yarn.lock'],
    [
      'pnpm-lock.yaml',
      { 'pnpm-lock.yaml': "lockfileVersion: '6.0'\npackages:\n  /lightship@9.1.0:\n    x: 1\n" },
      'pnpm-lock.yaml',
    ],
    ['a later 9.x release', { 'package.json': pkg('9.3.2') }, 'package.json'],
  ])('%s', (_name, files, file) => {
    const { f, assumptions } = t2(files);
    expect(lineOf(f)).toBe('PASS in-process drain 5 s (lightship)');
    expect(assumptions).toContain(`The lightship version is taken from "${file}".`);
  });
});

describe('the nearest folder that names the package decides', () => {
  it('a file in the source folder outranks the root, and a release it names that is not covered is UNRESOLVED', () => {
    const { f } = t2({ 'src/package.json': pkg('8.0.0'), 'package-lock.json': lock('9.1.0') });
    expect(f.kind).toBe('UNRESOLVED');
    expect(reason(f)).toBe('lightship 8.0.0 is not covered by a measured default');
  });

  it('a nearer package.json that does not name lightship lets the search go on up', () => {
    const { f, assumptions } = t2({
      'src/package.json': JSON.stringify({ dependencies: { express: '4.19.2' } }),
      'package-lock.json': lock('9.1.0'),
    });
    expect(f.kind).toBe('PASS');
    expect(assumptions).toContain('The lightship version is taken from "package-lock.json".');
  });

  it('a nearer file that names it with a range only is the answer: UNRESOLVED, not the root pin', () => {
    const { f } = t2({ 'src/package.json': pkg('^9.1.0'), 'package-lock.json': lock('9.1.0') });
    expect(f.kind).toBe('UNRESOLVED');
    expect(reason(f)).toBe('lightship is not pinned to an exact version in the files');
  });

  it('a nearer file in a form that is not read is the answer: UNRESOLVED', () => {
    const { f } = t2({
      'src/package.json': pkg('npm:other@1.0.0'),
      'package-lock.json': lock('9.1.0'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(reason(f)).toBe(
      'a lightship version in the repository is not in a form tripcurve reads',
    );
  });
});

describe('what is not evidence is UNRESOLVED, with the reason', () => {
  it.each([
    [
      'no file names it',
      { 'package.json': JSON.stringify({ name: 'x' }) },
      'no lightship version in the files',
    ],
    [
      'a range in package.json and no lock',
      { 'package.json': pkg('^9.1.0') },
      'lightship is not pinned to an exact version in the files',
    ],
    [
      'a pin and a lock that disagree',
      { 'package.json': pkg('9.1.0'), 'package-lock.json': lock('9.2.0') },
      'the repository pins different lightship versions',
    ],
    [
      'a lock file that does not parse',
      { 'package-lock.json': '{ "packages": ' },
      'a lightship version in the repository is not in a form tripcurve reads',
    ],
    [
      'a release before the measured one',
      { 'package.json': pkg('9.0.0') },
      'lightship 9.0.0 is not covered by a measured default',
    ],
    [
      'the next major',
      { 'package.json': pkg('10.0.0') },
      'lightship 10.0.0 is not covered by a measured default',
    ],
    [
      'an override naming the package',
      {
        'package.json': JSON.stringify({
          dependencies: { lightship: '9.1.0' },
          overrides: { lightship: '8.0.0' },
        }),
      },
      'a lightship version in the repository is not in a form tripcurve reads',
    ],
  ])('%s', (_name, files, why) => {
    const { f, assumptions } = t2(files);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.declare).toEqual(['declare drain.in_process_s for this workload in tripcurve.yaml']);
    expect(reason(f)).toBe(why);
    expect(assumptions.join('\n')).not.toContain('detects Kubernetes');
  });

  it('a lock file over the size limit was skipped, and a skipped file never lets the search go on up', () => {
    const { f } = t2({ 'package.json': pkg('9.1.0'), 'package-lock.json': ' '.repeat(5_000_001) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(reason(f)).toBe('a package file was skipped: larger than the 5 MB limit');
  });
});

describe('a literal shutdownDelay needs the release too, and is the written number', () => {
  it('known release: the number in the code, no Kubernetes assumption', () => {
    const src = SERVER.replace('createLightship()', 'createLightship({ shutdownDelay: 9000 })');
    const { result } = analyseFiles({ 'src/server.ts': src, 'package.json': pkg('9.1.0') });
    expect(lineOf(ruleOf(result, 'T2'))).toBe('PASS in-process drain 9 s (lightship)');
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('detects Kubernetes');
  });

  it('unknown release: UNRESOLVED (the meaning of the setting was measured on 9.1.0 only)', () => {
    const src = SERVER.replace('createLightship()', 'createLightship({ shutdownDelay: 9000 })');
    const { result } = analyseFiles({ 'src/server.ts': src });
    expect(ruleOf(result, 'T2').kind).toBe('UNRESOLVED');
  });
});
