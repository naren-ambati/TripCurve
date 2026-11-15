// An explicit keepAliveTimeout, keepAliveTimeoutBuffer or headersTimeout in Node source (measured in bolt B3 in
// measure/results/2026-11-11-b3.jsonl and 2026-11-11-b3-versions.jsonl). The demo's web workload is the base; each case changes the
// image tag or adds lines to src/server.ts and states the whole result.
//
// The rule: with an explicit keepAliveTimeout K the idle close is K plus what the release adds
// (1 s, or nothing on 18.x), where the entry measured it; with the buffer written, K plus that
// buffer. Anything not measured is UNRESOLVED with a fixed reason and never PASS or FAIL.
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import {
  analyseFiles,
  cleanupTrees,
  DEMO_FILES,
  renderChain,
  t1Of,
  withEnv,
} from '../support/analyse.js';
import { buildReport, wf } from '../support/report-fixtures.js';

afterEach(cleanupTrees);

function renderHumanFor(result: ReturnType<typeof analyseFiles>['result']): string {
  const entry = result.results[0];
  if (entry === undefined) throw new Error('no result');
  return renderHuman(buildReport({ results: [wf(entry.workload, [...entry.findings])] }));
}

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const serverTs = DEMO_FILES['src/server.ts'] as string;

const image = (tag: string) => withEnv(webYaml, 'image: node:22.23', `image: ${tag}`);
/** The demo server with these lines written just before `listen`. */
const beforeListen = (lines: string) =>
  withEnv(serverTs, 'server.listen(8080);', `${lines}\nserver.listen(8080);`);

function t1(server: string, tag = 'node:22.23'): Finding {
  return t1Of(analyseFiles({ 'src/server.ts': server, 'k8s/web.yaml': image(tag) }).result);
}

const NOT_MEASURED_AFTER =
  'the setting is not shown to be written before listen on an unconditional path, and only a value set before listen is measured';

describe('an explicit keepAliveTimeout on a release line where it was measured', () => {
  it('65000 ms on Node 22.23 is 66 s: PASS, with the setting as the source and the measured basis', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;'));
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 66 s is longer than LB idle 60 s');
    expect(f.decidingNote).toBe(
      'keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5)',
    );
    expect(renderChain(f)).toEqual([
      'idle close: 66 s @ explicit keepAliveTimeout + 1 s, Node (Node 22.x from 22.12; measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5)',
      'Node 22.23 image: "node:22.23" @ "k8s/web.yaml":17',
      'keepAliveTimeout set in the source: 65000 ms @ "src/server.ts":7',
      'LB idle: 60 s @ "k8s/ingress.yaml":9',
    ]);
    expect(f.chain[0]?.decidedBy).toMatchObject({ type: 'file', line: 7 });
  });

  it('VERSION-DEPENDENT names the kind of range it lists (the expected report layout, B3)', () => {
    const { result } = analyseFiles({ 'k8s/web.yaml': image('node:lts') });
    expect(renderHumanFor(result)).toContain('           every known Node range evaluated:\n');
  });

  it('a digit separator and a product of literals are read the same way', () => {
    expect(t1(beforeListen('server.keepAliveTimeout = 65_000;')).headline).toBe(
      'idle close 66 s is longer than LB idle 60 s',
    );
    expect(t1(beforeListen('server.keepAliveTimeout = 65 * 1000;')).kind).toBe('PASS');
  });

  it('30000 ms is 31 s: FAIL, because the measured rule shows it is below 60 s', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 30000;'));
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 31 s is not longer than LB idle 60 s');
  });

  it('59000 ms is 60 s: equal is FAIL, not PASS', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 59000;'));
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 60 s is not longer than LB idle 60 s');
  });

  it('the createServer options form behaves like assignment', () => {
    const server = withEnv(
      serverTs,
      'http.createServer((_req, res) => {',
      'http.createServer({ keepAliveTimeout: 65000 }, (_req, res) => {',
    );
    expect(t1(server).kind).toBe('PASS');
  });

  it('Object.assign before listen is read like an assignment before listen', () => {
    expect(t1(beforeListen('Object.assign(server, { keepAliveTimeout: 65000 });')).kind).toBe(
      'PASS',
    );
  });

  it('measured lines 24.x and 26.x give the same rule', () => {
    for (const tag of ['node:24.22.3', 'node:24.0', 'node:24.5.0', 'node:26.13.1', 'node:26.0']) {
      expect(t1(beforeListen('server.keepAliveTimeout = 65000;'), tag).kind, tag).toBe('PASS');
    }
  });

  it('Node 22.18 has no buffer property but closes 1 s late: the entry covers it (measured on 22.12.0 and 22.18.0)', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 7000;'), 'node:22.18');
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 8 s is not longer than LB idle 60 s');
  });

  it('Node 18.20.8 closes at exactly K: 7000 ms is 7 s, 65000 ms is 65 s, and a K beyond the measured span is not read', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 7000;'), 'node:18.20.8');
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 7 s is not longer than LB idle 60 s');
    const long = t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:18.20.8');
    expect(long.kind).toBe('PASS');
    expect(long.headline).toBe('idle close 65 s is longer than LB idle 60 s');
    const beyond = t1(beforeListen('server.keepAliveTimeout = 70000;'), 'node:18.20.8');
    expect(beyond.headline).toBe(
      'idle close not established: explicit keepAliveTimeout 70 s is outside the measured span (7 to 65 s)',
    );
  });

  it('Node 20.20.2 adds the second without the property: 7000 ms is 8 s; 65000 ms is 66 s; 70000 ms is outside the span', () => {
    expect(t1(beforeListen('server.keepAliveTimeout = 7000;'), 'node:20.20.2').headline).toBe(
      'idle close 8 s is not longer than LB idle 60 s',
    );
    expect(t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:20.20.2').kind).toBe('PASS');
    expect(t1(beforeListen('server.keepAliveTimeout = 70000;'), 'node:20.20.2').kind).toBe(
      'UNRESOLVED',
    );
  });
});

describe('a value outside what was measured is UNRESOLVED, never PASS and never FAIL', () => {
  it.each([
    [6000, 'explicit keepAliveTimeout 6 s is outside the measured span (7 to 65 s)'],
    [1000, 'explicit keepAliveTimeout 1 s is outside the measured span (7 to 65 s)'],
    [65001, 'explicit keepAliveTimeout 65.001 s is outside the measured span (7 to 65 s)'],
    [70000, 'explicit keepAliveTimeout 70 s is outside the measured span (7 to 65 s)'],
    [300000, 'explicit keepAliveTimeout 300 s is outside the measured span (7 to 65 s)'],
    [0, 'explicit keepAliveTimeout 0 s is outside the measured span (7 to 65 s)'],
  ])('K = %i ms', (ms, reason) => {
    const f = t1(beforeListen(`server.keepAliveTimeout = ${ms};`));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${reason}`);
    expect(f.demotedFrom).toBeUndefined();
    expect(renderChain(f)).toContain(
      `keepAliveTimeout set in the source: ${ms} ms @ "src/server.ts":7`,
    );
  });

  it('a value written after listen was not measured', () => {
    const f = t1(
      withEnv(
        serverTs,
        'server.listen(8080);',
        'server.listen(8080);\nserver.keepAliveTimeout = 65000;',
      ),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${NOT_MEASURED_AFTER}`);
  });

  it('a value written in a callback, in another function or in a file with no listen is not shown to be before listen', () => {
    const callback = withEnv(
      serverTs,
      'server.listen(8080);',
      "server.on('listening', () => {\n  server.keepAliveTimeout = 65000;\n});\nserver.listen(8080);",
    );
    expect(t1(callback).headline).toBe(`idle close not established: ${NOT_MEASURED_AFTER}`);
    const tune = withEnv(
      serverTs,
      'server.listen(8080);',
      'function tune(): void {\n  server.keepAliveTimeout = 65000;\n}\nserver.listen(8080);\ntune();',
    );
    expect(t1(tune).headline).toBe(`idle close not established: ${NOT_MEASURED_AFTER}`);
    const { result } = analyseFiles({
      'src/server.ts': `import { tune } from './tune.js';\n${serverTs}\ntune(server);\n`,
      'src/tune.ts':
        'export function tune(s: { keepAliveTimeout: number }): void {\n  s.keepAliveTimeout = 65000;\n}\n',
    });
    expect(t1Of(result).headline).toBe(
      `idle close not established: a keepAliveTimeout is written on an object tripcurve cannot tie to the listening server`,
    );
  });

  it('an assignment before listen inside the same function is before listen', () => {
    const inFunction = [
      "import http from 'node:http';",
      'function main(): void {',
      '  const server = http.createServer((_req, res) => {',
      "    res.end('ok');",
      '  });',
      '  server.keepAliveTimeout = 65000;',
      '  server.listen(8080);',
      '}',
      'main();',
      '',
    ].join('\n');
    expect(t1(inFunction).kind).toBe('PASS');
  });

  it('a second write of a different value is ambiguous: UNRESOLVED, not either of them', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 65000;\nserver.keepAliveTimeout = 30000;'),
    );
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('is UNRESOLVED with the reader reason for a non-literal value', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = Number(process.env.KA);'));
    expect(f.kind).toBe('UNRESOLVED');
    expect(renderChain(f).some((l) => l.startsWith('keepAliveTimeout:'))).toBe(true);
  });

  it('is UNRESOLVED when the search for source code is not complete, even with a literal in the files read', () => {
    const f = t1(`${beforeListen('server.keepAliveTimeout = 65000;')}\nimport './missing.js';\n`);
    expect(f.kind).toBe('UNRESOLVED');
    expect(renderChain(f)).toContain(
      'keepAliveTimeout set in the source: 65000 ms @ "src/server.ts":7',
    );
  });
});

describe('an explicit keepAliveTimeoutBuffer', () => {
  it('a buffer of 0 with K = 7000 ms on 22.23 is 7 s', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 0;'),
    );
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 7 s is not longer than LB idle 60 s');
    expect(f.chain[0]?.value).toMatchObject({
      source: {
        citation: 'explicit keepAliveTimeout + 0 s buffer, Node',
        basisText: 'measured at K = 7 and 65 s on 2 releases from 22.19.0 to 22.23.5',
      },
    });
  });

  it('a buffer of 0 with K = 65000 ms is 65 s (measured at K = 7 and 65 s); beyond the span it is not read', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 65000;\nserver.keepAliveTimeoutBuffer = 0;'),
    );
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 65 s is longer than LB idle 60 s');
    const beyond = t1(
      beforeListen('server.keepAliveTimeout = 70000;\nserver.keepAliveTimeoutBuffer = 0;'),
    );
    expect(beyond.headline).toBe(
      'idle close not established: explicit keepAliveTimeout 70 s is outside the measured span (7 to 65 s)',
    );
  });

  it('a buffer of 1000 (the default) written explicitly was measured at K = 7 s only', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 1000;'),
    );
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 8 s is not longer than LB idle 60 s');
    const long = t1(
      beforeListen('server.keepAliveTimeout = 65000;\nserver.keepAliveTimeoutBuffer = 1000;'),
    );
    expect(long.kind).toBe('UNRESOLVED');
    expect(long.headline).toBe(
      'idle close not established: explicit keepAliveTimeout 65 s is outside the measured span (7 to 7 s)',
    );
  });

  it.each([500, 2000, 5000, 60000])('a buffer of %i ms was not measured (B3)', (ms) => {
    const f = t1(
      beforeListen(`server.keepAliveTimeout = 65000;\nserver.keepAliveTimeoutBuffer = ${ms};`),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      `idle close not established: keepAliveTimeoutBuffer ${ms} ms is not measured`,
    );
  });

  it('a buffer value measured elsewhere but not on this release says so, not that no entry covers it', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 0;'),
      'node:22.18',
    );
    expect(f.headline).toBe(
      'idle close not established: an explicit keepAliveTimeoutBuffer is not measured on Node 22.18',
    );
  });

  it('K before listen with the buffer written after it is not measured (B3 review S1)', () => {
    const f = t1(
      withEnv(
        serverTs,
        'server.listen(8080);',
        'server.keepAliveTimeout = 7000;\nserver.listen(8080);\nserver.keepAliveTimeoutBuffer = 0;',
      ),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${NOT_MEASURED_AFTER}`);
  });

  it('a buffer set where the property does not exist is not measured (22.18, 24.5, 20.20.2)', () => {
    for (const tag of ['node:22.18', 'node:24.5', 'node:20.20.2']) {
      const f = t1(
        beforeListen('server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 0;'),
        tag,
      );
      expect(f.kind, tag).toBe('UNRESOLVED');
    }
  });

  it('a buffer without keepAliveTimeout: the default keepAliveTimeout with an explicit buffer is not measured', () => {
    const f = t1(beforeListen('server.keepAliveTimeoutBuffer = 0;'));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'idle close not established: keepAliveTimeoutBuffer is set without keepAliveTimeout, and the default keepAliveTimeout with an explicit buffer is not measured',
    );
  });

  it('a non-literal buffer is UNRESOLVED with the reader reason', () => {
    const f = t1(
      beforeListen(
        'server.keepAliveTimeout = 65000;\nserver.keepAliveTimeoutBuffer = Number(process.env.B);',
      ),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(renderChain(f).some((l) => l.startsWith('keepAliveTimeoutBuffer:'))).toBe(true);
  });
});

describe('headersTimeout (and the ranges where it cannot matter)', () => {
  it('a headersTimeout at or above the idle close cannot shorten it on Node 22', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;\nserver.headersTimeout = 66000;'));
    expect(f.kind).toBe('PASS');
    expect(renderChain(f)).toContain(
      'headersTimeout set in the source: 66000 ms @ "src/server.ts":8',
    );
  });

  it('a headersTimeout below the idle close is not measured on Node 22: UNRESOLVED', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;\nserver.headersTimeout = 1000;'));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'idle close not established: headersTimeout is set below the idle close, and its effect on this release is not measured',
    );
  });

  it('the same holds with the default idle close', () => {
    expect(t1(beforeListen('server.headersTimeout = 2000;')).kind).toBe('UNRESOLVED');
    expect(t1(beforeListen('server.headersTimeout = 66000;')).kind).toBe('FAIL');
  });

  it('a non-literal headersTimeout is UNRESOLVED', () => {
    const f = t1(
      beforeListen(
        'server.keepAliveTimeout = 65000;\nserver.headersTimeout = Number(process.env.H);',
      ),
    );
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('on Node 10.16 the idle close of 65000 ms is the default headersTimeout, 40 s: FAIL, from changelogs', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:10.16');
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 40 s is not longer than LB idle 60 s');
    expect(f.chain[0]?.value).toMatchObject({
      source: { basisText: 'from changelogs, not measured' },
      basis: 'from-changelogs-not-measured',
    });
  });

  it('on Node 12.18 the idle close is min(K, headersTimeout): 65 s with headersTimeout 66 s is PASS and prints the basis', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 65000;\nserver.headersTimeout = 66000;'),
      'node:12.18',
    );
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 65 s is longer than LB idle 60 s');
    expect(f.decidingNote).toBe(
      'smaller of keepAliveTimeout 65 s and headersTimeout 66 s (Node 12.x before 12.19.0; from changelogs, not measured)',
    );
  });

  it('on Node 12.18 a short headersTimeout decides, and its line is the deciding source', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 65000;\nserver.headersTimeout = 30000;'),
      'node:12.18',
    );
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 30 s is not longer than LB idle 60 s');
    expect(f.chain[0]?.decidedBy).toMatchObject({ type: 'file', line: 8 });
  });

  it('on Node 13.12 the default headersTimeout is 60 s: 65000 ms gives 60 s, which equals the LB idle: FAIL', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:13.12.1');
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 60 s is not longer than LB idle 60 s');
  });

  it('from 12.19 and 13.13 the trap is gone and no entry covers the release: UNRESOLVED', () => {
    for (const tag of [
      'node:12.19.0',
      'node:13.13.0',
      'node:11.10.1',
      'node:14.0.0',
      'node:9.0.0',
    ]) {
      expect(t1(beforeListen('server.keepAliveTimeout = 65000;'), tag).kind, tag).toBe(
        'UNRESOLVED',
      );
    }
  });

  it('in a trap range with no keepAliveTimeout written, the default is not in the knowledge base: UNRESOLVED', () => {
    const f = t1(serverTs, 'node:12.18');
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'idle close not established: no knowledge-base entry covers Node 12.18',
    );
  });
});

describe('several ranges with an explicit setting: VERSION-DEPENDENT, one line per range', () => {
  const lts = (lines: string) => t1(beforeListen(lines), 'node:lts');

  it('node:lts with 65000 ms lists every range and is never PASS', () => {
    const f = lts('server.keepAliveTimeout = 65000;');
    expect(f.kind).toBe('VERSION-DEPENDENT');
    expect(f.headline).toBe('Node version unknown');
    const rows = f.branches?.map((b) => [b.range, b.outcome]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['Node 22.x from 22.12', 'PASS'],
        ['Node 24.x from 24.0', 'PASS'],
        ['Node 26.x from 26.0', 'PASS'],
        ['Node 18.x from 18.20.8', 'PASS'],
        ['Node 20.x from 20.20.2', 'PASS'],
        ['Node 10.x from 10.15.2', 'FAIL'],
      ]),
    );
    // every stretch with no entry is a line of its own and reads unresolved
    expect(f.branches?.filter((b) => b.outcome === 'UNRESOLVED').length).toBeGreaterThan(2);
    expect(f.kind).not.toBe('PASS');
  });

  it('node:22 with 65000 ms: the part of 22.x before the first measured version keeps the result from PASS', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:22');
    expect(f.kind).toBe('VERSION-DEPENDENT');
    expect(f.branches?.map((b) => b.outcome)).toEqual(['UNRESOLVED', 'PASS']);
  });

  it('node:22.23 stays one range: a PASS needs no other range', () => {
    expect(t1(beforeListen('server.keepAliveTimeout = 65000;'), 'node:22.23').kind).toBe('PASS');
  });
});

describe('fractional milliseconds and https (B3)', () => {
  it.each([
    [
      '59000.4',
      'keepAliveTimeout 59000.4 ms is not a whole number of milliseconds; fractional milliseconds are not measured',
    ],
    [
      '59000.0004',
      'keepAliveTimeout 59000.0004 ms is not a whole number of milliseconds; fractional milliseconds are not measured',
    ],
    [
      '7000.5',
      'keepAliveTimeout 7000.5 ms is not a whole number of milliseconds; fractional milliseconds are not measured',
    ],
  ])('keepAliveTimeout = %s is UNRESOLVED, never a PASS that contradicts itself', (k, reason) => {
    const f = t1(beforeListen(`server.keepAliveTimeout = ${k};`));
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${reason}`);
  });

  it('a fractional buffer is UNRESOLVED', () => {
    const f = t1(
      beforeListen('server.keepAliveTimeout = 7000;\nserver.keepAliveTimeoutBuffer = 0.5;'),
    );
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(
      'idle close not established: keepAliveTimeoutBuffer 0.5 ms is not a whole number of milliseconds; fractional milliseconds are not measured',
    );
  });

  it('a fractional K in a trap range is UNRESOLVED too', () => {
    expect(t1(beforeListen('server.keepAliveTimeout = 65000.5;'), 'node:12.18').kind).toBe(
      'UNRESOLVED',
    );
  });

  const https = (lines: string) =>
    `import https from 'node:https';\nconst server = https.createServer((_q, r) => { r.end('ok'); });\n${lines}server.listen(8080);\n`;
  it('an https server is not measured: the explicit setting and the default are UNRESOLVED', () => {
    for (const lines of ['server.keepAliveTimeout = 65000;\n', '']) {
      const f = t1(https(lines));
      expect(f.kind, lines).toBe('UNRESOLVED');
      expect(f.headline, lines).toBe('idle close not established: https server not measured');
    }
  });

  it('createServer imported by name from https is not measured either', () => {
    const f = t1(
      "import { createServer } from 'node:https';\nconst server = createServer((_q, r) => { r.end('ok'); });\nserver.listen(8080);\n",
    );
    expect(f.headline).toBe('idle close not established: https server not measured');
  });

  it('the http default is unchanged', () => {
    expect(t1(serverTs).kind).toBe('FAIL');
  });
});

describe('the printed basis follows the form and the value that were measured (B3 second review m-a, m-b)', () => {
  const note = (server: string, tag = 'node:22.23') => t1(server, tag).decidingNote;
  /** The basis words of the idle close value, whatever the verdict (a FAIL has no deciding note). */
  const basis = (server: string, tag = 'node:22.23') => {
    const v = t1(server, tag).chain[0]?.value;
    return v !== undefined && 'source' in v && v.source.type === 'default'
      ? v.source.basisText
      : undefined;
  };
  const ASSIGN_22 = 'measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5';
  const OPTIONS_22 =
    'options form measured at K = 7 s on 22.23.2 and 22.23.5, at K = 65 s on 22.12.0 and 22.23.5';
  const optionsServer = (opts: string) =>
    withEnv(
      serverTs,
      'http.createServer((_req, res) => {',
      `http.createServer({ ${opts} }, (_req, res) => {`,
    );

  it('m-a: the options form prints the options-form runs, with the same verdict', () => {
    const f = t1(optionsServer('keepAliveTimeout: 65000'));
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 66 s is longer than LB idle 60 s');
    expect(f.decidingNote).toBe(
      `keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; ${OPTIONS_22})`,
    );
  });

  it('m-a: 24.x and 26.x name the one release run for each K', () => {
    expect(note(optionsServer('keepAliveTimeout: 65000'), 'node:24.22.3')).toBe(
      'keepAliveTimeout 65 s + 1 s (Node 24.x from 24.0; options form measured at K = 7 s on 24.22.3, at K = 65 s on 24.0.0)',
    );
    expect(basis(optionsServer('keepAliveTimeout: 7000'), 'node:26.13.1')).toBe(
      'options form measured at K = 7 s on 26.13.1, at K = 65 s on 26.0.0',
    );
  });

  it('m-a: a line with no options-form run says so and keeps the verdict', () => {
    const f = t1(optionsServer('keepAliveTimeout: 65000'), 'node:20.20.2');
    expect(f.kind).toBe('PASS');
    expect(f.decidingNote).toBe(
      'keepAliveTimeout 65 s + 1 s (Node 20.x from 20.20.2; options form not measured on this line; measured at K = 7, 12 and 65 s on 20.20.2)',
    );
  });

  it('m-a: an options-form K with a written buffer says the combination was not measured', () => {
    const f = t1(
      withEnv(
        optionsServer('keepAliveTimeout: 7000'),
        'server.listen(8080);',
        'server.keepAliveTimeoutBuffer = 0;\nserver.listen(8080);',
      ),
    );
    expect(f.kind).toBe('FAIL');
    expect(f.chain[0]?.value).toMatchObject({
      source: {
        basisText:
          'options form not measured on this line; measured at K = 7 and 65 s on 2 releases from 22.19.0 to 22.23.5',
      },
    });
  });

  it('m-b: a K that is not a measured value is called interpolated', () => {
    const f = t1(beforeListen('server.keepAliveTimeout = 30000;'));
    expect(f.kind).toBe('FAIL');
    expect(basis(beforeListen('server.keepAliveTimeout = 30000;'))).toBe(
      'K = 30 s interpolated between measured K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5',
    );
  });

  it('m-b: the same for the options form, and for a buffer entry', () => {
    expect(basis(optionsServer('keepAliveTimeout: 30000'))).toBe(
      `K = 30 s interpolated between ${OPTIONS_22}`,
    );
    const b = t1(
      beforeListen('server.keepAliveTimeout = 30000;\nserver.keepAliveTimeoutBuffer = 0;'),
    );
    expect(b.chain[0]?.value).toMatchObject({
      source: {
        basisText:
          'K = 30 s interpolated between measured K = 7 and 65 s on 2 releases from 22.19.0 to 22.23.5',
      },
    });
  });

  it('a measured K keeps the plain text', () => {
    expect(note(beforeListen('server.keepAliveTimeout = 65000;'))).toBe(
      `keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; ${ASSIGN_22})`,
    );
    expect(basis(beforeListen('server.keepAliveTimeout = 12000;'))).toBe(ASSIGN_22);
  });
});
