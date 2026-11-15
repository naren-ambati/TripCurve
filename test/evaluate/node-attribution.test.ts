// B3: an explicit setting counts only when it is bound to the listening server
// and written on an unconditional path before `listen`. Each case below was reproduced by the
// reviewer (scratchpad review-b3/fx): before the fix every UNRESOLVED case here printed PASS.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of } from '../support/analyse.js';

afterEach(cleanupTrees);

const HEAD = "import http from 'node:http';\n";
const MAKE = "const server = http.createServer((_q, r) => { r.end('ok'); });\n";

function t1(body: string) {
  return t1Of(
    analyseFiles({ 'src/server.ts': `${HEAD}${MAKE}${body}` }, { base: DEMO_FILES }).result,
  );
}

const UNATTRIBUTED =
  'a keepAliveTimeout is written on an object tripcurve cannot tie to the listening server';
const NOT_BEFORE =
  'the setting is not shown to be written before listen on an unconditional path, and only a value set before listen is measured';

describe('a setting on another object is not attributed to the listening server', () => {
  const cases: [string, string][] = [
    [
      'another server',
      'const other = http.createServer(() => {});\nother.keepAliveTimeout = 65000;\nserver.listen(8080);\n',
    ],
    [
      'an unrelated object',
      'const agent: any = {};\nagent.keepAliveTimeout = 65000;\nserver.listen(8080);\n',
    ],
    [
      'another server through its options (never listened)',
      'const other = http.createServer({ keepAliveTimeout: 65000 }, () => {});\nserver.listen(8080);\n',
    ],
    [
      'another server through its options (both listened)',
      'const other = http.createServer({ keepAliveTimeout: 65000 }, () => {});\nserver.listen(1);\nother.listen(2);\n',
    ],
    [
      'an alias of the server',
      'const s: any = server;\ns.keepAliveTimeout = 65000;\nserver.listen(8080);\n',
    ],
    [
      'Object.assign on another object',
      'const agent: any = {};\nObject.assign(agent, { keepAliveTimeout: 65000 });\nserver.listen(8080);\n',
    ],
  ];
  it.each(cases)('%s: UNRESOLVED, never PASS', (_name, body) => {
    const f = t1(body);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${UNATTRIBUTED}`);
  });
});

describe('a setting on a conditional, looped or dead path is not an unconditional write before listen', () => {
  const cases: [string, string][] = [
    ['if', 'if (process.env.PROD) { server.keepAliveTimeout = 65000; }\nserver.listen(8080);\n'],
    ['&&', 'process.env.PROD && (server.keepAliveTimeout = 65000);\nserver.listen(8080);\n'],
    [
      '?:',
      'process.env.PROD ? (server.keepAliveTimeout = 65000) : undefined;\nserver.listen(8080);\n',
    ],
    ['try', 'try { server.keepAliveTimeout = 65000; } catch {}\nserver.listen(8080);\n'],
    ['for', 'for (const x of []) { server.keepAliveTimeout = 65000; }\nserver.listen(8080);\n'],
    ['if (false)', 'if (false) { server.keepAliveTimeout = 65000; }\nserver.listen(8080);\n'],
    [
      'both branches equal',
      'if (process.env.PROD) { server.keepAliveTimeout = 65000; } else { server.keepAliveTimeout = 65000; }\nserver.listen(8080);\n',
    ],
    [
      'switch',
      "switch (process.env.X) { case 'a': server.keepAliveTimeout = 65000; }\nserver.listen(8080);\n",
    ],
    [
      'an if without braces',
      'if (process.env.PROD) server.keepAliveTimeout = 65000;\nserver.listen(8080);\n',
    ],
    [
      'a class constructor',
      'class A {\n  constructor() {\n    server.keepAliveTimeout = 65000;\n  }\n}\nnew A();\nserver.listen(8080);\n',
    ],
    [
      'a function that is never called',
      'function main() {\n  server.keepAliveTimeout = 65000;\n  server.listen(8080);\n}\n',
    ],
    [
      'a listen that is itself conditional',
      'server.keepAliveTimeout = 65000;\nif (process.env.PROD) { server.listen(8080); }\n',
    ],
  ];
  it.each(cases)('%s: UNRESOLVED, never PASS', (_name, body) => {
    const f = t1(body);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toBe(`idle close not established: ${NOT_BEFORE}`);
  });
});

describe('controls: the plain forms still resolve', () => {
  it('a plain assignment before listen', () => {
    expect(t1('server.keepAliveTimeout = 65000;\nserver.listen(8080);\n').kind).toBe('PASS');
  });
  it('a function the file calls at the top level, with the assignment and the listen in its body', () => {
    expect(
      t1(
        'function main() {\n  server.keepAliveTimeout = 65000;\n  server.listen(8080);\n}\nmain();\n',
      ).kind,
    ).toBe('PASS');
  });
  it('options of the server that listens', () => {
    const body =
      'const s2 = http.createServer({ keepAliveTimeout: 65000 }, () => {});\ns2.listen(8080);\n';
    const f = t1Of(
      analyseFiles({ 'src/server.ts': `${HEAD}${body}` }, { base: DEMO_FILES }).result,
    );
    expect(f.kind).toBe('PASS');
  });
  it('createServer(options).listen() in one chain', () => {
    const f = t1Of(
      analyseFiles(
        {
          'src/server.ts': `${HEAD}http.createServer({ keepAliveTimeout: 65000 }, () => {}).listen(8080);\n`,
        },
        { base: DEMO_FILES },
      ).result,
    );
    expect(f.kind).toBe('PASS');
  });
});
