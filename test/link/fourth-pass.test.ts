// Fourth review pass: the arguments of `createServer` are read through an ALLOW-LIST. "No
// setting found" stands for the Node default only if every `createServer` call has an allowed
// form; anything else is UNRESOLVED with one fixed reason. Every gap case below printed PASS
// before the change (LB idle 5 s, so the Node default of 6 s passes).
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');
const REASON = 'the createServer arguments are not in a form tripcurve reads';

function run(files: Record<string, string | null>) {
  const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5, ...files });
  return { f: t1Of(result), result };
}
const H = "(_q: unknown, r: { end(s: string): void }) => r.end('ok')";
const head = "import http from 'node:http';\nimport { createServer } from 'node:http';\n";
const prog = (body: string) => `${head}${body}\n`;
const gap = (body: string) => {
  const { f } = run({ 'src/server.ts': prog(body) });
  expect(f.kind).toBe('UNRESOLVED');
  expect(f.headline).toContain(REASON);
};
const pass = (files: Record<string, string>) => {
  const { f } = run(files);
  expect(f.kind).toBe('PASS');
};

describe('J1: a call result as an argument', () => {
  it.each([
    [
      'createServer(mk(), h)',
      `function mk() { return { keepAliveTimeout: 1 }; }\nhttp.createServer(mk(), ${H}).listen(8080);`,
    ],
    [
      'const opts = mk(); createServer(opts, h)',
      `function mk() { return { keepAliveTimeout: 1 }; }\nconst opts = mk();\nhttp.createServer(opts, ${H}).listen(8080);`,
    ],
    [
      'createServer(mk())',
      'function mk() { return { keepAliveTimeout: 1 }; }\ncreateServer(mk()).listen(8080);',
    ],
    [
      'const opts = mk(); createServer(opts)',
      'function mk() { return { keepAliveTimeout: 1 }; }\nconst opts = mk();\ncreateServer(opts).listen(8080);',
    ],
  ])('%s', (_n, body) => gap(body));
});

describe('J2: a single non-literal argument is not assumed to be the handler', () => {
  it('createServer(app.callback()) is UNRESOLVED with the fixed reason and no assumption', () => {
    const { f, result } = run({
      'src/server.ts': prog(
        "import Koa from 'koa';\nconst app = new Koa();\nhttp.createServer(app.callback()).listen(8080);",
      ),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(REASON);
    expect(result.assumptions.every((a) => !a.text.includes('handler'))).toBe(true);
  });
  it('createServer(handlerFromElsewhere) is UNRESOLVED', () => {
    gap("import { handler } from 'some-package';\nhttp.createServer(handler).listen(8080);");
  });
});

describe('J3: a const object that reaches createServer by a derived value', () => {
  const pre = 'const extra = load();\nconst base = {};\nObject.assign(base, extra);\n';
  it.each([
    ['a spread', 'const opts = base;\ncreateServer(...[opts]).listen(8080);'],
    ['opts.base', 'const opts = { base };\ncreateServer(opts.base).listen(8080);'],
    ['arr[0]', 'const arr = [base];\ncreateServer(arr[0]).listen(8080);'],
    ['structuredClone', 'createServer(structuredClone(base)).listen(8080);'],
    ['JSON round trip', 'createServer(JSON.parse(JSON.stringify(base))).listen(8080);'],
    ['Object.create', 'createServer(Object.create(base)).listen(8080);'],
    ['holder.cfg', 'const holder = { cfg: base };\ncreateServer(holder.cfg).listen(8080);'],
    ['a call f()', 'const f = () => base;\ncreateServer(f()).listen(8080);'],
    ['??', 'createServer(base ?? {}).listen(8080);'],
    ['a conditional', 'createServer(cond() ? base : {}).listen(8080);'],
    ['export const shared = base', 'export const shared = base;\ncreateServer(base).listen(8080);'],
    ['globalThis.cfg = base', 'globalThis.cfg = base;\ncreateServer(base).listen(8080);'],
  ])('%s', (_n, body) => gap(pre + body));
});

describe('the .constructor alias', () => {
  it('const F = (() => {}).constructor is a gap', () => {
    const { f } = run({
      'src/server.ts': prog(
        `const server = http.createServer(${H});\nconst F = (() => {}).constructor;\nF('s', 's.keepAliveTimeout = 1')(server);\nserver.listen(8080);`,
      ),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('a setting may be written in a form that is not read');
  });
  it('this.constructor is not flagged', () => {
    pass({
      'src/server.ts': prog(
        `class A { n() { return this.constructor.name; } }\nhttp.createServer(${H}).listen(8080);`,
      ),
    });
  });
});

describe('one reference only for an options object', () => {
  it('a const options object used once, with property reads, is read as today (PASS)', () => {
    pass({
      'src/server.ts': prog(
        `const opts = { requestTimeout: 1000 };\nconsole.log(opts.requestTimeout);\nhttp.createServer(opts, ${H}).listen(8080);`,
      ),
    });
  });
  it.each([
    ['printed elsewhere', 'const opts = {};\nconsole.log(opts);\ncreateServer(opts).listen(8080);'],
    ['a property write', 'const opts = {};\nopts.x = 1;\ncreateServer(opts).listen(8080);'],
    [
      'used twice',
      'const opts = {};\ncreateServer(opts).listen(8080);\ncreateServer(opts).listen(8081);',
    ],
    ['a spread inside', 'const opts = { ...load() };\ncreateServer(opts).listen(8080);'],
    ['a spread in place', 'createServer({ ...load() }).listen(8080);'],
    ['a computed key in place', "createServer({ ['keepAlive' + 'Timeout']: 1 }).listen(8080);"],
    ['three arguments', `createServer({}, ${H}, 1).listen(8080);`],
    ['a spread argument', 'createServer(...args()).listen(8080);'],
    ['a handler first and options second', `createServer(${H}, {}).listen(8080);`],
  ])('%s is a gap', (_n, body) => gap(body));
});

describe('controls that stay as they were', () => {
  it('the plain demo passes', () => pass({}));
  it('a handler declared as a const arrow', () => {
    pass({
      'src/server.ts': prog(`const handler = ${H};\nhttp.createServer(handler).listen(8080);`),
    });
  });
  it('a handler declared with function', () => {
    pass({
      'src/server.ts': prog(
        "function handler(_q: unknown, r: { end(s: string): void }) { r.end('ok'); }\nhttp.createServer(handler).listen(8080);",
      ),
    });
  });
  it('createServer() with a later server.on(request)', () => {
    pass({
      'src/server.ts': prog(
        "const server = http.createServer();\nserver.on('request', (_q, r) => r.end('ok'));\nserver.listen(8080);",
      ),
    });
  });
  it('createServer({ keepAliveTimeout: 70000 }, handler) is UNRESOLVED by the explicit-setting rule', () => {
    const { f } = run({
      'src/server.ts': prog(`http.createServer({ keepAliveTimeout: 70000 }, ${H}).listen(8080);`),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('explicit');
  });
  it.each([
    ['export default express()', "import express from 'express';\nexport default express();\n"],
    [
      'export default app',
      "import express from 'express';\nconst app = express();\nexport default app;\n",
    ],
    ['export const app', "import express from 'express';\nexport const app = express();\n"],
    [
      'module.exports = app',
      "const express = require('express');\nconst app = express();\nmodule.exports = app;\n",
    ],
  ])('an Express app imported from a local file: %s', (_n, appText) => {
    const named = appText.includes('export const app');
    pass({
      'src/server.ts': prog(
        `import ${named ? '{ app }' : 'app'} from './app.js';\nhttp.createServer(app).listen(8080);`,
      ),
      'src/app.ts': appText,
    });
  });
  it('an imported value that is not an Express app is a gap', () => {
    const { f } = run({
      'src/server.ts': prog("import app from './app.js';\nhttp.createServer(app).listen(8080);"),
      'src/app.ts': 'export default function app() {}\n',
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(REASON);
  });
});

// Confirmation pass K1: a handler identifier that is reassigned (or not `const`) could hold an
// options object by the time `createServer` runs, so it is not an allowed handler form.
describe('K1: a handler identifier that is reassigned is not an allowed handler', () => {
  it.each([
    [
      'let h = arrow; h = {options}',
      `let h = ${H};\nh = { keepAliveTimeout: 1 };\ncreateServer(h).listen(8080);`,
    ],
    [
      'let h = arrow; h = mk()',
      `function mk() { return {}; }\nlet h = ${H};\nh = mk();\ncreateServer(h).listen(8080);`,
    ],
    [
      'var h = arrow; h = {options}',
      `var h = ${H};\nh = { keepAliveTimeout: 1 };\ncreateServer(h).listen(8080);`,
    ],
    [
      'function h; h = {options}',
      `function h(_q: unknown, r: { end(s: string): void }) { r.end('ok'); }\n// @ts-ignore\nh = { keepAliveTimeout: 1 };\ncreateServer(h).listen(8080);`,
    ],
    ['let h = arrow, never reassigned', `let h = ${H};\ncreateServer(h).listen(8080);`],
    [
      'h ||= {options}',
      `let h: any = undefined;\nh ||= { keepAliveTimeout: 1 };\ncreateServer(h).listen(8080);`,
    ],
    [
      'destructuring target',
      `let h: any = ${H};\n[h] = [{ keepAliveTimeout: 1 }];\ncreateServer(h).listen(8080);`,
    ],
  ])('%s', (_n, body) => gap(body));

  it('a const arrow handler that is never reassigned still passes', () => {
    pass({ 'src/server.ts': prog(`const h = ${H};\ncreateServer(h).listen(8080);`) });
  });
  it('a function declaration that is never reassigned still passes', () => {
    pass({
      'src/server.ts': prog(
        "function h(_q: unknown, r: { end(s: string): void }) { r.end('ok'); }\ncreateServer(h).listen(8080);",
      ),
    });
  });
});
