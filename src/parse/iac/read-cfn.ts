// The CloudFormation and SAM reader: a template, YAML or JSON, read into the same
// model the Terraform readers fill. Five resource types and the values below, as literals; the property names
// and defaults are from the AWS documentation, looked up 2026-11-12 (docs/lookups-b12.txt).
//
//   AWS::ElasticLoadBalancingV2::LoadBalancer  LoadBalancerAttributes, the entry with Key idle_timeout.timeout_seconds; Type
//   AWS::SQS::Queue                            VisibilityTimeout
//   AWS::Lambda::Function, AWS::Serverless::Function   Timeout (a SAM function: Globals.Function.Timeout when it has none)
//   AWS::Lambda::EventSourceMapping            MaximumBatchingWindowInSeconds, EventSourceArn, FunctionName
//   SAM Events of Type SQS (and Kinesis, DynamoDB: a stream is unresolved)   Queue, MaximumBatchingWindowInSeconds
//
// The honesty rules:
//  - A value that is ABSENT is a claim of absence, so it is allowed only after every place it could come from was
//    read: a SAM function's Timeout comes from the function or from Globals.Function.Timeout; a Globals section
//    that is not read in full, a transform other than exactly AWS::Serverless-2016-10-31 (or Fn::Transform
//    anywhere), a Condition on the resource, or Properties that are not a plain mapping makes the value
//    unresolved, never a default.
//  - A literal is a whole number whose SOURCE TEXT is plain decimal digits (so `0x10`, `1e2`, `030`, a quoted
//    number and a tagged value are not read as numbers; the ALB attribute value is a string and may be quoted).
//    The tag forms (`!Ref`, `!If`, `!Bogus`) arrive here as long-form one-key mappings (intake rewrote them).
//  - A Ref or Fn::GetAtt is followed ONLY to link: the event source `Fn::GetAtt [queue, Arn]` to an
//    AWS::SQS::Queue of the same template, the function `Ref` or `Fn::GetAtt [function, Arn]` to a function of
//    the same template. A parameter (even with a Default), Fn::Sub, Fn::If, Fn::FindInMap, Fn::ImportValue,
//    Fn::Select, Fn::Join, a nested stack, a stream, a literal ARN: unresolved, with a fixed reason.
//  - Nothing is followed more than one hop, so a self-reference or a cycle cannot loop; it is unresolved.
// Not read at all, and ignored without comment: CDK code and `cdk.out`, `parameters.json`,
// `samconfig.toml`. A nested stack resource is read as a resource tripcurve does not follow.

import {
  fileSource,
  type InputText,
  inputText,
  makeSourcedValue,
  makeUnresolved,
  type SourceRef,
  stdinSource,
} from '../../core/index.js';
import { type IntakeDocument, rawInputTextForParser } from '../intake/index.js';
import {
  CFN_PROBLEMS,
  CFN_PROPERTY,
  problemOf,
  TF_INT_RANGES,
  type TfAttr,
  type TfAttributeName,
  type TfResource,
  type TfType,
} from './model.js';

export const SAM_TRANSFORM = 'AWS::Serverless-2016-10-31';

const RESOURCE_TYPES: Readonly<Record<string, TfType>> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'aws_lb',
  'AWS::SQS::Queue': 'aws_sqs_queue',
  'AWS::Lambda::Function': 'aws_lambda_function',
  'AWS::Serverless::Function': 'aws_lambda_function',
  'AWS::Lambda::EventSourceMapping': 'aws_lambda_event_source_mapping',
};
const STREAM_TYPES: readonly string[] = ['AWS::Kinesis::Stream', 'AWS::DynamoDB::Table'];
const NESTED_TYPES: readonly string[] = [
  'AWS::CloudFormation::Stack',
  'AWS::Serverless::Application',
];
const IDLE_KEY = 'idle_timeout.timeout_seconds';

type Path = readonly (string | number)[];

export interface CfnOrigin {
  readonly document: IntakeDocument;
  readonly file: InputText | undefined;
  readonly streamIndex: number | undefined;
  readonly scope: string;
  readonly dir: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** `{Ref: x}`, `{Condition: x}` or a mapping with an `Fn::` key: what a short-form tag or a long form becomes. */
function isIntrinsic(v: unknown): boolean {
  return (
    isRecord(v) &&
    Object.keys(v).some((k) => k === 'Ref' || k === 'Condition' || k.startsWith('Fn::'))
  );
}

/** True when `Fn::Transform` appears anywhere in the value (iterative: the nesting is the input's). */
function hasFnTransform(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (isRecord(v)) {
      if (Object.hasOwn(v, 'Fn::Transform')) return true;
      for (const k of Object.keys(v)) stack.push(v[k]);
    }
  }
  return false;
}

class Ctx {
  constructor(
    readonly origin: CfnOrigin,
    readonly root: Record<string, unknown>,
  ) {}

  source(path: Path): SourceRef {
    const at = this.origin.document.sourceAt(path);
    if (at.type === 'file' || at.type === 'stdin') return at;
    return this.origin.file !== undefined
      ? fileSource(this.origin.file, 1)
      : stdinSource(this.origin.streamIndex ?? 1, 1);
  }

  /** The text of the node as written, or undefined when it is not exactly that node (an alias, a merge). */
  text(path: Path): string | undefined {
    const t = this.origin.document.sourceTextAt(path);
    return t === undefined ? undefined : rawInputTextForParser(t);
  }

  get resources(): Record<string, unknown> {
    const r = own(this.root, 'Resources');
    return isRecord(r) ? r : {};
  }

  get parameters(): Record<string, unknown> {
    const p = own(this.root, 'Parameters');
    return isRecord(p) ? p : {};
  }
}

function unresolved(key: TfAttributeName, why: string, source: SourceRef): TfAttr {
  return { kind: 'unresolved', value: makeUnresolved(`${CFN_PROPERTY[key]} ${why}`), source };
}

/** Why an intrinsic function (or a tag) is not a literal: a parameter has its own reason. */
function whyIntrinsic(ctx: Ctx, v: Record<string, unknown>): string {
  const ref = own(v, 'Ref');
  if (typeof ref === 'string' && Object.hasOwn(ctx.parameters, ref)) return CFN_PROBLEMS.parameter;
  return CFN_PROBLEMS.intrinsic;
}

function intAttr(
  ctx: Ctx,
  key: TfAttributeName,
  raw: unknown,
  path: Path,
  options: { stringOk?: boolean } = {},
): TfAttr {
  const source = ctx.source(path);
  if (isIntrinsic(raw))
    return unresolved(key, whyIntrinsic(ctx, raw as Record<string, unknown>), source);
  const range = TF_INT_RANGES[key] as { min: number; max: number };
  const text = ctx.text(path);
  let n: number | undefined;
  if (typeof raw === 'number' && text !== undefined && /^(?:0|[1-9][0-9]*)$/.test(text)) n = raw;
  else if (
    options.stringOk === true &&
    typeof raw === 'string' &&
    /^(?:0|[1-9][0-9]{0,8})$/.test(raw) &&
    text !== undefined &&
    (text === `"${raw}"` || text === `'${raw}'`)
  ) {
    n = Number(raw);
  }
  if (n === undefined || !Number.isSafeInteger(n)) {
    return unresolved(key, CFN_PROBLEMS.notInteger, source);
  }
  if (n < range.min || n > range.max) {
    return unresolved(
      key,
      `is outside the documented range ${range.min} to ${range.max} s`,
      source,
    );
  }
  return {
    kind: 'literal',
    value: makeSourcedValue({ value: n, unit: 's', source, basis: 'declared' }),
  };
}

function typeAttr(ctx: Ctx, raw: unknown, path: Path): TfAttr {
  const source = ctx.source(path);
  if (isIntrinsic(raw)) {
    return unresolved(
      'load_balancer_type',
      whyIntrinsic(ctx, raw as Record<string, unknown>),
      source,
    );
  }
  if (typeof raw !== 'string' || ctx.text(path) === undefined) {
    return unresolved('load_balancer_type', 'is not a plain string literal', source);
  }
  return {
    kind: 'literal',
    value: makeSourcedValue({ value: inputText(raw), unit: 'none', source, basis: 'declared' }),
  };
}

/** A `Ref` or `Fn::GetAtt` of one resource: its logical id and, for GetAtt, the attribute. Nothing else is a reference. */
function refOf(v: unknown): { id: string; attribute: string | undefined } | undefined {
  if (!isRecord(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'Ref') {
    return typeof v.Ref === 'string' ? { id: v.Ref, attribute: undefined } : undefined;
  }
  if (keys[0] === 'Fn::GetAtt') {
    const g = v['Fn::GetAtt'];
    if (
      Array.isArray(g) &&
      g.length === 2 &&
      typeof g[0] === 'string' &&
      typeof g[1] === 'string'
    ) {
      return { id: g[0], attribute: g[1] };
    }
    if (typeof g === 'string') {
      const dot = g.indexOf('.');
      if (dot > 0) return { id: g.slice(0, dot), attribute: g.slice(dot + 1) };
    }
  }
  return undefined;
}

function referenceAttr(
  ctx: Ctx,
  key: 'event_source_arn' | 'function_name',
  raw: unknown,
  path: Path,
): TfAttr {
  const source = ctx.source(path);
  if (isIntrinsic(raw)) {
    const ref = refOf(raw);
    if (ref === undefined) {
      return unresolved(key, whyIntrinsic(ctx, raw as Record<string, unknown>), source);
    }
    if (Object.hasOwn(ctx.parameters, ref.id) && ref.attribute === undefined) {
      return unresolved(key, CFN_PROBLEMS.parameter, source);
    }
    // an own-property lookup only: a logical id such as `__proto__` or `constructor` is never a resource of the prototype
    const target = Object.hasOwn(ctx.resources, ref.id) ? ctx.resources[ref.id] : undefined;
    const targetType =
      isRecord(target) && typeof target.Type === 'string' ? target.Type : undefined;
    if (targetType === undefined) return unresolved(key, CFN_PROBLEMS.notInTemplate, source);
    if (NESTED_TYPES.includes(targetType)) return unresolved(key, CFN_PROBLEMS.nestedStack, source);
    if (key === 'event_source_arn') {
      if (STREAM_TYPES.includes(targetType)) return unresolved(key, CFN_PROBLEMS.stream, source);
      // `Ref` of a queue is its URL, not its ARN (docs/lookups-b12.txt): only GetAtt Arn is an event source ARN
      if (targetType !== 'AWS::SQS::Queue' || ref.attribute !== 'Arn') {
        return unresolved(
          key,
          targetType === 'AWS::SQS::Queue' ? CFN_PROBLEMS.reference : CFN_PROBLEMS.wrongType,
          source,
        );
      }
      return { kind: 'reference', type: 'aws_sqs_queue', name: inputText(ref.id), source };
    }
    if (
      (targetType !== 'AWS::Lambda::Function' && targetType !== 'AWS::Serverless::Function') ||
      (ref.attribute !== undefined && ref.attribute !== 'Arn')
    ) {
      return unresolved(
        key,
        targetType.endsWith('Function') ? CFN_PROBLEMS.reference : CFN_PROBLEMS.wrongType,
        source,
      );
    }
    return { kind: 'reference', type: 'aws_lambda_function', name: inputText(ref.id), source };
  }
  return unresolved(key, CFN_PROBLEMS.reference, source);
}

/** The idle timeout from `LoadBalancerAttributes`: the one entry with Key `idle_timeout.timeout_seconds`. Undefined when no entry has it and every entry was read. */
function idleAttr(ctx: Ctx, list: unknown, base: Path): TfAttr | undefined {
  const source = ctx.source(base);
  if (isIntrinsic(list)) {
    return unresolved('idle_timeout', whyIntrinsic(ctx, list as Record<string, unknown>), source);
  }
  if (!Array.isArray(list))
    return unresolved('idle_timeout', CFN_PROBLEMS.attributesNotRead, source);
  let found: TfAttr | undefined;
  let foundAt: SourceRef = source;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    const entry: unknown = list[i];
    if (!isRecord(entry) || isIntrinsic(entry) || !Object.hasOwn(entry, 'Key')) {
      return unresolved('idle_timeout', CFN_PROBLEMS.attributesNotRead, ctx.source([...base, i]));
    }
    const key = entry.Key;
    if (typeof key !== 'string' || ctx.text([...base, i, 'Key']) === undefined) {
      return unresolved(
        'idle_timeout',
        CFN_PROBLEMS.keyNotLiteral,
        ctx.source([...base, i, 'Key']),
      );
    }
    if (key !== IDLE_KEY) continue;
    count += 1;
    foundAt = ctx.source([...base, i]);
    found = Object.hasOwn(entry, 'Value')
      ? intAttr(ctx, 'idle_timeout', entry.Value, [...base, i, 'Value'], { stringOk: true })
      : unresolved('idle_timeout', CFN_PROBLEMS.notInteger, ctx.source([...base, i]));
  }
  if (count > 1) {
    return unresolved('idle_timeout', CFN_PROBLEMS.duplicate, foundAt);
  }
  return found;
}

type Globals =
  | { readonly state: 'absent' }
  | { readonly state: 'value'; readonly attr: TfAttr }
  | { readonly state: 'unread'; readonly source: SourceRef };

/** `Globals.Function.Timeout`, read as a literal; any form that is not read in full is `unread`. */
function globalsTimeout(ctx: Ctx): Globals {
  if (!Object.hasOwn(ctx.root, 'Globals')) return { state: 'absent' };
  const g = ctx.root.Globals;
  const here = ctx.source(['Globals']);
  if (!isRecord(g) || isIntrinsic(g)) return { state: 'unread', source: here };
  if (!Object.hasOwn(g, 'Function')) return { state: 'absent' };
  const f = g.Function;
  if (!isRecord(f) || isIntrinsic(f))
    return { state: 'unread', source: ctx.source(['Globals', 'Function']) };
  if (!Object.hasOwn(f, 'Timeout')) return { state: 'absent' };
  return {
    state: 'value',
    attr: intAttr(ctx, 'timeout', f.Timeout, ['Globals', 'Function', 'Timeout']),
  };
}

interface Built {
  readonly attrs: Partial<Record<TfAttributeName, TfAttr>>;
}

function resourceAttrs(
  ctx: Ctx,
  type: string,
  props: Record<string, unknown>,
  id: string,
  sam: boolean,
  globals: Globals,
): Built {
  const base: Path = ['Resources', id, 'Properties'];
  const attrs: Partial<Record<TfAttributeName, TfAttr>> = {};
  if (type === 'AWS::SQS::Queue') {
    if (Object.hasOwn(props, 'VisibilityTimeout')) {
      attrs.visibility_timeout_seconds = intAttr(
        ctx,
        'visibility_timeout_seconds',
        props.VisibilityTimeout,
        [...base, 'VisibilityTimeout'],
      );
    }
  } else if (type === 'AWS::Lambda::Function' || type === 'AWS::Serverless::Function') {
    if (Object.hasOwn(props, 'Timeout')) {
      attrs.timeout = intAttr(ctx, 'timeout', props.Timeout, [...base, 'Timeout']);
    } else if (type === 'AWS::Serverless::Function' && sam) {
      // The function has no Timeout of its own: Globals.Function.Timeout applies (docs/lookups-b12.txt).
      if (globals.state === 'value') attrs.timeout = globals.attr;
      else if (globals.state === 'unread') {
        attrs.timeout = unresolved('timeout', CFN_PROBLEMS.globals, globals.source);
      }
    }
  } else if (type === 'AWS::ElasticLoadBalancingV2::LoadBalancer') {
    if (Object.hasOwn(props, 'Type'))
      attrs.load_balancer_type = typeAttr(ctx, props.Type, [...base, 'Type']);
    if (Object.hasOwn(props, 'LoadBalancerAttributes')) {
      const idle = idleAttr(ctx, props.LoadBalancerAttributes, [...base, 'LoadBalancerAttributes']);
      if (idle !== undefined) attrs.idle_timeout = idle;
    }
  } else if (type === 'AWS::Lambda::EventSourceMapping') {
    if (Object.hasOwn(props, 'MaximumBatchingWindowInSeconds')) {
      attrs.maximum_batching_window_in_seconds = intAttr(
        ctx,
        'maximum_batching_window_in_seconds',
        props.MaximumBatchingWindowInSeconds,
        [...base, 'MaximumBatchingWindowInSeconds'],
      );
    }
    // The two links are always read: an absent one is not a reference, so the mapping is not linked.
    attrs.event_source_arn = Object.hasOwn(props, 'EventSourceArn')
      ? referenceAttr(ctx, 'event_source_arn', props.EventSourceArn, [...base, 'EventSourceArn'])
      : unresolved('event_source_arn', CFN_PROBLEMS.reference, ctx.source(['Resources', id]));
    attrs.function_name = Object.hasOwn(props, 'FunctionName')
      ? referenceAttr(ctx, 'function_name', props.FunctionName, [...base, 'FunctionName'])
      : unresolved('function_name', CFN_PROBLEMS.reference, ctx.source(['Resources', id]));
  }
  return { attrs };
}

/** The mappings a SAM function's `Events` stand for: SQS (and the streams, unresolved), one per event. */
function samEvents(
  ctx: Ctx,
  fnId: string,
  props: Record<string, unknown>,
  scope: { scope: string; dir: string },
  problem: string | undefined,
): TfResource[] {
  if (!Object.hasOwn(props, 'Events')) return [];
  const eventsPath: Path = ['Resources', fnId, 'Properties', 'Events'];
  const events = props.Events;
  const make = (
    name: string,
    path: Path,
    attrs: Partial<Record<TfAttributeName, TfAttr>>,
    why: string | undefined,
  ): TfResource => ({
    type: 'aws_lambda_event_source_mapping',
    name: inputText(name),
    source: ctx.source(path),
    scope: scope.scope,
    dir: scope.dir,
    form: 'cfn',
    attrs,
    ...(why === undefined ? {} : { problem: problemOf(why) }),
  });
  if (!isRecord(events) || isIntrinsic(events)) {
    return [make(`${fnId}/Events`, eventsPath, {}, problem ?? CFN_PROBLEMS.eventsNotRead)];
  }
  const out: TfResource[] = [];
  for (const evId of Object.keys(events)) {
    const ev = events[evId];
    const path: Path = [...eventsPath, evId];
    const name = `${fnId}/${evId}`;
    if (
      !isRecord(ev) ||
      isIntrinsic(ev) ||
      typeof ev.Type !== 'string' ||
      ctx.text([...path, 'Type']) === undefined
    ) {
      out.push(make(name, path, {}, problem ?? CFN_PROBLEMS.eventNotRead));
      continue;
    }
    if (ev.Type !== 'SQS' && ev.Type !== 'Kinesis' && ev.Type !== 'DynamoDB') continue;
    const evProps = Object.hasOwn(ev, 'Properties') ? ev.Properties : undefined;
    if (evProps !== undefined && (!isRecord(evProps) || isIntrinsic(evProps))) {
      out.push(make(name, path, {}, problem ?? CFN_PROBLEMS.properties));
      continue;
    }
    const p = evProps ?? {};
    const pBase: Path = [...path, 'Properties'];
    const attrs: Partial<Record<TfAttributeName, TfAttr>> = {};
    if (ev.Type === 'SQS') {
      attrs.event_source_arn = Object.hasOwn(p, 'Queue')
        ? referenceAttr(ctx, 'event_source_arn', p.Queue, [...pBase, 'Queue'])
        : unresolved('event_source_arn', CFN_PROBLEMS.reference, ctx.source(path));
    } else {
      attrs.event_source_arn = unresolved(
        'event_source_arn',
        CFN_PROBLEMS.stream,
        ctx.source(path),
      );
    }
    attrs.function_name = {
      kind: 'reference',
      type: 'aws_lambda_function',
      name: inputText(fnId),
      source: ctx.source(['Resources', fnId]),
    };
    if (Object.hasOwn(p, 'MaximumBatchingWindowInSeconds')) {
      attrs.maximum_batching_window_in_seconds = intAttr(
        ctx,
        'maximum_batching_window_in_seconds',
        p.MaximumBatchingWindowInSeconds,
        [...pBase, 'MaximumBatchingWindowInSeconds'],
      );
    }
    out.push(make(name, path, attrs, problem));
  }
  return out;
}

export interface CfnRead {
  readonly resources: TfResource[];
  /** Set when the whole template is not trusted: the file is then listed as not checked with this reason. */
  readonly unread?: 'cfn-transform' | 'cfn-unreadable';
}

/** The resources of one CloudFormation or SAM document. */
export function readCfn(origin: CfnOrigin): CfnRead {
  const root = origin.document.value;
  if (!isRecord(root)) return { resources: [] };
  const ctx = new Ctx(origin, root);
  // The whole-template checks come first and never depend on Resources: a transform or macro can
  // rewrite or add any resource, so a template with one is listed whether or not it has Resources.
  let templateProblem: string | undefined;
  const transform = own(root, 'Transform');
  const sam = transform === SAM_TRANSFORM;
  if (Object.hasOwn(root, 'Transform') && !sam) templateProblem = CFN_PROBLEMS.transform;
  if (templateProblem === undefined && hasFnTransform(root))
    templateProblem = CFN_PROBLEMS.transform;
  // Resources is required in every template (docs/lookups-b12.txt): a template with none holds nothing to check.
  // One that is present but not a mapping is not read.
  if (!Object.hasOwn(root, 'Resources')) {
    return templateProblem === undefined
      ? { resources: [] }
      : { resources: [], unread: 'cfn-transform' };
  }
  const resourcesNode = root.Resources;
  if (!isRecord(resourcesNode) || isIntrinsic(resourcesNode)) {
    return {
      resources: [],
      unread: templateProblem === undefined ? 'cfn-unreadable' : 'cfn-transform',
    };
  }
  for (const id of Object.keys(resourcesNode)) {
    const r = resourcesNode[id];
    if (!isRecord(r) || typeof r.Type !== 'string') {
      templateProblem ??= CFN_PROBLEMS.noType;
    } else if (r.Type.startsWith('AWS::Serverless::') && !sam) {
      templateProblem ??= CFN_PROBLEMS.samWithoutTransform;
    }
  }

  const unread: CfnRead['unread'] =
    templateProblem === undefined
      ? undefined
      : templateProblem === CFN_PROBLEMS.transform
        ? 'cfn-transform'
        : 'cfn-unreadable';
  const globals: Globals = sam ? globalsTimeout(ctx) : { state: 'absent' };
  const where = { scope: origin.scope, dir: origin.dir };
  const out: TfResource[] = [];
  for (const id of Object.keys(resourcesNode)) {
    const r = resourcesNode[id];
    if (!isRecord(r) || typeof r.Type !== 'string') continue;
    const type = Object.hasOwn(RESOURCE_TYPES, r.Type) ? RESOURCE_TYPES[r.Type] : undefined;
    if (type === undefined) continue;
    let problem = templateProblem;
    if (problem === undefined && Object.hasOwn(r, 'Condition')) problem = CFN_PROBLEMS.condition;
    const hasProps = Object.hasOwn(r, 'Properties');
    const propsNode = hasProps ? r.Properties : {};
    if (problem === undefined && (!isRecord(propsNode) || isIntrinsic(propsNode))) {
      problem = CFN_PROBLEMS.properties;
    }
    const props = isRecord(propsNode) ? propsNode : {};
    const built =
      problem === undefined
        ? resourceAttrs(ctx, r.Type, props, id, sam, globals)
        : { attrs: {} as Partial<Record<TfAttributeName, TfAttr>> };
    out.push({
      type,
      name: inputText(id),
      source: ctx.source(['Resources', id]),
      scope: origin.scope,
      dir: origin.dir,
      form: 'cfn',
      attrs: built.attrs,
      ...(problem === undefined ? {} : { problem: problemOf(problem) }),
    });
    if (r.Type === 'AWS::Serverless::Function' && sam) {
      out.push(...samEvents(ctx, id, props, where, problem));
      if (problem !== undefined && !isRecord(propsNode)) {
        // The function's Properties are not read, so its Events are not known: one mapping stands for them.
        out.push({
          type: 'aws_lambda_event_source_mapping',
          name: inputText(`${id}/Events`),
          source: ctx.source(['Resources', id]),
          scope: origin.scope,
          dir: origin.dir,
          form: 'cfn',
          attrs: {},
          problem: problemOf(problem),
        });
      }
    }
  }
  return unread === undefined ? { resources: out } : { resources: out, unread };
}
