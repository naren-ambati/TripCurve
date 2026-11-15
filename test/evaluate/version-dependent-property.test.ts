// The third property (bolt B3): a VERSION-DEPENDENT result is never turned into
// PASS, and the run is never clean, while any of its branches is unresolved or `to be measured`.
// Two seeded generators: one over knowledge bases of the generator's own (so `to be measured`
// ranges occur), one over the shipped knowledge base and the whole pipeline. A failing case
// replays from its seed and index.
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Finding,
  fileSource,
  inputText,
  isUnresolved,
  makeSourcedValue,
  type SourcedValue,
} from '../../src/core/index.js';
import { evaluateT1 } from '../../src/evaluate/index.js';
import { loadKnowledgeBase, parseVersion, unknownInterval } from '../../src/kb/index.js';
import { renderHuman, summarizeRun } from '../../src/report/index.js';
import type { ResolvedWorkload } from '../../src/resolve/index.js';
import { type NodeIdleSettings, planNodeRanges } from '../../src/resolve/node-ranges.js';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';
import { makeRng, type Rng } from '../support/prng.js';
import { buildReport, wf } from '../support/report-fixtures.js';
import { shutdownDefaults } from '../support/shutdown-defaults.js';

afterEach(cleanupTrees);

const FILE = fileSource(inputText('k8s/x.yaml'), 3);

function read(n: number, unit: 's' | 'ms'): SourcedValue {
  return makeSourcedValue({ value: n, unit, source: FILE, basis: 'declared' });
}

/** Node release lines 10 to 29, each entry one line from a chosen lower bound; some `to be measured`. */
function randomKb(rng: Rng) {
  const entries: Record<string, unknown>[] = [];
  const lines = new Set<number>();
  const count = rng.int(1, 8);
  for (let i = 0; i < count; i += 1) lines.add(rng.int(10, 29));
  for (const line of lines) {
    const basis = rng.pick(['measured', 'documented', 'from-changelogs', 'to-be-measured']);
    entries.push({
      id: `node-idle-close-${line}x`,
      subject: 'node-idle-close',
      value: rng.int(1, 120),
      unit: 's',
      applies: {
        runtime: 'node',
        versionRange: `>=${line}.${rng.int(0, 3)}.0 <${line + 1}.0.0`,
      },
      citationName: 'Test source',
      rangeLabel: `Test ${line}.x`,
      docUrl: 'https://example.test/node',
      docDate: '2026-11-11',
      basis,
      ...(basis === 'measured'
        ? { measuredOn: { version: `${line}.0.0`, date: '2026-11-11', platform: 'test' } }
        : {}),
      scriptRef: 'measure/node-idle-close.mjs',
      toleranceMs: 4,
    });
  }
  return loadKnowledgeBase([{ schemaVersion: 1, entries }]);
}

function workloadWith(candidates: ResolvedWorkload['idleCloseCandidates']): ResolvedWorkload {
  const lb = read(60, 's');
  return {
    workload: { kind: 'Deployment', namespace: inputText('ns'), name: inputText('w') },
    file: FILE,
    linkState: 'linked',
    behindLb: {
      kind: 'alb',
      lbIdle: lb,
      lbIdleSteps: [{ label: 'LB idle', value: lb }],
      declare: [],
    },
    server: { family: 'node' },
    nodeVersion: {
      label: 'Node (any version)',
      interval: unknownInterval(),
      step: { label: 'Node version', value: inputText('node:lts') },
    },
    idleCloseCandidates: candidates,
    idleClose: { candidates, problems: [], evidence: [], declare: [], explicitSetting: false },
    versionRanges: [],
    drainSearchComplete: true,
    assumptions: [],
    ...shutdownDefaults(),
  };
}

function runIsNotClean(finding: Finding): void {
  const summary = summarizeRun({ findings: [finding], uncheckedFiles: 0, workloadsNotChecked: 0 });
  expect(summary.clean).toBe(false);
  expect(summary.exitCode).toBe(1);
  const text = renderHuman(buildReport({ results: [wf(finding.subject as never, [finding])] }));
  expect(text).not.toMatch(/All checks passed|No failures/);
}

describe('property: planned candidates (random knowledge bases and settings)', () => {
  const rng = makeRng(20261112);
  const seen = { versionDependent: 0, withUnresolvedBranch: 0, withToBeMeasured: 0, passBranch: 0 };

  for (let i = 0; i < 600; i += 1) {
    const kb = randomKb(rng);
    const form3 = rng.int(0, 2);
    const interval =
      form3 === 0
        ? unknownInterval()
        : parseVersion(
            form3 === 1
              ? `${rng.int(10, 29)}`
              : `${rng.int(10, 29)}.${rng.int(0, 5)}.${rng.int(0, 5)}`,
          );
    const form = rng.int(0, 3);
    const settings: NodeIdleSettings = {
      ...(form === 0 ? {} : { keepAlive: read(rng.int(0, 90_000), 'ms') }),
      notBeforeListen: [],
    };
    const candidates = planNodeRanges({ interval, versionLabel: 'Node x', kb, settings });
    const finding = evaluateT1(workloadWith(candidates));

    it(`case ${i}: ${candidates.length} candidates give ${finding.kind}`, () => {
      expect(candidates.length).toBeGreaterThan(0);
      if (candidates.length < 2) return;
      expect(finding.kind).toBe('VERSION-DEPENDENT');
      expect(finding.branches).toHaveLength(candidates.length);
      runIsNotClean(finding);
      finding.branches?.forEach((branch, index) => {
        const c = candidates[index];
        if (c === undefined) throw new Error('branch without candidate');
        // The branch order is the candidate order and a branch never reads better than its candidate.
        expect(branch.range).toBe(c.condition);
        if (isUnresolved(c.value)) expect(branch.outcome).toBe('UNRESOLVED');
        else if (!c.supportsPass) expect(branch.outcome).toBe('unresolved: to be measured');
        else expect(['PASS', 'FAIL']).toContain(branch.outcome);
      });
    });
    if (candidates.length >= 2) {
      seen.versionDependent += 1;
      if (candidates.some((c) => isUnresolved(c.value))) seen.withUnresolvedBranch += 1;
      if (candidates.some((c) => !isUnresolved(c.value) && !c.supportsPass))
        seen.withToBeMeasured += 1;
      if (finding.branches?.some((b) => b.outcome === 'PASS')) seen.passBranch += 1;
    }
  }

  it('the generator reaches unresolved branches, to-be-measured branches and passing branches', () => {
    expect(seen.versionDependent).toBeGreaterThan(40);
    expect(seen.withUnresolvedBranch).toBeGreaterThan(50);
    expect(seen.withToBeMeasured).toBeGreaterThan(10);
    expect(seen.passBranch).toBeGreaterThan(10);
  });
});

describe('property: the whole pipeline on the shipped knowledge base', () => {
  const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
  const serverTs = DEMO_FILES['src/server.ts'] as string;
  const rng = makeRng(20261113);
  const tags = [
    'node:lts',
    'node:current',
    'node:latest',
    'node',
    'node:22',
    'node:22-alpine',
    'node:24',
    'node:20',
    'node:18',
    'node:18.20',
    'node:22.23',
    'node:22.23.2-slim',
    'node:20.20.2',
    'node:10.16',
    'node:12.18',
    'node:13.12',
    'node:26',
  ];
  // Tags that name a stretch of versions the knowledge base does not fully cover.
  const PARTIAL_TAGS = new Set([
    'node:lts',
    'node:current',
    'node:latest',
    'node',
    'node:22',
    'node:22-alpine',
    'node:20',
    'node:18',
    'node:18.20',
  ]);
  const lines = [
    '',
    'server.keepAliveTimeout = 65000;',
    'server.keepAliveTimeout = 7000;',
    'server.keepAliveTimeout = 30000;',
    'server.keepAliveTimeout = 65000;\nserver.headersTimeout = 66000;',
    'server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 0;',
    'server.keepAliveTimeout = 65000;\nserver.keepAliveTimeoutBuffer = 2000;',
    'server.headersTimeout = 2000;',
  ];

  it('no result with a branch that is not a number is PASS, and the run is never clean', () => {
    let versionDependent = 0;
    let unresolvedBranches = 0;
    for (let i = 0; i < 160; i += 1) {
      const tag = rng.pick(tags);
      const extra = rng.pick(lines);
      const server = withEnv(
        serverTs,
        'server.listen(8080);',
        `${extra}${extra === '' ? '' : '\n'}server.listen(8080);`,
      );
      const { result } = analyseFiles({
        'k8s/web.yaml': withEnv(webYaml, 'image: node:22.23', `image: ${tag}`),
        'src/server.ts': server,
      });
      const finding = t1Of(result);
      const where = `${tag} / ${JSON.stringify(extra)}`;
      if (finding.kind === 'VERSION-DEPENDENT') {
        versionDependent += 1;
        runIsNotClean(finding);
        const outcomes = finding.branches?.map((b) => b.outcome) ?? [];
        expect(outcomes.length, where).toBeGreaterThan(1);
        if (outcomes.some((o) => o !== 'PASS' && o !== 'FAIL')) unresolvedBranches += 1;
      }
      // An unknown or partial version never gives PASS when some version it names has no entry.
      if (PARTIAL_TAGS.has(tag)) expect(finding.kind, where).not.toBe('PASS');
    }
    expect(versionDependent).toBeGreaterThan(40);
    expect(unresolvedBranches).toBeGreaterThan(20);
  });

  it('the default source of a branch is named: every number printed has a basis', () => {
    const { result } = analyseFiles({
      'k8s/web.yaml': withEnv(webYaml, 'image: node:22.23', 'image: node:lts'),
    });
    const finding = t1Of(result);
    expect(finding.kind).toBe('VERSION-DEPENDENT');
    for (const b of finding.branches ?? []) {
      const value = b.chain[0]?.value;
      if (value !== undefined && !isUnresolved(value)) {
        expect(value).toMatchObject({ source: { type: 'default' } });
        expect((value as SourcedValue).source).toMatchObject({
          basisText: expect.stringMatching(/^measured on \d/),
        });
      }
    }
  });
});
