// Review findings M5 and m5.
//
// Ingresses that share `alb.ingress.kubernetes.io/group.name` share ONE ALB.
// `load-balancer-attributes` has Exclusive merge semantics: conflicting values across
// the group make the controller fail for the whole group, and members of the group can
// exist outside the checked files. Source:
// https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/
// (read 2026-11-11). So one Ingress's annotation is not the idle timeout of the ALB.
//
// m5: an Ingress backend port that is not a port of the Service still led to a result.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');
const GROUP = '    alb.ingress.kubernetes.io/group.name: shared\n';
const SHARED = 'shared ALB (IngressGroup); members outside these files may set the idle timeout';

function inGroup(text: string): string {
  return withEnv(
    text,
    '    alb.ingress.kubernetes.io/scheme: internet-facing\n',
    `    alb.ingress.kubernetes.io/scheme: internet-facing\n${GROUP}`,
  );
}

const declareIdle = (seconds: number) =>
  [
    'version: 1',
    'workloads:',
    '  - name: web',
    '    namespace: shop',
    '    load_balancer:',
    '      ingress: web',
    `      idle_timeout_s: ${seconds}`,
    '',
  ].join('\n');

describe('an Ingress in an IngressGroup', () => {
  it('control: the same Ingress without group.name passes with LB idle 5 s', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5 });
    expect(t1Of(result).kind).toBe('PASS');
  });

  it('a group.name makes LB idle unresolved with the fixed reason (was a wrong PASS)', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': inGroup(ING5) });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`LB idle not established: ${SHARED}`);
    // no assumed 60 s is listed for a shared ALB
    expect(result.assumptions.some((a) => a.text.includes('idle timeout is assumed'))).toBe(false);
  });

  it('also when the annotation is absent (no assumed 60 s for a shared ALB)', () => {
    const noAttr = withEnv(
      inGroup(ingressYaml),
      '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n',
      '',
    );
    const { result } = analyseFiles({ 'k8s/ingress.yaml': noAttr });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`LB idle not established: ${SHARED}`);
    // no assumed 60 s is listed for a shared ALB
    expect(result.assumptions.some((a) => a.text.includes('idle timeout is assumed'))).toBe(false);
  });

  it('a declaration that states the idle value, equal to the annotation, stands', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': inGroup(ING5),
      'tripcurve.yaml': declareIdle(5),
    });
    const f = t1Of(result);
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 6 s is longer than LB idle 5 s');
  });

  it('a declaration alone (no annotation) stands for the group', () => {
    const noAttr = withEnv(
      inGroup(ingressYaml),
      '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n',
      '',
    );
    const { result } = analyseFiles({
      'k8s/ingress.yaml': noAttr,
      'tripcurve.yaml': declareIdle(5),
    });
    expect(t1Of(result).kind).toBe('PASS');
  });

  it('a declaration that differs from the annotation is UNRESOLVED', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': inGroup(ING5),
      'tripcurve.yaml': declareIdle(120),
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('the annotation and the declaration give different idle timeouts');
  });

  it("the reviewer's repro: another member of the group in the files sets 60 s", () => {
    const other = ingressYaml
      .replace('name: web', 'name: other')
      .replace('name: web\n                port', 'name: elsewhere\n                port')
      .replace(
        'alb.ingress.kubernetes.io/scheme: internet-facing\n',
        `alb.ingress.kubernetes.io/scheme: internet-facing\n${GROUP}`,
      );
    const { result } = analyseFiles({
      'k8s/ingress.yaml': inGroup(ING5),
      'k8s/ingress2.yaml': other,
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`LB idle not established: ${SHARED}`);
  });
});

describe('two Ingresses with the same load-balancer-name share one ALB', () => {
  const named = (text: string, lb: string) =>
    withEnv(
      text,
      '    alb.ingress.kubernetes.io/scheme: internet-facing\n',
      `    alb.ingress.kubernetes.io/scheme: internet-facing\n    alb.ingress.kubernetes.io/load-balancer-name: ${lb}\n`,
    );
  const second = (lb: string) =>
    named(
      ingressYaml
        .replace('name: web\n  namespace', 'name: other\n  namespace')
        .replace('number: 80', 'number: 80')
        .replace('name: web\n                port', 'name: elsewhere\n                port'),
      lb,
    );

  it('a repeated load-balancer-name is the shared-ALB case', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': named(ING5, 'shop-alb'),
      'k8s/ingress2.yaml': second('shop-alb'),
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`LB idle not established: ${SHARED}`);
  });

  it('different names are two ALBs: the idle annotation stands', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': named(ING5, 'shop-alb'),
      'k8s/ingress2.yaml': second('other-alb'),
    });
    expect(t1Of(result).kind).toBe('PASS');
  });

  it('a declaration that states the idle value stands for a shared name too', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': named(ING5, 'shop-alb'),
      'k8s/ingress2.yaml': second('shop-alb'),
      'tripcurve.yaml': declareIdle(5),
    });
    expect(t1Of(result).kind).toBe('PASS');
  });
});

describe('m5: an Ingress backend port that is not a port of the Service', () => {
  it('port 81 against a Service that exposes only 80 is UNRESOLVED (was PASS)', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': withEnv(ING5, 'number: 80', 'number: 81'),
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('the Ingress backend port is not a port of the Service');
  });

  it('a backend port name the Service does not have is the same', () => {
    const named = withEnv(ING5, '                  number: 80\n', '                  name: nope\n');
    const { result } = analyseFiles({ 'k8s/ingress.yaml': named });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('the Ingress backend port is not a port of the Service');
  });

  it('one valid path and one path to port 81 of the same Service: UNRESOLVED (was PASS)', () => {
    const two = withEnv(
      ING5,
      '    - http:\n        paths:\n',
      '    - http:\n        paths:\n          - path: /bad\n            pathType: Prefix\n            backend:\n              service:\n                name: web\n                port:\n                  number: 81\n',
    );
    const { result } = analyseFiles({ 'k8s/ingress.yaml': two });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('the Ingress backend port is not a port of the Service');
  });

  it('control: port 80 is a port of the Service', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5 });
    expect(t1Of(result).kind).toBe('PASS');
  });
});
