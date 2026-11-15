// Precision fixtures for the Python servers: each case under
// test/fixtures/python/precision/ has its expected T1 result fixed here, written before the
// readers. The false-positive class (the earlier design's fatal flaw) is the first three: a
// sync worker is never flagged, whatever else is set.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees } from '../support/analyse.js';
import {
  analysePrecision,
  analysePrecisionFiles,
  cleanupPythonTrees,
  t1Summary,
} from '../support/python.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const NO_VERSION = 'no gunicorn version in the files';
const LB = 'LB idle: 60 s @ "k8s/ingress.yaml":9';
const WD = 'The container\'s working directory is taken to be ".".';

describe('the sync worker is not applicable, never FAIL', () => {
  it('sync-default: gunicorn with no -k and no --threads', () => {
    const r = analysePrecision('sync-default');
    expect(t1Summary(r)).toEqual({
      kind: 'N/A',
      headline: 'gunicorn sync worker closes after every response',
      chain: ['worker: sync @ "k8s/app.yaml":20'],
    });
    expect(r.assumptions).toEqual([]);
  });

  it('cmd-args-override: -k sync with GUNICORN_CMD_ARGS=--threads 4 is gthread, so T1 applies and is not N/A', () => {
    const t = t1Summary(analysePrecision('cmd-args-override'));
    expect(t).toEqual({
      kind: 'UNRESOLVED',
      headline: `idle close not established: ${NO_VERSION}`,
      chain: ['worker: gthread @ "k8s/app.yaml":22', `version: ? ${NO_VERSION}`, LB],
    });
  });

  it('GUNICORN_CMD_ARGS=--keep-alive 75 on the sync default is still N/A (an ignored option)', () => {
    const r = analysePrecision('sync-default', {
      extra: {
        'k8s/app.yaml': `${readApp('sync-default')}          env:\n            - name: GUNICORN_CMD_ARGS\n              value: "--keep-alive 75"\n`,
      },
    });
    expect(t1Summary(r).kind).toBe('N/A');
  });
});

describe('--threads above 1 means gthread, which has a keep-alive', () => {
  it('threads-2 is gthread: UNRESOLVED only because the release is unknown, never N/A and never PASS', () => {
    expect(t1Summary(analysePrecision('threads-2'))).toEqual({
      kind: 'UNRESOLVED',
      headline: `idle close not established: ${NO_VERSION}`,
      chain: ['worker: gthread @ "k8s/app.yaml":20', `version: ? ${NO_VERSION}`, LB],
    });
  });
});

describe('gunicorn.conf.py literals, read without running the file', () => {
  it('conf-literals: -c names the file, its worker_class = "sync" gives N/A with the file line as the source', () => {
    const r = analysePrecision('conf-literals');
    expect(t1Summary(r)).toEqual({
      kind: 'N/A',
      headline: 'gunicorn sync worker closes after every response',
      chain: ['worker: sync @ "gunicorn.conf.py":2'],
    });
    expect(r.assumptions.map((a) => a.text)).toEqual([WD]);
  });

  it('conf-nonliteral: code in the file makes the worker model UNRESOLVED, with the line', () => {
    const r = analysePrecision('conf-nonliteral');
    expect(t1Summary(r)).toEqual({
      kind: 'UNRESOLVED',
      headline:
        'idle close not established: a statement at line 1 of gunicorn.conf.py is not a plain literal assignment',
      chain: [
        'worker: ? a statement at line 1 of gunicorn.conf.py is not a plain literal assignment',
        LB,
      ],
    });
  });

  it('conf-unlinked: no -c and no link, a gunicorn.conf.py is in the repository: UNRESOLVED, its values not used', () => {
    const r = analysePrecision('conf-unlinked');
    const t = t1Summary(r);
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(
      'idle close not established: gunicorn.conf.py may be loaded from the working directory; link it in tripcurve.yaml',
    );
    // the file says uvicorn: that must not be used (no FAIL from a file nothing links)
    expect(t.chain.join('\n')).not.toContain('uvicorn');
  });

  it('conf-unlinked, then linked in tripcurve.yaml: the file is read (its worker class decides)', () => {
    const r = analysePrecision('conf-unlinked', {
      extra: {
        'tripcurve.yaml':
          'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    gunicorn_config: gunicorn.conf.py\n',
      },
    });
    const t = t1Summary(r);
    // uvicorn worker, no version: UNRESOLVED for the release, with the worker from the file line
    expect(t.chain[0]).toBe('worker: uvicorn @ "gunicorn.conf.py":1');
    expect(t.headline).toBe(`idle close not established: ${NO_VERSION}`);
  });

  it('dash-c-present: -c conf/gunicorn.conf.py (threads = 2) with -k sync is gthread', () => {
    const r = analysePrecision('dash-c-present');
    expect(t1Summary(r)).toEqual({
      kind: 'UNRESOLVED',
      headline: `idle close not established: ${NO_VERSION}`,
      chain: ['worker: gthread @ "conf/gunicorn.conf.py":1', `version: ? ${NO_VERSION}`, LB],
    });
    expect(r.assumptions.map((a) => a.text)).toEqual([WD]);
  });

  it('-c present stops the repository file from being a candidate: the named file is the only one read', () => {
    const r = analysePrecision('dash-c-present', {
      extra: { 'gunicorn.conf.py': 'worker_class = "uvicorn_worker.UvicornWorker"\n' },
    });
    expect(t1Summary(r).chain[0]).toBe('worker: gthread @ "conf/gunicorn.conf.py":1');
  });
});

/** The case's own manifest, to append an env block after the last container line. */
function readApp(name: string): string {
  return (analysePrecisionFiles(name)['k8s/app.yaml'] as string).replace(/\n*$/, '\n');
}
