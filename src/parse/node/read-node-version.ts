// RuntimeVersionReader. Produces one
// version hint per evidence source and never chooses between them: the order
// (declaration, then image tag, then a linked Dockerfile) and the narrowing by
// `engines` are the resolver's. The linker decides which Dockerfile
// is linked and passes only that one.
//
// A tag gives an interval: `22.23.2` is exact, `22.23` is 22.23.x, `22` is
// 22.x, and `lts`, `current`, `latest` and a missing tag (which means latest) name no version, so
// they are all versions. Anything else is unknown with a fixed reason.
// Decisions:
// - A tag is `<version or lts|current|latest>` with at most one suffix from a written-out list
//   of the official image variants (`-alpine`, `-alpine<N>.<N>`, `-slim`, `-bookworm`,
//   `-bookworm-slim`, `-bullseye`, `-bullseye-slim`, `-trixie`, `-trixie-slim`). A variant names
//   the operating system of the image, not the Node version, so it does not change the interval.
//   Any other suffix is unknown: tripcurve does not guess what an unfamiliar word means.
// - A digest-only reference is unknown.
// - A tag written together with a digest (`node:22.23.2@sha256:...`) is
//   unknown: a container runtime pulls the digest, so the tag is only a label
//   and may name a different image.
// - `docker.io/library/node`, `index.docker.io/library/node` and
//   `library/node` count as the official image, like `node`.

import { ts } from 'ts-morph';
import {
  fileSource,
  type InputText,
  inputText,
  isInputText,
  type SourceRef,
} from '../../core/index.js';
import { parseRange, parseVersion, unknownInterval, type VersionInterval } from '../../kb/index.js';
import type { Declaration } from '../config/index.js';
import {
  type InputFile,
  rawInputTextForParser,
  rawTextForParser,
  type UncheckedInput,
} from '../intake/index.js';
import type { Maybe } from '../k8s/index.js';
import type { RuntimeVersionHint } from './model.js';

export const REASON_NOT_NODE_IMAGE = 'the image is not the official node image';
export const REASON_TAG_NOT_EXACT = 'the tag names no version in a form tripcurve reads';
export const REASON_DIGEST_ONLY = 'the image is named by a digest only';
export const REASON_PINNED_BY_DIGEST = 'image pinned by digest; the tag is only a label';
export const REASON_VARIABLE = 'the image or tag is built from a variable';
export const REASON_IMAGE_NOT_TEXT = 'the image is not written as text';
export const REASON_DECLARED_NOT_VERSION = 'the declared version is not a version number';
export const REASON_ENGINES_FORM = 'the engines range is not in a form tripcurve reads';
export const REASON_ENGINES_NOT_TEXT = 'engines.node is not text';

const OFFICIAL = new Set([
  'node',
  'library/node',
  'docker.io/library/node',
  'index.docker.io/library/node',
]);
/** A tag that pins nothing: it names the newest release of some kind, so every version is possible. */
const FLOATING_TAGS = new Set(['lts', 'current', 'latest']);
/** Parts without leading zeros (`22.023.2` is not a version tripcurve reads), each at most 15 digits. */
const VERSION_TAG = /^(?:0|[1-9]\d{0,14})(?:\.(?:0|[1-9]\d{0,14})){0,2}$/;
/**
 * The official image variants, written out: a tag is a version (or lts, current, latest) with at
 * most ONE of these suffixes. A variant names the operating system of the image, not the Node
 * version. Any other suffix, two suffixes and a repeated one are not read.
 */
const VARIANTS: ReadonlySet<string> = new Set([
  'alpine',
  'slim',
  'bookworm',
  'bookworm-slim',
  'bullseye',
  'bullseye-slim',
  'trixie',
  'trixie-slim',
]);
const ALPINE_RELEASE = /^alpine(?:0|[1-9]\d?)\.(?:0|[1-9]\d?)$/;

type Outcome = { interval: VersionInterval } | { unknownReason: string };

/** The version an image reference names, or why it names none. Total: never throws. */
export function interpretNodeImage(ref: string): Outcome {
  if (ref.includes('$')) return { unknownReason: REASON_VARIABLE };
  const at = ref.indexOf('@');
  const named = at < 0 ? ref : ref.slice(0, at);
  if (named === '') return { unknownReason: REASON_DIGEST_ONLY };
  const slash = named.lastIndexOf('/');
  const last = named.slice(slash + 1);
  const colon = last.indexOf(':');
  const repo = colon < 0 ? named : named.slice(0, slash + 1 + colon);
  if (!OFFICIAL.has(repo)) return { unknownReason: REASON_NOT_NODE_IMAGE };
  // No tag means latest: the newest release, so no version is pinned.
  if (colon < 0)
    return at < 0 ? { interval: unknownInterval() } : { unknownReason: REASON_DIGEST_ONLY };
  if (at >= 0) return { unknownReason: REASON_PINNED_BY_DIGEST };
  const tag = last.slice(colon + 1);
  const dash = tag.indexOf('-');
  const head = dash < 0 ? tag : tag.slice(0, dash);
  const suffix = dash < 0 ? undefined : tag.slice(dash + 1);
  if (suffix !== undefined && !VARIANTS.has(suffix) && !ALPINE_RELEASE.test(suffix)) {
    return { unknownReason: REASON_TAG_NOT_EXACT };
  }
  if (FLOATING_TAGS.has(head)) return { interval: unknownInterval() };
  if (!VERSION_TAG.test(head)) return { unknownReason: REASON_TAG_NOT_EXACT };
  return { interval: parseVersion(head) };
}

function hint(
  sourceKind: RuntimeVersionHint['sourceKind'],
  outcome: Outcome,
  sourceRef: SourceRef,
  text: InputText | undefined,
): RuntimeVersionHint {
  return {
    runtime: 'node',
    sourceKind,
    ...outcome,
    ...(text === undefined ? {} : { text }),
    sourceRef,
  };
}

/** A `runtime.node` declaration from tripcurve.yaml: it is the version. */
export function hintFromDeclaration(declaration: Declaration): RuntimeVersionHint {
  const v = declaration.value;
  const text = isInputText(v.value) ? v.value : undefined;
  const parsed = text === undefined ? undefined : parseVersion(rawInputTextForParser(text));
  // parseVersion answers "all versions" for text that is not a version; a declaration
  // that names no version is not evidence of one.
  const known =
    parsed !== undefined &&
    !(
      parsed.upper === null &&
      parsed.lower.major === 0 &&
      parsed.lower.minor === 0 &&
      parsed.lower.patch === 0
    );
  const outcome: Outcome = known
    ? { interval: parsed }
    : { unknownReason: REASON_DECLARED_NOT_VERSION };
  return hint('declaration', outcome, v.source, text);
}

/** The container's image, when it is the official node image (any other image is "not node"). */
export function hintFromImage(
  image: Maybe | undefined,
  containerSource: SourceRef,
): RuntimeVersionHint {
  if (image === undefined || 'unresolved' in image || !isInputText(image.value)) {
    return hint(
      'image-tag',
      { unknownReason: REASON_IMAGE_NOT_TEXT },
      image && !('unresolved' in image) ? image.source : containerSource,
      undefined,
    );
  }
  return hint(
    'image-tag',
    interpretNodeImage(rawInputTextForParser(image.value)),
    image.source,
    image.value,
  );
}

// ---------------------------------------------------------------- Dockerfile

interface Instruction {
  readonly word: string;
  readonly rest: string;
  readonly line: number;
}

/** Logical instructions: comments dropped, `\` continuations joined; each with its first line. */
function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split(/\r?\n/);
  let pending: { text: string; line: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('#') || (trimmed === '' && pending === undefined)) continue;
    if (trimmed === '') continue;
    const joined = pending === undefined ? trimmed : `${pending.text} ${trimmed}`;
    const line = pending === undefined ? i + 1 : pending.line;
    if (joined.endsWith('\\')) {
      pending = { text: joined.slice(0, -1).trimEnd(), line };
      continue;
    }
    pending = undefined;
    const space = joined.search(/\s/);
    out.push({
      word: (space < 0 ? joined : joined.slice(0, space)).toUpperCase(),
      rest: space < 0 ? '' : joined.slice(space).trim(),
      line,
    });
  }
  if (pending !== undefined) {
    const space = pending.text.search(/\s/);
    out.push({
      word: (space < 0 ? pending.text : pending.text.slice(0, space)).toUpperCase(),
      rest: space < 0 ? '' : pending.text.slice(space).trim(),
      line: pending.line,
    });
  }
  return out;
}

interface Stage {
  readonly image: string;
  readonly name: string | undefined;
  readonly line: number;
}

function stages(text: string): Stage[] {
  const out: Stage[] = [];
  for (const ins of instructions(text)) {
    if (ins.word !== 'FROM') continue;
    const parts = ins.rest.split(/\s+/).filter((p) => p !== '' && !p.startsWith('--'));
    const image = parts[0];
    if (image === undefined) continue;
    const as = parts[1]?.toUpperCase() === 'AS' ? parts[2] : undefined;
    out.push({ image, name: as?.toLowerCase(), line: ins.line });
  }
  return out;
}

/**
 * The `FROM` of the last stage of a linked Dockerfile (the image the program
 * runs in), following `FROM <earlier stage>` back to an image. Undefined when
 * the file has no `FROM`.
 */
export function hintFromDockerfile(file: InputFile): RuntimeVersionHint | undefined {
  const all = stages(rawTextForParser(file));
  const last = all[all.length - 1];
  if (last === undefined) return undefined;
  let current: Stage = last;
  // `FROM <earlier stage>`: follow back to an image; each hop goes to a strictly earlier stage.
  for (let position = all.length - 1; position > 0; position -= 1) {
    const ref = current.image.toLowerCase();
    let next = -1;
    for (let i = 0; i < position; i += 1) if (all[i]?.name === ref) next = i;
    const earlier = next >= 0 ? all[next] : undefined;
    if (earlier === undefined) break;
    current = earlier;
    position = next + 1;
  }
  return hint(
    'linked-dockerfile',
    interpretNodeImage(current.image),
    fileSource(file.canonicalPath, current.line),
    inputText(current.image),
  );
}

// ---------------------------------------------------------------- package.json

export interface EnginesReading {
  readonly hint?: RuntimeVersionHint;
  readonly unchecked?: UncheckedInput;
}

function lineOfEnginesNode(text: string): number | undefined {
  const sf = ts.parseJsonText('package.json', text);
  const root = sf.statements[0]?.expression;
  if (root === undefined || !ts.isObjectLiteralExpression(root)) return undefined;
  const pick = (obj: ts.ObjectLiteralExpression, key: string) => {
    let found: ts.PropertyAssignment | undefined;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && p.name.text === key)
        found = p;
    }
    return found;
  };
  const engines = pick(root, 'engines');
  if (engines === undefined || !ts.isObjectLiteralExpression(engines.initializer)) return undefined;
  const node = pick(engines.initializer, 'node');
  if (node === undefined) return undefined;
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * `engines.node` of a package.json (it only narrows: the hint carries the
 * interval the range allows, or none when the range is not in the form tripcurve
 * reads). Never throws: a file that is not JSON is `parse-error`; one nested
 * deeper than the stack allows is `over-depth`.
 */
export function readPackageEngines(file: InputFile): EnginesReading {
  const text = rawTextForParser(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reasonCode = error instanceof RangeError ? 'over-depth' : 'parse-error';
    return { unchecked: { path: file.canonicalPath, reasonCode } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const enginesValue = Object.hasOwn(parsed, 'engines')
    ? (parsed as Record<string, unknown>).engines
    : undefined;
  if (typeof enginesValue !== 'object' || enginesValue === null || Array.isArray(enginesValue)) {
    return {};
  }
  if (!Object.hasOwn(enginesValue, 'node')) return {};
  const nodeValue = (enginesValue as Record<string, unknown>).node;
  let line: number;
  try {
    line = lineOfEnginesNode(text) ?? 1;
  } catch (error) {
    const reasonCode = error instanceof RangeError ? 'over-depth' : 'parse-error';
    return { unchecked: { path: file.canonicalPath, reasonCode } };
  }
  const source = fileSource(file.canonicalPath, line);
  if (typeof nodeValue !== 'string') {
    return { hint: hint('engines', { unknownReason: REASON_ENGINES_NOT_TEXT }, source, undefined) };
  }
  const interval = parseRange(nodeValue.trim());
  const outcome: Outcome =
    interval === undefined ? { unknownReason: REASON_ENGINES_FORM } : { interval };
  return { hint: hint('engines', outcome, source, inputText(nodeValue)) };
}
