// An explicit gunicorn keepalive equals the idle close, ONLY for the worker classes and releases the
// measurements cover (measure/results/2026-11-11-b2.jsonl and -b2-explicit.jsonl, docs/research.md
// section 2). Everything else stays UNRESOLVED.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees, t1Of } from '../support/analyse.js';
import { cleanupPythonTrees, pythonApp, t1Summary } from '../support/python.js';
import { where } from '../support/render.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const pin = (g: string) => ({ 'requirements.txt': `gunicorn==${g}\nuvicorn==0.54.0\n` });
const UVW = (flags: string) =>
  `          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker"${flags}]`;
const GTH = (flags: string) =>
  `          command: ["gunicorn", "app:app", "--threads", "2"${flags}]`;
const ENV = (text: string) =>
  `\n          env:\n            - name: GUNICORN_CMD_ARGS\n              value: "${text}"`;
const BASIS_UVW26 =
  'explicit keepalive, uvicorn worker (gunicorn 26.x; measured from 3 to 300 s on 26.2.0)';
const BASIS_ALONE =
  'explicit keepalive, uvicorn (uvicorn 0.54.x; measured from 7 to 300 s on 0.54.0)';
const keepaliveStep = (r: ReturnType<typeof pythonApp>) =>
  t1Summary(r).chain.find((c) => c.startsWith('keepalive'));
const NOT_MEASURED =
  'idle close not established: the effect of an explicit keepalive on the idle close is not measured yet';

describe('the uvicorn worker, gunicorn 26.2.0 and later 26.x, 27.0.0 and later 27.x', () => {
  it('--keep-alive 75: the idle close is 75 s, PASS against LB idle 60 s', () => {
    const r = pythonApp(UVW(', "--keep-alive", "75"'), pin('26.2.0'));
    expect(t1Summary(r)).toEqual({
      kind: 'PASS',
      headline: 'idle close 75 s is longer than LB idle 60 s',
      chain: [
        `idle close: 75 s @ ${BASIS_UVW26}`,
        'worker: uvicorn @ "k8s/app.yaml":20',
        'keepalive: 75 s @ "k8s/app.yaml":20',
        'LB idle: 60 s @ "k8s/ingress.yaml":9',
      ],
    });
  });

  it('a value not longer than the load balancer idle is FAIL, equal included', () => {
    for (const n of ['30', '60']) {
      const f = t1Of(pythonApp(UVW(`, "--keep-alive=${n}"`), pin('26.2.0')));
      expect(f.kind, n).toBe('FAIL');
      expect(f.headline, n).toBe(`idle close ${n} s is not longer than LB idle 60 s`);
    }
  });

  it('GUNICORN_CMD_ARGS gives the value, with the env entry as its source', () => {
    const r = pythonApp(`${UVW('')}${ENV('--keep-alive 75')}`, pin('27.0.0'));
    expect(t1Of(r).kind).toBe('PASS');
    expect(keepaliveStep(r)).toBe('keepalive: 75 s @ "k8s/app.yaml":22');
  });

  it('the winning source of two is the measured one (command line over GUNICORN_CMD_ARGS)', () => {
    const r = pythonApp(`${UVW(', "--keep-alive", "75"')}${ENV('--keep-alive 5')}`, pin('26.2.0'));
    expect(t1Of(r).kind).toBe('PASS');
    const r2 = pythonApp(`${UVW(', "--keep-alive", "5"')}${ENV('--keep-alive 75')}`, pin('26.2.0'));
    expect(t1Of(r2).kind).toBe('FAIL');
  });

  it('a linked gunicorn.conf.py gives the value, with the file line as its source', () => {
    const r = pythonApp(UVW(', "-c", "gunicorn.conf.py"'), {
      ...pin('26.2.0'),
      'gunicorn.conf.py': 'workers = 2\nkeepalive = 75\n',
    });
    expect(t1Of(r).kind).toBe('PASS');
    expect(keepaliveStep(r)).toBe('keepalive: 75 s @ "gunicorn.conf.py":2');
  });

  it('a release below the first measured one of its line is UNRESOLVED', () => {
    for (const v of ['26.1.0', '28.0.0']) {
      const t = t1Summary(pythonApp(UVW(', "--keep-alive", "75"'), pin(v)));
      expect(t.kind, v).toBe('UNRESOLVED');
      expect(t.headline, v).toBe(NOT_MEASURED);
    }
  });

  it('keepalive 0 is not a measured value: UNRESOLVED', () => {
    expect(t1Summary(pythonApp(UVW(', "--keep-alive", "0"'), pin('26.2.0'))).headline).toBe(
      'idle close not established: explicit keepalive 0 s is outside the measured span (3 to 300 s)',
    );
  });

  it('with the load balancer idle only assumed, no verdict is given', () => {
    const r = pythonApp(UVW(', "--keep-alive", "75"'), {
      ...pin('26.2.0'),
      'k8s/ingress.yaml':
        'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  namespace: shop\nspec:\n  ingressClassName: alb\n  rules:\n    - http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: app\n                port:\n                  number: 80\n',
    });
    expect(t1Of(r).kind).toBe('UNRESOLVED');
  });

  it('an envFrom that could carry the worker class leaves the worker unresolved, so no verdict', () => {
    const r = pythonApp(
      `${UVW(', "--keep-alive", "75"')}\n          envFrom:\n            - configMapRef: {name: c}`,
      pin('26.2.0'),
    );
    expect(t1Of(r).kind).toBe('UNRESOLVED');
  });
});

describe('gthread, gunicorn 26.2.0 and 27.0.0 (explicit 7 s and 75 s measured)', () => {
  it.each(['26.2.0', '27.0.0', '26.3.1'])('--keep-alive 75 on %s: PASS', (v) => {
    const r = pythonApp(GTH(', "--keep-alive", "75"'), pin(v));
    expect(t1Of(r).kind).toBe('PASS');
    expect(t1Summary(r).chain[1]).toBe('worker: gthread @ "k8s/app.yaml":20');
  });

  it('a release outside the measured lines is UNRESOLVED', () => {
    expect(t1Summary(pythonApp(GTH(', "--keep-alive", "75"'), pin('26.1.0'))).headline).toBe(
      NOT_MEASURED,
    );
  });
});

describe('everything not measured stays UNRESOLVED', () => {
  it.each(['gevent', 'eventlet', 'tornado'])('%s with an explicit keepalive', (cls) => {
    const t = t1Summary(
      pythonApp(
        `          command: ["gunicorn", "-k", "${cls}", "--keep-alive", "75"]`,
        pin('26.2.0'),
      ),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(NOT_MEASURED);
  });

  it('an explicit keepalive with no version is UNRESOLVED for the version, not guessed', () => {
    const t = t1Summary(pythonApp(UVW(', "--keep-alive", "75"')));
    expect(t.headline).toBe('idle close not established: no gunicorn version in the files');
  });

  it('on the sync worker an explicit keepalive is ignored: N/A', () => {
    const t = t1Summary(
      pythonApp('          command: ["gunicorn", "app:app", "--keep-alive", "75"]', pin('26.2.0')),
    );
    expect(t.kind).toBe('N/A');
  });

  it('two sources that disagree on a setting that is not measured are still UNRESOLVED', () => {
    const t = t1Summary(
      pythonApp(`${UVW(', "--keep-alive", "3", "--keep-alive", "75"')}`, pin('26.2.0')),
    );
    expect(t.headline).toBe(
      'idle close not established: gunicorn setting precedence not yet measured for this setting',
    );
  });
});

describe('uvicorn alone, 0.54.x from 0.54.0 (explicit 7 s measured from the flag and the environment)', () => {
  const uvPin = (v: string) => ({ 'requirements.txt': `uvicorn==${v}\n` });
  const UVI = (flags: string) => `          command: ["uvicorn", "app:app"${flags}]`;

  it('--timeout-keep-alive 7: the idle close is 7 s, FAIL against 60 s, cited to the measurement', () => {
    const r = pythonApp(UVI(', "--timeout-keep-alive", "7"'), uvPin('0.54.0'));
    expect(t1Summary(r)).toEqual({
      kind: 'FAIL',
      headline: 'idle close 7 s is not longer than LB idle 60 s',
      chain: [
        `idle close: 7 s @ ${BASIS_ALONE}`,
        'keepalive: 7 s @ "k8s/app.yaml":20',
        'LB idle: 60 s @ "k8s/ingress.yaml":9',
      ],
    });
  });

  it('UVICORN_TIMEOUT_KEEP_ALIVE gives the value too', () => {
    const r = pythonApp(
      `${UVI('')}\n          env:\n            - name: UVICORN_TIMEOUT_KEEP_ALIVE\n              value: "7"`,
      uvPin('0.54.2'),
    );
    expect(t1Of(r).kind).toBe('FAIL');
    expect(keepaliveStep(r)).toBe('keepalive: 7 s @ "k8s/app.yaml":22');
  });

  it('the flag and the environment disagreeing is UNRESOLVED (uvicorn precedence is not measured)', () => {
    const r = pythonApp(
      `${UVI(', "--timeout-keep-alive", "7"')}\n          env:\n            - name: UVICORN_TIMEOUT_KEEP_ALIVE\n              value: "8"`,
      uvPin('0.54.0'),
    );
    expect(t1Summary(r).headline).toBe(
      'idle close not established: uvicorn setting precedence not yet measured',
    );
  });

  it('a release outside 0.54.x, or no version, is UNRESOLVED', () => {
    expect(
      t1Summary(pythonApp(UVI(', "--timeout-keep-alive", "7"'), uvPin('0.55.0'))).headline,
    ).toBe(NOT_MEASURED);
    expect(t1Summary(pythonApp(UVI(', "--timeout-keep-alive", "7"'))).headline).toBe(
      'idle close not established: no uvicorn version in the files',
    );
  });
});

describe('the boundary: the nominal value is compared, strictly greater than the load balancer idle', () => {
  it.each([
    [
      'the uvicorn worker',
      (n: number) => pythonApp(UVW(`, "--keep-alive", "${n}"`), pin('26.2.0')),
    ],
    ['gthread', (n: number) => pythonApp(GTH(`, "--keep-alive", "${n}"`), pin('27.0.0'))],
  ])('%s: 59 and 60 are FAIL, 61 is PASS (LB idle 60 s)', (_l, run) => {
    expect(t1Of(run(59)).kind).toBe('FAIL');
    expect(t1Of(run(60)).kind).toBe('FAIL');
    expect(t1Of(run(60)).headline).toBe('idle close 60 s is not longer than LB idle 60 s');
    expect(t1Of(run(61)).kind).toBe('PASS');
  });
});

describe('review M3: an explicit value outside the measured span is UNRESOLVED', () => {
  const OUT = (n: number, a: number, b: number) =>
    `idle close not established: explicit keepalive ${n} s is outside the measured span (${a} to ${b} s)`;

  it.each([
    [
      'the uvicorn worker, 26.2.0',
      (n: number) => pythonApp(UVW(`, "--keep-alive", "${n}"`), pin('26.2.0')),
      3,
      300,
    ],
    [
      'the uvicorn worker, 27.0.0',
      (n: number) => pythonApp(UVW(`, "--keep-alive", "${n}"`), pin('27.0.0')),
      3,
      300,
    ],
    [
      'gthread, 26.2.0',
      (n: number) => pythonApp(GTH(`, "--keep-alive", "${n}"`), pin('26.2.0')),
      7,
      300,
    ],
    [
      'gthread, 27.0.0',
      (n: number) => pythonApp(GTH(`, "--keep-alive", "${n}"`), pin('27.0.0')),
      7,
      300,
    ],
    [
      'uvicorn alone',
      (n: number) =>
        pythonApp(`          command: ["uvicorn", "app:app", "--timeout-keep-alive", "${n}"]`, {
          'requirements.txt': 'uvicorn==0.54.0\n',
        }),
      7,
      300,
    ],
  ])(
    '%s: the ends are in, one step outside either end is out, 3000 s is out',
    (_l, run, min, max) => {
      expect(t1Summary(run(min - 1)).headline).toBe(OUT(min - 1, min, max));
      expect(t1Summary(run(max + 1)).headline).toBe(OUT(max + 1, min, max));
      expect(t1Summary(run(3000)).headline).toBe(OUT(3000, min, max));
      expect(t1Of(run(min)).kind).not.toBe('UNRESOLVED');
      expect(t1Of(run(max)).kind).not.toBe('UNRESOLVED');
    },
  );

  it('a value outside the span is shown in the chain, not turned into an idle close', () => {
    const t = t1Summary(pythonApp(UVW(', "--keep-alive", "3000"'), pin('26.2.0')));
    expect(t.chain.some((c) => c.startsWith('keepalive: 3000 s @'))).toBe(true);
    expect(t.chain.some((c) => c.startsWith('idle close: 3000'))).toBe(false);
  });
});

describe('review m3: an explicit value does not print as a default', () => {
  it('the citation is `explicit keepalive, <class> (<range>; measured from A to B s on <version>)`', () => {
    const r = pythonApp(UVW(', "--keep-alive", "75"'), pin('27.0.0'));
    const f = t1Summary(r);
    expect(f.chain[0]).toBe(
      'idle close: 75 s @ explicit keepalive, uvicorn worker (gunicorn 27.x; measured from 3 to 300 s on 27.0.0)',
    );
    expect(f.chain.join('\n')).not.toContain('default:');
    const g = t1Summary(pythonApp(GTH(', "--keep-alive", "75"'), pin('26.2.0')));
    expect(g.chain[0]).toBe(
      'idle close: 75 s @ explicit keepalive, gthread worker (gunicorn 26.x; measured from 7 to 300 s on 26.2.0)',
    );
  });
});

// Found while building the demo (bolt B10): the after-fix PASS line for `api` named the knowledge-base
// citation instead of the file line of `--keep-alive 75`, so a reader could not see where the 75 came
// from the design mockup: a PASS line names the deciding source, the source of the value being checked.
describe('B10: the PASS line cites the setting the idle close rests on', () => {
  const idleStep = (r: ReturnType<typeof pythonApp>) =>
    t1Of(r).chain.find((s) => s.label === 'idle close');

  it('gunicorn: the deciding source is the --keep-alive value, with its basis as the note', () => {
    const r = pythonApp(UVW(', "--keep-alive", "75"'), pin('26.2.0'));
    const step = idleStep(r);
    expect(step?.decidedBy).toBeDefined();
    expect(step?.decidedBy === undefined ? '' : where(step.decidedBy)).toBe('k8s/app.yaml:20');
    expect(t1Of(r).decidingNote).toBe(BASIS_UVW26);
  });

  it('uvicorn alone: the same', () => {
    const r = pythonApp('          command: ["uvicorn", "app:app", "--timeout-keep-alive", "75"]', {
      'requirements.txt': 'uvicorn==0.54.0\n',
    });
    const step = idleStep(r);
    expect(step?.decidedBy === undefined ? '' : where(step.decidedBy)).toBe('k8s/app.yaml:20');
    expect(t1Of(r).decidingNote).toBe(BASIS_ALONE);
  });

  it('GUNICORN_CMD_ARGS: the deciding source is the env entry, not the worker on the command line', () => {
    const r = pythonApp(`${UVW('')}${ENV('--keep-alive 75')}`, pin('26.2.0'));
    const step = idleStep(r);
    expect(step?.decidedBy === undefined ? '' : where(step.decidedBy)).toBe('k8s/app.yaml:22');
    expect(step?.decidedBy === undefined ? '' : where(step.decidedBy)).not.toBe('k8s/app.yaml:20');
  });

  it('a -c config file: the deciding source is the file line of keepalive, not the worker', () => {
    const r = pythonApp(UVW(', "-c", "gunicorn.conf.py"'), {
      ...pin('26.2.0'),
      'gunicorn.conf.py': 'workers = 2\nkeepalive = 75\n',
    });
    const step = idleStep(r);
    expect(step?.decidedBy === undefined ? '' : where(step.decidedBy)).toBe('gunicorn.conf.py:2');
  });
});
