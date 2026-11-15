// KubernetesReader.
//
// A pure function from the intake result to typed models. It reads documents
// that intake already parsed under the limits (so it never touches a file or
// the parser), reads only the fields tripcurve needs, and never evaluates them.
//
// Decisions, each kept where it is made:
// - The kind decides which reader runs, but the kind printed or stored is
//   always tripcurve's own constant, chosen by exact match (a field the input
//   controls never becomes a fact in tripcurve's voice).
// - `apiVersion` is not checked for the workload, Service and Ingress kinds;
//   it is required only to recognise a Gateway API kind.
// - Only ALB Ingresses are in `ingresses`. Any other Ingress
//   is a K8sUncheckedKind, so a linker cannot treat it as an ALB by accident.
// - A missing namespace is `default`, which is what Kubernetes does; the flag
//   `namespaceDeclared` keeps the difference.
// - An env entry with neither `value` nor `valueFrom` is the empty string, as
//   in Kubernetes.

import {
  type InputText,
  inputText,
  isDocumentedAlbIdle,
  makeSourcedValue,
  REASON_ALB_IDLE_OUT_OF_RANGE,
  type SourcedValue,
  type SourceRef,
  targetTypeFromInput,
} from '../../core/index.js';
import { type K8sWorkloadKind, k8sWorkloadKindFromInput } from '../../core/vocab.js';
import type { IntakeDocument, IntakeResult } from '../intake/index.js';
import { UnresolvedLog } from '../reader-result.js';
import {
  ALB_INGRESS_CONTROLLER,
  GATEWAY_API_KINDS,
  type K8sBackend,
  type K8sBackendPort,
  type K8sClassConflictIngress,
  type K8sContainer,
  type K8sEnvVar,
  type K8sIngress,
  type K8sIngressClass,
  type K8sPair,
  type K8sPort,
  type K8sPreStop,
  type K8sReadResult,
  type K8sService,
  type K8sServicePort,
  type K8sStringList,
  type K8sUncheckedKind,
  type K8sWorkload,
  type Maybe,
} from './model.js';

type PathKey = string | number;
type Rec = Record<string, unknown>;

const ALB_PREFIX = 'alb.ingress.kubernetes.io/';
const ANN_LB_ATTRIBUTES = `${ALB_PREFIX}load-balancer-attributes`;
const ANN_TARGET_TYPE = `${ALB_PREFIX}target-type`;
const ANN_LB_NAME = `${ALB_PREFIX}load-balancer-name`;
const ANN_GROUP_NAME = `${ALB_PREFIX}group.name`;
const ANN_LEGACY_CLASS = 'kubernetes.io/ingress.class';
const NLB_PREFIX = 'service.beta.kubernetes.io/';
const ANN_NLB_TYPE = `${NLB_PREFIX}aws-load-balancer-type`;
const ANN_NLB_TARGET = `${NLB_PREFIX}aws-load-balancer-nlb-target-type`;
const ANN_NLB_ATTRIBUTES = `${NLB_PREFIX}aws-load-balancer-attributes`;
const IDLE_ATTRIBUTE = 'idle_timeout.timeout_seconds';

const SERVICE_TYPES = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'] as const;
const NLB_TYPES = ['external', 'nlb', 'nlb-ip'] as const;
const NLB_TARGET_TYPES = ['ip', 'instance'] as const;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Rec, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Follows own properties only; anything else on the way gives undefined. */
/**
 * True when a list, or a list nested in it at any depth, holds a mapping that carries an `apiVersion` or a `kind` key.
 * An explicit stack and a visit bound keep a hostile nesting from recursing or costing more than linear work.
 */
function holdsManifestShape(list: readonly unknown[]): boolean {
  const stack: unknown[] = [list];
  for (let visited = 0; stack.length > 0 && visited < 1_000_000; visited += 1) {
    const next = stack.pop();
    if (Array.isArray(next)) stack.push(...next);
    else if (isRec(next) && (Object.hasOwn(next, 'apiVersion') || Object.hasOwn(next, 'kind'))) {
      return true;
    }
  }
  return false;
}

function dig(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRec(current)) return undefined;
    current = own(current, key);
  }
  return current;
}

function fixedFrom<T extends string>(list: readonly T[], text: string): T | undefined {
  return list.find((word) => word === text);
}

/** One object to read, with the way to find the source of a field inside it. */
interface ObjectView {
  readonly value: Rec;
  /** The Helm `# Source:` comment of the document this object is in. */
  readonly helmSource?: InputText;
  readonly at: (path: readonly PathKey[]) => SourceRef;
  /** Where the key at `path` is written (a block value starts on the next line; its key does not). */
  readonly keyAt: (path: readonly PathKey[]) => SourceRef;
}

interface IngressDraft {
  readonly rawClassName: string | undefined;
  readonly legacyAlb: boolean;
  /** The legacy `kubernetes.io/ingress.class` annotation, when it is text. */
  readonly legacyClassName: string | undefined;
  readonly hasAlbAnnotation: boolean;
  readonly name: string;
  readonly namespace: string;
  readonly build: (recognisedBy: K8sIngress['recognisedBy']) => K8sIngress;
  readonly unchecked: K8sUncheckedKind;
  readonly buildConflict: (
    conflict: K8sClassConflictIngress['conflict'],
  ) => K8sClassConflictIngress;
}

class Reader {
  readonly log = new UnresolvedLog();
  readonly workloads: K8sWorkload[] = [];
  readonly services: K8sService[] = [];
  readonly ingressClasses: K8sIngressClass[] = [];
  readonly uncheckedKinds: K8sUncheckedKind[] = [];
  private readonly ingressDrafts: IngressDraft[] = [];
  private readonly albClassNames = new Set<string>();
  private readonly seen = new Map<string, number>();

  // ---- values ---------------------------------------------------------

  private text(raw: string, source: SourceRef): SourcedValue {
    return makeSourcedValue({ value: inputText(raw), unit: 'none', source, basis: 'declared' });
  }

  private fixed(word: string, source: SourceRef): SourcedValue {
    return makeSourcedValue({ value: word, unit: 'none', source, basis: 'declared' });
  }

  private number(n: number, unit: 's' | 'none', source: SourceRef): SourcedValue {
    return makeSourcedValue({ value: n, unit, source, basis: 'declared' });
  }

  private textOrUnresolved(raw: unknown, source: SourceRef, what: string): Maybe {
    if (typeof raw === 'string') return this.text(raw, source);
    return this.log.mark('unsupported-form', source, `${what} is not text`);
  }

  private pairs(
    raw: unknown,
    at: (path: readonly PathKey[]) => SourceRef,
    path: readonly PathKey[],
    what: string,
    collection: string,
  ): K8sPair[] {
    if (raw === undefined || raw === null) return [];
    if (!isRec(raw)) {
      this.log.mark('unsupported-form', at(path), `${collection} not a mapping`);
      return [];
    }
    const out: K8sPair[] = [];
    for (const key of Object.keys(raw)) {
      const source = at([...path, key]);
      out.push({ key: inputText(key), value: this.textOrUnresolved(raw[key], source, what) });
    }
    return out;
  }

  // ---- identity -------------------------------------------------------

  private identity(
    view: ObjectView,
    what: string,
  ): { name: string; namespace: string; declared: boolean } | undefined {
    const meta = own(view.value, 'metadata');
    const name = isRec(meta) ? own(meta, 'name') : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      this.log.mark(
        'object-not-identified',
        view.at(['metadata']),
        `a ${what} has no literal name`,
      );
      return undefined;
    }
    const ns = isRec(meta) ? own(meta, 'namespace') : undefined;
    if (ns === undefined || ns === null) return { name, namespace: 'default', declared: false };
    if (typeof ns !== 'string' || ns.length === 0) {
      this.log.mark(
        'object-not-identified',
        view.at(['metadata', 'namespace']),
        `the namespace of a ${what} is not text`,
      );
      return undefined;
    }
    return { name, namespace: ns, declared: true };
  }

  /** Counts one more object under a key; the answer is read at the end (a later twin flags the first). */
  private note(parts: readonly string[]): string {
    // length-prefixed, so no choice of names can make two different objects share a key
    const key = parts.map((p) => `${p.length}:${p}`).join('|');
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
    return key;
  }

  private isDuplicate(key: string): boolean {
    return (this.seen.get(key) ?? 0) > 1;
  }

  // ---- entry ----------------------------------------------------------

  readDocument(doc: IntakeDocument): void {
    const queue: ObjectView[] = [];
    if (isRec(doc.value)) {
      queue.push({
        value: doc.value,
        ...(doc.helmSource === undefined ? {} : { helmSource: doc.helmSource }),
        at: (p) => doc.sourceAt(p),
        keyAt: (p) => doc.keySourceAt(p),
      });
    }
    // A file that is a list of objects at its root (a JSON array, a flow sequence, a block list): each element that is
    // an object is read like an item of a `kind: List`; any other element is an object that was not identified.
    if (
      Array.isArray(doc.value) &&
      !doc.value.some((e) => isRec(e) && typeof own(e, 'kind') === 'string') &&
      holdsManifestShape(doc.value)
    ) {
      // A root list with no object of text `kind`, but with mappings that carry the two keys: listed whether it is the
      // whole file or one document of a stream (the whole-file case is decided at intake).
      this.log.mark(
        'object-not-identified',
        doc.sourceAt([0]),
        'a list has no Kubernetes object in it',
      );
    }
    if (
      Array.isArray(doc.value) &&
      doc.value.some((e) => isRec(e) && typeof own(e, 'kind') === 'string')
    ) {
      doc.value.forEach((element, i) => {
        if (isRec(element) && typeof own(element, 'kind') === 'string') {
          queue.push({
            value: element,
            ...(doc.helmSource === undefined ? {} : { helmSource: doc.helmSource }),
            at: (p) => doc.sourceAt([i, ...p]),
            keyAt: (p) => doc.keySourceAt([i, ...p]),
          });
        } else {
          this.log.mark(
            'object-not-identified',
            doc.sourceAt([i]),
            'an element of a list is not a Kubernetes object',
          );
        }
      });
    }
    // Lists (`kind: List`, `DeploymentList`, ...) are flattened, with an explicit
    // queue so a hostile nesting of lists cannot recurse.
    for (let next = 0; next < queue.length; next += 1) {
      const view = queue[next];
      if (view === undefined) break;
      const kind = own(view.value, 'kind');
      if (typeof kind !== 'string') continue;
      // A mapping with a text `kind` and an `apiVersion` that is not text is not a Kubernetes object: it is listed (the
      // same for every kind and every form), so a manifest-shaped document is never dropped without a word.
      if (
        Object.hasOwn(view.value, 'apiVersion') &&
        typeof own(view.value, 'apiVersion') !== 'string'
      ) {
        this.log.mark(
          'object-not-identified',
          view.at(['apiVersion']),
          'the apiVersion of an object is not text',
        );
      }
      const items = own(view.value, 'items');
      if (kind.endsWith('List') && Array.isArray(items)) {
        const implied = kind === 'List' ? undefined : kind.slice(0, -'List'.length);
        items.forEach((item, i) => {
          if (!isRec(item)) return;
          const itemView: ObjectView = {
            value:
              implied !== undefined && own(item, 'kind') === undefined
                ? { ...item, kind: implied }
                : item,
            ...(view.helmSource === undefined ? {} : { helmSource: view.helmSource }),
            at: (p) => view.at(['items', i, ...p]),
            keyAt: (p) => view.keyAt(['items', i, ...p]),
          };
          queue.push(itemView);
        });
        continue;
      }
      this.readObject(kind, view);
    }
  }

  private readObject(kind: string, view: ObjectView): void {
    const workloadKind = k8sWorkloadKindFromInput(kind);
    if (workloadKind !== undefined) {
      this.workload(workloadKind, view);
    } else if (kind === 'Service') {
      this.service(view);
    } else if (kind === 'Ingress') {
      this.ingress(view);
    } else if (kind === 'IngressClass') {
      this.ingressClass(view);
    } else {
      const gateway = fixedFrom(GATEWAY_API_KINDS, kind);
      const api = own(view.value, 'apiVersion');
      if (
        gateway !== undefined &&
        typeof api === 'string' &&
        api.startsWith('gateway.networking.k8s.io/')
      ) {
        this.uncheckedKinds.push(this.unchecked(gateway, 'kind-not-checked', view));
      }
      // Any other kind is ignored without comment.
    }
  }

  private unchecked(
    kind: K8sUncheckedKind['kind'],
    reasonCode: K8sUncheckedKind['reasonCode'],
    view: ObjectView,
  ): K8sUncheckedKind {
    const meta = own(view.value, 'metadata');
    const name = isRec(meta) ? own(meta, 'name') : undefined;
    const ns = isRec(meta) ? own(meta, 'namespace') : undefined;
    return {
      kind,
      reasonCode,
      ...(typeof name === 'string' && name.length > 0 ? { name: inputText(name) } : {}),
      ...(typeof ns === 'string' && ns.length > 0 ? { namespace: inputText(ns) } : {}),
      source: view.at(['kind']),
    };
  }

  // ---- workloads ------------------------------------------------------

  private workload(kind: K8sWorkloadKind, view: ObjectView): void {
    const id = this.identity(view, 'workload');
    if (id === undefined) return;
    const isPod = kind === 'Pod';
    const specPath: string[] = isPod ? ['spec'] : ['spec', 'template', 'spec'];
    const podSpec = dig(view.value, specPath);
    const metaPath: string[] = isPod
      ? ['metadata', 'labels']
      : ['spec', 'template', 'metadata', 'labels'];
    const key = this.note(['workload', kind, id.namespace, id.name]);

    const containers: K8sContainer[] = [];
    const rawContainers = isRec(podSpec) ? own(podSpec, 'containers') : undefined;
    if (!isRec(podSpec)) {
      this.log.mark(
        'unsupported-form',
        view.at(isPod ? ['kind'] : ['spec']),
        'the workload has no pod spec',
      );
    } else if (Array.isArray(rawContainers)) {
      rawContainers.forEach((c, i) => {
        const container = this.container(c, view, [...specPath, 'containers', i]);
        if (container !== undefined) containers.push(container);
      });
    }

    const grace = isRec(podSpec) ? own(podSpec, 'terminationGracePeriodSeconds') : undefined;
    const gracePath = [...specPath, 'terminationGracePeriodSeconds'];
    let gracePeriod: Maybe | undefined;
    if (grace !== undefined && grace !== null) {
      gracePeriod =
        typeof grace === 'number' && Number.isSafeInteger(grace) && grace >= 0
          ? this.number(grace, 's', view.at(gracePath))
          : this.log.mark(
              'unsupported-form',
              view.at(gracePath),
              'the termination grace period is not a whole number of seconds',
            );
    }

    const labels = this.pairs(
      dig(view.value, ['metadata', 'labels']),
      view.at,
      ['metadata', 'labels'],
      'a label value',
      'the labels are',
    );
    // A bare Pod's template labels are its own labels: read once, so a problem is reported once.
    const podLabels = isPod
      ? labels
      : this.pairs(
          dig(view.value, metaPath),
          view.at,
          metaPath,
          'a label value',
          'the pod labels are',
        );
    const matchLabels = isPod ? undefined : dig(view.value, ['spec', 'selector', 'matchLabels']);
    const selectorMatchLabels =
      matchLabels === undefined
        ? undefined
        : this.pairs(
            matchLabels,
            view.at,
            ['spec', 'selector', 'matchLabels'],
            'a selector value',
            'the selector is',
          );
    const workload = (): K8sWorkload => ({
      kind,
      name: inputText(id.name),
      namespace: inputText(id.namespace),
      namespaceDeclared: id.declared,
      source: view.at(['kind']),
      labels,
      podLabels,
      ...(selectorMatchLabels === undefined ? {} : { selectorMatchLabels }),
      containers,
      ...(gracePeriod === undefined ? {} : { gracePeriod }),
      ...(view.helmSource === undefined ? {} : { helmSource: view.helmSource }),
      duplicate: false,
    });
    this.pendingDuplicates.push({
      key,
      apply: (dup) => this.workloads.push({ ...workload(), duplicate: dup }),
    });
  }

  // Objects are pushed once all documents are read, so the duplicate flag is right for the first twin too.
  private readonly pendingDuplicates: Array<{ key: string; apply: (duplicate: boolean) => void }> =
    [];

  private container(
    raw: unknown,
    view: ObjectView,
    path: readonly PathKey[],
  ): K8sContainer | undefined {
    if (!isRec(raw)) {
      this.log.mark('unsupported-form', view.at(path), 'a container is not a mapping');
      return undefined;
    }
    const name = own(raw, 'name');
    if (typeof name !== 'string' || name.length === 0) {
      this.log.mark('unsupported-form', view.at(path), 'a container has no literal name');
      return undefined;
    }
    const at = (p: readonly PathKey[]): SourceRef => view.at([...path, ...p]);
    const keyAt = (p: readonly PathKey[]): SourceRef => view.keyAt([...path, ...p]);
    const image = own(raw, 'image');
    const command = own(raw, 'command');
    const args = own(raw, 'args');
    const env = own(raw, 'env');
    const ports = own(raw, 'ports');
    const envFrom = own(raw, 'envFrom');
    const workingDir = own(raw, 'workingDir');
    const preStop = dig(raw, ['lifecycle', 'preStop']);
    return {
      name: inputText(name),
      source: at([]),
      ...(image === undefined || image === null
        ? {}
        : { image: this.textOrUnresolved(image, at(['image']), 'the image') }),
      ...(command === undefined || command === null
        ? {}
        : { command: this.stringList(command, at, 'command') }),
      ...(args === undefined || args === null ? {} : { args: this.stringList(args, at, 'args') }),
      env: Array.isArray(env) ? this.envVars(env, at) : [],
      ...(Array.isArray(envFrom) && envFrom.length > 0
        ? { envFromSource: keyAt(['envFrom']) }
        : {}),
      // An empty string is what Kubernetes treats as unset; anything else is a working directory.
      ...(workingDir === undefined || workingDir === null || workingDir === ''
        ? {}
        : { workingDirSource: keyAt(['workingDir']) }),
      ports: Array.isArray(ports) ? this.containerPorts(ports, at) : [],
      ...(preStop === undefined || preStop === null
        ? {}
        : { preStop: this.preStop(preStop, at, keyAt) }),
    };
  }

  private stringList(
    raw: unknown,
    at: (p: readonly PathKey[]) => SourceRef,
    field: 'command' | 'args',
  ): K8sStringList {
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      return this.log.mark(
        'unsupported-form',
        at([field]),
        `the container ${field} is not a list of text`,
      );
    }
    return {
      items: raw.map((item, i) => this.text(item as string, at([field, i]))),
      source: at([field]),
    };
  }

  private envVars(raw: readonly unknown[], at: (p: readonly PathKey[]) => SourceRef): K8sEnvVar[] {
    const out: K8sEnvVar[] = [];
    raw.forEach((entry, i) => {
      if (!isRec(entry)) return;
      const name = own(entry, 'name');
      if (typeof name !== 'string' || name.length === 0) {
        this.log.mark(
          'unsupported-form',
          at(['env', i]),
          'an environment variable has no literal name',
        );
        return;
      }
      const from = own(entry, 'valueFrom');
      const value = own(entry, 'value');
      let result: Maybe;
      if (from !== undefined && from !== null) {
        // Never read, never kept: only the fact that it is a reference.
        result = this.log.mark(
          'value-from-reference',
          at(['env', i]),
          'the value comes from a reference, which is not read',
        );
      } else if (value === undefined || value === null) {
        result = this.text('', at(['env', i]));
      } else {
        result = this.textOrUnresolved(value, at(['env', i, 'value']), 'an environment value');
      }
      out.push({ name: inputText(name), value: result, source: at(['env', i]) });
    });
    return out;
  }

  private containerPorts(
    raw: readonly unknown[],
    at: (p: readonly PathKey[]) => SourceRef,
  ): K8sPort[] {
    const out: K8sPort[] = [];
    raw.forEach((entry, i) => {
      if (!isRec(entry)) return;
      const port = own(entry, 'containerPort');
      const name = own(entry, 'name');
      out.push({
        source: at(['ports', i]),
        ...(typeof name === 'string' ? { name: this.text(name, at(['ports', i, 'name'])) } : {}),
        ...(port === undefined || port === null
          ? {}
          : { containerPort: this.portNumber(port, at(['ports', i, 'containerPort'])) }),
      });
    });
    return out;
  }

  private portNumber(raw: unknown, source: SourceRef): Maybe {
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? this.number(raw, 'none', source)
      : this.log.mark('unsupported-form', source, 'a port is not a whole number');
  }

  private preStop(
    raw: unknown,
    at: (p: readonly PathKey[]) => SourceRef,
    keyAt: (p: readonly PathKey[]) => SourceRef,
  ): K8sPreStop {
    const base = ['lifecycle', 'preStop'] as const;
    const source = keyAt(base);
    const hook = (): K8sPreStop => ({
      form: 'hook',
      delay: this.log.mark(
        'hook-unresolved-duration',
        source,
        'the preStop hook has no delay tripcurve can read',
      ),
      source,
    });
    if (!isRec(raw)) return hook();
    const handlers = Object.keys(raw).filter(
      (k) => ['exec', 'sleep', 'httpGet', 'tcpSocket'].includes(k) && own(raw, k) != null,
    );
    if (handlers.length !== 1) return hook();
    if (handlers[0] === 'sleep') {
      const seconds = dig(raw, ['sleep', 'seconds']);
      if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0) {
        return {
          form: 'sleep-handler',
          delay: this.number(seconds, 's', at([...base, 'sleep', 'seconds'])),
          source,
        };
      }
      return hook();
    }
    if (handlers[0] === 'exec') {
      const command = dig(raw, ['exec', 'command']);
      const commandSource = at([...base, 'exec', 'command']);
      if (Array.isArray(command) && command.every((c) => typeof c === 'string')) {
        const words = command as string[];
        const direct =
          words.length === 2 && words[0] === 'sleep'
            ? literalSeconds(words[1] as string)
            : undefined;
        if (direct !== undefined) {
          return { form: 'exec-sleep', delay: this.number(direct, 's', commandSource), source };
        }
        const shell =
          words.length === 3 && words[0] === '/bin/sh' && words[1] === '-c'
            ? /^sleep +([0-9]+)$/.exec(words[2] as string)
            : null;
        const shellSeconds = shell === null ? undefined : literalSeconds(shell[1] as string);
        if (shellSeconds !== undefined) {
          return {
            form: 'exec-shell-sleep',
            delay: this.number(shellSeconds, 's', commandSource),
            source,
          };
        }
      }
    }
    return hook();
  }

  // ---- services -------------------------------------------------------

  private annotations(view: ObjectView): Rec | undefined {
    const a = dig(view.value, ['metadata', 'annotations']);
    return isRec(a) ? a : undefined;
  }

  private annotation(
    view: ObjectView,
    annotations: Rec | undefined,
    key: string,
  ): { raw: unknown; source: SourceRef } | undefined {
    if (annotations === undefined || !Object.hasOwn(annotations, key)) return undefined;
    return { raw: annotations[key], source: view.at(['metadata', 'annotations', key]) };
  }

  private fixedOrText(
    raw: unknown,
    list: readonly string[],
    source: SourceRef,
    what: string,
  ): Maybe {
    if (typeof raw !== 'string')
      return this.log.mark('unsupported-form', source, `${what} is not text`);
    const word = fixedFrom(list, raw);
    return word === undefined ? this.text(raw, source) : this.fixed(word, source);
  }

  private service(view: ObjectView): void {
    const id = this.identity(view, 'Service');
    if (id === undefined) return;
    const key = this.note(['Service', id.namespace, id.name]);
    const annotations = this.annotations(view);
    const selector = dig(view.value, ['spec', 'selector']);
    const rawPorts = dig(view.value, ['spec', 'ports']);
    const type = dig(view.value, ['spec', 'type']);
    const nlbType = this.annotation(view, annotations, ANN_NLB_TYPE);
    const nlbTarget = this.annotation(view, annotations, ANN_NLB_TARGET);
    const nlbAttributes = this.annotation(view, annotations, ANN_NLB_ATTRIBUTES);
    const ports: K8sServicePort[] = [];
    if (Array.isArray(rawPorts)) {
      rawPorts.forEach((p, i) => {
        if (!isRec(p)) return;
        const at = (rest: PathKey[]): SourceRef => view.at(['spec', 'ports', i, ...rest]);
        const name = own(p, 'name');
        const port = own(p, 'port');
        const target = own(p, 'targetPort');
        ports.push({
          source: at([]),
          ...(typeof name === 'string' ? { name: this.text(name, at(['name'])) } : {}),
          ...(port === undefined || port === null
            ? {}
            : { port: this.portNumber(port, at(['port'])) }),
          ...(target === undefined || target === null
            ? {}
            : { targetPort: this.targetPort(target, at(['targetPort'])) }),
        });
      });
    }
    // A selector that is not a mapping is flagged by `pairs` and selects nothing.
    const serviceSelector =
      selector === undefined || selector === null
        ? undefined
        : this.pairs(
            selector,
            view.at,
            ['spec', 'selector'],
            'a selector value',
            'the selector is',
          );
    const build = (duplicate: boolean): K8sService => ({
      name: inputText(id.name),
      namespace: inputText(id.namespace),
      namespaceDeclared: id.declared,
      source: view.at(['kind']),
      ...(serviceSelector === undefined ? {} : { selector: serviceSelector }),
      ports,
      ...(type === undefined || type === null
        ? {}
        : {
            type: this.fixedOrText(
              type,
              SERVICE_TYPES,
              view.at(['spec', 'type']),
              'the Service type',
            ),
          }),
      ...(nlbType === undefined
        ? {}
        : {
            awsLoadBalancerType: this.fixedOrText(
              nlbType.raw,
              NLB_TYPES,
              nlbType.source,
              'the load balancer type',
            ),
          }),
      ...(nlbTarget === undefined
        ? {}
        : {
            awsNlbTargetType: this.fixedOrText(
              nlbTarget.raw,
              NLB_TARGET_TYPES,
              nlbTarget.source,
              'the NLB target type',
            ),
          }),
      ...(nlbAttributes === undefined
        ? {}
        : {
            awsLoadBalancerAttributes: this.textOrUnresolved(
              nlbAttributes.raw,
              nlbAttributes.source,
              'the load balancer attributes',
            ),
          }),
      duplicate,
    });
    this.pendingDuplicates.push({ key, apply: (dup) => this.services.push(build(dup)) });
  }

  /** A port number, or a port name (a string): the two forms of `targetPort`. */
  private targetPort(raw: unknown, source: SourceRef): Maybe {
    if (typeof raw === 'string') return this.text(raw, source);
    return this.portNumber(raw, source);
  }

  // ---- ingresses ------------------------------------------------------

  private ingress(view: ObjectView): void {
    const id = this.identity(view, 'Ingress');
    if (id === undefined) return;
    const annotations = this.annotations(view);
    const className = dig(view.value, ['spec', 'ingressClassName']);
    const legacy = this.annotation(view, annotations, ANN_LEGACY_CLASS);
    const attrs = this.annotation(view, annotations, ANN_LB_ATTRIBUTES);
    const target = this.annotation(view, annotations, ANN_TARGET_TYPE);
    const lbName = this.annotation(view, annotations, ANN_LB_NAME);
    const group = this.annotation(view, annotations, ANN_GROUP_NAME);
    const hasAlbAnnotation =
      annotations !== undefined && Object.keys(annotations).some((k) => k.startsWith(ALB_PREFIX));
    const key = this.note(['Ingress', id.namespace, id.name]);

    const build = (recognisedBy: K8sIngress['recognisedBy'], duplicate: boolean): K8sIngress => ({
      name: inputText(id.name),
      namespace: inputText(id.namespace),
      namespaceDeclared: id.declared,
      source: view.at(['kind']),
      recognisedBy,
      ...(typeof className === 'string'
        ? { ingressClassName: this.text(className, view.at(['spec', 'ingressClassName'])) }
        : {}),
      ...(legacy !== undefined && typeof legacy.raw === 'string'
        ? { legacyClass: this.text(legacy.raw, legacy.source) }
        : {}),
      ...(attrs === undefined ? {} : { idleTimeout: this.idleTimeout(attrs.raw, attrs.source) }),
      ...(target === undefined ? {} : { targetType: this.targetType(target.raw, target.source) }),
      ...(lbName === undefined
        ? {}
        : {
            loadBalancerName: this.textOrUnresolved(
              lbName.raw,
              lbName.source,
              'the load balancer name',
            ),
          }),
      ...(group === undefined
        ? {}
        : {
            groupName: this.textOrUnresolved(group.raw, group.source, 'the group name'),
          }),
      backends: this.backends(view),
      duplicate,
    });
    this.ingressDrafts.push({
      rawClassName: typeof className === 'string' ? className : undefined,
      legacyAlb: legacy !== undefined && legacy.raw === 'alb',
      legacyClassName:
        legacy !== undefined && typeof legacy.raw === 'string' ? legacy.raw : undefined,
      hasAlbAnnotation,
      name: id.name,
      namespace: id.namespace,
      build: (r) => build(r, this.isDuplicate(key)),
      unchecked: this.unchecked('Ingress', 'not-alb-ingress', view),
      buildConflict: (conflict) => ({
        name: inputText(id.name),
        namespace: inputText(id.namespace),
        namespaceDeclared: id.declared,
        source: view.at(['kind']),
        backends: this.backends(view),
        duplicate: this.isDuplicate(key),
        conflict,
      }),
    });
  }

  /**
   * `load-balancer-attributes` is a comma-separated list of `key=value`. A list
   * with any item that is not `key=value`, or with the idle key twice, or with
   * no idle key at all, gives no number: unresolved, with a fixed reason.
   */
  private idleTimeout(raw: unknown, source: SourceRef): Maybe {
    if (typeof raw !== 'string') {
      return this.log.mark('unsupported-form', source, 'the load balancer attributes are not text');
    }
    let found: string | undefined;
    let count = 0;
    for (const item of raw.split(',')) {
      const eq = item.indexOf('=');
      const k = eq === -1 ? item : item.slice(0, eq);
      if (eq === -1 || k.length === 0) {
        return this.log.mark(
          'unsupported-form',
          source,
          'the load balancer attribute list is malformed',
        );
      }
      // Padding around a key or value is not read as if it were absent: whether the
      // controller trims it has not been checked, so the list is not trusted (honesty rule).
      const v = item.slice(eq + 1);
      if (k !== k.trim() || v !== v.trim()) {
        return this.log.mark(
          'unsupported-form',
          source,
          'the load balancer attribute list has spaces around a key or value',
        );
      }
      if (k === IDLE_ATTRIBUTE) {
        count += 1;
        found = v;
      }
    }
    if (count === 0)
      return this.log.mark('non-literal', source, 'the attribute list sets no idle timeout');
    if (count > 1)
      return this.log.mark(
        'ambiguous',
        source,
        'the attribute list sets the idle timeout more than once',
      );
    const seconds = found !== undefined ? literalSeconds(found) : undefined;
    if (seconds === undefined) {
      return this.log.mark(
        'unsupported-form',
        source,
        'the idle timeout is not a whole number of seconds',
      );
    }
    // The documented range of the setting (see core/limits.ts).
    if (!isDocumentedAlbIdle(seconds)) {
      return this.log.mark('unsupported-form', source, REASON_ALB_IDLE_OUT_OF_RANGE);
    }
    return this.number(seconds, 's', source);
  }

  private targetType(raw: unknown, source: SourceRef): Maybe {
    if (typeof raw !== 'string')
      return this.log.mark('unsupported-form', source, 'the target type is not text');
    const word = targetTypeFromInput(raw);
    return word === undefined
      ? this.log.mark('unsupported-form', source, 'the target type is not ip or instance')
      : this.fixed(word, source);
  }

  private backends(view: ObjectView): K8sBackend[] {
    const out: K8sBackend[] = [];
    const add = (backend: unknown, path: readonly PathKey[]): void => {
      if (!isRec(backend)) return;
      // networking.k8s.io/v1: `service.{name, port}`; the older forms: `serviceName`, `servicePort`.
      const service = own(backend, 'service');
      const name = isRec(service) ? own(service, 'name') : own(backend, 'serviceName');
      if (typeof name !== 'string' || name.length === 0) return; // a resource backend: not a Service
      const portPath = isRec(service) ? [...path, 'service', 'port'] : [...path, 'servicePort'];
      const portRaw = isRec(service) ? dig(service, ['port']) : own(backend, 'servicePort');
      out.push({
        serviceName: inputText(name),
        source: view.at(path),
        ...this.backendPort(portRaw, portPath, view),
      });
    };
    add(dig(view.value, ['spec', 'defaultBackend']), ['spec', 'defaultBackend']);
    add(dig(view.value, ['spec', 'backend']), ['spec', 'backend']);
    const rules = dig(view.value, ['spec', 'rules']);
    if (Array.isArray(rules)) {
      rules.forEach((rule, r) => {
        const paths = dig(rule, ['http', 'paths']);
        if (!Array.isArray(paths)) return;
        paths.forEach((p, i) => {
          if (isRec(p)) add(own(p, 'backend'), ['spec', 'rules', r, 'http', 'paths', i, 'backend']);
        });
      });
    }
    return out;
  }

  private backendPort(
    raw: unknown,
    path: readonly PathKey[],
    view: ObjectView,
  ): { port?: K8sBackendPort } {
    if (raw === undefined || raw === null) return {};
    // v1: {number: N} or {name: text}; the older `servicePort`: a number or a name.
    if (isRec(raw)) {
      const n = own(raw, 'number');
      const name = own(raw, 'name');
      return {
        port: {
          ...(n === undefined || n === null
            ? {}
            : { number: this.portNumber(n, view.at([...path, 'number'])) }),
          ...(typeof name === 'string'
            ? { name: this.text(name, view.at([...path, 'name'])) }
            : {}),
        },
      };
    }
    if (typeof raw === 'string') return { port: { name: this.text(raw, view.at(path)) } };
    return { port: { number: this.portNumber(raw, view.at(path)) } };
  }

  // ---- ingress classes ------------------------------------------------

  private ingressClass(view: ObjectView): void {
    const meta = own(view.value, 'metadata');
    const name = isRec(meta) ? own(meta, 'name') : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      this.log.mark(
        'object-not-identified',
        view.at(['metadata']),
        'an IngressClass has no literal name',
      );
      return;
    }
    const key = this.note(['IngressClass', name]);
    const controller = dig(view.value, ['spec', 'controller']);
    const isAlb = controller === ALB_INGRESS_CONTROLLER;
    if (isAlb) this.albClassNames.add(name);
    const source = view.at(['spec', 'controller']);
    this.pendingDuplicates.push({
      key,
      apply: (dup) =>
        this.ingressClasses.push({
          name: inputText(name),
          source: view.at(['kind']),
          ...(controller === undefined || controller === null
            ? {}
            : { controller: this.textOrUnresolved(controller, source, 'the controller') }),
          isAlbController: isAlb,
          duplicate: dup,
        }),
    });
  }

  // ---- end ------------------------------------------------------------

  finish(): K8sReadResult {
    for (const pending of this.pendingDuplicates) pending.apply(this.isDuplicate(pending.key));
    const ingresses: K8sIngress[] = [];
    const classConflictIngresses: K8sClassConflictIngress[] = [];
    for (const draft of this.ingressDrafts) {
      let by: K8sIngress['recognisedBy'] | undefined;
      // Two class signals that name different classes, one of them the ALB controller's:
      // which one the cluster honours is not known (second review pass, N5).
      const isAlbClass = (c: string | undefined): boolean =>
        c !== undefined && (c === 'alb' || this.albClassNames.has(c));
      const twoClasses =
        draft.rawClassName !== undefined &&
        draft.legacyClassName !== undefined &&
        draft.rawClassName !== draft.legacyClassName &&
        (isAlbClass(draft.rawClassName) || isAlbClass(draft.legacyClassName));
      if (twoClasses) {
        this.uncheckedKinds.push(draft.unchecked);
        classConflictIngresses.push(draft.buildConflict('two-classes'));
        continue;
      }
      if (draft.rawClassName === 'alb') by = 'ingress-class-name';
      else if (draft.legacyAlb) by = 'legacy-annotation';
      else if (draft.rawClassName !== undefined && this.albClassNames.has(draft.rawClassName))
        by = 'ingress-class-object';
      else if (draft.legacyClassName !== undefined && this.albClassNames.has(draft.legacyClassName))
        by = 'ingress-class-object';
      // A class that is named and is not the ALB controller's decides: the ALB
      // annotations do not make it an ALB Ingress. Only when
      // no class is named do the annotations recognise one (option A).
      else if (
        draft.hasAlbAnnotation &&
        draft.rawClassName === undefined &&
        draft.legacyClassName === undefined
      )
        by = 'alb-annotation';
      if (by === undefined) {
        this.uncheckedKinds.push(draft.unchecked);
        const classNamed = draft.rawClassName !== undefined || draft.legacyClassName !== undefined;
        if (classNamed && draft.hasAlbAnnotation)
          classConflictIngresses.push(draft.buildConflict('alb-annotations'));
      } else ingresses.push(draft.build(by));
    }
    return Object.freeze({
      workloads: Object.freeze(this.workloads),
      ingresses: Object.freeze(ingresses),
      classConflictIngresses: Object.freeze(classConflictIngresses),
      services: Object.freeze(this.services),
      ingressClasses: Object.freeze(this.ingressClasses),
      uncheckedKinds: Object.freeze(this.uncheckedKinds),
      unresolved: Object.freeze(this.log.items),
    });
  }
}

/** A literal whole number of seconds: digits only, within the safe integer range. */
function literalSeconds(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Reads the Kubernetes objects of an intake result: every `k8s-yaml` file in
 * order, then the standard-input stream. Never throws on input; what cannot be
 * read is an unresolved marker or an unchecked kind, and the rest is still read.
 */
export function readKubernetes(intake: IntakeResult): K8sReadResult {
  const reader = new Reader();
  for (const file of intake.files) {
    if (file.class !== 'k8s-yaml') continue;
    for (const doc of file.documents ?? []) reader.readDocument(doc);
  }
  for (const doc of intake.stream?.documents ?? []) reader.readDocument(doc);
  return reader.finish();
}
