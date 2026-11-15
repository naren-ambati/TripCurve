import { describe, expect, it } from 'vitest';
import {
  fileSource,
  inputText,
  makeSourcedValue,
  type ResultKind,
  stdinSource,
} from '../../src/core/index.js';
import { renderSarif, uriOf } from '../../src/report/index.js';
import {
  buildReport,
  configError,
  finding,
  goodChain,
  queue,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';
import { validateSarif } from '../support/sarif-validate.js';
import { entry, VALID_ENTRY } from '../support/waiver-records.js';

// The SARIF 2.1.0 log, built from the Report model.

const TODAY = '2026-11-12';
const api = workload('api', 'shop');

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: {
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId?: string };
      region?: { startLine: number };
    };
  }[];
  suppressions?: { kind: string; justification: string }[];
  properties: { tripcurve: Record<string, unknown> };
}

function sarifOf(parts: Parameters<typeof buildReport>[0]) {
  const text = renderSarif(buildReport({ today: TODAY, ...parts }));
  const log = JSON.parse(text);
  // every document the renderer writes is valid for the subset, whatever the test is about
  expect(validateSarif(log)).toEqual([]);
  expect(text).toMatch(/^[\n\x20-\x7e]*$/);
  const run = log.runs[0];
  return { run, results: run.results as SarifResult[], props: run.properties.tripcurve };
}

describe('levels', () => {
  const kinds: ResultKind[] = [
    'FAIL',
    'WARN',
    'UNRESOLVED',
    'VERSION-DEPENDENT',
    'NOT EVALUATED',
    'PASS',
    'N/A',
  ];
  const { results } = sarifOf({
    results: [
      wf(
        api,
        kinds.map((k, i) =>
          finding(k as never, (['T1', 'T2', 'T3', 'T4'] as const)[i % 4], api, `h ${k}`),
        ),
      ),
    ],
  });

  it('maps FAIL to error, WARN, UNRESOLVED and VERSION-DEPENDENT to warning, NOT EVALUATED to note', () => {
    expect(
      results.map((r) => [r.message.text.split(':')[0]?.split(' ').slice(1).join(' '), r.level]),
    ).toEqual([
      ['FAIL', 'error'],
      ['WARN', 'warning'],
      ['UNRESOLVED', 'warning'],
      ['VERSION-DEPENDENT', 'warning'],
      ['NOT EVALUATED', 'note'],
    ]);
  });

  it('emits no result for PASS or N/A', () => {
    expect(results).toHaveLength(5);
    expect(JSON.stringify(results)).not.toContain('"PASS"');
    expect(JSON.stringify(results)).not.toContain('N/A');
  });

  it('writes the message as "<RULE> <KIND>: <headline>" and the rule and kind in the properties', () => {
    expect(results[0]?.message.text).toBe('T1 FAIL: h FAIL');
    expect(results[0]?.ruleId).toBe('T1');
    expect(results[0]?.properties.tripcurve.kind).toBe('FAIL');
  });
});

describe('the rules', () => {
  const { run } = sarifOf({ results: [wf(api, [finding('FAIL')])] });
  it('lists T1 to T4 and tripcurve-file, each described, with the explain command as its help', () => {
    const rules = run.tool.driver.rules as {
      id: string;
      shortDescription: { text: string };
      help: { text: string };
    }[];
    expect(rules.map((r) => r.id)).toEqual([
      'T1',
      'T2',
      'T3',
      'T4',
      'tripcurve-file',
      'tripcurve-run',
      'tripcurve-not-checked',
    ]);
    expect(rules[0]?.help.text).toContain('tripcurve --explain T1');
    expect(rules[0]?.shortDescription.text).toContain('idle close');
    expect(run.tool.driver.name).toBe('tripcurve');
    expect(run.tool.driver.version).toBe('0.1.1');
  });
});

describe('locations', () => {
  it('a result is at the first chain value read from the workload file, else at the workload', () => {
    const own = finding('FAIL', 'T1', api, 'h', [
      ...goodChain('k8s/ingress.yaml', 9),
      ...goodChain('k8s/web.yaml', 17),
    ]);
    const none = finding('FAIL', 'T2', api, 'h', goodChain('k8s/ingress.yaml', 9));
    const { results } = sarifOf({ results: [wf(api, [own, none], 'k8s/web.yaml')] });
    expect(results[0]?.locations?.[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'k8s/web.yaml', uriBaseId: 'SRCROOT' },
      region: { startLine: 17 },
    });
    // wf puts the workload at line 2 of its file
    expect(results[1]?.locations?.[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'k8s/web.yaml', uriBaseId: 'SRCROOT' },
      region: { startLine: 2 },
    });
  });

  it('standard input has no physicalLocation and the properties say where it came from', () => {
    const f = finding('FAIL', 'T1', api, 'h', [
      {
        label: 'LB idle',
        value: makeSourcedValue({
          value: 60,
          unit: 's',
          source: stdinSource(2, 9),
          basis: 'declared',
        }),
      },
    ]);
    const { results } = sarifOf({
      checked: '<stdin>',
      results: [{ workload: api, file: stdinSource(2, 5), findings: [f] }],
    });
    expect(results[0]?.locations).toBeUndefined();
    expect(results[0]?.properties.tripcurve.source).toBe('<stdin> document 2, line 9');
  });

  it('the workload is named in the properties, so two results with one message can be told apart', () => {
    const { results } = sarifOf({
      results: [
        wf(workload('a', 'x'), [finding('FAIL')], 'k8s/a.yaml'),
        wf(queue('orders'), [finding('FAIL', 'T4', queue('orders'))], 'infra/queue.tf'),
      ],
    });
    expect(results[0]?.properties.tripcurve.workload).toEqual({
      name: 'a',
      kind: 'Deployment',
      namespace: 'x',
    });
    expect(results[1]?.properties.tripcurve.workload).toEqual({
      name: 'orders',
      kind: 'event source mapping',
    });
  });
});

describe('uriOf: a path as a URI reference (SARIF 3.4.3)', () => {
  it.each([
    ['k8s/api.yaml', 'k8s/api.yaml'],
    ['k8s/a b.yaml', 'k8s/a%20b.yaml'],
    ['k8s/a"b‮.yaml', 'k8s/a%22b%E2%80%AE.yaml'],
    ['a:b/c.yaml', 'a%3Ab/c.yaml'],
    ['café/x#1?.yaml', 'caf%C3%A9/x%231%3F.yaml'],
    ['.', '.'],
    ['./docs', './docs'],
    ['/abs/my dir', 'file:///abs/my%20dir'],
    ['//host/x', 'file:////host/x'],
    ['a\ud800b', 'a%EF%BF%BDb'],
  ])('%j becomes %j', (raw, uri) => {
    expect(uriOf(inputText(raw))).toBe(uri);
  });
});

describe('waivers', () => {
  const results = (records: ReturnType<typeof entry>[], today = TODAY) =>
    sarifOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'no drain delay before SIGTERM')])],
      waiverRecords: records,
      today,
    }).results;

  it('a valid tripcurve.yaml waiver is an external suppression with the reason as justification', () => {
    const [r] = results([entry(VALID_ENTRY)]);
    expect(r?.suppressions?.map((x) => [x.kind, x.justification])).toEqual([
      ['external', 'drains in sidecar'],
    ]);
    expect(r?.level).toBe('error');
    expect(r?.message.text).toBe('T2 FAIL: no drain delay before SIGTERM');
    expect(r?.properties.tripcurve).toMatchObject({ kind: 'WAIVED', originalKind: 'FAIL' });
  });

  it('an expired waiver carries no suppression, keeps its level and is on the properties', () => {
    const [r] = results([entry({ ...VALID_ENTRY, until: '2026-11-11' })]);
    expect(r?.suppressions).toBeUndefined();
    expect(r?.level).toBe('error');
    expect(r?.properties.tripcurve.expiredWaiver).toEqual({
      until: '2026-11-11',
      reason: 'drains in sidecar',
      mechanism: 'config',
    });
  });

  it('a waived result keeps the level of its original kind', () => {
    const unresolved = finding('UNRESOLVED', 'T2', api, 'h');
    const { results: rs } = sarifOf({
      results: [wf(api, [unresolved])],
      waiverRecords: [entry(VALID_ENTRY)],
    });
    expect(rs[0]?.level).toBe('warning');
    expect(rs[0]?.suppressions?.[0]?.kind).toBe('external');
  });

  it('an invalid and an unmatched waiver are warnings at the file that holds them, and suppress nothing', () => {
    const rs = results([
      entry({ ...VALID_ENTRY, workload: 'ghost' }, 7),
      entry({ ...VALID_ENTRY, rule: 'T1' }, 11),
    ]);
    const files = rs.filter((r) => r.ruleId === 'tripcurve-file');
    expect(files).toHaveLength(2);
    expect(files.map((r) => r.level)).toEqual(['warning', 'warning']);
    expect(files.map((r) => r.locations?.[0]?.physicalLocation.region?.startLine)).toEqual([7, 11]);
    expect(files.map((r) => r.properties.tripcurve.reason)).toEqual([
      'invalid-waiver',
      'unmatched-waiver',
    ]);
    expect(files[0]?.message.text).toContain(
      'names a workload that was not read; it suppresses nothing',
    );
    expect(files[1]?.message.text).toBe(
      'waiver not applied: no finding for rule T1 on workload "api" matches the waiver; it suppresses nothing',
    );
    expect(rs.find((r) => r.ruleId === 'T2')?.suppressions).toBeUndefined();
  });
});

describe('file results: nothing a consumer reading only results could miss', () => {
  it('each unchecked file is a warning located at the file, with the line of a parse error', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      unchecked: [unchecked('k8s/a.yaml', 'parse-error', 14), unchecked('k8s/b.yaml', 'over-size')],
    });
    expect(results.map((r) => r.message.text)).toEqual([
      'file not checked: "k8s/a.yaml": YAML syntax error at line 14',
      'file not checked: "k8s/b.yaml": larger than the 5 MB limit',
    ]);
    expect(results.map((r) => r.locations?.[0]?.physicalLocation.region?.startLine)).toEqual([
      14,
      undefined,
    ]);
    expect(results.every((r) => r.ruleId === 'tripcurve-file' && r.level === 'warning')).toBe(true);
  });

  it('an unchecked stream has no physicalLocation', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      unchecked: [{ path: '<stdin>', reasonCode: 'parse-error', line: 3 }],
    });
    expect(results[0]?.locations).toBeUndefined();
    expect(results[0]?.properties.tripcurve.source).toBe('<stdin>');
    expect(results[0]?.message.text).toBe('file not checked: <stdin>: YAML syntax error at line 3');
  });

  it('each configuration error is a warning at the file and line, in the words of the human report', () => {
    const { results, props } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      configErrors: [
        { ...configError('workloads[0].longest_request_s', 7), expected: 'a number of seconds' },
        configError('colour', 9, 'unknown-key'),
        {
          ...configError('longest_request_s', 11, 'declaration-names-no-workload'),
          workload: inputText('ghost'),
        },
        { ...configError('x', 12, 'duplicate-workload-entry'), workload: inputText('web') },
      ],
    });
    expect(results.map((r) => r.message.text)).toEqual([
      'configuration error: key "workloads\\[0\\].longest_request_s" must be a number of seconds',
      'configuration error: key "colour" is not a key tripcurve knows',
      'configuration error: no workload named "ghost" for "longest_request_s"',
      'configuration error: two entries name the same workload "web"',
    ]);
    expect(results.map((r) => r.locations?.[0]?.physicalLocation.region?.startLine)).toEqual([
      7, 9, 11, 12,
    ]);
    expect(props).toMatchObject({ outcome: 'ConfigError', clean: false, exitCode: 2 });
    expect(results.every((r) => r.ruleId === 'tripcurve-file')).toBe(true);
  });

  it('the no-files case is one warning at the checked root, the nothing-checked case another, and a stream root has no location', () => {
    const e1 = sarifOf({ noRecognisedFiles: true, filesRead: 0, checked: './docs' }).results;
    expect(e1).toHaveLength(1);
    expect(e1[0]?.message.text).toBe(
      'nothing checked: no Kubernetes, server or Terraform files found under "./docs"',
    );
    expect(e1[0]?.locations?.[0]?.physicalLocation.artifactLocation).toEqual({
      uri: '.',
      uriBaseId: 'SRCROOT',
    });
    const e10 = sarifOf({ results: [], filesRead: 4 }).results;
    expect(e10.map((r) => r.message.text)).toEqual([
      'nothing checked: files were read but no check was evaluated',
    ]);
    const stream = sarifOf({ noRecognisedFiles: true, filesRead: 0, checked: '<stdin>' }).results;
    expect(stream[0]?.locations).toBeUndefined();
    expect(stream[0]?.message.text).toBe(
      'nothing checked: no Kubernetes, server or Terraform files found under <stdin>',
    );
  });

  it('the root is the SRCROOT base itself, whatever was typed, never an absolute-path reference (m8)', () => {
    const { results } = sarifOf({
      noRecognisedFiles: true,
      filesRead: 0,
      checked: '/work/my repo',
    });
    expect(results[0]?.locations?.[0]?.physicalLocation.artifactLocation).toEqual({
      uri: '.',
      uriBaseId: 'SRCROOT',
    });
    expect(results[0]?.message.text).toContain('"/work/my repo"');
  });
});

describe('the run properties', () => {
  it('carry the outcome, clean, the counts, the exit code and how many objects were not checked', () => {
    const { props } = sarifOf({
      results: [wf(api, [finding('PASS'), finding('N/A', 'T2')])],
      notChecked: [
        {
          subjectKind: 'workload',
          subject: inputText('w'),
          kind: 'Deployment',
          file: inputText('k8s/x.yaml'),
          reasonCode: 'no-recognised-lb',
        },
      ],
    });
    expect(props).toEqual({
      outcome: 'Clean',
      clean: true,
      summary: {
        failed: 0,
        warning: 0,
        unresolved: 0,
        versionDependent: 0,
        notEvaluated: 0,
        waived: 0,
        notApplicable: 1,
        passed: 1,
      },
      exitCode: 0,
      notChecked: 1,
    });
  });

  it('a clean run has an empty results array, and only then (a non-zero exit never has one)', () => {
    expect(sarifOf({ results: [wf(api, [finding('PASS')])] }).results).toEqual([]);
    for (const parts of [
      { results: [wf(api, [finding('FAIL')])] },
      { results: [wf(api, [finding('PASS')])], unchecked: [unchecked('k8s/x.yaml')] },
      { results: [] as ReturnType<typeof wf>[] },
      { configErrors: [configError('k')] },
      { noRecognisedFiles: true, filesRead: 0 },
    ]) {
      const { results, props } = sarifOf(parts);
      expect(props.exitCode).not.toBe(0);
      expect(results.length).toBeGreaterThan(0);
    }
  });
});

describe('hostile input', () => {
  const nasty = 'a"b\\‮\ud800\u{1f600}\u001b[2J\n`<b>';
  const w = workload(nasty);
  const { results } = sarifOf({
    results: [
      wf(
        w,
        [finding('FAIL', 'T1', w, 'h', goodChain(`k8s/${nasty}.yaml`, 4))],
        `k8s/${nasty}.yaml`,
      ),
    ],
    unchecked: [unchecked(`k8s/${nasty}.yaml`, 'parse-error', 2)],
    waiverRecords: [entry({ ...VALID_ENTRY, rule: 'T1', workload: nasty, reason: nasty })],
  });

  it('the messages hold the name only in quotes and escaped, so they cannot start a line or hold markup', () => {
    const file = results.find((r) => r.ruleId === 'tripcurve-file');
    expect(file?.message.text).toMatch(
      /^file not checked: "[\x20-\x7e]*": YAML syntax error at line 2$/,
    );
    expect(file?.message.text).not.toContain('\n');
    expect(file?.message.text).toContain('\\u202e');
  });

  it('the URI is percent-encoded and the justification is the plain reason as a JSON string', () => {
    const located = results[0]?.locations?.[0]?.physicalLocation.artifactLocation.uri ?? '';
    expect(located).toMatch(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/);
    expect(results[0]?.suppressions?.[0]?.justification).toBe('a"b\\‮�\u{1f600}\u001b[2J\n`<b>');
  });
});

// ---- adversarial review of B7 -------------------------------------------------------------------

import { type Finding, makeFinding } from '../../src/core/index.js';

describe('review M1: a not-clean run is never all notes', () => {
  const waivedPair = [
    entry({ ...VALID_ENTRY, rule: 'T1' }, 3),
    entry({ ...VALID_ENTRY, rule: 'T2' }, 7),
  ];
  const noteOnly = (extra: Parameters<typeof buildReport>[0] = {}) =>
    sarifOf({
      results: [
        wf(api, [
          finding('FAIL', 'T1', api, 'a'),
          finding('FAIL', 'T2', api, 'b'),
          finding('NOT EVALUATED', 'T3', api, 'c'),
        ]),
      ],
      waiverRecords: waivedPair,
      ...extra,
    });

  it('adds one warning at the root, under tripcurve-run, when the only unsuppressed result is a note', () => {
    const { results, props } = noteOnly();
    expect(props.clean).toBe(false);
    const run = results.filter((r) => r.ruleId === 'tripcurve-run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      level: 'warning',
      message: { text: 'the run is not clean: 1 not evaluated; see the run properties' },
      properties: { tripcurve: { reason: 'not-clean' } },
    });
    expect(run[0]?.locations?.[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: '.', uriBaseId: 'SRCROOT' },
    });
    expect(run[0]?.suppressions).toBeUndefined();
  });

  it('names every unclean count, in the order of the closing line', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('NOT EVALUATED', 'T3', api, 'c')])],
      configErrors: [],
    });
    expect(results.find((r) => r.ruleId === 'tripcurve-run')?.message.text).toBe(
      'the run is not clean: 1 not evaluated; see the run properties',
    );
  });

  it('is not added when an unsuppressed error, a warning or a file result already says so', () => {
    for (const parts of [
      { results: [wf(api, [finding('FAIL')])] },
      { results: [wf(api, [finding('UNRESOLVED')])] },
      { results: [wf(api, [finding('NOT EVALUATED')])], unchecked: [unchecked('k8s/x.yaml')] },
      {
        results: [wf(api, [finding('NOT EVALUATED')])],
        waiverRecords: [entry({ ...VALID_ENTRY, workload: 'ghost' })],
      },
      { noRecognisedFiles: true, filesRead: 0 },
      { configErrors: [configError('k')] },
    ] as Parameters<typeof buildReport>[0][]) {
      expect(sarifOf(parts).results.some((r) => r.ruleId === 'tripcurve-run')).toBe(false);
    }
  });

  it('is not added to a clean run, and a suppressed error does not count as saying so', () => {
    expect(
      sarifOf({ results: [wf(api, [finding('PASS')])] }).results.some(
        (r) => r.ruleId === 'tripcurve-run',
      ),
    ).toBe(false);
    const { results } = noteOnly();
    const unsuppressed = results.filter(
      (r) => (r.level === 'error' || r.level === 'warning') && r.suppressions === undefined,
    );
    expect(unsuppressed.map((r) => r.ruleId)).toEqual(['tripcurve-run']);
  });

  it('lists tripcurve-run among the rules', () => {
    expect(noteOnly().run.tool.driver.rules.map((r: { id: string }) => r.id)).toContain(
      'tripcurve-run',
    );
  });
});

describe('review M2: message text cannot hold an embedded link (SARIF 3.11.6)', () => {
  const evil = '[pwn](https://evil.example/x)';

  it('escapes [ and ] in quoted names, and { and } (3.11.5), in every message that quotes input', () => {
    const hostile = workload(evil);
    const { results } = sarifOf({
      results: [wf(hostile, [finding('UNRESOLVED', 'T1', hostile, 'h')], 'k8s/a.yaml')],
      unchecked: [unchecked(evil + '.yaml', 'parse-error', 2)],
      waiverRecords: [entry({ ...VALID_ENTRY, workload: evil, reason: 'r' }, 4)],
    });
    const texts = results.map((r) => r.message.text);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const text of texts) {
      expect(text).not.toContain('[pwn](');
      expect(text.replace(/\\[[\]]/g, '')).not.toMatch(/[[\]]/);
    }
    expect(texts.find((t) => t.startsWith('file not checked'))).toBe(
      'file not checked: "\\[pwn\\](https://evil.example/x).yaml": YAML syntax error at line 2',
    );
  });

  it('escapes a key in a configuration error', () => {
    const { results } = sarifOf({ configErrors: [configError(evil, 3, 'unknown-key')] });
    expect(results[0]?.message.text).toBe(
      'configuration error: key "\\[pwn\\](https://evil.example/x)" is not a key tripcurve knows',
    );
  });

  it('escapes the name in an unmatched waiver and in the root of the no-files case', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'x')])],
      waiverRecords: [entry({ ...VALID_ENTRY, rule: 'T1', workload: 'api', reason: evil }, 4)],
    });
    expect(
      results.find((r) => r.properties.tripcurve.reason === 'unmatched-waiver')?.message.text,
    ).toContain('workload "api"');
    const e1 = sarifOf({ noRecognisedFiles: true, filesRead: 0, checked: evil }).results;
    expect(e1[0]?.message.text).toBe(
      'nothing checked: no Kubernetes, server or Terraform files found under "\\[pwn\\](https://evil.example/x)"',
    );
    expect(JSON.stringify(e1[0]?.message.text)).not.toContain('[pwn](');
  });

  it('an invalid waiver message quotes the waiver text with its brackets escaped', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'x')])],
      waiverRecords: [entry({ rule: 'T2', workload: 'api', reason: evil }, 4)],
    });
    const invalid = results.find((r) => r.properties.tripcurve.reason === 'invalid-waiver');
    expect(invalid?.message.text).toContain('\\[pwn\\]');
    expect(invalid?.message.text).not.toContain('[pwn](');
  });

  it('braces are doubled (3.11.5) and a backslash before a bracket stays unambiguous', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('FAIL')])],
      unchecked: [unchecked('a{0}\\[b].yaml', 'over-size')],
    });
    expect(results.find((r) => r.ruleId === 'tripcurve-file')?.message.text).toBe(
      'file not checked: "a{{0}}\\\\\\[b\\].yaml": larger than the 5 MB limit',
    );
  });
});

describe('review m2: a suppression carries the expiry', () => {
  it('has until, the mechanism and the source in its properties', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('FAIL', 'T2', api, 'no drain')])],
      waiverRecords: [entry(VALID_ENTRY)],
    });
    expect(results[0]?.suppressions?.[0]).toEqual({
      kind: 'external',
      justification: 'drains in sidecar',
      properties: {
        tripcurve: {
          until: '2027-01-31',
          mechanism: 'config',
          source: { type: 'declared', file: 'tripcurve.yaml', line: 3 },
        },
      },
    });
  });
});

describe('review m4: a workload that was not checked is a note', () => {
  const item = (name: string | undefined, file: string, line?: number) => ({
    subjectKind: 'workload' as const,
    ...(name === undefined ? {} : { subject: inputText(name) }),
    kind: 'Deployment' as const,
    file: inputText(file),
    ...(line === undefined ? {} : { line }),
    reasonCode: 'no-recognised-lb' as const,
  });

  it('is one note per workload under tripcurve-not-checked, at its manifest, and the run stays clean', () => {
    const { results, props, run } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      notChecked: [item('lonely', 'k8s/extra.yaml', 2), item(undefined, 'k8s/two.yaml')],
    });
    expect(props.clean).toBe(true);
    expect(props.exitCode).toBe(0);
    expect(results.map((r) => [r.ruleId, r.level, r.message.text])).toEqual([
      [
        'tripcurve-not-checked',
        'note',
        'not checked: Deployment "lonely": no load balancer found in the checked files, so T1 to T3 were not checked for it',
      ],
      [
        'tripcurve-not-checked',
        'note',
        'not checked: Deployment: no load balancer found in the checked files, so T1 to T3 were not checked for it',
      ],
    ]);
    expect(results[0]?.locations?.[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'k8s/extra.yaml', uriBaseId: 'SRCROOT' },
      region: { startLine: 2 },
    });
    expect(results[1]?.locations?.[0]?.physicalLocation.region).toBeUndefined();
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toContain(
      'tripcurve-not-checked',
    );
  });
});

describe('review m6: a result without a level is a warning, never nothing', () => {
  const base = makeFinding({ rule: 'T1', subject: api, kind: 'FAIL', headline: 'h', chain: [] });

  it('a kind that is not one of the eight is a warning', () => {
    const odd = { ...base, kind: 'BOGUS' } as unknown as Finding;
    const { results } = sarifOf({ results: [wf(api, [odd])] });
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('warning');
    expect(results[0]?.suppressions).toBeUndefined();
  });

  it('a WAIVED finding with an original kind but no waiver keeps the level of that kind (second review m-A)', () => {
    for (const [original, level] of [
      ['FAIL', 'error'],
      ['UNRESOLVED', 'warning'],
      ['NOT EVALUATED', 'note'],
    ] as const) {
      const f = { ...base, kind: 'WAIVED', originalKind: original } as unknown as Finding;
      const { results } = sarifOf({ results: [wf(api, [f])] });
      expect(results[0]?.level, original).toBe(level);
      expect(results[0]?.suppressions, original).toBeUndefined();
    }
  });

  it('a WAIVED finding that has a waiver but no original kind is not suppressed either', () => {
    const waiver = {
      until: '2027-01-31',
      reason: inputText('r'),
      source: fileSource(inputText('tripcurve.yaml'), 3),
      mechanism: 'config' as const,
    };
    const odd = { ...base, kind: 'WAIVED', waiver } as unknown as Finding;
    const { results } = sarifOf({ results: [wf(api, [odd])] });
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('warning');
    expect(results[0]?.suppressions).toBeUndefined();
  });

  it('a WAIVED finding with no original kind or no waiver is a warning and is not suppressed', () => {
    const noOriginal = { ...base, kind: 'WAIVED' } as unknown as Finding;
    const noWaiver = { ...base, kind: 'WAIVED', originalKind: 'FAIL' } as unknown as Finding;
    const { results } = sarifOf({ results: [wf(api, [noOriginal, noWaiver])] });
    expect(results.map((r) => r.level)).toEqual(['warning', 'error']);
    expect(results.every((r) => r.suppressions === undefined)).toBe(true);
    expect(results[0]?.message.text).toBe('T1 WAIVED: h');
  });
});

describe('review m8: URIs are relative to the SRCROOT base', () => {
  it('declares SRCROOT without a uri, so no machine path is in the log, and uses it on every relative uri', () => {
    const { run, results } = sarifOf({
      results: [wf(api, [finding('FAIL')])],
      unchecked: [unchecked('k8s/b.yaml')],
    });
    expect(run.originalUriBaseIds).toEqual({
      SRCROOT: {
        description: {
          text: 'The directory that was checked. Every relative uri in this log is relative to it.',
        },
      },
    });
    for (const r of results) {
      expect(r.locations?.[0]?.physicalLocation.artifactLocation.uriBaseId).toBe('SRCROOT');
    }
  });

  it('a file: URI (a config file outside the root) has no base', () => {
    const { results } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      configErrors: [{ ...configError('k'), file: inputText('/etc/tripcurve.yaml') }],
    });
    expect(results[0]?.locations?.[0]?.physicalLocation.artifactLocation).toEqual({
      uri: 'file:///etc/tripcurve.yaml',
    });
  });
});

describe('second review m-D: every not-checked item is a note', () => {
  it('an Ingress and a kind that is not checked are notes at their file, and the count matches the run properties', () => {
    const { results, props } = sarifOf({
      results: [wf(api, [finding('PASS')])],
      notChecked: [
        {
          subjectKind: 'ingress',
          subject: inputText('web'),
          kind: 'Ingress',
          file: inputText('k8s/i.yaml'),
          line: 4,
          reasonCode: 'not-alb-ingress',
        },
        {
          subjectKind: 'kind',
          kind: 'HTTPRoute',
          file: inputText('k8s/g.yaml'),
          reasonCode: 'kind-not-checked',
        },
      ] as never,
    });
    expect(results.map((r) => [r.ruleId, r.level, r.message.text])).toEqual([
      [
        'tripcurve-not-checked',
        'note',
        'not checked: Ingress "web": not recognised as an ALB Ingress',
      ],
      ['tripcurve-not-checked', 'note', 'not checked: HTTPRoute: not a kind tripcurve checks'],
    ]);
    expect(results[0]?.locations?.[0]?.physicalLocation.region?.startLine).toBe(4);
    expect(results.length).toBe(props.notChecked);
  });
});
