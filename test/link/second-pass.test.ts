// Second review pass, findings N1 to N6. Each case went through the real pipeline and
// printed PASS (or a clean-looking result) before the fix. Honesty rule: "no setting found"
// is evidence for the Node default only when nothing the files show could have set it.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const serverTs = DEMO_FILES['src/server.ts'] as string;
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');

const ENV_FILE = 'environment file not read';
const PRE_SCRIPT = 'an npm pre-script runs code before the server that was not read';
const SETTING_FORM = 'a setting may be written in a form that is not read';
const PRELOAD = 'code preloaded before the entry was not read';

function container(command: readonly string[], extra = ''): string {
  return withEnv(
    webYaml,
    '          command: ["node", "src/server.ts"]\n',
    `          command: ${JSON.stringify(command)}\n${extra}`,
  );
}
function run(files: Record<string, string | null>) {
  return t1Of(analyseFiles({ 'k8s/ingress.yaml': ING5, ...files }).result);
}
function nodeOptions(value: string): string {
  return container(
    ['node', 'src/server.ts'],
    `          env:\n            - name: NODE_OPTIONS\n              value: ${JSON.stringify(value)}\n`,
  );
}

describe('N1: --env-file can supply NODE_OPTIONS from a file that is not read', () => {
  it.each([
    ['--env-file=.env', ['node', '--env-file=.env', 'src/server.ts']],
    ['--env-file .env', ['node', '--env-file', '.env', 'src/server.ts']],
    ['--env-file-if-exists=.env', ['node', '--env-file-if-exists=.env', 'src/server.ts']],
    ['--env-file-if-exists .env', ['node', '--env-file-if-exists', '.env', 'src/server.ts']],
  ])('%s in the command is a gap', (_f, command) => {
    const f = run({ 'k8s/web.yaml': container(command) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(ENV_FILE);
  });

  it('in args', () => {
    const web = withEnv(
      container(['node']),
      '          command: ["node"]\n',
      '          command: ["node"]\n          args: ["--env-file=.env", "src/server.ts"]\n',
    );
    expect(run({ 'k8s/web.yaml': web }).headline).toContain(ENV_FILE);
  });

  it('in an npm script', () => {
    const f = run({
      'k8s/web.yaml': container(['npm', 'start']),
      'package.json': '{"scripts":{"start":"node --env-file=.env src/server.ts"}}',
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(ENV_FILE);
  });

  it('in NODE_OPTIONS', () => {
    const f = run({ 'k8s/web.yaml': nodeOptions('--env-file=.env') });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(ENV_FILE);
  });
});

describe('N2: an npm pre-script runs code before the server', () => {
  const start = container(['npm', 'start']);
  const pkg = (scripts: Record<string, string>) => `${JSON.stringify({ scripts })}\n`;

  it('prestart for npm start is a gap', () => {
    const f = run({
      'k8s/web.yaml': start,
      'package.json': pkg({ prestart: 'node tune.js', start: 'node src/server.ts' }),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRE_SCRIPT);
  });

  it.each(['run', 'run-script'])('pre<name> for npm %s <name> is a gap', (verb) => {
    const f = run({
      'k8s/web.yaml': container(['npm', verb, 'serve']),
      'package.json': pkg({ preserve: 'node tune.js', serve: 'node src/server.ts' }),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(PRE_SCRIPT);
  });

  it('a post-script runs after the server stops and is not a gap', () => {
    const f = run({
      'k8s/web.yaml': start,
      'package.json': pkg({ poststart: 'node x.js', start: 'node src/server.ts' }),
    });
    expect(f.kind).toBe('PASS');
  });

  it('a pre-script of another script is not a gap', () => {
    const f = run({
      'k8s/web.yaml': start,
      'package.json': pkg({ prebuild: 'node x.js', start: 'node src/server.ts' }),
    });
    expect(f.kind).toBe('PASS');
  });
});

describe('N3: setter forms that are neither read nor flagged', () => {
  const prog = (body: string) =>
    `import http from 'node:http';\nconst server = http.createServer();\n${body}\nserver.listen(8080);\n`;
  it.each([
    ['Object.assign with a non-literal source', 'const o = load();\nObject.assign(server, o);'],
    ['Reflect.set', "Reflect.set(server, 'keepAliveTimeout', 1);"],
    ['Object.defineProperty', "Object.defineProperty(server, 'keepAliveTimeout', { value: 1 });"],
    [
      'Object.defineProperties',
      'Object.defineProperties(server, { keepAliveTimeout: { value: 1 } });',
    ],
    ['a computed member write', "const k = 'keepAliveTimeout';\nserver[k] = 1;"],
    ['eval', "eval('1');"],
    ['new Function', "new Function('return 1')();"],
  ])('%s is a gap', (_n, body) => {
    const f = run({ 'src/server.ts': prog(body) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(SETTING_FORM);
  });

  it('eval in a read file other than the entry is a gap too', () => {
    const f = run({
      'src/server.ts': `import './other.js';\n${serverTs}`,
      'src/other.ts': "eval('1');\n",
    });
    expect(f.headline).toContain(SETTING_FORM);
  });

  it('controls: Object.assign into a literal and an array write are not the server', () => {
    const f = run({
      'src/server.ts': prog('const a = {};\nObject.assign({}, a);\nconst xs = [];\nxs[0] = 1;'),
    });
    expect(f.kind).toBe('PASS');
  });
});

describe('N4: NODE_OPTIONS quoting and spellings', () => {
  it.each([
    ['a quoted flag', '--max-old-space-size=100 "--require" ./x.js'],
    ['single quotes', "--max-old-space-size=100 '--require' ./x.js"],
    ['a backslash', '--max-old-space-size=100 --require\\ ./x.js'],
    ['no leading dashes', 'require=./x.js'],
    ['underscores', '--experimental_loader=x'],
    ['--env_file with underscores', '--env_file=.env'],
  ])('%s is a gap', (_n, value) => {
    const f = run({ 'k8s/web.yaml': nodeOptions(value) });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toMatch(new RegExp(`${PRELOAD}|${ENV_FILE}|NODE_OPTIONS`));
  });

  it('control: options that do not preload stay PASS', () => {
    const f = run({ 'k8s/web.yaml': nodeOptions('--max-old-space-size=100 --enable-source-maps') });
    expect(f.kind).toBe('PASS');
  });
});

describe('N5: conflicting class signals', () => {
  const legacy = (cls: string) =>
    withEnv(ING5, '  annotations:\n', `  annotations:\n    kubernetes.io/ingress.class: ${cls}\n`);
  it('legacy alb with ingressClassName nginx is UNRESOLVED, not an ALB read', () => {
    const f = run({
      'k8s/ingress.yaml': withEnv(
        legacy('alb'),
        'ingressClassName: alb',
        'ingressClassName: nginx',
      ),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('the Ingress names two different classes');
  });
  it('legacy nginx with ingressClassName alb is the same', () => {
    const f = run({ 'k8s/ingress.yaml': legacy('nginx') });
    expect(f.headline).toContain('the Ingress names two different classes');
  });
  it('control: the same class twice is fine', () => {
    expect(run({ 'k8s/ingress.yaml': legacy('alb') }).kind).toBe('PASS');
  });
});

describe('N6: the command path is matched the way a Linux container matches it', () => {
  it('a different case does not link', () => {
    const f = run({
      'k8s/web.yaml': withEnv(webYaml, '"src/server.ts"', '"SRC/server.ts"'),
    });
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('source not linked');
  });
  it('a different case in the file name does not link', () => {
    const f = run({
      'k8s/web.yaml': withEnv(webYaml, '"src/server.ts"', '"src/Server.ts"'),
    });
    expect(f.headline).toContain('source not linked');
  });
  it('a trailing slash does not link', () => {
    const f = run({
      'k8s/web.yaml': withEnv(webYaml, '"src/server.ts"', '"src/server.ts/"'),
    });
    expect(f.headline).toContain('source not linked');
  });
  it('control: the exact path links', () => {
    expect(run({}).kind).toBe('PASS');
  });
});
