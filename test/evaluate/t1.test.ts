// T1 end to end: files -> read -> link -> resolve -> evaluate (bolt B1). The
// expectations are written out in full: every chain line the report prints.
import { symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/index.js';
import { loadKnowledgeBase } from '../../src/kb/index.js';
import { DECLARE_NODE_VERSION } from '../../src/resolve/index.js';
import {
  analyseFiles,
  cleanupTrees,
  DEMO_FILES,
  renderChain,
  t1Of,
  withEnv,
} from '../support/analyse.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const outsideTrees: Tree[] = [];
afterEach(() => {
  cleanupTrees();
  for (const t of outsideTrees.splice(0)) t.cleanup();
});

const IDLE_CLOSE_22 =
  'idle close: 6 s @ default: Node keepAliveTimeout 5 s + 1 s (Node 22.x from 22.12; measured on 5 releases from 22.12.0 to 22.23.5)';
const LB_60 = 'LB idle: 60 s @ "k8s/ingress.yaml":9';

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const serverTs = DEMO_FILES['src/server.ts'] as string;

describe('the demo web workload (Node default behind an ALB Ingress)', () => {
  it('is a T1 FAIL with the exact chain the report prints', () => {
    const { result } = analyseFiles({});
    expect(result.configErrors).toEqual([]);
    expect(result.results).toHaveLength(1);
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(finding.headline).toBe('idle close 6 s is not longer than LB idle 60 s');
    expect(renderChain(finding)).toEqual([
      IDLE_CLOSE_22,
      'Node 22.23 image: "node:22.23" @ "k8s/web.yaml":17',
      'source no setting found in 1 file read: "src/server.ts"',
      LB_60,
    ]);
    expect(finding.demotedFrom).toBeUndefined();
    expect(result.notChecked).toEqual([]);
    // The command's relative file was found by assuming a working directory.
    expect(result.assumptions.map((a) => a.text)).toEqual([
      'The container\'s working directory is taken to be ".".',
    ]);
  });

  it('keeps the subject as the fixed kind word with the names as input text', () => {
    const { result } = analyseFiles({});
    const subject = t1Of(result).subject;
    expect('kind' in subject && subject.kind).toBe('Deployment');
  });

  it('is T1 PASS only when every value is established: LB idle declared as 5 s', () => {
    const noAnnotation = withEnv(
      ingressYaml,
      '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n',
      '',
    );
    const { result } = analyseFiles({
      'k8s/ingress.yaml': noAnnotation,
      'tripcurve.yaml': [
        'version: 1',
        'workloads:',
        '  - name: web',
        '    namespace: shop',
        '    load_balancer:',
        '      ingress: web',
        '      idle_timeout_s: 5',
        '',
      ].join('\n'),
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('PASS');
    expect(finding.headline).toBe('idle close 6 s is longer than LB idle 5 s');
    expect(renderChain(finding).at(-1)).toBe('LB idle: 5 s @ "tripcurve.yaml":7');
  });
});

describe('a declared idle timeout and the annotation', () => {
  const yaml = (seconds: number) =>
    [
      'version: 1',
      'workloads:',
      '  - name: web',
      '    load_balancer:',
      '      ingress: web',
      `      idle_timeout_s: ${seconds}`,
      '',
    ].join('\n');

  it('are the same value: the value stands', () => {
    const { result } = analyseFiles({ 'tripcurve.yaml': yaml(60) });
    expect(t1Of(result).kind).toBe('FAIL');
  });

  it('differ: UNRESOLVED with both values shown', () => {
    const { result } = analyseFiles({ 'tripcurve.yaml': yaml(120) });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'LB idle not established: the annotation and the declaration give different idle timeouts',
    );
    const lines = renderChain(finding);
    expect(lines).toContain('LB idle annotation: 60 s @ "k8s/ingress.yaml":9');
    expect(lines).toContain('LB idle declared: 120 s @ "tripcurve.yaml":6');
  });

  it('name an Ingress that is not behind the workload: never applied, UNRESOLVED', () => {
    const wrong = yaml(120).replace('ingress: web', 'ingress: other');
    const { result } = analyseFiles({ 'tripcurve.yaml': wrong });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toContain('not one that reaches it');
  });
});

describe('no idle annotation: the documented default is only an assumption', () => {
  const noAnnotation = withEnv(
    ingressYaml,
    '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n',
    '',
  );

  it('is UNRESOLVED, prints the assumed value and what it would mean, and lists the assumption', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': noAnnotation });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'LB idle is not set in the files; assumed 60 s, so idle close 6 s is not longer (T1 would FAIL)',
    );
    expect(renderChain(finding).at(-1)).toBe(
      'LB idle assumed, not set in the files: 60 s @ default: ALB idle timeout (AWS docs, ALB; documented)',
    );
    expect(finding.declare?.[0]).toContain('idle_timeout.timeout_seconds');
    expect(result.assumptions).toHaveLength(2);
    expect(result.assumptions[0]?.text).toContain('assumed to be the documented default of 60 s');
    expect(result.assumptions[1]?.text).toContain('working directory is taken to be');
  });

  it('never gives PASS even when the assumed value would pass', () => {
    // An idle close of 6 s against an assumed 5 s would pass: it must still not print PASS.
    const kb = loadKnowledgeBase([
      {
        schemaVersion: 1,
        entries: [
          {
            id: 'alb-idle-timeout-default',
            subject: 'alb-idle-timeout',
            value: 2,
            unit: 's',
            applies: { runtime: 'alb', versionRange: '*' },
            citationName: 'ALB idle timeout',
            rangeLabel: 'test',
            docUrl: 'https://example.test/alb',
            docDate: '2026-11-11',
            basis: 'documented',
            scriptRef: { notMeasurableLocally: 'test' },
          },
          ...nodeEntries(),
        ],
      },
    ]);
    const { result } = analyseFiles({ 'k8s/ingress.yaml': noAnnotation }, { kb });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toContain('T1 would pass');
  });
});

function nodeEntries(): unknown[] {
  return [
    {
      id: 'node-idle-close-22x',
      subject: 'node-idle-close',
      value: 6,
      unit: 's',
      applies: { runtime: 'node', versionRange: '>=22.19.0 <23.0.0' },
      citationName: 'Node test',
      rangeLabel: 'Node 22.x from 22.19',
      docUrl: 'https://example.test/node',
      docDate: '2026-11-11',
      basis: 'measured',
      measuredOn: { version: '22.23.2', date: '2026-11-11', platform: 'test' },
      scriptRef: 'measure/node-idle-close.mjs',
      toleranceMs: 4,
    },
  ];
}

// The explicit keepAliveTimeout rule (measured in bolt B3) is tested in node-explicit.test.ts.

describe('the Node version', () => {
  const image = (tag: string) => withEnv(webYaml, 'image: node:22.23', `image: ${tag}`);

  it('node:22 is 22.x: VERSION-DEPENDENT, with the stretch before the first measured version unresolved', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:22') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    expect(finding.headline).toBe('Node version spans several knowledge-base ranges');
    expect(finding.branches?.map((b) => [b.range, b.outcome])).toEqual([
      ['22 to before 22.12', 'UNRESOLVED'],
      ['Node 22.x from 22.12', 'FAIL'],
    ]);
    expect(finding.declare?.[0]).toContain('exact Node version tag');
  });

  it('node:20.11 has no knowledge-base entry: UNRESOLVED, never a borrowed value', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:20.11') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'idle close not established: no knowledge-base entry covers Node 20.11',
    );
  });

  it('node:22.11 (before the first measured 22.x) has no entry: UNRESOLVED', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:22.11') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'idle close not established: no knowledge-base entry covers Node 22.11',
    );
  });

  it('node:22.18 (no buffer property yet) is covered: 6 s was measured on 22.12.0 and 22.18.0', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:22.18') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(renderChain(finding)[0]).toContain(
      'Node 22.x from 22.12; measured on 5 releases from 22.12.0',
    );
  });

  it('node:24.22.3 and node:26.13.1 use their measured entries', () => {
    for (const [tag, range] of [
      ['node:24.22.3', 'Node 24.x from 24.0; measured on 4 releases from 24.0.0 to 24.22.3'],
      ['node:26.13.1', 'Node 26.x from 26.0; measured on 2 releases from 26.0.0 to 26.13.1'],
      ['node:20.20.2', 'Node 20.x from 20.20.2; measured on 20.20.2'],
    ] as const) {
      const { result } = analyseFiles({ 'k8s/web.yaml': image(tag) });
      const finding = t1Of(result);
      expect(finding.kind).toBe('FAIL');
      expect(renderChain(finding)[0]).toContain(range);
    }
  });

  it('node:18.20.8 closes at exactly 5 s: a FAIL against 60 s', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:18.20.8') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(finding.headline).toBe('idle close 5 s is not longer than LB idle 60 s');
  });

  it('node:24.0 is the first measured 24.x release; node:23.1 has no entry', () => {
    expect(t1Of(analyseFiles({ 'k8s/web.yaml': image('node:24.0') }).result).kind).toBe('FAIL');
    const finding = t1Of(analyseFiles({ 'k8s/web.yaml': image('node:23.1') }).result);
    expect(finding.kind).toBe('UNRESOLVED');
  });

  it('a declared runtime.node of 22 covers 22.0 to 22.11 that no entry covers: VERSION-DEPENDENT, not the partial match', () => {
    const { result } = analyseFiles({
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "22"\n',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    expect(finding.branches?.map((b) => b.outcome)).toEqual(['UNRESOLVED', 'FAIL']);
  });

  it('a declared runtime.node wins over the image tag', () => {
    const { result } = analyseFiles({
      'tripcurve.yaml':
        'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "20.11.0"\n',
    });
    const finding = t1Of(result);
    expect(finding.headline).toBe(
      'idle close not established: no knowledge-base entry covers Node 20.11.0',
    );
  });

  it('engines only narrows: an engines range that excludes the image version is UNRESOLVED', () => {
    const { result } = analyseFiles({
      'package.json': '{"engines":{"node":">=24.0.0 <25.0.0"}}',
    });
    // the package.json is not near the manifest's source link? it is the nearest to src/server.ts
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toContain('engines excludes');
  });

  it('engines that contain the version change nothing', () => {
    const { result } = analyseFiles({ 'package.json': '{"engines":{"node":">=22.0.0 <23.0.0"}}' });
    expect(t1Of(result).kind).toBe('FAIL');
  });

  it('a linked Dockerfile gives the version when the manifest image is not the node image', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': image('registry.test/web:1'),
      'docker/Dockerfile': 'FROM node:22.23.2\nCOPY . .\n',
      'tripcurve.yaml':
        'version: 1\nworkloads:\n  - name: web\n    dockerfile: docker/Dockerfile\n',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(renderChain(finding)[1]).toBe(
      'Node 22.23.2 Dockerfile FROM: "node:22.23.2" @ "docker/Dockerfile":1',
    );
  });

  it('an unlinked Dockerfile is never used', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': image('registry.test/web:1'),
      'docker/Dockerfile': 'FROM node:22.23.2\n',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'idle close not established: no Node version is established for this workload',
    );
  });
});

describe('source that is not linked, or not completely read', () => {
  it('an unlinked source is UNRESOLVED, never the default', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, '          command: ["node", "src/server.ts"]\n', ''),
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe(
      'idle close not established: source not linked: the container has no literal command',
    );
    expect(finding.declare?.[0]).toContain('link the entry file as source');
    expect(result.model.workloads[0]?.linkState).toBe('unresolved-source-not-linked');
  });

  it('a source search that did not find the server construction is UNRESOLVED', () => {
    const { result } = analyseFiles({
      'src/server.ts': "import { start } from './boot.js';\nstart();\n",
      'src/boot.ts': 'export function start(): void {}\n',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toContain('no server construction');
  });

  it('a local import that names no file read leaves the search incomplete', () => {
    const { result } = analyseFiles({
      'src/server.ts': `${serverTs}\nimport './missing.js';\n`,
    });
    expect(t1Of(result).kind).toBe('UNRESOLVED');
  });

  it('a source file that is a syntax error is unread: UNRESOLVED', () => {
    const { result } = analyseFiles({ 'src/server.ts': 'const = ;;; {{{' });
    expect(t1Of(result).kind).toBe('UNRESOLVED');
  });

  it('a declared source in tripcurve.yaml is used', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, '          command: ["node", "src/server.ts"]\n', ''),
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    source: src/server.ts\n',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(renderChain(finding)[2]).toBe('source no setting found in 1 file read: "src/server.ts"');
  });

  it('a declared source outside the root is refused and does not fall back to the command', () => {
    const outside = makeTree();
    outsideTrees.push(outside);
    const target = outside.write('server.ts', serverTs);
    for (const declared of [target, `../${basename(outside.root)}/server.ts`]) {
      const { result } = analyseFiles({
        'tripcurve.yaml': `version: 1\nworkloads:\n  - name: web\n    source: ${declared}\n`,
      });
      const finding = t1Of(result);
      expect(finding.kind).toBe('UNRESOLVED');
      expect(finding.headline).toBe(
        'idle close not established: source not linked: the linked path lies outside the checked root',
      );
    }
  });

  it('a symlink inside the root that points outside is refused', () => {
    const outside = makeTree();
    outsideTrees.push(outside);
    const target = outside.write('server.ts', serverTs);
    const { result } = analyseFiles(
      {
        'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    source: link.ts\n',
      },
      {
        before: (tree) => symlinkSync(target, join(tree.root, 'link.ts')),
      },
    );
    expect(t1Of(result).headline).toContain('outside the checked root');
  });

  it('a command that names an absolute path inside the container links nothing', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, '"src/server.ts"', '"/app/src/server.ts"'),
    });
    expect(t1Of(result).headline).toContain('a path inside the container');
  });

  it('an npm script resolved to a literal node file links the source (and records the assumption)', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, '["node", "src/server.ts"]', '["npm", "start"]'),
      'package.json': '{"scripts":{"start":"node src/server.ts"}}',
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('FAIL');
    expect(result.assumptions.some((a) => a.text.includes('npm script'))).toBe(true);
  });

  it('an npm script that is not a plain node command leaves the source unlinked', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, '["node", "src/server.ts"]', '["npm", "run", "serve"]'),
      'package.json': '{"scripts":{"serve":"NODE_ENV=production node src/server.ts && echo x"}}',
    });
    expect(t1Of(result).headline).toContain('not a plain node command');
  });
});

describe('load balancers', () => {
  it('a Service behind an NLB is UNRESOLVED with the NLB reason', () => {
    const { result } = analyseFiles({
      'k8s/stream.yaml': [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: stream',
        'spec:',
        '  selector:',
        '    matchLabels:',
        '      app: stream',
        '  template:',
        '    metadata:',
        '      labels:',
        '        app: stream',
        '    spec:',
        '      containers:',
        '        - name: app',
        '          image: node:22.23',
        '          command: ["node", "src/server.ts"]',
        '          ports:',
        '            - containerPort: 9000',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: stream',
        '  annotations:',
        '    service.beta.kubernetes.io/aws-load-balancer-type: external',
        'spec:',
        '  type: LoadBalancer',
        '  selector:',
        '    app: stream',
        '  ports:',
        '    - port: 443',
        '      targetPort: 9000',
        '',
      ].join('\n'),
      'k8s/ingress.yaml': null,
      'k8s/service.yaml': null,
      'k8s/web.yaml': null,
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe('no measured evidence for NLBs');
  });

  it('an Ingress that is not an ALB Ingress is not checked, and so is the workload behind it', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': ingressYaml
        .replace('ingressClassName: alb', 'ingressClassName: nginx')
        .replace(/ {4}alb\.ingress\.[^\n]*\n/g, ''),
    });
    expect(result.results).toEqual([]);
    expect(result.notChecked.map((n) => [n.subjectKind, n.reasonCode, n.kind])).toEqual([
      ['workload', 'no-recognised-lb', 'Deployment'],
      ['ingress', 'not-alb-ingress', 'Ingress'],
    ]);
  });

  it('a workload with no Service at all is not checked', () => {
    const { result } = analyseFiles({ 'k8s/service.yaml': null, 'k8s/ingress.yaml': null });
    expect(result.results).toEqual([]);
    expect(result.notChecked.map((n) => n.reasonCode)).toEqual(['no-recognised-lb']);
  });

  it('a Service selecting two workloads gives each its own finding', () => {
    const second = webYaml
      .replaceAll('name: web\n  namespace: shop', 'name: web2\n  namespace: shop')
      .replace('node:22.23', 'node:24.22.3');
    const { result } = analyseFiles({ 'k8s/web2.yaml': second });
    expect(result.results).toHaveLength(2);
    const kinds = result.results.map((r) => r.findings[0]?.kind);
    expect(kinds).toEqual(['FAIL', 'FAIL']);
    const lines = result.results.map((r) => renderChain(r.findings[0] as Finding)[0] ?? '');
    expect(lines.some((l) => l.includes('Node 22.x'))).toBe(true);
    expect(lines.some((l) => l.includes('Node 24.x'))).toBe(true);
  });

  it('a workload reached by two Ingresses is UNRESOLVED (no one idle timeout applies)', () => {
    const { result } = analyseFiles({
      'k8s/ingress2.yaml': withEnv(ingressYaml, 'name: web', 'name: web-second'),
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toContain('more than one load balancer');
  });
});

describe('duplicates and ambiguous containers', () => {
  it('two Deployments with the same kind, namespace and name are both UNRESOLVED: more than one match', () => {
    const { result } = analyseFiles({ 'k8s/web-copy.yaml': webYaml });
    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      const f = entry.findings[0];
      expect(f?.kind).toBe('UNRESOLVED');
      expect(f?.headline).toBe('more than one match: this workload cannot be linked to one object');
    }
    expect(result.model.workloads.map((w) => w.linkState)).toEqual([
      'unresolved-more-than-one-match',
      'unresolved-more-than-one-match',
    ]);
  });

  it('two Services of the same name make the link ambiguous', () => {
    const { result } = analyseFiles({
      'k8s/service-copy.yaml': DEMO_FILES['k8s/service.yaml'] as string,
    });
    expect(t1Of(result).kind).toBe('UNRESOLVED');
    expect(result.model.workloads[0]?.linkState).toBe('unresolved-more-than-one-match');
  });

  it('a container that declares no port the Service targets is not determined', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, 'containerPort: 8080', 'containerPort: 9999'),
    });
    expect(result.model.workloads[0]?.linkState).toBe('unresolved-container-not-determined');
    expect(result.model.workloads[0]?.linkProblem).toBe(
      'unresolved: no container declares the port the Service targets',
    );
    expect(t1Of(result).kind).toBe('UNRESOLVED');
  });

  it('two containers that both declare the targeted port are not determined', () => {
    const twin = `${webYaml}        - name: sidecar\n          image: node:22.23\n          ports:\n            - containerPort: 8080\n`;
    const { result } = analyseFiles({ 'k8s/web.yaml': twin });
    expect(result.model.workloads[0]?.linkProblem).toBe(
      'unresolved: more than one container declares the port the Service targets',
    );
  });
});

describe('configuration errors stop the run before any rule', () => {
  it('a declaration naming no workload', () => {
    const { result } = analyseFiles({
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: ghost\n    longest_request_s: 5\n',
    });
    expect(result.configErrors.map((e) => e.reasonCode)).toEqual(['declaration-names-no-workload']);
    expect(result.results).toEqual([]);
    expect(result.model.workloads).toEqual([]);
  });

  it('a declaration naming two workloads', () => {
    const other = webYaml.replace('namespace: shop', 'namespace: other');
    const { result } = analyseFiles({
      'k8s/web-other.yaml': other,
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    longest_request_s: 5\n',
    });
    expect(result.configErrors.map((e) => e.reasonCode)).toEqual([
      'declaration-names-several-workloads',
    ]);
    expect(result.results).toEqual([]);
  });

  it('a namespace on the declaration makes it name one workload', () => {
    const other = webYaml.replace('namespace: shop', 'namespace: other');
    const { result } = analyseFiles({
      'k8s/web-other.yaml': other,
      'tripcurve.yaml':
        'version: 1\nworkloads:\n  - name: web\n    namespace: shop\n    longest_request_s: 5\n',
    });
    expect(result.configErrors).toEqual([]);
  });
});

describe('VERSION-DEPENDENT: more than one remaining range (RuleEngine combines candidates)', () => {
  const two = (secondValue: number, secondBasis: 'measured' | 'to-be-measured' = 'measured') =>
    loadKnowledgeBase([
      {
        schemaVersion: 1,
        entries: [
          ...albEntry(),
          {
            id: 'node-idle-close-22-early',
            subject: 'node-idle-close',
            value: 5,
            unit: 's',
            applies: { runtime: 'node', versionRange: '>=22.0.0 <22.19.0' },
            citationName: 'Node keepAliveTimeout 5 s',
            rangeLabel: 'Node 22.x before 22.19',
            docUrl: 'https://example.test/node',
            docDate: '2026-11-11',
            basis: 'from-changelogs',
            scriptRef: 'measure/x.mjs',
            toleranceMs: 4,
          },
          {
            id: 'node-idle-close-22-late',
            subject: 'node-idle-close',
            value: secondValue,
            unit: 's',
            applies: { runtime: 'node', versionRange: '>=22.19.0 <23.0.0' },
            citationName: 'Node test',
            rangeLabel: 'Node 22.x from 22.19',
            docUrl: 'https://example.test/node',
            docDate: '2026-11-11',
            basis: secondBasis,
            ...(secondBasis === 'measured'
              ? { measuredOn: { version: '22.23.2', date: '2026-11-11', platform: 'test' } }
              : {}),
            scriptRef: 'measure/x.mjs',
            toleranceMs: 4,
          },
        ],
      },
    ]);
  const declare22 = {
    'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "22"\n',
  };

  it('is VERSION-DEPENDENT with one branch per range, even when all ranges agree', () => {
    const { result } = analyseFiles(declare22, { kb: two(6) });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    expect(finding.branches?.map((b) => [b.range, b.outcome])).toEqual([
      ['Node 22.x before 22.19', 'FAIL'],
      ['Node 22.x from 22.19', 'FAIL'],
    ]);
  });

  it('shows the branches that differ', () => {
    const { result } = analyseFiles(declare22, { kb: two(90) });
    const finding = t1Of(result);
    expect(finding.branches?.map((b) => b.outcome)).toEqual(['FAIL', 'PASS']);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
  });

  it('a branch whose idle close EQUALS the LB idle is FAIL, not PASS (strictly longer)', () => {
    // The demo LB idle is 60 s; the second range's idle close is exactly 60 s.
    const { result } = analyseFiles(declare22, { kb: two(60) });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    expect(finding.branches?.map((b) => [b.range, b.outcome])).toEqual([
      ['Node 22.x before 22.19', 'FAIL'],
      ['Node 22.x from 22.19', 'FAIL'],
    ]);
  });

  it('a branch whose idle close is one second above the LB idle is PASS (the boundary from above)', () => {
    const { result } = analyseFiles(declare22, { kb: two(61) });
    expect(t1Of(result).branches?.map((b) => b.outcome)).toEqual(['FAIL', 'PASS']);
  });

  it('lists a to-be-measured range as unresolved: to be measured', () => {
    const { result } = analyseFiles(declare22, { kb: two(90, 'to-be-measured') });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    expect(finding.branches?.map((b) => b.outcome)).toEqual(['FAIL', 'unresolved: to be measured']);
  });

  it('one range whose entry is to be measured is UNRESOLVED, never PASS', () => {
    const kb = loadKnowledgeBase([
      {
        schemaVersion: 1,
        entries: [
          ...albEntry(),
          {
            id: 'node-idle-close-22-tbm',
            subject: 'node-idle-close',
            value: 90,
            unit: 's',
            applies: { runtime: 'node', versionRange: '>=22.0.0 <23.0.0' },
            citationName: 'Node test',
            rangeLabel: 'Node 22.x',
            docUrl: 'https://example.test/node',
            docDate: '2026-11-11',
            basis: 'to-be-measured',
            scriptRef: 'measure/x.mjs',
            toleranceMs: 4,
          },
        ],
      },
    ]);
    const { result } = analyseFiles({}, { kb });
    const finding = t1Of(result);
    expect(finding.kind).toBe('UNRESOLVED');
    expect(finding.headline).toBe('a default this check rests on has not been measured yet');
    expect(finding.chain[0]?.label).toBe('idle close');
  });

  it.each([
    ['above the LB idle', 90],
    ['below the LB idle', 6],
  ])(
    'a single to-be-measured candidate (%s) is refused by the rule itself, not demoted from a PASS',
    (_where, value) => {
      const kb = loadKnowledgeBase([
        {
          schemaVersion: 1,
          entries: [
            ...albEntry(),
            {
              id: 'node-idle-close-22-tbm',
              subject: 'node-idle-close',
              value,
              unit: 's',
              applies: { runtime: 'node', versionRange: '>=22.0.0 <23.0.0' },
              citationName: 'Node test',
              rangeLabel: 'Node 22.x',
              docUrl: 'https://example.test/node',
              docDate: '2026-11-11',
              basis: 'to-be-measured',
              scriptRef: 'measure/x.mjs',
              toleranceMs: 4,
            },
          ],
        },
      ]);
      const { result } = analyseFiles({}, { kb });
      const finding = t1Of(result);
      expect(finding.kind).toBe('UNRESOLVED');
      expect(finding.headline).toBe('a default this check rests on has not been measured yet');
      // The rule returns UNRESOLVED itself (step 7). Without that guard a value above the LB
      // idle reaches the PASS factory and comes back as a demotion, which this catches.
      expect(finding.demotedFrom).toBeUndefined();
      expect(finding.declare).toEqual([DECLARE_NODE_VERSION]);
    },
  );
});

function albEntry(): unknown[] {
  return [
    {
      id: 'alb-idle-timeout-default',
      subject: 'alb-idle-timeout',
      value: 60,
      unit: 's',
      applies: { runtime: 'alb', versionRange: '*' },
      citationName: 'ALB idle timeout',
      rangeLabel: 'AWS docs, ALB',
      docUrl: 'https://example.test/alb',
      docDate: '2026-11-11',
      basis: 'documented',
      scriptRef: { notMeasurableLocally: 'test' },
    },
  ];
}
