// The literal-only gunicorn.conf.py reader and the Dockerfile ENV reader. The conf reader never runs the file: hostile text must give a bounded, named result.
import { afterEach, describe, expect, it } from 'vitest';
import {
  GUNICORN_SETTING_NAMES,
  REASON_CLASS_UNKNOWN,
  REASON_CONF_NOT_LITERAL,
  REASON_CONF_OPAQUE,
  REASON_NOT_WHOLE_NUMBER,
  readDockerfileEnv,
  readGunicornConfig,
} from '../../src/parse/python/index.js';
import { cleanupPythonTrees, configFile, dockerfile, show } from '../support/python.js';

afterEach(cleanupPythonTrees);

function read(text: string) {
  const r = readGunicornConfig(configFile(text));
  return {
    shown: Object.fromEntries(GUNICORN_SETTING_NAMES.map((n) => [n, show(r.settings[n])])),
    opaqueAtLine: r.opaqueAtLine,
  };
}
const F = 'gunicorn.conf.py';

describe('literal assignments are read with their lines', () => {
  it('reads the five settings, ignoring every other name', () => {
    const r = read(
      `bind = "0.0.0.0:8000"\nworker_class = "uvicorn_worker.UvicornWorker"\nthreads = 4\nkeepalive = 75  # seconds\ngraceful_timeout = 1_0\nworkers = 2\nloglevel = 'info'\n`,
    );
    expect(r.opaqueAtLine).toBeUndefined();
    expect(r.shown).toEqual({
      workerClass: `uvicorn@${F}:2`,
      threads: `4@${F}:3`,
      keepalive: `75s@${F}:4`,
      gracefulTimeout: `10s@${F}:5`,
      workers: `2@${F}:6`,
    });
  });

  it('the last assignment wins, as in Python', () => {
    expect(read('workers = 2\nworkers = 8\n').shown.workers).toBe(`8@${F}:2`);
  });

  it('comments, blank lines, a docstring line, CRLF and a BOM are fine', () => {
    const r = read('\uFEFF# config\r\n\r\n"""Gunicorn settings."""\r\nthreads = 3\r\n');
    expect(r.opaqueAtLine).toBeUndefined();
    expect(r.shown.threads).toBe(`3@${F}:4`);
  });

  it('a setting that is not there is none; an upper-case name is not a gunicorn setting', () => {
    const r = read('KEEPALIVE = 9\nWorkers = 3\n');
    expect(r.shown.keepalive).toBe('none');
    expect(r.shown.workers).toBe('none');
  });

  it('a literal of the wrong kind for the setting is unresolved, not read as another', () => {
    const r = read('worker_class = 5\nthreads = "4"\nkeepalive = 2.5\nworkers = True\n');
    expect(r.shown.workerClass).toBe(`?${REASON_CLASS_UNKNOWN}`);
    expect(r.shown.threads).toBe(`?${REASON_NOT_WHOLE_NUMBER}`);
    expect(r.shown.keepalive).toBe(`?${REASON_NOT_WHOLE_NUMBER}`);
    expect(r.shown.workers).toBe(`?${REASON_NOT_WHOLE_NUMBER}`);
  });
});

describe('anything that is not a plain literal assignment makes the whole file unresolved', () => {
  // `own` is the setting the offending line assigns: it names its own line, the others the first code line.
  const allUnresolved = (text: string, line: number, own?: string) => {
    const r = read(text);
    expect(r.opaqueAtLine, text).toBe(line);
    for (const name of GUNICORN_SETTING_NAMES) {
      const expected = name === own ? REASON_CONF_NOT_LITERAL(line) : REASON_CONF_OPAQUE(line);
      expect(r.shown[name], `${name} in ${text}`).toBe(`?${expected}`);
    }
  };

  it.each([
    ['an import', 'import os\nworkers = 2\n', 1],
    ['a from-import', 'from os import environ\n', 1],
    ['a star import', 'from settings import *\n', 1],
    ['a call', 'print("x")\n', 1],
    ['an if', 'workers = 2\nif True:\n    workers = 4\n', 2],
    [
      'a def (hooks may set cfg)',
      'def when_ready(server):\n    server.cfg.set("keepalive", 99)\n',
      1,
    ],
    ['a class', 'class A:\n    pass\n', 1],
    ['exec', 'exec("workers = 9")\n', 1],
    ['an augmented assignment', 'workers = 2\nworkers += 2\n', 2],
    ['an attribute assignment', 'cfg.keepalive = 5\n', 1],
    ['a tuple assignment', 'a, b = 1, 2\n', 1],
    ['a chained assignment', 'a = b = 1\n', 1],
    ['an annotated assignment', 'workers: int = 4\n', 1],
    ['two statements on a line', 'workers = 2; threads = 3\n', 1, 'workers'],
    ['a continuation line', 'workers = 2 \\\n    + 1\n', 1, 'workers'],
    ['an indented line', '  workers = 2\n', 1],
    ['a decorator', '@x\ndef f(): pass\n', 1],
    ['a multi-line string', 'doc = """\nthreads = 99\n"""\n', 1],
    ['a computed value', 'workers = 2 * 2\n', 1, 'workers'],
    ['a comparison', 'workers == 2\n', 1],
    ['a walrus or lambda', 'f = lambda: 1\n', 1],
    ['a name', 'workers = N\n', 1, 'workers'],
    ['a list', 'workers = [1]\n', 1, 'workers'],
    ['an f-string', 'worker_class = f"a{b}"\n', 1, 'workerClass'],
    ['a string with an escape', 'worker_class = "a\\x41"\n', 1, 'workerClass'],
    ['hex', 'workers = 0x10\n', 1, 'workers'],
  ] as Array<[string, string, number, string?]>)('%s', (_label, text, line, own) => {
    allUnresolved(text, line, own);
  });

  it('a literal before the offending line is not trusted either', () => {
    const r = read('keepalive = 75\nimport os\n');
    expect(r.shown.keepalive).toBe(`?${REASON_CONF_OPAQUE(2)}`);
  });

  it("a computed value for a setting names that setting's own line; the others name the first code line", () => {
    const r = read('import os\nworkers = 2\nworker_class = os.environ.get("W")\n');
    expect(r.opaqueAtLine).toBe(1);
    expect(r.shown.workerClass).toBe(`?${REASON_CONF_OPAQUE(1)}`);
    const direct = read('workers = 2\nkeepalive = int(5)\nthreads = 2\n');
    expect(direct.opaqueAtLine).toBe(2);
    expect(direct.shown.keepalive).toBe(`?${REASON_CONF_NOT_LITERAL(2)}`);
    expect(direct.shown.threads).toBe(`?${REASON_CONF_OPAQUE(2)}`);
    expect(direct.shown.workers).toBe(`?${REASON_CONF_OPAQUE(2)}`);
  });
});

describe('hostile files: bounded and never run', () => {
  it('a code-injection attempt in a value is a string, never evaluated', () => {
    const r = read("worker_class = \"__import__('os').system('x')\"\n");
    expect(r.shown.workerClass).toBe(`?${REASON_CLASS_UNKNOWN}`);
  });

  it('control characters, a lone CR line break and an enormous line give a result', () => {
    expect(read('threads = 2\rworkers = 3\r').shown.workers).toBe(`3@${F}:2`);
    expect(read(`workers = ${'9'.repeat(200000)}\n`).shown.workers).toBe(
      `?${REASON_NOT_WHOLE_NUMBER}`,
    );
    expect(read(`x = "${'a'.repeat(300000)}`).opaqueAtLine).toBe(1);
    expect(read('\u0001\u0002\n').opaqueAtLine).toBe(1);
  });
});

describe('Dockerfile ENV (read only when linked)', () => {
  const env = (text: string) => {
    const r = readDockerfileEnv(dockerfile(text), [
      'GUNICORN_CMD_ARGS',
      'UVICORN_TIMEOUT_KEEP_ALIVE',
    ]);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.text ?? '?']));
  };
  it.each([
    [
      'key=value',
      'FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads 2"\n',
      { GUNICORN_CMD_ARGS: '--threads 2' },
    ],
    [
      'old form',
      'FROM python\nENV GUNICORN_CMD_ARGS --threads 2\n',
      { GUNICORN_CMD_ARGS: '--threads 2' },
    ],
    [
      'several pairs',
      'FROM x\nENV A=1 UVICORN_TIMEOUT_KEEP_ALIVE=9 B=2\n',
      { UVICORN_TIMEOUT_KEEP_ALIVE: '9' },
    ],
    ['lower case keyword', 'FROM x\nenv GUNICORN_CMD_ARGS=a\n', { GUNICORN_CMD_ARGS: 'a' }],
    [
      'continuation',
      'FROM x\nENV GUNICORN_CMD_ARGS="--threads 2" \\\n    UVICORN_TIMEOUT_KEEP_ALIVE=4\n',
      { GUNICORN_CMD_ARGS: '--threads 2', UVICORN_TIMEOUT_KEEP_ALIVE: '4' },
    ],
    [
      'a later ENV overrides',
      'FROM x\nENV GUNICORN_CMD_ARGS=a\nENV GUNICORN_CMD_ARGS=b\n',
      { GUNICORN_CMD_ARGS: 'b' },
    ],
    ['only the last stage', 'FROM x AS build\nENV GUNICORN_CMD_ARGS=a\nFROM y\n', {}],
    [
      'a stage built on an earlier stage inherits',
      'FROM x AS base\nENV GUNICORN_CMD_ARGS=a\nFROM base AS app\nENV UVICORN_TIMEOUT_KEEP_ALIVE=3\n',
      { GUNICORN_CMD_ARGS: 'a', UVICORN_TIMEOUT_KEEP_ALIVE: '3' },
    ],
    [
      'a comment line inside a continuation',
      'FROM x\nENV GUNICORN_CMD_ARGS=a \\\n# note\n    UVICORN_TIMEOUT_KEEP_ALIVE=5\n',
      { GUNICORN_CMD_ARGS: 'a', UVICORN_TIMEOUT_KEEP_ALIVE: '5' },
    ],
  ])('%s', (_l, text, expected) => {
    expect(env(text)).toEqual(expected);
  });

  it.each([
    ['a variable reference', 'FROM x\nENV GUNICORN_CMD_ARGS="--threads $N"\n'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile variable reference, not a template
    ['a braced reference', 'FROM x\nENV GUNICORN_CMD_ARGS=--threads=${N}\n'],
    ['a backslash escape', 'FROM x\nENV GUNICORN_CMD_ARGS="a\\"b"\n'],
    ['a backtick', 'FROM x\nENV GUNICORN_CMD_ARGS=`x`\n'],
    ['an unterminated quote', 'FROM x\nENV GUNICORN_CMD_ARGS="open\n'],
    ['quotes in the old form', 'FROM x\nENV GUNICORN_CMD_ARGS "a b"\n'],
  ])('%s is a value that is not read', (_l, text) => {
    expect(env(text)).toEqual({ GUNICORN_CMD_ARGS: '?' });
  });

  it('a parser directive that changes how the file is read makes every wanted name unread', () => {
    expect(env('# escape=`\nFROM x\nENV GUNICORN_CMD_ARGS=a\n')).toEqual({
      GUNICORN_CMD_ARGS: '?',
      UVICORN_TIMEOUT_KEEP_ALIVE: '?',
    });
  });

  it('an ENV before any FROM, and an empty file, give nothing', () => {
    expect(env('ENV GUNICORN_CMD_ARGS=a\n')).toEqual({});
    expect(env('# nothing\n')).toEqual({});
  });

  it('a self-referencing FROM does not loop', () => {
    expect(env('FROM app AS app\nENV GUNICORN_CMD_ARGS=a\n')).toEqual({ GUNICORN_CMD_ARGS: 'a' });
  });
});

describe('a PEP 263 coding cookie', () => {
  const CODING = 'gunicorn.conf.py declares a source encoding that tripcurve does not read';
  const opaque = (text: string) => {
    const r = read(text);
    return { at: r.opaqueAtLine, all: new Set(Object.values(r.shown)) };
  };

  it.each([
    [
      'unicode_escape on line 1',
      '# coding: unicode_escape\n# \\nkeepalive = 99\nworker_class = "sync"\n',
    ],
    [
      'utf-7 on line 2 after a shebang',
      '#!/usr/bin/env python\n# -*- coding: utf-7 -*-\n# +AAo-worker_class = "uvicorn_worker.UvicornWorker"\n',
    ],
    ['utf-16', '# coding=utf-16\nworkers = 1\n'],
    ['cp1252', '# -*- coding: cp1252 -*-\nworkers = 1\n'],
    ['an unknown name', '# coding: nosuchcodec\nworkers = 1\n'],
    ['utf-8-sig', '# coding: utf-8-sig\nworkers = 1\n'],
    ['fileencoding in a vim line', '# vim: set fileencoding=utf-7 :\nworkers = 1\n'],
    ['rot13', '# coding: rot13\nworkers = 1\n'],
  ])('%s makes every setting of the file UNRESOLVED', (_l, text) => {
    const { all } = opaque(text);
    expect([...all]).toEqual([`?${CODING}`]);
  });

  it.each([
    '# -*- coding: utf-8 -*-',
    '# coding: UTF-8',
    '# coding=utf8',
    '# coding: UTF_8',
    '# coding: ascii',
    '# coding: latin-1',
    '# coding: Latin_1',
    '# coding: latin1',
    '# coding: iso-8859-1',
    '# coding: ISO_8859-1',
    '# vim: set fileencoding=iso8859-1 :',
  ])('the cookie %j is read as ordinary text', (cookie) => {
    const r = read(`${cookie}\nworkers = 3\n`);
    expect(r.opaqueAtLine).toBeUndefined();
    expect(r.shown.workers).toBe(`3@gunicorn.conf.py:2`);
  });

  it('a cookie on line 3 or later is not a cookie (Python looks at two lines only)', () => {
    const r = read('# one\n# two\n# coding: utf-7\nworkers = 3\n');
    expect(r.opaqueAtLine).toBeUndefined();
  });

  it('the reason names the line of the cookie', () => {
    expect(opaque('\n# coding: utf-7\nworkers = 3\n').at).toBe(2);
  });
});
