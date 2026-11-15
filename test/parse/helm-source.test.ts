// The Helm `# Source: <path>` comment of a rendered document: kept as input TEXT
// only, taken from the lines before a document's first content, never from its body.
import { describe, expect, it } from 'vitest';
import { intakeStreamBytes } from '../../src/parse/intake/index.js';
import { readKubernetes } from '../../src/parse/k8s/index.js';
import { txt } from '../support/render.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const POD = (name: string) =>
  `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\nspec:\n  containers: []\n`;
const sources = (text: string): Array<string | undefined> =>
  (intakeStreamBytes(bytes(text)).stream?.documents ?? []).map((d) =>
    d.helmSource === undefined ? undefined : txt(d.helmSource),
  );

describe('Helm source comments', () => {
  it('each document gets the comment written under its own ---', () => {
    expect(
      sources(
        `---\n# Source: chart/templates/a.yaml\n${POD('a')}---\n# Source: chart/templates/b.yaml\n${POD('b')}---\n${POD('c')}`,
      ),
    ).toEqual(['chart/templates/a.yaml', 'chart/templates/b.yaml', undefined]);
  });

  it("a comment before the first document with no --- is the first document's", () => {
    expect(sources(`# Source: first/a.yaml\n${POD('a')}`)).toEqual(['first/a.yaml']);
  });

  it('other comment lines are skipped, spacing is trimmed, and the first Source line wins', () => {
    expect(
      sources(`---\n# Chart: x\n#   Source:   a/b.yaml  \n# Source: later.yaml\n${POD('a')}`),
    ).toEqual(['a/b.yaml']);
  });

  it.each([
    ['one in the body', `${POD('a')}# Source: body.yaml\n`],
    ['an empty one', `---\n# Source:\n${POD('a')}`],
    ['another word', `---\n# Sources: x\n${POD('a')}`],
    ['not a comment', `---\nSource: x\n${POD('a')}`],
  ])('%s gives none', (_l, text) => {
    expect(sources(text)).toEqual([undefined]);
  });

  it('a comment written before a --- belongs to the document above it, never to the next one', () => {
    expect(sources(`---\n${POD('a')}# Source: belongs-to-nobody.yaml\n---\n${POD('b')}`)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('reaches the workload read from the document, and a List item inherits it', () => {
    const list = `---\n# Source: chart/list.yaml\napiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Pod\n    metadata: {name: p}\n    spec: {containers: []}\n`;
    const workloads = readKubernetes(intakeStreamBytes(bytes(list))).workloads;
    expect(workloads.map((w) => w.helmSource && txt(w.helmSource))).toEqual(['chart/list.yaml']);
  });

  it('hostile text is kept as text (no parsing, no truncation here)', () => {
    const evil = `x"\u001b[0m\n`;
    const got = sources(`---\n# Source: ${evil.trim()}\n${POD('a')}`);
    expect(got[0]).toBe('x"\u001b[0m');
  });

  it('a very large comment region is read in linear time (one scan of the text before the content)', () => {
    const big = `---\n${'# note\n'.repeat(200000)}# Source: deep.yaml\n${POD('a')}`;
    expect(sources(big)).toEqual(['deep.yaml']);
  });
});
