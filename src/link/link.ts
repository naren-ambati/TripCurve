// ConfigGraphLinker: builds the config graph from the readers' models.
//
// An ALB Ingress, then its backend Service, then every workload the Service's
// selector selects (same namespace), then the container the Service port reaches
// (the target port, matched to a container port). Every selected workload gets its
// own chain. Two objects with the same kind, namespace and name are both
// kept and both flagged. Workloads no recognised load balancer reaches, Ingresses
// that are not ALB and kinds not checked are listed once as not checked.
//
// Choice: a container is determined only by a port match. A pod with one container
// that declares no ports is NOT assumed to be the target: a pod can have containers
// the file does not show, so the chain is unresolved instead (honesty first).

import {
  compareInputText,
  declaredSource,
  type InputText,
  inputText,
  inputTextEquals,
  isInputText,
  isSourcedValue,
  type SourcedValue,
  type SourceRef,
  type WorkloadRef,
} from '../core/index.js';
import {
  type ConfigError,
  type ConfigLink,
  type ConfigResult,
  confineToRoot,
  type Declaration,
  type IacReadResult,
  type InputFile,
  type IntakeResult,
  type K8sContainer,
  type K8sIngress,
  type K8sPair,
  type K8sPort,
  type K8sReadResult,
  type K8sService,
  type K8sWorkload,
  rawInputTextForParser,
  readPythonCommand,
  STDIN,
  type WorkloadSelector,
} from '../parse/index.js';
import { linkGunicornConfig } from './gunicorn-config-link.js';
import type {
  ConfigGraph,
  ContainerLink,
  DockerfileLink,
  LbPath,
  NotCheckedItem,
  WorkloadChain,
} from './model.js';
import { linkSource } from './source-link.js';
import { linkDeclaredLb, linkLbByName, type TerraformLbLink } from './terraform-link.js';

export interface LinkInput {
  readonly intake: IntakeResult;
  readonly k8s: K8sReadResult;
  readonly config: ConfigResult;
  /** The Terraform resources read (bolt B5). */
  readonly iac: IacReadResult;
}

const NLB_TYPES = ['external', 'nlb', 'nlb-ip'];

function sameName(a: InputText, b: InputText): boolean {
  return inputTextEquals(a, b);
}

function identityKey(w: K8sWorkload): string {
  return `${w.kind}\u0000${rawInputTextForParser(w.namespace)}\u0000${rawInputTextForParser(w.name)}`;
}

function refOf(w: K8sWorkload): WorkloadRef {
  return { kind: w.kind, namespace: w.namespace, name: w.name };
}

function fileLineOf(source: SourceRef): { file: InputText | typeof STDIN; line: number } {
  switch (source.type) {
    case 'file':
    case 'declared':
      return { file: source.file, line: source.line };
    case 'stdin':
      return { file: STDIN, line: source.line };
    case 'default':
      return { file: STDIN, line: 1 };
  }
}

// ---------------------------------------------------------------- selector match

function pairText(pair: K8sPair): InputText | undefined {
  const v = pair.value;
  return isSourcedValue(v) && isInputText(v.value) ? v.value : undefined;
}

/** A Service selector selects a pod whose labels hold every selector pair. An empty selector selects nothing. */
function selects(service: K8sService, workload: K8sWorkload): boolean {
  const selector = service.selector;
  if (selector === undefined || selector.length === 0) return false;
  if (!sameName(service.namespace, workload.namespace)) return false;
  return selector.every((want) => {
    const wanted = pairText(want);
    if (wanted === undefined) return false; // a value that is not text cannot be matched
    return workload.podLabels.some((have) => {
      const text = pairText(have);
      return text !== undefined && sameName(have.key, want.key) && sameName(text, wanted);
    });
  });
}

// ---------------------------------------------------------------- container

type PortWanted = { readonly number: number } | { readonly name: InputText } | undefined;

function wantedFromTarget(servicePort: K8sService['ports'][number]): PortWanted {
  const target = servicePort.targetPort;
  if (target === undefined) {
    const port = servicePort.port;
    return port !== undefined && isSourcedValue(port) && typeof port.value === 'number'
      ? { number: port.value }
      : undefined;
  }
  if (!isSourcedValue(target)) return undefined;
  if (typeof target.value === 'number') return { number: target.value };
  return isInputText(target.value) ? { name: target.value } : undefined;
}

function portMatches(port: K8sPort, wanted: { number: number } | { name: InputText }): boolean {
  if ('number' in wanted) {
    const n = port.containerPort;
    return n !== undefined && isSourcedValue(n) && n.value === wanted.number;
  }
  const name = port.name;
  return name !== undefined && isInputText(name.value) && sameName(name.value, wanted.name);
}

function containersFor(
  workload: K8sWorkload,
  wanted: { number: number } | { name: InputText },
): K8sWorkload['containers'][number][] {
  return workload.containers.filter((c) => c.ports.some((p) => portMatches(p, wanted)));
}

interface BackendPorts {
  /** The Service ports the Ingress backends name. */
  readonly ports: K8sService['ports'];
  /** A backend names a port the Service does not have. */
  readonly notAPort: boolean;
  /** A backend port, or a Service port it would be compared with, could not be read. */
  readonly unreadable: boolean;
}

function backendPortsFor(ingress: K8sIngress, service: K8sService): BackendPorts {
  // The Ingress backend names a Service port by number or by name.
  const backends = ingress.backends.filter((b) => sameName(b.serviceName, service.name));
  const ports: K8sService['ports'][number][] = [];
  let notAPort = false;
  let unreadable = false;
  for (const backend of backends) {
    const bp = backend.port;
    if (bp === undefined) {
      unreadable = true;
      continue;
    }
    const wantsNumber = bp.number !== undefined && isSourcedValue(bp.number);
    const wantsName = bp.name !== undefined && isInputText(bp.name.value);
    if (!wantsNumber && !wantsName) {
      unreadable = true;
      continue;
    }
    let matched = false;
    for (const sp of service.ports) {
      const byNumber =
        wantsNumber &&
        sp.port !== undefined &&
        isSourcedValue(sp.port) &&
        sp.port.value === (bp.number as SourcedValue).value;
      const byName =
        wantsName &&
        sp.name !== undefined &&
        isInputText(sp.name.value) &&
        sameName(sp.name.value, (bp.name as SourcedValue).value as InputText);
      if (byNumber || byName) {
        ports.push(sp);
        matched = true;
      }
    }
    if (matched) continue;
    // Nothing matched: it is "not a port of the Service" only when every Service port could be read.
    const readable = service.ports.every((sp) =>
      wantsNumber ? sp.port !== undefined && isSourcedValue(sp.port) : sp.name !== undefined,
    );
    if (readable) notAPort = true;
    else unreadable = true;
  }
  return { ports, notAPort, unreadable };
}

function determineContainer(workload: K8sWorkload, paths: readonly LbPath[]): ContainerLink {
  const found = new Map<K8sWorkload['containers'][number], true>();
  let unreadable = false;
  let noServicePort = false;
  for (const path of paths) {
    let ports: K8sService['ports'];
    if (path.kind === 'alb') {
      const backend = backendPortsFor(path.ingress, path.service);
      // One backend naming a port the Service lacks is not set aside because another is fine (m5).
      if (backend.notAPort) return { state: 'unresolved', reasonCode: 'service-port-not-found' };
      if (backend.unreadable) unreadable = true;
      ports = backend.ports;
      if (backend.unreadable && ports.length === 0) continue;
    } else ports = path.service.ports;
    if (ports.length === 0) {
      noServicePort = true;
      continue;
    }
    for (const sp of ports) {
      const wanted = wantedFromTarget(sp);
      if (wanted === undefined) {
        unreadable = true;
        continue;
      }
      for (const c of containersFor(workload, wanted)) found.set(c, true);
    }
  }
  const containers = [...found.keys()];
  if (containers.length === 1)
    return { state: 'determined', container: containers[0] as K8sContainer };
  if (containers.length > 1) return { state: 'unresolved', reasonCode: 'several-containers-match' };
  if (unreadable) return { state: 'unresolved', reasonCode: 'port-not-readable' };
  if (noServicePort) return { state: 'unresolved', reasonCode: 'service-port-not-found' };
  return { state: 'unresolved', reasonCode: 'no-container-matches' };
}

// ---------------------------------------------------------------- load balancer paths

function nlbType(service: K8sService): SourcedValue | undefined {
  const t = service.awsLoadBalancerType;
  if (t === undefined || !isSourcedValue(t)) return undefined;
  return typeof t.value === 'string' && NLB_TYPES.includes(t.value) ? t : undefined;
}

/** Same kind, namespace and name: the same object. */
function sameIngress(a: K8sIngress, b: K8sIngress): boolean {
  return sameName(a.name, b.name) && sameName(a.namespace, b.namespace);
}

function literalName(value: K8sIngress['loadBalancerName']): InputText | undefined {
  return value !== undefined && isSourcedValue(value) && isInputText(value.value)
    ? value.value
    : undefined;
}

/**
 * Ingresses that share `alb.ingress.kubernetes.io/group.name` share one ALB, and so do
 * Ingresses that name the same `load-balancer-name`. `load-balancer-attributes` has
 * Exclusive merge semantics: conflicting values across the group make the controller
 * fail for the entire group, and members can exist outside the checked files, so one
 * Ingress's annotation is not what the ALB has. Source:
 * https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
 * (read 2026-11-11).
 */
function sharesAlb(ingress: K8sIngress, all: readonly K8sIngress[]): boolean {
  if (ingress.groupName !== undefined) return true;
  const name = literalName(ingress.loadBalancerName);
  if (name === undefined) return false;
  return all.some((other) => {
    if (sameIngress(other, ingress)) return false;
    const otherName = literalName(other.loadBalancerName);
    return otherName !== undefined && inputTextEquals(otherName, name);
  });
}

function pathsFor(workload: K8sWorkload, k8s: K8sReadResult): LbPath[] {
  const paths: LbPath[] = [];
  for (const service of k8s.services) {
    if (!selects(service, workload)) continue;
    const nlb = nlbType(service);
    if (nlb !== undefined) paths.push({ kind: 'nlb', service, nlbType: nlb });
    for (const ingress of k8s.ingresses) {
      if (!sameName(ingress.namespace, service.namespace)) continue;
      if (ingress.backends.some((b) => sameName(b.serviceName, service.name))) {
        paths.push({ kind: 'alb', ingress, service, sharedAlb: sharesAlb(ingress, k8s.ingresses) });
      }
    }
    for (const ingress of k8s.classConflictIngresses) {
      if (!sameName(ingress.namespace, service.namespace)) continue;
      if (ingress.backends.some((b) => sameName(b.serviceName, service.name))) {
        paths.push({ kind: 'class-conflict', ingress, service });
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------- declarations

function matchesSelector(selector: WorkloadSelector, workload: K8sWorkload): boolean {
  if (!sameName(selector.workload.name, workload.name)) return false;
  const ns = selector.workload.namespace;
  if (ns !== undefined && !sameName(ns, workload.namespace)) return false;
  return selector.workloadKind === undefined || selector.workloadKind === workload.kind;
}

function matchedIdentities(
  selector: WorkloadSelector,
  workloads: readonly K8sWorkload[],
): Set<string> {
  const keys = new Set<string>();
  for (const w of workloads) if (matchesSelector(selector, w)) keys.add(identityKey(w));
  return keys;
}

function declarationErrors(
  config: ConfigResult,
  workloads: readonly K8sWorkload[],
): { errors: ConfigError[]; usable: Set<Declaration | ConfigLink> } {
  const errors: ConfigError[] = [];
  const usable = new Set<Declaration | ConfigLink>();
  const file = config.configFile ?? inputText('tripcurve.yaml');
  const check = (item: Declaration | ConfigLink, key: string) => {
    const count = matchedIdentities(item, workloads).size;
    if (count === 1) {
      usable.add(item);
      return;
    }
    errors.push({
      file,
      line: item.line,
      key: inputText(key),
      reasonCode:
        count === 0 ? 'declaration-names-no-workload' : 'declaration-names-several-workloads',
      workload: item.workload.name,
    });
  };
  for (const d of config.declarations) check(d, d.key);
  for (const l of config.links) check(l, l.kind);
  return { errors, usable };
}

// ---------------------------------------------------------------- package.json and Dockerfile

/** The package.json in the directory of `canonicalPath` or the nearest directory above it, up to the root. */
export function nearestPackageJson(
  intake: IntakeResult,
  canonicalPath: InputText,
): InputFile | undefined {
  const path = rawInputTextForParser(canonicalPath);
  const byPath = new Map<string, InputFile>();
  for (const f of intake.files) {
    if (f.class === 'package-json') byPath.set(rawInputTextForParser(f.canonicalPath), f);
  }
  let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  for (;;) {
    const hit = byPath.get(dir === '' ? 'package.json' : `${dir}/package.json`);
    if (hit !== undefined) return hit;
    if (dir === '') return undefined;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

/** The folder of the manifest, root-relative; `''` for the root (or for standard input). */
function manifestDirOf(workload: K8sWorkload): string {
  const src = workload.source;
  if (src.type !== 'file') return '';
  const path = rawInputTextForParser(src.file);
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function packageJsonFor(workload: K8sWorkload, intake: IntakeResult): InputFile | undefined {
  const src = workload.source;
  return src.type === 'file' ? nearestPackageJson(intake, src.file) : undefined;
}

function dockerfileFor(
  link: ConfigLink | undefined,
  intake: IntakeResult,
): DockerfileLink | undefined {
  if (link === undefined) return undefined;
  let confined: ReturnType<typeof confineToRoot>;
  try {
    confined = confineToRoot(intake, link.target);
  } catch {
    return { state: 'unresolved', reasonCode: 'unreadable' };
  }
  if (!confined.ok) return { state: 'unresolved', reasonCode: confined.reasonCode };
  const file = intake.files.find(
    (f) => f.class === 'dockerfile' && inputTextEquals(f.canonicalPath, confined.canonicalPath),
  );
  return file === undefined
    ? { state: 'unresolved', reasonCode: 'not-a-dockerfile' }
    : { state: 'linked', file };
}

// ---------------------------------------------------------------- the graph

function declaredLbMismatch(links: readonly ConfigLink[], paths: readonly LbPath[]): boolean {
  for (const link of links) {
    if (link.kind !== 'load_balancer' || link.loadBalancer === undefined) continue;
    const form = link.loadBalancer.form;
    if (form === 'terraform') continue; // read in a later release; the resolver handles it
    const named = paths.some((p) =>
      form === 'ingress'
        ? p.kind === 'alb' && sameName(p.ingress.name, link.target)
        : p.kind === 'nlb' && sameName(p.service.name, link.target),
    );
    if (!named) return true;
  }
  return false;
}

/**
 * The Terraform load balancer of a workload: the declared link when there is one, else the by-name link
 * when the one ALB path carries a literal `load-balancer-name` (an assumption).
 */
function terraformLbFor(
  links: readonly ConfigLink[],
  paths: readonly LbPath[],
  iac: IacReadResult,
  configFile: InputText | undefined,
): TerraformLbLink | undefined {
  const declared = links.find(
    (l) => l.kind === 'load_balancer' && l.loadBalancer?.form === 'terraform',
  );
  if (declared !== undefined) {
    return linkDeclaredLb(
      iac,
      declaredSource(configFile ?? inputText('tripcurve.yaml'), declared.line),
      declared.target,
    );
  }
  const only = paths.length === 1 ? paths[0] : undefined;
  if (only === undefined || only.kind !== 'alb') return undefined;
  const name = only.ingress.loadBalancerName;
  if (name === undefined || !isSourcedValue(name) || !isInputText(name.value)) return undefined;
  return linkLbByName(iac, name);
}

export function linkConfigGraph(input: LinkInput): ConfigGraph {
  const { intake, k8s, config, iac } = input;
  const { errors, usable } = declarationErrors(config, k8s.workloads);

  const chains: WorkloadChain[] = [];
  const notChecked: NotCheckedItem[] = [];

  for (const workload of k8s.workloads) {
    const paths = pathsFor(workload, k8s);
    const loc = fileLineOf(workload.source);
    if (paths.length === 0) {
      notChecked.push({
        subjectKind: 'workload',
        subject: workload.name,
        kind: workload.kind,
        file: loc.file,
        line: loc.line,
        reasonCode: 'no-recognised-lb',
      });
      continue;
    }
    const declarations = config.declarations.filter(
      (d) => usable.has(d) && matchesSelector(d, workload),
    );
    const links = config.links.filter((l) => usable.has(l) && matchesSelector(l, workload));
    const container = determineContainer(workload, paths);
    const packageJson = packageJsonFor(workload, intake);
    const sourceLink = linkSource({
      intake,
      ...(container.state === 'determined' ? { container: container.container } : {}),
      sourceLinks: links.filter((l) => l.kind === 'source'),
      ...(config.configFile === undefined ? {} : { configFile: config.configFile }),
      ...(packageJson === undefined ? {} : { packageJson }),
      manifestDir: manifestDirOf(workload),
    });
    const python =
      container.state === 'determined' ? readPythonCommand(container.container) : undefined;
    const gunicornConfig =
      python?.program === 'gunicorn'
        ? linkGunicornConfig({
            intake,
            configLinks: links.filter((l) => l.kind === 'gunicorn_config'),
            ...(config.configFile === undefined ? {} : { configFile: config.configFile }),
            ...(python.configArg === undefined ? {} : { arg: python.configArg }),
            workingDirSet:
              container.state === 'determined' &&
              container.container.workingDirSource !== undefined,
            manifestDir: manifestDirOf(workload),
          })
        : undefined;
    const dockerfile = dockerfileFor(
      links.find((l) => l.kind === 'dockerfile'),
      intake,
    );
    const terraformLb = terraformLbFor(links, paths, iac, config.configFile);
    chains.push({
      workload,
      ref: refOf(workload),
      paths,
      ambiguous:
        workload.duplicate ||
        paths.some((p) => p.service.duplicate || (p.kind !== 'nlb' && p.ingress.duplicate)),
      container,
      declarations,
      links,
      sourceLink,
      ...(gunicornConfig === undefined ? {} : { gunicornConfig }),
      ...(dockerfile === undefined ? {} : { dockerfile }),
      ...(packageJson === undefined ? {} : { packageJson }),
      declaredLbMismatch: declaredLbMismatch(links, paths),
      ...(terraformLb === undefined ? {} : { terraformLb }),
      ...(config.configFile === undefined ? {} : { configFile: config.configFile }),
    });
  }

  for (const kind of k8s.uncheckedKinds) {
    const loc = fileLineOf(kind.source);
    notChecked.push({
      subjectKind: kind.kind === 'Ingress' ? 'ingress' : 'kind',
      ...(kind.name === undefined ? {} : { subject: kind.name }),
      kind: kind.kind,
      file: loc.file,
      line: loc.line,
      reasonCode: kind.reasonCode === 'not-alb-ingress' ? 'not-alb-ingress' : 'kind-not-checked',
    });
  }
  notChecked.sort(compareNotChecked);

  const known = new Map<string, WorkloadRef>();
  for (const w of k8s.workloads)
    if (!known.has(identityKey(w))) known.set(identityKey(w), refOf(w));

  return {
    workloadChains: chains,
    notChecked,
    configErrors: [...config.configErrors, ...errors],
    knownWorkloads: [...known.values()],
  };
}

const SUBJECT_RANK = { workload: 0, ingress: 1, kind: 2 } as const;

function compareNotChecked(a: NotCheckedItem, b: NotCheckedItem): number {
  if (a.subjectKind !== b.subjectKind)
    return SUBJECT_RANK[a.subjectKind] - SUBJECT_RANK[b.subjectKind];
  const fa = isInputText(a.file) ? a.file : inputText(a.file);
  const fb = isInputText(b.file) ? b.file : inputText(b.file);
  const byFile = compareInputText(fa, fb);
  if (byFile !== 0) return byFile;
  return (a.line ?? 0) - (b.line ?? 0);
}
