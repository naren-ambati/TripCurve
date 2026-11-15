// The idle timeout of a Terraform `aws_lb`.
//   - a literal `idle_timeout`: that value, with its file and line;
//   - an unresolved one (a variable, an expression, a block with count or for_each ...): unresolved;
//   - an absent one: the Terraform AWS provider's documented default (60), basis `documented`, because
//     Terraform applies and reconciles the default when the attribute is absent, so it follows from the
//     file itself (the same reasoning as the Kubernetes grace default). It is used only for an
//     APPLICATION load balancer: `load_balancer_type` absent is the documented default `application`;
//     any other literal, or one that cannot be read, is unresolved.
// The value comes from the knowledge base, never from this file.

import {
  type ChainStep,
  isInputText,
  makeUnresolved,
  SafeText,
  type SourcedValue,
  type UnresolvedValue,
} from '../core/index.js';
import { type KnowledgeBase, sourcedValueFromEntry, unknownInterval } from '../kb/index.js';
import { type TfResource, tfAttr } from '../parse/index.js';

export const REASON_TF_NOT_APPLICATION =
  'the Terraform load balancer is not an application load balancer';
export const REASON_TF_NO_DEFAULT =
  'the knowledge base has no entry for the Terraform idle default';

export interface TerraformIdle {
  readonly value: SourcedValue | UnresolvedValue;
  readonly steps: readonly ChainStep[];
}

export function terraformIdle(resource: TfResource, kb: KnowledgeBase): TerraformIdle {
  const fail = (reason: string): TerraformIdle => {
    const value = makeUnresolved(reason);
    return { value, steps: [{ label: 'LB idle', value }] };
  };
  const type = tfAttr(resource, 'load_balancer_type');
  if (type !== undefined) {
    if (type.kind === 'unresolved') return fail(type.value.reason);
    if (
      type.kind !== 'literal' ||
      !isInputText(type.value.value) ||
      SafeText.render(type.value.value, 'json') !== 'application'
    ) {
      return fail(REASON_TF_NOT_APPLICATION);
    }
  }
  const idle = tfAttr(resource, 'idle_timeout');
  if (idle === undefined) {
    const match = kb.lookup(
      resource.form === 'cfn' ? 'cfn-lb-idle-timeout' : 'terraform-lb-idle-timeout',
      unknownInterval(),
    ).matches[0];
    const value = match === undefined ? undefined : sourcedValueFromEntry(match.entry);
    if (value === undefined) return fail(REASON_TF_NO_DEFAULT);
    return { value, steps: [{ label: 'LB idle', value }] };
  }
  if (idle.kind === 'unresolved') return fail(idle.value.reason);
  if (idle.kind !== 'literal') return fail('idle_timeout is not a literal number');
  return { value: idle.value, steps: [{ label: 'LB idle', value: idle.value }] };
}
