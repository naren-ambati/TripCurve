// Review finding m3: an ALB idle timeout outside the documented range 1 to 4000
// seconds (docs.aws.amazon.com .../application/edit-load-balancer-attributes.html,
// read 2026-11-11: "The valid range is 1 to 4000 seconds.") was accepted, so
// `idle_timeout.timeout_seconds=0` gave a PASS. Such a value is UNRESOLVED.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const REASON = 'outside the documented range 1 to 4000 s';

function annotated(seconds: number): Record<string, string> {
  return {
    'k8s/ingress.yaml': withEnv(
      DEMO_FILES['k8s/ingress.yaml'] as string,
      'idle_timeout.timeout_seconds=60',
      `idle_timeout.timeout_seconds=${seconds}`,
    ),
  };
}

function declared(seconds: number): Record<string, string> {
  return {
    'k8s/ingress.yaml': withEnv(
      DEMO_FILES['k8s/ingress.yaml'] as string,
      '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n',
      '',
    ),
    'tripcurve.yaml': [
      'version: 1',
      'workloads:',
      '  - name: web',
      '    load_balancer:',
      '      ingress: web',
      `      idle_timeout_s: ${seconds}`,
      '',
    ].join('\n'),
  };
}

describe('an ALB idle timeout outside 1 to 4000 s is unresolved (m3)', () => {
  it.each([0, 4001, 100000])('annotation %i s: UNRESOLVED, never a PASS', (n) => {
    const t1 = t1Of(analyseFiles(annotated(n)).result);
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toBe(`LB idle not established: ${REASON}`);
  });

  it.each([0, 4001])('declared %i s in tripcurve.yaml: UNRESOLVED, never a PASS', (n) => {
    const t1 = t1Of(analyseFiles(declared(n)).result);
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toBe(`LB idle not established: ${REASON}`);
  });

  it('the range ends are accepted: 1 s gives a PASS against the 6 s idle close, 4000 s a FAIL', () => {
    expect(t1Of(analyseFiles(annotated(1)).result).kind).toBe('PASS');
    expect(t1Of(analyseFiles(annotated(4000)).result).kind).toBe('FAIL');
    expect(t1Of(analyseFiles(declared(1)).result).kind).toBe('PASS');
    expect(t1Of(analyseFiles(declared(4000)).result).kind).toBe('FAIL');
  });

  it('an annotation and a declaration that both sit outside the range stay UNRESOLVED', () => {
    const files = { ...annotated(0), 'tripcurve.yaml': declared(0)['tripcurve.yaml'] as string };
    expect(t1Of(analyseFiles(files).result).kind).toBe('UNRESOLVED');
  });
});
