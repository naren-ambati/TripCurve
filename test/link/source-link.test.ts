import { describe, expect, it } from 'vitest';
import { inputText, inputTextEquals } from '../../src/core/index.js';
import { basenameOf, nodeEntryFile, npmScriptName, packageScript } from '../../src/link/index.js';
import { intake } from '../../src/parse/index.js';
import { makeTree } from '../support/tmp-tree.js';

describe('nodeEntryFile: the literal file of a node command', () => {
  it.each([
    [['node', 'src/server.ts'], 'src/server.ts'],
    [['/usr/local/bin/node', 'server.js', '--port', '80'], 'server.js'],
    [['nodejs', 'a.js'], 'a.js'],
    [['node', '--require', './x.js', 'main.js'], 'main.js'],
    [['node', '-r', './x.js', 'main.js'], 'main.js'],
    [['node', '--enable-source-maps', 'main.js'], 'main.js'],
    [['node', '--', 'main.js'], 'main.js'],
  ])('%j -> %s', (words, file) => {
    expect(nodeEntryFile(words)).toEqual({ ok: true, file });
  });

  it.each([
    [['python', 'app.py'], 'not-a-node-command'],
    [['sh', '-c', 'node x.js'], 'not-a-node-command'],
    [[], 'not-a-node-command'],
    [['node'], 'command-names-no-file'],
    [['node', '-e', 'console.log(1)'], 'command-names-no-file'],
    [['node', '--eval', 'x'], 'command-names-no-file'],
    [['node', '--'], 'command-names-no-file'],
    [['node', '--require'], 'command-names-no-file'],
  ])('%j -> %s', (words, reasonCode) => {
    expect(nodeEntryFile(words)).toEqual({ ok: false, reasonCode });
  });
});

describe('npmScriptName', () => {
  it.each([
    [['npm', 'start'], 'start'],
    [['npm', 'run', 'serve'], 'serve'],
    [['/usr/bin/npm', 'run-script', 'x'], 'x'],
  ])('%j -> %s', (words, name) => {
    expect(npmScriptName(words)).toBe(name);
  });
  it.each([
    [['npm']],
    [['npm', 'run']],
    [['npm', 'run', '--silent', 'x']],
    [['yarn', 'start']],
    [['npm', 'test']],
    [[]],
  ])('%j names no script', (words) => {
    expect(npmScriptName(words)).toBeUndefined();
  });
});

describe('basenameOf and packageScript', () => {
  it('basenameOf', () => {
    expect(basenameOf('/a/b/node')).toBe('node');
    expect(basenameOf('node')).toBe('node');
  });

  it('packageScript reads a plain string script and nothing else', () => {
    const tree = makeTree();
    try {
      tree.write('ok/package.json', '{"scripts":{"start":"node a.js","n":5}}');
      tree.write('arr/package.json', '{"scripts":["x"]}');
      tree.write('inherit/package.json', '{"scripts":{}}');
      tree.write('bad/package.json', '{not json');
      tree.write('top/package.json', '[1]');
      const result = intake({ root: tree.root });
      const pkg = (dir: string) => {
        const f = result.files.find((x) =>
          inputTextEquals(x.canonicalPath, inputText(`${dir}/package.json`)),
        );
        if (!f) throw new Error(`no ${dir}`);
        return f;
      };
      expect(packageScript(pkg('ok'), 'start')).toBe('node a.js');
      expect(packageScript(pkg('ok'), 'n')).toBeUndefined();
      expect(packageScript(pkg('ok'), 'missing')).toBeUndefined();
      expect(packageScript(pkg('ok'), 'constructor')).toBeUndefined();
      expect(packageScript(pkg('arr'), 'start')).toBeUndefined();
      expect(packageScript(pkg('inherit'), 'toString')).toBeUndefined();
      expect(packageScript(pkg('top'), 'start')).toBeUndefined();
    } finally {
      tree.cleanup();
    }
  });
});
