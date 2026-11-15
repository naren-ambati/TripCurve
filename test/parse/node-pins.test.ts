// The exact version of one npm package (lightship, bolt B4) from package.json, package-lock.json,
// npm-shrinkwrap.json, yarn.lock and pnpm-lock.yaml. Only an EXACT version is evidence; a range, a tag or
// `*` is not, and a form the reader does not understand is `unreadable`, never skipped.
import { describe, expect, it } from 'vitest';
import { type NodePinReading, readNodePackagePin } from '../../src/parse/node/index.js';
import { fakeFile } from '../support/python.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

const read = (name: string, text: string): NodePinReading =>
  readNodePackagePin(
    fakeFile(text, name === 'package.json' ? 'package-json' : 'node-lock', name),
    'lightship',
  );
const pin = (version: string, line: number): NodePinReading => ({ state: 'pin', version, line });
const NONE: NodePinReading = { state: 'none' };
const UNPINNED: NodePinReading = { state: 'unpinned' };
const UNREADABLE: NodePinReading = { state: 'unreadable' };

const pkg = (deps: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'app', ...deps, ...extra }, null, 2);

describe('package.json', () => {
  it.each([
    [
      'an exact version in dependencies',
      pkg({ dependencies: { lightship: '9.1.0' } }),
      pin('9.1.0', 4),
    ],
    [
      'an exact version in devDependencies',
      pkg({ devDependencies: { lightship: '9.1.0' } }),
      pin('9.1.0', 4),
    ],
    [
      'optionalDependencies',
      pkg({ optionalDependencies: { lightship: '9.1.0' } }),
      pin('9.1.0', 4),
    ],
    ['the package is not named', pkg({ dependencies: { express: '4.19.2' } }), NONE],
    ['a caret range', pkg({ dependencies: { lightship: '^9.1.0' } }), UNPINNED],
    ['a tilde range', pkg({ dependencies: { lightship: '~9.1.0' } }), UNPINNED],
    ['a comparator', pkg({ dependencies: { lightship: '>=9.1.0 <10' } }), UNPINNED],
    ['a partial version', pkg({ dependencies: { lightship: '9.1' } }), UNPINNED],
    ['a wildcard', pkg({ dependencies: { lightship: '*' } }), UNPINNED],
    ['a tag', pkg({ dependencies: { lightship: 'latest' } }), UNPINNED],
    [
      'an alias to another package',
      pkg({ dependencies: { lightship: 'npm:other@1.0.0' } }),
      UNREADABLE,
    ],
    ['a git URL', pkg({ dependencies: { lightship: 'github:gajus/lightship#main' } }), UNREADABLE],
    ['a local path', pkg({ dependencies: { lightship: 'file:../lightship' } }), UNREADABLE],
    ['a workspace protocol', pkg({ dependencies: { lightship: 'workspace:*' } }), UNREADABLE],
    ['a pre-release', pkg({ dependencies: { lightship: '9.1.0-beta.1' } }), UNREADABLE],
    ['a version that is not text', pkg({ dependencies: { lightship: 9 } }), UNREADABLE],
    ['a dependency table that is not an object', pkg({ dependencies: ['lightship'] }), UNREADABLE],
    [
      'an override that names the package',
      pkg({ dependencies: { lightship: '9.1.0' } }, { overrides: { lightship: '8.0.0' } }),
      UNREADABLE,
    ],
    [
      'a nested override that names the package',
      pkg(
        { dependencies: { lightship: '9.1.0' } },
        { overrides: { express: { lightship: '8.0.0' } } },
      ),
      UNREADABLE,
    ],
    [
      'a yarn resolution that names it',
      pkg({}, { resolutions: { 'foo/lightship': '8.0.0' } }),
      UNREADABLE,
    ],
    [
      'a pnpm override that names it',
      pkg({}, { pnpm: { overrides: { lightship: '8.0.0' } } }),
      UNREADABLE,
    ],
    [
      'an override that does not name it',
      pkg({ dependencies: { lightship: '9.1.0' } }, { overrides: { express: '4.0.0' } }),
      pin('9.1.0', 4),
    ],
    [
      'a bundled dependency',
      pkg({ dependencies: { lightship: '9.1.0' } }, { bundledDependencies: ['lightship'] }),
      UNREADABLE,
    ],
  ])('%s', (_name, text, expected) => {
    expect(read('package.json', text)).toEqual(expected);
  });

  it('a package.json that does not parse and names the package cannot be trusted; one that does not name it says nothing', () => {
    expect(read('package.json', '{ "dependencies": { "lightship": "9.1.0", ')).toEqual(UNREADABLE);
    expect(read('package.json', '{ nonsense')).toEqual(NONE);
    expect(read('package.json', '[]')).toEqual(NONE);
  });
});

describe('package-lock.json and npm-shrinkwrap.json', () => {
  const lock3 = (packages: Record<string, unknown>): string =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }, null, 2);

  it.each(['package-lock.json', 'npm-shrinkwrap.json'])(
    '%s: lockfile 3 reads the installed version',
    (name) => {
      const text = lock3({ 'node_modules/lightship': { version: '9.1.0' } });
      expect(read(name, text)).toEqual({ state: 'pin', version: '9.1.0', line: 5 });
    },
  );

  it.each([
    ['not named', lock3({ 'node_modules/express': { version: '4.19.2' } }), NONE],
    [
      'a package of a similar name',
      lock3({ 'node_modules/lightship-extra': { version: '1.0.0' } }),
      NONE,
    ],
    [
      'a scoped package ending in the name',
      lock3({ 'node_modules/@x/lightship': { version: '1.0.0' } }),
      NONE,
    ],
    [
      'a nested copy of the same version',
      lock3({
        'node_modules/lightship': { version: '9.1.0' },
        'node_modules/a/node_modules/lightship': { version: '9.1.0' },
      }),
      { state: 'pin', version: '9.1.0', line: 5 },
    ],
    [
      'two different versions',
      lock3({
        'node_modules/lightship': { version: '9.1.0' },
        'node_modules/a/node_modules/lightship': { version: '8.0.0' },
      }),
      { state: 'conflict' },
    ],
    ['a link', lock3({ 'node_modules/lightship': { link: true, resolved: '../l' } }), UNREADABLE],
    [
      'a bundled copy',
      lock3({ 'node_modules/lightship': { version: '9.1.0', inBundle: true } }),
      UNREADABLE,
    ],
    [
      'a version that is not exact',
      lock3({ 'node_modules/lightship': { version: '9.1.0-rc.1' } }),
      UNREADABLE,
    ],
    ['no version', lock3({ 'node_modules/lightship': {} }), UNREADABLE],
    ['a lock that does not parse', '{ "packages": ', UNREADABLE],
    ['a lock that is not an object', '[]', UNREADABLE],
  ])('%s', (_name, text, expected) => {
    expect(read('package-lock.json', text)).toEqual(expected);
  });

  it('lockfile 1 reads dependencies, nested ones too', () => {
    const v1 = JSON.stringify(
      {
        lockfileVersion: 1,
        dependencies: {
          a: { version: '1.0.0', dependencies: { lightship: { version: '9.1.0' } } },
        },
      },
      null,
      2,
    );
    expect(read('package-lock.json', v1)).toEqual({ state: 'pin', version: '9.1.0', line: 7 });
    const top = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { lightship: { version: '9.1.0' } },
    });
    expect(read('package-lock.json', top)).toMatchObject({ state: 'pin', version: '9.1.0' });
  });
});

describe('review minor 4: aliases and zero-padded versions', () => {
  const lock3 = (entry: Record<string, unknown>): string =>
    JSON.stringify(
      { lockfileVersion: 3, packages: { '': {}, 'node_modules/lightship': entry } },
      null,
      2,
    );
  it('a lock entry whose name differs (an npm alias) is not lightship', () => {
    expect(read('package-lock.json', lock3({ name: 'other', version: '9.1.0' }))).toEqual(
      UNREADABLE,
    );
  });
  it('a lock entry that names itself lightship is fine', () => {
    expect(read('package-lock.json', lock3({ name: 'lightship', version: '9.1.0' }))).toMatchObject(
      { state: 'pin' },
    );
  });
  it.each(['9.1.01', '09.1.0', '9.01.0'])('%s is rejected in every file', (v) => {
    expect(read('package.json', pkg({ dependencies: { lightship: v } }))).toEqual(UNREADABLE);
    expect(read('package-lock.json', lock3({ version: v }))).toEqual(UNREADABLE);
    expect(read('yarn.lock', `lightship@^9:\n  version "${v}"\n`)).toEqual(UNREADABLE);
    expect(read('pnpm-lock.yaml', `packages:\n  /lightship@${v}:\n    x: 1\n`)).toEqual(UNREADABLE);
  });
  it('zero itself is fine', () => {
    expect(read('package.json', pkg({ dependencies: { lightship: '9.0.0' } }))).toMatchObject({
      state: 'pin',
    });
  });
});

describe('yarn.lock', () => {
  it.each([
    [
      'classic',
      '# yarn lockfile v1\n\nlightship@^9.1.0:\n  version "9.1.0"\n  resolved "https://x"\n',
      pin('9.1.0', 3),
    ],
    [
      'classic, several specs',
      '"lightship@^9.0.0", "lightship@^9.1.0":\n  version "9.1.0"\n',
      pin('9.1.0', 1),
    ],
    [
      'berry',
      '__metadata:\n  version: 8\n\n"lightship@npm:^9.1.0":\n  version: 9.1.0\n  resolution: "lightship@npm:9.1.0"\n',
      pin('9.1.0', 4),
    ],
    ['the package is not named', 'express@^4:\n  version "4.19.2"\n', NONE],
    ['a scoped package of the same tail', '"@x/lightship@^1":\n  version "1.0.0"\n', NONE],
    [
      'two versions',
      'lightship@^8:\n  version "8.0.0"\n\nlightship@^9:\n  version "9.1.0"\n',
      { state: 'conflict' },
    ],
    ['an alias', '"lightship@npm:other@^1":\n  version: 1.0.0\n', UNREADABLE],
    ['no version line', 'lightship@^9:\n  resolved "x"\n', UNREADABLE],
    ['a version that is not exact', 'lightship@^9:\n  version "9.1.0-beta"\n', UNREADABLE],
  ])('%s', (_name, text, expected) => {
    expect(read('yarn.lock', text)).toEqual(expected);
  });
});

describe('pnpm-lock.yaml', () => {
  it.each([
    [
      'lockfile 6, a leading slash',
      "lockfileVersion: '6.0'\n\npackages:\n\n  /lightship@9.1.0:\n    resolution: {integrity: x}\n",
      pin('9.1.0', 5),
    ],
    [
      'lockfile 9, snapshots',
      "lockfileVersion: '9.0'\n\nsnapshots:\n\n  lightship@9.1.0:\n    dependencies: {}\n",
      pin('9.1.0', 5),
    ],
    ['a peer suffix', 'packages:\n  /lightship@9.1.0(express@4.0.0):\n    x: 1\n', pin('9.1.0', 2)],
    ['quoted keys', "packages:\n  'lightship@9.1.0':\n    x: 1\n", pin('9.1.0', 2)],
    ['not named', 'packages:\n  /express@4.19.2:\n    x: 1\n', NONE],
    ['a scoped package', 'packages:\n  /@x/lightship@1.0.0:\n    x: 1\n', NONE],
    [
      'the importers section does not count',
      'importers:\n  .:\n    dependencies:\n      lightship:\n        version: 9.1.0\n',
      NONE,
    ],
    [
      'two versions',
      'packages:\n  /lightship@8.0.0:\n    x: 1\n  /lightship@9.1.0:\n    x: 1\n',
      { state: 'conflict' },
    ],
    [
      'an override that names it',
      'overrides:\n  lightship: 8.0.0\n\npackages:\n  /lightship@9.1.0:\n    x: 1\n',
      UNREADABLE,
    ],
    ['a version that is not exact', 'packages:\n  /lightship@9.1.0-rc.1:\n    x: 1\n', UNREADABLE],
  ])('%s', (_name, text, expected) => {
    expect(read('pnpm-lock.yaml', text)).toEqual(expected);
  });
});

describe('hostile files', () => {
  it('a very long line, a deeply nested JSON and thousands of entries do not crash or freeze', {
    timeout: SCALING_TEST_TIMEOUT_MS,
  }, () => {
    expect(read('yarn.lock', `${'x'.repeat(1_000_000)}\n`)).toEqual(NONE);
    const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
    expect(read('package-lock.json', deep)).toEqual(UNREADABLE);
    expect(read('package.json', deep)).toEqual(NONE);
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `/p${i}@1.0.0:\n  x: 1\n`).join('');
    const ratio = scalingRatio((n) => read('pnpm-lock.yaml', `packages:\n${lines(n)}`), 5000);
    expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    const entries = (n: number): string =>
      JSON.stringify({
        packages: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]),
        ),
      });
    expect(scalingRatio((n) => read('package-lock.json', entries(n)), 5000)).toBeLessThan(
      LINEAR_RATIO_LIMIT,
    );
  });

  it('a package that claims to be a prototype property is just a name', () => {
    expect(
      read('package.json', pkg({ dependencies: { __proto__: '9.1.0', constructor: '1.0.0' } })),
    ).toEqual(NONE);
  });
});
