// Terraform JSON: `*.tf.json` (the JSON syntax of Terraform source) and the output of
// `terraform show -json` (a plan or a state), as a file or on standard input. The same eight attributes
// are read, as literals.
//
//  - `*.tf.json`: `resource.<type>.<name>` bodies are read like HCL bodies (absence of an attribute is
//    absence; count, for_each, dynamic and a lifecycle other than create_before_destroy and
//    prevent_destroy make the block unresolved). A reference is the string `"${type.name.attr}"` and
//    nothing else.
//  - `terraform show -json`: numbers and names are read from the plan's `planned_values` (or the state's
//    `values`), where Terraform has already applied defaults; an attribute that is missing there is
//    unresolved, never a default. References come only from `configuration`, and only as the exact
//    `references` list of one attribute (`aws_sqs_queue.q.arn` and `aws_sqs_queue.q`). Resources in child
//    modules are not read. A state holds no `configuration`, so its mappings are not linked.
// Lines come from the intake document, which holds the position of every value.

import {
  fileSource,
  type InputText,
  inputText,
  makeSourcedValue,
  makeUnresolved,
  type SourceRef,
  stdinSource,
} from '../../core/index.js';
import type { IntakeDocument } from '../intake/index.js';
import {
  problemOf,
  TF_ATTRIBUTES,
  TF_INT_RANGES,
  TF_PROBLEMS,
  TF_REFERENCES,
  type TfAttr,
  type TfAttributeName,
  type TfResource,
  type TfType,
  tfTypeFromInput,
} from './model.js';

type Path = readonly (string | number)[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The entries of an object, or of an array of objects (the JSON syntax allows both), with their paths. */
function entries(value: unknown, path: Path): { key: string; value: unknown; path: Path }[] {
  const out: { key: string; value: unknown; path: Path }[] = [];
  const objects: { o: Record<string, unknown>; p: Path }[] = [];
  if (isRecord(value)) objects.push({ o: value, p: path });
  else if (Array.isArray(value)) {
    value.forEach((o, i) => {
      if (isRecord(o)) objects.push({ o, p: [...path, i] });
    });
  }
  for (const { o, p } of objects) {
    for (const key of Object.keys(o)) out.push({ key, value: o[key], path: [...p, key] });
  }
  return out;
}

export interface JsonOrigin {
  readonly document: IntakeDocument;
  readonly file: InputText | undefined;
  /** For a stream: the 1-based number of the document. */
  readonly streamIndex: number | undefined;
  readonly scope: string;
  readonly dir: string;
}

function sourceOf(origin: JsonOrigin, path: Path): SourceRef {
  const at = origin.document.sourceAt(path);
  if (at.type === 'file' || at.type === 'stdin') return at;
  return origin.file !== undefined
    ? fileSource(origin.file, 1)
    : stdinSource(origin.streamIndex ?? 1, 1);
}

function unresolvedAttr(key: string, why: string, source: SourceRef): TfAttr {
  return { kind: 'unresolved', value: makeUnresolved(`${key} ${why}`), source };
}

function intAttr(key: string, raw: unknown, source: SourceRef): TfAttr {
  const range = TF_INT_RANGES[key] as { min: number; max: number };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return unresolvedAttr(
      key,
      raw === null || raw === undefined ? TF_PROBLEMS.notInPlan : TF_PROBLEMS.notInteger,
      source,
    );
  }
  if (raw < range.min || raw > range.max) {
    return unresolvedAttr(
      key,
      `is outside the documented range ${range.min} to ${range.max} s`,
      source,
    );
  }
  return {
    kind: 'literal',
    value: makeSourcedValue({ value: raw, unit: 's', source, basis: 'declared' }),
  };
}

function stringAttr(key: string, raw: unknown, source: SourceRef): TfAttr {
  if (typeof raw !== 'string' || /[\\$%]/.test(raw)) {
    return unresolvedAttr(key, TF_PROBLEMS.notString, source);
  }
  return {
    kind: 'literal',
    value: makeSourcedValue({ value: inputText(raw), unit: 'none', source, basis: 'declared' }),
  };
}

const INTERPOLATION =
  /^\$\{([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)\}$/;

function referenceAttr(
  key: string,
  type: string,
  name: string,
  attribute: string,
  source: SourceRef,
): TfAttr {
  const ref = TF_REFERENCES[key] as { type: TfType; attributes: readonly string[] };
  if (type !== ref.type || !ref.attributes.includes(attribute)) {
    return unresolvedAttr(key, `${TF_PROBLEMS.notReference}: it does not name ${ref.type}`, source);
  }
  return { kind: 'reference', type: ref.type, name: inputText(name), source };
}

function attrFromSyntax(key: string, raw: unknown, source: SourceRef): TfAttr {
  if (key in TF_INT_RANGES) return intAttr(key, raw, source);
  if (key in TF_REFERENCES) {
    const m = typeof raw === 'string' ? INTERPOLATION.exec(raw) : null;
    if (m === null) return unresolvedAttr(key, TF_PROBLEMS.notReference, source);
    return referenceAttr(key, m[1] as string, m[2] as string, m[3] as string, source);
  }
  return stringAttr(key, raw, source);
}

/** `resource` of a `*.tf.json` document. */
export function readTfJsonSyntax(origin: JsonOrigin): TfResource[] {
  const root = origin.document.value;
  if (!isRecord(root) || !Object.hasOwn(root, 'resource')) return [];
  const out: TfResource[] = [];
  for (const typeEntry of entries(root.resource, ['resource'])) {
    const type = tfTypeFromInput(typeEntry.key);
    if (type === undefined) continue;
    for (const named of entries(typeEntry.value, typeEntry.path)) {
      const bodies = entries(named.value, named.path);
      const read = TF_ATTRIBUTES[type];
      const attrs: Partial<Record<TfAttributeName, TfAttr>> = {};
      let problem: string | undefined;
      const seen = new Set<string>();
      for (const item of bodies) {
        const source = sourceOf(origin, item.path);
        if (item.key === 'count' || item.key === 'for_each') {
          problem ??= TF_PROBLEMS.countOrForEach;
        } else if (item.key === 'dynamic') {
          problem ??= TF_PROBLEMS.dynamic;
        } else if (item.key === 'lifecycle') {
          const inner = entries(item.value, item.path);
          const ok = inner.every(
            (e) =>
              (e.key === 'create_before_destroy' || e.key === 'prevent_destroy') &&
              typeof e.value === 'boolean',
          );
          if (!ok) problem ??= TF_PROBLEMS.lifecycle;
        } else if (read.includes(item.key)) {
          attrs[item.key as TfAttributeName] = seen.has(item.key)
            ? unresolvedAttr(item.key, TF_PROBLEMS.duplicate, source)
            : attrFromSyntax(item.key, item.value, source);
          seen.add(item.key);
        }
      }
      out.push({
        type,
        name: inputText(named.key),
        source: sourceOf(origin, named.path),
        scope: origin.scope,
        dir: origin.dir,
        form: 'json',
        attrs,
        ...(problem === undefined ? {} : { problem: problemOf(problem) }),
      });
    }
  }
  return out;
}

/** True for the shape of `terraform show -json` output (a plan or a state). */
export function isShowJson(root: unknown): boolean {
  return (
    isRecord(root) &&
    typeof root.format_version === 'string' &&
    (isRecord(root.planned_values) || isRecord(root.values) || isRecord(root.configuration))
  );
}

function rootResources(
  section: unknown,
  path: Path,
): { value: Record<string, unknown>; path: Path }[] {
  if (!isRecord(section) || !isRecord(section.root_module)) return [];
  const list = section.root_module.resources;
  if (!Array.isArray(list)) return [];
  const out: { value: Record<string, unknown>; path: Path }[] = [];
  list.forEach((r, i) => {
    if (isRecord(r)) out.push({ value: r, path: [...path, 'root_module', 'resources', i] });
  });
  return out;
}

const ADDRESS_PART = '([A-Za-z_][A-Za-z0-9_-]*)';

/** The exact references of one attribute in `configuration`, or undefined when it is not a single reference. */
function configReference(
  config: Record<string, unknown> | undefined,
  key: string,
): { type: string; name: string; attribute: string } | undefined {
  const expressions =
    config !== undefined && isRecord(config.expressions) ? config.expressions : undefined;
  const entry = expressions?.[key];
  if (!isRecord(entry) || !Array.isArray(entry.references)) return undefined;
  const refs = entry.references.filter((r): r is string => typeof r === 'string');
  if (refs.length !== entry.references.length || refs.length < 1 || refs.length > 2) {
    return undefined;
  }
  const m = new RegExp(`^${ADDRESS_PART}\\.${ADDRESS_PART}\\.${ADDRESS_PART}$`).exec(
    refs[0] as string,
  );
  if (m === null) return undefined;
  if (refs.length === 2 && refs[1] !== `${m[1]}.${m[2]}`) return undefined;
  return { type: m[1] as string, name: m[2] as string, attribute: m[3] as string };
}

/** The managed resources of a `terraform show -json` document. */
export function readShowJson(origin: JsonOrigin): TfResource[] {
  const root = origin.document.value;
  if (!isRecord(root)) return [];
  const planned = isRecord(root.planned_values) ? 'planned_values' : 'values';
  const configByAddress = new Map<string, Record<string, unknown>>();
  for (const c of rootResources(root.configuration, ['configuration'])) {
    if (typeof c.value.address === 'string') configByAddress.set(c.value.address, c.value);
  }
  const out: TfResource[] = [];
  for (const r of rootResources(root[planned], [planned])) {
    const v = r.value;
    if (v.mode !== 'managed' || typeof v.type !== 'string' || typeof v.name !== 'string') continue;
    const type = tfTypeFromInput(v.type);
    if (type === undefined) continue;
    const values = isRecord(v.values) ? v.values : {};
    const config = typeof v.address === 'string' ? configByAddress.get(v.address) : undefined;
    const attrs: Partial<Record<TfAttributeName, TfAttr>> = {};
    const here = sourceOf(origin, [...r.path, 'values']);
    for (const key of TF_ATTRIBUTES[type]) {
      const at = Object.hasOwn(values, key) ? sourceOf(origin, [...r.path, 'values', key]) : here;
      if (key in TF_REFERENCES) {
        const ref = configReference(config, key);
        attrs[key as TfAttributeName] =
          ref === undefined
            ? unresolvedAttr(key, TF_PROBLEMS.notReference, here)
            : referenceAttr(key, ref.type, ref.name, ref.attribute, here);
      } else if (key in TF_INT_RANGES) {
        attrs[key as TfAttributeName] = intAttr(key, values[key], at);
      } else {
        attrs[key as TfAttributeName] = stringAttr(key, values[key], at);
      }
    }
    out.push({
      type,
      name: inputText(v.name),
      source: sourceOf(origin, r.path),
      scope: origin.scope,
      dir: origin.dir,
      form: 'plan',
      attrs,
      ...(Object.hasOwn(v, 'index') ? { problem: problemOf(TF_PROBLEMS.countOrForEach) } : {}),
    });
  }
  return out;
}
