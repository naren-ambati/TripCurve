// Exact version pins in the repository (maintainer decision 2026-11-11): requirements*.txt, pyproject.toml
// (PEP 621 and Poetry), poetry.lock and uv.lock. A small line-oriented reader; only an EXACT pin is
// evidence, anything it cannot read is `unreadable`, and hostile text never crashes or freezes it.
import { describe, expect, it } from 'vitest';
import { type PinReading, readPythonPins } from '../../src/parse/python/index.js';
import { fakeFile } from '../support/python.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

const pins = (name: string, text: string, pkg: 'gunicorn' | 'uvicorn' = 'gunicorn'): PinReading =>
  readPythonPins(fakeFile(text, 'python-pin', name), pkg);
const pin = (version: string, line: number): PinReading => ({ state: 'pin', version, line });
const NONE: PinReading = { state: 'none' };
const UNPINNED: PinReading = { state: 'unpinned' };
const UNREADABLE: PinReading = { state: 'unreadable', reason: 'form' };
const MARKER: PinReading = { state: 'unreadable', reason: 'marker' };
const CONFLICT: PinReading = { state: 'conflict' };

describe('requirements*.txt', () => {
  it.each([
    ['an exact pin', 'gunicorn==26.2.0\n', pin('26.2.0', 1)],
    ['the other package', 'uvicorn==0.54.0\n', NONE],
    [
      'spaces, extras and a comment',
      'flask\n  Gunicorn [gevent] == 26.2.0   # prod\n',
      pin('26.2.0', 2),
    ],
    ['name spelling is normalised', 'GUNICORN==26.2.0\n', pin('26.2.0', 1)],
    [
      'hashes are ignored',
      'gunicorn==26.2.0 --hash=sha256:abc \\\n    --hash=sha256:def\n',
      pin('26.2.0', 1),
    ],
    ['a two-part version is the same release', 'gunicorn==26.2\n', pin('26.2.0', 1)],
    [
      'a comment line and a blank line',
      '# gunicorn==1.0.0\n\ngunicorn==26.2.0\n',
      pin('26.2.0', 3),
    ],
    ['CRLF', 'a==1\r\ngunicorn==26.2.0\r\n', pin('26.2.0', 2)],
  ])('%s', (_l, text, expected) => {
    expect(pins('requirements.txt', text)).toEqual(expected);
  });

  it.each([
    ['>=', 'gunicorn>=26\n'],
    ['~=', 'gunicorn~=26.2\n'],
    ['a range', 'gunicorn>=26,<27\n'],
    ['a comma with ==', 'gunicorn==26.2.0,!=26.2.1\n'],
    ['unpinned', 'gunicorn\n'],
    ['a wildcard', 'gunicorn==26.*\n'],
    ['!=', 'gunicorn!=25.0.0\n'],
  ])('%s is named without an exact pin (it stops the search, it is not a pin)', (_l, text) => {
    expect(pins('requirements.txt', text)).toEqual(UNPINNED);
  });

  it('an environment marker on the pin makes it unreadable: it applies only under that marker', () => {
    for (const marker of [
      '; python_version >= "3.9"',
      "; python_version<'3'",
      ' ; sys_platform == "win32"',
    ]) {
      expect(pins('requirements.txt', `gunicorn==26.2.0${marker}\n`)).toEqual(MARKER);
    }
    // a marker on another package is not about this package
    expect(pins('requirements.txt', 'flask==3.0.0 ; python_version >= "3.9"\n')).toEqual(NONE);
    // a marker on a line that is not an exact pin is unpinned, as without it
    expect(pins('requirements.txt', "gunicorn>=20 ; python_version<'3'\n")).toEqual(UNPINNED);
  });

  it.each([
    ['a pre-release', 'gunicorn==26.2.0rc1\n'],
    ['a direct URL', 'gunicorn @ https://example.com/g.whl\n'],
    ['a VCS line naming it', 'git+https://example.com/x.git#egg=gunicorn\n'],
    ['a four-part version', 'gunicorn==26.2.0.1\n'],
    ['a local version', 'gunicorn==26.2.0+local\n'],
  ])('%s is a pin tripcurve does not read', (_l, text) => {
    expect(pins('requirements.txt', text)).toEqual(UNREADABLE);
  });

  it('two different pins in one file conflict; the same pin twice does not', () => {
    expect(pins('requirements.txt', 'gunicorn==26.2.0\ngunicorn==27.0.0\n')).toEqual(CONFLICT);
    expect(pins('requirements.txt', 'gunicorn==26.2.0\ngunicorn==26.2\n')).toEqual(
      pin('26.2.0', 1),
    );
  });

  it.each([
    ['-r', '-r base.txt\n'],
    ['-r glued', '-rbase.txt\n'],
    ['--requirement', '--requirement base.txt\n'],
    ['--requirement=', '--requirement=base.txt\n'],
    ['-c', '-c constraints.txt\n'],
    ['--constraint', '--constraint=constraints.txt\n'],
    ['-e', '-e .\n'],
    ['-e with a VCS URL', '-e git+https://github.com/benoitc/gunicorn.git@abc#egg=gunicorn\n'],
    ['--editable', '--editable ./local\n'],
    ['after the pin', 'gunicorn==26.2.0\n--extra-index-url http://x\n-c constraints.txt\n'],
  ])('an option line that can bring in requirements (%s) makes the file unreadable', (_l, text) => {
    expect(pins('requirements.txt', text)).toEqual(UNREADABLE);
  });

  it.each([
    ['a URL', 'https://files.example/gunicorn-20.1.0.tar.gz\n'],
    ['a VCS URL', 'git+https://example.com/x.git#egg=other\n'],
    ['a relative path', './vendor/pkg\n'],
    ['a parent path', '../vendor/pkg\n'],
    ['an absolute path', '/srv/pkg\n'],
    ['a wheel file', 'pkg-1.0-py3-none-any.whl\n'],
    ['a file URL', 'file:///srv/pkg\n'],
    ['text that is not a requirement', '!!!\n'],
  ])('%s makes the file unreadable, whatever it names', (_l, text) => {
    expect(pins('requirements.txt', `gunicorn==26.2.0\n${text}`)).toEqual(UNREADABLE);
  });

  it('other options (index URLs, hashes, flags) do not bring in requirements', () => {
    expect(
      pins(
        'requirements.txt',
        '--index-url https://x\n--extra-index-url http://y\n--pre\n--no-binary :all:\n--trusted-host z\ngunicorn==26.2.0\n',
      ),
    ).toEqual(pin('26.2.0', 6));
  });
});

describe('pyproject.toml', () => {
  it('PEP 621 dependencies with ==, single and multi-line, with extras and markers', () => {
    expect(
      pins(
        'pyproject.toml',
        '[project]\nname = "x"\ndependencies = [\n  "flask>=3",\n  "gunicorn==26.2.0",  # pinned\n  "uvicorn[standard]==0.54.0; python_version > \'3.8\'",\n]\n',
      ),
    ).toEqual(pin('26.2.0', 5));
    expect(
      pins(
        'pyproject.toml',
        '[project]\ndependencies = ["uvicorn[standard]==0.54.0"]\n',
        'uvicorn',
      ),
    ).toEqual(pin('0.54.0', 2));
  });

  it('not exact in PEP 621 is none', () => {
    expect(pins('pyproject.toml', '[project]\ndependencies = ["gunicorn>=26"]\n')).toEqual(
      UNPINNED,
    );
  });

  it('Poetry exact forms', () => {
    const toml = (line: string) => `[tool.poetry.dependencies]\npython = "^3.12"\n${line}\n`;
    expect(pins('pyproject.toml', toml('gunicorn = "26.2.0"'))).toEqual(pin('26.2.0', 3));
    expect(pins('pyproject.toml', toml('gunicorn = "==26.2.0"'))).toEqual(pin('26.2.0', 3));
    expect(
      pins('pyproject.toml', toml('gunicorn = {version = "26.2.0", extras = ["gevent"]}')),
    ).toEqual(pin('26.2.0', 3));
  });

  it.each(['"^26.2"', '"~26.2"', '">=26"', '"*"', '"26.*"', '">=26,<27"'])(
    'Poetry %s is not exact',
    (v) => {
      expect(pins('pyproject.toml', `[tool.poetry.dependencies]\ngunicorn = ${v}\n`)).toEqual(
        UNPINNED,
      );
    },
  );

  it('a Poetry sub-table for the package is a form that is not read (m6)', () => {
    for (const body of [
      '[tool.poetry.dependencies.gunicorn]\nversion = "20.1.0"\n',
      '[tool.poetry.dependencies.gunicorn]\nversion = "^20"\nextras = ["gevent"]\n',
      '[tool.poetry.dependencies."gunicorn"]\nversion = "26.2.0"\n',
    ]) {
      expect(
        pins('pyproject.toml', `[tool.poetry.dependencies]\npython = "^3.12"\n${body}`),
      ).toEqual(UNREADABLE);
    }
    expect(pins('pyproject.toml', '[tool.poetry.dependencies.flask]\nversion = "3.0.0"\n')).toEqual(
      NONE,
    );
  });

  it('an environment marker in a PEP 621 pin makes it unreadable', () => {
    expect(
      pins(
        'pyproject.toml',
        `[project]\ndependencies = ["gunicorn==26.2.0; python_version<'3'"]\n`,
      ),
    ).toEqual(MARKER);
  });

  it('a Poetry git or path dependency is not read', () => {
    expect(
      pins('pyproject.toml', '[tool.poetry.dependencies]\ngunicorn = {git = "https://x/y.git"}\n'),
    ).toEqual(UNREADABLE);
  });

  it('a pin in another table (dev group, optional) is not a pin of the project', () => {
    expect(
      pins('pyproject.toml', '[tool.poetry.group.dev.dependencies]\ngunicorn = "26.2.0"\n'),
    ).toEqual(NONE);
    expect(
      pins('pyproject.toml', '[project.optional-dependencies]\nx = ["gunicorn==26.2.0"]\n'),
    ).toEqual(NONE);
  });

  it('an unterminated array or a multi-line string is not read', () => {
    expect(pins('pyproject.toml', '[project]\ndependencies = [\n  "gunicorn==26.2.0",\n')).toEqual(
      UNREADABLE,
    );
    expect(pins('pyproject.toml', '[project]\ndependencies = ["""gunicorn==26.2.0"""]\n')).toEqual(
      UNREADABLE,
    );
  });
});

describe('poetry.lock and uv.lock', () => {
  const lock = (blocks: string[]) => blocks.map((b) => `[[package]]\n${b}\n`).join('\n');
  it('the locked version of the package, with its line', () => {
    expect(
      pins(
        'poetry.lock',
        lock([
          'name = "flask"\nversion = "3.0.0"',
          'name = "gunicorn"\nversion = "26.2.0"\ndescription = "x"',
        ]),
      ),
    ).toEqual(pin('26.2.0', 7));
    expect(
      pins(
        'uv.lock',
        `version = 1\n${lock(['name = "uvicorn"\nversion = "0.54.0"\nsource = { registry = "x" }'])}`,
        'uvicorn',
      ),
    ).toEqual(pin('0.54.0', 4));
  });

  it('a dependency entry of another package is not the package', () => {
    expect(
      pins(
        'uv.lock',
        lock([
          'name = "app"\nversion = "1.0.0"\ndependencies = [\n    { name = "gunicorn" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "gunicorn", specifier = ">=1" }]',
        ]),
      ),
    ).toEqual(NONE);
  });

  it("keys after a sub-table of the block are not the block's", () => {
    expect(
      pins(
        'poetry.lock',
        '[[package]]\nname = "other"\nversion = "1.0"\n[package.dependencies]\n\n[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n[package.extras]\nname = "x"\nversion = "9.9.9"\n',
      ),
    ).toEqual(pin('26.2.0', 8));
  });

  it('two locked versions (a forked resolution) conflict', () => {
    expect(
      pins(
        'uv.lock',
        lock(['name = "gunicorn"\nversion = "26.2.0"', 'name = "gunicorn"\nversion = "27.0.0"']),
      ),
    ).toEqual(CONFLICT);
  });

  it('a version that is not plain is unreadable; a package block with no version too', () => {
    expect(pins('poetry.lock', lock(['name = "gunicorn"\nversion = "26.2.0rc1"']))).toEqual(
      UNREADABLE,
    );
    expect(pins('poetry.lock', lock(['name = "gunicorn"']))).toEqual(UNREADABLE);
  });
});

describe('what is not a pin file, and hostile text', () => {
  it('an unknown file name gives none', () => {
    expect(pins('notes.txt', 'gunicorn==26.2.0\n')).toEqual(NONE);
  });

  it('control characters, a lone CR, NUL and very long lines give a result', () => {
    expect(pins('requirements.txt', '\u0000gunicorn==26.2.0\u0001\r\u001b[31m\n')).toEqual(
      UNREADABLE,
    );
    expect(pins('requirements.txt', `gunicorn==${'9'.repeat(100000)}\n`)).toEqual(UNREADABLE);
    expect(pins('requirements.txt', `gunicorn ${'='.repeat(100000)} 1\n`).state).toBeDefined();
    expect(pins('pyproject.toml', `[project]\ndependencies = [${'"a",'.repeat(50000)}`).state).toBe(
      'unreadable',
    );
  });

  it(
    'work grows linearly with each file kind',
    () => {
      const run = (name: string, make: (n: number) => string) =>
        scalingRatio((n) => {
          pins(name, make(n));
        }, 5000);
      expect(
        run('requirements.txt', (n) => 'flask==1.0.0 ; python_version>"3"\n'.repeat(n)),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(run('requirements.txt', (n) => `gunicorn ${'x '.repeat(n)}\n`)).toBeLessThan(
        LINEAR_RATIO_LIMIT,
      );
      expect(
        run(
          'pyproject.toml',
          (n) =>
            `[project]\ndependencies = [\n${'  "flask[a,b]>=1; os_name == \'x\'",\n'.repeat(n)}]\n`,
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(
        run('pyproject.toml', (n) => `[tool.poetry.dependencies]\n${'pkg = "1.0"\n'.repeat(n)}`),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(
        run('poetry.lock', (n) => '[[package]]\nname = "a"\nversion = "1.0"\n\n'.repeat(n)),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(
        run(
          'uv.lock',
          (n) =>
            `[[package]]\nname = "gunicorn"\nversion = "26.2.0"\n${'dependencies = [{ name = "x" }]\n'.repeat(n)}`,
        ),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});
