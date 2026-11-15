// Where a setting is written relative to `listen` (bolt B3). Only a value in place before the
// server listens was measured (measure/results/2026-11-11-b3.jsonl), so the reader says which
// settings it cannot show to be written before listen. It never runs the program: the order is
// the order in the text, within one function body, and anything else is "not shown".
import { afterEach, describe, expect, it } from 'vitest';
import { inputText, inputTextEquals } from '../../src/core/index.js';
import { intake } from '../../src/parse/intake/index.js';
import { type NodeServerSettings, readNodeServer } from '../../src/parse/node/index.js';
import { makeTree, type Tree } from '../support/tmp-tree.js';

const trees: Tree[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) t.cleanup();
});

function read(files: Record<string, string>, entry = 'server.js'): NodeServerSettings {
  const t = makeTree();
  trees.push(t);
  for (const [path, text] of Object.entries(files)) t.write(path, text);
  const r = intake({ root: t.root });
  const file = r.files.find((f) => inputTextEquals(f.canonicalPath, inputText(entry)));
  if (!file) throw new Error(`no file ${entry}`);
  return readNodeServer(r, file);
}

const HEAD = "const http = require('node:http');\nconst server = http.createServer(() => {});\n";

describe('settings written before listen in the same function body', () => {
  it('an assignment before listen at the top of the file', () => {
    const s = read({
      'server.js': `${HEAD}server.keepAliveTimeout = 65000;\nserver.listen(8080);\n`,
    });
    expect(s.notBeforeListen).toEqual([]);
  });

  it('an assignment before listen inside a function that also calls listen', () => {
    const s = read({
      'server.js': `function main() {\n  const server = require('node:http').createServer(() => {});\n  server.keepAliveTimeout = 65000;\n  server.listen(8080);\n}\nmain();\n`,
    });
    expect(s.notBeforeListen).toEqual([]);
  });

  it('an options literal is evaluated when the server is made: always before listen', () => {
    const s = read({
      'server.js': `const server = require('node:http').createServer({ keepAliveTimeout: 65000 }, () => {});\nserver.listen(8080);\n`,
    });
    expect(s.notBeforeListen).toEqual([]);
    const after = read({
      'server.js': `const server = require('node:http').createServer({ keepAliveTimeout: 65000 }, () => {});\nserver.listen(8080);\nserver.headersTimeout = 1;\n`,
    });
    expect(after.notBeforeListen).toEqual(['headersTimeout']);
  });

  it('Object.assign before listen counts like an assignment before listen', () => {
    const s = read({
      'server.js': `${HEAD}Object.assign(server, { keepAliveTimeout: 65000 });\nserver.listen(8080);\n`,
    });
    expect(s.notBeforeListen).toEqual([]);
  });
});

describe('settings not shown to be written before listen', () => {
  it.each([
    ['after listen', `${HEAD}server.listen(8080);\nserver.keepAliveTimeout = 65000;\n`],
    [
      'in a callback',
      `${HEAD}server.on('listening', () => {\n  server.keepAliveTimeout = 65000;\n});\nserver.listen(8080);\n`,
    ],
    [
      'in a function the file calls later',
      `${HEAD}function tune() {\n  server.keepAliveTimeout = 65000;\n}\nserver.listen(8080);\ntune();\n`,
    ],
    [
      'with a listen in another function than the assignment',
      `${HEAD}function start() {\n  server.listen(8080);\n}\nserver.keepAliveTimeout = 65000;\nstart();\n`,
    ],
    [
      'when one of two listen calls comes first',
      `${HEAD}server.listen(1);\nserver.keepAliveTimeout = 65000;\nserver.listen(2);\n`,
    ],
  ])('%s', (_name, text) => {
    expect(read({ 'server.js': text }).notBeforeListen).toEqual(['keepAliveTimeout']);
  });

  it('a setting written in an imported file with no listen cannot be tied to the listening server', () => {
    const s = read({
      'server.js': `const { tune } = require('./tune');\n${HEAD}tune(server);\nserver.listen(8080);\n`,
      'tune.js': 'exports.tune = (s) => {\n  s.keepAliveTimeout = 65000;\n};\n',
    });
    expect(s.unattributed).toEqual(['keepAliveTimeout']);
  });

  it('one late write among several marks that setting, and only that one', () => {
    const s = read({
      'server.js': `${HEAD}server.keepAliveTimeout = 65000;\nserver.listen(8080);\nserver.headersTimeout = 66000;\n`,
    });
    expect(s.notBeforeListen).toEqual(['headersTimeout']);
  });

  it('lists names in the fixed setting order', () => {
    const s = read({
      'server.js': `${HEAD}server.listen(8080);\nserver.headersTimeout = 1;\nserver.keepAliveTimeoutBuffer = 0;\nserver.keepAliveTimeout = 7000;\n`,
    });
    expect(s.notBeforeListen).toEqual([
      'keepAliveTimeout',
      'keepAliveTimeoutBuffer',
      'headersTimeout',
    ]);
  });
});

describe('settings not tied to the one listening server', () => {
  it.each([
    ['in a file with no listen at all', `${HEAD}server.keepAliveTimeout = 65000;\n`],
    [
      'on another server of the same file',
      `${HEAD}const other = require('node:http').createServer(() => {});\nother.keepAliveTimeout = 65000;\nserver.listen(8080);\n`,
    ],
    [
      'on an unrelated object',
      `${HEAD}const agent = {};\nagent.keepAliveTimeout = 65000;\nserver.listen(8080);\n`,
    ],
    [
      'on an alias',
      `${HEAD}const s = server;\ns.keepAliveTimeout = 65000;\nserver.listen(8080);\n`,
    ],
    [
      'on the value Express app.listen returns',
      "const app = require('express')();\nconst server = app.listen(8080);\nserver.keepAliveTimeout = 65000;\n",
    ],
    [
      'in the options of a server that does not listen',
      `${HEAD}const other = require('node:http').createServer({ keepAliveTimeout: 65000 }, () => {});\nserver.listen(8080);\n`,
    ],
    [
      'when two servers listen (neither is the one that serves)',
      `${HEAD}const other = require('node:http').createServer(() => {});\nserver.keepAliveTimeout = 65000;\nserver.listen(1);\nother.listen(2);\n`,
    ],
  ])('%s', (_name, text) => {
    expect(read({ 'server.js': text }).unattributed).toEqual(['keepAliveTimeout']);
  });

  it('a setting on the listening server is attributed', () => {
    const s = read({
      'server.js': `${HEAD}server.keepAliveTimeout = 65000;\nserver.listen(8080);\n`,
    });
    expect(s.unattributed).toEqual([]);
    expect(s.notBeforeListen).toEqual([]);
  });

  it.each([
    ['if', 'if (process.env.PROD) { server.keepAliveTimeout = 65000; }\n'],
    ['&&', 'process.env.PROD && (server.keepAliveTimeout = 65000);\n'],
    ['try', 'try { server.keepAliveTimeout = 65000; } catch (e) {}\n'],
    ['for', 'for (const x of []) { server.keepAliveTimeout = 65000; }\n'],
    ['a function that is never called', 'function f() {\n  server.keepAliveTimeout = 65000;\n}\n'],
  ])('a write under %s is tied to the server but not before listen', (_name, write) => {
    const s = read({ 'server.js': `${HEAD}${write}server.listen(8080);\n` });
    expect(s.unattributed).toEqual([]);
    expect(s.notBeforeListen).toEqual(['keepAliveTimeout']);
  });

  it('an https server is flagged', () => {
    expect(
      read({
        'server.js':
          "const server = require('node:https').createServer(() => {});\nserver.listen(1);\n",
      }).usesHttps,
    ).toBe(true);
    expect(read({ 'server.js': `${HEAD}server.listen(1);\n` }).usesHttps).toBe(false);
  });
});
