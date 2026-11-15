// The Terraform load balancer link and the event source mapping link. Linking uses explicit evidence only.
//
//  - A DECLARED link (`load_balancer: {terraform: aws_lb.<name>}` in tripcurve.yaml) is established when
//    exactly one `aws_lb` of that resource name was read.
//  - A link BY NAME is an ASSUMPTION: an Ingress `load-balancer-name` annotation equal to the literal
//    `name` of exactly one `aws_lb`. The controller applies that name only when it creates a load
//    balancer, and a Terraform-owned one is normally joined by TargetGroupBinding, which is not read.
//    "Exactly one" is a claim of absence: it needs every Terraform input read, and every `aws_lb` to
//    have a literal name (an allow-list, not a list of known escapes). Otherwise the link is
//    unresolved, never guessed.
//  - An event source mapping links to its queue and function only by an `aws_sqs_queue` and
//    `aws_lambda_function` reference that matches exactly one resource of the same FOLDER (bolt B17). A folder
//    is one Terraform module: every `.tf` and `.tf.json` file in it is read as one document, and a nested
//    folder is a separate module. A reference never crosses into a subfolder, a parent, a sibling or a `module`
//    block. A plan document and a CloudFormation or SAM template are one module each.

import { type InputText, isInputText, type SourcedValue, type SourceRef } from '../core/index.js';
import {
  type IacReadResult,
  moduleOf,
  rawInputTextForParser,
  TF_PROBLEMS,
  type TfResource,
  type TfType,
  tfAttr,
} from '../parse/index.js';

export const TF_LB_UNRESOLVED_REASONS = [
  'terraform-not-read',
  'no-resource',
  'several-resources',
  'name-not-literal',
] as const;
export type TfLbUnresolvedReason = (typeof TF_LB_UNRESOLVED_REASONS)[number];

export type TerraformLbLink =
  | {
      readonly state: 'linked';
      readonly by: 'declared';
      readonly resource: TfResource;
      /** The declaration `tripcurve.yaml`:line, and the target as written. */
      readonly evidence: SourceRef;
      readonly target: InputText;
    }
  | {
      readonly state: 'linked';
      readonly by: 'name';
      readonly resource: TfResource;
      /** The `load-balancer-name` annotation value, with its source. */
      readonly annotation: SourcedValue;
      /** The `name` attribute of the load balancer that equals it. */
      readonly name: SourcedValue;
    }
  | {
      readonly state: 'unresolved';
      readonly by: 'declared' | 'name';
      readonly reason: TfLbUnresolvedReason;
    };

function isLb(r: TfResource): boolean {
  return r.type === 'aws_lb';
}

/** Lookups built once per read, so linking is linear in the resources and never rescans them per mapping or workload. */
interface Index {
  readonly lbs: readonly TfResource[];
  readonly lbsByName: ReadonlyMap<string, readonly TfResource[]>;
  readonly byScope: ReadonlyMap<string, readonly TfResource[]>;
  /** The load balancers whose `name` is a literal, by that name (raw), with the value. */
  readonly literalNames: ReadonlyMap<string, readonly { r: TfResource; name: SourcedValue }[]>;
  /** Some aws_lb has a name that is not a literal. */
  readonly anyNameNotLiteral: boolean;
}

const indexes = new WeakMap<IacReadResult, Index>();

function indexOf(iac: IacReadResult): Index {
  const found = indexes.get(iac);
  if (found !== undefined) return found;
  const lbs: TfResource[] = [];
  const lbsByName = new Map<string, TfResource[]>();
  const byScope = new Map<string, TfResource[]>();
  const push = (m: Map<string, TfResource[]>, key: string, r: TfResource): void => {
    const list = m.get(key);
    if (list === undefined) m.set(key, [r]);
    else list.push(r);
  };
  for (const r of iac.resources) {
    const name = rawInputTextForParser(r.name);
    // A CloudFormation load balancer is never linked by a Terraform address or by name (bolt B12): there is no
    // CloudFormation link form, and its Name is not read.
    if (isLb(r) && r.form !== 'cfn') {
      lbs.push(r);
      push(lbsByName, name, r);
    }
    push(byScope, `${moduleOf(r)}\u0000${r.type}\u0000${name}`, r);
  }
  const literalNames = new Map<string, { r: TfResource; name: SourcedValue }[]>();
  let anyNameNotLiteral = false;
  for (const r of lbs) {
    const name = literalName(r);
    if (name === undefined) {
      anyNameNotLiteral = true;
      continue;
    }
    const key = rawInputTextForParser(name.value as InputText);
    const list = literalNames.get(key);
    if (list === undefined) literalNames.set(key, [{ r, name }]);
    else list.push({ r, name });
  }
  const made: Index = { lbs, lbsByName, byScope, literalNames, anyNameNotLiteral };
  indexes.set(iac, made);
  return made;
}

function literalName(r: TfResource): SourcedValue | undefined {
  const a = tfAttr(r, 'name');
  return a !== undefined && a.kind === 'literal' && isInputText(a.value.value)
    ? a.value
    : undefined;
}

export function linkDeclaredLb(
  iac: IacReadResult,
  evidence: SourceRef,
  target: InputText,
): TerraformLbLink {
  const text = rawInputTextForParser(target);
  const resourceName = text.slice(text.indexOf('.') + 1);
  const found = indexOf(iac).lbsByName.get(resourceName) ?? [];
  if (found.length === 1) {
    return { state: 'linked', by: 'declared', resource: found[0] as TfResource, evidence, target };
  }
  if (found.length > 1) return { state: 'unresolved', by: 'declared', reason: 'several-resources' };
  return {
    state: 'unresolved',
    by: 'declared',
    reason: iac.incomplete ? 'terraform-not-read' : 'no-resource',
  };
}

/**
 * Only a name of letters, digits and hyphens is linked by name. The link is printed as an assumption
 * line quoting the name, and a name with other characters could not be quoted safely there. (AWS's own
 * rules for a load balancer name were not looked up; this is tripcurve's rule, and it errs toward no link.)
 */
const LINKABLE_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Undefined when no `aws_lb` could be the one the annotation names (the ordinary "no link" case). */
export function linkLbByName(
  iac: IacReadResult,
  annotation: SourcedValue,
): TerraformLbLink | undefined {
  const wanted = annotation.value;
  if (!isInputText(wanted) || !LINKABLE_NAME.test(rawInputTextForParser(wanted))) return undefined;
  const index = indexOf(iac);
  if (iac.incomplete) {
    return index.lbs.length === 0
      ? undefined
      : { state: 'unresolved', by: 'name', reason: 'terraform-not-read' };
  }
  if (index.lbs.length === 0) return undefined;
  if (index.anyNameNotLiteral)
    return { state: 'unresolved', by: 'name', reason: 'name-not-literal' };
  const matches = index.literalNames.get(rawInputTextForParser(wanted)) ?? [];
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { state: 'unresolved', by: 'name', reason: 'several-resources' };
  const only = matches[0] as { r: TfResource; name: SourcedValue };
  return { state: 'linked', by: 'name', resource: only.r, annotation, name: only.name };
}

// ---------------------------------------------------------------- event source mappings

export const MAPPING_LINK_REASONS = [
  'mapping-block-not-read',
  'queue-not-a-reference',
  'function-not-a-reference',
  'queue-not-found',
  'function-not-found',
  'several-queues',
  'several-functions',
  'folder-not-read',
] as const;
export type MappingLinkReason = (typeof MAPPING_LINK_REASONS)[number];

export interface MappingLink {
  readonly mapping: TfResource;
  readonly queue:
    | { readonly ok: true; readonly resource: TfResource }
    | { readonly ok: false; readonly reason: MappingLinkReason };
  readonly fn:
    | { readonly ok: true; readonly resource: TfResource }
    | { readonly ok: false; readonly reason: MappingLinkReason };
}

function findInScope(
  iac: IacReadResult,
  mapping: TfResource,
  type: TfType,
  name: InputText,
): readonly TfResource[] {
  return (
    indexOf(iac).byScope.get(
      `${moduleOf(mapping)}\u0000${type}\u0000${rawInputTextForParser(name)}`,
    ) ?? []
  );
}

function referenced(
  iac: IacReadResult,
  mapping: TfResource,
  attribute: 'event_source_arn' | 'function_name',
  type: TfType,
  notRef: MappingLinkReason,
  notFound: MappingLinkReason,
  several: MappingLinkReason,
): MappingLink['queue'] {
  const a = tfAttr(mapping, attribute);
  if (a === undefined || a.kind !== 'reference') return { ok: false, reason: notRef };
  const found = findInScope(iac, mapping, type, a.name);
  if (found.length === 1) return { ok: true, resource: found[0] as TfResource };
  // An override file declares the address a second time on purpose (Terraform merges it into the first). Both
  // blocks carry the override problem, so linking either one gives every value unresolved with that reason.
  const overridden = found.find((r) => r.problem?.reason === TF_PROBLEMS.override);
  if (overridden !== undefined) return { ok: true, resource: overridden };
  if (found.length === 0) {
    // Not found in the folder: when a Terraform file of that folder was not read, it may be there.
    const unread =
      (mapping.form === 'hcl' || mapping.form === 'json') && iac.unreadFolders.has(mapping.dir);
    return { ok: false, reason: unread ? 'folder-not-read' : notFound };
  }
  return { ok: false, reason: several };
}

export function linkMappings(iac: IacReadResult): MappingLink[] {
  return iac.resources
    .filter((r) => r.type === 'aws_lambda_event_source_mapping')
    .map((mapping): MappingLink => {
      if (mapping.problem !== undefined) {
        const bad = { ok: false as const, reason: 'mapping-block-not-read' as const };
        return { mapping, queue: bad, fn: bad };
      }
      return {
        mapping,
        queue: referenced(
          iac,
          mapping,
          'event_source_arn',
          'aws_sqs_queue',
          'queue-not-a-reference',
          'queue-not-found',
          'several-queues',
        ),
        fn: referenced(
          iac,
          mapping,
          'function_name',
          'aws_lambda_function',
          'function-not-a-reference',
          'function-not-found',
          'several-functions',
        ),
      };
    });
}
