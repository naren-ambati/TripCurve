import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunResult, runBuilt } from '../support/e2e.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { REPORT_SCENARIOS } from '../support/report-scenarios.js';
import { validateSarif } from '../support/sarif-validate.js';

// Bolt B7: `--format json` and `--format sarif` through the built command, against goldens
// written by hand and the design mockup before the renderers existed (the readings
// are in test/golden/README.md). The date is injected the way the waiver goldens do it.

const ROOT = join(import.meta.dirname, '..', '..');
const WITH_TODAY = join(ROOT, 'test', 'support', 'with-today.mjs');
const golden = (name: string, ext: 'json' | 'sarif'): string =>
  readFileSync(join(ROOT, 'test', 'golden', `report-${name}.${ext}.txt`), 'utf8');

describe.each(REPORT_SCENARIOS)('golden: $name', (scenario) => {
  const tree = fixtureTree(scenario.fixture, scenario.overlay);
  afterAll(() => tree.cleanup());
  const runs: Record<'json' | 'sarif' | 'human', RunResult> = {} as never;
  beforeAll(() => {
    for (const format of ['json', 'sarif', 'human'] as const) {
      runs[format] = runBuilt([scenario.today, '.', '--format', format], {
        cwd: tree.root,
        script: WITH_TODAY,
      });
    }
  });

  it.each(['json', 'sarif'] as const)('--format %s prints exactly the golden text', (format) => {
    expect(runs[format].stdout).toBe(golden(scenario.golden, format));
  });

  it.each(['json', 'sarif', 'human'] as const)(
    '--format %s exits with the scenario exit code and writes nothing to stderr',
    (format) => {
      expect(runs[format].status).toBe(scenario.exit);
      expect(runs[format].stderr).toBe('');
    },
  );

  it('both documents are valid JSON and plain ASCII', () => {
    for (const format of ['json', 'sarif'] as const) {
      const text = runs[format].stdout;
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).toMatch(/^[\n\x20-\x7e]*$/);
      expect(text.endsWith('}\n')).toBe(true);
    }
  });

  it('the SARIF document passes the hand-written validator', () => {
    expect(validateSarif(JSON.parse(runs.sarif.stdout))).toEqual([]);
  });

  it('JSON and SARIF carry the same outcome, clean flag and exit code as the exit status', () => {
    const json = JSON.parse(runs.json.stdout);
    const props = JSON.parse(runs.sarif.stdout).runs[0].properties.tripcurve;
    expect(json.summary.exitCode).toBe(scenario.exit);
    expect(props.exitCode).toBe(scenario.exit);
    expect(json.summary.clean).toBe(scenario.exit === 0);
    expect(props.clean).toBe(scenario.exit === 0);
    expect(props.outcome).toBe(json.summary.outcome);
  });

  it('no SARIF document with a non-zero exit has an empty results array', () => {
    const results = JSON.parse(runs.sarif.stdout).runs[0].results;
    if (scenario.exit !== 0) expect(results.length).toBeGreaterThan(0);
  });

  it('the tripcurve-not-checked notes are as many as the notChecked count of the run properties (second review m-D)', () => {
    const run = JSON.parse(runs.sarif.stdout).runs[0];
    const notes = run.results.filter(
      (r: { ruleId: string }) => r.ruleId === 'tripcurve-not-checked',
    );
    expect(notes).toHaveLength(run.properties.tripcurve.notChecked);
    expect(JSON.parse(runs.json.stdout).notChecked).toHaveLength(notes.length);
  });

  it('is byte-identical on a second run (deterministic)', () => {
    const again = runBuilt([scenario.today, '.', '--format', 'sarif'], {
      cwd: tree.root,
      script: WITH_TODAY,
    });
    expect(again.stdout).toBe(runs.sarif.stdout);
  });
});

describe('what the goldens say, in words (the honesty rules)', () => {
  const sarif = (name: string) => JSON.parse(golden(name, 'sarif')).runs[0];
  const json = (name: string) => JSON.parse(golden(name, 'json'));

  it('the demo has exactly four error results in SARIF (B7)', () => {
    const results = sarif('demo').results as { level: string }[];
    expect(results.filter((r) => r.level === 'error')).toHaveLength(4);
    expect(json('demo').summary.failed).toBe(4);
  });

  it('PASS and N/A results are not in SARIF, and every FAIL is an error', () => {
    const text = golden('demo', 'sarif');
    expect(text).not.toContain('PASS');
    expect(text).not.toContain('N/A');
    expect(text).toContain('"level": "note"');
  });

  it('a valid waiver is a suppression of the right kind with the reason as justification; an expired one is not', () => {
    const waived = sarif('waived').results as {
      suppressions: { kind: string; justification: string }[];
    }[];
    expect(waived.map((r) => r.suppressions[0]?.kind)).toEqual([
      'external',
      'inSource',
      'inSource',
    ]);
    expect(waived[0]?.suppressions[0]?.justification).toBe('NLB owned by the network team');
    const expired = sarif('expired').results as {
      suppressions?: unknown;
      properties: Record<string, unknown>;
    }[];
    expect(expired.every((r) => r.suppressions === undefined)).toBe(true);
    expect(golden('expired', 'sarif')).toContain('"expiredWaiver"');
    expect(json('expired').waivers[0].state).toBe('expired');
  });

  it('a waived result is never counted as passed', () => {
    const summary = json('waived').summary;
    expect(summary.waived).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.outcome).toBe('NoFailures');
  });

  it('the no-files case, the config-error case and the nothing-checked case each give one warning at a file and clean: false', () => {
    for (const name of ['e1', 'e4', 'e10']) {
      const run = sarif(name);
      // the nothing-checked case also has a note for the workload that was not checked (review m4); the warning comes first
      expect(run.results).toHaveLength(name === 'e10' ? 2 : 1);
      expect(run.results[0].ruleId).toBe('tripcurve-file');
      expect(run.results[0].level).toBe('warning');
      expect(run.properties.tripcurve.clean).toBe(false);
      expect(run.properties.tripcurve.exitCode).toBe(2);
    }
    expect(json('e4').summary.outcome).toBe('ConfigError');
    expect(json('e4').workloads).toEqual([]);
    expect(json('e4').summary.passed).toBe(0);
  });

  it('an unchecked file is a warning located at that file, and counts under unresolved', () => {
    const run = sarif('unchecked');
    const file = run.results.find((r: { message: { text: string } }) =>
      r.message.text.startsWith('file not checked'),
    );
    expect(file.level).toBe('warning');
    expect(file.locations[0].physicalLocation.artifactLocation.uri).toBe('broken.yaml');
    expect(json('unchecked').summary.unresolved).toBe(1);
  });

  it('the stream NLB case is unresolved in both formats: never pass', () => {
    const results = sarif('stream').results as { level: string; message: { text: string } }[];
    expect(results.map((r) => r.level)).toEqual(['warning', 'warning', 'warning']);
    expect(golden('stream', 'json')).not.toContain('"PASS"');
    expect(json('stream').summary.clean).toBe(false);
  });

  it('hostile text is escaped: the documents hold no raw control, bidirectional or non-ASCII character', () => {
    for (const ext of ['json', 'sarif'] as const) {
      const text = golden('hostile', ext);
      expect(text).toMatch(/^[\n\x20-\x7e]*$/);
      expect(text).toContain('\\u202e');
    }
    // the lone surrogate became U+FFFD (SafeText's data mode) and the escape sequence stayed an escape
    expect(golden('hostile', 'json')).toContain('\\ufffd');
    expect(golden('hostile', 'json')).toContain('\\u001b[2J');
    expect(golden('hostile', 'sarif')).toContain('k8s/bad%22%E2%80%AE.yaml');
  });
});

describe('the formats on the command line', () => {
  const tree = fixtureTree('report/demo');
  afterAll(() => tree.cleanup());

  it('--format json exits with the report exit code and the human format is unchanged', () => {
    const human = runBuilt(['.'], { cwd: tree.root });
    const asJson = runBuilt(['.', '--format', 'json'], { cwd: tree.root });
    expect(human.status).toBe(1);
    expect(asJson.status).toBe(1);
    expect(human.stdout.startsWith('tripcurve 0.1.1   checked "."')).toBe(true);
    expect(JSON.parse(asJson.stdout).schemaVersion).toBe(1);
  });

  it('an unknown format is still a usage error that names the three formats', () => {
    const run = runBuilt(['--format', 'xml']);
    expect(run.status).toBe(2);
    expect(run.stderr).toBe(
      'tripcurve: unknown format. Formats are human, json and sarif. See --help.\n',
    );
    expect(run.stdout).toBe('');
  });
});

describe('standard input (a stream has no file)', () => {
  const stdin = ['ingress.yaml', 'service.yaml', 'web.yaml']
    .map(
      (f) =>
        `---\n${readFileSync(join(ROOT, 'test', 'fixtures', 'link', 'web-demo', 'k8s', f), 'utf8')}`,
    )
    .join('');

  it('JSON names <stdin>, the documents read and the document and line of each workload', () => {
    const run = runBuilt(['-', '--format', 'json'], { input: stdin });
    const doc = JSON.parse(run.stdout);
    expect(doc.checked).toEqual({ path: '<stdin>', filesRead: 0, documents: 3 });
    expect(doc.workloads[0]).toMatchObject({ name: 'web', file: '<stdin>', document: 3 });
    expect(run.status).toBe(doc.summary.exitCode);
  });

  it('SARIF results have no physicalLocation and say where they came from; the log is valid', () => {
    const run = runBuilt(['-', '--format', 'sarif'], { input: stdin });
    const log = JSON.parse(run.stdout);
    expect(validateSarif(log)).toEqual([]);
    const results = log.runs[0].results as {
      locations?: unknown;
      properties: { tripcurve: { source?: string } };
    }[];
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.locations).toBeUndefined();
      expect(r.properties.tripcurve.source).toMatch(/^<stdin> document 3, line \d+$/);
    }
    expect(run.stderr).toBe('');
  });
});
