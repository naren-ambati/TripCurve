// B4-more: copy of shutdown-b4.mjs (same method) with the cases for more workers and other ways to set graceful_timeout.
//   node measure/shutdown-b4-more.mjs <venv> <case> <long|short>
// cases: sync-w2 | sync-w2-graceful10 | sync-env-graceful10 | sync-conf-graceful10 | uvicorn-worker-graceful10 | gthread-graceful10
//   sync-w2*: -w 2; every other case: -w 1.
//   sync-env-graceful10: GUNICORN_CMD_ARGS='--graceful-timeout 10', no flag, empty config file.
//   sync-conf-graceful10: -c gunicorn-gt10.conf.py (graceful_timeout = 10), no flag.
// long  = a request that sleeps 60 s (longer than any ceiling under test)
// short = a request that sleeps 3 s (finishes well before any ceiling)
// Method: start the server on 127.0.0.1, send GET /sleep?s=N on one connection,
// wait until the app says (marker file) that the request is in flight, send SIGTERM
// to the server's main process, then time (from the moment kill() returned):
// the in-flight connection closing, the worker process disappearing, the main
// process exiting. Clean env, explicit empty gunicorn config, process-group kill,
// localhost only. Exit 0 measured (one JSON line), 2 usage, 3 not installed, 4 could not measure.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const [venv, caseName, kind] = process.argv.slice(2);
const CASES = ['sync-w2', 'sync-w2-graceful10', 'sync-env-graceful10', 'sync-conf-graceful10', 'uvicorn-worker-graceful10', 'gthread-graceful10'];
if (!venv || !CASES.includes(caseName) || !['long', 'short'].includes(kind)) {
  console.error(`usage: shutdown-b4.mjs <venv> <${CASES.join('|')}> <long|short>`); process.exit(2);
}
const isUvicorn = false;
const nWorkers = caseName.startsWith('sync-w2') ? 2 : 1;
const sleepS = kind === 'long' ? 60 : 3;
const capMs = (isUvicorn ? 90 : 120) * 1000;
const bin = (n) => `${venv}/bin/${n}`;
const exe = isUvicorn ? 'uvicorn' : 'gunicorn';
if (!existsSync(bin(exe)) || !existsSync(bin('python'))) { console.error(`server not installed: ${bin(exe)}`); process.exit(3); }
const here = fileURLToPath(new URL('.', import.meta.url));
const tmp = mkdtempSync(`${tmpdir()}/tc-b4m-`);
const env = { PATH: `${venv}/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? '/', PYTHONDONTWRITEBYTECODE: '1', TC_MARKER_DIR: tmp, ...(caseName === 'sync-env-graceful10' ? { GUNICORN_CMD_ARGS: '--graceful-timeout 10' } : {}) };

let child = null; let stopping = false;
const stop = async (code, msg) => {
  if (stopping) return new Promise(() => {});
  stopping = true;
  if (msg) console.error(msg);
  if (child) {
    // whole process group, whether or not the main process is still alive
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('exit', r));
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(4, `could not measure: interrupted by ${sig}`));

try {
  const py = (c) => execFileSync(bin('python'), ['-c', c], { env }).toString().trim();
  const ver = (m) => py(`import importlib.metadata as m; print(m.version("${m}"))`);
  const version = isUvicorn ? `uvicorn ${ver('uvicorn')}` : `gunicorn ${ver('gunicorn')}${caseName === 'uvicorn-worker-graceful10' ? ` + uvicorn-worker ${ver('uvicorn-worker')} + uvicorn ${ver('uvicorn')}` : ''}`;
  const pythonVersion = py('import sys; print(sys.version.split()[0])');
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const conf = caseName === 'sync-conf-graceful10' ? `${here}gunicorn-gt10.conf.py` : `${here}gunicorn-empty.conf.py`;
  const g = ['-c', conf, '--log-level', 'info', '-w', String(nWorkers), '-b', `127.0.0.1:${port}`];
  const args = {
    'sync-w2': [...g, 'slow_wsgi:app'],
    'sync-w2-graceful10': [...g, '--graceful-timeout', '10', 'slow_wsgi:app'],
    'sync-env-graceful10': [...g, 'slow_wsgi:app'],
    'sync-conf-graceful10': [...g, 'slow_wsgi:app'],
    'uvicorn-worker-graceful10': [...g, '--graceful-timeout', '10', '-k', 'uvicorn_worker.UvicornWorker', 'slow_asgi:app'],
    'gthread-graceful10': [...g, '--graceful-timeout', '10', '--threads', '2', 'slow_wsgi:app'],
  }[caseName];
  const caseArgs = { 'sync-w2': '-w 2', 'sync-w2-graceful10': '-w 2 --graceful-timeout 10', 'sync-env-graceful10': "GUNICORN_CMD_ARGS='--graceful-timeout 10'", 'sync-conf-graceful10': '-c gunicorn-gt10.conf.py (graceful_timeout = 10)', 'uvicorn-worker-graceful10': '-k uvicorn_worker.UvicornWorker --graceful-timeout 10', 'gthread-graceful10': '--threads 2 --graceful-timeout 10' }[caseName];

  child = spawn(bin(exe), args, { cwd: here, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let log = '';
  child.stderr.on('data', (d) => { if (log.length < 200000) log += d; });
  child.on('error', (e) => stop(4, `could not measure: the server did not start (${e.code})`));
  let exitInfo = null; let tExit = null; let tSigterm = null;
  child.on('exit', (code, signal) => {
    if (tSigterm === null) stop(4, `could not measure: the server exited early (code ${code})`);
    else { exitInfo = { code, signal }; tExit = process.hrtime.bigint(); }
  });
  const readyPort = async () => {
    for (let i = 0; i < 150; i++) {
      if (await new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (!(await readyPort())) await stop(4, 'could not measure: the server did not start within 15 s');

  // the in-flight request
  let bytes = ''; let tClose = null; let closeKind = null;
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.on('data', (d) => { if (bytes.length < 4096) bytes += d.toString('latin1'); });
  sock.on('error', (e) => { if (closeKind === null) { closeKind = `error ${e.code}`; tClose = process.hrtime.bigint(); } });
  sock.on('end', () => { if (closeKind === null) { closeKind = 'fin'; tClose = process.hrtime.bigint(); } });
  sock.on('close', () => { if (closeKind === null) { closeKind = 'closed'; tClose = process.hrtime.bigint(); } });
  sock.write(`GET /sleep?s=${sleepS} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  // wait until the app says the request is being handled
  let inFlight = false;
  for (let i = 0; i < 300 && !inFlight; i++) { inFlight = existsSync(`${tmp}/started`); if (!inFlight) await new Promise((r) => setTimeout(r, 50)); }
  if (!inFlight) await stop(4, 'could not measure: the request never reached the app within 15 s');
  await new Promise((r) => setTimeout(r, 500)); // let the request settle in flight
  if (closeKind !== null) await stop(4, `could not measure: the connection closed before SIGTERM (${closeKind})`);
  // worker pids (gunicorn only): the children of the main process
  let workers = [];
  if (!isUvicorn) { try { workers = execFileSync('/usr/bin/pgrep', ['-P', String(child.pid)]).toString().split('\n').filter(Boolean).map(Number); } catch {} }
  if (workers.length !== nWorkers) await stop(4, `could not measure: expected ${nWorkers} worker(s), found ${workers.length}`);
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

  const t0 = process.hrtime.bigint();
  process.kill(child.pid, 'SIGTERM'); tSigterm = t0;
  const tW = workers.map(() => null);
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline && (tClose === null || tExit === null || tW.some((x) => x === null))) {
    workers.forEach((p, i) => { if (tW[i] === null && !alive(p)) tW[i] = process.hrtime.bigint(); });
    await new Promise((r) => setTimeout(r, 10));
  }
  if (tClose === null || tExit === null || tW.some((x) => x === null)) await stop(4, `could not measure: not finished within ${capMs / 1000} s of SIGTERM`);
  const head = bytes.split('\r\n')[0];
  const complete = /^HTTP\/1\.1 200/.test(head) && bytes.endsWith('done');
  const interesting = log.split('\n').filter((l) => /SIGKILL|Worker (exiting|timeout)|WORKER TIMEOUT|Handling signal|Shutting down|Waiting for|Finished server process|Application shutdown|Waiting for connections|Cancel|force/i.test(l)).map((l) => l.replace(/^\[[^\]]*\] /, '').slice(0, 160));
  const out = {
    entry: 'shutdown-graceful-ceiling-more', server: `gunicorn ${caseName}`, version,
    platform: `${process.platform}-${process.arch}, CPython ${pythonVersion}`, date: new Date().toLocaleDateString('en-CA'),
    case: { name: caseName, args: caseArgs, request: `GET /sleep?s=${sleepS}`, kind },
    resolution: { pollMs: 10, settleMsBeforeSigterm: 500 },
    workers: nWorkers,
    measured: {
      sigtermToConnectionClosedMs: Math.round(Number(tClose - t0) / 1e5) / 10,
      sigtermToWorkerGoneMs: Math.round(Number(tW.reduce((m, x) => (x > m ? x : m)) - t0) / 1e5) / 10,
      sigtermToEachWorkerGoneMs: tW.map((x) => Math.round(Number(x - t0) / 1e5) / 10).sort((a, b) => a - b),
      sigtermToMainExitMs: Math.round(Number(tExit - t0) / 1e5) / 10,
      connectionClose: closeKind, responseComplete: complete, responseHead: head.slice(0, 40), bytesReceived: bytes.length,
      mainExit: exitInfo,
    },
    observed: { serverLog: interesting.slice(0, 12) },
  };
  console.log(JSON.stringify(out));
  await stop(0);
} catch (e) {
  await stop(4, `could not measure: ${e.message.split('\n')[0]}`);
}
