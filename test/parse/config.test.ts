import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSourcedValue } from '../../src/core/index.js';
import { type ConfigResult, readConfig } from '../../src/parse/config/index.js';
import { intake, intakeStreamBytes } from '../../src/parse/intake/index.js';
import { txt, where } from '../support/render.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'config');
const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function readFrom(text: string): ConfigResult {
  const t = makeTree();
  trees.push(t);
  t.write('tripcurve.yaml', text);
  return readConfig(intake({ root: t.root }));
}

function errs(result: ConfigResult): string[] {
  return result.configErrors.map((e) => `${e.line}|${e.reasonCode}|${txt(e.key)}`);
}

describe('a valid tripcurve.yaml', () => {
  const result = readConfig(intake({ root: join(FIXTURES, 'valid') }));

  it('has no errors and names the file', () => {
    expect(errs(result)).toEqual([]);
    expect(txt(result.configFile as never)).toBe('tripcurve.yaml');
  });

  it('turns each declaration into a value sourced to tripcurve.yaml:<line> with basis declared', () => {
    const rows = result.declarations.map((d) => ({
      workload: txt(d.workload.name),
      namespace: d.workload.namespace === undefined ? undefined : txt(d.workload.namespace),
      key: d.key,
      value: typeof d.value.value === 'object' ? txt(d.value.value) : d.value.value,
      unit: d.value.unit,
      at: where(d.value.source),
      line: d.line,
      basis: d.value.basis,
      confidence: d.value.confidence,
      sourceType: d.value.source.type,
    }));
    expect(rows).toEqual([
      {
        workload: 'web',
        namespace: 'shop',
        key: 'longest_request_s',
        value: 5,
        unit: 's',
        at: 'tripcurve.yaml:7',
        line: 7,
        basis: 'declared',
        confidence: 'declared',
        sourceType: 'declared',
      },
      {
        workload: 'web',
        namespace: 'shop',
        key: 'drain.in_process_s',
        value: 3,
        unit: 's',
        at: 'tripcurve.yaml:9',
        line: 9,
        basis: 'declared',
        confidence: 'declared',
        sourceType: 'declared',
      },
      {
        workload: 'web',
        namespace: 'shop',
        key: 'runtime.node',
        value: '22.23.2',
        unit: 'none',
        at: 'tripcurve.yaml:11',
        line: 11,
        basis: 'declared',
        confidence: 'declared',
        sourceType: 'declared',
      },
    ]);
    for (const d of result.declarations) expect(isSourcedValue(d.value)).toBe(true);
    expect(result.declarations[0]?.workloadKind).toBe('Deployment');
  });

  it('reads the links: source, dockerfile, gunicorn_config and the three load balancer forms', () => {
    const rows = result.links.map((l) => [
      txt(l.workload.name),
      l.kind,
      txt(l.target),
      l.line,
      l.loadBalancer?.form ?? '-',
      l.loadBalancer?.idleTimeoutS === undefined ? '-' : l.loadBalancer.idleTimeoutS.value,
    ]);
    expect(rows).toEqual([
      ['web', 'source', 'src/server.ts', 6, '-', '-'],
      ['web', 'dockerfile', 'docker/Dockerfile', 12, '-', '-'],
      ['web', 'gunicorn_config', 'app/gunicorn.conf.py', 13, '-', '-'],
      ['web', 'load_balancer', 'web-ingress', 15, 'ingress', 120],
      ['api', 'load_balancer', 'aws_lb.main', 19, 'terraform', '-'],
      ['stream', 'load_balancer', 'stream-svc', 22, 'service', 350],
    ]);
  });

  it('extracts waive entries raw and validates nothing', () => {
    expect(result.waiverRecords).toHaveLength(3);
    const [first, second, third] = result.waiverRecords;
    expect(first?.mechanism).toBe('config');
    expect(where(first?.source as never)).toBe('tripcurve.yaml:25');
    expect(first?.rawFields.map((f) => txt(f.key))).toEqual([
      'rule',
      'workload',
      'reason',
      'until',
    ]);
    expect(txt(first?.rawText as never)).toContain('reason: "drains in sidecar"');
    expect(second?.rawFields).toEqual([]); // a string entry is still a record, for to refuse
    expect(txt(second?.rawText as never)).toBe('"not even a mapping"');
    const reason = third?.rawFields.find((f) => txt(f.key) === 'reason');
    expect(reason?.value).toBe(5);
    const rule = third?.rawFields.find((f) => txt(f.key) === 'rule');
    expect(rule?.value).toEqual({ nested: true });
  });
});

describe('errors stop nothing here but are all listed', () => {
  it('an unknown key is an error at the key, named as written, at every level', () => {
    const result = readConfig(intake({ root: join(FIXTURES, 'unknown-key') }));
    expect(errs(result)).toEqual([
      '5|unknown-key|longest_reqest_s',
      '8|unknown-key|npm',
      '9|unknown-key|top_level_idle',
    ]);
    // the good declaration of the same entry is still read
    expect(result.declarations.map((d) => d.key)).toEqual(['longest_request_s', 'runtime.node']);
  });

  it('wrong types, negative and non-numeric numbers, an unknown kind and a missing name', () => {
    const result = readConfig(intake({ root: join(FIXTURES, 'bad-values') }));
    expect(errs(result)).toEqual([
      '4|bad-value|workloads[0].longest_request_s',
      '7|bad-value|workloads[1].drain.in_process_s',
      '10|bad-value|workloads[2].runtime.node',
      '12|bad-value|workloads[3].kind',
      '13|invalid-schema|workloads[4].name',
      '14|bad-value|workloads[5].name',
      '17|invalid-schema|workloads[6].load_balancer',
      '22|invalid-schema|workloads[7].load_balancer',
      '25|bad-value|workloads[8].load_balancer.terraform',
    ]);
    expect(result.declarations).toEqual([]);
    expect(result.links).toEqual([]);
  });

  it('the version must be 1', () => {
    expect(errs(readFrom('version: 2\n'))).toEqual(['1|bad-value|version']);
    expect(errs(readFrom('workloads: []\n'))).toEqual(['1|invalid-schema|version']);
    expect(errs(readFrom('version: "1"\n'))).toEqual(['1|bad-value|version']);
  });

  it('a global longest_request_s or idle value is an unknown key', () => {
    expect(errs(readFrom('version: 1\nlongest_request_s: 5\nidle_timeout_s: 60\n'))).toEqual([
      '2|unknown-key|longest_request_s',
      '3|unknown-key|idle_timeout_s',
    ]);
  });

  it('workloads and waive must be lists; an entry must be a mapping', () => {
    const wrong = readFrom('version: 1\nworkloads: {a: 1}\nwaive: x\n');
    // a waive: that is not a list is not a configuration error: it is one raw waiver record, judged invalid
    // and listed by WaiverApplier, so it never stops the run
    expect(errs(wrong)).toEqual(['2|invalid-schema|workloads']);
    expect(wrong.waiverRecords).toHaveLength(1);
    expect(wrong.waiverRecords[0]?.notAList).toBe(true);
    expect(
      wrong.waiverRecords[0]?.source.type === 'declared' && wrong.waiverRecords[0].source.line,
    ).toBe(3);
    expect(errs(readFrom('version: 1\nworkloads:\n  - web\n'))).toEqual([
      '3|invalid-schema|workloads[0]',
    ]);
  });

  it('bounds on numbers: zero is allowed, infinity and NaN are not', () => {
    const ok = readFrom('version: 1\nworkloads:\n  - name: w\n    longest_request_s: 0\n');
    expect(ok.configErrors).toEqual([]);
    expect(ok.declarations[0]?.value.value).toBe(0);
    for (const bad of ['.inf', '-.inf', '.nan', '"5"', 'true', '-0.5', '[1]']) {
      const r = readFrom(`version: 1\nworkloads:\n  - name: w\n    longest_request_s: ${bad}\n`);
      expect(errs(r)).toEqual(['4|bad-value|workloads[0].longest_request_s']);
    }
  });

  it('a key named __proto__ or constructor is an unknown key, never a lookup on the prototype', () => {
    const r = readFrom('version: 1\n__proto__: {x: 1}\nconstructor: 5\n');
    expect(errs(r)).toEqual(['2|unknown-key|__proto__', '3|unknown-key|constructor']);
  });

  it('a duplicate key in the file is a file error, not a silent last-one-wins', () => {
    const r = readFrom('version: 1\nversion: 1\n');
    // the error names the key that was written twice
    expect(errs(r)).toEqual(['2|invalid-schema|version']);
  });

  it('a file that does not parse is an error, not an ignored file', () => {
    const r = readFrom('version: 1\nworkloads: [oops\n');
    expect(r.configErrors).toHaveLength(1);
    expect(r.configErrors[0]?.reasonCode).toBe('invalid-schema');
    expect(txt(r.configErrors[0]?.key as never)).toBe('(file)');
    expect(r.configErrors[0]?.line).toBeGreaterThanOrEqual(2);
    expect(r.declarations).toEqual([]);
  });

  it('an empty file, a scalar file and a two-document file are errors', () => {
    expect(errs(readFrom(''))).toEqual(['1|invalid-schema|(file)']);
    expect(errs(readFrom('just text\n'))).toEqual(['1|invalid-schema|(file)']);
    expect(errs(readFrom('version: 1\n---\nversion: 1\n'))).toEqual(['2|invalid-schema|(file)']);
  });

  it('a config file that is over the size limit is an error', () => {
    const t = makeTree();
    trees.push(t);
    t.write('tripcurve.yaml', `version: 1\n#${'x'.repeat(500)}\n`);
    const r = readConfig(
      intake({ root: t.root, limits: { maxFileBytes: 100, maxAliasCount: 100 } }),
    );
    expect(errs(r)).toEqual(['1|invalid-schema|(file)']);
  });

  it('a named --config that is missing is an error', () => {
    const t = makeTree();
    trees.push(t);
    t.write('web.yaml', 'apiVersion: v1\nkind: Pod\n');
    const r = readConfig(intake({ root: t.root, configPath: join(t.root, 'nope.yaml') }));
    expect(errs(r)).toEqual(['1|invalid-schema|(file)']);
  });
});

describe('a tripcurve.yaml that intake refused', () => {
  it('a link out of the root is an error, not a config that quietly does not exist', () => {
    const outside = makeTree();
    trees.push(outside);
    outside.write('c.yaml', 'version: 1\n');
    const t = makeTree();
    trees.push(t);
    t.write('web.yaml', 'apiVersion: v1\nkind: Pod\n');
    symlinkSync(join(outside.root, 'c.yaml'), join(t.root, 'tripcurve.yaml'));
    const r = readConfig(intake({ root: t.root }));
    expect(errs(r)).toEqual(['1|invalid-schema|(file)']);
  });
});

describe('no configuration', () => {
  it('no tripcurve.yaml gives an empty, valid result', () => {
    const t = makeTree();
    trees.push(t);
    t.write('web.yaml', 'apiVersion: v1\nkind: Pod\n');
    const r = readConfig(intake({ root: t.root }));
    expect(r).toEqual({ declarations: [], links: [], waiverRecords: [], configErrors: [] });
  });

  it('with - and no --config none is looked up', () => {
    const r = readConfig(intakeStreamBytes(Buffer.from('version: 1\nbogus: 1\n')));
    expect(r.configErrors).toEqual([]);
    expect(r.configFile).toBeUndefined();
  });

  it('with - and --config the named file is read', () => {
    const t = makeTree();
    trees.push(t);
    t.write('c.yaml', 'version: 1\nbogus: 1\n');
    const r = readConfig(
      intakeStreamBytes(Buffer.from(''), { configPath: join(t.root, 'c.yaml') }),
    );
    expect(errs(r)).toEqual(['2|unknown-key|bogus']);
  });
});

describe('hostile configuration text', () => {
  it('names and values with control characters are carried as input text', () => {
    const r = readFrom('version: 1\nworkloads:\n  - name: "a\\e[31mb"\n    source: "x\\ny"\n');
    expect(r.configErrors).toEqual([]);
    expect(txt(r.links[0]?.workload.name as never)).toBe('a\u001b[31mb');
    expect(txt(r.links[0]?.target as never)).toBe('x\ny');
  });

  it('an alias bomb in tripcurve.yaml is an error, not a hang', () => {
    let text = 'version: 1\nx-a0: &a0 [x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i < 10; i += 1) {
      text += `x-a${i}: &a${i} [${Array(9)
        .fill(`*a${i - 1}`)
        .join(', ')}]\n`;
    }
    const r = readFrom(text);
    expect(r.configErrors).toHaveLength(1);
    expect(r.configErrors[0]?.reasonCode).toBe('invalid-schema');
  });
});
