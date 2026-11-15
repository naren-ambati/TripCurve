import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSarif } from '../support/sarif-validate.js';

// The hand-written SARIF subset validator: it must accept every golden and refuse each
// kind of broken document. A validator that accepts everything would pass the first test only, so each
// mutation below must make it fail with the section it cites.

const GOLDEN = join(import.meta.dirname, '..', 'golden');
const sarifGoldens = readdirSync(GOLDEN).filter((f) => f.endsWith('.sarif.txt'));

type Doc = {
  version: unknown;
  runs: {
    originalUriBaseIds?: unknown;
    tool: { driver: { name: unknown; version?: unknown; rules: Record<string, unknown>[] } };
    results: Record<string, unknown>[];
    properties?: unknown;
  }[];
};

function load(name: string): Doc {
  return JSON.parse(readFileSync(join(GOLDEN, name), 'utf8')) as Doc;
}

/** A copy of the waived golden (it has a location, a region and suppressions on every result). */
function fresh(): Doc {
  return load('report-waived.sarif.txt');
}

describe('the validator accepts every SARIF golden', () => {
  it('finds the goldens', () => {
    expect(sarifGoldens.length).toBeGreaterThanOrEqual(9);
  });
  it.each(sarifGoldens)('%s has no problem', (name) => {
    expect(validateSarif(load(name))).toEqual([]);
  });
  it('accepts a minimal log, an empty suppressions array and a result with no location', () => {
    const doc = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'x', rules: [{ id: 'R' }] } },
          results: [{ ruleId: 'R', level: 'warning', message: { text: 'm' }, suppressions: [] }],
        },
      ],
    };
    expect(validateSarif(doc)).toEqual([]);
  });
});

interface Mutation {
  readonly name: string;
  /** The cited section (or a word of the problem) the report must name. */
  readonly section: string;
  readonly apply: (doc: Doc) => unknown;
}

type Bag = Record<string, unknown>;
const run0 = (doc: Doc) => doc.runs[0] as Doc['runs'][number];
const driver0 = (doc: Doc) => run0(doc).tool.driver as unknown as Bag;
const rules0 = (doc: Doc) => run0(doc).tool.driver.rules as Bag[];
const result0 = (doc: Doc) => run0(doc).results[0] as Bag;
const physical0 = (doc: Doc) =>
  (((result0(doc).locations as Bag[])[0] as Bag).physicalLocation as Bag) ?? {};
const artifact0 = (doc: Doc) => physical0(doc).artifactLocation as Bag;

/** A mutation that changes the document in place. */
function edit(name: string, section: string, change: (doc: Doc) => void): Mutation {
  return {
    name,
    section,
    apply: (doc) => {
      change(doc);
      return doc;
    },
  };
}

/** A mutation that sets one property of the first result. */
const setResult = (name: string, section: string, key: string, value: unknown): Mutation =>
  edit(name, section, (d) => {
    result0(d)[key] = value;
  });

const setUri = (name: string, section: string, uri: unknown): Mutation =>
  edit(name, section, (d) => {
    artifact0(d).uri = uri;
  });

const setRegion = (name: string, section: string, region: unknown): Mutation =>
  edit(name, section, (d) => {
    physical0(d).region = region;
  });

const MUTATIONS: readonly Mutation[] = [
  { name: 'the log is not an object', section: '3.13', apply: () => [] },
  edit('version missing', '3.13.2', (d) => {
    delete (d as Partial<Doc>).version;
  }),
  { name: 'version 2.0.0', section: '3.13.2', apply: (d) => ({ ...d, version: '2.0.0' }) },
  { name: 'version is a number', section: '3.13.2', apply: (d) => ({ ...d, version: 2.1 }) },
  edit('runs missing', '3.13.4', (d) => {
    delete (d as Partial<Doc>).runs;
  }),
  { name: 'runs empty', section: '3.13.4', apply: (d) => ({ ...d, runs: [] }) },
  { name: 'runs is an object', section: '3.13.4', apply: (d) => ({ ...d, runs: {} }) },
  { name: 'a run is not an object', section: '3.14', apply: (d) => ({ ...d, runs: [1] }) },
  edit('tool missing', '3.14.6', (d) => {
    delete (run0(d) as Partial<Doc['runs'][0]>).tool;
  }),
  edit('driver missing', '3.18.2', (d) => {
    delete (run0(d).tool as unknown as Bag).driver;
  }),
  edit('driver name missing', '3.19.8', (d) => {
    delete driver0(d).name;
  }),
  edit('driver name empty', '3.19.8', (d) => {
    driver0(d).name = '';
  }),
  edit('driver name is a number', '3.19.8', (d) => {
    driver0(d).name = 7;
  }),
  edit('driver version is a number', '3.19.13', (d) => {
    driver0(d).version = 1;
  }),
  edit('rules is an object', '3.19.23', (d) => {
    driver0(d).rules = {};
  }),
  edit('a rule is not an object', '3.19.23', (d) => {
    rules0(d)[0] = 'T1' as never;
  }),
  edit('a rule has no id', '3.49.3', (d) => {
    delete rules0(d)[0]?.id;
  }),
  edit('a rule id is a number', '3.49.3', (d) => {
    rules0(d)[0] = { id: 1 };
  }),
  edit('a rule id is listed twice', 'listed twice', (d) => {
    rules0(d).push({ id: 'T1' });
  }),
  edit('a rule description has no text', '3.12.3', (d) => {
    rules0(d)[0] = { id: 'T1', shortDescription: {} };
  }),
  edit('a rule help text is empty', '3.12.3', (d) => {
    rules0(d)[0] = { id: 'T1', help: { text: '' } };
  }),
  edit('results missing', '3.14.23', (d) => {
    delete (run0(d) as Partial<Doc['runs'][0]>).results;
  }),
  edit('results is an object', '3.14.23', (d) => {
    (run0(d) as unknown as Bag).results = {};
  }),
  edit('a result is not an object', '3.27', (d) => {
    run0(d).results[0] = null as never;
  }),
  edit('ruleId missing', '3.27.5', (d) => {
    delete result0(d).ruleId;
  }),
  setResult('ruleId is a number', '3.27.5', 'ruleId', 1),
  setResult('ruleId is not in tool.driver.rules', '3.27.6', 'ruleId', 'T9'),
  setResult('level is not one of the four', '3.27.10', 'level', 'fatal'),
  setResult('level is a number', '3.27.10', 'level', 1),
  setResult('level in capitals', '3.27.10', 'level', 'WARNING'),
  edit('message missing', '3.27.11', (d) => {
    delete result0(d).message;
  }),
  setResult('message is a string', '3.27.11', 'message', 'text'),
  setResult('message text with a link', '3.11.6', 'message', { text: 'bad [x](http://e) {0}' }),
  setResult('message text with a bare bracket', '3.11.6', 'message', { text: 'a ] b' }),
  setResult('message text with a bare brace', '3.11.5', 'message', { text: 'a { b' }),
  setResult('message text where a doubled backslash leaves a bracket bare', '3.11.6', 'message', {
    text: 'a \\\\[b',
  }),
  setResult('message text with a single closing brace after a pair', '3.11.5', 'message', {
    text: 'a {{b}}}',
  }),
  setResult('message text empty', '3.11.8', 'message', { text: '' }),
  setResult('message text is a number', '3.11.8', 'message', { text: 5 }),
  setResult('locations is an object', '3.27.12', 'locations', {}),
  setResult('a location is not an object', '3.28', 'locations', [1]),
  setResult('physicalLocation missing', '3.28.3', 'locations', [{}]),
  edit('artifactLocation missing', '3.29.2', (d) => {
    delete physical0(d).artifactLocation;
  }),
  edit('uri missing', '3.4.3', (d) => {
    physical0(d).artifactLocation = {};
  }),
  setUri('uri is a number', '3.4.3', 3),
  setUri('uri empty', '3.4.3', ''),
  setUri('uri begins with a slash', '3.4.3', '/etc/x.yaml'),
  setUri('uri has a space', '3.4.3', 'a b.yaml'),
  setUri('uri has a quote', '3.4.3', 'a"b.yaml'),
  setUri('uri has a non-ASCII character', '3.4.3', 'caf\u00e9.yaml'),
  setUri('uri has a bad percent-encoding', 'percent', 'a%2.yaml'),
  setUri('uri has a colon in its first segment', 'colon', 'a:b/c.yaml'),
  setRegion('region is a number', '3.30', 3),
  setRegion('startLine is 0', '3.30.5', { startLine: 0 }),
  setRegion('startLine is negative', '3.30.5', { startLine: -4 }),
  setRegion('startLine is fractional', '3.30.5', { startLine: 1.5 }),
  setRegion('startLine is a string', '3.30.5', { startLine: '7' }),
  setRegion('region has no startLine', '3.30.5', {}),
  setResult('suppressions is an object', '3.27.23', 'suppressions', {}),
  setResult('a suppression is not an object', '3.35', 'suppressions', ['x']),
  setResult('suppression kind missing', '3.35.2', 'suppressions', [{ justification: 'x' }]),
  setResult('suppression kind not allowed', '3.35.2', 'suppressions', [{ kind: 'bogus' }]),
  setResult('suppression kind in capitals', '3.35.2', 'suppressions', [{ kind: 'External' }]),
  setResult('suppression status not allowed', '3.35.3', 'suppressions', [
    { kind: 'external', status: 'maybe' },
  ]),
  setResult('suppression justification is a number', '3.35.6', 'suppressions', [
    { kind: 'external', justification: 4 },
  ]),
  setResult('suppressions repeat', '3.27.23', 'suppressions', [
    { kind: 'external' },
    { kind: 'external' },
  ]),
  setResult('a properties bag is not an object', '3.8.1', 'properties', 'x'),
  edit('the run properties are not an object', '3.8.1', (d) => {
    run0(d).properties = [];
  }),
  {
    name: 'the log properties are not an object',
    section: '3.8.1',
    apply: (d) => ({ ...d, properties: 1 }),
  },

  // ----: closed property sets, required level, ruleIndex, startColumn, markdown, uriBaseId ----
  edit('an unknown key on the log', 'closed', (d) => {
    (d as unknown as Bag).runz = [];
  }),
  edit('an unknown key on a run', 'closed', (d) => {
    (run0(d) as unknown as Bag).rulez = [];
  }),
  edit('an unknown key on the tool', 'closed', (d) => {
    (run0(d).tool as unknown as Bag).extensionz = [];
  }),
  edit('an unknown key on the driver', 'closed', (d) => {
    driver0(d).rulez = [];
  }),
  edit('an unknown key on a rule', 'closed', (d) => {
    rules0(d)[0] = { id: 'T1', helpUrl: 'x' };
  }),
  edit('an unknown key on a rule description', 'closed', (d) => {
    rules0(d)[0] = { id: 'T1', help: { text: 'x', txt: 'y' } };
  }),
  setResult('a misspelt level key', 'closed', 'levle', 'error'),
  setResult('suppression spelt in the singular', 'closed', 'suppression', []),
  setResult('a result kind (tripcurve writes none)', 'closed', 'kind', 'bogus'),
  setResult('a misspelt message key', 'closed', 'message', { text: 'x', txet: 'y' }),
  edit('an unknown key on a location', 'closed', (d) => {
    (result0(d).locations as Bag[])[0] = { physicalLocation: physical0(d), id: 3 };
  }),
  edit('an unknown key on a physicalLocation', 'closed', (d) => {
    physical0(d).address = {};
  }),
  edit('an unknown key on an artifactLocation', 'closed', (d) => {
    artifact0(d).description = {};
  }),
  setRegion('startLineX on a region', 'closed', { startLine: 1, startLineX: 2 }),
  setResult('an unknown key on a suppression', 'closed', 'suppressions', [
    { kind: 'external', reason: 'x' },
  ]),
  edit('level missing', 'level', (d) => {
    delete result0(d).level;
  }),
  setResult('ruleIndex is negative', '3.27.6', 'ruleIndex', -1),
  setResult('ruleIndex is fractional', '3.27.6', 'ruleIndex', 1.5),
  setResult('ruleIndex is a string', '3.27.6', 'ruleIndex', '0'),
  setResult('ruleIndex points at another rule', '3.27.6', 'ruleIndex', 1),
  setResult('ruleIndex is past the rules', '3.27.6', 'ruleIndex', 99),
  setRegion('startColumn is 0', '3.30.6', { startLine: 1, startColumn: 0 }),
  setRegion('startColumn is fractional', '3.30.6', { startLine: 1, startColumn: 1.5 }),
  setRegion('startColumn is a string', '3.30.6', { startLine: 1, startColumn: '1' }),
  setResult('message.markdown is empty', '3.11.9', 'message', { text: 'x', markdown: '' }),
  setResult('message.markdown is a number', '3.11.9', 'message', { text: 'x', markdown: 3 }),
  edit('uriBaseId is a number (key)', '3.4.4', (d) => {
    artifact0(d).uriBaseId = 3;
  }),
  edit('a relative uri with no uriBaseId', '3.4.4', (d) => {
    delete artifact0(d).uriBaseId;
  }),
  edit('a uriBaseId that no originalUriBaseIds declares', '3.14.14', (d) => {
    artifact0(d).uriBaseId = 'ELSEWHERE';
  }),
  edit('a file: uri with a uriBaseId', '3.4.4', (d) => {
    Object.assign(artifact0(d), { uri: 'file:///a/b.yaml' });
  }),
  edit('originalUriBaseIds is an array', '3.14.14', (d) => {
    run0(d).originalUriBaseIds = [];
  }),
  edit('an originalUriBaseIds entry is not an object', '3.14.14', (d) => {
    run0(d).originalUriBaseIds = { SRCROOT: 'x' };
  }),
  edit('an originalUriBaseIds entry with a relative uri and no base', '3.14.14', (d) => {
    run0(d).originalUriBaseIds = { SRCROOT: { uri: 'src/' } };
  }),
  edit('an originalUriBaseIds entry with an unknown key', 'closed', (d) => {
    run0(d).originalUriBaseIds = { SRCROOT: { uri: 'file:///a/', note: 'x' } };
  }),
  setResult('suppression properties are not an object', '3.8.1', 'suppressions', [
    { kind: 'external', properties: 'x' },
  ]),
];

describe('the validator accepts what the spec allows and tripcurve may write', () => {
  it.each([
    'plain',
    'a \\[x\\](http://e) {{0}}',
    'two backslashes then an escaped bracket: \\\\\\[b\\]',
    'a trailing backslash \\',
  ])('the message %j', (text) => {
    const doc = fresh();
    result0(doc).message = { text };
    expect(validateSarif(doc)).toEqual([]);
  });
  it.each(['accepted', 'underReview', 'rejected'])('a suppression with status %s', (status) => {
    const doc = fresh();
    result0(doc).suppressions = [{ kind: 'external', status, justification: 'x' }];
    expect(validateSarif(doc)).toEqual([]);
  });
  it('a result with ruleIndex naming its own rule, a startColumn and a markdown message', () => {
    const doc = fresh();
    Object.assign(result0(doc), { ruleIndex: 0, message: { text: 'm', markdown: '**m**' } });
    physical0(doc).region = { startLine: 3, startColumn: 4 };
    expect(validateSarif(doc)).toEqual([]);
  });
});

describe('the validator refuses each broken document', () => {
  it('has the mutations (a guard against emptying the list)', () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(95);
  });
  it.each(MUTATIONS)('$name', ({ apply, section }) => {
    const mutated = apply(fresh());
    const problems = validateSarif(mutated);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(section);
  });
  it('the unmutated document passes, so each failure above comes from its mutation', () => {
    expect(validateSarif(fresh())).toEqual([]);
  });
});
