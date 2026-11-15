import { afterAll, describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { validateSarif } from '../support/sarif-validate.js';

// Review of B7, m3: a configuration file that cannot be read is a fact that every format shows. The human
// report used to print only the configuration error and hide the unchecked file that the JSON and SARIF
// documents listed, and its key read `"(file)"`.: an invalid file prints the config-error case, checks nothing, exits 2.

const broken = fixtureTree('link/web-demo', {
  'tripcurve.yaml': 'version: 1\nworkloads: [unclosed\n',
});
const notMap = fixtureTree('link/web-demo', { 'tripcurve.yaml': '- a\n- b\n' });
const empty = fixtureTree('link/web-demo', { 'tripcurve.yaml': '' });
afterAll(() => {
  broken.cleanup();
  notMap.cleanup();
  empty.cleanup();
});

const formats = (cwd: string) => ({
  human: runBuilt(['.', '--format', 'human'], { cwd }),
  json: runBuilt(['.', '--format', 'json'], { cwd }),
  sarif: runBuilt(['.', '--format', 'sarif'], { cwd }),
});

describe('a configuration file that is not valid YAML', () => {
  const out = formats(broken.root);

  it('exits 2 in every format and prints the plain problem, never the key "(file)"', () => {
    expect(out.human.status).toBe(2);
    expect(out.json.status).toBe(2);
    expect(out.sarif.status).toBe(2);
    expect(out.human.stdout).toContain(
      'Config error in "tripcurve.yaml" at line 3: the config file could not be read.\n',
    );
    expect(out.human.stdout).not.toContain('key "(file)"');
    expect(out.human.stdout).not.toContain('not in a form');
  });

  it('the human report lists the unchecked file as the other two formats do', () => {
    expect(out.human.stdout).toBe(
      'Config error in "tripcurve.yaml" at line 3: the config file could not be read.\n\nFiles not checked\n  UNRESOLVED (file)  could not parse "tripcurve.yaml": YAML syntax error at line\n                     3\n\nNothing was checked.\n',
    );
    const json = JSON.parse(out.json.stdout);
    expect(json.unchecked).toEqual([
      {
        type: 'file',
        file: 'tripcurve.yaml',
        reason: 'YAML syntax error',
        reasonCode: 'parse-error',
        line: 3,
      },
    ]);
    expect(json.configErrors[0]).toMatchObject({
      file: 'tripcurve.yaml',
      line: 3,
      reason: 'the config file could not be read',
      reasonCode: 'invalid-schema',
      wholeFile: 'unreadable',
    });
    const sarif = JSON.parse(out.sarif.stdout);
    expect(validateSarif(sarif)).toEqual([]);
    const texts = sarif.runs[0].results.map((r: { message: { text: string } }) => r.message.text);
    expect(texts).toEqual([
      'file not checked: "tripcurve.yaml": YAML syntax error at line 3',
      'configuration error: the config file could not be read',
    ]);
  });
});

describe('a configuration file that is not a mapping', () => {
  it('says so in plain words in all three formats', () => {
    const out = formats(notMap.root);
    expect(out.human.stdout).toContain(
      'Config error in "tripcurve.yaml" at line 1: the config file is not a mapping of\nkeys.\n',
    );
    expect(out.human.stdout).not.toContain('key "(file)"');
    expect(out.human.stdout).not.toContain('Files not checked');
    expect(JSON.parse(out.json.stdout).configErrors[0]).toMatchObject({
      reason: 'the config file is not a mapping of keys',
      reasonCode: 'invalid-schema',
      wholeFile: 'not-a-mapping',
    });
    expect(JSON.parse(out.sarif.stdout).runs[0].results[0].message.text).toBe(
      'configuration error: the config file is not a mapping of keys',
    );
  });
});

describe('an empty configuration file', () => {
  it('is not a mapping of keys; it is not an unreadable file, and nothing is listed as not checked', () => {
    const out = formats(empty.root);
    expect(out.human.status).toBe(2);
    expect(out.human.stdout).toContain('the config file is not a mapping of\nkeys.');
    expect(JSON.parse(out.json.stdout).configErrors[0].wholeFile).toBe('not-a-mapping');
  });
});

describe('the summary when a configuration error stops the run', () => {
  // When a configuration error stops the run, the document has empty `workloads`, `configErrors` filled, every
  // count 0, `outcome: ConfigError`, `clean: false` and `exitCode: 2`; the pipeline supplies outcome `ConfigError`,
  // zero counts and `exitCode: 2`. No rule ran, so nothing is counted; an unchecked file is
  // still listed (m3), under `unchecked`, and is not counted under `unresolved`.
  const demo = fixtureTree('link/web-demo');
  afterAll(() => demo.cleanup());

  it('a config file that does not exist lists the unchecked file, counts nothing and exits 2', () => {
    const out = runBuilt(['.', '--config', '/nonexistent.yaml', '--format', 'json'], {
      cwd: demo.root,
    });
    const json = JSON.parse(out.stdout);
    expect(out.status).toBe(2);
    expect(json.unchecked).toHaveLength(1);
    expect(json.configErrors).toHaveLength(1);
    expect(json.summary).toEqual({
      failed: 0,
      warning: 0,
      unresolved: 0,
      versionDependent: 0,
      notEvaluated: 0,
      waived: 0,
      notApplicable: 0,
      passed: 0,
      outcome: 'ConfigError',
      clean: false,
      waivedDates: [],
      exitCode: 2,
    });
  });
});

describe('a --config file that was never opened names no line (B22)', () => {
  // "at line 1" for a file that was never opened is meaningless in words; JSON and SARIF keep the contract's
  // required line (1), because a consumer reads a number there.
  const demo = fixtureTree('link/web-demo');
  const dir = fixtureTree('link/web-demo', { 'cfgdir/readme.txt': 'x\n' });
  afterAll(() => {
    demo.cleanup();
    dir.cleanup();
  });
  for (const [what, args, cwd] of [
    ['a missing file', ['.', '--config', 'nope.yaml'], demo.root],
    ['a directory', ['.', '--config', 'cfgdir'], dir.root],
  ] as const) {
    it(`${what}: the human report says the file could not be read, with no line`, () => {
      const out = runBuilt([...args], { cwd });
      expect(out.status).toBe(2);
      expect(out.stdout).toMatch(
        /^Config error in "[a-z.]+": the config file could not be read\./m,
      );
      expect(out.stdout).not.toMatch(/Config error in [^\n]*at line/);
    });
    it(`${what}: JSON keeps the contract's line and SARIF still validates`, () => {
      const json = JSON.parse(runBuilt([...args, '--format', 'json'], { cwd }).stdout);
      expect(json.configErrors[0]).toMatchObject({ line: 1, wholeFile: 'unreadable' });
      const sarif = JSON.parse(runBuilt([...args, '--format', 'sarif'], { cwd }).stdout);
      expect(validateSarif(sarif)).toEqual([]);
    });
  }
  it('a config file over the size limit names no line either', () => {
    const big = fixtureTree('link/web-demo', {
      'tripcurve.yaml': `version: 1\n#${'x'.repeat(5_100_000)}\n`,
    });
    try {
      const out = runBuilt(['.'], { cwd: big.root });
      expect(out.stdout).toContain(
        'Config error in "tripcurve.yaml": the config file could not be read.',
      );
    } finally {
      big.cleanup();
    }
  });
  it('a config file with a syntax error still names its line', () => {
    const out = runBuilt(['.'], { cwd: broken.root });
    expect(out.stdout).toContain('Config error in "tripcurve.yaml" at line 3:');
  });
});

describe('the human summary and the JSON carry the same counts when nothing was checked (B22)', () => {
  it('a tree whose only file cannot be parsed', () => {
    const only = fixtureTree('hostile/bad-yaml', {});
    try {
      const human = runBuilt(['.'], { cwd: only.root });
      const json = JSON.parse(runBuilt(['.', '--format', 'json'], { cwd: only.root }).stdout);
      expect(json.summary.outcome).toBe('NothingChecked');
      expect(json.summary.unresolved).toBe(1);
      expect(human.stdout).toContain(
        'Summary: nothing checked, 1 unresolved (1 file not checked); not a clean result',
      );
    } finally {
      only.cleanup();
    }
  });
});
