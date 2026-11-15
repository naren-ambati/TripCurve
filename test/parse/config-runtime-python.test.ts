// `runtime.gunicorn` and `runtime.uvicorn` declarations (maintainer decision 2026-11-11): the same shape
// and rules as `runtime.node`, and a declaration that names zero or two workloads is the config-error case error.
import { afterEach, describe, expect, it } from 'vitest';
import { DECLARATION_KEYS, readConfig } from '../../src/parse/config/index.js';
import { intake } from '../../src/parse/intake/index.js';
import { analyseFiles, cleanupTrees, DEMO_FILES } from '../support/analyse.js';
import { txt } from '../support/render.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
  cleanupTrees();
});

function read(text: string) {
  const t = makeTree();
  trees.push(t);
  t.write('tripcurve.yaml', text);
  return readConfig(intake({ root: t.root }));
}
const errs = (r: ReturnType<typeof read>) =>
  r.configErrors.map((e) => `${e.line}|${e.reasonCode}|${txt(e.key)}`);

describe('the config reader', () => {
  it('knows the two new keys', () => {
    expect(DECLARATION_KEYS).toEqual([
      'longest_request_s',
      'drain.in_process_s',
      'runtime.node',
      'runtime.gunicorn',
      'runtime.uvicorn',
    ]);
  });

  it('reads each as a declared text value with its line, together with runtime.node', () => {
    const r = read(
      'version: 1\nworkloads:\n  - name: api\n    runtime:\n      node: "22.23"\n      gunicorn: "26.2.0"\n      uvicorn: "0.54.0"\n',
    );
    expect(errs(r)).toEqual([]);
    expect(
      r.declarations.map(
        (d) =>
          `${d.key}|${typeof d.value.value === 'object' ? txt(d.value.value) : d.value.value}|${d.line}|${d.value.basis}`,
      ),
    ).toEqual([
      'runtime.node|22.23|5|declared',
      'runtime.gunicorn|26.2.0|6|declared',
      'runtime.uvicorn|0.54.0|7|declared',
    ]);
  });

  it('a bare number is refused (26.10 would be 26.1), like runtime.node', () => {
    const r = read('version: 1\nworkloads:\n  - name: api\n    runtime:\n      gunicorn: 26.2\n');
    expect(errs(r)).toEqual(['5|bad-value|workloads[0].runtime.gunicorn']);
  });

  it('an unknown key under runtime and an empty runtime are errors', () => {
    expect(
      errs(
        read(
          'version: 1\nworkloads:\n  - name: a\n    runtime:\n      gunicorn: "26.2.0"\n      uwsgi: "1"\n',
        ),
      ),
    ).toEqual(['6|unknown-key|uwsgi']);
    expect(errs(read('version: 1\nworkloads:\n  - name: a\n    runtime: {}\n'))).toEqual([
      '4|invalid-schema|workloads[0].runtime',
    ]);
  });
});

describe('a declaration that names no workload or two is the config-error case error, as for runtime.node', () => {
  const declare = (key: string, name: string) =>
    `version: 1\nworkloads:\n  - name: ${name}\n    runtime:\n      ${key}: "1.0.0"\n`;
  const codes = (r: ReturnType<typeof analyseFiles>['result']) =>
    r.configErrors.map((e) => `${e.reasonCode}|${txt(e.key)}`);

  it.each(['gunicorn', 'uvicorn'])('runtime.%s naming no workload', (key) => {
    const { result } = analyseFiles({
      'tripcurve.yaml': declare(`runtime.${key}`.slice(8), 'ghost'),
    });
    expect(codes(result)).toEqual([`declaration-names-no-workload|runtime.${key}`]);
  });

  it.each(['gunicorn', 'uvicorn'])(
    'runtime.%s naming two workloads (one name in two namespaces)',
    (key) => {
      const web = DEMO_FILES['k8s/web.yaml'] as string;
      const { result } = analyseFiles({
        'k8s/web-other.yaml': web.replace('namespace: shop', 'namespace: other'),
        'tripcurve.yaml': declare(key, 'web'),
      });
      expect(codes(result)).toEqual([`declaration-names-several-workloads|runtime.${key}`]);
    },
  );
});
