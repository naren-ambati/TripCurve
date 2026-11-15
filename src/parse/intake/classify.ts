// Classification of the files tripcurve reads: by name first,
// then, for YAML only, by content. An unknown file is ignored without comment.
//
// Decisions (see the area 2 report):
// - `tripcurve.yaml` is a configuration file only at the root of the checked
//   path; one deeper in the tree is not read.
// - `.json` files other than `package.json`, the lock files and `*.tf.json` are read, bounded, and
//   decided by CONTENT (bolt B12): a CloudFormation or SAM template, or, for the one file named as
//   the root, `terraform show -json` output. A text sniff only chooses candidates; the parsed shape
//   decides (see `isCfnTemplateValue`), and a file that fits two shapes is reported, never guessed.
// - A YAML file is Kubernetes when it has an `apiVersion:` line and a `kind:`
//   line. A Helm template with `{{ }}` and those two lines is then reported
//   as unparseable (render it and pipe it in); one without them is not ours.
// - a `.yaml`, `.yml` or `.json` file that has the two words `apiVersion` and `kind` anywhere, in any
//   quoting or style (JSON, quoted keys, flow mapping on one line), is a candidate; the PARSED shape decides (a
//   document that is a mapping with an `apiVersion` key and a string `kind`, or a sequence with at least one such mapping; see `isK8sCandidateValue`). A candidate
//   that does not parse is reported, never ignored: it may be the manifest it looks like.

import { isNodeLockFileName } from '../node/read-node-pins.js';
import { isPinFileName } from '../python/read-pins.js';
import type { InputClass } from './types.js';

const NODE_SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
const TYPE_DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'];

/** Directories that are never walked: a dependency tree or version-control data. */
// `cdk.out` is the output of the CDK: CDK is not read, and its synthesized templates and bundled assets are
// not read either (unknown files are ignored without comment).
export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  '.terraform',
  'cdk.out',
];

/** `.json` in any case: a file whose content may be a CloudFormation or SAM template. */
export function isJsonName(name: string): boolean {
  return name.toLowerCase().endsWith('.json');
}

/** `.yaml` or `.yml` in any case: `.YAML` and `.Yml` are YAML files too. */
export function isYamlName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

/** The class a file name decides on its own, or undefined (then YAML may decide by content). */
export function classifyByName(name: string, atRoot: boolean): InputClass | undefined {
  if (name === 'tripcurve.yaml') return atRoot ? 'tripcurve-yaml' : undefined;
  if (name === 'package.json') return 'package-json';
  if (isNodeLockFileName(name)) return 'node-lock';
  if (name === 'gunicorn.conf.py') return 'gunicorn-conf';
  if (isPinFileName(name)) return 'python-pin';
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.Dockerfile')) {
    return 'dockerfile';
  }
  // Terraform does not read a file whose name starts with a dot, or an editor's `#name#` file.
  if (name.endsWith('.tf.json') || name.endsWith('.tf')) {
    if (name.startsWith('.') || (name.startsWith('#') && name.endsWith('#'))) return undefined;
    return name.endsWith('.tf.json') ? 'terraform-json' : 'terraform';
  }
  if (TYPE_DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix))) return undefined;
  if (NODE_SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'node-source';
  return undefined;
}

/** True when a file of this name might be one we read, so a refusal to open it must be reported. */
export function couldBeRelevant(name: string, atRoot: boolean): boolean {
  // A `.json` file is a candidate too (bolt B12): its content decides, and one that cannot be read is
  // reported unless its content says it is not a template (see `readOne`).
  return classifyByName(name, atRoot) !== undefined || isYamlName(name) || isJsonName(name);
}

// Only spaces and tabs inside a line (never \s, which crosses lines): a file of
// 5 MB of blank lines must not make these quadratic.
const API_VERSION_LINE = /^[ \t]*(?:-[ \t]+)?apiVersion[ \t]*:/m;
const KIND_LINE = /^[ \t]*(?:-[ \t]+)?kind[ \t]*:/m;
const TEMPLATE_KEY =
  /^(?:AWSTemplateFormatVersion|Transform|Resources|"AWSTemplateFormatVersion"|"Transform"|"Resources"|'AWSTemplateFormatVersion'|'Transform'|'Resources')[ \t]*:/;

/**
 * True when a template key (`AWSTemplateFormatVersion`, `Transform`, `Resources`) is a key of the top-level mapping
 * of a document, at the indentation that document's first line of content uses. A template whose keys are all
 * indented is still found, while a nested `Resources:` (a Helm values file, a Serverless Framework file, a workflow)
 * is not a candidate, so such a file is never parsed for it. One linear pass, no regular expression over the
 * whole text. A template carried as text in a Kubernetes `ConfigMap` is a candidate only if its lines sit at the
 * ConfigMap's own top level, which they do not; the parsed documents decide in any case (`isCfnTemplateValue`).
 */
export function hasTemplateKeyAtTopIndent(text: string): boolean {
  let resourcesOnly = false;
  let docIndent: number | undefined;
  for (let from = 0; from < text.length; ) {
    let to = text.indexOf('\n', from);
    if (to === -1) to = text.length;
    let i = from;
    while (i < to && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i += 1;
    const first = text.charCodeAt(i);
    const indent = i - from;
    if (i < to && first !== 35 && first !== 13) {
      if (indent === 0 && (text.startsWith('---', i) || text.startsWith('...', i))) {
        docIndent = undefined;
      } else if (indent === 0 && first === 37) {
        // a directive line (`%YAML`): not content
      } else {
        docIndent ??= indent;
        if (indent === docIndent && TEMPLATE_KEY.test(text.slice(i, Math.min(to, i + 40)))) {
          // `Resources` alone is a candidate only when the text mentions an `AWS::` type at all: typed resources are
          // part of the shape (`isCfnTemplateValue`), so a file with none cannot be a template without a version
          // header or a transform, and is not parsed for it.
          if (!/^["']?Resources/.test(text.slice(i, i + 11))) return true;
          resourcesOnly = true;
        }
      }
    }
    from = to + 1;
  }
  return resourcesOnly && text.includes('AWS::');
}

/** A YAML file written as JSON (starts with a brace): the JSON candidate test applies too. */
function startsWithBrace(text: string): boolean {
  return /^[\s\uFEFF]*\{/.test(text.slice(0, 64));
}

/**
 * True when a text could hold a Kubernetes object in ANY style or quoting: the two words `apiVersion` and `kind`
 * appear. A pre-filter that cannot drop a real manifest (every manifest has both keys, spelled so); the parsed shape
 * decides (`isK8sObjectValue`). Two substring searches, linear.
 */
export function couldBeK8sText(text: string): boolean {
  return text.includes('apiVersion') && text.includes('kind');
}

/** True when the text has the plain block-style lines of a manifest: `apiVersion:` and `kind:` at the start of a line. */
export function hasPlainK8sLines(text: string): boolean {
  return API_VERSION_LINE.test(text) && KIND_LINE.test(text);
}

/** True when the text of a JSON file could be a CloudFormation or SAM template (a pre-filter; the shape decides). */
export function couldBeCfnJson(text: string): boolean {
  if (text.includes('"AWSTemplateFormatVersion"')) return true;
  if (text.includes('"Resources"') && text.includes('"Type"') && text.includes('"AWS::')) {
    return true;
  }
  return text.includes('"Transform"') && text.includes('AWS::Serverless');
}

/**
 * True when the text of a flow-style document (a YAML file written as `{...}`) could be a template: the same markers as
 * `couldBeCfnJson`, with the keys quoted or not (YAML flow style allows plain keys). The parsed shape decides.
 */
function couldBeCfnFlow(text: string): boolean {
  if (text.includes('AWSTemplateFormatVersion')) return true;
  if (text.includes('Resources') && text.includes('AWS::')) return true;
  return text.includes('Transform') && text.includes('AWS::Serverless');
}

/**
 * Content class of a YAML file, or undefined when it is not one we read. `both` is a file whose text could be
 * Kubernetes and CloudFormation: the caller parses it and decides by the shape of the documents.
 */
export function classifyYamlContent(text: string): InputClass | 'both' | 'k8s-probe' | undefined {
  const cfn = hasTemplateKeyAtTopIndent(text) || (startsWithBrace(text) && couldBeCfnFlow(text));
  const plain = hasPlainK8sLines(text);
  // `k8s-probe`: the words are there but not as plain lines (quoted keys, flow style, JSON): parse, then decide by shape.
  const probe = !plain && couldBeK8sText(text);
  if (cfn && (plain || probe)) return 'both';
  if (cfn) return 'cfn-template';
  if (plain) return 'k8s-yaml';
  if (probe) return 'k8s-probe';
  return undefined;
}

/** A Kubernetes object: a mapping with a string `apiVersion` and a string `kind` (or a list of them). */
export function isK8sObjectValue(value: unknown): boolean {
  return isRecord(value) && typeof value.apiVersion === 'string' && typeof value.kind === 'string';
}

/**
 * What makes a parsed document of a candidate file Kubernetes: a mapping with an `apiVersion` key and a string `kind`
 * (the reader then identifies it, or reports it as an object it cannot identify, as it does for plain YAML), or a
 * sequence at the root (a file that is a list of objects; the reader reads each element that is an object with a
 * string `kind` and reports the others). A mapping whose `kind` is not text is not an object.
 */
export function isK8sCandidateValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isObjectWithKind);
  return isRecord(value) && Object.hasOwn(value, 'apiVersion') && typeof value.kind === 'string';
}

/** An element of a root list that the Kubernetes reader reads: a mapping with a text `kind`. */
export function isObjectWithKind(value: unknown): boolean {
  return isRecord(value) && typeof value.kind === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The shape of a parsed CloudFormation or SAM template (the content rule). A mapping that has
 * `AWSTemplateFormatVersion`; or `Transform` together with a `Resources` mapping; or a non-empty
 * `Resources` mapping whose every value is a mapping with a string `Type` of the form `A::B` (at
 * least one starting `AWS::`). A Kubernetes object (`apiVersion`, `kind`) or a lock file never fits,
 * because none has a top-level `Resources` mapping of typed resources.
 */
export function isCfnTemplateValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'AWSTemplateFormatVersion')) return true;
  // A transform makes a file a template even with no usable Resources: it can rewrite anything, so it is listed
  // (a `Resources` key of any form, or a transform named like an AWS one).
  if (Object.hasOwn(value, 'Transform')) {
    const t = value.Transform;
    if (Object.hasOwn(value, 'Resources') || (typeof t === 'string' && t.startsWith('AWS::'))) {
      return true;
    }
  }
  const resources = Object.hasOwn(value, 'Resources') ? value.Resources : undefined;
  if (!isRecord(resources)) return false;
  const types = Object.keys(resources).map((k) => {
    const r = resources[k];
    return isRecord(r) && Object.hasOwn(r, 'Type') && typeof r.Type === 'string' ? r.Type : '';
  });
  return (
    types.length > 0 &&
    types.every((t) => /^[A-Za-z0-9_]+::[A-Za-z0-9_:]+$/.test(t)) &&
    types.some((t) => t.startsWith('AWS::'))
  );
}

/** The shape of `terraform show -json` output (a plan or a state): a top-level `format_version` string and a values section. */
export function isShowJsonValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.format_version === 'string' &&
    (isRecord(value.planned_values) || isRecord(value.values) || isRecord(value.configuration))
  );
}

/**
 * `terraform show -json` output (a plan or a state) given as the one file to check: it has a
 * `format_version` key and a `planned_values`, `values` or `configuration` key. Only a file named as the
 * root is looked at this way, so no lock file in a tree is ever read for it (bolt B5).
 */
export function classifyShowJson(text: string): InputClass | undefined {
  return text.includes('"format_version"') &&
    (text.includes('"planned_values"') ||
      text.includes('"values"') ||
      text.includes('"configuration"'))
    ? 'terraform-json'
    : undefined;
}
