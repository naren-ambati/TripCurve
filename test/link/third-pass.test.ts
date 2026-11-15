// Third review pass: alias spellings of the setter forms (N3a), the Object.assign and
// NODE_OPTIONS costs. Each gap case printed PASS before the fix.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');
const SETTING_FORM = 'a setting may be written in a form that is not read';

function run(files: Record<string, string | null>) {
  return t1Of(analyseFiles({ 'k8s/ingress.yaml': ING5, ...files }).result);
}
const prog = (body: string, head = '') =>
  `import http from 'node:http';\n${head}\nconst server = http.createServer();\n${body}\nserver.listen(8080);\n`;
function nodeOptions(value: string): string {
  return withEnv(
    webYaml,
    '          command: ["node", "src/server.ts"]\n',
    `          command: ["node", "src/server.ts"]\n          env:\n            - name: NODE_OPTIONS\n              value: ${JSON.stringify(value)}\n`,
  );
}

describe('N3a: alias spellings and references to the setter forms', () => {
  it.each([
    ['const R = Reflect', "const R = Reflect;\nR.set(server, 'keepAliveTimeout', 1);"],
    ['const { set } = Reflect', "const { set } = Reflect;\nset(server, 'keepAliveTimeout', 1);"],
    ['globalThis.Reflect.set', "globalThis.Reflect.set(server, 'keepAliveTimeout', 1);"],
    [
      'const O = Object; O.defineProperty',
      "const O = Object;\nO.defineProperty(server, 'keepAliveTimeout', { value: 1 });",
    ],
    [
      "Object['defineProperty']",
      "Object['defineProperty'](server, 'keepAliveTimeout', { value: 1 });",
    ],
    ['const A = Object.assign', 'const o = load();\nconst A = Object.assign;\nA(server, o);'],
    ['const O = Object; O.assign', 'const o = load();\nconst O = Object;\nO.assign(server, o);'],
    ['const e = eval', "const e = eval;\ne('1');"],
    ['globalThis.eval', "globalThis.eval('1');"],
    ['(0, eval)', "(0, eval)('1');"],
    ['const F = Function; new F', "const F = Function;\nnew F('return 1')();"],
    ['.constructor(...)', "(() => {}).constructor('return 1')();"],
    ['vm.runInThisContext', "const vm = require('vm');\nvm.runInThisContext('1');"],
    ['import of node:vm', "import { runInThisContext } from 'node:vm';\nrunInThisContext('1');"],
    ["setTimeout('string code')", "setTimeout('server.keepAliveTimeout = 1', 10);"],
    ['setTimeout with a concatenated string', "setInterval('a' + 'b', 10);"],
    ['Object.setPrototypeOf', 'Object.setPrototypeOf(server, { keepAliveTimeout: 1 });'],
    ['a local variable named Function', 'const Function = 1;'],
  ])('%s is a gap', (_n, body) => {
    const f = run({ 'src/server.ts': prog(body) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(SETTING_FORM);
  });

  it('controls: ordinary timers and a plain object write stay PASS', () => {
    const f = run({
      'src/server.ts': prog(
        'setTimeout(() => {}, 10);\nsetInterval(tick, 10);\nfunction tick() {}',
      ),
    });
    expect(f.kind).toBe('PASS');
  });
});

describe('Cost 1: Object.assign flags only a target that could be the server', () => {
  it('a local const object literal is not the server: no gap', () => {
    const f = run({
      'src/server.ts': prog(
        'const config = { a: 1 };\nconst opts = load();\nObject.assign(config, opts);',
      ),
    });
    expect(f.kind).toBe('PASS');
  });
  it.each([
    ['the server itself', 'const o = load();\nObject.assign(server, o);'],
    ['a parameter', 'function f(target: object, o: object) { Object.assign(target, o); }'],
    ['an imported binding', "import { shared } from 'lib';\nObject.assign(shared, load());"],
    ['a call result', 'Object.assign(getTarget(), load());'],
    ['a property access', 'const x = { y: {} };\nObject.assign(x.y, load());'],
    ['a let variable', 'let c = {};\nObject.assign(c, load());'],
  ])('%s is a gap', (_n, body) => {
    const f = run({ 'src/server.ts': prog(body) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(SETTING_FORM);
  });
});

describe('Cost 2: NODE_OPTIONS flags only the options Node loads code with', () => {
  it.each([
    ['--report-on-signal', '--report-on-signal'],
    ['--report-dir', '--report-dir=/tmp'],
    ['--redirect-warnings', '--redirect-warnings=/tmp/w'],
    ['--max-old-space-size', '--max-old-space-size=100'],
  ])('%s is not code-loading: PASS', (_n, value) => {
    expect(run({ 'k8s/web.yaml': nodeOptions(value) }).kind).toBe('PASS');
  });
  it.each([
    '-r dotenv/config',
    '--require=dotenv/config',
    '--import tsx',
    '--loader x',
    '--experimental_loader=x',
    '--experimental-loader x',
    '--env-file=.env',
    '--env_file_if_exists=.env',
    'require=dotenv/config',
    '--REQUIRE dotenv/config',
    '"--require" dotenv/config',
  ])('%s is a gap (a superset of what Node accepted)', (value) => {
    expect(run({ 'k8s/web.yaml': nodeOptions(value) }).kind).toBe('UNRESOLVED');
  });
});

describe('Hole A and D: the options object of createServer is part of the server', () => {
  const head = "import http from 'node:http';\n";
  const tail =
    "const server = http.createServer(opts, (_q, r) => r.end('ok'));\nserver.listen(8080);\n";
  const gap = (code: string) => {
    const f = run({ 'src/server.ts': code });
    expect(f.kind).toBe('UNRESOLVED');
  };

  it('A: Object.assign(opts, extra) before createServer(opts) is a gap', () => {
    gap(
      `${head}const extra = JSON.parse(process.env.X ?? '{}');\nconst opts = {};\nObject.assign(opts, extra);\n${tail}`,
    );
  });
  it('D: a computed write on opts is a gap', () => {
    gap(`${head}const opts = {};\nconst k = 'keepAlive' + 'Timeout';\nopts[k] = 1000;\n${tail}`);
  });
  it('an alias is mutated: const o2 = opts; Object.assign(o2, x)', () => {
    gap(`${head}const opts = {};\nconst o2 = opts;\nObject.assign(o2, load());\n${tail}`);
  });
  it('an alias is written with a computed key', () => {
    gap(`${head}const opts = {};\nconst o2 = opts;\no2[key()] = 1;\n${tail}`);
  });
  it('the alias is what createServer gets', () => {
    gap(`${head}const base = {};\nconst opts = base;\nObject.assign(base, load());\n${tail}`);
  });
  it('mutated after createServer is called (conservative)', () => {
    gap(
      `${head}const opts = {};\nconst server = http.createServer(opts);\nObject.assign(opts, load());\nserver.listen(8080);\n`,
    );
  });
  it('opts passed to a non-local function', () => {
    gap(`${head}import { tune } from 'lib';\nconst opts = {};\ntune(opts);\n${tail}`);
  });
  it('opts wrapped in an object passed to a non-local function', () => {
    gap(`${head}import { tune } from 'lib';\nconst opts = {};\ntune({ opts });\n${tail}`);
  });

  it('already correct and kept: a spread, and a non-literal property write', () => {
    gap(
      `${head}const extra = load();\nconst server = http.createServer({ ...extra }, (_q, r) => r.end('ok'));\nserver.listen(8080);\n`,
    );
    gap(`${head}const opts = {};\nopts.keepAliveTimeout = Number(process.env.K);\n${tail}`);
  });

  it('control: a local const object that never reaches createServer is still exempt', () => {
    const f = run({
      'src/server.ts': `${head}const config = {};\nObject.assign(config, load());\nconst server = http.createServer((_q, r) => r.end('ok'));\nserver.listen(8080);\n`,
    });
    expect(f.kind).toBe('PASS');
  });
  it('control: an untouched options object is fine', () => {
    const f = run({
      'src/server.ts': `${head}const opts = {};\n${tail}`,
    });
    expect(f.kind).toBe('PASS');
  });
});
