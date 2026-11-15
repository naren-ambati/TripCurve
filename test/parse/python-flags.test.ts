// The gunicorn and uvicorn flag readers: every form that is read, every
// near-form that is NOT read and must be unresolved rather than skipped, and hostile input.
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText } from '../../src/core/index.js';
import {
  GUNICORN_CMD_ARGS,
  type GunicornCommandReading,
  pythonServerProgram,
  REASON_CLASS_UNKNOWN,
  REASON_CMD_ARGS_CONFIG,
  REASON_CMD_ARGS_FORM,
  REASON_CMD_ARGS_REFERENCE,
  REASON_ENV_FILE,
  REASON_ENV_FROM_GUNICORN,
  REASON_ENV_FROM_UVICORN,
  REASON_EXPANSION,
  REASON_FLAG_FORM,
  REASON_NO_VALUE,
  REASON_NOT_WHOLE_NUMBER,
  readPythonCommand,
  type UvicornCommandReading,
} from '../../src/parse/python/index.js';
import { shlexSplit } from '../../src/parse/python/shell-words.js';
import { cleanupPythonTrees, containerFrom, dockerfile, showAll } from '../support/python.js';

afterEach(cleanupPythonTrees);

/** `command: [..]` as a flow list on file line 14, plus optional extra container lines. */
function gunicorn(words: string[], extra = ''): GunicornCommandReading {
  const body = `          command: [${words.map((w) => JSON.stringify(w)).join(', ')}]${extra === '' ? '' : `\n${extra}`}`;
  const reading = readPythonCommand(containerFrom(body));
  if (reading?.program !== 'gunicorn') throw new Error('not gunicorn');
  return reading;
}
function uvicorn(words: string[], extra = ''): UvicornCommandReading {
  const body = `          command: [${words.map((w) => JSON.stringify(w)).join(', ')}]${extra === '' ? '' : `\n${extra}`}`;
  const reading = readPythonCommand(containerFrom(body));
  if (reading?.program !== 'uvicorn') throw new Error('not uvicorn');
  return reading;
}
const L = 'app.yaml:14';
const ENV = (name: string, value: string) =>
  `          env:\n            - name: ${name}\n              value: ${JSON.stringify(value)}`;

describe('which program a command runs', () => {
  it.each([
    [['gunicorn', 'app:app'], 'gunicorn', 1],
    [['/usr/local/bin/gunicorn', 'app:app'], 'gunicorn', 1],
    [['python', '-m', 'gunicorn', 'app:app'], 'gunicorn', 3],
    [['python3.12', '-m', 'uvicorn', 'app:app'], 'uvicorn', 3],
    [['uvicorn', 'app:app'], 'uvicorn', 1],
  ] as const)('%j is %s', (words, program, from) => {
    expect(pythonServerProgram([...words])).toEqual({ program, flagsFrom: from });
  });

  it.each([
    [['poetry', 'run', 'gunicorn']],
    [['sh', '-c', 'gunicorn app:app']],
    [['python', '-u', '-m', 'gunicorn']],
    [['gunicorn2', 'app']],
    [['python', 'gunicorn']],
    [[]],
  ] as const)('%j is not read', (words) => {
    expect(pythonServerProgram([...words])).toBeUndefined();
  });
});

describe('gunicorn flags with their lines', () => {
  it('reads -k, --threads, --keep-alive, --graceful-timeout and -w in every long and short spelling', () => {
    const r = gunicorn([
      'gunicorn',
      'app:app',
      '-k',
      'uvicorn_worker.UvicornWorker',
      '--threads=3',
      '--keep-alive',
      '75',
      '--graceful-timeout=20',
      '-w4',
    ]);
    expect(showAll(r.settings.workerClass)).toEqual([`command:uvicorn@${L}`]);
    expect(showAll(r.settings.threads)).toEqual([`command:3@${L}`]);
    expect(showAll(r.settings.keepalive)).toEqual([`command:75s@${L}`]);
    expect(showAll(r.settings.gracefulTimeout)).toEqual([`command:20s@${L}`]);
    expect(showAll(r.settings.workers)).toEqual([`command:4@${L}`]);
  });

  it('-kgthread and --worker-class=gevent', () => {
    expect(showAll(gunicorn(['gunicorn', '-kgthread', 'a:a']).settings.workerClass)).toEqual([
      `command:gthread@${L}`,
    ]);
    expect(showAll(gunicorn(['gunicorn', '--worker-class=gevent']).settings.workerClass)).toEqual([
      `command:gevent@${L}`,
    ]);
  });

  it('a value on its own line in a block list keeps that line', () => {
    const body =
      '          command:\n            - gunicorn\n            - -k\n            - sync\n            - --keep-alive\n            - "9"';
    const r = readPythonCommand(containerFrom(body)) as GunicornCommandReading;
    expect(showAll(r.settings.workerClass)).toEqual(['command:sync@app.yaml:17']);
    expect(showAll(r.settings.keepalive)).toEqual(['command:9s@app.yaml:19']);
  });

  it('a command in `command` and the flags in `args` are read together', () => {
    const r = readPythonCommand(
      containerFrom('          command: ["gunicorn"]\n          args: ["-k", "sync", "app:app"]'),
    ) as GunicornCommandReading;
    expect(showAll(r.settings.workerClass)).toEqual(['command:sync@app.yaml:15']);
  });

  it('no flag at all gives no contribution (the caller decides what that means)', () => {
    const r = gunicorn(['gunicorn', 'app:app', '-b', '0.0.0.0:8000', '--access-logfile', '-']);
    for (const list of Object.values(r.settings)) expect(list).toEqual([]);
  });

  it('flags after -- are positional', () => {
    expect(showAll(gunicorn(['gunicorn', '--', '-k', 'gthread']).settings.workerClass)).toEqual([]);
  });

  it('a class is matched exactly, and only the two uvicorn spellings are the uvicorn worker', () => {
    const cls = (c: string) => showAll(gunicorn(['gunicorn', '-k', c]).settings.workerClass);
    expect(cls('uvicorn.workers.UvicornWorker')).toEqual([`command:uvicorn@${L}`]);
    expect(cls('uvicorn.workers.UvicornH11Worker')).toEqual([`command:?${REASON_CLASS_UNKNOWN}`]);
    expect(cls('uvicorn')).toEqual([`command:?${REASON_CLASS_UNKNOWN}`]);
    expect(cls('GTHREAD')).toEqual([`command:?${REASON_CLASS_UNKNOWN}`]);
    expect(cls('my.pkg.Worker')).toEqual([`command:?${REASON_CLASS_UNKNOWN}`]);
  });
});

describe('forms that are not read are unresolved, never skipped', () => {
  it.each([
    ['not a number', ['--keep-alive', 'ten'], REASON_NOT_WHOLE_NUMBER],
    ['a negative number', ['--keep-alive', '-1'], REASON_NOT_WHOLE_NUMBER],
    ['a fraction', ['--keep-alive=2.5'], REASON_NOT_WHOLE_NUMBER],
    ['beyond the safe integers', ['--keep-alive', '99999999999999999999'], REASON_NOT_WHOLE_NUMBER],
    ['an empty value', ['--keep-alive='], REASON_NOT_WHOLE_NUMBER],
    ['a reference', ['--keep-alive', '$(KA)'], REASON_EXPANSION],
    ['a reference inside the flag', ['--keep-alive=$(KA)'], REASON_EXPANSION],
    ['no value', ['--keep-alive'], REASON_NO_VALUE],
    ['a flag as the value', ['--keep-alive', '--threads', '2'], REASON_NO_VALUE],
  ])('keep-alive with %s', (_label, flags, reason) => {
    const r = gunicorn(['gunicorn', ...flags]);
    expect(showAll(r.settings.keepalive)).toEqual([`command:?${reason}`]);
  });

  it.each([
    ['an abbreviation', '--keep', 'keepalive'],
    ['a shorter abbreviation', '--kee', 'keepalive'],
    ['an abbreviated threads', '--thr', 'threads'],
    ['an abbreviated graceful timeout', '--graceful', 'gracefulTimeout'],
  ] as const)('%s of a long flag is not read', (_l, flag, setting) => {
    const r = gunicorn(['gunicorn', flag, '9']);
    expect(showAll(r.settings[setting])).toEqual([`command:?${REASON_FLAG_FORM}`]);
  });

  it('--w could be --workers or --worker-class: both are unresolved', () => {
    const r = gunicorn(['gunicorn', '--w', '3']);
    expect(showAll(r.settings.workers)).toEqual([`command:?${REASON_FLAG_FORM}`]);
    expect(showAll(r.settings.workerClass)).toEqual([`command:?${REASON_FLAG_FORM}`]);
  });

  it('-k=gthread and a cluster such as -Dk are not read', () => {
    expect(showAll(gunicorn(['gunicorn', '-k=gthread']).settings.workerClass)).toEqual([
      `command:?${REASON_FLAG_FORM}`,
    ]);
    expect(showAll(gunicorn(['gunicorn', '-Dk', 'gthread']).settings.workerClass)).toEqual([
      `command:?${REASON_FLAG_FORM}`,
    ]);
    expect(showAll(gunicorn(['gunicorn', '-Dw', '3']).settings.workers)).toEqual([
      `command:?${REASON_FLAG_FORM}`,
    ]);
  });

  it('a word that could expand into any flag makes every setting unresolved', () => {
    for (const word of ['$(FLAGS)', '--$(X)', '-$(Y)']) {
      const r = gunicorn(['gunicorn', 'app:app', word]);
      for (const list of Object.values(r.settings)) {
        expect(showAll(list), word).toEqual([`command:?${REASON_EXPANSION}`]);
      }
    }
  });

  it('a reference inside an app module cannot become a flag and changes nothing', () => {
    const r = gunicorn(['gunicorn', 'app:$(APP)']);
    for (const list of Object.values(r.settings)) expect(list).toEqual([]);
  });

  it('the same flag twice is kept as two contributions (the resolver decides)', () => {
    const r = gunicorn(['gunicorn', '--keep-alive', '3', '--keep-alive', '5']);
    expect(showAll(r.settings.keepalive)).toEqual([`command:3s@${L}`, `command:5s@${L}`]);
  });
});

describe('-c, --config and --chdir', () => {
  it('the config file path is recorded with its line, the last -c does not hide a second', () => {
    expect(gunicorn(['gunicorn', '-c', 'conf/g.py']).configArg).toMatchObject({
      kind: 'path',
      path: 'conf/g.py',
    });
    expect(gunicorn(['gunicorn', '--config=g.py']).configArg).toMatchObject({
      kind: 'path',
      path: 'g.py',
    });
    expect(gunicorn(['gunicorn', '-cg.py']).configArg).toMatchObject({
      kind: 'path',
      path: 'g.py',
    });
  });

  it.each([
    ['python:mod', 'python:my.config'],
    ['file:', 'file:g.py'],
    ['an empty value', ''],
    ['a reference', '$(CONF)'],
  ])('%s is not a path', (_l, value) => {
    expect(gunicorn(['gunicorn', '-c', value]).configArg?.kind).toBe('not-a-path');
  });

  it('two -c flags: which one applies is not measured', () => {
    expect(gunicorn(['gunicorn', '-c', 'a.py', '-c', 'b.py']).configArg?.kind).toBe('not-a-path');
  });

  it('-c with no value, and an abbreviated --conf', () => {
    expect(gunicorn(['gunicorn', '-c']).configArg?.kind).toBe('no-value');
    expect(gunicorn(['gunicorn', '--conf', 'a.py']).configArg?.kind).toBe('not-a-path');
  });

  it('--chdir is recorded, in the command and in GUNICORN_CMD_ARGS', () => {
    expect(gunicorn(['gunicorn', '--chdir', '/app']).chdirSource).toBeDefined();
    expect(gunicorn(['gunicorn', '--chdir=/app']).chdirSource).toBeDefined();
    expect(
      gunicorn(['gunicorn'], ENV(GUNICORN_CMD_ARGS, '--chdir /app')).chdirSource,
    ).toBeDefined();
    expect(gunicorn(['gunicorn']).chdirSource).toBeUndefined();
  });
});

describe('GUNICORN_CMD_ARGS from a literal env value only', () => {
  it('is read with the env entry as its source', () => {
    const r = gunicorn(
      ['gunicorn', 'app:app'],
      ENV(GUNICORN_CMD_ARGS, '--threads 4 --keep-alive "75"'),
    );
    expect(showAll(r.settings.threads)).toEqual(['cmd-args-env:4@app.yaml:16']);
    expect(showAll(r.settings.keepalive)).toEqual(['cmd-args-env:75s@app.yaml:16']);
  });

  it('is split like shlex: quotes, a single-quoted value, an escaped space', () => {
    const r = gunicorn(
      ['gunicorn'],
      ENV(GUNICORN_CMD_ARGS, "--worker-class 'gthread' --keep-alive 5"),
    );
    expect(showAll(r.settings.workerClass)).toEqual(['cmd-args-env:gthread@app.yaml:16']);
  });

  it('a valueFrom reference is unresolved for every setting', () => {
    const body = `          env:\n            - name: GUNICORN_CMD_ARGS\n              valueFrom:\n                configMapKeyRef: {name: c, key: k}`;
    const r = gunicorn(['gunicorn'], body);
    for (const list of Object.values(r.settings)) {
      expect(showAll(list)).toEqual([`cmd-args-env:?${REASON_CMD_ARGS_REFERENCE}`]);
    }
  });

  it('an envFrom could set it: every setting is unresolved, unless the manifest env sets it', () => {
    const from = gunicorn(
      ['gunicorn'],
      '          envFrom:\n            - configMapRef: {name: c}',
    );
    for (const list of Object.values(from.settings)) {
      expect(showAll(list)).toEqual([`cmd-args-env:?${REASON_ENV_FROM_GUNICORN}`]);
    }
    const both = gunicorn(
      ['gunicorn'],
      `          envFrom:\n            - configMapRef: {name: c}\n${ENV(GUNICORN_CMD_ARGS, '--threads 2').replace('          env:', '          env:')}`,
    );
    expect(showAll(both.settings.threads)).toEqual(['cmd-args-env:2@app.yaml:18']);
  });

  it('a value shlex cannot split (an open quote, a trailing backslash) is not read', () => {
    for (const text of ['--keep-alive "5', '--keep-alive 5\\']) {
      const r = gunicorn(['gunicorn'], ENV(GUNICORN_CMD_ARGS, text));
      for (const list of Object.values(r.settings)) {
        expect(showAll(list), text).toEqual([`cmd-args-env:?${REASON_CMD_ARGS_FORM}`]);
      }
    }
  });

  it('a $(...) reference could add flags: every setting is unresolved', () => {
    const r = gunicorn(['gunicorn'], ENV(GUNICORN_CMD_ARGS, '--threads 2 $(MORE)'));
    for (const list of Object.values(r.settings)) {
      expect(showAll(list)).toEqual([`cmd-args-env:?${REASON_EXPANSION}`]);
    }
  });

  it('-c inside GUNICORN_CMD_ARGS makes every setting unresolved (not measured)', () => {
    const r = gunicorn(['gunicorn'], ENV(GUNICORN_CMD_ARGS, '-c other.py --threads 2'));
    for (const list of Object.values(r.settings)) {
      expect(showAll(list)).toEqual([`cmd-args-env:?${REASON_CMD_ARGS_CONFIG}`]);
    }
    expect(r.configArg).toBeUndefined();
  });

  it('the variable twice in env is not read', () => {
    const body = `${ENV(GUNICORN_CMD_ARGS, '--threads 2')}\n            - name: GUNICORN_CMD_ARGS\n              value: "--threads 3"`;
    const r = gunicorn(['gunicorn'], body);
    expect(showAll(r.settings.threads)).toEqual([`cmd-args-env:?${REASON_CMD_ARGS_FORM}`]);
  });

  it('a Dockerfile ENV is read only when the Dockerfile is passed (linked), and the manifest env replaces it', () => {
    const c = containerFrom('          command: ["gunicorn"]');
    const env = {
      GUNICORN_CMD_ARGS: { text: '--threads 5', source: fileSource(inputText('x'), 3) },
    };
    expect(showAll((readPythonCommand(c) as GunicornCommandReading).settings.threads)).toEqual([]);
    const withImage = readPythonCommand(c, env) as GunicornCommandReading;
    expect(showAll(withImage.settings.threads)).toEqual(['dockerfile-env:5@x:3']);
    const shadowed = readPythonCommand(
      containerFrom(`          command: ["gunicorn"]\n${ENV(GUNICORN_CMD_ARGS, '--threads 2')}`),
      env,
    ) as GunicornCommandReading;
    expect(showAll(shadowed.settings.threads)).toEqual(['cmd-args-env:2@app.yaml:16']);
    const df = dockerfile('FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads $N"\n');
    expect(df.class).toBe('dockerfile');
  });
});

describe('uvicorn alone', () => {
  it('reads --timeout-keep-alive in both spellings, with its line', () => {
    expect(
      showAll(uvicorn(['uvicorn', 'app:app', '--timeout-keep-alive', '10']).keepalive),
    ).toEqual([`command:10s@${L}`]);
    expect(showAll(uvicorn(['uvicorn', '--timeout-keep-alive=7', 'app:app']).keepalive)).toEqual([
      `command:7s@${L}`,
    ]);
    expect(showAll(uvicorn(['python', '-m', 'uvicorn', 'a:a']).keepalive)).toEqual([]);
  });

  it('reads UVICORN_TIMEOUT_KEEP_ALIVE from a literal env value', () => {
    const r = uvicorn(['uvicorn', 'a:a'], ENV('UVICORN_TIMEOUT_KEEP_ALIVE', '30'));
    expect(showAll(r.keepalive)).toEqual(['cmd-args-env:30s@app.yaml:16']);
  });

  it.each([
    ['not a number', ['--timeout-keep-alive', 'x'], REASON_NOT_WHOLE_NUMBER],
    ['a reference', ['--timeout-keep-alive', '$(T)'], REASON_EXPANSION],
    ['no value', ['--timeout-keep-alive'], REASON_NO_VALUE],
    ['an abbreviation', ['--timeout-keep', '5'], REASON_FLAG_FORM],
    ['an env file', ['--env-file', '.env'], REASON_ENV_FILE],
    ['a word that could expand to a flag', ['$(F)'], REASON_EXPANSION],
  ])('%s is unresolved', (_l, flags, reason) => {
    expect(showAll(uvicorn(['uvicorn', 'a:a', ...flags]).keepalive)).toEqual([
      `command:?${reason}`,
    ]);
  });

  it('a valueFrom, an envFrom and UVICORN_ENV_FILE are unresolved', () => {
    const ref = uvicorn(
      ['uvicorn'],
      '          env:\n            - name: UVICORN_TIMEOUT_KEEP_ALIVE\n              valueFrom:\n                secretKeyRef: {name: s, key: k}',
    );
    expect(showAll(ref.keepalive)).toHaveLength(1);
    expect(showAll(ref.keepalive)[0]).toContain(
      '?UVICORN_TIMEOUT_KEEP_ALIVE comes from a reference',
    );
    const from = uvicorn(['uvicorn'], '          envFrom:\n            - configMapRef: {name: c}');
    expect(showAll(from.keepalive)).toEqual([`cmd-args-env:?${REASON_ENV_FROM_UVICORN}`]);
    const file = uvicorn(['uvicorn'], ENV('UVICORN_ENV_FILE', '/x'));
    expect(showAll(file.keepalive)).toEqual([`cmd-args-env:?${REASON_ENV_FILE}`]);
  });
});

describe('what is not a Python server command', () => {
  it('args alone, an unresolved list and another program give no reading', () => {
    expect(readPythonCommand(containerFrom('          args: ["gunicorn"]'))).toBeUndefined();
    expect(readPythonCommand(containerFrom('          command: ["node", "x.js"]'))).toBeUndefined();
    expect(readPythonCommand(containerFrom('          command: ["gunicorn", 5]'))).toBeUndefined();
    expect(readPythonCommand(containerFrom('          command: "gunicorn"'))).toBeUndefined();
  });
});

describe('shlexSplit', () => {
  it.each([
    ['a b  c', ['a', 'b', 'c']],
    ['a "b c" d', ['a', 'b c', 'd']],
    ["a 'b \"c' d", ['a', 'b "c', 'd']],
    ['a\\ b', ['a b']],
    ['"a\\"b"', ['a"b']],
    ['"a\\nb"', ['a\\nb']],
    ['', []],
    ['  ', []],
    ['a""b', ['ab']],
    ['--x=$HOME', ['--x=$HOME']],
  ])('%j', (text, words) => {
    expect(shlexSplit(text)).toEqual(words);
  });

  it.each(['"open', "'open", 'trailing\\'])('%j is not splittable', (text) => {
    expect(shlexSplit(text)).toBeUndefined();
  });
});
