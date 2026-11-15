// The Kubernetes models. Everything that came from a file is
// an InputText or a SourcedValue (value, unit, source, basis); a value that
// could not be established is an UnresolvedValue, never a default. Secret data
// and `valueFrom` references are not fields of any model.

import type { InputText, SourcedValue, SourceRef, UnresolvedValue } from '../../core/index.js';
import type { K8sWorkloadKind } from '../../core/vocab.js';
import type { ReaderUnresolved } from '../reader-result.js';

export type Maybe = SourcedValue | UnresolvedValue;

/** A label or selector entry. The key is input text; a value that is not text is unresolved. */
export interface K8sPair {
  readonly key: InputText;
  readonly value: Maybe;
}

export interface K8sPort {
  readonly name?: SourcedValue;
  /** A number of unit `none`, or unresolved when it is not an integer. */
  readonly containerPort?: Maybe;
  readonly source: SourceRef;
}

export interface K8sEnvVar {
  readonly name: InputText;
  /** A literal, or unresolved (`valueFrom`, or a value that is not text). */
  readonly value: Maybe;
  readonly source: SourceRef;
}

export type K8sStringList =
  | { readonly items: readonly SourcedValue[]; readonly source: SourceRef }
  | UnresolvedValue;

/**
 * A preStop hook. The two exec forms and the sleep handler are a delay
 * of N seconds; any other hook is of unresolved duration.
 */
export type K8sPreStop =
  | {
      readonly form: 'exec-sleep' | 'exec-shell-sleep' | 'sleep-handler';
      /** Seconds, unit `s`. */
      readonly delay: SourcedValue;
      readonly source: SourceRef;
    }
  | { readonly form: 'hook'; readonly delay: UnresolvedValue; readonly source: SourceRef };

export interface K8sContainer {
  readonly name: InputText;
  readonly source: SourceRef;
  readonly image?: Maybe;
  readonly command?: K8sStringList;
  readonly args?: K8sStringList;
  readonly env: readonly K8sEnvVar[];
  /**
   * Set when the container has `envFrom`: variables may come from a config map
   * or secret that tripcurve does not read, so an env variable that is absent
   * here is not known to be absent.
   */
  readonly envFromSource?: SourceRef;
  /**
   * Set when the container sets a non-empty `workingDir`. Then a relative path in
   * its command cannot be mapped to a repository folder.
   */
  readonly workingDirSource?: SourceRef;
  readonly ports: readonly K8sPort[];
  readonly preStop?: K8sPreStop;
}

export interface K8sWorkload {
  /** From the fixed list; never the input's own string. */
  readonly kind: K8sWorkloadKind;
  readonly name: InputText;
  /** `default` when the object names none (what Kubernetes does); see `namespaceDeclared`. */
  readonly namespace: InputText;
  readonly namespaceDeclared: boolean;
  /** Where the object starts (its `kind` line, or its place in a List). */
  readonly source: SourceRef;
  readonly labels: readonly K8sPair[];
  /** The labels of the pod template (of the object itself for a bare Pod): what a Service selector matches. */
  readonly podLabels: readonly K8sPair[];
  /** `spec.selector.matchLabels`; matchExpressions are not read. */
  readonly selectorMatchLabels?: readonly K8sPair[];
  readonly containers: readonly K8sContainer[];
  /** `terminationGracePeriodSeconds`; absent when the object sets none (the default is the knowledge base's). */
  readonly gracePeriod?: Maybe;
  /** Another object of the same kind, namespace and name was read: both are kept. */
  readonly duplicate: boolean;
  /** The Helm `# Source:` comment text of the document the object came from (standard input only in practice). */
  readonly helmSource?: InputText;
}

export interface K8sBackendPort {
  readonly number?: Maybe;
  readonly name?: SourcedValue;
}

export interface K8sBackend {
  readonly serviceName: InputText;
  readonly port?: K8sBackendPort;
  readonly source: SourceRef;
}

export const INGRESS_RECOGNITIONS = [
  'ingress-class-name',
  'legacy-annotation',
  'ingress-class-object',
  'alb-annotation',
] as const;
export type IngressRecognition = (typeof INGRESS_RECOGNITIONS)[number];

/** An Ingress recognised as an ALB Ingress. Others are K8sUncheckedKind. */
export interface K8sIngress {
  readonly name: InputText;
  readonly namespace: InputText;
  readonly namespaceDeclared: boolean;
  readonly source: SourceRef;
  /** Why it counts as an ALB Ingress. */
  readonly recognisedBy: IngressRecognition;
  readonly ingressClassName?: SourcedValue;
  /** The legacy `kubernetes.io/ingress.class` annotation. */
  readonly legacyClass?: SourcedValue;
  /** `idle_timeout.timeout_seconds` from `load-balancer-attributes`, seconds; unresolved when the list is malformed or ambiguous. */
  readonly idleTimeout?: Maybe;
  /** `target-type`: a fixed word (`ip` or `instance`), or unresolved for any other text. */
  readonly targetType?: Maybe;
  /** `load-balancer-name`, as written. */
  readonly loadBalancerName?: Maybe;
  /**
   * `group.name`, as written: Ingresses that share it share ONE ALB (an
   * IngressGroup), and members can exist outside the checked files.
   */
  readonly groupName?: Maybe;
  readonly backends: readonly K8sBackend[];
  readonly duplicate: boolean;
}

/**
 * An Ingress that names another controller's class (`ingressClassName`, or the
 * legacy annotation, not `alb` and not an IngressClass for the AWS controller)
 * yet carries `alb.ingress.kubernetes.io/*` annotations. It is NOT an ALB
 * Ingress, but the conflict is kept so the workloads behind it are reported
 * unresolved rather than read as if no load balancer reached them.
 */
export interface K8sClassConflictIngress {
  readonly name: InputText;
  readonly namespace: InputText;
  readonly namespaceDeclared: boolean;
  readonly source: SourceRef;
  readonly backends: readonly K8sBackend[];
  readonly duplicate: boolean;
  /** `alb-annotations`: another controller's class with ALB annotations; `two-classes`: the class field and the legacy annotation name different classes. */
  readonly conflict: 'alb-annotations' | 'two-classes';
}

export interface K8sServicePort {
  readonly name?: SourcedValue;
  readonly port?: Maybe;
  /** A number (a port) or an InputText (a port name); absent means the same as `port`. */
  readonly targetPort?: Maybe;
  readonly source: SourceRef;
}

export interface K8sService {
  readonly name: InputText;
  readonly namespace: InputText;
  readonly namespaceDeclared: boolean;
  readonly source: SourceRef;
  /** Absent when the Service has no selector. */
  readonly selector?: readonly K8sPair[];
  readonly ports: readonly K8sServicePort[];
  /** `spec.type`: a fixed word for the four known types, otherwise input text. */
  readonly type?: Maybe;
  /** `service.beta.kubernetes.io/aws-load-balancer-type`: a fixed word for `external`, `nlb`, `nlb-ip`, otherwise input text. */
  readonly awsLoadBalancerType?: Maybe;
  /** `service.beta.kubernetes.io/aws-load-balancer-nlb-target-type`: `ip` or `instance`, otherwise input text. */
  readonly awsNlbTargetType?: Maybe;
  /** `service.beta.kubernetes.io/aws-load-balancer-attributes`, as written; not parsed (T1 for an NLB is unresolved whatever it says). */
  readonly awsLoadBalancerAttributes?: Maybe;
  readonly duplicate: boolean;
}

/** The AWS Load Balancer Controller's name in `IngressClass` `spec.controller`. */
export const ALB_INGRESS_CONTROLLER = 'ingress.k8s.aws/alb';

export interface K8sIngressClass {
  readonly name: InputText;
  readonly source: SourceRef;
  readonly controller?: Maybe;
  /** `spec.controller` is exactly `ingress.k8s.aws/alb`. */
  readonly isAlbController: boolean;
  readonly duplicate: boolean;
}

export const UNCHECKED_KIND_REASONS = ['not-alb-ingress', 'kind-not-checked'] as const;
export type UncheckedKindReason = (typeof UNCHECKED_KIND_REASONS)[number];

/** Gateway API kinds, listed as kinds not checked. */
export const GATEWAY_API_KINDS = [
  'Gateway',
  'GatewayClass',
  'HTTPRoute',
  'GRPCRoute',
  'TCPRoute',
  'TLSRoute',
  'UDPRoute',
] as const;
export type GatewayApiKind = (typeof GATEWAY_API_KINDS)[number];

/**
 * An Ingress that is not an ALB Ingress, or a kind tripcurve does not check.
 * `kind` is one of tripcurve's own words, chosen by exact match, never the
 * input's string; `name` and `namespace` are input text.
 */
export interface K8sUncheckedKind {
  readonly kind: 'Ingress' | GatewayApiKind;
  readonly reasonCode: UncheckedKindReason;
  readonly name?: InputText;
  readonly namespace?: InputText;
  readonly source: SourceRef;
}

export interface K8sReadResult {
  readonly workloads: readonly K8sWorkload[];
  readonly ingresses: readonly K8sIngress[];
  /** Ingresses with another controller's class and ALB annotations; see K8sClassConflictIngress. */
  readonly classConflictIngresses: readonly K8sClassConflictIngress[];
  readonly services: readonly K8sService[];
  readonly ingressClasses: readonly K8sIngressClass[];
  readonly uncheckedKinds: readonly K8sUncheckedKind[];
  readonly unresolved: readonly ReaderUnresolved[];
}
