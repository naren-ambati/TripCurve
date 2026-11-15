import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type InputText,
  isInputText,
  isSourcedValue,
  isUnresolved,
  K8S_WORKLOAD_KINDS,
} from '../../src/core/index.js';
import { intake, intakeStreamBytes } from '../../src/parse/intake/index.js';
import {
  ALB_INGRESS_CONTROLLER,
  GATEWAY_API_KINDS,
  type K8sReadResult,
  readKubernetes,
} from '../../src/parse/k8s/index.js';
import { container, pairs, preStop, val } from '../support/k8s-summary.js';
import { makeRng } from '../support/prng.js';
import { txt, where } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'k8s');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function readDir(dir: string): K8sReadResult {
  return readKubernetes(intake({ root: join(FIXTURES, dir) }));
}
// The prefix only makes the file look like Kubernetes YAML to intake.
const PREFIX = 'apiVersion: v1\nkind: Placeholder\n---\n';
function readText(text: string): K8sReadResult {
  const t = makeTree();
  trees.push(t);
  t.write('a.yaml', `${PREFIX}${text}`);
  return readKubernetes(intake({ root: t.root }));
}
/** The line a needle is on in `PREFIX + text`: an oracle that does not use the reader. */
function lineOf(text: string, needle: string, nth = 1): number {
  const lines = `${PREFIX}${text}`.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] as string).includes(needle)) {
      seen += 1;
      if (seen === nth) return i + 1;
    }
  }
  throw new Error(`no line with ${needle}`);
}
function byName<T extends { name: InputText }>(list: readonly T[], name: string): T {
  const found = list.find((item) => txt(item.name) === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

describe('the web fixture: Deployment, Service, ALB Ingress', () => {
  const r = readDir('web');

  it('reads the workload with name, namespace, labels, pod labels, selector and grace period, each with a line', () => {
    expect(r.workloads).toHaveLength(1);
    const w = r.workloads[0];
    expect(w?.kind).toBe('Deployment');
    expect(txt(w?.name as never)).toBe('web');
    expect(txt(w?.namespace as never)).toBe('shop');
    expect(w?.namespaceDeclared).toBe(true);
    expect(where(w?.source as never)).toBe('web.yaml:2');
    expect(pairs(w?.labels)).toEqual(['app="web"@web.yaml:7', 'tier="frontend"@web.yaml:8']);
    expect(pairs(w?.podLabels)).toEqual(['app="web"@web.yaml:17']);
    expect(pairs(w?.selectorMatchLabels)).toEqual(['app="web"@web.yaml:13']);
    expect(val(w?.gracePeriod)).toBe('45s@web.yaml:19');
    expect(w?.duplicate).toBe(false);
  });

  it('reads the container: image, command, args, literal env, ports and preStop', () => {
    const c = container(r.workloads[0]?.containers[0] as never);
    expect(c).toEqual({
      name: 'app',
      at: 'web.yaml:21',
      image: '"node:22.23"@web.yaml:22',
      command: ['"node"@web.yaml:23', '"src/server.js"@web.yaml:23'],
      args: ['"--port"@web.yaml:24', '"8080"@web.yaml:24'],
      env: [
        'NODE_ENV="production"@web.yaml:27',
        'API_KEY=?the value comes from a reference, which is not read',
        'EMPTY=""@web.yaml:33',
      ],
      envFrom: undefined,
      ports: ['"http"@web.yaml:35 8080@web.yaml:36'],
      preStop: 'exec-sleep 10s@web.yaml:40',
    });
  });

  it('recognises the ALB Ingress and reads idle seconds, target type, name and the backend, with lines', () => {
    expect(r.ingresses).toHaveLength(1);
    const i = r.ingresses[0];
    expect(i?.recognisedBy).toBe('ingress-class-name');
    expect(val(i?.ingressClassName)).toBe('"alb"@ingress.yaml:11');
    expect(val(i?.idleTimeout)).toBe('60s@ingress.yaml:7');
    expect(val(i?.targetType)).toBe('ip@ingress.yaml:8');
    expect(val(i?.loadBalancerName)).toBe('"shop-alb"@ingress.yaml:9');
    expect(i?.backends).toHaveLength(1);
    const b = i?.backends[0];
    expect(txt(b?.serviceName as never)).toBe('web');
    expect(val(b?.port?.number)).toBe('80@ingress.yaml:21');
    expect(where(b?.source as never)).toBe('ingress.yaml:18');
  });

  it('reads the Service: selector, ports with targetPort, type', () => {
    const s = r.services[0];
    expect(pairs(s?.selector)).toEqual(['app="web"@service.yaml:9']);
    expect(val(s?.type)).toBe('ClusterIP@service.yaml:7');
    expect(s?.ports.map((p) => `${val(p.name)} ${val(p.port)} -> ${val(p.targetPort)}`)).toEqual([
      '"http"@service.yaml:11 80@service.yaml:12 -> 8080@service.yaml:13',
    ]);
  });

  it('lists the unresolved value: the valueFrom environment value, with its line', () => {
    expect(r.unresolved.map((u) => `${u.what}@${where(u.where)}`)).toEqual([
      'value-from-reference@web.yaml:28',
    ]);
    expect(r.uncheckedKinds).toEqual([]);
  });

  it("no field holds input text as a bare string: the only bare strings are tripcurve's own words", () => {
    const allowedWords = new Set<string>([
      ...K8S_WORKLOAD_KINDS,
      'ingress-class-name',
      'legacy-annotation',
      'ingress-class-object',
      'alb-annotation',
      'exec-sleep',
      'exec-shell-sleep',
      'sleep-handler',
      'hook',
      'file',
      'stdin',
      'declared',
      'default',
      'value-from-reference',
    ]);
    const bare: Array<[string, string]> = [];
    const collect = (value: unknown, key: string): void => {
      if (isInputText(value) || isSourcedValue(value) || isUnresolved(value)) return;
      if (typeof value === 'string') bare.push([key, value]);
      else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) collect(v, k);
      }
    };
    collect(r, 'r');
    expect(bare.length).toBeGreaterThan(5);
    // `label` is the fixed text of an unresolved marker (checked below); every other bare string is a word
    for (const [key, value] of bare) {
      if (key === 'label') continue;
      expect(allowedWords.has(value), `${key}=${value}`).toBe(true);
    }
    for (const u of r.unresolved) expect(u.label).toMatch(/^[a-z][a-z ,.]+$/);
    for (const u of r.unresolved) expect(['value-from-reference']).toContain(u.what);
  });
});

describe('workload kinds', () => {
  const r = readDir('shapes');
  it('reads StatefulSet, DaemonSet and a bare Pod, and ignores a Job and a ConfigMap', () => {
    const kinds = r.workloads.map((w) => `${w.kind} ${txt(w.name)}`);
    for (const expected of ['StatefulSet db', 'DaemonSet agent', 'Pod lonely']) {
      expect(kinds).toContain(expected);
    }
    expect(kinds.join('|')).not.toMatch(/not-a-workload|cm/);
  });

  it('a bare Pod carries its containers and labels directly', () => {
    const pod = byName(r.workloads, 'lonely');
    expect(pairs(pod.podLabels)).toEqual(pairs(pod.labels));
    expect(pod.selectorMatchLabels).toBeUndefined();
    expect(val(pod.gracePeriod)).toBe('5s@workloads.yaml:38');
    expect(pod.containers.map((c) => preStop(c.preStop))).toEqual([
      'sleep-handler 7s@workloads.yaml:45',
    ]);
  });

  it('a missing namespace is "default" and says it was not written', () => {
    const db = byName(r.workloads, 'db');
    expect(txt(db.namespace)).toBe('default');
    expect(db.namespaceDeclared).toBe(false);
    expect(byName(r.workloads, 'agent').namespaceDeclared).toBe(true);
  });

  it('a grace period of 0 is read as 0, not as absent', () => {
    expect(val(byName(r.workloads, 'agent').gracePeriod)).toBe('0s@workloads.yaml:26');
    expect(byName(r.workloads, 'db').gracePeriod).toBeUndefined();
  });

  it("the kind is matched exactly and the stored kind is tripcurve's constant", () => {
    const odd = readText(
      'apiVersion: apps/v1\nkind: deployment\nmetadata: {name: a}\n---\n' +
        'apiVersion: apps/v1\nkind: "Deployment "\nmetadata: {name: b}\n---\n' +
        'apiVersion: apps/v1\nkind: [Deployment]\nmetadata: {name: c}\n---\n' +
        'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: d}\nspec: {template: {spec: {containers: []}}}\n',
    );
    expect(odd.workloads.map((w) => txt(w.name))).toEqual(['d']);
    for (const w of r.workloads) expect(K8S_WORKLOAD_KINDS as readonly string[]).toContain(w.kind);
  });
});

describe('preStop forms', () => {
  const r = readDir('shapes');
  // oracle: the first `preStop:` line after the `- name: <container>` line of the fixture
  const fixture = readFileSync(join(FIXTURES, 'shapes', 'prestop.yaml'), 'utf8').split('\n');
  const preStopKeyLine = (name: string): number => {
    const start = fixture.findIndex((l) => l.trim() === `- name: ${name}`);
    return start + fixture.slice(start).findIndex((l) => l.trim() === 'preStop:') + 1;
  };
  const hooks = byName(r.workloads, 'hooks');
  const byContainer = (name: string): string | undefined =>
    preStop(hooks.containers.find((c) => txt(c.name) === name)?.preStop);

  it('exec sleep N, exec /bin/sh -c "sleep N" and the sleep handler are delays', () => {
    expect(byContainer('exec-sleep')).toBe('exec-sleep 5s@prestop.yaml:14');
    expect(byContainer('shell-sleep')).toBe('exec-shell-sleep 12s@prestop.yaml:20');
    expect(byContainer('sleep-handler')).toBe('sleep-handler 3s@prestop.yaml:26');
  });

  it('any other preStop is a hook of unresolved duration, with its line', () => {
    const hook = 'hook ?the preStop hook has no delay tripcurve can read';
    for (const name of [
      'shell-with-more',
      'shell-extra-word',
      'bash',
      'variable',
      'http',
      'two-handlers',
      'negative-sleep',
      'huge',
    ]) {
      expect(byContainer(name), name).toBe(hook);
    }
    const lines = r.unresolved
      .filter((u) => u.what === 'hook-unresolved-duration')
      .map((u) => where(u.where));
    expect(lines).toEqual([
      // the line of the `preStop:` key of each container (a block value starts one line later)
      ...[
        'shell-with-more',
        'shell-extra-word',
        'bash',
        'variable',
        'http',
        'two-handlers',
        'negative-sleep',
        'huge',
      ].map((name) => `prestop.yaml:${preStopKeyLine(name)}`),
    ]);
  });

  it('no preStop at all is absent, not zero', () => {
    expect(byContainer('none')).toBeUndefined();
  });
});

describe('Ingress recognition', () => {
  const r = readDir('shapes');
  const recognised = Object.fromEntries(r.ingresses.map((i) => [txt(i.name), i.recognisedBy]));

  it('recognises by ingressClassName alb, the legacy annotation, an IngressClass for the AWS controller, or any alb annotation', () => {
    expect(recognised['by-class-name']).toBe('ingress-class-name');
    expect(recognised['by-legacy']).toBe('legacy-annotation');
    expect(recognised['by-class-object']).toBe('ingress-class-object');
    expect(recognised['by-annotation']).toBe('alb-annotation');
  });

  it('the controller string is the one looked up on 2026-11-11', () => {
    expect(ALB_INGRESS_CONTROLLER).toBe('ingress.k8s.aws/alb');
    const classes = Object.fromEntries(
      r.ingressClasses.map((c) => [txt(c.name), c.isAlbController]),
    );
    expect(classes).toEqual({ aws: true, nginx: false });
  });

  it('any other Ingress is not in `ingresses` and is listed with its fixed reason', () => {
    for (const name of ['plain-nginx', 'no-class', 'class-name-is-not-alb-controller']) {
      expect(recognised[name]).toBeUndefined();
    }
    const listed = r.uncheckedKinds
      .filter((u) => u.kind === 'Ingress')
      .map((u) => `${txt(u.name as never)}|${u.reasonCode}`);
    expect(listed).toEqual([
      'plain-nginx|not-alb-ingress',
      'no-class|not-alb-ingress',
      'class-name-is-not-alb-controller|not-alb-ingress',
    ]);
  });

  it('a Gateway API route is a kind not checked; the same kind name in another group is ignored', () => {
    const routes = r.uncheckedKinds.filter((u) => u.reasonCode === 'kind-not-checked');
    expect(routes.map((u) => `${u.kind}|${txt(u.name as never)}`)).toEqual(['HTTPRoute|route']);
    expect(GATEWAY_API_KINDS).toContain('HTTPRoute');
  });

  it('an IngressClass that appears in a later file still counts', () => {
    const t = makeTree();
    trees.push(t);
    t.write(
      'a-ingress.yaml',
      'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: {name: i}\nspec: {ingressClassName: custom}\n',
    );
    t.write(
      'z-class.yaml',
      'apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata: {name: custom}\nspec: {controller: ingress.k8s.aws/alb}\n',
    );
    const out = readKubernetes(intake({ root: t.root }));
    expect(out.ingresses.map((i) => i.recognisedBy)).toEqual(['ingress-class-object']);
    expect(out.uncheckedKinds).toEqual([]);
  });

  it('an IngressClass whose controller only looks like the AWS one does not count', () => {
    const out = readText(
      'apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata: {name: fake}\nspec: {controller: "ingress.k8s.aws/alb2"}\n---\n' +
        'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: {name: i}\nspec: {ingressClassName: fake}\n',
    );
    expect(out.ingresses).toEqual([]);
    expect(out.uncheckedKinds.map((u) => u.reasonCode)).toEqual(['not-alb-ingress']);
  });
});

describe('ALB annotations', () => {
  const r = readDir('shapes');
  const idle = (name: string): string | undefined => val(byName(r.ingresses, name).idleTimeout);

  it('reads the idle timeout from an attribute list and the target type', () => {
    expect(idle('idle-120')).toBe('120s@annotations.yaml:6');
    expect(val(byName(r.ingresses, 'idle-120').targetType)).toBe('instance@annotations.yaml:7');
    expect(idle('none-set')).toBeUndefined();
  });

  it('a malformed or ambiguous attribute list is unresolved, never a number', () => {
    expect(idle('malformed-list')).toBe('?the load balancer attribute list is malformed');
    expect(idle('no-equals')).toBe('?the load balancer attribute list is malformed');
    expect(idle('twice')).toBe('?the attribute list sets the idle timeout more than once');
    expect(idle('not-a-number')).toBe('?the idle timeout is not a whole number of seconds');
    expect(idle('negative-and-float')).toBe('?the idle timeout is not a whole number of seconds');
    expect(idle('no-idle-key')).toBe('?the attribute list sets no idle timeout');
    expect(idle('numeric-annotation')).toBe('?the load balancer attributes are not text');
  });

  it("padding spaces are not trusted: unresolved, because the controller's trimming was not checked", () => {
    expect(idle('padded')).toBe(
      '?the load balancer attribute list has spaces around a key or value',
    );
  });

  it('a target type other than ip or instance is unresolved', () => {
    expect(val(byName(r.ingresses, 'not-a-number').targetType)).toBe(
      '?the target type is not ip or instance',
    );
  });

  it('every unresolved annotation is also in the unresolved list with its line', () => {
    const lines = r.unresolved.filter((u) => where(u.where).startsWith('annotations.yaml')).length;
    expect(lines).toBeGreaterThanOrEqual(8);
  });

  it('whole seconds only, inside the documented range 1 to 4000 (m3); an exponent or a sign is not a number', () => {
    const mk = (v: string): string | undefined => {
      const text = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\n  annotations:\n    alb.ingress.kubernetes.io/load-balancer-attributes: "idle_timeout.timeout_seconds=${v}"\nspec: {ingressClassName: alb}\n`;
      return val(readText(text).ingresses[0]?.idleTimeout);
    };
    const annotationLine = lineOf(
      'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\n  annotations:\n    alb.ingress.kubernetes.io/load-balancer-attributes: "x"\nspec: {ingressClassName: alb}\n',
      'load-balancer-attributes',
    );
    expect(mk('1')).toBe(`1s@a.yaml:${annotationLine}`);
    expect(mk('4000')).toBe(`4000s@a.yaml:${annotationLine}`);
    expect(mk('0')).toBe('?outside the documented range 1 to 4000 s');
    expect(mk('4001')).toBe('?outside the documented range 1 to 4000 s');
    expect(mk('00')).toBe('?outside the documented range 1 to 4000 s');
    for (const bad of ['1e3', '+60', '60.5', '0x10', '', '99999999999999999999']) {
      expect(mk(bad), bad).toMatch(/^\?/);
    }
  });
});

describe('Service and the NLB annotations', () => {
  const r = readDir('shapes');
  const stream = byName(r.services, 'stream');

  it('reads the NLB annotations and the port forms', () => {
    expect(val(stream.type)).toBe('LoadBalancer@stream-nlb.yaml:29');
    expect(val(stream.awsLoadBalancerType)).toBe('external@stream-nlb.yaml:25');
    expect(val(stream.awsNlbTargetType)).toBe('ip@stream-nlb.yaml:26');
    expect(val(stream.awsLoadBalancerAttributes)).toBe(
      '"load_balancing.cross_zone.enabled=true"@stream-nlb.yaml:27',
    );
    expect(stream.ports.map((p) => `${val(p.port)} -> ${val(p.targetPort)}`)).toEqual([
      '443@stream-nlb.yaml:34 -> 9000@stream-nlb.yaml:35',
      '80@stream-nlb.yaml:36 -> "http"@stream-nlb.yaml:37',
      '81@stream-nlb.yaml:38 -> undefined',
    ]);
  });

  it('known words are tripcurve constants; other text stays input text', () => {
    const text =
      'apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  annotations:\n    service.beta.kubernetes.io/aws-load-balancer-type: "some-other"\n    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip "\nspec:\n  type: Weird\n';
    const s = readText(text).services[0];
    expect(val(s?.awsLoadBalancerType)).toBe(`"some-other"@a.yaml:${lineOf(text, 'some-other')}`);
    expect(val(s?.awsNlbTargetType)).toBe(`"ip "@a.yaml:${lineOf(text, 'nlb-target-type')}`);
    expect(val(s?.type)).toBe(`"Weird"@a.yaml:${lineOf(text, 'type: Weird')}`);
  });

  it('a Service with no selector has none, which is not the same as an empty one', () => {
    const out = readText(
      'apiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {type: ExternalName}\n',
    );
    expect(out.services[0]?.selector).toBeUndefined();
    const empty = readText(
      'apiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {selector: {}}\n',
    );
    expect(empty.services[0]?.selector).toEqual([]);
  });
});

describe('Ingress backends: both API shapes', () => {
  it('reads defaultBackend, rules paths, a named port and the old serviceName form', () => {
    const text = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: i, annotations: {alb.ingress.kubernetes.io/scheme: internal}}
spec:
  defaultBackend:
    service: {name: fallback, port: {name: http}}
  rules:
    - http:
        paths:
          - backend: {service: {name: api, port: {number: 8080}}}
          - backend: {resource: {kind: StorageBucket, name: assets}}
---
apiVersion: extensions/v1beta1
kind: Ingress
metadata: {name: old, annotations: {alb.ingress.kubernetes.io/scheme: internal}}
spec:
  backend: {serviceName: legacy, servicePort: 80}
  rules:
    - http: {paths: [{backend: {serviceName: legacy2, servicePort: web}}]}
`;
    const out = readText(text);
    const rows = out.ingresses.flatMap((i) =>
      i.backends.map(
        (b) =>
          `${txt(i.name)}: ${txt(b.serviceName)} ${val(b.port?.number) ?? val(b.port?.name) ?? '-'}`,
      ),
    );
    expect(rows).toEqual([
      `i: fallback "http"@a.yaml:${lineOf(text, 'name: fallback')}`,
      `i: api 8080@a.yaml:${lineOf(text, 'name: api')}`,
      `old: legacy 80@a.yaml:${lineOf(text, 'serviceName: legacy,')}`,
      `old: legacy2 "web"@a.yaml:${lineOf(text, 'serviceName: legacy2')}`,
    ]);
    // the Resource backend is not a Service and is not read as one
    expect(out.ingresses[0]?.backends.map((b) => txt(b.serviceName))).toEqual(['fallback', 'api']);
  });
});

describe('duplicates, multi-document files, lists, anchors and merge keys', () => {
  const r = readDir('shapes');

  it('keeps both objects of the same kind, namespace and name and flags both', () => {
    const twins = r.workloads.filter((w) => txt(w.name) === 'twin');
    expect(twins.map((w) => `${txt(w.namespace)}:${w.duplicate}`)).toEqual([
      'a:true',
      'a:true',
      'b:false',
    ]);
    expect(twins.map((w) => txt(w.containers[0]?.name as never))).toEqual(['one', 'two', 'three']);
    const svcs = r.services.filter((s) => txt(s.name) === 'svc');
    expect(svcs.map((s) => s.duplicate)).toEqual([true, true]);
  });

  it('the same name under different kinds is not a duplicate', () => {
    const out = readText(
      'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: x}\nspec: {template: {spec: {containers: []}}}\n---\napiVersion: v1\nkind: Service\nmetadata: {name: x}\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: x}\nspec: {containers: []}\n',
    );
    expect([...out.workloads, ...out.services].map((o) => o.duplicate)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('names that could collide when joined do not (length-prefixed keys)', () => {
    const out = readText(
      'apiVersion: v1\nkind: Pod\nmetadata: {name: "b", namespace: "a|1:b"}\nspec: {containers: []}\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: "b|1:b", namespace: "a"}\nspec: {containers: []}\n',
    );
    expect(out.workloads.map((w) => w.duplicate)).toEqual([false, false]);
  });

  it('flattens a List and a typed list, and reads each item', () => {
    expect(txt(byName(r.workloads, 'in-list').name)).toBe('in-list');
    expect(byName(r.workloads, 'in-list').kind).toBe('Pod');
    expect(byName(r.workloads, 'typed-list-item').kind).toBe('Deployment');
    expect(txt(byName(r.services, 'svc-in-list').name)).toBe('svc-in-list');
    expect(where(byName(r.workloads, 'in-list').source)).toBe('list.yaml:5');
  });

  it('anchors, aliases and merge keys resolve', () => {
    const w = byName(r.workloads, 'anchored');
    expect(pairs(w.podLabels)).toEqual(['app="anchored"@anchors.yaml:10']);
    expect(w.containers.map((c) => container(c).image)).toEqual([
      '"example/base:1"@anchors.yaml:15',
      '"example/base:1"@anchors.yaml:19',
    ]);
    expect(w.containers.map((c) => txt(c.name))).toEqual(['base', 'merged']);
  });

  it('a malformed document does not hide the good ones in the same file', () => {
    const t = makeTree();
    trees.push(t);
    t.write(
      'mix.yaml',
      'apiVersion: v1\nkind: Pod\nmetadata: {name: good}\nspec: {containers: []}\n---\napiVersion: v1\nkind: Pod\nmetadata: [broken\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: also-good}\nspec: {containers: []}\n',
    );
    const result = intake({ root: t.root });
    expect(result.unchecked).toHaveLength(1);
    expect(readKubernetes(result).workloads.map((w) => txt(w.name))).toEqual(['good', 'also-good']);
  });
});

describe('odd and hostile values become unresolved markers, never a guess', () => {
  const r = readDir('shapes');
  const odd = byName(r.workloads, 'odd-values');

  it('values that are not text or not whole numbers are unresolved', () => {
    expect(pairs(odd.podLabels)).toEqual([
      'app="odd"@odd.yaml:24',
      'version=?a label value is not text',
    ]);
    expect(val(odd.gracePeriod)).toBe(
      '?the termination grace period is not a whole number of seconds',
    );
    const c = container(odd.containers[0] as never);
    expect(c.image).toBe('?the image is not text');
    expect(c.command).toBe('?the container command is not a list of text');
    expect(c.args).toBe('?the container args is not a list of text');
    expect(c.env).toEqual([
      'NUM=?an environment value is not text',
      'BOTH=?the value comes from a reference, which is not read',
    ]);
    expect(c.ports).toEqual(['- ?a port is not a whole number', '- 80@odd.yaml:44']);
  });

  it('envFrom is flagged, so an env variable that is not listed is not known to be absent', () => {
    const line =
      readFileSync(join(FIXTURES, 'shapes', 'odd.yaml'), 'utf8')
        .split('\n')
        .findIndex((l) => l.includes('envFrom:')) + 1;
    expect(container(odd.containers[0] as never).envFrom).toBe(`odd.yaml:${line}`);
  });

  it('a negative grace period is unresolved, not clamped', () => {
    expect(val(byName(r.workloads, 'negative-grace').gracePeriod)).toBe(
      '?the termination grace period is not a whole number of seconds',
    );
  });

  it('objects that cannot be identified are listed as unresolved and dropped', () => {
    const names = r.workloads.map((w) => txt(w.name));
    expect(names).not.toContain('odd');
    const labels = r.unresolved.map((u) => u.label);
    expect(labels).toContain('a workload has no literal name');
    expect(labels).toContain('the namespace of a workload is not text');
    expect(labels).toContain('a container has no literal name');
    expect(labels).toContain('a container is not a mapping');
    expect(labels).toContain('the workload has no pod spec');
  });

  it('a Deployment with no containers list has none', () => {
    expect(byName(r.workloads, 'no-spec').containers).toEqual([]);
  });

  it('input text with control characters and look-alike names stays InputText and prints escaped', () => {
    const out = readText(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: "evil\\n  FAIL T1  idle close 0 s\\e[31m"\n  namespace: "ns\\u202e"\nspec: {containers: []}\n',
    );
    const w = out.workloads[0];
    expect(String(w?.name)).toBe('[InputText]');
    expect(JSON.stringify(w)).not.toContain('FAIL');
    expect(txt(w?.name as never)).toContain('FAIL T1');
  });

  it('keys named __proto__ and constructor are ordinary data', () => {
    const out = readText(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  labels:\n    __proto__: x\n    constructor: y\n  annotations:\n    constructor: z\nspec: {containers: []}\n',
    );
    expect(({} as { x?: unknown }).x).toBeUndefined();
    const text =
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  labels:\n    __proto__: x\n    constructor: y\n  annotations:\n    constructor: z\nspec: {containers: []}\n';
    expect(pairs(out.workloads[0]?.labels)).toEqual([
      `__proto__="x"@a.yaml:${lineOf(text, '__proto__')}`,
      `constructor="y"@a.yaml:${lineOf(text, 'constructor: y')}`,
    ]);
  });

  it('a hostile pile of documents of nothing useful is read as nothing', () => {
    const out = readText(
      '---\n---\n- a\n- b\n---\nplain\n---\n42\n---\nkind: 7\n---\nkind: {a: b}\n',
    );
    expect(out.workloads).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });
});

describe('malformed containers of data', () => {
  it('labels, selectors and a Service selector that are not mappings are unresolved, not dropped quietly', () => {
    const text =
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n  labels: [a, b]\nspec: {containers: []}\n---\napiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {selector: foo}\n';
    const out = readText(text);
    expect(out.workloads[0]?.labels).toEqual([]);
    expect(out.unresolved.map((u) => `${u.label}@${where(u.where)}`)).toEqual([
      `the labels are not a mapping@a.yaml:${lineOf(text, '[a, b]')}`,
      `the selector is not a mapping@a.yaml:${lineOf(text, 'selector: foo')}`,
    ]);
    expect(out.services[0]?.selector).toEqual([]); // flagged above; selects nothing
  });

  it(
    'a very long List is read in linear time',
    () => {
      const list = (n: number) =>
        `apiVersion: v1\nkind: List\nitems:\n${Array.from(
          { length: n },
          (_, i) =>
            `  - {apiVersion: v1, kind: Pod, metadata: {name: p${i}}, spec: {containers: []}}`,
        ).join('\n')}\n`;
      expect(readText(list(20000)).workloads).toHaveLength(20000);
      expect(scalingRatio((n) => readText(list(n)), 2000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

describe('Secret data and valueFrom values are never fields of any model', () => {
  it('nothing from a Secret, a secretKeyRef, a configMapKeyRef or an envFrom reference is in the result', () => {
    const t = makeTree();
    trees.push(t);
    t.write('secrets.yaml', readFixture('shapes/secrets.yaml'));
    const out = readKubernetes(intake({ root: t.root }));
    const texts: string[] = [];
    const keys: string[] = [];
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || seen.has(value)) return;
      seen.add(value);
      if (isInputText(value)) {
        texts.push(txt(value));
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        keys.push(k);
        if (typeof v === 'string') texts.push(v);
        walk(v);
      }
    };
    walk(out);
    expect(texts.length).toBeGreaterThan(5); // the walk really visited text
    expect(texts.filter((s) => s.includes('LEAKED'))).toEqual([]);
    for (const banned of ['valueFrom', 'secretKeyRef', 'configMapKeyRef', 'data', 'stringData']) {
      expect(keys).not.toContain(banned);
    }
    // the Secret object itself is not a workload, a Service, or anything else
    expect(out.workloads.map((w) => txt(w.name))).toEqual(['uses-secret']);
    expect(out.unresolved.map((u) => u.what).sort()).toEqual([
      'value-from-reference',
      'value-from-reference',
    ]);
    const fixtureLines = readFixture('shapes/secrets.yaml').split('\n');
    const envFromLine = fixtureLines.findIndex((l) => l.includes('envFrom:')) + 1;
    expect(container(out.workloads[0]?.containers[0] as never).envFrom).toBe(
      `secrets.yaml:${envFromLine}`,
    );
  });
});

describe('standard input', () => {
  it('sources read <stdin> document n, line m', () => {
    const text =
      'apiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {selector: {app: a}}\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n        - name: c\n          image: node:22.23\n';
    const out = readKubernetes(intakeStreamBytes(Buffer.from(text)));
    expect(out.services.map((s) => where(s.source))).toEqual(['<stdin> document 1, line 2']);
    const c = out.workloads[0]?.containers[0];
    expect(val(c?.image)).toBe('"node:22.23"@<stdin> document 2, line 15');
  });
});

describe('hostile input never crashes the reader (property test over random shapes)', () => {
  const scalars = [
    null,
    true,
    false,
    0,
    -1,
    1.5,
    7,
    'x',
    '',
    'sleep',
    '$VAR',
    'alb',
    'ip',
    '9'.repeat(30),
    ['a'],
    {},
    'idle_timeout.timeout_seconds=5',
  ];
  const kinds = [
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Pod',
    'Service',
    'Ingress',
    'IngressClass',
    'List',
    'HTTPRoute',
    'Secret',
  ];
  const fields = [
    'metadata',
    'spec',
    'template',
    'containers',
    'env',
    'ports',
    'lifecycle',
    'preStop',
    'exec',
    'sleep',
    'command',
    'args',
    'labels',
    'annotations',
    'selector',
    'matchLabels',
    'name',
    'namespace',
    'image',
    'value',
    'valueFrom',
    'port',
    'targetPort',
    'rules',
    'http',
    'paths',
    'backend',
    'service',
    'items',
    'kind',
    'apiVersion',
    'ingressClassName',
    'defaultBackend',
    'controller',
    'terminationGracePeriodSeconds',
    'seconds',
    'number',
    'type',
    'envFrom',
    '__proto__',
    'constructor',
  ];

  it('random documents give a result with only valid models, and never throw', () => {
    const rng = makeRng(20261111);
    const gen = (depth: number): unknown => {
      const roll = rng.next();
      if (depth > 5 || roll < 0.35) return rng.pick(scalars);
      if (roll < 0.55) return Array.from({ length: rng.int(0, 3) }, () => gen(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = rng.int(0, 5); i > 0; i -= 1) {
        Object.defineProperty(o, rng.pick(fields), {
          value: gen(depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return o;
    };
    for (let n = 0; n < 400; n += 1) {
      const doc: Record<string, unknown> = {};
      Object.defineProperty(doc, 'kind', {
        value: rng.pick(kinds),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(doc, 'apiVersion', {
        value: rng.pick(['v1', 'apps/v1', 'gateway.networking.k8s.io/v1']),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      for (const f of ['metadata', 'spec', 'items']) {
        if (rng.next() < 0.8)
          Object.defineProperty(doc, f, {
            value: gen(1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      const text = JSON.stringify(doc);
      const result = readKubernetes(intakeStreamBytes(Buffer.from(text)));
      for (const w of result.workloads) {
        expect(K8S_WORKLOAD_KINDS as readonly string[]).toContain(w.kind);
        expect(isInputText(w.name)).toBe(true);
        for (const c of w.containers) {
          expect(isInputText(c.name)).toBe(true);
          for (const e of c.env)
            expect(isSourcedValue(e.value) || isUnresolved(e.value)).toBe(true);
        }
      }
      for (const i of result.ingresses) expect(isInputText(i.name)).toBe(true);
      for (const u of result.unresolved) expect(u.label.length).toBeGreaterThan(0);
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

function readFixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8');
}
