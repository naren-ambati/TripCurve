// Linking a gunicorn.conf.py to a workload: explicit evidence only, the same
// working-directory rules as the Node command file, a link and -c that disagree are not decided.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees } from '../support/analyse.js';
import { cleanupPythonTrees, pythonApp } from '../support/python.js';
import { txt } from '../support/render.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const LINK = (path: string) =>
  `version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    gunicorn_config: ${path}\n`;

function linkOf(container: string, extra: Record<string, string | null> = {}) {
  const chain = pythonApp(container, extra).graph.workloadChains[0];
  if (chain?.gunicornConfig === undefined) throw new Error('no gunicorn link');
  const l = chain.gunicornConfig;
  return l.state === 'linked'
    ? {
        state: l.state,
        by: l.by,
        file: txt(l.file.canonicalPath),
        dir: l.assumedWorkingDir && txt(l.assumedWorkingDir),
      }
    : l.state === 'unlinked'
      ? { state: l.state, reason: l.reasonCode }
      : { state: l.state };
}
const CMD = (c: string) => `          command: ["gunicorn", "app:app"${c === '' ? '' : `, ${c}`}]`;

describe('the file -c names', () => {
  it('is found from the manifest folder up to the root; the folder is an assumption', () => {
    expect(
      linkOf(CMD('"-c", "gunicorn.conf.py"'), { 'gunicorn.conf.py': 'workers = 1\n' }),
    ).toEqual({
      state: 'linked',
      by: 'command',
      file: 'gunicorn.conf.py',
      dir: '.',
    });
  });

  it('a file beside the manifest wins its own folder', () => {
    expect(
      linkOf(CMD('"--config=gunicorn.conf.py"'), { 'k8s/gunicorn.conf.py': 'workers = 1\n' }),
    ).toEqual({
      state: 'linked',
      by: 'command',
      file: 'k8s/gunicorn.conf.py',
      dir: 'k8s',
    });
  });

  it('the same relative name in two folders on the way up is not decided', () => {
    expect(
      linkOf(CMD('"-c", "gunicorn.conf.py"'), {
        'k8s/gunicorn.conf.py': 'workers = 1\n',
        'gunicorn.conf.py': 'workers = 2\n',
      }),
    ).toEqual({ state: 'unlinked', reason: 'several-files-match' });
  });

  it.each([
    [
      'an absolute path (inside the container)',
      CMD('"-c", "/app/gunicorn.conf.py"'),
      'absolute-path',
    ],
    [
      'a container workingDir',
      `${CMD('"-c", "gunicorn.conf.py"')}\n          workingDir: /app`,
      'working-dir-not-mapped',
    ],
    ['a file that is not there', CMD('"-c", "nope/gunicorn.conf.py"'), 'unreadable'],
    ['a path outside the root', CMD('"-c", "../../../etc/gunicorn.conf.py"'), 'outside-root'],
    ['python:module', CMD('"-c", "python:my.mod"'), 'not-a-path'],
    ['file:path', CMD('"-c", "file:gunicorn.conf.py"'), 'not-a-path'],
    ['a reference', CMD('"-c", "$(CONF)"'), 'not-a-path'],
    ['no value', CMD('"-c"'), 'no-value'],
    ['two -c flags', CMD('"-c", "a.py", "-c", "b.py"'), 'not-a-path'],
  ])('%s is unlinked', (_l, container, reason) => {
    expect(linkOf(container, { 'gunicorn.conf.py': 'workers = 1\n' })).toEqual({
      state: 'unlinked',
      reason,
    });
  });

  it('a file with another name is not read as a gunicorn config', () => {
    expect(linkOf(CMD('"-c", "settings.py"'), { 'settings.py': 'workers = 1\n' })).toEqual({
      state: 'unlinked',
      reason: 'not-a-config-file',
    });
  });

  it('a directory spelled with a trailing slash and a case-different name are not files on Linux', () => {
    expect(
      linkOf(CMD('"-c", "gunicorn.conf.py/"'), { 'gunicorn.conf.py': 'workers = 1\n' }),
    ).toMatchObject({
      state: 'unlinked',
    });
    expect(
      linkOf(CMD('"-c", "Gunicorn.Conf.py"'), { 'gunicorn.conf.py': 'workers = 1\n' }),
    ).toMatchObject({
      state: 'unlinked',
    });
  });
});

describe('a gunicorn_config link in tripcurve.yaml', () => {
  it('names the file, with no -c', () => {
    expect(
      linkOf(CMD(''), {
        'conf/gunicorn.conf.py': 'workers = 1\n',
        'tripcurve.yaml': LINK('conf/gunicorn.conf.py'),
      }),
    ).toEqual({ state: 'linked', by: 'declared', file: 'conf/gunicorn.conf.py', dir: undefined });
  });

  it('a link that names no gunicorn.conf.py is unlinked, with a fixed reason', () => {
    expect(linkOf(CMD(''), { 'tripcurve.yaml': LINK('conf/gunicorn.conf.py') })).toEqual({
      state: 'unlinked',
      reason: 'unreadable',
    });
    expect(linkOf(CMD(''), { 'tripcurve.yaml': LINK('../x/gunicorn.conf.py') })).toMatchObject({
      state: 'unlinked',
    });
  });

  it('and -c naming the same file agree', () => {
    expect(
      linkOf(CMD('"-c", "gunicorn.conf.py"'), {
        'gunicorn.conf.py': 'workers = 1\n',
        'tripcurve.yaml': LINK('gunicorn.conf.py'),
      }),
    ).toMatchObject({ state: 'linked', by: 'declared' });
  });

  it('and -c naming another repository file is a conflict, not decided', () => {
    expect(
      linkOf(CMD('"-c", "other/gunicorn.conf.py"'), {
        'gunicorn.conf.py': 'workers = 1\n',
        'other/gunicorn.conf.py': 'workers = 2\n',
        'tripcurve.yaml': LINK('gunicorn.conf.py'),
      }),
    ).toEqual({ state: 'unlinked', reason: 'link-conflict' });
  });

  it('and -c python:module is a conflict', () => {
    expect(
      linkOf(CMD('"-c", "python:mod"'), {
        'gunicorn.conf.py': 'workers = 1\n',
        'tripcurve.yaml': LINK('gunicorn.conf.py'),
      }),
    ).toEqual({ state: 'unlinked', reason: 'link-conflict' });
  });

  it('and -c with a path inside the container leaves the owner link standing', () => {
    expect(
      linkOf(CMD('"-c", "/app/gunicorn.conf.py"'), {
        'gunicorn.conf.py': 'workers = 1\n',
        'tripcurve.yaml': LINK('gunicorn.conf.py'),
      }),
    ).toMatchObject({ state: 'linked', by: 'declared' });
  });
});

describe('no -c and no link', () => {
  it('a gunicorn.conf.py anywhere in the checked files may be loaded from the working directory', () => {
    expect(linkOf(CMD(''), { 'services/other/gunicorn.conf.py': 'workers = 1\n' })).toEqual({
      state: 'may-be-loaded',
    });
  });

  it('none in the files: no configuration file is involved', () => {
    expect(linkOf(CMD(''))).toEqual({ state: 'none' });
  });

  it('a file with another name is not a candidate for the default', () => {
    expect(linkOf(CMD(''), { 'gunicorn_conf.py': 'workers = 1\n' })).toEqual({ state: 'none' });
  });

  it('-c stops the default: another gunicorn.conf.py in the repository is not a candidate', () => {
    expect(
      linkOf(CMD('"-c", "conf/gunicorn.conf.py"'), {
        'conf/gunicorn.conf.py': 'workers = 1\n',
        'other/gunicorn.conf.py': 'workers = 2\n',
      }),
    ).toMatchObject({ state: 'linked', file: 'conf/gunicorn.conf.py' });
  });
});

describe('only a gunicorn command gets a gunicorn link', () => {
  it('uvicorn, Node and a shell command have none', () => {
    for (const cmd of [
      '          command: ["uvicorn", "app:app"]',
      '          command: ["node", "server.js"]',
      '          command: ["sh", "-c", "gunicorn app:app"]',
    ]) {
      const chain = pythonApp(cmd, { 'gunicorn.conf.py': 'workers = 1\n' }).graph.workloadChains[0];
      expect(chain?.gunicornConfig).toBeUndefined();
    }
  });
});
