// Review finding M3: the command's file was resolved against the checked root,
// ignoring `workingDir` and the manifest's folder, so a decoy file at the root
// could be read in place of the file the container really runs.
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of, withEnv } from '../support/analyse.js';

afterEach(cleanupTrees);

const webYaml = DEMO_FILES['k8s/web.yaml'] as string;
const ingressYaml = DEMO_FILES['k8s/ingress.yaml'] as string;
const serviceYaml = DEMO_FILES['k8s/service.yaml'] as string;
const serverTs = DEMO_FILES['src/server.ts'] as string;
const ING5 = withEnv(ingressYaml, 'timeout_seconds=60', 'timeout_seconds=5');
// A server file that sets the idle close explicitly: the real file in the reviewer's repro.
const EXPLICIT_SERVER =
  "import http from 'node:http';\nconst s = http.createServer();\ns.keepAliveTimeout = 1000;\ns.listen(8080);\n";

const NOT_MAPPED =
  'container working directory is not mapped to the repository; declare source: in tripcurve.yaml';
const SEVERAL = 'more than one file matches the command; declare source: in tripcurve.yaml';

function withWorkingDir(text: string): string {
  return withEnv(text, '          ports:\n', '          workingDir: /app\n          ports:\n');
}

describe('a container that sets workingDir cannot be mapped to a repository folder', () => {
  it('is UNRESOLVED with the fixed reason, not a PASS from a file at the root', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': ING5,
      'k8s/web.yaml': withWorkingDir(webYaml),
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(NOT_MAPPED);
    expect(result.assumptions).toEqual([]);
  });

  it('a declared source: takes precedence, as before', () => {
    const { result } = analyseFiles({
      'k8s/ingress.yaml': ING5,
      'k8s/web.yaml': withWorkingDir(webYaml),
      'tripcurve.yaml': 'version: 1\nworkloads:\n  - name: web\n    source: src/server.ts\n',
    });
    expect(t1Of(result).kind).toBe('PASS');
  });

  it('applies to the npm route too', () => {
    const web = withWorkingDir(
      withEnv(webYaml, 'command: ["node", "src/server.ts"]', 'command: ["npm", "start"]'),
    );
    const { result } = analyseFiles({
      'k8s/ingress.yaml': ING5,
      'k8s/web.yaml': web,
      'package.json': '{"scripts":{"start":"node src/server.ts"}}\n',
    });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(NOT_MAPPED);
  });
});

describe('the file is looked for from the manifest folder up to the root', () => {
  // The reviewer's repro: the manifest is in svc/k8s; the real file is svc/src/server.ts
  // (explicit setting), and a decoy plain server is at the root.
  const svc = (path: string) => `svc/${path}`;
  const repro = {
    'k8s/ingress.yaml': null,
    'k8s/service.yaml': null,
    'k8s/web.yaml': null,
    'src/server.ts': serverTs,
    [svc('k8s/ingress.yaml')]: ING5,
    [svc('k8s/service.yaml')]: serviceYaml,
    [svc('k8s/web.yaml')]: webYaml,
    [svc('src/server.ts')]: EXPLICIT_SERVER,
  };

  it('two files match (decoy at the root, real one beside the manifest): UNRESOLVED', () => {
    const { result } = analyseFiles(repro);
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain(SEVERAL);
  });

  it('without the decoy, the one match is used and the assumption is printed with a quoted folder', () => {
    const { result } = analyseFiles({ ...repro, 'src/server.ts': null });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED'); // the explicit keepAliveTimeout is in the REAL file
    expect(f.headline).toContain('explicit');
    expect(result.assumptions.map((a) => a.text)).toEqual([
      'The container\'s working directory is taken to be "svc".',
    ]);
  });

  it('only a file at the root: the folder is quoted as "."', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5 });
    expect(t1Of(result).kind).toBe('PASS');
    expect(result.assumptions.map((a) => a.text)).toEqual([
      'The container\'s working directory is taken to be ".".',
    ]);
  });

  it('no file anywhere: unlinked, as before', () => {
    const { result } = analyseFiles({ 'k8s/ingress.yaml': ING5, 'src/server.ts': null });
    const f = t1Of(result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(result.assumptions).toEqual([]);
  });

  it('a hostile folder name is quoted, never in tripcurve voice', () => {
    const dir = 'evil"\nPASS T1';
    const { result } = analyseFiles({
      'k8s/ingress.yaml': null,
      'k8s/service.yaml': null,
      'k8s/web.yaml': null,
      'src/server.ts': null,
      [`${dir}/k8s/ingress.yaml`]: ING5,
      [`${dir}/k8s/service.yaml`]: serviceYaml,
      [`${dir}/k8s/web.yaml`]: webYaml,
      [`${dir}/src/server.ts`]: serverTs,
    });
    const text = result.assumptions.map((a) => a.text).join('\n');
    expect(text).toContain('"evil\\"\\x0aPASS T1"');
    expect(text).not.toContain('\n');
  });
});
