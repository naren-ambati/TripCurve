// Review finding M6: an Ingress that names another controller's class but
// carries alb.ingress.kubernetes.io/* annotations was read as an ALB and could
// PASS. It is not an ALB; the workloads behind it get an UNRESOLVED T1 with a
// fixed reason so the conflict is visible and the run is not clean.
import { afterEach, describe, expect, it } from 'vitest';
import { intake } from '../../src/parse/index.js';
import { readKubernetes } from '../../src/parse/k8s/index.js';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';
import { txt } from '../support/render.js';
import { makeTree } from '../support/tmp-tree.js';

afterEach(cleanupTrees);

const REASON = 'Ingress class names another controller but carries ALB annotations';
const DEMO_INGRESS = DEMO_FILES['k8s/ingress.yaml'] as string;

function withClass(spec: string): string {
  return withEnv(DEMO_INGRESS, '  ingressClassName: alb\n', spec);
}

function readIngresses(files: Record<string, string>) {
  const t = makeTree();
  try {
    for (const [p, text] of Object.entries(files)) t.write(p, text);
    return readKubernetes(intake({ root: t.root }));
  } finally {
    t.cleanup();
  }
}

describe('reader: a class that is not ALB wins over ALB annotations', () => {
  it('ingressClassName nginx plus ALB annotations is not an ALB Ingress', () => {
    const out = readIngresses({ 'i.yaml': withClass('  ingressClassName: nginx\n') });
    expect(out.ingresses).toEqual([]);
    expect(out.uncheckedKinds.map((u) => u.reasonCode)).toEqual(['not-alb-ingress']);
    expect(out.classConflictIngresses.map((i) => txt(i.name))).toEqual(['web']);
  });

  it('the legacy annotation naming another class does the same', () => {
    const text = withClass('').replace(
      '  annotations:\n',
      '  annotations:\n    kubernetes.io/ingress.class: nginx\n',
    );
    const out = readIngresses({ 'i.yaml': text });
    expect(out.ingresses).toEqual([]);
    expect(out.classConflictIngresses).toHaveLength(1);
  });

  it('a class that an IngressClass in the files ties to the ALB controller is still an ALB', () => {
    const out = readIngresses({
      'i.yaml': withClass('  ingressClassName: custom\n'),
      'c.yaml':
        'apiVersion: networking.k8s.io/v1\nkind: IngressClass\nmetadata: {name: custom}\nspec: {controller: ingress.k8s.aws/alb}\n',
    });
    expect(out.ingresses.map((i) => i.recognisedBy)).toEqual(['ingress-class-object']);
    expect(out.classConflictIngresses).toEqual([]);
  });

  it('with NO class named, ALB annotations still recognise an ALB Ingress', () => {
    const out = readIngresses({ 'i.yaml': withClass('') });
    expect(out.ingresses.map((i) => i.recognisedBy)).toEqual(['alb-annotation']);
    expect(out.classConflictIngresses).toEqual([]);
  });

  it('another class with no ALB annotation stays an unchecked Ingress, with no conflict', () => {
    const plain = [
      'apiVersion: networking.k8s.io/v1',
      'kind: Ingress',
      'metadata: {name: web, namespace: shop}',
      'spec:',
      '  ingressClassName: nginx',
      '',
    ].join('\n');
    const out = readIngresses({ 'i.yaml': plain });
    expect(out.ingresses).toEqual([]);
    expect(out.classConflictIngresses).toEqual([]);
    expect(out.uncheckedKinds.map((u) => u.reasonCode)).toEqual(['not-alb-ingress']);
  });
});

describe('pipeline: the workload behind it is UNRESOLVED, never PASS', () => {
  it('demo with the class changed to nginx: T1 is UNRESOLVED with the fixed reason', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': withClass('  ingressClassName: nginx\n'),
    });
    const t1 = t1Of(result);
    expect(t1.kind).toBe('UNRESOLVED');
    expect(JSON.stringify(t1)).toContain(REASON);
    // the Ingress itself is still listed as not checked
    expect(result.notChecked.map((n) => `${n.subjectKind}|${n.reasonCode}`)).toContain(
      'ingress|not-alb-ingress',
    );
  });

  it('a safe idle value cannot turn it into a PASS', () => {
    const text = withClass('  ingressClassName: nginx\n').replace(
      'idle_timeout.timeout_seconds=60',
      'idle_timeout.timeout_seconds=1',
    );
    const { result } = analyseFiles({ 'k8s/ingress.yaml': text });
    expect(t1Of(result).kind).toBe('UNRESOLVED');
  });

  it('unchanged demo is still the web T1 FAIL', () => {
    expect(t1Of(analyseFiles({}).result).kind).toBe('FAIL');
  });
});
