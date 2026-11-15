// In-process drains read from Node source: lightship, terminus `beforeShutdown`
// and a literal delay in a SIGTERM handler, with the allow-list approach of B1 to B3. A drain counts
// only when it is a plain statement run from the top of the file, tied to the process or the one
// listening server, in a small set of forms with a number written in the code. Everything else is a
// drain of UNRESOLVED duration, never "no drain" and never a guessed delay.
import { afterEach, describe, expect, it } from 'vitest';
import { type InputText, inputText, inputTextEquals } from '../../src/core/index.js';
import { type InputFile, intake } from '../../src/parse/intake/index.js';
import { type NodeDrain, readNodeServer } from '../../src/parse/node/index.js';
import { txt } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function drainsOf(files: Record<string, string>, entry = 'server.js'): NodeDrain[] {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const r = intake({ root: t.root });
  const file = r.files.find((f): f is InputFile =>
    inputTextEquals(f.canonicalPath, inputText(entry)),
  );
  if (file === undefined) throw new Error('no entry');
  return [...readNodeServer(r, file).drains];
}

function where(d: NodeDrain): string {
  const s = d.source;
  return s.type === 'file' ? `${txt(s.file as InputText)}:${s.line}` : '?';
}

/** `kind <delay> @file:line` for a read delay; `kind ? <reason>` for an unresolved one. */
function summary(list: readonly NodeDrain[]): string[] {
  return list.map((d) => {
    if (d.delay.state === 'lightship-default') return `${d.kind} default @${where(d)}`;
    if (d.delay.state === 'unresolved') return `${d.kind} ? ${d.delay.value.reason}`;
    const at = d.delay.value.source;
    const line = at.type === 'file' ? at.line : 0;
    return `${d.kind} ${d.delay.value.value} ms (line ${line}) @${where(d)}`;
  });
}

const SERVER = [
  "import http from 'node:http';",
  'const server = http.createServer((_req, res) => { res.end("ok"); });',
  'server.listen(8080);',
].join('\n');

describe('lightship', () => {
  const head = `${SERVER}\nimport { createLightship } from 'lightship';\n`;

  it('createLightship() with no options is a drain of the default delay (resolved later, from the version)', () => {
    expect(
      summary(drainsOf({ 'server.js': `${head}const lightship = await createLightship();\n` })),
    ).toEqual(['lightship default @server.js:5']);
  });

  it('createLightship({}) and options that do not touch the delay are the default too', () => {
    const d = drainsOf({
      'server.js': `${head}const lightship = await createLightship({ port: 9000, gracefulShutdownTimeout: 20000 });\n`,
    });
    expect(summary(d)).toEqual(['lightship default @server.js:5']);
  });

  it('a literal shutdownDelay is the drain, with the line of the number', () => {
    const d = drainsOf({
      'server.js': `${head}const lightship = await createLightship({\n  shutdownDelay: 7000,\n});\n`,
    });
    expect(summary(d)).toEqual(['lightship 7000 ms (line 6) @server.js:5']);
  });

  it('a product of literals is a literal', () => {
    const d = drainsOf({
      'server.js': `${head}await createLightship({ shutdownDelay: 5 * 1000 });\n`,
    });
    expect(summary(d)).toEqual(['lightship 5000 ms (line 5) @server.js:5']);
  });

  it('a shutdownDelay of 0 is read as 0 (no drain; the resolver decides)', () => {
    const d = drainsOf({ 'server.js': `${head}await createLightship({ shutdownDelay: 0 });\n` });
    expect(summary(d)).toEqual(['lightship 0 ms (line 5) @server.js:5']);
  });

  it('reads a require() binding and a namespace import', () => {
    const viaRequire = drainsOf({
      'server.js': `${SERVER}\nconst { createLightship } = require('lightship');\ncreateLightship();\n`,
    });
    expect(summary(viaRequire)).toEqual(['lightship default @server.js:5']);
    const viaNamespace = drainsOf({
      'server.js': `${SERVER}\nimport * as L from 'lightship';\nL.createLightship({ shutdownDelay: 1000 });\n`,
    });
    expect(summary(viaNamespace)).toEqual(['lightship 1000 ms (line 5) @server.js:5']);
  });

  it.each([
    [
      'a delay that is not a literal',
      'const d = Number(process.env.D);\nawait createLightship({ shutdownDelay: d });',
    ],
    ['a computed delay', 'await createLightship({ shutdownDelay: 5000 + 1 });'],
    ['a delay given twice', 'await createLightship({ shutdownDelay: 1, shutdownDelay: 2 });'],
    ['options that are not written in place', 'const o = {};\nawait createLightship(o);'],
    ['a spread', 'await createLightship({ ...base });'],
    [
      'detectKubernetes (it can switch the delay to 0)',
      'await createLightship({ detectKubernetes: false });',
    ],
    ['signals (it changes what triggers the shutdown)', 'await createLightship({ signals: [] });'],
    ['an option that is not read', 'await createLightship({ terminate: () => {} });'],
    ['a call under a condition', 'if (process.env.PROD) { await createLightship(); }'],
    ['a call in a callback', 'server.on("listening", () => { createLightship(); });'],
    [
      'a call in a function that is never called',
      'async function boot() { await createLightship(); }',
    ],
    ['an alias of createLightship', 'const make = createLightship;\nawait make();'],
    ['createLightship passed to another function', 'start(createLightship);'],
  ])('%s is a drain of unresolved duration', (_name, body) => {
    const d = drainsOf({ 'server.js': `${head}${body}\n` });
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.every((x) => x.delay.state === 'unresolved')).toBe(true);
    expect(d.every((x) => x.kind === 'lightship')).toBe(true);
  });

  it('a file that imports lightship and never calls it has no drain (nothing is created)', () => {
    expect(drainsOf({ 'server.js': head })).toEqual([]);
  });

  it('a function called at the top of the file is a plain path', () => {
    const d = drainsOf({
      'server.js': `${head}async function boot() { await createLightship({ shutdownDelay: 3000 }); }\nboot();\n`,
    });
    expect(summary(d)).toEqual(['lightship 3000 ms (line 5) @server.js:5']);
  });
});

describe('terminus beforeShutdown', () => {
  const head = [
    "import http from 'node:http';",
    "import { createTerminus } from '@godaddy/terminus';",
    'const server = http.createServer((_req, res) => { res.end("ok"); });',
    'server.listen(8080);',
    '',
  ].join('\n');

  it('the README form: a promise that resolves after a literal delay', () => {
    const d = drainsOf({
      'server.js': `${head}createTerminus(server, {\n  beforeShutdown: () => new Promise((resolve) => setTimeout(resolve, 5000)),\n});\n`,
    });
    expect(summary(d)).toEqual(['terminus 5000 ms (line 6) @server.js:5']);
  });

  it('an async function that awaits a literal delay, with logging', () => {
    const d = drainsOf({
      'server.js': `${head}createTerminus(server, {\n  async beforeShutdown() {\n    console.log('draining');\n    await new Promise(function (r) { setTimeout(r, 2000); });\n    await new Promise((r) => setTimeout(r, 3000));\n  },\n});\n`,
    });
    expect(summary(d)).toEqual(['terminus 5000 ms (line 8) @server.js:5']);
  });

  it('a local function named in the option, and timers/promises', () => {
    const d = drainsOf({
      'server.js': `import { setTimeout as sleep } from 'node:timers/promises';\n${head}const wait = async () => { await sleep(4000); };\ncreateTerminus(server, { beforeShutdown: wait });\n`,
    });
    expect(summary(d)).toEqual(['terminus 4000 ms (line 6) @server.js:7']);
  });

  it('a beforeShutdown with no delay is a drain of 0 ms', () => {
    const d = drainsOf({
      'server.js': `${head}createTerminus(server, { beforeShutdown: async () => {} });\n`,
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay).toMatchObject({ state: 'literal', value: { value: 0 } });
  });

  it('createTerminus without a beforeShutdown adds no drain', () => {
    expect(
      drainsOf({
        'server.js': `${head}createTerminus(server, { healthChecks: {}, timeout: 1000 });\n`,
      }),
    ).toEqual([]);
    expect(drainsOf({ 'server.js': `${head}createTerminus(server);\n` })).toEqual([]);
  });

  it('an Express app served through http.createServer(app) is the listening server', () => {
    const d = drainsOf({
      'server.js': [
        "import http from 'node:http';",
        "import express from 'express';",
        "import { createTerminus } from '@godaddy/terminus';",
        'const app = express();',
        'const server = http.createServer(app);',
        'server.listen(8080);',
        'createTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 6000)) });',
      ].join('\n'),
    });
    expect(summary(d)).toEqual(['terminus 6000 ms (line 7) @server.js:7']);
  });

  it('app.listen(...) is a server the search cannot name (as for settings): a terminus on it is unresolved', () => {
    const d = drainsOf({
      'server.js': [
        "import express from 'express';",
        "import { createTerminus } from '@godaddy/terminus';",
        'const app = express();',
        'const server = app.listen(8080);',
        'createTerminus(server, { beforeShutdown: () => new Promise((r) => setTimeout(r, 6000)) });',
      ].join('\n'),
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it.each([
    ['a helper that sleeps', 'beforeShutdown: () => sleep(5000)'],
    [
      'a delay that is not a literal',
      'beforeShutdown: () => new Promise((r) => setTimeout(r, ms))',
    ],
    [
      'a conditional delay',
      'beforeShutdown: async () => { if (a) { await new Promise((r) => setTimeout(r, 5000)); } }',
    ],
    ['a function that is not in the file', 'beforeShutdown: imported'],
    [
      'a callback that does not resolve what it waits for',
      'beforeShutdown: () => new Promise((r) => setTimeout(other, 5000))',
    ],
    [
      'a second argument to setTimeout',
      'beforeShutdown: () => new Promise((r) => setTimeout(r, 5000, 1))',
    ],
    [
      'a call before the delay',
      'beforeShutdown: async () => { await flush(); await new Promise((r) => setTimeout(r, 5000)); }',
    ],
    ['signals that tripcurve does not read', 'signals: ["SIGINT"], beforeShutdown: async () => {}'],
    ['a signal that is not SIGTERM', 'signal: "SIGUSR2", beforeShutdown: async () => {}'],
    ['an option that is not read', 'unknownOption: 1, beforeShutdown: async () => {}'],
  ])('%s is a terminus drain of unresolved duration', (_name, option) => {
    const d = drainsOf({ 'server.js': `${head}createTerminus(server, { ${option} });\n` });
    expect(d).toHaveLength(1);
    expect(d[0]?.kind).toBe('terminus');
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('options that are not an object written in place are unresolved (a beforeShutdown could be in them)', () => {
    const d = drainsOf({ 'server.js': `${head}const opts = {};\ncreateTerminus(server, opts);\n` });
    expect(summary(d)).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('a server that is not the listening one is not tied: unresolved', () => {
    const d = drainsOf({
      'server.js': `${head}const other = http.createServer(() => {});\ncreateTerminus(other, { beforeShutdown: async () => {} });\n`,
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('a createTerminus under a condition is unresolved', () => {
    const d = drainsOf({
      'server.js': `${head}if (process.env.X) { createTerminus(server, { beforeShutdown: async () => {} }); }\n`,
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('two listening servers in the files read: no drain can be tied, so each is unresolved', () => {
    const d = drainsOf({
      'server.js': `${head}createTerminus(server, { beforeShutdown: async () => {} });\nimport './other.js';\n`,
      'other.js': 'import http from "node:http";\nhttp.createServer(() => {}).listen(9090);\n',
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('an alias of createTerminus is a form that is not read', () => {
    const d = drainsOf({
      'server.js': `${head}const t = createTerminus;\nt(server, { beforeShutdown: async () => {} });\n`,
    });
    expect(d.some((x) => x.kind === 'terminus' && x.delay.state === 'unresolved')).toBe(true);
  });
});

describe('a SIGTERM handler', () => {
  const head = `${SERVER}\n`;

  it('waits a literal time, then closes the server', () => {
    const d = drainsOf({
      'server.js': `${head}process.on('SIGTERM', async () => {\n  console.log('bye');\n  await new Promise((r) => setTimeout(r, 4000));\n  server.close();\n});\n`,
    });
    expect(summary(d)).toEqual(['sigterm-handler 4000 ms (line 6) @server.js:4']);
  });

  it('a timer that closes the server later is a delay of its literal time', () => {
    const d = drainsOf({
      'server.js': `${head}process.once('SIGTERM', () => {\n  setTimeout(() => server.close(), 3000);\n});\n`,
    });
    expect(summary(d)).toEqual(['sigterm-handler 3000 ms (line 5) @server.js:4']);
  });

  it('a handler that closes at once is a delay of 0, and a kill timer after the close is no drain', () => {
    const d = drainsOf({
      'server.js': `${head}process.on('SIGTERM', () => {\n  server.close(() => process.exit(0));\n  setTimeout(() => process.exit(1), 10000).unref();\n});\n`,
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay).toMatchObject({ state: 'literal', value: { value: 0 } });
  });

  it('a concise arrow that closes the server is 0, and process.exit counts as a stop', () => {
    expect(
      summary(drainsOf({ 'server.js': `${head}process.on('SIGTERM', () => server.close());\n` })),
    ).toEqual(['sigterm-handler 0 ms (line 4) @server.js:4']);
    expect(
      summary(drainsOf({ 'server.js': `${head}process.on('SIGTERM', () => process.exit(0));\n` })),
    ).toEqual(['sigterm-handler 0 ms (line 4) @server.js:4']);
  });

  it('a handler named in the call and defined in the file', () => {
    const d = drainsOf({
      'server.js': `${head}function stop() { return new Promise((r) => r()); }\nasync function onTerm() { await new Promise((r) => setTimeout(r, 1500)); server.close(); }\nprocess.on('SIGTERM', onTerm);\n`,
    });
    expect(summary(d)).toEqual(['sigterm-handler 1500 ms (line 5) @server.js:6']);
  });

  it('other signals are not drains', () => {
    expect(
      drainsOf({
        'server.js': `${head}process.on('SIGINT', () => { shutdown(); });\nprocess.on('exit', () => {});\n`,
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'a helper before the stop',
      "process.on('SIGTERM', async () => { await drain(); server.close(); });",
    ],
    [
      'a delay that is not a literal',
      "process.on('SIGTERM', async () => { await new Promise((r) => setTimeout(r, MS)); server.close(); });",
    ],
    [
      'a condition before the stop',
      "process.on('SIGTERM', () => { if (ready) { server.close(); } });",
    ],
    [
      'a handler that never stops the server',
      "process.on('SIGTERM', () => { console.log('term'); });",
    ],
    [
      'a kill timer before the stop (a race)',
      "process.on('SIGTERM', () => { setTimeout(() => process.exit(1), 9000); server.close(); });",
    ],
    [
      'a timed stop and a second stop (a race)',
      "process.on('SIGTERM', () => { setTimeout(() => server.close(), 3000); server.close(); });",
    ],
    [
      'a timer that does not close the server',
      "process.on('SIGTERM', () => { setTimeout(() => { flush(); }, 3000); server.close(); });",
    ],
    [
      'a close on another server',
      "const other = require('http').createServer(); process.on('SIGTERM', () => { other.close(); });",
    ],
    ['a handler that is not a function in the file', "process.on('SIGTERM', imported);"],
    ['a registration with the wrong number of arguments', "process.on('SIGTERM');"],
    ['a registration under a condition', "if (x) { process.on('SIGTERM', () => server.close()); }"],
    [
      'a registration in the listen callback',
      "server.on('listening', () => { process.on('SIGTERM', () => server.close()); });",
    ],
    [
      'a signal name that is not written in the code',
      "const sig = 'SIGTERM';\nprocess.on(sig, () => server.close());",
    ],
    [
      'a list of signals',
      "['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => server.close()));",
    ],
    ['an alias of process', "const p = process;\np.on('SIGTERM', () => server.close());"],
    ['process passed to a function', 'register(process);'],
    ['process by a computed key', "process['on']('SIGTERM', () => server.close());"],
    [
      'process reached through globalThis',
      "globalThis.process.on('SIGTERM', () => server.close());",
    ],
    ['process reached through global', "global.process.on('SIGTERM', () => server.close());"],
    [
      'a destructured method of process',
      "const { on } = process;\non('SIGTERM', () => server.close());",
    ],
    ['process taken from require', "require('process').on('SIGTERM', () => server.close());"],
    ['a SIGTERM handler on another object', "emitter.on('SIGTERM', () => server.close());"],
  ])('%s is a drain of unresolved duration', (_name, body) => {
    const d = drainsOf({ 'server.js': `${head}${body}\n` });
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.some((x) => x.delay.state === 'unresolved')).toBe(true);
    expect(d.every((x) => x.kind === 'sigterm-handler')).toBe(true);
  });

  it('a name bound to the process module counts as the process', () => {
    const d = drainsOf({
      'server.js': `${head}import proc from 'node:process';\nproc.on('SIGTERM', () => server.close());\n`,
    });
    expect(summary(d)).toEqual(['sigterm-handler 0 ms (line 5) @server.js:5']);
  });

  it('ordinary use of process is not a gap', () => {
    expect(
      drainsOf({
        'server.js': `${head}const port = Number(process.env.PORT);\nprocess.stdout.write('x');\nprocess.nextTick(() => {});\n`,
      }),
    ).toEqual([]);
  });

  it('two handlers are two drains (how they combine is not read: the resolver says so)', () => {
    const d = drainsOf({
      'server.js': `${head}process.on('SIGTERM', () => server.close());\nprocess.on('SIGTERM', () => { setTimeout(() => server.close(), 2000); });\n`,
    });
    expect(summary(d)).toEqual([
      'sigterm-handler 0 ms (line 4) @server.js:4',
      'sigterm-handler 2000 ms (line 5) @server.js:5',
    ]);
  });
});

describe('hostile source', () => {
  it('thousands of registrations are one unresolved drain, quickly', () => {
    const lines = [SERVER];
    for (let i = 0; i < 5000; i += 1) lines.push("process.on('SIGTERM', () => server.close());");
    const d = drainsOf({ 'server.js': lines.join('\n') });
    expect(d).toHaveLength(1);
    expect(d[0]?.delay.state).toBe('unresolved');
  });

  it('a file that does not parse gives no drain and is reported unchecked, as before', () => {
    const t = makeTree();
    trees.push(t);
    t.write('server.js', 'const = = ;\n process.on(');
    const r = intake({ root: t.root });
    const file = r.files[0] as InputFile;
    const s = readNodeServer(r, file);
    expect(s.drains).toEqual([]);
    expect(s.unchecked).toHaveLength(1);
  });

  it('a big file with many uses of process and one registration is read in linear time', {
    timeout: SCALING_TEST_TIMEOUT_MS,
  }, () => {
    const big = (n: number): string =>
      `${SERVER}\n${Array.from({ length: n }, (_, i) => `const v${i} = process.env.V${i};`).join('\n')}\nprocess.on('SIGTERM', () => server.close());\n`;
    expect(summary(drainsOf({ 'server.js': big(2000) }))).toEqual([
      'sigterm-handler 0 ms (line 2004) @server.js:2004',
    ]);
    const ratio = scalingRatio((n) => {
      drainsOf({ 'server.js': big(n) });
    }, 1000);
    expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
  });

  it('many lightship and terminus mentions are linear too', {
    timeout: SCALING_TEST_TIMEOUT_MS,
  }, () => {
    const many = (n: number): string =>
      `${SERVER}\nimport { createLightship } from 'lightship';\n${Array.from({ length: n }, (_, i) => `const l${i} = createLightship;`).join('\n')}\n`;
    expect(drainsOf({ 'server.js': many(50) }).length).toBeGreaterThan(0);
    const ratio = scalingRatio((n) => {
      drainsOf({ 'server.js': many(n) });
    }, 1000);
    expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
  });
});
