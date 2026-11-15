// action/run.sh, run with bash and no GitHub. Real CLI against fixtures, and stub
// CLIs for the crash cases. Every case asserts the script's exit status AND its outputs.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  argvLog,
  CLEAN,
  copyFixture,
  FAILING,
  NOTHING,
  outputs,
  pathWithFailingMv,
  pathWithNpm,
  pathWithoutNode,
  REAL_CLI,
  runScript,
  runScriptOpenStdin,
  type Sandbox,
  sandbox,
  stubCli,
  VALID_SARIF,
} from './support.js';

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

const real = (path: string, extra: Record<string, string | undefined> = {}) =>
  runScript(sb, 'check', { TRIPCURVE_CLI: REAL_CLI, TRIPCURVE_PATH: path, ...extra });
const stub = (body: string, extra: Record<string, string | undefined> = {}) =>
  runScript(sb, 'check', { TRIPCURVE_CLI: stubCli(sb, body), TRIPCURVE_PATH: '.', ...extra });
const sarifDoc = () => JSON.parse(readFileSync(join(sb.workspace, 'tripcurve.sarif'), 'utf8'));

describe('real CLI on fixture repos', () => {
  it('a clean repo: exit 0, exit-code 0, a valid SARIF file and its path as outputs', () => {
    const r = real(CLEAN);
    expect(r.status).toBe(0);
    expect(outputs(sb)).toEqual({ 'sarif-file': 'tripcurve.sarif', 'exit-code': '0' });
    expect(sarifDoc().version).toBe('2.1.0');
    expect(r.stdout).toContain('All checks passed');
  });

  it('a failing repo: exit 1, exit-code 1, and the SARIF file is still written', () => {
    const r = real(FAILING);
    expect(r.status).toBe(1);
    expect(outputs(sb)).toEqual({ 'sarif-file': 'tripcurve.sarif', 'exit-code': '1' });
    expect(sarifDoc().runs[0].results.length).toBeGreaterThan(0);
    expect(r.stderr).toContain('failures were found');
  });

  it('a nothing-checked repo: exit 2, exit-code 2, and it is not called a pass', () => {
    const r = real(NOTHING);
    expect(r.status).toBe(2);
    expect(outputs(sb)['exit-code']).toBe('2');
    expect(r.stdout).not.toContain('All checks passed');
    expect(r.stderr).toContain('nothing was checked');
  });

  it('format json and format sarif go to the log; the SARIF file is the same either way', () => {
    const j = real(FAILING, { TRIPCURVE_FORMAT: 'json' });
    expect(JSON.parse(j.stdout).summary.clean).toBe(false);
    const first = readFileSync(join(sb.workspace, 'tripcurve.sarif'), 'utf8');
    const s = real(FAILING, { TRIPCURVE_FORMAT: 'sarif' });
    expect(JSON.parse(s.stdout).version).toBe('2.1.0');
    expect(readFileSync(join(sb.workspace, 'tripcurve.sarif'), 'utf8')).toBe(first);
  });

  it('writes the SARIF file into a new sub-folder of the workspace', () => {
    const r = real(CLEAN, { TRIPCURVE_SARIF_FILE: 'out/deep/t.sarif' });
    expect(r.status).toBe(0);
    expect(outputs(sb)['sarif-file']).toBe('out/deep/t.sarif');
    expect(JSON.parse(readFileSync(join(sb.workspace, 'out/deep/t.sarif'), 'utf8')).version).toBe(
      '2.1.0',
    );
  });

  it('leaves no temporary file behind', () => {
    real(FAILING);
    expect(readdirSync(sb.workspace)).toEqual(['tripcurve.sarif']);
  });
});

describe('no false success: a stub CLI that misbehaves', () => {
  const ok = `process.stdout.write(${JSON.stringify(VALID_SARIF)}); process.exit(0);`;

  it('control: a well-behaved stub passes', () => {
    const r = stub(ok);
    expect(r.status).toBe(0);
    expect(outputs(sb)['exit-code']).toBe('0');
  });

  it('exit 3 (crash): the job fails with 3 and the log says internal error, not failures found', () => {
    const r = stub('process.exit(3);');
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(r.stderr).toContain('internal error');
    expect(r.stderr).toContain('Nothing was verified');
    expect(r.stderr).not.toContain('failures were found');
    expect(outputs(sb)['sarif-file']).toBeUndefined();
  });

  it('exit 1 and exit 2 each fail the job with their own code', () => {
    for (const code of [1, 2]) {
      const sb2 = sandbox();
      const r = runScript(sb2, 'check', {
        TRIPCURVE_CLI: stubCli(
          sb2,
          `process.stdout.write(${JSON.stringify(VALID_SARIF)}); process.exit(${code});`,
        ),
        TRIPCURVE_PATH: '.',
      });
      expect(r.status).toBe(code);
      expect(outputs(sb2)['exit-code']).toBe(String(code));
      sb2.cleanup();
    }
  });

  it('killed by SIGKILL: fails with 137, says it was a signal, and sets exit-code', () => {
    const r = stub("process.kill(process.pid, 'SIGKILL');");
    expect(r.status).toBe(137);
    expect(outputs(sb)['exit-code']).toBe('137');
    expect(r.stderr).toContain('stopped by signal 9');
  });

  it('the SARIF run killed after a clean report run: still a failure', () => {
    const r = stub(`if (sarif) process.kill(process.pid, 'SIGKILL'); process.exit(0);`);
    expect(r.status).toBe(137);
    expect(outputs(sb)['exit-code']).toBe('137');
    expect(outputs(sb)['sarif-file']).toBeUndefined();
  });

  it('exit 0 with an EMPTY SARIF file: fails with 3, no sarif-file output, no file written', () => {
    const r = stub('process.exit(0);');
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(outputs(sb)['sarif-file']).toBeUndefined();
    expect(existsSync(join(sb.workspace, 'tripcurve.sarif'))).toBe(false);
    expect(r.stderr).toContain('empty or is not a SARIF 2.1.0 document');
  });

  it('exit 0 with SARIF that has no runs (runs: []): fails with 3', () => {
    const r = stub(
      `if (sarif) process.stdout.write('{"version":"2.1.0","runs":[]}'); process.exit(0);`,
    );
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(outputs(sb)['sarif-file']).toBeUndefined();
    expect(existsSync(join(sb.workspace, 'tripcurve.sarif'))).toBe(false);
  });

  it('a failed move into place: fails with 3 and sarif-file stays unset', () => {
    const r = runScript(
      sb,
      'check',
      { TRIPCURVE_CLI: stubCli(sb, ok), TRIPCURVE_PATH: '.' },
      pathWithFailingMv(sb),
    );
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(outputs(sb)['sarif-file']).toBeUndefined();
    expect(existsSync(join(sb.workspace, 'tripcurve.sarif'))).toBe(false);
  });

  it('removes its temporary file after a failure', () => {
    stub('process.exit(3);');
    expect(readdirSync(sb.workspace)).toEqual([]);
  });

  it('a path of - never waits on stdin, even when stdin stays open', async () => {
    const r = await runScriptOpenStdin(
      sb,
      {
        TRIPCURVE_CLI: stubCli(sb, `require('node:fs').readFileSync(0); ${ok}`),
        TRIPCURVE_PATH: '-',
      },
      20_000,
    );
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(0);
  }, 60_000);

  it('exit 0 with invalid JSON in the SARIF file: fails with 3', () => {
    const r = stub(`if (sarif) process.stdout.write('{"version": '); process.exit(0);`);
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(existsSync(join(sb.workspace, 'tripcurve.sarif'))).toBe(false);
  });

  it('exit 0 with JSON of the wrong version or shape: fails with 3', () => {
    for (const doc of [
      '{"version":"2.0.0","runs":[]}',
      '{"version":"2.1.0"}',
      '[]',
      'null',
      '"2.1.0"',
    ]) {
      const sb2 = sandbox();
      const r = runScript(sb2, 'check', {
        TRIPCURVE_CLI: stubCli(
          sb2,
          `if (sarif) process.stdout.write(${JSON.stringify(doc)}); process.exit(0);`,
        ),
        TRIPCURVE_PATH: '.',
      });
      expect(r.status, doc).toBe(3);
      expect(outputs(sb2)['exit-code']).toBe('3');
      sb2.cleanup();
    }
  });

  it('both runs fail: the job fails, and the first non-zero code is the output', () => {
    const r = stub(`process.exit(sarif ? 3 : 2);`);
    expect(r.status).toBe(2);
    expect(outputs(sb)['exit-code']).toBe('2');
    expect(r.stderr).toContain('SARIF run');
  });

  it('a report-run failure still writes the SARIF file and the outputs before failing', () => {
    const r = stub(
      `process.stdout.write(${JSON.stringify(VALID_SARIF)}); process.exit(sarif ? 0 : 1);`,
    );
    expect(r.status).toBe(1);
    expect(outputs(sb)).toEqual({ 'sarif-file': 'tripcurve.sarif', 'exit-code': '1' });
    expect(sarifDoc().version).toBe('2.1.0');
  });

  it('a missing CLI file: fails with 127 and says nothing was checked', () => {
    const r = runScript(sb, 'check', {
      TRIPCURVE_CLI: join(sb.dir, 'nope.js'),
      TRIPCURVE_PATH: '.',
    });
    expect(r.status).toBe(127);
    expect(outputs(sb)['exit-code']).toBe('127');
    expect(r.stderr).toContain('Nothing was checked');
  });

  it('node missing: fails with 127', () => {
    const r = runScript(
      sb,
      'check',
      { TRIPCURVE_CLI: stubCli(sb, 'process.exit(0);'), TRIPCURVE_PATH: '.' },
      pathWithoutNode(sb),
    );
    expect(r.status).toBe(127);
    expect(outputs(sb)['exit-code']).toBe('127');
    expect(r.stderr).toContain('node was not found');
  });
});

describe('build mode', () => {
  it('npm ci then npm run build, nothing else, and exit 0 sets no exit-code', () => {
    const r = runScript(sb, 'build', {}, pathWithNpm(sb, { ci: 0, build: 0 }));
    expect(r.status).toBe(0);
    expect(readFileSync(sb.log, 'utf8').trim().split('\n')).toEqual([
      'ci --ignore-scripts',
      'run build',
    ]);
    expect(outputs(sb)).toEqual({});
  });

  it('an unusable Action checkout: fails with 3 and still sets exit-code 3', () => {
    const r = runScript(sb, 'build', { GITHUB_ACTION_PATH: join(sb.dir, 'no-such-dir') });
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
  });

  it('npm ci failing: fails with 3, sets exit-code 3, and never builds', () => {
    const r = runScript(sb, 'build', {}, pathWithNpm(sb, { ci: 1, build: 0 }));
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(readFileSync(sb.log, 'utf8').trim()).toBe('ci --ignore-scripts');
  });

  it('the build failing: fails with 3 and sets exit-code 3', () => {
    const r = runScript(sb, 'build', {}, pathWithNpm(sb, { ci: 0, build: 1 }));
    expect(r.status).toBe(3);
    expect(outputs(sb)['exit-code']).toBe('3');
    expect(r.stderr).toContain('build failed');
  });
});

describe('hostile inputs', () => {
  const ok = `process.stdout.write(${JSON.stringify(VALID_SARIF)}); process.exit(0);`;

  it('a path of --format=json is one argv entry after --, never a flag', () => {
    const r = stub(ok, { TRIPCURVE_PATH: '--format=json' });
    expect(r.status).toBe(0);
    expect(argvLog(sb)).toEqual([
      ['--format', 'human', '--', '--format=json'],
      ['--format', 'sarif', '--', '--format=json'],
    ]);
  });

  it('the real CLI also takes a path of --format=json as a path (exit 2, named as a path)', () => {
    const r = real('--format=json');
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain('"--format=json" does not exist');
  });

  it('a config starting with - is the value of --config, kept as one argv entry', () => {
    stub(ok, { TRIPCURVE_CONFIG: '--format=json' });
    expect(argvLog(sb)[0]).toEqual(['--format', 'human', '--config', '--format=json', '--', '.']);
  });

  it('an empty config adds no --config', () => {
    stub(ok, { TRIPCURVE_CONFIG: '' });
    expect(argvLog(sb)[0]).toEqual(['--format', 'human', '--', '.']);
  });

  it('spaces, $(...) and backticks in the path are data: nothing runs and no pwned file appears', () => {
    const name = 'a b $(touch pwned) `touch pwned2` ; touch pwned3';
    copyFixture(CLEAN, join(sb.workspace, name));
    const r = real(name);
    expect(r.status).toBe(0);
    expect(readdirSync(sb.workspace).sort()).toEqual([name, 'tripcurve.sarif'].sort());
    for (const f of ['pwned', 'pwned2', 'pwned3']) {
      expect(existsSync(join(sb.workspace, f))).toBe(false);
      expect(existsSync(join(process.cwd(), f))).toBe(false);
    }
  });

  it('the same hostile text as a config and as a sarif-file never runs either', () => {
    stub(ok, { TRIPCURVE_CONFIG: '$(touch pwned) `touch pwned`' });
    const r = stub(ok, { TRIPCURVE_SARIF_FILE: '$(touch pwned).sarif' });
    expect(r.status).toBe(0);
    expect(existsSync(join(sb.workspace, 'pwned'))).toBe(false);
    expect(existsSync(join(sb.workspace, '$(touch pwned).sarif'))).toBe(true);
  });

  it('a format of "sarif; rm -rf /" is a usage failure (2), quoted as data, and nothing runs', () => {
    const r = stub(ok, { TRIPCURVE_FORMAT: 'sarif; rm -rf /' });
    expect(r.status).toBe(2);
    expect(outputs(sb)).toEqual({ 'exit-code': '2' });
    expect(r.stderr).toBe(
      'tripcurve action: format must be one of human, json, sarif; got "sarif; rm -rf /"\n',
    );
    expect(argvLog(sb)).toEqual([]);
  });

  it('every format outside the closed set is refused, including near misses', () => {
    for (const f of ['SARIF', 'Human', ' human', 'text', 'sarif ', 'json\n', '-']) {
      const sb2 = sandbox();
      const r = runScript(sb2, 'check', {
        TRIPCURVE_CLI: stubCli(sb2, ok),
        TRIPCURVE_PATH: '.',
        TRIPCURVE_FORMAT: f,
      });
      expect(r.status, JSON.stringify(f)).toBe(2);
      expect(outputs(sb2)).toEqual({ 'exit-code': '2' });
      sb2.cleanup();
    }
  });

  it('a format with a newline and a workflow command cannot forge a log line or an output', () => {
    const r = stub(ok, { TRIPCURVE_FORMAT: 'x\n::error::pwned\nexit-code=0' });
    expect(r.status).toBe(2);
    expect(r.stderr.split('\n').filter((l) => l.startsWith('::'))).toEqual([]);
    expect(r.stderr.trimEnd().split('\n').length).toBe(1);
    expect(outputs(sb)).toEqual({ 'exit-code': '2' });
  });

  it('a very long or non-ASCII format is cut to 80 characters of printable ASCII', () => {
    const r = stub(ok, { TRIPCURVE_FORMAT: `${'é'.repeat(200)}${'a'.repeat(200)}` });
    expect(r.status).toBe(2);
    const quoted = /got "(.*)"\n$/.exec(r.stderr)?.[1] ?? '';
    expect(quoted.length).toBeLessThanOrEqual(80);
    expect(quoted).toMatch(/^[ -~]*$/);
  });

  const refused = [
    '../x',
    '../../etc/x',
    'a/../../x',
    'a/../x',
    '/tmp/x.sarif',
    '/',
    '..',
    'a/',
    'bad\nname',
    'name\n',
  ];
  for (const file of refused) {
    it(`a sarif-file of ${JSON.stringify(file)} is refused with 2 and nothing is written or run`, () => {
      const r = stub(ok, { TRIPCURVE_SARIF_FILE: file });
      expect(r.status).toBe(2);
      expect(outputs(sb)).toEqual({ 'exit-code': '2' });
      expect(r.stderr).toContain('sarif-file must be a relative path inside the workspace');
      expect(argvLog(sb)).toEqual([]);
      expect(existsSync(join(sb.dir, 'x'))).toBe(false);
    });
  }

  it('a sub-folder that is a symlink out of the workspace is refused', () => {
    const outside = join(sb.dir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(sb.workspace, 'link'));
    const r = stub(ok, { TRIPCURVE_SARIF_FILE: 'link/x.sarif' });
    expect(r.status).toBe(2);
    expect(existsSync(join(outside, 'x.sarif'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a multi-level path through a symlink out of the workspace creates nothing outside it', () => {
    const outside = join(sb.dir, 'outside');
    mkdirSync(outside);
    symlinkSync('../outside', join(sb.workspace, 'out'));
    const r = stub(ok, { TRIPCURVE_SARIF_FILE: 'out/new/deep/f.sarif' });
    expect(r.status).toBe(2);
    expect(outputs(sb)).toEqual({ 'exit-code': '2' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a symlink to a folder inside the workspace is followed, and the file lands in the real folder', () => {
    mkdirSync(join(sb.workspace, 'real'));
    symlinkSync('real', join(sb.workspace, 'alias'));
    const r = stub(ok, { TRIPCURVE_SARIF_FILE: 'alias/sub/f.sarif' });
    expect(r.status).toBe(0);
    expect(existsSync(join(sb.workspace, 'real/sub/f.sarif'))).toBe(true);
  });

  it('a sarif-file that is itself a symlink is refused, and its target is untouched', () => {
    const victim = join(sb.dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(sb.workspace, 'tripcurve.sarif'));
    const r = stub(ok);
    expect(r.status).toBe(2);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('a sarif-file that names an existing directory is refused', () => {
    mkdirSync(join(sb.workspace, 'd'));
    const r = stub(ok, { TRIPCURVE_SARIF_FILE: 'd' });
    expect(r.status).toBe(2);
  });
});

describe('defaults', () => {
  it('an empty sarif-file or path falls back to the defaults', () => {
    const r = runScript(sb, 'check', {
      TRIPCURVE_CLI: stubCli(sb, `process.stdout.write(${JSON.stringify(VALID_SARIF)});`),
      TRIPCURVE_PATH: '',
      TRIPCURVE_SARIF_FILE: '',
      TRIPCURVE_FORMAT: '',
    });
    expect(r.status).toBe(0);
    expect(argvLog(sb)[0]).toEqual(['--format', 'human', '--', '.']);
    expect(outputs(sb)['sarif-file']).toBe('tripcurve.sarif');
  });
});

describe('secrets', () => {
  it('prints no environment value other than the inputs, and asks for no token', () => {
    const r = stub('process.exit(1);', { GITHUB_TOKEN: 'ghs_secretvalue', MY_SECRET: 'hunter2' });
    expect(r.stdout + r.stderr + readFileSync(sb.output, 'utf8')).not.toMatch(
      /ghs_secretvalue|hunter2/,
    );
    expect(
      readFileSync(join(import.meta.dirname, '..', '..', 'action', 'run.sh'), 'utf8'),
    ).not.toMatch(/GITHUB_TOKEN|secrets\./);
  });
});
