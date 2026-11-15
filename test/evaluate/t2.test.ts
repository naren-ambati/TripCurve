// Rule T2 end to end: files -> read -> link -> resolve -> evaluate.
// Every acceptance criterion has a fixture, and the maintainer decision of 2026-11-10 has a named one: a
// terminus `beforeShutdown` of unresolved duration (or a preStop hook) is UNRESOLVED, never PASS.
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyseFiles,
  cleanupTrees,
  DEMO_FILES,
  lineOf,
  renderChain,
  ruleOf,
  sleepLifecycle,
  webManifest,
} from '../support/analyse.js';
import { runBuilt } from '../support/e2e.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  cleanupTrees();
  for (const t of trees.splice(0)) t.cleanup();
});

const T2 = (files: Record<string, string | null>) => ruleOf(analyseFiles(files).result, 'T2');
const SERVER_HEAD = [
  "import http from 'node:http';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
  '',
].join('\n');
const DECLARE_DRAIN = 'declare drain.in_process_s for this workload in tripcurve.yaml';
const declaration = (lines: string[]): string =>
  ['version: 1', 'workloads:', '  - name: web', '    namespace: shop', ...lines, ''].join('\n');

describe('a preStop delay is a drain', () => {
  it.each([
    ['exec sleep', '                command: ["sleep", "10"]'],
    ['exec /bin/sh -c sleep', '                command: ["/bin/sh", "-c", "sleep 10"]'],
  ])('%s: PASS with its source', (_name, command) => {
    const lifecycle = [
      '          lifecycle:',
      '            preStop:',
      '              exec:',
      command,
    ].join('\n');
    const f = T2({ 'k8s/web.yaml': webManifest({ lifecycle }) });
    expect(lineOf(f)).toBe('PASS preStop sleep 10 s');
    expect(renderChain(f)).toEqual(['preStop: 10 s @ "k8s/web.yaml":25']);
    expect(f.assumptions?.map((a) => a.text)).toEqual([
      "Endpoint removal needs time to propagate; AWS's EKS guide suggests a preStop of 10 s. tripcurve checks a delay exists, not that it is enough.",
    ]);
  });

  it('the sleep handler: PASS, with the line of its seconds', () => {
    const lifecycle = [
      '          lifecycle:',
      '            preStop:',
      '              sleep:',
      '                seconds: 7',
    ].join('\n');
    const f = T2({ 'k8s/web.yaml': webManifest({ lifecycle }) });
    expect(lineOf(f)).toBe('PASS preStop sleep 7 s');
    expect(renderChain(f)).toEqual(['preStop: 7 s @ "k8s/web.yaml":25']);
  });

  it('a delay of 0 is not a drain: FAIL', () => {
    const f = T2({ 'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(0) }) });
    expect(lineOf(f)).toBe('FAIL no drain delay before SIGTERM');
    expect(renderChain(f)).toContain('preStop: 0 s @ "k8s/web.yaml":25');
  });
});

describe('no drain, and the search was complete', () => {
  it('a Node workload whose source was linked and read: FAIL, naming what was searched', () => {
    const f = T2({});
    expect(lineOf(f)).toBe('FAIL no drain delay before SIGTERM');
    expect(renderChain(f)).toEqual([
      'target-type: ip @ "k8s/ingress.yaml":8',
      'preStop none in: "k8s/web.yaml"',
      'drain none no lightship, terminus or SIGTERM drain found in 1 file read: "src/server.ts"',
    ]);
    expect(f.assumptions).toBeUndefined();
  });

  it('a gunicorn workload: FAIL, and the detail line says in-process drains are read for Node source only', async () => {
    const { pythonApp } = await import('../support/python.js');
    const r = pythonApp('          command: ["gunicorn", "app:app"]');
    const f = ruleOf(r, 'T2');
    expect(lineOf(f)).toBe('FAIL no drain delay before SIGTERM');
    expect(renderChain(f).at(-1)).toBe(
      'drain none: in-process drains are read for Node source only; none declared',
    );
  });
});

describe('a server that is not recognised has no complete drain search', () => {
  it('no drain found: UNRESOLVED, not FAIL, and T3 cannot add a drain either', async () => {
    const { pythonApp } = await import('../support/python.js');
    const r = pythonApp('          command: ["sh", "-c", "exec /app/serve"]');
    const t2 = ruleOf(r, 'T2');
    expect(lineOf(t2)).toBe('UNRESOLVED the search for a drain is not complete');
    expect(renderChain(t2).at(-1)).toBe(
      'drain: ? the server is not recognised, so the search for a drain is not complete',
    );
    expect(ruleOf(r, 'T3').kind).toBe('UNRESOLVED');
  });
});

describe('a Node workload whose source is not linked', () => {
  it('with no preStop: UNRESOLVED, not FAIL', () => {
    const f = T2({ 'k8s/web.yaml': webManifest({ command: '["node"]' }) });
    expect(lineOf(f)).toBe('UNRESOLVED source not linked; link it or declare a drain');
    expect(f.declare).toEqual([
      'set source for this workload in tripcurve.yaml, or declare drain.in_process_s for it',
    ]);
    expect(renderChain(f)[1]).toBe('source: ? source not linked: the node command names no file');
  });

  it('with a preStop delay: PASS (the preStop is the drain)', () => {
    const f = T2({
      'k8s/web.yaml': webManifest({ command: '["node"]', lifecycle: sleepLifecycle(10) }),
    });
    expect(f.kind).toBe('PASS');
  });

  it('with a declared drain: PASS', () => {
    const f = T2({
      'k8s/web.yaml': webManifest({ command: '["node"]' }),
      'tripcurve.yaml': declaration(['    drain:', '      in_process_s: 12']),
    });
    expect(lineOf(f)).toBe('PASS declared drain 12 s');
  });
});

describe('a Node search that is not complete is never FAIL', () => {
  const dynamic = `${SERVER_HEAD}const name = process.env.PLUGIN;\nrequire(name);\n`;
  it('with no drain found: UNRESOLVED, saying why', () => {
    const f = T2({ 'src/server.ts': dynamic });
    expect(lineOf(f)).toBe('UNRESOLVED the search for a drain is not complete');
    expect(renderChain(f).at(-1)).toBe(
      'drain: ? the source search is not complete, so a drain in code that was not read cannot be ruled out',
    );
  });

  it('with a preStop delay it is PASS (the preStop is established)', () => {
    expect(
      T2({
        'src/server.ts': dynamic,
        'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10) }),
      }).kind,
    ).toBe('PASS');
  });
});

describe('a preStop hook of unresolved duration', () => {
  const hook = [
    '          lifecycle:',
    '            preStop:',
    '              httpGet:',
    '                path: /drain',
    '                port: 8080',
  ].join('\n');

  it('is UNRESOLVED, pointing at the hook, with what to write instead', () => {
    const f = T2({ 'k8s/web.yaml': webManifest({ lifecycle: hook }) });
    expect(lineOf(f)).toBe('UNRESOLVED preStop hook of unknown duration');
    expect(renderChain(f)[0]).toBe('preStop: unknown @ "k8s/web.yaml":23');
    expect(f.declare?.[0]).toContain('exec sleep');
  });

  it('stays UNRESOLVED when a drain is declared: a hook has no declaration key (see docs/limits.md)', () => {
    const f = T2({
      'k8s/web.yaml': webManifest({ lifecycle: hook }),
      'tripcurve.yaml': declaration(['    drain:', '      in_process_s: 12']),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it.each([
    [
      'an exec of another command',
      '              exec:\n                command: ["/bin/drain.sh"]',
    ],
    ['a sleep with a variable', '              exec:\n                command: ["sleep", "$(N)"]'],
    [
      'a sleep with more words',
      '              exec:\n                command: ["sleep", "10", "&&", "true"]',
    ],
  ])('%s is a hook', (_name, body) => {
    const lifecycle = ['          lifecycle:', '            preStop:', body].join('\n');
    expect(T2({ 'k8s/web.yaml': webManifest({ lifecycle }) }).kind).toBe('UNRESOLVED');
  });
});

describe('and the maintainer decision of 2026-11-10: a terminus beforeShutdown of unresolved duration', () => {
  const terminus = (hook: string): string =>
    [
      "import http from 'node:http';",
      "import { createTerminus } from '@godaddy/terminus';",
      'const server = http.createServer((_req, res) => { res.end("ok"); });',
      'server.listen(8080);',
      `createTerminus(server, { beforeShutdown: ${hook} });`,
      '',
    ].join('\n');

  it('NAMED FIXTURE: never PASS, with what to declare', () => {
    const f = T2({ 'src/server.ts': terminus('() => sleep(5000)') });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.demotedFrom).toBeUndefined();
    expect(f.headline).toBe('drain of unknown duration in terminus beforeShutdown');
    expect(renderChain(f)[0]).toBe('drain: unknown @ "src/server.ts":5');
    expect(f.declare).toEqual([DECLARE_DRAIN]);
  });

  it('stays UNRESOLVED even with a preStop delay: nothing shows PASS over an unverified value', () => {
    const f = T2({
      'src/server.ts': terminus('() => sleep(5000)'),
      'k8s/web.yaml': webManifest({ lifecycle: sleepLifecycle(10) }),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('the whole run is never clean: the built command exits 1 and prints no green line', () => {
    const t = makeTree();
    trees.push(t);
    const files = {
      ...DEMO_FILES,
      'src/server.ts': terminus('() => sleep(5000)'),
      'k8s/web.yaml': webManifest({
        lifecycle: sleepLifecycle(10),
        pod: '      terminationGracePeriodSeconds: 45',
      }),
      'tripcurve.yaml': declaration(['    longest_request_s: 5']),
    };
    for (const [path, text] of Object.entries(files)) t.write(path, text as string);
    const run = runBuilt(['.'], { cwd: t.root });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      'UNRESOLVED T2  drain of unknown duration in terminus beforeShutdown',
    );
    expect(run.stdout).toContain('UNRESOLVED T3  drain duration unknown; grace cannot be checked');
    expect(run.stdout).not.toContain('All checks passed');
    expect(run.stdout).not.toMatch(/PASS T[23]/);
  });

  it('a declared drain settles it (the recovery table): PASS with the declaration as the source', () => {
    const f = T2({
      'src/server.ts': terminus('() => sleep(5000)'),
      'tripcurve.yaml': declaration(['    drain:', '      in_process_s: 6']),
    });
    expect(lineOf(f)).toBe('PASS declared drain 6 s');
    expect(renderChain(f)).toEqual(['drain: 6 s @ "tripcurve.yaml":6']);
  });

  it('a literal delay in the README form is a drain: PASS, with the line of the call', () => {
    const f = T2({
      'src/server.ts': terminus('() => new Promise((resolve) => setTimeout(resolve, 5000))'),
    });
    expect(lineOf(f)).toBe('PASS in-process drain 5 s (terminus beforeShutdown)');
    expect(f.decidingNote).toBe('terminus beforeShutdown');
    expect(f.chain[0]?.decidedBy).toMatchObject({ type: 'file', line: 5 });
  });
});

describe('in-process drains in Node source', () => {
  it('a literal SIGTERM-handler delay: PASS', () => {
    const f = T2({
      'src/server.ts': `${SERVER_HEAD}process.on('SIGTERM', async () => {\n  await new Promise((r) => setTimeout(r, 4000));\n  server.close();\n});\n`,
    });
    expect(lineOf(f)).toBe('PASS in-process drain 4 s (SIGTERM handler)');
  });

  it('a SIGTERM handler that closes at once is no drain: FAIL', () => {
    const f = T2({
      'src/server.ts': `${SERVER_HEAD}process.on('SIGTERM', () => server.close());\n`,
    });
    expect(f.kind).toBe('FAIL');
  });

  it('a SIGTERM handler that is not read: UNRESOLVED (a non-literal delay is unresolved)', () => {
    const f = T2({
      'src/server.ts': `${SERVER_HEAD}process.on('SIGTERM', async () => {\n  await new Promise((r) => setTimeout(r, MS));\n  server.close();\n});\n`,
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('drain of unknown duration in a SIGTERM handler');
  });

  it('two drains: how they combine is not read, so UNRESOLVED', () => {
    const f = T2({
      'src/server.ts': `${SERVER_HEAD}process.on('SIGTERM', () => server.close());\nprocess.on('SIGTERM', () => { setTimeout(() => server.close(), 2000); });\n`,
    });
    expect(lineOf(f)).toBe(
      'UNRESOLVED more than one in-process drain: how they combine is not read',
    );
  });
});

describe('lightship', () => {
  const lightship = (call: string): string =>
    `${SERVER_HEAD}import { createLightship } from 'lightship';\n${call}\n`;
  const pinned = (version: string): Record<string, string> => ({
    'package.json': JSON.stringify({ dependencies: { lightship: version } }, null, 2),
  });

  it('the default delay is the knowledge base value for the release, and the Assumptions say how it was used', () => {
    const { result } = analyseFiles({
      'src/server.ts': lightship('await createLightship();'),
      ...pinned('9.1.0'),
    });
    const f = ruleOf(result, 'T2');
    expect(lineOf(f)).toBe('PASS in-process drain 5 s (lightship)');
    expect(f.decidingNote).toBe('lightship shutdownDelay default');
    expect(renderChain(f)[0]).toBe(
      'drain: 5 s @ default: lightship shutdownDelay (lightship 9.x; measured on 9.1.0)',
    );
    const texts = result.assumptions.map((a) => a.text);
    expect(texts).toContain(
      'lightship detects Kubernetes at run time; assumed true because the workload is a Kubernetes manifest.',
    );
    expect(texts).toContain('The lightship version is taken from "package.json".');
  });

  it('a literal shutdownDelay is the drain, and needs no Kubernetes assumption', () => {
    const { result } = analyseFiles({
      'src/server.ts': lightship('await createLightship({ shutdownDelay: 7000 });'),
      ...pinned('9.1.0'),
    });
    const f = ruleOf(result, 'T2');
    expect(lineOf(f)).toBe('PASS in-process drain 7 s (lightship)');
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('detects Kubernetes');
  });

  it.each([
    ['no version in the files', {}, 'no lightship version in the files'],
    [
      'a range, not a pin',
      pinned('^9.1.0'),
      'lightship is not pinned to an exact version in the files',
    ],
    [
      'a release the measurement does not cover (8.x)',
      pinned('8.5.0'),
      'lightship 8.5.0 is not covered by a measured default',
    ],
    [
      'a release before the measured one (9.0.x)',
      pinned('9.0.0'),
      'lightship 9.0.0 is not covered by a measured default',
    ],
    [
      'the next major (10.x)',
      pinned('10.0.0'),
      'lightship 10.0.0 is not covered by a measured default',
    ],
  ])('%s: UNRESOLVED with "declare drain.in_process_s"', (_name, files, reason) => {
    const f = T2({ 'src/server.ts': lightship('await createLightship();'), ...files });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('drain of unknown duration in lightship');
    expect(f.chain.at(-1)).toMatchObject({ label: 'reason', value: { note: reason } });
    expect(f.declare).toEqual([DECLARE_DRAIN]);
  });

  it('a conditional call is a drain tripcurve does not read: UNRESOLVED', () => {
    const f = T2({
      'src/server.ts': lightship('if (process.env.K8S) { await createLightship(); }'),
      ...pinned('9.1.0'),
    });
    expect(f.kind).toBe('UNRESOLVED');
  });
});

describe('a declared drain', () => {
  it('PASS with the declaration as the source', () => {
    const f = T2({ 'tripcurve.yaml': declaration(['    drain:', '      in_process_s: 12']) });
    expect(lineOf(f)).toBe('PASS declared drain 12 s');
    expect(renderChain(f)).toEqual(['drain: 12 s @ "tripcurve.yaml":6']);
  });

  it('a declared drain of 0 is no drain: FAIL (the maintainer said so, and the search is not needed)', () => {
    const f = T2({ 'tripcurve.yaml': declaration(['    drain:', '      in_process_s: 0']) });
    expect(f.kind).toBe('FAIL');
    expect(renderChain(f).at(-1)).toBe('drain: 0 s @ "tripcurve.yaml":6');
  });

  it('it is per workload: a declaration naming another workload is a configuration error, not applied', () => {
    const { result } = analyseFiles({
      'tripcurve.yaml': [
        'version: 1',
        'workloads:',
        '  - name: other',
        '    drain:',
        '      in_process_s: 9',
        '',
      ].join('\n'),
    });
    expect(result.configErrors).toHaveLength(1);
    expect(result.results).toEqual([]);
  });
});

describe('links that are not settled', () => {
  it('two objects of one name: UNRESOLVED, with the link problem', () => {
    const web = webManifest({ lifecycle: sleepLifecycle(10) });
    const f = T2({ 'k8s/web.yaml': `${web}---\n${web}` });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('more than one match: this workload cannot be linked to one object');
  });

  it('two containers that both declare the port: UNRESOLVED, container not determined', () => {
    const twin = `${webManifest({ lifecycle: sleepLifecycle(10) })}        - name: sidecar\n          image: busybox\n          ports:\n            - containerPort: 8080\n`;
    const f = T2({ 'k8s/web.yaml': twin });
    expect(lineOf(f)).toBe('UNRESOLVED link unresolved: container not determined');
  });
});
