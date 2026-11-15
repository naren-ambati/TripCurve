// Inline waiver comments: `# tripcurve: ignore <RULE> reason="..." until=<date>` in a
// YAML file is READ, raw, with its file and line. Nothing is validated here: a malformed one is
// still a record, which the waiver reader judges in bolt B6. A comment is a real YAML comment: text inside
// a quoted or block scalar is not one.
import { afterEach, describe, expect, it } from 'vitest';
import { intake, readConfig } from '../../src/parse/index.js';
import { txt, where } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function records(files: Record<string, string>) {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  return readConfig(intake({ root: t.root })).waiverRecords;
}

const DEPLOY = (body: string): string =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n${body}spec: {}\n`;

describe('a well-formed inline waiver', () => {
  it('is read raw, with the file and the line it is written on', () => {
    const r = records({
      'k8s/api.yaml': DEPLOY(
        '  # tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31\n',
      ),
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.mechanism).toBe('inline');
    expect(r[0]?.rawFields).toEqual([]);
    expect(txt(r[0]?.rawText as never)).toBe(
      '# tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31',
    );
    expect(r[0]?.source && where(r[0].source)).toBe('k8s/api.yaml:5');
  });

  it('is read after a value on the same line, and in order of line', () => {
    const r = records({
      'k8s/api.yaml': [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: api # tripcurve: ignore T1 reason="a" until=2027-01-31',
        '  namespace: shop',
        '  # tripcurve: ignore T3 reason="b" until=2027-02-01',
        'spec: {}',
        '',
      ].join('\n'),
    });
    expect(r.map((x) => (x.source.type === 'file' ? x.source.line : 0))).toEqual([4, 6]);
  });

  it('is read in tripcurve.yaml and with no space after the hash', () => {
    const r = records({
      'tripcurve.yaml': 'version: 1\n#tripcurve: ignore T2 reason="x" until=2027-01-31\n',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.source && where(r[0].source)).toBe('tripcurve.yaml:2');
  });

  it('is read from a file with Windows line ends, without the carriage return', () => {
    const r = records({
      'k8s/api.yaml': DEPLOY('  # tripcurve: ignore T2 reason="x" until=2027-01-31\n').replaceAll(
        '\n',
        '\r\n',
      ),
    });
    expect(r).toHaveLength(1);
    expect(txt(r[0]?.rawText as never)).toBe('# tripcurve: ignore T2 reason="x" until=2027-01-31');
  });
});

describe('a malformed one is still a record (judged later, never silently dropped)', () => {
  it.each([
    '# tripcurve: ignore',
    '# tripcurve: ignore T9 until=never',
    '# tripcurve: ignore T2 reason= until=',
    '# tripcurve: please',
    '# tripcurve:',
  ])('%s', (comment) => {
    const r = records({ 'k8s/api.yaml': DEPLOY(`  ${comment}\n`) });
    expect(r).toHaveLength(1);
    expect(txt(r[0]?.rawText as never)).toBe(comment);
  });
});

describe('only a real comment that opens with tripcurve: counts', () => {
  it.each([
    [
      'text in a double-quoted scalar',
      DEPLOY('  note: "# tripcurve: ignore T2 reason=\\"x\\" until=2027-01-31"\n'),
    ],
    ['text in a single-quoted scalar', DEPLOY("  note: '# tripcurve: ignore T2'\n")],
    [
      'text in a block scalar',
      DEPLOY('  note: |\n    # tripcurve: ignore T2 reason="x" until=2027-01-31\n'),
    ],
    [
      'text in a plain scalar after a word',
      DEPLOY('  note: see # tripcurve: ignore\n'.replace(' # ', '#')),
    ],
    ['a comment that does not open with the marker', DEPLOY('  # please tripcurve: ignore T2\n')],
    ['another tool name', DEPLOY('  # tripcurvex: ignore T2\n')],
    ['the marker in capitals', DEPLOY('  # TRIPCURVE: ignore T2\n')],
  ])('%s is not an inline waiver', (_name, yaml) => {
    expect(records({ 'k8s/api.yaml': yaml })).toEqual([]);
  });

  it('a Terraform comment is read (`#` and `//`), raw; source code is not read for comments', () => {
    const r = records({
      'main.tf':
        '# tripcurve: ignore T4 reason="x" until=2027-01-31\nresource "aws_sqs_queue" "q" {} // tripcurve: ignore T4 reason="y" until=2027-02-01\n',
      'src/server.ts': '// tripcurve: ignore T1 reason="x" until=2027-01-31\n',
    });
    expect(r.map((x) => txt(x.rawText))).toEqual([
      '# tripcurve: ignore T4 reason="x" until=2027-01-31',
      '// tripcurve: ignore T4 reason="y" until=2027-02-01',
    ]);
    expect(r.map((x) => (x.source.type === 'file' ? x.source.line : 0))).toEqual([1, 2]);
  });

  it('a YAML file that does not parse still yields the comments that were read before the error', () => {
    const r = records({
      'k8s/api.yaml': `# tripcurve: ignore T2 reason="x" until=2027-01-31\napiVersion: v1\nkind: Pod\nmetadata: [unclosed\n`,
    });
    expect(r).toHaveLength(1);
  });
});

describe('hostile input', () => {
  const many = (n: number): string =>
    `${Array.from({ length: n }, (_, i) => `# tripcurve: ignore T${(i % 3) + 1} reason="r" until=2027-01-31`).join('\n')}\napiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n`;

  it('thousands of comments are all read, in linear time', {
    timeout: SCALING_TEST_TIMEOUT_MS,
  }, () => {
    expect(records({ 'k8s/p.yaml': many(5000) })).toHaveLength(5000);
    const ratio = scalingRatio((n) => {
      const t = makeTree();
      trees.push(t);
      t.write('k8s/p.yaml', many(n));
      readConfig(intake({ root: t.root }));
    }, 1000);
    expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
  });

  it('control characters and a huge comment are kept as input text, never executed or shown raw', () => {
    const evil = `# tripcurve: ignore T2 reason="\u001b[2J${'x'.repeat(100000)}"`;
    const r = records({ 'k8s/api.yaml': DEPLOY(`  ${evil}\n`) });
    expect(r).toHaveLength(1);
    expect(txt(r[0]?.rawText as never).length).toBe(evil.length);
  });
});
