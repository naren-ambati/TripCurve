// The worker model and the idle close of gunicorn and uvicorn. The
// verdict path runs with a knowledge base whose ranges are `*` (what a version source would
// give), because the files show no gunicorn version (see python-version.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTrees, t1Of } from '../support/analyse.js';
import {
  cleanupPythonTrees,
  LB_STEP,
  NO_VERSION,
  pythonApp,
  starKb,
  t1Summary,
} from '../support/python.js';

afterEach(() => {
  cleanupTrees();
  cleanupPythonTrees();
});

const UVICORN_CMD =
  '          command: ["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker", "-w", "4"]';
const star = (...ids: string[]) => starKb(ids);

describe('the verdict path: a release the knowledge base covers (`api` of the demo)', () => {
  it('gunicorn with the uvicorn worker: FAIL T1, the idle close cited exactly as in the expected report layout', () => {
    const r = pythonApp(UVICORN_CMD, {}, star('gunicorn-keepalive-uvicorn-worker-26x'));
    const f = t1Of(r);
    expect(f.kind).toBe('FAIL');
    expect(f.headline).toBe('idle close 2 s is not longer than LB idle 60 s');
    expect(t1Summary(r).chain).toEqual([
      'idle close: 2 s @ default: gunicorn keepalive, uvicorn worker (gunicorn 26.x; measured on 26.2.0)',
      'worker: uvicorn @ "k8s/app.yaml":20',
      LB_STEP,
    ]);
  });

  it('two release lines overlapping: VERSION-DEPENDENT, one branch per range, even though both give 2 s', () => {
    const f = t1Of(pythonApp(UVICORN_CMD, {}, starKb()));
    expect(f.kind).toBe('VERSION-DEPENDENT');
    expect((f.branches ?? []).map((b) => b.range)).toEqual(['gunicorn 26.x', 'gunicorn 27.x']);
    // the words are the runtime's own: never "Node" for a gunicorn workload
    expect(f.headline).toBe('idle close depends on the gunicorn version: 2 ranges apply');
    expect(f.declare).toEqual(['declare runtime.gunicorn for this workload in tripcurve.yaml']);
  });

  it('gthread (--threads 2) uses the gthread entry', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "app:app", "--threads", "2"]',
      {},
      star('gunicorn-keepalive-gthread-26x'),
    );
    expect(t1Summary(r).chain[0]).toBe(
      'idle close: 2 s @ default: gunicorn keepalive, gthread worker (gunicorn 26.x; measured on 26.2.0)',
    );
    expect(t1Of(r).kind).toBe('FAIL');
  });

  it('uvicorn alone: FAIL T1 from its own entry, 5 s', () => {
    const r = pythonApp(
      '          command: ["uvicorn", "app:app"]',
      {},
      star('uvicorn-keepalive-0-54x'),
    );
    expect(t1Summary(r)).toMatchObject({
      kind: 'FAIL',
      chain: [
        'idle close: 5 s @ default: uvicorn keepalive (uvicorn 0.54.x; measured on 0.54.0)',
        LB_STEP,
      ],
    });
  });

  it('the verdict is not given when the load balancer idle is only assumed (no annotation)', () => {
    const r = pythonApp(
      UVICORN_CMD,
      {
        // the shared Ingress without its idle-timeout annotation
        'k8s/ingress.yaml':
          'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: app\n  namespace: shop\nspec:\n  ingressClassName: alb\n  rules:\n    - http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: app\n                port:\n                  number: 80\n',
      },
      star('gunicorn-keepalive-uvicorn-worker-26x'),
    );
    const f = t1Of(r);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.headline).toContain('LB idle is not set in the files; assumed 60 s');
  });
});

describe('the shipped knowledge base with no version evidence: UNRESOLVED, never the nearest range', () => {
  it.each([
    ['the uvicorn worker', UVICORN_CMD],
    ['gthread by --threads', '          command: ["gunicorn", "app:app", "--threads", "3"]'],
    ['gthread by -k', '          command: ["gunicorn", "app:app", "-k", "gthread"]'],
  ])('%s', (_l, cmd) => {
    const t = t1Summary(pythonApp(cmd));
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(`idle close not established: ${NO_VERSION}`);
  });

  it('uvicorn alone', () => {
    const t = t1Summary(pythonApp('          command: ["uvicorn", "app:app"]'));
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe('idle close not established: no uvicorn version in the files');
  });

  it.each(['gevent', 'eventlet', 'tornado'])(
    '%s has no measured entry: UNRESOLVED, to be measured, whatever the release',
    (cls) => {
      const r = pythonApp(
        `          command: ["gunicorn", "app:app", "-k", "${cls}"]`,
        {},
        starKb(),
      );
      const t = t1Summary(r);
      expect(t.kind).toBe('UNRESOLVED');
      expect(t.headline).toBe(
        `idle close not established: no measured default for the ${cls} worker: to be measured`,
      );
    },
  );
});

describe('unknown and unreadable worker classes are UNRESOLVED', () => {
  it.each([
    ['an unknown class', 'my.pkg.Worker', 'worker class is not one tripcurve knows'],
    ['a bare uvicorn', 'uvicorn', 'worker class is not one tripcurve knows'],
    [
      'a $(...) reference',
      '$(CLASS)',
      'a $(...) reference in the command is expanded by Kubernetes',
    ],
  ])('%s', (_l, cls, reason) => {
    const t = t1Summary(
      pythonApp(`          command: ["gunicorn", "app:app", "-k", "${cls}"]`, {}, starKb()),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(`idle close not established: ${reason}`);
  });

  it('an unknown class with --threads 4 is still unknown (the model is not guessed from threads)', () => {
    const t = t1Summary(
      pythonApp(
        '          command: ["gunicorn", "app:app", "-k", "my.pkg.Worker", "--threads", "4"]',
        {},
        starKb(),
      ),
    );
    expect(t.kind).toBe('UNRESOLVED');
  });

  it('sync with --threads unresolved: it cannot be said whether the worker is sync or gthread', () => {
    const t = t1Summary(
      pythonApp('          command: ["gunicorn", "app:app", "--threads", "many"]', {}, starKb()),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toContain('not a whole number');
  });

  it('--threads 1 stays sync, --threads 0 too', () => {
    for (const n of ['0', '1']) {
      expect(
        t1Summary(pythonApp(`          command: ["gunicorn", "app:app", "--threads", "${n}"]`))
          .kind,
      ).toBe('N/A');
    }
  });

  it('an explicit gthread class with threads unresolved is still gthread (threads cannot change it)', () => {
    const t = t1Summary(
      pythonApp(
        '          command: ["gunicorn", "-k", "gthread", "--threads", "many"]',
        {},
        star('gunicorn-keepalive-gthread-26x'),
      ),
    );
    expect(t.kind).toBe('FAIL');
  });
});

describe('an explicit keepalive stays UNRESOLVED where no measurement covers it', () => {
  it('uvicorn --timeout-keep-alive on a release outside the measured line', () => {
    const t = t1Summary(
      pythonApp('          command: ["uvicorn", "app:app", "--timeout-keep-alive", "70"]', {
        'requirements.txt': 'uvicorn==0.55.0\n',
      }),
    );
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.headline).toBe(
      'idle close not established: the effect of an explicit keepalive on the idle close is not measured yet',
    );
    expect(t.chain[0]).toBe('keepalive: 70 s @ "k8s/app.yaml":20');
  });
});

describe('a linked Dockerfile ENV', () => {
  const DOCKERFILE = 'FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads 3"\n';
  const LINK =
    'version: 1\nworkloads:\n  - name: app\n    namespace: shop\n    dockerfile: Dockerfile\n';

  it('is not read when the Dockerfile is not linked: the default worker applies, N/A', () => {
    const r = pythonApp('          command: ["gunicorn", "app:app"]', { Dockerfile: DOCKERFILE });
    expect(t1Summary(r).kind).toBe('N/A');
  });

  it('is read when tripcurve.yaml links it: --threads 3 makes the worker gthread', () => {
    const r = pythonApp('          command: ["gunicorn", "app:app"]', {
      Dockerfile: DOCKERFILE,
      'tripcurve.yaml': LINK,
    });
    const t = t1Summary(r);
    expect(t.kind).toBe('UNRESOLVED');
    expect(t.chain[0]).toBe('worker: gthread @ "Dockerfile":2');
  });

  it('the manifest env replaces the image ENV', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "app:app"]\n          env:\n            - name: GUNICORN_CMD_ARGS\n              value: "--threads 1"',
      { Dockerfile: DOCKERFILE, 'tripcurve.yaml': LINK },
    );
    expect(t1Summary(r).kind).toBe('N/A');
  });

  it('a Dockerfile ENV that is not literal makes the settings UNRESOLVED', () => {
    const r = pythonApp('          command: ["gunicorn", "app:app"]', {
      Dockerfile: 'FROM python:3.12\nENV GUNICORN_CMD_ARGS="--threads $N"\n',
      'tripcurve.yaml': LINK,
    });
    expect(t1Summary(r).headline).toBe(
      'idle close not established: a Dockerfile ENV is not in a form tripcurve reads',
    );
  });
});

describe('the places that could set a setting and are not read: no "no setting found" (the B1 lesson)', () => {
  it('an envFrom makes the worker model UNRESOLVED instead of the default sync', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "app:app"]\n          envFrom:\n            - configMapRef: {name: c}',
    );
    expect(t1Summary(r)).toMatchObject({
      kind: 'UNRESOLVED',
      headline:
        'idle close not established: envFrom may set GUNICORN_CMD_ARGS from a source that is not read',
    });
  });

  it('a valueFrom GUNICORN_CMD_ARGS makes it UNRESOLVED', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "app:app"]\n          env:\n            - name: GUNICORN_CMD_ARGS\n              valueFrom:\n                configMapKeyRef: {name: c, key: k}',
    );
    expect(t1Summary(r).headline).toBe(
      'idle close not established: GUNICORN_CMD_ARGS comes from a reference that is not read',
    );
  });

  it('a container workingDir with -c is not mapped to a folder', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "-c", "gunicorn.conf.py"]\n          workingDir: /srv',
      { 'gunicorn.conf.py': 'worker_class = "sync"\n' },
    );
    expect(t1Summary(r).headline).toBe(
      'idle close not established: container working directory is not mapped to the repository; link the gunicorn config in tripcurve.yaml',
    );
  });

  it('--chdir: where the config file is found is not measured, so the file is not read', () => {
    const r = pythonApp(
      '          command: ["gunicorn", "-c", "gunicorn.conf.py", "--chdir", "/srv"]',
      {
        'gunicorn.conf.py': 'worker_class = "sync"\n',
      },
    );
    expect(t1Summary(r).kind).toBe('UNRESOLVED');
    expect(t1Summary(r).headline).toContain('--chdir');
  });

  it('a command that is a shell string is not read as gunicorn at all', () => {
    const r = pythonApp('          command: ["sh", "-c", "gunicorn app:app"]');
    expect(t1Summary(r).kind).toBe('UNRESOLVED');
  });
});

describe('a PASS is never produced from a Python result that rests on something unverified', () => {
  it('no Python case gives PASS while the version is unknown', () => {
    for (const cmd of [UVICORN_CMD, '          command: ["uvicorn", "a:a"]']) {
      expect(t1Of(pythonApp(cmd)).kind).not.toBe('PASS');
    }
  });
});
