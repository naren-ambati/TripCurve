// The lines an object owns, for inline waivers: a YAML document owns every
// line from the end of the document above it (or the file start) to the line before the next `---`;
// a Terraform resource owns its lines from its header to its closing brace.
import { afterEach, describe, expect, it } from 'vitest';
import { intake, readIac } from '../../src/parse/index.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function docs(text: string) {
  const t = makeTree();
  trees.push(t);
  t.write('k8s/x.yaml', text);
  const file = intake({ root: t.root }).files.find((f) => f.documents !== undefined);
  return (file?.documents ?? []).map((d) => [d.blockFirstLine, d.blockLastLine]);
}

// each document is two lines: `apiVersion: v1` and `kind: Service`
const D = 'apiVersion: v1\nkind: Service\n';

describe('YAML documents', () => {
  it('one document owns the whole file, comments before and after its content included', () => {
    expect(docs(`# above\n${D}# below\n`)).toEqual([[1, 4]]);
  });

  it('a file with no trailing newline ends on its last line', () => {
    expect(docs('apiVersion: v1\nkind: Service')).toEqual([[1, 2]]);
  });

  it('a --- starts the next document on its own line; the comment above it belongs to the document above', () => {
    expect(docs(`${D}# end of a\n---\n# start of b\n${D}`)).toEqual([
      [1, 3],
      [4, 7],
    ]);
  });

  it('three documents split at their separators', () => {
    expect(docs(`${D}---\n${D}x: 1\n---\n${D}`)).toEqual([
      [1, 2],
      [3, 6],
      [7, 9],
    ]);
  });

  it('a document that did not parse leaves its lines to no document', () => {
    expect(docs(`${D}---\nkey: [unclosed\n# c\n---\n${D}`)).toEqual([
      [1, 2],
      [6, 8],
    ]);
  });

  it('Windows line ends give the same lines', () => {
    expect(docs(`${D}---\n${D}`.replaceAll('\n', '\r\n'))).toEqual([
      [1, 2],
      [3, 5],
    ]);
  });
});

describe('Terraform resources', () => {
  function resources(text: string) {
    const t = makeTree();
    trees.push(t);
    t.write('infra/q.tf', text);
    return readIac(intake({ root: t.root })).resources.map((r) => [
      r.source.type === 'file' ? r.source.line : 0,
      r.endLine,
    ]);
  }

  it('a block runs from its header line to its closing brace', () => {
    expect(
      resources(
        'resource "aws_sqs_queue" "a" {\n  visibility_timeout_seconds = 30\n}\n\nresource "aws_lambda_function" "f" {\n  timeout = 10\n  tags = {\n    a = "b"\n  }\n}\n',
      ),
    ).toEqual([
      [1, 3],
      [5, 10],
    ]);
  });

  it('a one-line block starts and ends on one line', () => {
    expect(resources('resource "aws_sqs_queue" "a" {}\n')).toEqual([[1, 1]]);
  });
});
