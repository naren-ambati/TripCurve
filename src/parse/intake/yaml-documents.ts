// YAML text to bounded documents, at the file boundary.
//
// What happens here, and nowhere later:
// - alias expansion is bounded by the explicit `maxAliasCount` (never -1);
// - a stack overflow, in the yaml library (it reports it as RESOURCE_EXHAUSTION)
//   or in our own walk (RangeError), is "too deeply nested";
// - Secret `data` and `stringData` are removed before any reader sees them,
//   from the syntax tree first and from the plain value again (a merge key can
//   bring them in from another mapping);
// - a document that fails makes at most ONE unchecked record per file, and the
//   documents that parsed are still handed on (one bad document never hides
//   the rest). The parser's own message is never kept, only a code and a line.

import {
  Composer,
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  Pair,
  Parser,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from 'yaml';
import { type InputText, inputText, type SourceRef } from '../../core/index.js';
import type { IntakeDocument, IntakeLimits, UncheckedReason } from './types.js';

export interface YamlIssue {
  readonly reasonCode: UncheckedReason;
  readonly line?: number;
}

export interface ParsedYaml {
  readonly documents: readonly IntakeDocument[];
  readonly issue?: YamlIssue;
  /**
   * Real YAML comments (not text inside a scalar) that start `# tripcurve:`: the raw text of an
   * inline waiver, with its line. Read here because the tokenizer is what tells a comment
   * from a string; nothing is validated, that is the waiver reader's work (bolt B6).
   */
  readonly waiverComments: readonly InlineComment[];
}

export interface InlineComment {
  /** 1-based line in the file. */
  readonly line: number;
  /** The comment as written, from its `#` to the end of the line. */
  readonly text: InputText;
}

const WAIVER_COMMENT = /^#[ \t]*tripcurve:/;

/**
 * Passes the parser's tokens on unchanged and collects the comment tokens that open an inline
 * waiver. Iterative: the token tree can be as deep as the input says. Linear in the tokens.
 */
function* collectingComments(
  tokens: Iterable<unknown>,
  found: (offset: number, text: string) => void,
): Generator<never> {
  for (const token of tokens) {
    const stack: unknown[] = [token];
    while (stack.length > 0) {
      const item = stack.pop();
      if (typeof item !== 'object' || item === null) continue;
      if (Array.isArray(item)) {
        for (const x of item) stack.push(x);
        continue;
      }
      const t = item as { type?: unknown; source?: unknown; offset?: unknown };
      if (t.type === 'comment' && typeof t.source === 'string' && typeof t.offset === 'number') {
        if (WAIVER_COMMENT.test(t.source)) found(t.offset, t.source);
        continue;
      }
      for (const value of Object.values(item)) {
        if (typeof value === 'object' && value !== null) stack.push(value);
      }
    }
    yield token as never;
  }
}

type PathKey = string | number;

// A Secret is reduced to what identifies it: apiVersion, kind and metadata.name
// and metadata.namespace. Everything else is dropped, not just `data` and
// `stringData`: an anchor or a spare key could carry the same values, and the
// last-applied-configuration annotation holds a copy of them.
const SECRET_KEEP = ['apiVersion', 'kind', 'metadata'] as const;
const SECRET_METADATA_KEEP = ['name', 'namespace'] as const;

const CFN_SHORT_FORMS: Readonly<Record<string, string>> = {
  '!Ref': 'Ref',
  '!Condition': 'Condition',
};

/** The long form key of a tag: `!Ref` is `Ref`, `!GetAtt` is `Fn::GetAtt`, any other tag (known or not) is `Fn::<tag>`. */
function longFormKey(tag: string): string {
  const known = CFN_SHORT_FORMS[tag];
  if (known !== undefined) return known;
  return `Fn::${tag.startsWith('!') ? tag.slice(1) : tag}`;
}

/**
 * CloudFormation templates (bolt B12): a YAML short-form tag (`!Ref`, `!Sub`, `!If`, an unknown `!Bogus`)
 * is rewritten in the syntax tree into its long form, a one-key mapping (`{Ref: x}`, `{Fn::Sub: x}`), so a
 * tagged value never reads as a plain literal (the yaml library otherwise drops the tag of an unknown tag
 * and hands over the bare value, `!Bogus 30` as "30"). Nothing is run. Returns true for a document that
 * uses a form tripcurve does not read at all: an alias or a merge key (anchors change which value is
 * where), a collection used as a key, or a key that carries a tag (it could rename the key `Timeout`).
 * Iterative, so a deep document cannot overflow the stack here.
 */
function rewriteCfnTags(doc: Document): boolean {
  let unsafe = false;
  const wrap = (node: unknown): unknown => {
    if (!isNode(node)) return node;
    const tag = (node as { tag?: string }).tag;
    if (tag === undefined) return node;
    (node as { tag?: string }).tag = undefined;
    let inner: unknown = node;
    if (tag === '!GetAtt' && isScalar(node) && typeof node.value === 'string') {
      const dot = node.value.indexOf('.');
      if (dot > 0) {
        const seq = new YAMLSeq();
        seq.items.push(new Scalar(node.value.slice(0, dot)), new Scalar(node.value.slice(dot + 1)));
        seq.range = node.range;
        inner = seq;
      }
    }
    const map = new YAMLMap();
    map.items.push(new Pair(new Scalar(longFormKey(tag)), inner));
    map.range = node.range;
    return map;
  };
  const stack: unknown[] = [];
  const root = doc.contents;
  if (root !== null && isNode(root)) {
    if (isAlias(root)) return true;
    const rewritten = wrap(root);
    doc.contents = rewritten as typeof doc.contents;
    stack.push(rewritten);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (
          !isScalar(key) ||
          key.tag !== undefined ||
          typeof key.value === 'symbol' ||
          key.value === '<<'
        ) {
          unsafe = true;
        }
        const value = pair.value;
        if (isAlias(value)) unsafe = true;
        else if (isNode(value)) {
          pair.value = wrap(value) as typeof pair.value;
          stack.push(pair.value);
        }
      }
    } else if (isSeq(node)) {
      for (let i = 0; i < node.items.length; i += 1) {
        const item = node.items[i];
        if (isAlias(item)) unsafe = true;
        else if (isNode(item)) {
          node.items[i] = wrap(item) as typeof item;
          stack.push(node.items[i]);
        }
      }
    }
  }
  return unsafe;
}

function nodeString(node: unknown, doc: Document): string | undefined {
  let n = node;
  if (isAlias(n)) n = n.resolve(doc);
  return isScalar(n) && typeof n.value === 'string' ? n.value : undefined;
}

function reduceSecretNode(map: YAMLMap, doc: Document): void {
  for (const pair of [...map.items]) {
    const key = nodeString(pair.key, doc);
    if (key === undefined || !(SECRET_KEEP as readonly string[]).includes(key)) {
      map.items.splice(map.items.indexOf(pair), 1);
    }
  }
  let meta: unknown = map.get('metadata', true);
  if (isAlias(meta)) meta = meta.resolve(doc);
  if (isMap(meta)) {
    for (const pair of [...meta.items]) {
      const key = nodeString(pair.key, doc);
      if (key === undefined || !(SECRET_METADATA_KEEP as readonly string[]).includes(key)) {
        meta.items.splice(meta.items.indexOf(pair), 1);
      }
    }
  }
}

// A Secret object, or a list of them. The list's own kind may be `SecretList`,
// in which case its items need not say `kind` themselves.
function scrubSecretsInTree(doc: Document): void {
  const root = doc.contents;
  if (!isMap(root)) return;
  const kind = nodeString(root.get('kind', true), doc);
  if (kind === 'Secret') {
    reduceSecretNode(root, doc);
    return;
  }
  if (kind?.endsWith('List')) {
    const raw: unknown = root.get('items', true);
    const items = isAlias(raw) ? raw.resolve(doc) : raw;
    if (!isSeq(items)) return;
    for (const item of items.items) {
      const resolved = isAlias(item) ? item.resolve(doc) : item;
      if (!isMap(resolved)) continue;
      if (kind === 'SecretList' || nodeString(resolved.get('kind', true), doc) === 'Secret') {
        reduceSecretNode(resolved, doc);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Same reduction on the plain value: a merge key can bring fields in that the
// tree pass above did not see as the Secret's own.
function reduceSecretValue(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!(SECRET_KEEP as readonly string[]).includes(key)) delete value[key];
  }
  const meta = Object.hasOwn(value, 'metadata') ? value.metadata : undefined;
  if (isRecord(meta)) {
    for (const key of Object.keys(meta)) {
      if (!(SECRET_METADATA_KEEP as readonly string[]).includes(key)) delete meta[key];
    }
  }
}

function scrubSecretsInValue(value: unknown): void {
  if (!isRecord(value)) return;
  const kind = Object.hasOwn(value, 'kind') ? value.kind : undefined;
  if (kind === 'Secret') {
    reduceSecretValue(value);
    return;
  }
  if (typeof kind === 'string' && kind.endsWith('List')) {
    const items = Object.hasOwn(value, 'items') ? value.items : undefined;
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (kind === 'SecretList' || (Object.hasOwn(item, 'kind') && item.kind === 'Secret')) {
        reduceSecretValue(item);
      }
    }
  }
}

/**
 * The offset of the second occurrence of a key, in any mapping of the document,
 * or undefined. The yaml library checks this itself, but its check compares each
 * key with every key before it (quadratic: 30,000 keys took 6.9 s, 60,000 took
 * 25.7 s, measured 2026-11-11), so it is switched off (`uniqueKeys: false`) and
 * done here with one Set per mapping. Same rule as the library's: two scalar
 * keys with the same value are duplicates (a number and a string are not, and
 * NaN is never equal to itself); a collection or alias key never is. The walk
 * is iterative, so a deep document cannot overflow the stack here.
 */
function firstDuplicateKeyOffset(doc: Document): number | undefined {
  let earliest: number | undefined;
  const stack: unknown[] = [doc.contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isMap(node)) {
      const seen = new Set<unknown>();
      for (const pair of node.items) {
        const key = pair.key;
        if (isScalar(key)) {
          const value = key.value;
          const isNaNKey = typeof value === 'number' && Number.isNaN(value);
          if (!isNaNKey) {
            if (seen.has(value)) {
              const offset = key.range?.[0];
              if (offset !== undefined && (earliest === undefined || offset < earliest)) {
                earliest = offset;
              }
            } else {
              seen.add(value);
            }
          }
        }
        stack.push(pair.key, pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
  return earliest;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Parses `text` (already decoded) into documents under the limits.
 * `makeSource` builds the provenance for a (document index, line) pair, for a
 * file or for the standard-input stream.
 */
export interface ParseOptions {
  /** A CloudFormation or SAM template: short-form tags become long form, and aliases are refused (bolt B12). */
  readonly cfn?: boolean;
}

export function parseYamlDocuments(
  text: string,
  limits: IntakeLimits,
  makeSource: (documentIndex: number, line: number) => SourceRef,
  options: ParseOptions = {},
): ParsedYaml {
  const lineCounter = new LineCounter();
  const parser = new Parser(lineCounter.addNewLine);
  // `uniqueKeys: false`: duplicates are found by `firstDuplicateKeyOffset` (the
  // library's check is quadratic). `logLevel: 'silent'`: the library prints its own
  // warnings to stderr (for example for a collection used as a key); tripcurve's
  // output is its own and input text never reaches it that way.
  const composer = new Composer({
    lineCounter,
    merge: true,
    uniqueKeys: false,
    logLevel: 'silent',
  });
  const documents: IntakeDocument[] = [];
  const waiverComments: InlineComment[] = [];
  let issue: YamlIssue | undefined;
  const note = (found: YamlIssue): void => {
    issue ??= found;
  };
  const lineAt = (offset: number): number => lineCounter.linePos(offset).line;

  try {
    let index = 0;
    let previousEnd = 0;
    // The end of the previous document including its trailing comments: where the next block starts.
    let previousFullEnd: number | undefined;
    const tokens = collectingComments(parser.parse(text), (offset, source) => {
      waiverComments.push({
        line: lineCounter.linePos(offset).line,
        text: inputText(source.replace(/[\r\n].*$/s, '')),
      });
    });
    for (const doc of composer.compose(tokens as never)) {
      index += 1;
      const regionStart = previousEnd;
      previousEnd = doc.range?.[1] ?? previousEnd;
      const blockStartOffset = previousFullEnd;
      previousFullEnd = doc.range?.[2] ?? previousFullEnd;
      const exhausted = doc.errors.find((e) => errorCodeOf(e) === 'RESOURCE_EXHAUSTION');
      if (exhausted !== undefined) {
        note({ reasonCode: 'over-depth' });
        continue;
      }
      const firstError = doc.errors[0];
      const duplicateAt = firstDuplicateKeyOffset(doc);
      if (firstError !== undefined || duplicateAt !== undefined) {
        const errorAt = firstError?.pos?.[0];
        const offset =
          errorAt === undefined || (duplicateAt !== undefined && duplicateAt < errorAt)
            ? (duplicateAt ?? errorAt)
            : errorAt;
        note(
          typeof offset === 'number'
            ? { reasonCode: 'parse-error', line: lineAt(offset) }
            : { reasonCode: 'parse-error' },
        );
        continue;
      }
      if (options.cfn === true && rewriteCfnTags(doc)) {
        note({ reasonCode: 'cfn-unreadable', line: lineAt(doc.range?.[0] ?? 0) });
        continue;
      }
      scrubSecretsInTree(doc);
      let value: unknown;
      try {
        // maxAliasCount is explicit: the library default could change, and -1 turns it off.
        value = doc.toJS({ maxAliasCount: limits.maxAliasCount });
      } catch (error) {
        if (error instanceof RangeError) {
          note({ reasonCode: 'over-depth' });
        } else if (error instanceof ReferenceError && error.message.includes('Excessive alias')) {
          // The message is read here only to tell the one limit error from the
          // others (an alias with no anchor); it is never kept or shown.
          note({ reasonCode: 'alias-limit' });
        } else {
          note({ reasonCode: 'parse-error', line: lineAt(doc.range?.[0] ?? 0) });
        }
        continue;
      }
      scrubSecretsInValue(value);
      documents.push(
        makeDocument(doc, index, value, lineAt, text, makeSource, regionStart, {
          first: blockStartOffset === undefined ? 1 : lineAt(blockStartOffset),
          lastOffset: doc.range?.[2],
          lineCol: (offset: number) => lineCounter.linePos(offset),
        }),
      );
    }
  } catch (error) {
    // Stack overflow outside the library's own guard, or a defect in it: the
    // file stops here, the documents before it are kept.
    note({ reasonCode: error instanceof RangeError ? 'over-depth' : 'parse-error' });
  }
  waiverComments.sort((a, b) => a.line - b.line);
  return issue === undefined ? { documents, waiverComments } : { documents, issue, waiverComments };
}

// One key index per mapping, built the first time a path lookup passes through it.
const keyIndexes = new WeakMap<object, Map<unknown, unknown>>();

const HELM_SOURCE_LINE = /^[ \t]*#[ \t]*Source:[ \t]*(.*?)[ \t]*$/;

/**
 * The text of a Helm `# Source: <path>` comment written before the first content of a
 * document (after its `---`), or undefined. `helm template` writes one before every
 * rendered object. It is only ever input TEXT, shown after a fixed label and never as a
 * source; a comment inside the document body is not looked at.
 */
function helmSourceOf(text: string, from: number, to: number | undefined): InputText | undefined {
  if (to === undefined || to <= from) return undefined;
  let found: string | undefined;
  for (const line of text.slice(from, to).split(/\r\n|\r|\n/)) {
    // a comment belongs to the document whose `---` it follows, not to the one before it
    if (/^---(?:[ \t]|$)/.test(line)) {
      found = undefined;
      continue;
    }
    if (found !== undefined) continue;
    const match = HELM_SOURCE_LINE.exec(line);
    if (match !== null && match[1] !== '') found = match[1] as string;
  }
  return found === undefined ? undefined : inputText(found);
}

function makeDocument(
  doc: Document,
  index: number,
  value: unknown,
  lineAt: (offset: number) => number,
  text: string,
  makeSource: (documentIndex: number, line: number) => SourceRef,
  regionStart: number,
  block: {
    readonly first: number;
    readonly lastOffset: number | undefined;
    readonly lineCol: (offset: number) => { line: number; col: number };
  },
): IntakeDocument {
  const startLine = lineAt(doc.range?.[0] ?? 0);
  // The lines this document owns, trailing comments included: from the end of the previous
  // document (or the file start) to the line before the next `---` (or the last line).
  const endAt = block.lastOffset === undefined ? undefined : block.lineCol(block.lastOffset);
  const blockLast =
    endAt === undefined
      ? startLine
      : Math.max(block.first, endAt.col === 1 && endAt.line > 1 ? endAt.line - 1 : endAt.line);
  const helmSource = helmSourceOf(text, regionStart, doc.contents?.range?.[0] ?? doc.range?.[0]);

  // The deepest node that can be found along the path; `exact` says whether it is the node asked for. One walk
  // from the root, with a key index per mapping built on first use: `doc.getIn` scans the keys of a mapping
  // for every step, so a mapping of tens of thousands of keys (a template with that many resources) would make
  // every lookup linear and the whole read quadratic (bolt B12). Same answer as `getIn`: a scalar key is
  // matched by strict equality, the first of equal keys wins, a sequence takes an integer index, and a step
  // through anything that is not a collection ends the walk.
  const find = (path: readonly PathKey[]) => {
    let best: { node: Node; depth: number } | undefined;
    let node: unknown = doc.contents;
    if (isNode(node) && node.range) best = { node, depth: 0 };
    for (let k = 0; k < path.length; k += 1) {
      const step = path[k] as PathKey;
      let next: unknown;
      if (isMap(node)) {
        let index = keyIndexes.get(node);
        if (index === undefined) {
          index = new Map();
          for (const pair of node.items) {
            if (isScalar(pair.key) && !index.has(pair.key.value))
              index.set(pair.key.value, pair.value);
          }
          keyIndexes.set(node, index);
        }
        next = index.get(step);
      } else if (isSeq(node)) {
        let i: unknown = step;
        if (i && typeof i === 'string') i = Number(i);
        next = typeof i === 'number' && Number.isInteger(i) && i >= 0 ? node.items[i] : undefined;
      } else break;
      if (!isNode(next)) break;
      node = next;
      if (next.range) best = { node: next, depth: k + 1 };
    }
    return best === undefined ? undefined : { node: best.node, exact: best.depth === path.length };
  };

  return Object.freeze({
    index,
    startLine,
    blockFirstLine: block.first,
    blockLastLine: blockLast,
    value,
    ...(helmSource === undefined ? {} : { helmSource }),
    sourceAt(path: readonly PathKey[]): SourceRef {
      const found = find(path);
      const offset = found?.node.range?.[0];
      return makeSource(index, offset === undefined ? startLine : lineAt(offset));
    },
    keySourceAt(path: readonly PathKey[]): SourceRef {
      const last = path[path.length - 1];
      const parent = path.length === 0 ? undefined : find(path.slice(0, -1));
      if (parent?.exact && isMap(parent.node) && typeof last === 'string') {
        for (const pair of parent.node.items) {
          if (isScalar(pair.key) && pair.key.value === last && pair.key.range) {
            return makeSource(index, lineAt(pair.key.range[0]));
          }
        }
      }
      // not a key we can find (it came in through a merge): the nearest node, as sourceAt does
      const found = find(path);
      const offset = found?.node.range?.[0];
      return makeSource(index, offset === undefined ? startLine : lineAt(offset));
    },
    sourceTextAt(path: readonly PathKey[]): InputText | undefined {
      const found = find(path);
      const range = found?.node.range;
      if (found === undefined || !found.exact || range === undefined || range === null) {
        return undefined;
      }
      return inputText(text.slice(range[0], range[1]));
    },
  });
}
