// Bolt B22, two small gaps left by the second review of B21 (written first, seen red):
//   1. a manifest-shaped mapping whose `apiVersion` is not text (`{"apiVersion": 3, "kind": "Deployment"}`) was
//      listed or read depending on the kind and the form; every one with a text `kind` is now listed as
//      `object-not-identified`, in every form, plain YAML included, whatever the kind is. Only a `kind` that is not
//      text is ignored (the file is then not a manifest at all).
//   2. a root list whose elements hold no text `kind` was listed when it was alone in a file and ignored when it was
//      one document of a stream; both are listed now.
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { analyse } from '../../src/analyse.js';
import { intake } from '../../src/parse/index.js';
import { assembleReport } from '../../src/report/index.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

type Form = 'yaml' | 'quoted' | 'flow' | 'json';
const FORMS: readonly Form[] = ['yaml', 'quoted', 'flow', 'json'];

function write(form: Form, object: unknown): string {
  switch (form) {
    case 'yaml':
      return stringify(object);
    case 'quoted':
      return stringify(object, { defaultKeyType: 'QUOTE_DOUBLE' });
    case 'flow':
      return `${stringify(object, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n\s*/g, ' ')}\n`;
    case 'json':
      return `${JSON.stringify(object)}\n`;
  }
}

function unchecked(files: Record<string, string>): { read: number; reasons: string[] } {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const read = intake({ root: t.root });
  const report = assembleReport({ checked: '.', intake: read, analysis: analyse(read) });
  return { read: read.filesRead, reasons: report.unchecked.map((u) => u.reasonCode) };
}

describe('an object whose apiVersion is not text is listed, in every form and for every kind', () => {
  for (const api of [3, true, null, ['apps/v1']] as const) {
    for (const kind of ['Deployment', 'Service', 'ConfigMap']) {
      for (const named of [true, false]) {
        for (const form of FORMS) {
          it(`apiVersion ${JSON.stringify(api)}, ${kind}${named ? ' (named)' : ''}, as ${form}`, () => {
            const object = { apiVersion: api, kind, ...(named ? { metadata: { name: 'x' } } : {}) };
            const ext = form === 'json' ? 'json' : 'yaml';
            const got = unchecked({ [`k8s/a.${ext}`]: write(form, object) });
            expect(got.read).toBe(1);
            expect(got.reasons).toEqual(['object-not-identified']);
          });
        }
      }
    }
  }

  it('an object with a text apiVersion that is a kind nobody reads is still ignored without comment', () => {
    const got = unchecked({
      'k8s/a.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n',
    });
    expect(got.reasons).toEqual([]);
  });

  it('a `kind` that is not text is not a manifest: ignored, as before', () => {
    expect(unchecked({ 'k8s/a.json': '{"apiVersion": 3, "kind": 5}\n' }).reasons).toEqual([]);
    expect(unchecked({ 'k8s/a.yaml': 'apiVersion: 3\nkind: 5\n' }).reasons).toEqual([]);
  });

  it('an object of a stream and an item of a List are listed the same way', () => {
    const stream =
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n---\napiVersion: 3\nkind: Deployment\nmetadata:\n  name: d\n';
    expect(unchecked({ 'k8s/a.yaml': stream }).reasons).toEqual(['object-not-identified']);
    const list =
      'apiVersion: v1\nkind: List\nitems:\n  - {apiVersion: 3, kind: Service, metadata: {name: s}}\n';
    expect(unchecked({ 'k8s/a.yaml': list }).reasons).toEqual(['object-not-identified']);
  });
});

describe('a root list with no object of text kind is listed alone and inside a stream', () => {
  const list = [{ apiVersion: 'v1', kind: 5 }];
  const other = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n';
  for (const form of ['yaml', 'flow', 'json'] as const) {
    it(`alone, as ${form}`, () => {
      const ext = form === 'json' ? 'json' : 'yaml';
      expect(unchecked({ [`k8s/a.${ext}`]: write(form, list) }).reasons).toEqual([
        'object-not-identified',
      ]);
    });
  }
  it('after another document of the stream, the same list is listed too', () => {
    const body = stringify(list);
    expect(unchecked({ 'k8s/a.yaml': `${other}---\n${body}` }).reasons).toEqual([
      'object-not-identified',
    ]);
    expect(unchecked({ 'k8s/a.yaml': `${body}---\n${other}` }).reasons).toEqual([
      'object-not-identified',
    ]);
  });
  it('a nested list holding an object is listed alone and inside a stream (same rule)', () => {
    const nested = '- - {apiVersion: apps/v1, kind: Deployment}\n';
    expect(unchecked({ 'k8s/a.yaml': nested }).reasons).toEqual(['object-not-identified']);
    expect(unchecked({ 'k8s/a.yaml': `${other}---\n${nested}` }).reasons).toEqual([
      'object-not-identified',
    ]);
  });
  it('a plain data list of mappings in a stream is NOT listed', () => {
    expect(unchecked({ 'k8s/a.yaml': `${other}---\n- a: 1\n` }).reasons).toEqual([]);
    expect(unchecked({ 'k8s/a.yaml': `${other}---\n- - a: 1\n` }).reasons).toEqual([]);
  });
  it('a list of plain strings in a stream stays ignored (nothing in it is shaped like an object)', () => {
    expect(unchecked({ 'k8s/a.yaml': `${other}---\n- a\n- b\n` }).reasons).toEqual([]);
  });
});
