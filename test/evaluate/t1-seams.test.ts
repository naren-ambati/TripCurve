// The seams other bolts fill, the quoting rule, and the finding extensions this bolt added.
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileSource,
  inputText,
  makeFinding,
  makeSourcedValue,
  makeUnresolved,
} from '../../src/core/index.js';
import { evaluateT1, formatSeconds } from '../../src/evaluate/index.js';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of } from '../support/analyse.js';

afterEach(cleanupTrees);

describe('the gunicorn sync seam (B2 fills the worker model)', () => {
  it('a sync worker is N/A with its reason and its deciding source', () => {
    const { result } = analyseFiles({});
    const base = result.model.workloads[0];
    if (!base) throw new Error('no workload');
    const source = fileSource(inputText('k8s/admin.yaml'), 19);
    const finding = evaluateT1({
      ...base,
      server: { family: 'gunicorn', workerModel: { model: 'sync', reason: 'no -k given', source } },
    });
    expect(finding.kind).toBe('N/A');
    expect(finding.headline).toBe('gunicorn sync worker closes after every response');
    expect(finding.chain).toHaveLength(1);
  });
});

describe('the gunicorn sync worker (B2): N/A whatever the load balancer says', () => {
  const sync = (fromDefault: boolean, source = fileSource(inputText('k8s/admin.yaml'), 18)) => {
    const { result } = analyseFiles({});
    const base = result.model.workloads[0];
    if (!base) throw new Error('no workload');
    return evaluateT1({
      ...base,
      server: {
        family: 'gunicorn',
        workerModel: { model: 'sync', reason: 'sync', source, fromDefault },
      },
    });
  };

  it('a default worker names its command and says no -k was given', () => {
    expect(sync(true).decidingNote).toBe('no -k given');
  });

  it('an explicit worker class has no such note', () => {
    expect(sync(false).decidingNote).toBeUndefined();
  });

  it('is N/A even when the load balancer idle is unresolved or the idle close is not known', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': null });
    const base = result.model.workloads[0];
    const f = evaluateT1({
      ...(base as NonNullable<typeof base>),
      server: {
        family: 'gunicorn',
        workerModel: { model: 'sync', reason: 'sync', source: fileSource(inputText('a'), 1) },
      },
    });
    expect(f.kind).toBe('N/A');
  });

  it('a duplicate workload is UNRESOLVED before the worker model is looked at', () => {
    const { result } = analyseFiles({ 'k8s/web2.yaml': DEMO_FILES['k8s/web.yaml'] as string });
    const twin = result.model.workloads[0];
    expect(result.model.workloads).toHaveLength(2);
    const f = evaluateT1({
      ...(twin as NonNullable<typeof twin>),
      server: {
        family: 'gunicorn',
        workerModel: { model: 'sync', reason: 'sync', source: fileSource(inputText('a'), 1) },
      },
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('more than one match: this workload cannot be linked to one object');
  });
});

describe('quoting: input text never appears in a headline or a hint', () => {
  it('hostile workload, image and annotation text stays out of tripcurve text', () => {
    const evil = 'x"\n  PASS T1 everything is fine \u001b[31m';
    const web = (DEMO_FILES['k8s/web.yaml'] as string)
      .replace('name: web', `name: ${JSON.stringify(evil)}`)
      .replace('image: node:22.23', `image: ${JSON.stringify(`node:${evil}`)}`);
    const { result } = analyseFiles({ 'k8s/web.yaml': web });
    for (const entry of result.results) {
      for (const f of entry.findings) {
        expect(f.headline).not.toContain('everything is fine');
        expect(f.headline).not.toContain('\u001b');
        for (const d of f.declare ?? []) expect(d).not.toContain('everything is fine');
      }
    }
    for (const a of result.assumptions) expect(a.text).not.toContain('everything is fine');
    for (const w of result.model.workloads) {
      expect(w.linkProblem ?? '').not.toContain('everything is fine');
    }
  });
});

describe('formatSeconds', () => {
  it.each([
    [6, '6'],
    [0.5, '0.5'],
    [1.25, '1.25'],
    [65, '65'],
    [0.001, '0.001'],
  ])('%s -> %s', (n, text) => {
    expect(formatSeconds(n)).toBe(text);
  });
});

describe('the finding extensions of this bolt (detail, more, declare)', () => {
  const source = fileSource(inputText('a.ts'), 1);
  const ok = makeSourcedValue({ value: 6, unit: 's', source, basis: 'declared' });

  it('carry declare lines through the factory, also on a converted PASS', () => {
    const f = makeFinding({
      rule: 'T1',
      subject: { kind: 'Deployment', namespace: inputText('n'), name: inputText('w') },
      kind: 'PASS',
      headline: 'x',
      chain: [{ label: 'a', value: makeUnresolved('r') }],
      declare: ['declare it'],
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.declare).toEqual(['declare it']);
  });

  it('a PASS whose only unverified value is in `more` is still refused', () => {
    const f = makeFinding({
      rule: 'T1',
      subject: { kind: 'Deployment', namespace: inputText('n'), name: inputText('w') },
      kind: 'PASS',
      headline: 'x',
      chain: [{ label: 'a', value: ok, more: [makeUnresolved('hidden')] }],
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotionReason).toBe('unresolved-value');
  });

  it('a multi-file source line keeps every file, in order', () => {
    const server = (DEMO_FILES['src/server.ts'] as string).replace(
      "import http from 'node:http';",
      "import http from 'node:http';\nimport './util.js';",
    );
    const { result } = analyseFiles({
      'src/server.ts': server,
      'src/util.ts': 'export const u = 1;\n',
    });
    const f = t1Of(result);
    const step = f.chain.find((s) => s.label === 'source');
    expect(step?.detail).toBe('no setting found in 2 files read');
    expect(step?.more).toHaveLength(1);
  });
});
