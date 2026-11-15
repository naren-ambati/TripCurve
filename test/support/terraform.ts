// Helpers for the Terraform tests: write files, run intake and the Terraform reader, and show what was read
// as short strings.
import { afterEach } from 'vitest';
import { isInputText } from '../../src/core/index.js';
import {
  type IacReadResult,
  intake,
  intakeStreamBytes,
  readIac,
  type TfAttr,
  type TfAttributeName,
  type TfResource,
} from '../../src/parse/index.js';
import { txt, where } from './render.js';
import { makeTree, type Tree } from './tmp-tree.js';

const trees: Tree[] = [];
export function registerTfCleanup(): void {
  afterEach(() => {
    for (const t of trees.splice(0)) t.cleanup();
  });
}

export function readTf(files: Record<string, string>): IacReadResult {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  return readIac(intake({ root: t.root }));
}

export function readTfStdin(text: string): IacReadResult {
  return readIac(intakeStreamBytes(new TextEncoder().encode(text)));
}

/** `literal 60 s @ main.tf:3`, `ref aws_sqs_queue.q @ main.tf:9`, `? reason`, or `absent`. */
export function show(resource: TfResource, name: TfAttributeName): string {
  const a: TfAttr | undefined = resource.attrs[name];
  if (resource.problem !== undefined) return `? ${resource.problem.reason}`;
  if (a === undefined) return 'absent';
  if (a.kind === 'literal') {
    const v = a.value.value;
    const unit = a.value.unit === 'none' ? '' : ` ${a.value.unit}`;
    // a number computed from literals (B17) shows the expression it came from, as input text
    const expression =
      a.value.expression === undefined ? '' : ` = ${JSON.stringify(txt(a.value.expression))}`;
    return `${isInputText(v) ? JSON.stringify(txt(v)) : String(v)}${unit}${expression} @ ${where(a.value.source)}`;
  }
  if (a.kind === 'reference') return `ref ${a.type}.${txt(a.name)} @ ${where(a.source)}`;
  return `? ${a.value.reason}`;
}

export function find(result: IacReadResult, type: string, name: string): TfResource {
  const r = result.resources.find((x) => x.type === type && txt(x.name) === name);
  if (r === undefined) throw new Error(`no ${type}.${name} was read`);
  return r;
}
