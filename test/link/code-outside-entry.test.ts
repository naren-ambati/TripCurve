// Review finding M2: code that runs outside the entry file's static imports was
// ignored, and the result was still PASS. Every case below went through the real
// pipeline (files -> read -> link -> resolve -> evaluate) and printed PASS before
// the fix. The honesty rule: "no setting found" is evidence for the Node default
// only when nothing the files show could have set it; otherwise T1 is UNRESOLVED
// with a fixed reason, never PASS and never FAIL on a default that was not established.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

afterEach(cleanupTrees);

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const serverTs = DEMO_FILES['src/server.ts'] as string;

// LB idle 5 s: the Node default (6 s) is longer, so an unread preload makes a wrong PASS.
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');

const PRELOAD_REASON = 'code preloaded before the entry was not read';
const FRAMEWORK_REASON = 'server framework not read';

function container(command: readonly string[], extra = ''): string {
  return withEnv(
    webYaml,
    '          command: ["node", "src/server.ts"]\n',
    `          command: ${JSON.stringify(command)}\n${extra}`,
  );
}

function run(files: Record<string, string | null>) {
  const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5, ...files });
  return t1Of(result);
}

describe('control: the plain demo with LB idle 5 s is a real PASS', () => {
  it('passes, so the cases below can only differ because of what they add', () => {
    const f = run({});
    expect(f.kind).toBe('PASS');
    expect(f.headline).toBe('idle close 6 s is longer than LB idle 5 s');
  });
});

describe('preload flags in the container command or args', () => {
  it.each([
    ['-r', ['node', '-r', 'dotenv/config', 'src/server.ts']],
    ['--require', ['node', '--require', 'dotenv/config', 'src/server.ts']],
    ['--require=', ['node', '--require=dotenv/config', 'src/server.ts']],
    ['--import', ['node', '--import', 'tsx', 'src/server.ts']],
    ['--import=', ['node', '--import=tsx', 'src/server.ts']],
    ['--loader', ['node', '--loader', 'ts-node/esm', 'src/server.ts']],
    ['--loader=', ['node', '--loader=ts-node/esm', 'src/server.ts']],
    ['--experimental-loader', ['node', '--experimental-loader', 'x', 'src/server.ts']],
    ['--experimental-loader=', ['node', '--experimental-loader=x', 'src/server.ts']],
  ])('%s naming a package is code not read: UNRESOLVED', (_flag, command) => {
    const f = run({ 'k8s/web.yaml': container(command) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it('also when the flags are in args', () => {
    const web = withEnv(
      container(['node']),
      '          command: ["node"]\n',
      '          command: ["node"]\n          args: ["--require", "dotenv/config", "src/server.ts"]\n',
    );
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it.each([
    ['-e', ['node', '-e', "require('./x')", 'src/server.ts']],
    ['--eval', ['node', '--eval', "require('./x')", 'src/server.ts']],
    ['-p', ['node', '-p', '1', 'src/server.ts']],
    ['--print', ['node', '--print', '1', 'src/server.ts']],
  ])('%s (an eval string) next to a declared source is code not read', (_flag, command) => {
    const f = run({
      'k8s/web.yaml': container(command),
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    source: src/server.ts\n',
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it('a literal local preload file is read like an import, including its own imports', () => {
    const web = container(['node', '--require', './preload.js', 'src/server.ts']);
    const f = run({
      'k8s/web.yaml': web,
      'preload.js': "require('./more.js');\n",
      'more.js': 'const s = {}; s.keepAliveTimeout = 1000;\n',
    });
    // `more.js` is only reached through the preload: its setting must be seen, and it is written on
    // an object tripcurve cannot tie to the listening server (it is in a file with no listen).
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('cannot tie to the listening server');
  });

  it('a local preload with nothing in it leaves the search complete (the files are listed)', () => {
    const web = container(['node', '--require=./preload.js', 'src/server.ts']);
    const f = run({ 'k8s/web.yaml': web, 'preload.js': "console.log('hi');\n" });
    expect(f.kind).toBe('PASS');
    const source = f.chain.find((s) => s.label === 'source');
    expect(source?.detail).toBe('no setting found in 2 files read');
  });

  it('a local preload that is not among the files is code not read', () => {
    const web = container(['node', '--require', './missing.js', 'src/server.ts']);
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
  });
});

describe('preload flags in an npm script', () => {
  const pkg = (start: string, extra = '') =>
    `{"name":"w","scripts":{"start":${JSON.stringify(start)}${extra}}}\n`;
  const npmWeb = container(['npm', 'start']);

  it('control: a plain script is linked and passes', () => {
    const f = run({
      'k8s/web.yaml': npmWeb,
      'package.json': pkg('node src/server.ts'),
    });
    expect(f.kind).toBe('PASS');
  });

  it('--require=<package> in the script is code not read', () => {
    const f = run({
      'k8s/web.yaml': npmWeb,
      'package.json': pkg('node --require=dotenv/config src/server.ts'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it('-r <package> in the script is code not read', () => {
    const f = run({
      'k8s/web.yaml': npmWeb,
      'package.json': pkg('node -r dotenv/config src/server.ts'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it('a prestart script IS a gap (second review pass, N2): it can alter files the server loads', () => {
    const f = run({
      'k8s/web.yaml': npmWeb,
      'package.json': pkg('node src/server.ts', ',"prestart":"node --require x setup.js"'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('an npm pre-script runs code before the server that was not read');
  });
});

describe('NODE_OPTIONS and envFrom on the container', () => {
  const env = (lines: string) => `          env:\n${lines}`;
  const cmd = ['node', 'src/server.ts'];

  it('a literal NODE_OPTIONS with --require <package> is code not read', () => {
    const web = container(
      cmd,
      env('            - name: NODE_OPTIONS\n              value: "--require dotenv/config"\n'),
    );
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRELOAD_REASON);
  });

  it('a literal NODE_OPTIONS with --import=<package> is code not read', () => {
    const web = container(
      cmd,
      env('            - name: NODE_OPTIONS\n              value: "--import=tsx"\n'),
    );
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('a literal NODE_OPTIONS preloading a local file reads that file', () => {
    const web = container(
      cmd,
      env('            - name: NODE_OPTIONS\n              value: "--require ./preload.js"\n'),
    );
    const f = run({
      'k8s/web.yaml': web,
      'preload.js': 'const s = {}; s.keepAliveTimeout = 1000;\n',
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('cannot tie to the listening server');
  });

  it('a literal NODE_OPTIONS with no preload flag changes nothing', () => {
    const web = container(
      cmd,
      env('            - name: NODE_OPTIONS\n              value: "--max-old-space-size=512"\n'),
    );
    expect(run({ 'k8s/web.yaml': web }).kind).toBe('PASS');
  });

  it('a NODE_OPTIONS from valueFrom is not read: UNRESOLVED with a fixed reason', () => {
    const web = container(
      cmd,
      env(
        '            - name: NODE_OPTIONS\n              valueFrom:\n                configMapKeyRef:\n                  name: c\n                  key: k\n',
      ),
    );
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('NODE_OPTIONS comes from a source that is not read');
  });

  it('any envFrom could inject NODE_OPTIONS: UNRESOLVED with a fixed reason', () => {
    const web = container(
      cmd,
      '          envFrom:\n            - configMapRef:\n                name: c\n',
    );
    const f = run({ 'k8s/web.yaml': web });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('NODE_OPTIONS comes from a source that is not read');
  });
});

describe('dynamic loading and servers handed to code that is not read', () => {
  const serverWith = (extra: string) => `${extra}\n${serverTs}`;

  it.each([
    ['require with a computed name', "const name = './x';\nrequire(name);"],
    ['require with a template substitution', `const n = "x";\nrequire(\`./\${n}\`);`],
    ['import() with a computed name', "const name = './x';\nimport(name);"],
  ])('%s makes the search incomplete', (_n, code) => {
    const f = run({ 'src/server.ts': serverWith(code) });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('a literal require of a package is not dynamic', () => {
    expect(run({ 'src/server.ts': serverWith("require('left-pad');") }).kind).toBe('PASS');
  });

  it('the server passed to a function from a non-local module: search incomplete', () => {
    const code = serverTs
      .replace(
        "import http from 'node:http';",
        "import http from 'node:http';\nimport { harden } from 'server-hardener';",
      )
      .replace('server.listen(8080);', 'harden(server);\nserver.listen(8080);');
    const f = run({ 'src/server.ts': code });
    expect(f.kind).toBe('UNRESOLVED');
  });

  it('the server wrapped in an object passed to a non-local function: search incomplete', () => {
    const code = serverTs
      .replace(
        "import http from 'node:http';",
        "import http from 'node:http';\nimport { terminator } from 'http-terminator';",
      )
      .replace('server.listen(8080);', 'terminator({ server });\nserver.listen(8080);');
    expect(run({ 'src/server.ts': code }).kind).toBe('UNRESOLVED');
  });

  it('the value returned by app.listen passed to a non-local function: search incomplete', () => {
    const code = [
      "import express from 'express';",
      "import { harden } from 'server-hardener';",
      'const app = express();',
      'const s = app.listen(8080);',
      'harden(s);',
      '',
    ].join('\n');
    expect(run({ 'src/server.ts': code }).kind).toBe('UNRESOLVED');
  });

  it('a Node built-in that takes the server (events.once) is not a gap', () => {
    const code = serverTs
      .replace(
        "import http from 'node:http';",
        "import http from 'node:http';\nimport { once } from 'node:events';",
      )
      .replace('server.listen(8080);', "server.listen(8080);\nawait once(server, 'listening');");
    expect(run({ 'src/server.ts': code }).kind).toBe('PASS');
  });
});

describe('the construction site counts only for http, https and Express', () => {
  it('control: an Express app.listen is a construction site and the default applies', () => {
    const code = "import express from 'express';\nconst app = express();\napp.listen(8080);\n";
    expect(run({ 'src/server.ts': code }).kind).toBe('PASS');
  });

  it('control: node:https createServer counts as a construction site, but an https server is not measured (B3)', () => {
    const code =
      "import https from 'node:https';\nconst s = https.createServer({});\ns.listen(8443);\n";
    const f = run({ 'src/server.ts': code });
    // recognised as a server (not "no server construction"), and the unmeasured protocol is named
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe('idle close not established: https server not measured');
  });

  it.each([
    [
      'Fastify',
      "import Fastify from 'fastify';\nconst app = Fastify();\napp.listen({ port: 8080 });\n",
    ],
    ['Koa', "import Koa from 'koa';\nconst app = new Koa();\napp.listen(8080);\n"],
    [
      'Hapi',
      "import Hapi from '@hapi/hapi';\nconst server = Hapi.server({ port: 8080 });\nserver.listen(8080);\n",
    ],
    ['a .listen on anything else', 'const thing = makeThing();\nthing.listen(8080);\n'],
  ])('%s is a server framework not read: UNRESOLVED', (_n, code) => {
    const f = run({ 'src/server.ts': code });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(FRAMEWORK_REASON);
  });

  it('a createServer from another module is not a construction site', () => {
    const code = "import { createServer } from 'some-framework';\nconst s = createServer();\n";
    expect(run({ 'src/server.ts': code }).kind).toBe('UNRESOLVED');
  });

  it('a Fastify listen next to a real http site is still a server not read', () => {
    const code = `${serverTs}\nimport Fastify from 'fastify';\nconst app = Fastify();\napp.listen({ port: 9090 });\n`;
    const f = run({ 'src/server.ts': code });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(FRAMEWORK_REASON);
  });
});

describe('the construction site is traced through the forms real servers are written in', () => {
  it.each([
    [
      'CommonJS require',
      "const http = require('http');\nconst s = http.createServer();\ns.listen(8080);\n",
    ],
    [
      'a destructured require',
      "const { createServer } = require('node:http');\ncreateServer().listen(8080);\n",
    ],
    [
      'a namespace import',
      "import * as http from 'http';\nconst s = http.createServer();\ns.listen(8080);\n",
    ],
    [
      'a named import with an alias',
      "import { createServer as make } from 'node:http';\nmake().listen(8080);\n",
    ],
    [
      'an import-equals require',
      "import http = require('http');\nconst s = http.createServer();\ns.listen(8080);\n",
    ],
    [
      'a server held in a class property',
      "import http from 'http';\nclass A { server = http.createServer(); start() { this.server.listen(80); } }\n",
    ],
    [
      'a server assigned after its declaration',
      "import http from 'http';\nlet s;\ns = http.createServer();\ns.listen(8080);\n",
    ],
    [
      'Express through require, with the listen result kept',
      "const express = require('express');\nconst app = express();\nconst server = app.listen(8080);\nserver.keepAliveTimeout;\n",
    ],
  ])('%s is a construction site and the default applies', (_n, code) => {
    expect(run({ 'src/server.ts': code }).kind).toBe('PASS');
  });

  it('a name assigned in a cycle is not traced, and does not hang', () => {
    const code = 'let a, b;\na = b;\nb = a;\na.listen(8080);\n';
    const f = run({ 'src/server.ts': code });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(FRAMEWORK_REASON);
  });

  it(
    'many assignments to one name cost linear work, not quadratic (no wall-clock budget)',
    () => {
      const work = (n: number) => {
        const lines = ["import http from 'http';", 'let s;'];
        for (let i = 0; i < n; i += 1) lines.push('s = http.createServer();');
        for (let i = 0; i < n; i += 1) lines.push('s.listen(8080);');
        run({ 'src/server.ts': `${lines.join('\n')}\n` });
        cleanupTrees();
      };
      expect(scalingRatio(work, 1500)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('a name assigned that many times is not traced to one server', () => {
    const lines = ["import http from 'http';", 'let s;'];
    for (let i = 0; i < 40; i += 1) lines.push('s = http.createServer();');
    lines.push('s.listen(8080);');
    const f = run({ 'src/server.ts': `${lines.join('\n')}\n` });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(FRAMEWORK_REASON);
  });
});
