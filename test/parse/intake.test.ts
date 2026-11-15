import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inputText, MAX_FILE_BYTES, YAML_MAX_ALIAS_COUNT } from '../../src/core/index.js';
import {
  confineToRoot,
  DEFAULT_LIMITS,
  inspectRoot,
  intake,
  intakeStdin,
  intakeStreamBytes,
  rawTextForParser,
  STDIN,
  UNCHECKED_REASONS,
  type UncheckedInput,
  uncheckedReasonWords,
} from '../../src/parse/intake/index.js';
import { txt, where } from '../support/render.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const HOSTILE = join(import.meta.dirname, '..', 'fixtures', 'hostile');
const DEPLOY = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n';

const trees: Tree[] = [];
function tree(): Tree {
  const t = makeTree();
  trees.push(t);
  return t;
}
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function names(result: { files: readonly { canonicalPath: never }[] }): string[] {
  return result.files.map((f) => txt(f.canonicalPath));
}
function pathsOf(list: readonly { canonicalPath: unknown }[]): string[] {
  return list.map((f) => txt(f.canonicalPath as never));
}
function uncheckedPairs(list: readonly UncheckedInput[]): string[] {
  return list.map((u) => `${u.path === STDIN ? STDIN : txt(u.path)}|${u.reasonCode}`);
}

describe('classification', () => {
  it('classifies by name and content, ignores unknown files and skipped directories', () => {
    const t = tree();
    t.write('k8s/web.yaml', DEPLOY);
    t.write('k8s/values.yaml', 'replicas: 3\n'); // yaml but not Kubernetes: ignored without comment
    t.write('Dockerfile', 'FROM node:22.23\n');
    t.write('svc/Dockerfile.prod', 'FROM node:22\n');
    t.write('package.json', '{}');
    t.write('src/server.ts', 'export {};\n');
    t.write('src/types.d.ts', 'export {};\n'); // declaration file: not source
    t.write('infra/main.tf', 'resource "aws_lb" "x" {}\n');
    t.write('infra/plan.tf.json', '{}');
    t.write('app/gunicorn.conf.py', 'workers = 2\n');
    t.write('cfn/stack.yaml', 'AWSTemplateFormatVersion: "2010-09-09"\nResources: {}\n');
    t.write('tripcurve.yaml', 'version: 1\n');
    t.write('docs/tripcurve.yaml', 'version: 1\n'); // not at the root: not read
    t.write('README.md', '# hi\n');
    t.write('node_modules/dep/ingress.yaml', DEPLOY);
    t.write('.git/config.yaml', DEPLOY);
    const result = intake({ root: t.root });
    const found = result.files.map((f) => `${txt(f.canonicalPath)}=${f.class}`);
    expect(found).toEqual([
      'Dockerfile=dockerfile',
      'app/gunicorn.conf.py=gunicorn-conf',
      'cfn/stack.yaml=cfn-template',
      'infra/main.tf=terraform',
      'infra/plan.tf.json=terraform-json',
      'k8s/web.yaml=k8s-yaml',
      'package.json=package-json',
      'src/server.ts=node-source',
      'svc/Dockerfile.prod=dockerfile',
      'tripcurve.yaml=tripcurve-yaml',
    ]);
    expect(result.unchecked).toEqual([]);
    expect(result.filesRead).toBe(10);
    expect(result.noRecognisedFiles).toBe(false);
    expect(txt(result.configCandidate as never)).toBe('tripcurve.yaml');
  });

  it('orders files by the byte order of their canonical paths', () => {
    const t = tree();
    // no pair that differs only by case: the macOS file system would make them one file
    for (const n of ['b.yaml', 'a.yaml', 'C.yaml', 'z.yaml', '\u00e9.yaml', 'sub/a.yaml']) {
      t.write(n, DEPLOY);
    }
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual([
      'C.yaml',
      'a.yaml',
      'b.yaml',
      'sub/a.yaml',
      'z.yaml',
      '\u00e9.yaml',
    ]);
  });

  it('is deterministic: the same tree gives the same result twice', () => {
    const t = tree();
    for (const n of ['x/y.yaml', 'a.yaml', 'm/n/o.yaml']) t.write(n, DEPLOY);
    expect(pathsOf(intake({ root: t.root }).files)).toEqual(
      pathsOf(intake({ root: t.root }).files),
    );
  });

  it('classifies by content only: a .yaml with apiVersion and kind lines is Kubernetes', () => {
    const t = tree();
    t.write('a.yml', DEPLOY);
    t.write('b.yaml', 'kind: Thing\n'); // no apiVersion
    t.write('c.yaml', 'apiVersion: v1\n'); // no kind
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['a.yml']);
  });

  it('a Helm template that cannot parse is reported, not ignored', () => {
    const t = tree();
    t.write(
      'templates/d.yaml',
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  {{- if .Values.x }}\n  name: a\n',
    );
    const result = intake({ root: t.root });
    expect(uncheckedPairs(result.unchecked)).toEqual(['templates/d.yaml|parse-error']);
    expect(result.unchecked[0]?.line).toBe(4);
  });
});

describe('the empty result', () => {
  it('no recognised file: noRecognisedFiles is set and nothing is unchecked', () => {
    const result = intake({ root: join(HOSTILE, 'no-files') });
    expect(result.files).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.noRecognisedFiles).toBe(true);
    expect(result.filesRead).toBe(0);
  });

  it('a tripcurve.yaml alone is not a recognised input file', () => {
    const t = tree();
    t.write('tripcurve.yaml', 'version: 1\n');
    const result = intake({ root: t.root });
    expect(result.noRecognisedFiles).toBe(true);
    expect(result.files).toHaveLength(1);
  });

  it('a file we could not read means the run found something: not the no-files case', () => {
    const t = tree();
    t.write('a.yaml', 'apiVersion: v1\nkind: Pod\nmetadata: [oops\n');
    const result = intake({ root: t.root });
    expect(result.noRecognisedFiles).toBe(false);
  });

  it('an explicit root that does not exist is refused before reading', () => {
    const t = tree();
    expect(inspectRoot(join(t.root, 'nope'))).toEqual({ ok: false });
    expect(inspectRoot(t.root)).toEqual({ ok: true, kind: 'directory' });
    t.write('one.yaml', DEPLOY);
    expect(inspectRoot(join(t.root, 'one.yaml'))).toEqual({ ok: true, kind: 'file' });
    const result = intake({ root: join(t.root, 'nope') });
    expect(uncheckedPairs(result.unchecked).map((s) => s.endsWith('|unreadable'))).toEqual([true]);
    expect(result.noRecognisedFiles).toBe(false);
  });

  it('a root that is one file checks that file', () => {
    const t = tree();
    const file = t.write('only.yaml', DEPLOY);
    const result = intake({ root: file });
    expect(pathsOf(result.files)).toEqual(['only.yaml']);
  });

  it('a directory that cannot be listed is reported (skipped when run as root)', () => {
    if (process.getuid?.() === 0) return;
    const t = tree();
    t.write('ok/a.yaml', DEPLOY);
    t.write('locked/b.yaml', DEPLOY);
    chmodSync(join(t.root, 'locked'), 0o000);
    try {
      const result = intake({ root: t.root });
      expect(pathsOf(result.files)).toEqual(['ok/a.yaml']);
      expect(uncheckedPairs(result.unchecked)).toEqual(['locked|unreadable']);
    } finally {
      chmodSync(join(t.root, 'locked'), 0o755);
    }
  });
});

describe('limits', () => {
  it('a file one byte over the limit is over-size, at the limit it is read', () => {
    const t = tree();
    const limits = { maxFileBytes: 200, maxAliasCount: YAML_MAX_ALIAS_COUNT };
    const base = `${DEPLOY}#`;
    t.write('exact.yaml', base + 'x'.repeat(200 - base.length));
    t.write('over.yaml', base + 'x'.repeat(201 - base.length));
    const result = intake({ root: t.root, limits });
    expect(pathsOf(result.files)).toEqual(['exact.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['over.yaml|over-size']);
  });

  it('the default limit is 5,000,000 bytes and a file over it is skipped, not read', () => {
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(MAX_FILE_BYTES);
    expect(MAX_FILE_BYTES).toBe(5_000_000);
    const t = tree();
    t.write('huge.yaml', `${DEPLOY}#${'x'.repeat(5_000_001)}`);
    t.write('small.yaml', DEPLOY);
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['small.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['huge.yaml|over-size']);
  });

  it('a file of exactly 5,000,000 bytes is still read', () => {
    const t = tree();
    const head = `${DEPLOY}#`;
    t.write('edge.yaml', head + 'x'.repeat(5_000_000 - head.length));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['edge.yaml']);
    expect(result.unchecked).toEqual([]);
  });

  it('other classes are bounded too', () => {
    const t = tree();
    t.write('server.ts', 'x'.repeat(300));
    t.write('Dockerfile', 'FROM x\n');
    const result = intake({
      root: t.root,
      limits: { maxFileBytes: 100, maxAliasCount: YAML_MAX_ALIAS_COUNT },
    });
    expect(pathsOf(result.files)).toEqual(['Dockerfile']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['server.ts|over-size']);
  });

  // Bounded by the alias count, not by a clock; a hang would hit the test timeout.
  it('an alias bomb is alias-limit (the explicit library limit, not the default)', () => {
    const result = intake({ root: join(HOSTILE, 'alias-bomb') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['bomb.yaml|alias-limit']);
    expect(result.files).toHaveLength(1); // read; no documents survived
    expect(result.files[0]?.documents).toEqual([]);
  });

  it('the alias limit is a parameter, so a small file can reach it', () => {
    const t = tree();
    t.write('a.yaml', `${DEPLOY}x-a: &a [1, 2]\nx-b: *a\nx-c: *a\nx-d: *a\n`);
    const ok = intake({ root: t.root });
    expect(ok.unchecked).toEqual([]);
    const tight = intake({ root: t.root, limits: { maxFileBytes: 5_000_000, maxAliasCount: 2 } });
    expect(uncheckedPairs(tight.unchecked)).toEqual(['a.yaml|alias-limit']);
  });

  it('YAML with 20,000 levels of nesting is "too deeply nested" and does not crash', () => {
    const result = intake({ root: join(HOSTILE, 'deep-nesting') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['deep.yaml|over-depth']);
  });

  it('deeply nested block YAML generated at run time is also contained', () => {
    const t = tree();
    let text = `${DEPLOY}x:\n`;
    for (let i = 0; i < 2500; i += 1) text += `${' '.repeat(i + 1)}k:\n`;
    t.write('deep.yaml', `${text}${' '.repeat(2501)}v\n`);
    const result = intake({ root: t.root });
    expect(uncheckedPairs(result.unchecked)).toEqual(['deep.yaml|over-depth']);
  });

  it(
    'many empty documents in one file cost linear time',
    () => {
      const t = tree();
      t.write('many.yaml', `${DEPLOY}${'---\n'.repeat(100_000)}`);
      expect(intake({ root: t.root }).files).toHaveLength(1);
      const ratio = scalingRatio((n) => {
        const u = tree();
        u.write('many.yaml', `${DEPLOY}${'---\n'.repeat(n)}`);
        intake({ root: u.root });
      }, 25_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a file that is only blank lines is classified in linear time',
    () => {
      const t = tree();
      t.write('blank.yaml', '\n'.repeat(2_000_000));
      t.write('spaces.yaml', `${' '.repeat(2_000_000)}\n`);
      expect(intake({ root: t.root }).files).toEqual([]); // not Kubernetes: ignored
      const ratio = scalingRatio((n) => {
        const u = tree();
        u.write('blank.yaml', '\n'.repeat(n));
        u.write('spaces.yaml', `${' '.repeat(n)}\n`);
        intake({ root: u.root });
      }, 1_000_000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

describe('invalid UTF-8, control characters and broken files', () => {
  it('invalid UTF-8 is unreadable, never decoded with replacement characters', () => {
    const result = intake({ root: join(HOSTILE, 'invalid-utf8') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['bad.yaml|unreadable']);
    expect(result.files).toEqual([]);
  });

  it('a file cut off in the middle of a character is truncated', () => {
    const result = intake({ root: join(HOSTILE, 'truncated-utf8') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['cut.yaml|truncated']);
  });

  it('a NUL byte means a binary file: unreadable', () => {
    const result = intake({ root: join(HOSTILE, 'nul-binary') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['binary.yaml|unreadable']);
  });

  it('control characters inside a value are kept as data (SafeText makes them visible later)', () => {
    const result = intake({ root: join(HOSTILE, 'control-chars') });
    expect(result.unchecked).toEqual([]);
    const doc = result.files[0]?.documents?.[0];
    const meta = (doc?.value as { metadata: { name: string; namespace: string } } | undefined)
      ?.metadata;
    expect(meta?.name).toBe('web\u001b[31m\u0007 evil');
    expect(meta?.namespace).toBe('a\u001b]0;title\u0007b');
  });

  it('a file name with control characters is carried as input text, not interpreted', () => {
    const t = tree();
    t.write('we\u001b[2Jird\u0007.yaml', DEPLOY);
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['we\u001b[2Jird\u0007.yaml']);
  });

  it('one bad document among good ones: the good ones are kept, the file is named once with the line', () => {
    const t = tree();
    t.write(
      'many.yaml',
      `${DEPLOY}---\napiVersion: v1\nkind: Service\nmetadata: [broken\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n`,
    );
    const result = intake({ root: t.root });
    expect(result.files[0]?.documents).toHaveLength(2);
    expect(uncheckedPairs(result.unchecked)).toEqual(['many.yaml|parse-error']);
    const line = result.unchecked[0]?.line;
    expect(line).toBeGreaterThanOrEqual(5);
    expect(line).toBeLessThanOrEqual(9);
  });

  it('a file broken in several places gives one record, not several', () => {
    const result = intake({ root: join(HOSTILE, 'bad-yaml') });
    expect(uncheckedPairs(result.unchecked)).toEqual(['broken.yaml|parse-error']);
    expect(pathsOf(result.files).sort()).toEqual(['broken.yaml', 'good.yaml']);
  });

  it('an unchecked record has only a path, a reason code and, for a parse error, a line', () => {
    const result = intake({ root: join(HOSTILE, 'bad-yaml') });
    const record = result.unchecked[0] as UncheckedInput;
    expect(Object.keys(record).sort()).toEqual(['line', 'path', 'reasonCode']);
    for (const other of ['invalid-utf8', 'alias-bomb', 'deep-nesting']) {
      const r = intake({ root: join(HOSTILE, other) }).unchecked[0] as UncheckedInput;
      expect(Object.keys(r).sort()).toEqual(['path', 'reasonCode']);
    }
    expect(UNCHECKED_REASONS).toContain(record.reasonCode);
  });

  it('a .YAML, .YML or mixed-case YAML extension is read like .yaml, never ignored without a trace (m6)', () => {
    const t = tree();
    t.write('k8s/WEB.YAML', DEPLOY);
    t.write('k8s/api.Yml', DEPLOY.replace('web', 'api'));
    t.write('k8s/broken.YML', 'kind: [unclosed\napiVersion: v1\n');
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['k8s/WEB.YAML', 'k8s/api.Yml', 'k8s/broken.YML']);
    expect(result.files.map((f) => f.class)).toEqual(['k8s-yaml', 'k8s-yaml', 'k8s-yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['k8s/broken.YML|parse-error']);
  });

  it('a duplicate key is a parse error, not a silent last-one-wins', () => {
    const t = tree();
    t.write('d.yaml', `${DEPLOY}  name: other\n`);
    const result = intake({ root: t.root });
    expect(uncheckedPairs(result.unchecked)).toEqual(['d.yaml|parse-error']);
  });

  it('a file replaced by a socket-like or unreadable entry never blocks (FIFO named .yaml)', () => {
    const t = tree();
    t.write('good.yaml', DEPLOY);
    try {
      execFileSync('mkfifo', [join(t.root, 'pipe.yaml')]);
    } catch {
      return; // no mkfifo here
    }
    // A FIFO that blocked the read would hang here and hit the test timeout.
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['good.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['pipe.yaml|unreadable']);
  });

  it('a file name that is not valid UTF-8 never crashes (skipped where the file system refuses it)', () => {
    const t = tree();
    t.write('ok.yaml', DEPLOY);
    try {
      writeFileSync(
        Buffer.concat([
          Buffer.from(`${t.root}/bad`),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('.yaml'),
        ]),
        DEPLOY,
      );
    } catch {
      return;
    }
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toContain('ok.yaml');
    for (const u of result.unchecked) expect(u.reasonCode).toBe('unreadable');
  });
});

describe('root confinement, symlinks and spellings', () => {
  it('a symlink loop stops: the loop is reported once, nothing is read twice', () => {
    const t = tree();
    t.write('a/web.yaml', DEPLOY);
    symlinkSync('.', join(t.root, 'a', 'self'));
    symlinkSync('..', join(t.root, 'a', 'up'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['a/web.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['a/self|symlink-loop', 'a/up|symlink-loop']);
  });

  it('two links pointing at each other never end: reported as a loop, nothing read', () => {
    const t = tree();
    t.write('web.yaml', DEPLOY);
    symlinkSync(join(t.root, 'two'), join(t.root, 'one'));
    symlinkSync(join(t.root, 'one'), join(t.root, 'two'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['web.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual(['one|symlink-loop', 'two|symlink-loop']);
  });

  it('a file link that loops on itself, with a name we would read, is reported', () => {
    const t = tree();
    symlinkSync(join(t.root, 'self.yaml'), join(t.root, 'self.yaml'));
    const result = intake({ root: t.root });
    expect(uncheckedPairs(result.unchecked)).toEqual(['self.yaml|symlink-loop']);
  });

  it('a symlink leaving the root is never read: directory and file', () => {
    const outside = tree();
    outside.write('secret.yaml', DEPLOY);
    outside.write('dir/x.yaml', DEPLOY);
    const t = tree();
    t.write('in.yaml', DEPLOY);
    symlinkSync(join(outside.root, 'dir'), join(t.root, 'linked-dir'));
    symlinkSync(join(outside.root, 'secret.yaml'), join(t.root, 'leak.yaml'));
    // a link with an unremarkable name whose target is a file we would read: reported too
    symlinkSync(join(outside.root, 'secret.yaml'), join(t.root, 'harmless-name'));
    // a link to something we would never read: not our business
    outside.write('notes.txt', 'x');
    symlinkSync(join(outside.root, 'notes.txt'), join(t.root, 'notes-link'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['in.yaml']);
    expect(uncheckedPairs(result.unchecked)).toEqual([
      'harmless-name|outside-root',
      'leak.yaml|outside-root',
      'linked-dir|outside-root',
    ]);
  });

  it('a relative symlink with .. that leaves the root is refused', () => {
    const outside = tree();
    outside.write('o.yaml', DEPLOY);
    const t = tree();
    mkdirSync(join(t.root, 'deep', 'er'), { recursive: true });
    const rel = join('..', '..', '..', outside.root.split('/').pop() as string, 'o.yaml');
    symlinkSync(rel, join(t.root, 'deep', 'er', 'esc.yaml'));
    // the temp dirs share a parent, so the relative path really reaches the other tree
    const result = intake({ root: t.root });
    expect(result.files).toEqual([]);
    expect(uncheckedPairs(result.unchecked)).toEqual(['deep/er/esc.yaml|outside-root']);
  });

  it('two spellings of one file are one file: a symlink to a file inside the root', () => {
    const t = tree();
    t.write('real/web.yaml', DEPLOY);
    symlinkSync(join(t.root, 'real', 'web.yaml'), join(t.root, 'alias.yaml'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['real/web.yaml']);
    expect(result.filesRead).toBe(1);
  });

  it('two spellings of one file are one file: a hard link', () => {
    const t = tree();
    t.write('a.yaml', DEPLOY);
    linkSync(join(t.root, 'a.yaml'), join(t.root, 'b.yaml'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['a.yaml']);
  });

  it('a symlinked directory inside the root is walked at its real place only', () => {
    const t = tree();
    t.write('real/web.yaml', DEPLOY);
    symlinkSync(join(t.root, 'real'), join(t.root, 'shortcut'));
    const result = intake({ root: t.root });
    expect(pathsOf(result.files)).toEqual(['real/web.yaml']);
    expect(result.unchecked).toEqual([]);
  });

  it('a trailing slash, a symlinked root and a dotted root give the same canonical paths', () => {
    const t = tree();
    t.write('k/web.yaml', DEPLOY);
    const link = join(t.root, '..', `${t.root.split('/').pop()}-link`);
    symlinkSync(t.root, link);
    try {
      const base = pathsOf(intake({ root: t.root }).files);
      expect(pathsOf(intake({ root: `${t.root}/` }).files)).toEqual(base);
      expect(pathsOf(intake({ root: link }).files)).toEqual(base);
      expect(pathsOf(intake({ root: join(t.root, 'k', '..') }).files)).toEqual(base);
      expect(txt(intake({ root: link }).root as never)).toBe(realpathSync(t.root));
    } finally {
      execFileSync('rm', [link]);
    }
  });

  it('a unicode spelling of a name is the same file where the file system folds them', () => {
    const t = tree();
    const nfc = 'caf\u00e9.yaml';
    const nfd = 'cafe\u0301.yaml';
    t.write(nfc, DEPLOY);
    const result = intake({ root: t.root });
    let foldsSpellings = true;
    try {
      realpathSync(join(t.root, nfd));
    } catch {
      foldsSpellings = false;
    }
    if (!foldsSpellings) return; // this file system keeps the two names apart
    const confined = confineToRoot(result, inputText(nfd));
    expect(confined.ok).toBe(true);
    if (confined.ok) {
      expect(txt(confined.canonicalPath).normalize('NFC')).toBe(nfc);
      expect(pathsOf(result.files)).toHaveLength(1);
    }
  });

  describe('confineToRoot: paths found inside input files', () => {
    it('refuses .., absolute paths and links that leave the root; accepts what stays inside', () => {
      const outside = tree();
      outside.write('o.js', 'x');
      const t = tree();
      t.write('src/server.js', 'x');
      t.write('web.yaml', DEPLOY);
      symlinkSync(join(outside.root, 'o.js'), join(t.root, 'src', 'link.js'));
      symlinkSync(join(t.root, 'self'), join(t.root, 'self'));
      const result = intake({ root: t.root });

      const ok = confineToRoot(result, inputText('src/../src/server.js'));
      expect(ok.ok && txt(ok.canonicalPath)).toBe('src/server.js');
      const abs = confineToRoot(result, inputText(join(t.root, 'src', 'server.js')));
      expect(abs.ok && txt(abs.canonicalPath)).toBe('src/server.js');

      expect(confineToRoot(result, inputText('../etc/passwd'))).toEqual({
        ok: false,
        reasonCode: expect.stringMatching(/outside-root|unreadable/),
      });
      expect(confineToRoot(result, inputText(join(outside.root, 'o.js')))).toEqual({
        ok: false,
        reasonCode: 'outside-root',
      });
      expect(confineToRoot(result, inputText('src/link.js'))).toEqual({
        ok: false,
        reasonCode: 'outside-root',
      });
      expect(confineToRoot(result, inputText('self'))).toEqual({
        ok: false,
        reasonCode: 'symlink-loop',
      });
      expect(confineToRoot(result, inputText('missing.js'))).toEqual({
        ok: false,
        reasonCode: 'unreadable',
      });
      expect(confineToRoot(result, inputText('bad\u0000name'))).toEqual({
        ok: false,
        reasonCode: 'unreadable',
      });
    });

    it('a result from standard input has no root: every path is refused', () => {
      const result = intakeStreamBytes(Buffer.from(DEPLOY));
      expect(confineToRoot(result, inputText('anything.js'))).toEqual({
        ok: false,
        reasonCode: 'outside-root',
      });
    });
  });
});

describe('Secret data is never read', () => {
  it('data and stringData are gone from every document, including list items and merged keys', () => {
    const result = intake({ root: join(HOSTILE, 'secrets') });
    expect(result.unchecked).toEqual([]);
    const docs = result.files[0]?.documents ?? [];
    expect(docs).toHaveLength(5);
    const dump = JSON.stringify(docs.map((d) => d.value));
    for (const secret of [
      'hunter',
      'aHVu',
      'c2VjcmV0',
      'dmFsdWU',
      '"password"',
      '"token"',
      '"pw"',
    ]) {
      expect(dump).not.toContain(secret);
    }
    // the rest of each object is still there: names are not secrets
    expect(dump).not.toContain('x-base');
    expect(dump).toContain('"creds"');
    expect(dump).toContain('"via-merge"');
    expect(dump).toContain('"listed"');
    expect(dump).toContain('"in-list"');
    expect(dump).toContain('"kind-via-merge"');
  });

  it('a Secret in the standard-input stream is scrubbed the same way', () => {
    const text = 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  k: hunter\n';
    const result = intakeStreamBytes(Buffer.from(text));
    expect(JSON.stringify(result.stream?.documents.map((d) => d.value))).not.toContain('hunter');
  });

  it('only a Secret loses its data: a ConfigMap keeps data', () => {
    const t = tree();
    t.write(
      'cm.yaml',
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  k: keep-me\n',
    );
    const result = intake({ root: t.root });
    expect(JSON.stringify(result.files[0]?.documents?.[0]?.value)).toContain('keep-me');
  });
});

describe('standard input', () => {
  const stream = `${DEPLOY}---\n# a helm comment\napiVersion: v1\nkind: Service\nmetadata:\n  name: svc\n---\n`;

  it('numbers documents from 1 and gives stream lines', () => {
    const result = intakeStreamBytes(Buffer.from(stream));
    expect(result.root).toBe(STDIN);
    expect(result.files).toEqual([]);
    const docs = result.stream?.documents ?? [];
    expect(docs.map((d) => d.index)).toEqual([1, 2, 3]);
    expect(where(docs[0]?.sourceAt(['metadata', 'name']) as never)).toBe(
      '<stdin> document 1, line 4',
    );
    expect(where(docs[1]?.sourceAt(['metadata', 'name']) as never)).toBe(
      '<stdin> document 2, line 10',
    );
    expect(result.noRecognisedFiles).toBe(false);
  });

  it('empty input is the empty result', () => {
    const result = intakeStreamBytes(Buffer.from(''));
    expect(result.stream?.documents).toEqual([]);
    expect(result.noRecognisedFiles).toBe(true);
  });

  it('a stream over the limit is unchecked as <stdin>', () => {
    const result = intakeStreamBytes(Buffer.from(`${DEPLOY}#${'x'.repeat(300)}`), {
      limits: { maxFileBytes: 100, maxAliasCount: 100 },
    });
    expect(result.stream).toBeUndefined();
    expect(uncheckedPairs(result.unchecked)).toEqual(['<stdin>|over-size']);
    expect(result.noRecognisedFiles).toBe(false);
  });

  it('invalid UTF-8 on standard input is unreadable', () => {
    const result = intakeStreamBytes(Buffer.from([0x61, 0x3a, 0x20, 0xff, 0x0a]));
    expect(uncheckedPairs(result.unchecked)).toEqual(['<stdin>|unreadable']);
  });

  it('reads a descriptor in bounded chunks and stops at the limit', () => {
    const t = tree();
    const file = t.write('in.yaml', `${stream}${'#'.repeat(200_000)}\n`);
    const fd = openSync(file, 'r');
    try {
      const ok = intakeStdin({ fd });
      expect(ok.stream?.documents.length).toBe(3);
    } finally {
      closeSync(fd);
    }
    const fd2 = openSync(file, 'r');
    try {
      const over = intakeStdin({ fd: fd2, limits: { maxFileBytes: 1000, maxAliasCount: 100 } });
      expect(uncheckedPairs(over.unchecked)).toEqual(['<stdin>|over-size']);
    } finally {
      closeSync(fd2);
    }
  });

  it('with - no tripcurve.yaml is looked up; a named --config is read', () => {
    const t = tree();
    t.write('cfg/tripcurve.yaml', 'version: 1\n');
    const plain = intakeStreamBytes(Buffer.from(DEPLOY));
    expect(plain.configCandidate).toBeUndefined();
    const withConfig = intakeStreamBytes(Buffer.from(DEPLOY), {
      configPath: join(t.root, 'cfg', 'tripcurve.yaml'),
    });
    expect(withConfig.files.map((f) => f.class)).toEqual(['tripcurve-yaml']);
    // B17: shown as typed, never resolved (on macOS the real path of a temporary folder differs from the typed one)
    expect(txt(withConfig.files[0]?.canonicalPath as never)).toBe(
      join(t.root, 'cfg', 'tripcurve.yaml'),
    );
  });
});

describe('the configuration file', () => {
  it('--config may lie outside the root and replaces the root tripcurve.yaml', () => {
    const elsewhere = tree();
    elsewhere.write('mine.yaml', 'version: 1\n');
    const t = tree();
    t.write('web.yaml', DEPLOY);
    t.write('tripcurve.yaml', 'version: 1\n');
    const result = intake({ root: t.root, configPath: join(elsewhere.root, 'mine.yaml') });
    const configs = result.files.filter((f) => f.class === 'tripcurve-yaml');
    expect(configs).toHaveLength(1);
    // B17: an outside --config is shown as it was typed (the person named it), not resolved
    expect(txt(configs[0]?.canonicalPath as never)).toBe(join(elsewhere.root, 'mine.yaml'));
    expect(txt(result.configCandidate as never)).toBe(join(elsewhere.root, 'mine.yaml'));
    expect(pathsOf(result.files)).not.toContain('tripcurve.yaml');
  });

  it('B17: a typed path through a link or with dots is shown as typed, never resolved', () => {
    const elsewhere = tree();
    elsewhere.write('real/mine.yaml', 'version: 1\n');
    symlinkSync(join(elsewhere.root, 'real'), join(elsewhere.root, 'via'));
    const t = tree();
    t.write('web.yaml', DEPLOY);
    for (const typed of [
      join(elsewhere.root, 'via', 'mine.yaml'),
      `${elsewhere.root}/real/../real/mine.yaml`,
    ]) {
      const result = intake({ root: t.root, configPath: typed });
      expect(pathsOf(result.files.filter((f) => f.class === 'tripcurve-yaml'))).toEqual([typed]);
      expect(txt(result.configCandidate as never)).toBe(typed);
    }
  });

  it('B17: a typed relative path that is not under the root cannot be mistaken for a file of the root', () => {
    const t = tree();
    t.write('web.yaml', DEPLOY);
    t.write('tripcurve.yaml', 'version: 1\n');
    // the person is in another folder; `tripcurve.yaml` there is a different file from the root's
    const elsewhere = tree();
    elsewhere.write('tripcurve.yaml', 'version: 1\nworkloads: []\n');
    const previous = process.cwd();
    try {
      process.chdir(elsewhere.root);
      const result = intake({ root: t.root, configPath: 'tripcurve.yaml' });
      const shown = pathsOf(result.files.filter((f) => f.class === 'tripcurve-yaml'));
      expect(shown).toHaveLength(1);
      expect(shown[0]).not.toBe('tripcurve.yaml');
      expect(shown[0]).toBe('./tripcurve.yaml');
      expect(pathsOf(result.files)).toContain('web.yaml');
    } finally {
      process.chdir(previous);
    }
  });

  it('--config inside the root is read once under its relative name', () => {
    const t = tree();
    t.write('cfg/c.yaml', 'version: 1\n');
    const result = intake({ root: t.root, configPath: join(t.root, 'cfg', 'c.yaml') });
    expect(pathsOf(result.files)).toEqual(['cfg/c.yaml']);
    expect(result.files[0]?.class).toBe('tripcurve-yaml');
  });

  it('a --config that cannot be read is reported and still named as the candidate', () => {
    const t = tree();
    t.write('web.yaml', DEPLOY);
    const result = intake({ root: t.root, configPath: join(t.root, 'missing.yaml') });
    expect(uncheckedPairs(result.unchecked).map((s) => s.split('|')[1])).toEqual(['unreadable']);
    expect(result.configCandidate).toBeDefined();
  });

  it('a config file with a syntax error is unchecked with its line (the ConfigReader turns it into the config-error case)', () => {
    const t = tree();
    t.write('tripcurve.yaml', 'version: 1\nworkloads: [oops\n');
    const result = intake({ root: t.root });
    expect(uncheckedPairs(result.unchecked)).toEqual(['tripcurve.yaml|parse-error']);
  });
});

describe('documents: provenance by path', () => {
  const text = `${DEPLOY}  labels:\n    app: web\nspec:\n  items:\n    - a\n    - b\n`;

  it('gives the line of the value at a path', () => {
    const t = tree();
    t.write('d.yaml', text);
    const doc = intake({ root: t.root }).files[0]?.documents?.[0];
    expect(where(doc?.sourceAt(['metadata', 'name']) as never)).toBe('d.yaml:4');
    expect(where(doc?.sourceAt(['metadata', 'labels', 'app']) as never)).toBe('d.yaml:6');
    expect(where(doc?.sourceAt(['spec', 'items', 1]) as never)).toBe('d.yaml:10');
    expect(txt(doc?.sourceTextAt(['metadata', 'name']) as never)).toBe('web');
  });

  it('a path that is not there falls back to the nearest node that is, never a made-up line', () => {
    const t = tree();
    t.write('d.yaml', text);
    const doc = intake({ root: t.root }).files[0]?.documents?.[0];
    const near = where(doc?.sourceAt(['metadata', 'labels', 'nope', 'deeper']) as never);
    expect(near).toBe('d.yaml:6');
    expect(doc?.sourceTextAt(['metadata', 'labels', 'nope'])).toBeUndefined();
  });

  it('merge keys resolve and the value is reachable', () => {
    const t = tree();
    t.write(
      'm.yaml',
      `apiVersion: v1\nkind: Pod\nx-base: &b\n  image: nginx\nmetadata:\n  name: p\nspec:\n  containers:\n    - <<: *b\n      name: c\n`,
    );
    const result = intake({ root: t.root });
    expect(result.unchecked).toEqual([]);
    const value = result.files[0]?.documents?.[0]?.value as {
      spec: { containers: { image: string; name: string }[] };
    };
    expect(value.spec.containers[0]).toEqual({ image: 'nginx', name: 'c' });
    const doc = result.files[0]?.documents?.[0];
    // image came in through the merge: the line is the container's, not invented
    expect(where(doc?.sourceAt(['spec', 'containers', 0, 'image']) as never)).toMatch(
      /^m\.yaml:9$/,
    );
  });

  it('a key named __proto__ stays plain data and does not touch the prototype', () => {
    const t = tree();
    t.write('p.yaml', `${DEPLOY}__proto__:\n  polluted: yes\n`);
    const result = intake({ root: t.root });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(result.files).toHaveLength(1);
  });
});

describe('text, lines and the one parser door', () => {
  it('lineIndex holds the offset of each line start', () => {
    const t = tree();
    t.write('Dockerfile', 'a\nbb\n\nccc');
    const file = intake({ root: t.root }).files[0];
    expect(file?.lineIndex).toEqual([0, 2, 5, 6]);
  });

  it('rawTextForParser gives the text without a byte-order mark', () => {
    const t = tree();
    t.write(
      'Dockerfile',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('FROM x\n')]),
    );
    const file = intake({ root: t.root }).files[0];
    expect(rawTextForParser(file as never)).toBe('FROM x\n');
  });

  it('an InputFile does not give its text away by accident', () => {
    const t = tree();
    t.write('Dockerfile', 'FROM secret-ish\n');
    const file = intake({ root: t.root }).files[0];
    expect(String(file?.text)).toBe('[InputText]');
    expect(JSON.stringify(file?.text)).toBe('"[InputText]"');
  });
});

describe('fixed wording for the reason codes', () => {
  it('has words for every code, with limit values from the constants', () => {
    for (const code of UNCHECKED_REASONS)
      expect(uncheckedReasonWords(code).length).toBeGreaterThan(0);
    expect(uncheckedReasonWords('over-size')).toBe('larger than the 5 MB limit');
    expect(uncheckedReasonWords('over-depth')).toBe('too deeply nested');
    expect(uncheckedReasonWords('alias-limit')).toContain('100');
    expect(uncheckedReasonWords('parse-error')).toBe('YAML syntax error');
  });
});

// keep the unused-import check honest for helpers only some branches use
void names;
void mkdirSync;
