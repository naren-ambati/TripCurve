// The load balancer idle timeout.
//
//   an annotation value, or a declaration       -> that value, with its source;
//   an annotation and a declaration that differ -> unresolved, both shown;
//   a malformed or ambiguous annotation         -> unresolved with the reader's reason;
//   nothing in any file                         -> the documented default as an ASSUMED
//                                                  value (basis `assumed`): the console can
//                                                  change it outside Git, so its absence from
//                                                  the files does not establish it;
//   an NLB Service                              -> unresolved, `no measured evidence for NLBs`;
//   a declared Terraform link                   -> the aws_lb's idle_timeout (or the provider default), established (B5);
//   a Terraform aws_lb reached only by the Ingress load-balancer-name
//                                               -> its value as an ASSUMPTION: never PASS or FAIL.
// The documented value comes from the knowledge base, never from this file.

import {
  type Assumption,
  type ChainStep,
  defaultSource,
  type InputText,
  inputTextEquals,
  isDocumentedAlbIdle,
  isSourcedValue,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  REASON_ALB_IDLE_OUT_OF_RANGE,
  SafeText,
  type SourcedValue,
  type SourceRef,
  type UnresolvedValue,
} from '../core/index.js';
import { type KnowledgeBase, sourcedValueFromEntry, unknownInterval } from '../kb/index.js';
import type { LbPath, TfLbUnresolvedReason, WorkloadChain } from '../link/index.js';
import { rawInputTextForParser } from '../parse/index.js';
import type { ResolvedLb } from './model.js';
import { terraformIdle } from './terraform-lb.js';

export const REASON_NLB = 'no measured evidence for NLBs';
export const REASON_CLASS_CONFLICT =
  'Ingress class names another controller but carries ALB annotations';
export const REASON_TWO_CLASSES = 'the Ingress names two different classes';
export const REASON_SEVERAL_LBS = 'more than one load balancer reaches this workload';
export const REASON_DECLARED_LB_NOT_BEHIND =
  'a load balancer declared for this workload in tripcurve.yaml is not one that reaches it';
export const REASON_TF_NOT_READ =
  'a Terraform file could not be read, so the Terraform load balancer is not known';
export const REASON_TF_NO_RESOURCE =
  'no aws_lb of the declared name was found in the Terraform files';
export const REASON_TF_SEVERAL = 'more than one aws_lb in the Terraform files matches';
export const REASON_TF_NAME_NOT_LITERAL =
  'an aws_lb in the Terraform files has a name that is not a literal, so no one aws_lb can be matched by name';
export const DECLARE_TERRAFORM_LB =
  'declare load_balancer.terraform for this workload in tripcurve.yaml, naming the aws_lb';
const TF_REASONS: Readonly<Record<TfLbUnresolvedReason, string>> = {
  'terraform-not-read': REASON_TF_NOT_READ,
  'no-resource': REASON_TF_NO_RESOURCE,
  'several-resources': REASON_TF_SEVERAL,
  'name-not-literal': REASON_TF_NAME_NOT_LITERAL,
};
export const REASON_ANNOTATION_TERRAFORM_DIFFER =
  'the annotation and the Terraform load balancer linked by name give different idle timeouts';
export const REASON_ANNOTATION_DECLARATION_DIFFER =
  'the annotation and the declaration give different idle timeouts';
/**
 * Ingresses that share `group.name` (or repeat a `load-balancer-name`) share one ALB;
 * `load-balancer-attributes` has Exclusive merge semantics, so conflicting values make the
 * controller fail for the whole group, and members can exist outside the checked files.
 * Source: https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
 * (read 2026-11-11).
 */
export const REASON_SHARED_ALB =
  'shared ALB (IngressGroup); members outside these files may set the idle timeout';
export const DECLARE_LB_SHARED =
  'declare load_balancer.idle_timeout_s for this workload in tripcurve.yaml with the idle timeout the shared ALB has';
export const REASON_NO_KB_ENTRY =
  'the knowledge base has no entry for the load balancer idle default';

export const DECLARE_LB_IDLE =
  'set idle_timeout.timeout_seconds in the Ingress annotation alb.ingress.kubernetes.io/load-balancer-attributes, or declare load_balancer.idle_timeout_s for this workload in tripcurve.yaml';
export const DECLARE_LB_DISAGREEMENT =
  'make the annotation and the declared idle_timeout_s agree, or remove one of them';

export interface LbIdleResult {
  readonly lb: ResolvedLb;
  readonly assumptions: readonly Assumption[];
}

/**
 * Input text quoted through SafeText and cut to a length an assumption line can hold. The report keeps a
 * quoted run unbreakable and off the start of a line when it wraps the line (report/human.ts), so the
 * text here reads exactly as the same input does in a chain line, spaces included.
 */
const ASSUMPTION_QUOTE_ROOM = 36;
function unbreakable(text: InputText): string {
  return SafeText.render(text, 'terminal', { maxLength: ASSUMPTION_QUOTE_ROOM });
}

/** `"file":line`, quoted through SafeText, or the stream place-holder. */
function sourceText(source: SourceRef): string {
  switch (source.type) {
    case 'file':
    case 'declared':
      return `${unbreakable(source.file)}:${source.line}`;
    case 'stdin':
      return `<stdin> document ${source.document}, line ${source.line}`;
    case 'default':
      return source.citation;
  }
}

function pathKey(p: LbPath): string {
  const ns = rawInputTextForParser(p.kind === 'nlb' ? p.service.namespace : p.ingress.namespace);
  const name = rawInputTextForParser(p.kind === 'nlb' ? p.service.name : p.ingress.name);
  return `${p.kind}\u0000${ns}\u0000${name}`;
}

function unresolvedLb(
  kind: ResolvedLb['kind'],
  reason: string,
  declare: readonly string[],
  steps: readonly ChainStep[] = [],
): LbIdleResult {
  const value = makeUnresolved(reason, declare[0]);
  return {
    lb: {
      kind,
      lbIdle: value,
      lbIdleSteps: steps.length > 0 ? steps : [{ label: 'LB idle', value }],
      declare,
    },
    assumptions: [],
  };
}

export function resolveLbIdle(chain: WorkloadChain, kb: KnowledgeBase): LbIdleResult {
  const distinct = new Map<string, LbPath>();
  for (const p of chain.paths) if (!distinct.has(pathKey(p))) distinct.set(pathKey(p), p);
  const paths = [...distinct.values()];

  const only = paths[0];
  if (only === undefined) return unresolvedLb('alb', REASON_SEVERAL_LBS, []);
  // A conflicting class decides before anything else: no idle value read from such
  // an Ingress, or assumed, may support a result.
  const conflict = paths.find((p) => p.kind === 'class-conflict');
  if (conflict !== undefined) {
    const two = conflict.kind === 'class-conflict' && conflict.ingress.conflict === 'two-classes';
    return unresolvedLb('alb', two ? REASON_TWO_CLASSES : REASON_CLASS_CONFLICT, []);
  }
  if (paths.length > 1) return unresolvedLb('several', REASON_SEVERAL_LBS, []);
  if (only.kind === 'nlb') return unresolvedLb('nlb', REASON_NLB, []);
  if (only.kind === 'class-conflict') return unresolvedLb('alb', REASON_CLASS_CONFLICT, []); // narrowing only

  const targetType = only.ingress.targetType;
  const withTarget = <T extends LbIdleResult>(r: T): T =>
    targetType === undefined ? r : ({ ...r, lb: { ...r.lb, targetType } } as T);

  if (chain.declaredLbMismatch) {
    return withTarget(unresolvedLb('alb', REASON_DECLARED_LB_NOT_BEHIND, [DECLARE_LB_IDLE]));
  }
  const annotation = only.ingress.idleTimeout;
  const declaredLink = chain.links.find(
    (l) =>
      l.kind === 'load_balancer' &&
      l.loadBalancer?.form === 'ingress' &&
      l.loadBalancer.idleTimeoutS !== undefined &&
      inputTextEquals(l.target, only.ingress.name),
  );
  const tf = chain.terraformLb;
  let tfDeclared: { value: SourcedValue; steps: readonly ChainStep[] } | undefined;
  if (tf !== undefined && tf.by === 'declared') {
    if (tf.state === 'unresolved') {
      return withTarget(unresolvedLb('alb', TF_REASONS[tf.reason], [DECLARE_TERRAFORM_LB]));
    }
    const idle = terraformIdle(tf.resource, kb);
    const link: ChainStep = {
      label: 'LB link',
      value: makeSourcedValue({
        value: tf.target,
        unit: 'none',
        source: tf.evidence,
        basis: 'declared',
      }),
    };
    if (isUnresolved(idle.value)) {
      return withTarget(
        unresolvedLb('alb', idle.value.reason, [DECLARE_LB_IDLE], [link, ...idle.steps]),
      );
    }
    tfDeclared = { value: idle.value, steps: [link, ...idle.steps] };
  }
  const declared: SourcedValue | undefined =
    tfDeclared?.value ?? declaredLink?.loadBalancer?.idleTimeoutS;

  // A shared ALB: its idle timeout is not established by this Ingress's annotation, and no
  // default is assumed for it. Only a declaration that states the idle value settles it, and
  // then the usual annotation-versus-declaration rule applies.
  if (only.sharedAlb && declared === undefined) {
    return withTarget(unresolvedLb('alb', REASON_SHARED_ALB, [DECLARE_LB_SHARED]));
  }

  if (annotation !== undefined && isUnresolved(annotation)) {
    return withTarget(
      unresolvedLb(
        'alb',
        annotation.reason,
        [DECLARE_LB_IDLE],
        [{ label: 'LB idle', value: annotation }],
      ),
    );
  }
  const read: SourcedValue | undefined =
    annotation !== undefined && isSourcedValue(annotation) ? annotation : undefined;

  // A declared value outside the documented range is not a value an ALB can have (m3).
  // The annotation was checked by the reader; the declaration is checked here.
  if (
    declared !== undefined &&
    !(typeof declared.value === 'number' && isDocumentedAlbIdle(declared.value))
  ) {
    const value = makeUnresolved(REASON_ALB_IDLE_OUT_OF_RANGE, DECLARE_LB_IDLE);
    return withTarget(
      unresolvedLb(
        'alb',
        REASON_ALB_IDLE_OUT_OF_RANGE,
        [DECLARE_LB_IDLE],
        [{ label: 'LB idle', detail: 'declared', value }],
      ),
    );
  }

  if (read !== undefined && declared !== undefined) {
    if (read.value !== declared.value || read.unit !== declared.unit) {
      const value: UnresolvedValue = makeUnresolved(
        REASON_ANNOTATION_DECLARATION_DIFFER,
        DECLARE_LB_DISAGREEMENT,
      );
      return withTarget({
        lb: {
          kind: 'alb',
          lbIdle: value,
          lbIdleSteps: [
            { label: 'LB idle', detail: 'annotation', value: read },
            ...(tfDeclared?.steps ?? [{ label: 'LB idle', detail: 'declared', value: declared }]),
          ],
          declare: [DECLARE_LB_DISAGREEMENT],
        },
        assumptions: [],
      });
    }
  }
  // An annotation that gives one idle timeout and a Terraform aws_lb (reached only by name) that gives
  // another: the link is an assumption, so neither is trusted over the other; both are shown.
  if (read !== undefined && declared === undefined && tf !== undefined && tf.by === 'name') {
    if (tf.state === 'linked') {
      const idle = terraformIdle(tf.resource, kb);
      if (
        isSourcedValue(idle.value) &&
        (idle.value.value !== read.value || idle.value.unit !== read.unit)
      ) {
        const value = makeUnresolved(REASON_ANNOTATION_TERRAFORM_DIFFER, DECLARE_LB_DISAGREEMENT);
        return withTarget({
          lb: {
            kind: 'alb',
            lbIdle: value,
            lbIdleSteps: [{ label: 'LB idle', detail: 'annotation', value: read }, ...idle.steps],
            declare: [DECLARE_LB_DISAGREEMENT],
          },
          assumptions: [],
        });
      }
    }
  }
  const established = read ?? declared;
  if (established !== undefined) {
    return withTarget({
      lb: {
        kind: 'alb',
        lbIdle: established,
        lbIdleSteps:
          established === tfDeclared?.value
            ? tfDeclared.steps
            : [{ label: 'LB idle', value: established }],
        declare: [],
      },
      assumptions: [],
    });
  }

  // A Terraform aws_lb reached only by the Ingress `load-balancer-name` annotation: an assumption.
  if (tf !== undefined && tf.by === 'name') {
    if (tf.state === 'unresolved') {
      return withTarget(unresolvedLb('alb', TF_REASONS[tf.reason], [DECLARE_TERRAFORM_LB]));
    }
    const idle = terraformIdle(tf.resource, kb);
    const marker: ChainStep = {
      label: 'LB link',
      value: makeSourcedValue({
        value: 'by name',
        unit: 'none',
        source: defaultSource({
          citation: 'Terraform load balancer linked by name',
          basisText: 'assumed',
          bare: true,
        }),
        basis: 'assumed',
      }),
    };
    if (isUnresolved(idle.value)) {
      return withTarget(
        unresolvedLb('alb', idle.value.reason, [DECLARE_TERRAFORM_LB], [...idle.steps, marker]),
      );
    }
    const text = `Terraform load balancer linked by name: the load-balancer-name annotation value ${unbreakable(tf.annotation.value as InputText)} at ${sourceText(tf.annotation.source)} equals the name of aws_lb ${unbreakable(tf.resource.name)} at ${sourceText(tf.name.source)}. The controller applies the name only when it creates a load balancer, and a Terraform-owned one is normally joined by TargetGroupBinding, which tripcurve does not read, so the link is assumed.`;
    return withTarget({
      lb: {
        kind: 'alb',
        lbIdle: idle.value,
        lbIdleSteps: [...idle.steps, marker],
        declare: [DECLARE_TERRAFORM_LB],
        assumedFrom: 'terraform-name',
      },
      assumptions: [{ text, reason: 'a Terraform aws_lb is linked to the Ingress by name only' }],
    });
  }

  // Nothing in any file: the documented default, as an assumption.
  const match = kb.lookup('alb-idle-timeout', unknownInterval()).matches[0];
  const assumed =
    match === undefined ? undefined : sourcedValueFromEntry(match.entry, { assumed: true });
  if (assumed === undefined)
    return withTarget(unresolvedLb('alb', REASON_NO_KB_ENTRY, [DECLARE_LB_IDLE]));
  return withTarget({
    lb: {
      kind: 'alb',
      lbIdle: assumed,
      lbIdleSteps: [{ label: 'LB idle', detail: 'assumed, not set in the files', value: assumed }],
      declare: [DECLARE_LB_IDLE],
    },
    assumptions: [
      {
        text: `The load balancer idle timeout is assumed to be the documented default of ${String(assumed.value)} s, because no file or declaration sets it; the console can change it outside Git.`,
        reason: 'no idle_timeout.timeout_seconds in the files or in tripcurve.yaml',
      },
    ],
  });
}
