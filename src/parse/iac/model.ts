// The Terraform models. Only four resource types and eight attributes are read, all as
// literals; anything else is an unresolved value with a fixed reason. Nothing here is a default: a
// missing attribute is simply absent, and the resolver decides (with a knowledge-base citation) what
// absence means.

import {
  type InputText,
  makeUnresolved,
  type SourcedValue,
  type SourceRef,
  type UnresolvedValue,
} from '../../core/index.js';

export const TF_TYPES = [
  'aws_lb',
  'aws_sqs_queue',
  'aws_lambda_function',
  'aws_lambda_event_source_mapping',
] as const;
export type TfType = (typeof TF_TYPES)[number];

export function tfTypeFromInput(text: string): TfType | undefined {
  return TF_TYPES.find((t) => t === text);
}

/** The attributes read per type. `name` and `load_balancer_type` serve the by-name link and the ALB check. */
export const TF_ATTRIBUTES: Readonly<Record<TfType, readonly string[]>> = {
  aws_lb: ['idle_timeout', 'name', 'load_balancer_type'],
  aws_sqs_queue: ['visibility_timeout_seconds'],
  aws_lambda_function: ['timeout'],
  aws_lambda_event_source_mapping: [
    'maximum_batching_window_in_seconds',
    'event_source_arn',
    'function_name',
  ],
};

export type TfAttributeName =
  | 'idle_timeout'
  | 'name'
  | 'load_balancer_type'
  | 'visibility_timeout_seconds'
  | 'timeout'
  | 'maximum_batching_window_in_seconds'
  | 'event_source_arn'
  | 'function_name';

/** Attributes read as whole numbers of seconds, with the documented range of each (docs/lookups-b5.txt; ALB range: core/limits.ts). */
export const TF_INT_RANGES: Readonly<
  Record<string, { readonly min: number; readonly max: number }>
> = {
  idle_timeout: { min: 1, max: 4000 },
  visibility_timeout_seconds: { min: 0, max: 43_200 },
  timeout: { min: 1, max: 900 },
  maximum_batching_window_in_seconds: { min: 0, max: 300 },
};

/** Attributes read as a reference, and the types and attributes a reference may name. */
export const TF_REFERENCES: Readonly<
  Record<string, { readonly type: TfType; readonly attributes: readonly string[] }>
> = {
  event_source_arn: { type: 'aws_sqs_queue', attributes: ['arn'] },
  function_name: {
    type: 'aws_lambda_function',
    attributes: ['arn', 'function_name', 'qualified_arn'],
  },
};

export type TfAttr =
  | { readonly kind: 'literal'; readonly value: SourcedValue }
  | {
      readonly kind: 'reference';
      readonly type: TfType;
      readonly name: InputText;
      readonly source: SourceRef;
    }
  | { readonly kind: 'unresolved'; readonly value: UnresolvedValue; readonly source: SourceRef };

export interface TfResource {
  readonly type: TfType;
  /** The resource label (`orders` in `aws_sqs_queue.orders`). */
  readonly name: InputText;
  /** Where the block starts. */
  readonly source: SourceRef;
  /**
   * The line of the closing brace, for a block read from HCL. An inline waiver comment attaches to
   * the resource whose lines, from `source` to here, contain it. Absent for
   * JSON and plan resources, which carry no comments.
   */
  readonly endLine?: number;
  /** One file (or one standard-input document): a reference links only inside its scope. */
  readonly scope: string;
  /** The folder of the file, root-relative (`''` for the root): an override file changes only its own folder. */
  readonly dir: string;
  /**
   * `plan`: values from `terraform show -json`; `hcl` and `json`: written in source; `cfn`: a CloudFormation or
   * SAM template (bolt B12), read into the same types: `name` is the logical id (a SAM event: `<function>/<event>`).
   */
  readonly form: 'hcl' | 'json' | 'plan' | 'cfn';
  readonly attrs: Readonly<Partial<Record<TfAttributeName, TfAttr>>>;
  /** The block is not fully read (count, for_each, dynamic, lifecycle, override): every attribute is unresolved with this. */
  readonly problem?: UnresolvedValue;
}

export const TF_PROBLEMS = {
  countOrForEach: 'the block uses count or for_each, so it stands for several instances',
  dynamic: 'the block has a dynamic block',
  lifecycle: 'the block has a lifecycle setting tripcurve does not read',
  override: 'an override file changes this resource',
  partialModule:
    'only one file of the module was given; check the folder (a sibling file may override or declare it)',
  declaredTwice: 'the same Terraform resource is declared twice',
  duplicate: 'is written more than once',
  notInteger:
    'is not a whole number written as a literal (a variable, a function, an expression with anything but integer literals, or another form)',
  notString: 'is not a plain string literal',
  notReference: 'is not a plain reference tripcurve follows',
  notInPlan: 'is not a known value in the plan or state',
} as const;

export function problemOf(text: string): UnresolvedValue {
  return makeUnresolved(text);
}

/** The attribute as the resolver sees it: a block with a problem has only unresolved attributes; undefined is absent. */
export function tfAttr(resource: TfResource, name: TfAttributeName): TfAttr | undefined {
  if (resource.problem !== undefined) {
    return { kind: 'unresolved', value: resource.problem, source: resource.source };
  }
  return resource.attrs[name];
}

/**
 * The module a resource belongs to, which is where a reference can find its target (bolt B17). Terraform reads
 * every `.tf` and `.tf.json` file of one folder as one module and treats nested folders as separate modules, so a
 * resource read from source is in the module of its folder. A plan document, a state and a CloudFormation or SAM
 * template are each one module by themselves (their `scope`). The prefix keeps a folder from ever equalling a scope.
 */
export function moduleOf(resource: TfResource): string {
  return resource.form === 'hcl' || resource.form === 'json'
    ? `\u0001folder\u0000${resource.dir}`
    : resource.scope;
}

export function resourceKey(resource: TfResource, raw: (t: InputText) => string): string {
  return `${resource.type}.${raw(resource.name)}`;
}

/** The fixed reasons of the CloudFormation and SAM reader (bolt B12). Never an input text. */
export const CFN_PROBLEMS = {
  transform:
    'the template uses a transform or macro other than AWS::Serverless-2016-10-31 (or Fn::Transform), which can rewrite its resources',
  noType: 'the template has a resource without a readable Type, so it is not trusted',
  samWithoutTransform: 'the template has an AWS::Serverless resource but not the SAM transform',
  condition: 'the resource has a Condition, so it may not exist',
  properties: 'the resource Properties are not a plain mapping',
  eventNotRead: 'the SAM event is not a plain mapping with a literal Type',
  eventsNotRead: 'the SAM Events are not a plain mapping',
  globals:
    'the SAM Globals section is not in a form tripcurve reads fully (a Globals.Function that is not a plain mapping, or an intrinsic function in it)',
  notInteger:
    'is not a whole number written as a literal (a parameter, an intrinsic function, a quoted number or another form)',
  parameter:
    'refers to a template parameter (parameter files are not read, and a deploy can override a default)',
  intrinsic: 'uses an intrinsic function, a condition or a tag that tripcurve does not evaluate',
  reference: 'is not a reference tripcurve follows',
  stream:
    'is a stream (Kinesis or DynamoDB), which tripcurve does not follow: only an SQS queue is',
  nestedStack: 'refers to a nested stack, which is not read',
  notInTemplate: 'refers to something that is not a resource of this template',
  wrongType: 'refers to a resource of another type',
  duplicate: 'is written more than once',
  attributesNotRead:
    'LoadBalancerAttributes is not a plain list of Key and Value entries, so the idle timeout is not known',
  keyNotLiteral:
    'a LoadBalancerAttributes entry has a Key that is not a literal, so it could be the idle timeout',
} as const;

/** The CloudFormation property each internal attribute name stands for, for the reasons printed. */
export const CFN_PROPERTY: Readonly<Record<TfAttributeName, string>> = {
  idle_timeout: 'the load balancer idle timeout attribute',
  name: 'Name',
  load_balancer_type: 'Type',
  visibility_timeout_seconds: 'VisibilityTimeout',
  timeout: 'Timeout',
  maximum_batching_window_in_seconds: 'MaximumBatchingWindowInSeconds',
  event_source_arn: 'EventSourceArn',
  function_name: 'FunctionName',
};
