// The T4 inputs: for each Terraform event source mapping, the queue's
// visibility timeout, the function's timeout and the mapping's batching window, each a sourced value or
// unresolved with a fixed reason.
//   - A literal attribute: its value with file and line.
//   - A `visibility_timeout_seconds` or `timeout` that is absent: the Terraform provider's documented
//     default (30 and 3 s), which follows from the file itself (basis `documented`).
//   - An absent `maximum_batching_window_in_seconds` is NOT established: the provider has no default for
//     it (AWS applies 0 for SQS at create, and Terraform does not manage it afterwards). It is the
//     ASSUMED value 0 s (basis `assumed`), listed in Assumptions; a result that rests on it is UNRESOLVED.
//   - The queue and function are linked only by a reference to a resource of the same folder (one Terraform
//     module, bolt B17); anything else is unresolved.
// Nothing here produces a result kind.

import { type Assumption, type ChainStep, makeUnresolved } from '../core/index.js';
import {
  type KbSubject,
  type KnowledgeBase,
  sourcedValueFromEntry,
  unknownInterval,
} from '../kb/index.js';
import { linkMappings, type MappingLink, type MappingLinkReason } from '../link/index.js';
import {
  type IacReadResult,
  TF_PROBLEMS,
  type TfAttributeName,
  type TfResource,
  tfAttr,
} from '../parse/index.js';
import type { QueueInput, ResolvedQueueWorkload } from './model.js';

export const MAPPING_LINK_TEXT: Readonly<Record<MappingLinkReason, string>> = {
  'mapping-block-not-read':
    'the mapping block is not fully read (count, for_each, dynamic, lifecycle or an override)',
  'queue-not-a-reference':
    'the event source is not a reference to an aws_sqs_queue in this folder (a literal ARN, a variable, a stream or another form)',
  'function-not-a-reference':
    'the function is not a reference to an aws_lambda_function in this folder (a name, a variable or another form)',
  'queue-not-found': 'the aws_sqs_queue the mapping names is not in the same folder',
  'function-not-found': 'the aws_lambda_function the mapping names is not in the same folder',
  'several-queues': 'more than one aws_sqs_queue of that name is in the same folder',
  'several-functions': 'more than one aws_lambda_function of that name is in the same folder',
  'folder-not-read':
    'a file of the same folder was not read, so what the mapping names may be declared there',
};

/** The same texts for a CloudFormation or SAM template (bolt B12): the words of the template, never Terraform's. */
export const CFN_LINK_TEXT: Readonly<Record<MappingLinkReason, string>> = {
  'mapping-block-not-read':
    'the event source mapping is not fully read (a transform, a Condition, or Properties or Events that are not a plain mapping)',
  'queue-not-a-reference':
    'the event source is not Fn::GetAtt [queue, Arn] of an AWS::SQS::Queue in this template (a literal ARN, a parameter, a stream or another form)',
  'function-not-a-reference':
    'the function is not a Ref or Fn::GetAtt [function, Arn] of a function in this template (a name, a parameter or another form)',
  'queue-not-found': 'the AWS::SQS::Queue the mapping names is not in this template',
  'function-not-found': 'the function the mapping names is not in this template',
  'several-queues': 'more than one AWS::SQS::Queue of that name is in this template',
  'several-functions': 'more than one function of that name is in this template',
  'folder-not-read': 'a file of the same folder was not read',
};
export const CFN_DECLARE_LINKS =
  'give the mapping EventSourceArn: !GetAtt <Queue>.Arn and FunctionName: !Ref <Function>, in the same template (for a SAM event, Queue: !GetAtt <Queue>.Arn)';
export const CFN_DECLARE_VISIBILITY =
  'write VisibilityTimeout as a literal number in the AWS::SQS::Queue';
export const CFN_DECLARE_TIMEOUT =
  'write Timeout as a literal number in the function (a SAM function may take it from Globals.Function.Timeout)';
export const CFN_DECLARE_WINDOW =
  'write MaximumBatchingWindowInSeconds as a literal number in the mapping (or the SAM SQS event)';
export const CFN_BATCHING_ASSUMPTION: Assumption = {
  text: 'The batching window is assumed to be 0 s where MaximumBatchingWindowInSeconds is not set: AWS applies its own default for the mapping, and the template does not state it.',
  reason: 'no MaximumBatchingWindowInSeconds in the template',
};

export const DECLARE_LINKS =
  'reference the queue (event_source_arn = aws_sqs_queue.<name>.arn) and the function (function_name = aws_lambda_function.<name>.arn) from the mapping, in the same folder';
export const DECLARE_VISIBILITY =
  'write visibility_timeout_seconds as a literal number in the aws_sqs_queue';
export const DECLARE_TIMEOUT = 'write timeout as a literal number in the aws_lambda_function';
export const DECLARE_WINDOW =
  'write maximum_batching_window_in_seconds as a literal number in the aws_lambda_event_source_mapping';

export const BATCHING_ASSUMPTION: Assumption = {
  text: 'The batching window is assumed to be 0 s where maximum_batching_window_in_seconds is not set: the Terraform provider has no default for it, so AWS applies its own default at create and Terraform does not manage it afterwards.',
  reason: 'no maximum_batching_window_in_seconds in the Terraform files',
};

const CFN_SUBJECTS: Readonly<Partial<Record<KbSubject, KbSubject>>> = {
  'terraform-sqs-visibility': 'cfn-sqs-visibility',
  'terraform-lambda-timeout': 'cfn-lambda-timeout',
};

function failed(label: string, reason: string, declare: string): QueueInput {
  const value = makeUnresolved(reason);
  return { value, step: { label, value }, declare: [declare] };
}

function fromAttr(
  label: string,
  resource: TfResource,
  attribute: TfAttributeName,
  kb: KnowledgeBase,
  terraformSubject: KbSubject,
  terraformDeclare: string,
): QueueInput {
  const cfn = resource.form === 'cfn';
  const subject = cfn ? (CFN_SUBJECTS[terraformSubject] ?? terraformSubject) : terraformSubject;
  const declare = cfn
    ? attribute === 'timeout'
      ? CFN_DECLARE_TIMEOUT
      : CFN_DECLARE_VISIBILITY
    : terraformDeclare;
  const attr = tfAttr(resource, attribute);
  if (attr === undefined) {
    const match = kb.lookup(subject, unknownInterval()).matches[0];
    const value = match === undefined ? undefined : sourcedValueFromEntry(match.entry);
    return value === undefined
      ? failed(label, `the knowledge base has no default for ${attribute}`, declare)
      : { value, step: { label, value }, declare: [] };
  }
  if (attr.kind === 'literal') {
    return { value: attr.value, step: { label, value: attr.value }, declare: [] };
  }
  const reason =
    attr.kind === 'unresolved' ? attr.value.reason : `${attribute} is not a literal number`;
  return failed(label, reason, declare);
}

function windowOf(mapping: TfResource, kb: KnowledgeBase): { input: QueueInput; assumed: boolean } {
  const cfn = mapping.form === 'cfn';
  const declareWindow = cfn ? CFN_DECLARE_WINDOW : DECLARE_WINDOW;
  const attr = tfAttr(mapping, 'maximum_batching_window_in_seconds');
  if (attr === undefined) {
    const match = kb.lookup('lambda-sqs-batching-window', unknownInterval()).matches[0];
    const value =
      match === undefined ? undefined : sourcedValueFromEntry(match.entry, { assumed: true });
    if (value === undefined) {
      return {
        input: failed(
          'batching',
          'the knowledge base has no batching window default',
          declareWindow,
        ),
        assumed: false,
      };
    }
    const step: ChainStep = { label: 'batching', detail: 'assumed, not set in the files', value };
    return { input: { value, step, declare: [declareWindow] }, assumed: true };
  }
  if (attr.kind === 'literal') {
    return {
      input: { value: attr.value, step: { label: 'batching', value: attr.value }, declare: [] },
      assumed: false,
    };
  }
  const reason =
    attr.kind === 'unresolved' ? attr.value.reason : 'the batching window is not a literal number';
  return { input: failed('batching', reason, declareWindow), assumed: false };
}

const linkText = (m: TfResource) => (m.form === 'cfn' ? CFN_LINK_TEXT : MAPPING_LINK_TEXT);
const links = (m: TfResource) => (m.form === 'cfn' ? CFN_DECLARE_LINKS : DECLARE_LINKS);

/**
 * Why a mapping is not linked. A template says it exactly (a nested stack, a stream, a parameter, a transform: the
 * reader's own fixed reason); a Terraform mapping keeps the link wording.
 */
function whyNotLinked(
  m: TfResource,
  attribute: TfAttributeName,
  reason: MappingLinkReason,
): string {
  if (m.form === 'cfn') {
    const attr = tfAttr(m, attribute);
    if (attr?.kind === 'unresolved') return attr.value.reason;
  }
  if (m.problem?.reason === TF_PROBLEMS.partialModule) return m.problem.reason;
  return linkText(m)[reason];
}

function resolveOne(link: MappingLink, kb: KnowledgeBase): ResolvedQueueWorkload {
  const m = link.mapping;
  const visibility: QueueInput = link.queue.ok
    ? fromAttr(
        'visibility',
        link.queue.resource,
        'visibility_timeout_seconds',
        kb,
        'terraform-sqs-visibility',
        DECLARE_VISIBILITY,
      )
    : failed('visibility', whyNotLinked(m, 'event_source_arn', link.queue.reason), links(m));
  const functionTimeout: QueueInput = link.fn.ok
    ? fromAttr(
        'timeout',
        link.fn.resource,
        'timeout',
        kb,
        'terraform-lambda-timeout',
        DECLARE_TIMEOUT,
      )
    : failed('timeout', whyNotLinked(m, 'function_name', link.fn.reason), links(m));
  const window = windowOf(m, kb);
  return {
    queue: { mapping: m.name },
    file: m.source,
    visibility,
    functionTimeout,
    batchingWindow: window.input,
    batchingAssumed: window.assumed,
    assumptions: window.assumed
      ? [m.form === 'cfn' ? CFN_BATCHING_ASSUMPTION : BATCHING_ASSUMPTION]
      : [],
  };
}

export function resolveQueueWorkloads(
  iac: IacReadResult,
  kb: KnowledgeBase,
): ResolvedQueueWorkload[] {
  return linkMappings(iac).map((l) => resolveOne(l, kb));
}
