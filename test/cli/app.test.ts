import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_ERROR_MESSAGE, runCli } from '../../src/cli/app.js';
import { HELP_TEXT } from '../../src/cli/help.js';
import { nodeIsSupported, unsupportedNodeMessage } from '../../src/cli/node-check.js';
import { check, render } from '../../src/index.js';
import { DEMO_FILES_SHUTDOWN as DEMO_FILES } from '../support/analyse.js';
import { buildReport } from '../support/report-fixtures.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = readFileSync(join(ROOT, 'test', 'golden', 'web-t1.txt'), 'utf8');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function demoTree(): Tree {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(DEMO_FILES)) t.write(path, text);
  return t;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, tty = false, deps = {}) {
  let stdout = '';
  let stderr = '';
  const code = runCli(
    args,
    {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
      stdoutIsTty: tty,
    },
    env,
    deps,
  );
  return { code, stdout, stderr };
}

describe('the Node version check', () => {
  it.each([
    ['22.12.0', true],
    ['22.12.1', true],
    ['22.23.2', true],
    ['23.0.0', true],
    ['24.1.0', true],
    ['v22.12.0', true],
    ['22.11.9', false],
    ['22.0.0', false],
    ['21.99.99', false],
    ['20.11.0', false],
    ['18.0.0', false],
    ['', false],
    ['not a version', false],
  ])('%j is supported: %j', (version, expected) => {
    expect(nodeIsSupported(version)).toBe(expected);
  });

  it('prints one fixed message with the running version, then "Nothing was checked."', () => {
    expect(unsupportedNodeMessage('20.11.0')).toBe(
      'tripcurve needs Node 22.12.0 or later; this is Node 20.11.0.\nNothing was checked.\n',
    );
  });

  it('never echoes a version string that is not digits and dots', () => {
    expect(unsupportedNodeMessage('20.1.0\u001b[2J')).toContain('this is Node unknown.');
  });
});

describe('runCli: what it does before reading anything', () => {
  it('--help prints the help text and exits 0', () => {
    expect(run(['--help'])).toEqual({ code: 0, stdout: HELP_TEXT, stderr: '' });
  });

  it('--version prints the version and exits 0', () => {
    expect(run(['--version'])).toEqual({ code: 0, stdout: '0.1.0\n', stderr: '' });
  });

  it('the help text is the expected report layout', () => {
    for (const line of HELP_TEXT.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(HELP_TEXT).toContain('Usage: tripcurve [options] [path]');
    expect(HELP_TEXT).toContain(
      '  --no-color         never use colour (NO_COLOR is also honoured)',
    );
    // --explain is available now (bolt B6): its line carries no "not available yet" note
    expect(HELP_TEXT).toContain('  --explain <rule>   explain T1, T2, T3 or T4, then exit\n');
    expect(HELP_TEXT).not.toContain('(not available yet)');
    // the json and sarif formats are available now (bolt B7): the line is
    expect(HELP_TEXT).toContain('  --format <format>  human, json or sarif (default: human)\n');
    expect(HELP_TEXT).not.toContain('available yet');
    expect(HELP_TEXT).toContain(
      'Exit codes: 0 clean or "No failures:", 1 not clean, 2 nothing checked or',
    );
  });

  it('a usage error exits 2 on stderr with nothing on stdout', () => {
    const r = run(['--nope']);
    expect(r).toEqual({ code: 2, stdout: '', stderr: 'tripcurve: unknown option. See --help.\n' });
  });

  it('an option without its value is a usage error', () => {
    expect(run(['--config']).code).toBe(2);
    expect(run(['--config']).stderr).toBe(
      'tripcurve: an option is missing its value. See --help.\n',
    );
  });

  it('two paths are a usage error', () => {
    expect(run(['a', 'b']).stderr).toBe('tripcurve: only one path can be given. See --help.\n');
  });

  it('--format json and --format sarif print their document and exit with the report exit code', () => {
    const t = demoTree();
    const json = run([t.root, '--format', 'json']);
    expect(json.code).toBe(1);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).summary).toMatchObject({ failed: 1, clean: false, exitCode: 1 });
    const sarif = run([t.root, '--format', 'sarif']);
    expect(sarif.code).toBe(1);
    expect(sarif.stderr).toBe('');
    expect(JSON.parse(sarif.stdout).version).toBe('2.1.0');
  });

  it('on a configuration error the chosen format still prints its document, with exit 2 and clean false', () => {
    const t = demoTree();
    t.write('tripcurve.yaml', 'version: 1\nbogus: true\n');
    const json = run([t.root, '--format', 'json']);
    expect(json.code).toBe(2);
    expect(json.stderr).toBe('');
    const doc = JSON.parse(json.stdout);
    expect(doc.summary).toMatchObject({
      outcome: 'ConfigError',
      clean: false,
      exitCode: 2,
      failed: 0,
    });
    expect(doc.workloads).toEqual([]);
    expect(doc.configErrors).toHaveLength(1);
    const sarif = run([t.root, '--format', 'sarif']);
    expect(sarif.code).toBe(2);
    const log = JSON.parse(sarif.stdout);
    expect(log.runs[0].properties.tripcurve).toMatchObject({
      outcome: 'ConfigError',
      clean: false,
      exitCode: 2,
    });
    expect(log.runs[0].results).toHaveLength(1);
  });

  it('--explain with json or sarif is a usage error; with human it is allowed', () => {
    for (const format of ['json', 'sarif']) {
      const r = run(['--explain', 'T1', '--format', format]);
      expect(r).toEqual({
        code: 2,
        stdout: '',
        stderr: 'tripcurve: --explain prints text only. See --help.\n',
      });
    }
    expect(run(['--explain', 'T1', '--format', 'human']).code).toBe(0);
    expect(run(['--explain', 'T1']).code).toBe(0);
  });

  it('an unknown format is a usage error', () => {
    expect(run(['--format', 'bogus']).stderr).toBe(
      'tripcurve: unknown format. Formats are human, json and sarif. See --help.\n',
    );
    expect(run(['--format', 'bogus']).code).toBe(2);
  });

  it('a usage error never echoes the bad argument', () => {
    const r = run(['--format', 'SECRET\u001b[2J']);
    expect(r.stderr).not.toContain('SECRET');
    expect(r.stderr).not.toContain('\u001b');
  });

  it('a missing root exits 2 before reading anything, naming the path quoted', () => {
    const r = run(['/no/such/dir']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      'tripcurve: "/no/such/dir" does not exist or cannot be read.\nNothing was checked.\n',
    );
  });

  it('--format human is accepted', () => {
    const t = demoTree();
    expect(run([t.root, '--format', 'human']).code).toBe(1);
  });
});

describe('runCli: a run', () => {
  it('prints the report on stdout and exits with the summary exit code', () => {
    const t = demoTree();
    const r = run([t.root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Workload "web" (Deployment) in "k8s/web.yaml"');
    expect(r.stdout).toContain('Summary: 1 failed, 1 unresolved, 1 passed; not a clean result');
    // the header names the path as typed
    expect(r.stdout.split('\n')[0]).toMatch(/^tripcurve 0\.1\.0 {3}checked "/);
  });

  it('--verbose is accepted, keeps every line of a FAIL (its chain is always shown) and adds the chain under a PASS', () => {
    const t = demoTree();
    const a = run([t.root]);
    const b = run([t.root, '--verbose']);
    expect(b.code).toBe(a.code);
    const verbose = b.stdout.split('\n');
    for (const line of a.stdout.split('\n').slice(1)) expect(verbose).toContain(line);
    expect(b.stdout).toContain(
      '  PASS T2  preStop sleep 10 s ("k8s/web.yaml":25)\n           preStop 10 s     "k8s/web.yaml":25',
    );
  });

  it('colour only on a terminal, without NO_COLOR and without --no-color', () => {
    const t = demoTree();
    const esc = '\u001b[31mFAIL\u001b[0m';
    expect(run([t.root], {}, true).stdout).toContain(esc);
    expect(run([t.root], {}, false).stdout).not.toContain('\u001b');
    expect(run([t.root], { NO_COLOR: '1' }, true).stdout).not.toContain('\u001b');
    expect(run([t.root], { NO_COLOR: '' }, true).stdout).toContain(esc);
    expect(run([t.root, '--no-color'], {}, true).stdout).not.toContain('\u001b');
  });

  it('colour removed equals the plain text byte for byte (spec rule 4)', () => {
    const t = demoTree();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
    const stripped = run([t.root], {}, true).stdout.replace(/\u001b\[[0-9;]*m/g, '');
    expect(stripped).toBe(run([t.root], {}, false).stdout);
  });

  it('an explicit --config names a file, and an invalid one is the config-error case (exit 2)', () => {
    const t = demoTree();
    t.write('other.yaml', 'version: 1\nworkloads:\n  - name: web\n    longest_request_s: fast\n');
    const r = run([t.root, '--config', join(t.root, 'other.yaml')]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Config error in "other.yaml"');
    expect(r.stdout.endsWith('Nothing was checked.\n')).toBe(true);
  });

  it('matches the golden text when run on the fixture directory', () => {
    const t = demoTree();
    const r = run([t.root]);
    expect(r.stdout.replace(/checked ".*?"/, 'checked "."')).toBe(GOLDEN);
  });
});

describe('runCli: an internal error (exit 3)', () => {
  it('prints the fixed message and nothing else: no stack, no input', () => {
    const t = demoTree();
    const r = run([t.root], {}, false, {
      check: () => {
        throw new Error('boom /etc/passwd secret');
      },
    });
    expect(r).toEqual({ code: 3, stdout: '', stderr: INTERNAL_ERROR_MESSAGE });
    expect(INTERNAL_ERROR_MESSAGE).toContain('Nothing was verified.');
    for (const line of INTERNAL_ERROR_MESSAGE.split('\n'))
      expect(line.length).toBeLessThanOrEqual(80);
  });

  it('a throw that is not an Error is the same', () => {
    const t = demoTree();
    const r = run([t.root], {}, false, {
      check: () => {
        throw 'a string';
      },
    });
    expect(r.code).toBe(3);
  });

  it('a failure while rendering writes nothing to stdout', () => {
    const t = demoTree();
    const r = run([t.root], {}, false, {
      check: () => ({ ...buildReport(), blocks: null }) as never,
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
  });
});

describe('the library export', () => {
  it('check(path) returns the Report: model, summary and exit code', () => {
    const t = demoTree();
    const report = check(t.root);
    expect(report.summary.outcome).toBe('NotClean');
    expect(report.summary.exitCode).toBe(1);
    expect(report.summary.clean).toBe(false);
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]?.findings[0]?.kind).toBe('FAIL');
  });

  it('check accepts an options object too, and render prints the same text as the command', () => {
    const t = demoTree();
    const a = check({ path: t.root });
    expect(render(a, 'human')).toBe(run([t.root]).stdout);
  });

  it('a configuration error or an empty folder is a Report with exit 2, not an exception', () => {
    const empty = makeTree();
    trees.push(empty);
    expect(check(empty.root).summary.exitCode).toBe(2);
    expect(check(empty.root).summary.outcome).toBe('NothingChecked');
    const bad = demoTree();
    bad.write('tripcurve.yaml', 'version: 1\nbogus: true\n');
    expect(check(bad.root).summary.outcome).toBe('ConfigError');
  });

  it('a missing path is a Report that says nothing was checked, not an exception', () => {
    const report = check('/no/such/dir-for-tripcurve');
    expect(report.summary.exitCode).toBe(2);
    expect(report.unchecked).toHaveLength(1);
  });

  it('render writes the three formats, and refuses a format that does not exist', () => {
    const report = buildReport();
    expect(render(report, 'human')).toContain('tripcurve 0.1.0');
    expect(JSON.parse(render(report, 'json')).schemaVersion).toBe(1);
    expect(JSON.parse(render(report, 'sarif')).version).toBe('2.1.0');
    expect(() => render(report, 'xml' as never)).toThrow(TypeError);
  });

  it('VERSION equals the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(check(demoTree().root).header.version).toBe(pkg.version);
  });
});
