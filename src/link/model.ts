// The config graph (ConfigGraphOutputs, ConfigGraphLinker).
// Linking uses explicit evidence only: selectors, backend
// references, declared links and files a command names. Anything else is
// unresolved or listed as not checked. Nothing here picks a value or a verdict.

import type { InputText, SourcedValue, SourceRef, WorkloadRef } from '../core/index.js';
import type { WorkloadKind } from '../core/vocab.js';
import type {
  ConfigError,
  ConfigLink,
  Declaration,
  GatewayApiKind,
  InputFile,
  K8sClassConflictIngress,
  K8sContainer,
  K8sIngress,
  K8sService,
  K8sWorkload,
  NodePreloads,
  StdinPath,
} from '../parse/index.js';
import type { GunicornConfigLink } from './gunicorn-config-link.js';
import type { TerraformLbLink } from './terraform-link.js';

/** How a load balancer reaches a workload. */
export type LbPath =
  | {
      readonly kind: 'alb';
      readonly ingress: K8sIngress;
      readonly service: K8sService;
      /**
       * The Ingress shares one ALB with others (a `group.name`, or a `load-balancer-name`
       * another Ingress in the files repeats), so its own annotation does not set that
       * ALB's idle timeout on its own.
       */
      readonly sharedAlb: boolean;
    }
  | {
      /** An Ingress with another controller's class but ALB annotations: not an ALB, not trusted as one. */
      readonly kind: 'class-conflict';
      readonly ingress: K8sClassConflictIngress;
      readonly service: K8sService;
    }
  | {
      readonly kind: 'nlb';
      readonly service: K8sService;
      /** The `aws-load-balancer-type` value that makes the Service an NLB (a fixed word). */
      readonly nlbType: SourcedValue;
    };

export const NOT_CHECKED_REASONS = [
  'no-recognised-lb',
  'not-alb-ingress',
  'kind-not-checked',
] as const;
export type NotCheckedReason = (typeof NOT_CHECKED_REASONS)[number];

/** NotCheckedItem. `subject` is absent when the object names none. */
export interface NotCheckedItem {
  readonly subjectKind: 'workload' | 'ingress' | 'kind';
  readonly subject?: InputText;
  /** One of tripcurve's own kind words (never the input's string). */
  readonly kind: WorkloadKind | 'Ingress' | GatewayApiKind;
  readonly file: InputText | StdinPath;
  readonly line?: number;
  readonly reasonCode: NotCheckedReason;
}

/** Why a container could not be chosen: fixed codes, no input text. */
export const CONTAINER_UNRESOLVED_REASONS = [
  'no-container-matches',
  'several-containers-match',
  'port-not-readable',
  'backend-port-not-named',
  'service-port-not-found',
] as const;
export type ContainerUnresolvedReason = (typeof CONTAINER_UNRESOLVED_REASONS)[number];

export type ContainerLink =
  | { readonly state: 'determined'; readonly container: K8sContainer }
  | { readonly state: 'unresolved'; readonly reasonCode: ContainerUnresolvedReason };

export const SOURCE_UNLINKED_REASONS = [
  'no-evidence',
  'no-container',
  'no-command',
  'not-a-node-command',
  'command-names-no-file',
  'script-not-found',
  'script-not-literal',
  'absolute-path',
  'outside-root',
  'symlink-loop',
  'unreadable',
  'not-read-as-source',
  /** The container sets `workingDir`, so a relative path in its command cannot be mapped to a folder. */
  'working-dir-not-mapped',
  /** The relative path in the command names a file in more than one folder from the manifest up to the root. */
  'several-files-match',
] as const;
export type SourceUnlinkedReason = (typeof SOURCE_UNLINKED_REASONS)[number];

export type SourceLink =
  | {
      readonly state: 'linked';
      /** How the file was found, in this order: a declared `source:`, the command's literal file, an npm script. */
      readonly by: 'declared' | 'command' | 'npm-script';
      readonly entry: InputFile;
      /** Where the evidence is written (the declaration, or the command). */
      readonly evidence: SourceRef;
      /**
       * The folder (root-relative; `.` is the root) taken to be the container's working
       * directory so the command's relative file could be found: an assumption the
       * report lists. Absent for a declared source or an npm script.
       */
      readonly assumedWorkingDir?: InputText;
      /** Code Node runs before the entry file (preload flags, `NODE_OPTIONS`): what to read and what could not be. */
      readonly preloads: NodePreloads;
    }
  | {
      readonly state: 'unlinked';
      readonly reasonCode: SourceUnlinkedReason;
      readonly evidence?: SourceRef;
    };

/** A Dockerfile linked from `tripcurve.yaml` (the only way a Dockerfile is linked). */
export type DockerfileLink =
  | { readonly state: 'linked'; readonly file: InputFile }
  | {
      readonly state: 'unresolved';
      readonly reasonCode: 'outside-root' | 'symlink-loop' | 'unreadable' | 'not-a-dockerfile';
    };

export const LINK_STATES = [
  'linked',
  'unresolved-more-than-one-match',
  'unresolved-container-not-determined',
  'unresolved-source-not-linked',
] as const;
/** `linkState`. Precedence when several apply: more than one match, container, source. */
export type LinkState = (typeof LINK_STATES)[number];

export interface WorkloadChain {
  readonly workload: K8sWorkload;
  readonly ref: WorkloadRef;
  /** Every load balancer path to this workload (one per Ingress and Service pair, or NLB Service). */
  readonly paths: readonly LbPath[];
  /** Another object of the same kind, namespace and name was read, or so was the Ingress or Service. */
  readonly ambiguous: boolean;
  readonly container: ContainerLink;
  /** The declarations of `tripcurve.yaml` that name exactly this workload. */
  readonly declarations: readonly Declaration[];
  readonly links: readonly ConfigLink[];
  readonly sourceLink: SourceLink;
  /** B2: the `gunicorn.conf.py` a gunicorn command loads, or why none is known. Absent for other servers. */
  readonly gunicornConfig?: GunicornConfigLink;
  readonly dockerfile?: DockerfileLink;
  /** The package.json nearest to the manifest (for the npm script and `engines`), when one is read. */
  readonly packageJson?: InputFile;
  /**
   * A declared load-balancer link of the form `ingress` or `service` that names
   * none of the load balancers behind this workload: the declaration is never
   * applied to the wrong one, and the idle timeout is unresolved.
   */
  readonly declaredLbMismatch: boolean;
  /**
   * B5: the Terraform `aws_lb` this workload's load balancer is linked to, by a declaration (established)
   * or by the Ingress `load-balancer-name` annotation (an assumption), or why the link is unresolved.
   * Absent when no Terraform link applies.
   */
  readonly terraformLb?: TerraformLbLink;
  /** The configuration file the declarations came from. */
  readonly configFile?: InputText;
}

export interface ConfigGraph {
  readonly workloadChains: readonly WorkloadChain[];
  readonly notChecked: readonly NotCheckedItem[];
  /** The reader's errors, then the declaration-target errors; non-empty stops the run. */
  readonly configErrors: readonly ConfigError[];
  /** Every workload read, once per kind, namespace and name (U9 validates waivers against it). */
  readonly knownWorkloads: readonly WorkloadRef[];
  /** B2: a gunicorn.conf.py that no -c or link names. Not produced in B1. */
  readonly unlinkedServerConfig?: { readonly file: InputText };
}
