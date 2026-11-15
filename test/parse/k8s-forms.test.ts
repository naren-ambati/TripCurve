// Hardcore local testing (2026-11-14): a Kubernetes manifest written as JSON, with quoted keys or in
// flow style was ignored: not counted, not listed, and the run printed "All checks passed". The class is now decided
// by the parsed shape (a mapping with a string `apiVersion` and a string `kind`), as is done for templates. A manifest
// in any of the four forms must give the same files-read count, the same findings and the same summary as its plain
// YAML twin (line numbers may differ), and a broken one in any form is listed as not checked.
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { analyse } from '../../src/analyse.js';
import { intake, readKubernetes } from '../../src/parse/index.js';
import { assembleReport } from '../../src/report/index.js';
import { DEMO_FILES_SHUTDOWN } from '../support/analyse.js';
import { DEMO, DEMO_FIXED } from '../support/demo.js';
import { txt } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

type Form = 'yaml' | 'quoted' | 'flow' | 'json';
const FORMS: readonly Form[] = ['yaml', 'quoted', 'flow', 'json'];
const EXT: Record<Form, string> = { yaml: 'yaml', quoted: 'yaml', flow: 'yaml', json: 'json' };

function write(form: Form, object: unknown): string {
  switch (form) {
    case 'yaml':
      return stringify(object);
    case 'quoted':
      return stringify(object, { defaultKeyType: 'QUOTE_DOUBLE' });
    case 'flow':
      // one line, as `{apiVersion: v1, kind: Pod, ...}`: the shape the old line test could not see
      return `${stringify(object, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n\s*/g, ' ')}\n`;
    case 'json':
      return `${JSON.stringify(object, null, 2)}\n`;
  }
}

const meta = (name: string) => ({ name, namespace: 'shop' });
const pod = (app: string) => ({
  metadata: { labels: { app } },
  spec: {
    containers: [
      {
        name: 'app',
        image: 'node:22.23',
        command: ['node', 'src/server.ts'],
        ports: [{ name: 'http', containerPort: 8080 }],
      },
    ],
    terminationGracePeriodSeconds: 45,
  },
});
const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: meta('web'),
  spec: { selector: { matchLabels: { app: 'web' } }, template: pod('web') },
};
const service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: meta('web'),
  spec: { selector: { app: 'web' }, ports: [{ port: 80, targetPort: 'http' }] },
};
const ingress = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'Ingress',
  metadata: {
    ...meta('shop'),
    annotations: {
      'alb.ingress.kubernetes.io/scheme': 'internet-facing',
      'alb.ingress.kubernetes.io/load-balancer-attributes': 'idle_timeout.timeout_seconds=60',
      'alb.ingress.kubernetes.io/target-type': 'ip',
    },
  },
  spec: {
    ingressClassName: 'alb',
    rules: [
      {
        http: {
          paths: [
            {
              path: '/',
              pathType: 'Prefix',
              backend: { service: { name: 'web', port: { number: 80 } } },
            },
          ],
        },
      },
    ],
  },
};
const MANIFESTS: Record<string, unknown> = {
  deployment,
  statefulset: {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta('db'),
    spec: { serviceName: 'db', selector: { matchLabels: { app: 'db' } }, template: pod('db') },
  },
  daemonset: {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: meta('agent'),
    spec: { selector: { matchLabels: { app: 'agent' } }, template: pod('agent') },
  },
  pod: {
    apiVersion: 'v1',
    kind: 'Pod',
    ...pod('one'),
    metadata: { ...meta('one'), labels: { app: 'one' } },
  },
  service,
  ingress,
  list: {
    apiVersion: 'v1',
    kind: 'List',
    items: [deployment, service],
  },
};

function treeOf(files: Record<string, string>): Tree {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  return t;
}

function objectsOf(read: ReturnType<typeof intake>): string[] {
  const k = readKubernetes(read);
  return [
    ...k.workloads.map((o) => `${o.kind}/${txt(o.name)}`),
    ...k.services.map((o) => `Service/${txt(o.name)}`),
    ...k.ingresses.map((o) => `Ingress/${txt(o.name)}`),
  ].sort();
}

/** What a run says, without line numbers: the files read, what is not checked, every finding and the summary. */
function projection(t: Tree) {
  const read = intake({ root: t.root });
  const analysis = analyse(read);
  const report = assembleReport({ checked: '.', intake: read, analysis });
  return {
    filesRead: read.filesRead,
    classes: read.files.map((f) => f.class),
    unchecked: report.unchecked.map((u) => u.reasonCode),
    objects: objectsOf(read),
    findings: analysis.results.flatMap((r) =>
      r.findings.map((f) => `${f.rule} ${f.kind} ${f.headline}`),
    ),
    summary: report.summary,
  };
}

describe('every manifest form is read as its plain YAML twin', () => {
  for (const [name, object] of Object.entries(MANIFESTS)) {
    for (const form of FORMS.slice(1)) {
      it(`${name} as ${form}`, () => {
        const plain = projection(treeOf({ [`k8s/${name}.yaml`]: write('yaml', object) }));
        expect(plain.filesRead).toBe(1);
        const other = projection(treeOf({ [`k8s/${name}.${EXT[form]}`]: write(form, object) }));
        expect(other).toEqual(plain);
        expect(other.classes).toEqual(['k8s-yaml']);
      });
    }
  }

  it('the demo web workload (ingress, service, deployment, server.ts) gives the same findings in all four forms', () => {
    const files = (form: Form): Record<string, string> => {
      const out: Record<string, string> = {
        'src/server.ts': DEMO_FILES_SHUTDOWN['src/server.ts'] as string,
      };
      for (const path of ['k8s/ingress.yaml', 'k8s/service.yaml', 'k8s/web.yaml']) {
        const object = parse(DEMO_FILES_SHUTDOWN[path] as string);
        out[path.replace(/\.yaml$/, `.${EXT[form]}`)] = write(form, object);
      }
      return out;
    };
    const plain = projection(treeOf(files('yaml')));
    expect(plain.findings.some((f) => f.startsWith('T1 FAIL'))).toBe(true);
    expect(plain.summary.clean).toBe(false);
    for (const form of FORMS.slice(1)) {
      expect(projection(treeOf(files(form)))).toEqual(plain);
    }
  });

  it('a package.json, a lock file and a tsconfig.json that mention the two words are still not manifests', () => {
    const t = treeOf({
      'package.json': '{"name":"x","version":"1.0.0","apiVersion":"v1","kind":"app"}\n',
      'tsconfig.json': '{"compilerOptions":{},"apiVersion":"v1","kind":"x"}\n',
      'k8s/ok.yaml': write('yaml', deployment),
    });
    const p = projection(t);
    expect(p.objects).toEqual(['Deployment/web']);
  });

  it('a file that is both a template and a manifest is still reported, never guessed', () => {
    const both = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { B: { Type: 'AWS::S3::Bucket' } },
      apiVersion: 'v1',
      kind: 'ConfigMap',
    };
    for (const form of FORMS) {
      const p = projection(treeOf({ [`x/t.${EXT[form]}`]: write(form, both) }));
      expect(p.unchecked, form).toEqual(['template-ambiguous']);
      expect(p.summary.clean, form).toBe(false);
    }
  });

  it('JSON that is not a manifest (no string apiVersion and kind) is ignored without comment', () => {
    const t = treeOf({
      'data/a.json': '{"apiVersion": 3, "kind": 5}\n',
      'data/b.yaml': 'a: 1\nnote: "apiVersion kind"\n',
    });
    const read = intake({ root: t.root });
    expect(read.filesRead).toBe(0);
    expect(read.unchecked).toEqual([]);
  });
});

describe('a broken manifest of any form is listed as not checked', () => {
  const full = (form: Form) => write(form, deployment);
  // a file cut off inside a nested value (a block-style file only breaks that way inside a flow value)
  const truncated = (form: Form) =>
    form === 'yaml' || form === 'quoted'
      ? `${full(form)}extra: {a: [1, 2`
      : full(form).slice(0, Math.floor(full(form).length * 0.75));
  const broken = (form: Form): string => `${full(form)}]]}}\n`;
  for (const form of FORMS) {
    for (const [what, make] of [
      ['truncated', truncated],
      ['syntactically broken', broken],
    ] as const) {
      it(`${what}, as ${form}`, () => {
        const p = projection(treeOf({ [`k8s/web.${EXT[form]}`]: make(form) }));
        expect(p.unchecked, 'listed under files not checked').toHaveLength(1);
        expect(['parse-error', 'json-parse-error']).toContain(p.unchecked[0]);
        expect(p.summary.clean).toBe(false);
        expect(p.summary.exitCode).not.toBe(0);
      });
    }
  }

  it('a plain YAML file broken the same way is the existing behaviour (the reference)', () => {
    const p = projection(treeOf({ 'k8s/web.yaml': `${full('yaml')}\nfoo: [unclosed\n` }));
    expect(p.unchecked).toEqual(['parse-error']);
  });
});

describe('hostile manifests in the new forms never crash and never read clean', () => {
  const hostile: Record<string, (form: Form) => string> = {
    'a 10 MB string': (form) =>
      write(form, {
        ...deployment,
        metadata: { ...meta('web'), annotations: { big: 'x'.repeat(10_000_000) } },
      }),
    'deep nesting': (form) => {
      const depth = 20_000;
      return form === 'json'
        ? `{"apiVersion":"v1","kind":"X","a":${'['.repeat(depth)}${']'.repeat(depth)}}`
        : `{apiVersion: v1, kind: X, a: ${'['.repeat(depth)}${']'.repeat(depth)}}`;
    },
    'duplicate keys': (form) =>
      form === 'json'
        ? '{"apiVersion":"v1","kind":"Pod","kind":"Service","metadata":{"name":"a","namespace":"b"}}'
        : '{apiVersion: v1, kind: Pod, kind: Service, metadata: {name: a, namespace: b}}',
    'a byte-order mark': (form) => `﻿${write(form, deployment)}`,
    'CRLF line ends': (form) => write(form, deployment).replace(/\n/g, '\r\n'),
  };
  for (const [what, make] of Object.entries(hostile)) {
    for (const form of FORMS.slice(1)) {
      it(`${what}, as ${form}`, () => {
        const t = treeOf({ [`k8s/h.${EXT[form]}`]: make(form) });
        const p = projection(t);
        if (what === 'a byte-order mark' || what === 'CRLF line ends') {
          expect(p.objects).toEqual(['Deployment/web']);
        } else {
          // read, or listed as not checked: never silently dropped, and the run is not clean
          expect(p.filesRead + p.unchecked.length).toBeGreaterThan(0);
        }
        if (what === 'duplicate keys' || what === 'a 10 MB string' || what === 'deep nesting') {
          expect(p.unchecked.length + p.objects.length).toBeGreaterThan(0);
        }
      });
    }
  }
});

describe('finding a manifest by its shape stays linear in the file', () => {
  // The text pre-filter is two substring searches and the parse is the ordinary bounded one: a JSON file, a quoted-key
  // file and a one-line flow file of n entries, and n small manifests, each cost time linear in n.
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: i, kind: 'k', v: [i, i] }));
  const forms: [string, (n: number) => string][] = [
    ['JSON', (n) => `${JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', data: items(n) })}\n`],
    [
      'flow on one line',
      (n) =>
        `{apiVersion: v1, kind: ConfigMap, data: [${items(n)
          .map((i) => `{id: ${i.id}, kind: k}`)
          .join(', ')}]}\n`,
    ],
    [
      'quoted keys',
      (n) =>
        stringify(
          { apiVersion: 'v1', kind: 'ConfigMap', data: items(n) },
          { defaultKeyType: 'QUOTE_DOUBLE' },
        ),
    ],
  ];
  for (const [name, make] of forms) {
    it(
      `${name}: 4x the entries take about 4x the time`,
      () => {
        const ratio = scalingRatio((n) => {
          const t = makeTree();
          try {
            t.write(`k8s/big.${name === 'JSON' ? 'json' : 'yaml'}`, make(n));
            intake({ root: t.root });
          } finally {
            t.cleanup();
          }
        }, 5_000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
      },
      SCALING_TEST_TIMEOUT_MS,
    );
  }

  it(
    'many small manifests in one JSON-named folder: 4x the files take about 4x the time',
    () => {
      const ratio = scalingRatio((n) => {
        const t = makeTree();
        try {
          for (let i = 0; i < n; i++)
            t.write(
              `k8s/m${i}.json`,
              `{"apiVersion":"v1","kind":"Pod","metadata":{"name":"p${i}"}}\n`,
            );
          intake({ root: t.root });
        } finally {
          t.cleanup();
        }
      }, 150);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

// A file that is a list of objects at its root (a JSON array, a flow sequence, a block-style list) was skipped without a
// word: it parsed to a sequence, no mapping was found, and the file vanished. Each element that is an object is now
// read like an item of a `kind: List`, and anything else is listed. (kubectl's own acceptance of a root array is not
// claimed; tripcurve only never skips one silently.)
describe('a root-level list of objects is read, never skipped', () => {
  const asList = (form: Form, objects: unknown[]): string => {
    switch (form) {
      case 'json':
        return `${JSON.stringify(objects, null, 2)}\n`;
      case 'flow':
        return `${stringify(objects, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n\s*/g, ' ')}\n`;
      default:
        return stringify(objects); // a block list: `- apiVersion: ...` at column 0
    }
  };
  const LIST_FORMS: Form[] = ['yaml', 'flow', 'json'];
  const copyDemo = (source: string): Tree => {
    const t = makeTree();
    trees.push(t);
    cpSync(source, t.root, { recursive: true, filter: (f) => !/expected|README\.md$/.test(f) });
    return t;
  };
  /** A copy of a demo tree with every manifest rewritten as a one-element list in the given form. */
  const demoAsLists = (source: string, form: Form): Tree => {
    const t = copyDemo(source);
    for (const name of readdirSync(join(t.root, 'k8s'))) {
      const path = join(t.root, 'k8s', name);
      const object = parse(readFileSync(path, 'utf8'));
      rmSync(path);
      t.write(`k8s/${name.replace(/\.yaml$/, `.${EXT[form]}`)}`, asList(form, [object]));
    }
    return t;
  };

  for (const [name, source] of [
    ['demo', DEMO],
    ['demo-fixed', DEMO_FIXED],
  ] as const) {
    for (const form of LIST_FORMS) {
      it(`${name} with every manifest as a root list (${form}) gives the plain demo's findings`, () => {
        const plain = projection(copyDemo(source));
        const lists = projection(demoAsLists(source, form));
        expect(lists).toEqual(plain);
        expect(lists.filesRead).toBe(plain.filesRead);
      });
    }
  }

  it('one list holding several objects (the manifests of the web workload) is read as all of them', () => {
    for (const form of LIST_FORMS) {
      const all = ['ingress', 'service', 'web'].map((n) =>
        parse(DEMO_FILES_SHUTDOWN[`k8s/${n}.yaml`] as string),
      );
      const t = treeOf({
        [`k8s/all.${EXT[form]}`]: asList(form, all),
        'src/server.ts': DEMO_FILES_SHUTDOWN['src/server.ts'] as string,
      });
      const p = projection(t);
      expect(p.objects, form).toEqual(['Deployment/web', 'Ingress/web', 'Service/web']);
      expect(
        p.findings.some((f) => f.startsWith('T1 FAIL')),
        form,
      ).toBe(true);
    }
  });

  it('a list with a stray element reads the objects and lists the file as not checked', () => {
    for (const form of LIST_FORMS) {
      const p = projection(
        treeOf({
          [`k8s/m.${EXT[form]}`]: asList(form, [deployment, 'stray', { note: 'apiVersion kind' }]),
        }),
      );
      expect(p.objects, form).toEqual(['Deployment/web']);
      expect(p.unchecked, form).toEqual(['object-not-identified']);
      expect(p.summary.clean, form).toBe(false);
    }
  });

  it('a list with the two words and no object at all is listed, never ignored', () => {
    for (const form of LIST_FORMS) {
      const p = projection(
        treeOf({ [`k8s/m.${EXT[form]}`]: asList(form, ['apiVersion', 'kind']) }),
      );
      expect(p.unchecked, form).toEqual(['object-not-identified']);
      expect(p.summary.clean, form).toBe(false);
    }
  });
});

describe('an object the plain path lists is listed the same way in every form', () => {
  const odd = { apiVersion: ['apps/v1'], kind: 'Deployment', metadata: { name: 'x' } };
  const nameless = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: {} };
  for (const [what, object] of [
    ['an apiVersion that is not text', odd],
    ['no name', nameless],
  ] as const) {
    for (const form of FORMS) {
      it(`${what}, as ${form}`, () => {
        const reference = projection(treeOf({ 'k8s/a.yaml': write('yaml', object) }));
        const p = projection(treeOf({ [`k8s/a.${EXT[form]}`]: write(form, object) }));
        expect(p.unchecked).toEqual(reference.unchecked);
        expect(p.filesRead).toBe(reference.filesRead);
        expect(p.summary.clean).toBe(false);
      });
    }
  }
});

describe('the candidate test is not wider than the words (guards)', () => {
  it('a broken file that holds only `kind` (or only `apiVersion`) is ignored, not listed', () => {
    const t = treeOf({
      'a/kind.yaml': 'kind: [unclosed\n',
      'a/api.yaml': '{apiVersion: [unclosed\n',
      'a/kind.json': '{"kind": \n',
      'a/api.json': '{"apiVersion": \n',
    });
    const read = intake({ root: t.root });
    expect(read.unchecked).toEqual([]);
    expect(read.filesRead).toBe(0);
  });

  it('a file with a template marker and both words that parses as neither shape is not read as Kubernetes', () => {
    const t = treeOf({
      'a/n.json': '{"note": "\\"AWSTemplateFormatVersion\\" apiVersion kind"}\n',
      'a/n.yaml': '{note: "AWSTemplateFormatVersion apiVersion kind"}\n',
    });
    const read = intake({ root: t.root });
    expect(read.files.map((f) => f.class)).toEqual([]);
    expect(read.unchecked).toEqual([]);
  });
});
