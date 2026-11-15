// B2 gunicorn measurements from a given virtualenv:
//   node measure/py-b2.mjs <venv> threads            gunicorn --threads 2, no -k, WSGI app: idle close
//   node measure/py-b2.mjs <venv> threads-env        GUNICORN_CMD_ARGS='--threads 4', no -k: idle close
//   node measure/py-b2.mjs <venv> sync               no -k, no --threads: Connection: close and time to FIN
//   node measure/py-b2.mjs <venv> precedence <list>  uvicorn worker; <list> is comma-separated sources
//        of keepalive from: cli=3 s, env=5 s, file=7 s, default=9 s, emptyfile (a -c file that sets
//        nothing), or `none`. Which value applied shows as the idle close.
// Explicit keep-alive (follow-up), each with a value N in seconds, cap 120 s:
//   node measure/py-b2.mjs <venv> gthread-keepalive N         --threads 2 --keep-alive N, WSGI app
//   node measure/py-b2.mjs <venv> uvicorn-worker-keepalive N  uvicorn worker, --keep-alive N
//   node measure/py-b2.mjs <venv> uvicorn-flag N              uvicorn alone, --timeout-keep-alive N
//   node measure/py-b2.mjs <venv> uvicorn-env N               uvicorn alone, UVICORN_TIMEOUT_KEEP_ALIVE=N
// Starts gunicorn on 127.0.0.1 only, with a clean environment (only PATH, HOME,
// PYTHONDONTWRITEBYTECODE, plus GUNICORN_CMD_ARGS where the case sets it) and a
// working directory that holds only what the case puts there. gunicorn's own
// log (info level) is read from a pipe for the worker class it says it uses.
// Prints one JSON line. Exit 0 measured, 2 usage, 3 server not
// installed, 4 could not measure.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { measureIdleClose, measureCloseAfterResponse } from './lib/idle-close.mjs';

const [venv, mode, list = '', capArg] = process.argv.slice(2);
// Cap on how long the measurer waits for the close, seconds; 120 unless given
// as a fifth argument (explicit modes only), e.g. 400 for the 300 s values.
const capS = capArg === undefined ? 120 : /^[1-9][0-9]{0,4}$/.test(capArg) ? Number(capArg) : null;
const VALUES = { cli: 3, env: 5, file: 7, default: 9 };
const sources = list === 'none' || list === '' ? [] : list.split(',');
const EXPLICIT = ['gthread-keepalive', 'uvicorn-worker-keepalive', 'uvicorn-flag', 'uvicorn-env'];
const explicit = EXPLICIT.includes(mode);
const nSeconds = explicit && /^[1-9][0-9]{0,3}$/.test(list) ? Number(list) : null;
const usage = capS === null || (capArg !== undefined && !EXPLICIT.includes(mode)) || !venv || !['threads', 'threads-env', 'sync', 'precedence', ...EXPLICIT].includes(mode)
  || (explicit && nSeconds === null)
  || (mode === 'precedence' && (list === '' || sources.some((s) => !(s in VALUES) && s !== 'emptyfile') || new Set(sources).size !== sources.length || (sources.includes('file') && sources.includes('emptyfile'))))
  || (mode !== 'precedence' && !explicit && list !== '');
if (usage) { console.error('usage: py-b2.mjs <venv> <threads|threads-env|sync|precedence <cli,env,file,default,emptyfile|none>|gthread-keepalive N [capS]|uvicorn-worker-keepalive N [capS]|uvicorn-flag N [capS]|uvicorn-env N [capS]>'); process.exit(2); }
const bin = (n) => `${venv}/bin/${n}`;
const isUvicorn = mode === 'uvicorn-flag' || mode === 'uvicorn-env';
const exe = isUvicorn ? 'uvicorn' : 'gunicorn';
if (!existsSync(bin(exe)) || !existsSync(bin('python'))) { console.error(`server not installed: ${bin(exe)}`); process.exit(3); }
const here = fileURLToPath(new URL('.', import.meta.url));
const env = { PATH: `${venv}/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? '/', PYTHONDONTWRITEBYTECODE: '1' };

let child = null;
let tmp = null;
let stopping = false;
// Stop the server's whole process group, wait until it has gone, remove the
// scratch folder. Once a stop has begun every later caller waits forever, so a
// close caused by the stop can never be printed as a measurement.
const stop = async (code, msg) => {
  if (stopping) return new Promise(() => {});
  stopping = true;
  if (msg) console.error(msg);
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once('exit', r));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    await gone;
    clearTimeout(t);
  }
  if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(4, `could not measure: interrupted by ${sig}`));

try {
  const py = (code) => execFileSync(bin('python'), ['-c', code], { env }).toString().trim();
  const ver = (mod) => py(`import importlib.metadata as m; print(m.version("${mod}"))`);
  const pythonVersion = py('import sys; print(sys.version.split()[0])');
  const gver = ver('gunicorn');
  const version = isUvicorn ? `uvicorn ${ver('uvicorn')}` : (mode === 'precedence' || mode === 'uvicorn-worker-keepalive') ? `gunicorn ${gver} + uvicorn-worker ${ver('uvicorn-worker')} + uvicorn ${ver('uvicorn')}` : `gunicorn ${gver}`;

  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const common = ['--log-level', 'info', '-w', '1', '-b', `127.0.0.1:${port}`];
  let args; let cwd = here; const runEnv = { ...env };
  if (isUvicorn) {
    args = ['--host', '127.0.0.1', '--port', String(port), 'app:app'];
    if (mode === 'uvicorn-flag') args.push('--timeout-keep-alive', String(nSeconds));
    else runEnv.UVICORN_TIMEOUT_KEEP_ALIVE = String(nSeconds);
  } else if (mode === 'uvicorn-worker-keepalive') {
    args = ['-c', `${here}gunicorn-empty.conf.py`, '-k', 'uvicorn_worker.UvicornWorker', ...common, '--keep-alive', String(nSeconds), 'app:app'];
  } else if (mode === 'gthread-keepalive') {
    args = ['-c', `${here}gunicorn-empty.conf.py`, ...common, '--threads', '2', '--keep-alive', String(nSeconds), 'wsgi_app:app'];
  } else if (mode === 'precedence') {
    tmp = mkdtempSync(`${tmpdir()}/tc-b2-`);
    copyFileSync(`${here}app.py`, `${tmp}/app.py`);
    cwd = tmp;
    args = ['-k', 'uvicorn_worker.UvicornWorker', ...common];
    if (sources.includes('cli')) args.push('--keep-alive', String(VALUES.cli));
    if (sources.includes('env')) runEnv.GUNICORN_CMD_ARGS = `--keep-alive ${VALUES.env}`;
    if (sources.includes('file')) { writeFileSync(`${tmp}/conf-file.py`, `keepalive = ${VALUES.file}\n`); args.unshift('-c', `${tmp}/conf-file.py`); }
    if (sources.includes('emptyfile')) { writeFileSync(`${tmp}/conf-empty.py`, '# sets nothing\n'); args.unshift('-c', `${tmp}/conf-empty.py`); }
    if (sources.includes('default')) writeFileSync(`${tmp}/gunicorn.conf.py`, `keepalive = ${VALUES.default}\n`);
    args.push('app:app');
  } else {
    args = ['-c', `${here}gunicorn-empty.conf.py`, ...common, 'wsgi_app:app'];
    if (mode === 'threads') args.splice(2, 0, '--threads', '2');
    if (mode === 'threads-env') runEnv.GUNICORN_CMD_ARGS = '--threads 4';
  }
  child = spawn(bin(exe), args, { cwd, env: runEnv, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let log = '';
  child.stderr.on('data', (d) => { if (log.length < 200000) log += d; });
  child.on('error', (e) => stop(4, `could not measure: the server did not start (${e.code})`));
  const exitedEarly = (code) => stop(4, `could not measure: the server exited early (code ${code})`);
  child.on('exit', exitedEarly);

  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    up = await new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) await stop(4, 'could not measure: the server did not start within 15 s');

  const entry = { threads: 'gunicorn-gthread-default', 'threads-env': 'gunicorn-gthread-default', sync: 'gunicorn-sync-worker', precedence: 'gunicorn-keepalive-precedence',
    'gthread-keepalive': 'gunicorn-gthread-explicit-keepalive', 'uvicorn-worker-keepalive': 'gunicorn-uvicorn-worker-explicit-keepalive',
    'uvicorn-flag': 'uvicorn-explicit-keepalive', 'uvicorn-env': 'uvicorn-explicit-keepalive' }[mode];
  const out = {
    entry, server: isUvicorn ? 'uvicorn' : (mode === 'precedence' || mode === 'uvicorn-worker-keepalive') ? 'gunicorn-uvicorn' : `gunicorn ${mode}`, version,
    platform: `${process.platform}-${process.arch}, CPython ${pythonVersion}`, date: new Date().toLocaleDateString('en-CA'),
  };
  if (mode === 'precedence') out.case = { sources: Object.fromEntries(sources.map((s) => [s, s === 'emptyfile' ? 'sets nothing' : VALUES[s]])) };
  else if (explicit) out.case = { [mode === 'uvicorn-env' ? 'UVICORN_TIMEOUT_KEEP_ALIVE' : mode === 'uvicorn-flag' ? 'args' : 'args']: mode === 'uvicorn-env' ? String(nSeconds) : `${mode === 'gthread-keepalive' ? '--threads 2 ' : ''}${mode === 'uvicorn-flag' ? '--timeout-keep-alive' : '--keep-alive'} ${nSeconds}` };
  else out.case = mode === 'threads' ? { args: '--threads 2' } : mode === 'threads-env' ? { GUNICORN_CMD_ARGS: '--threads 4' } : { args: '(none)' };
  // The worker class, from gunicorn's own startup line "Using worker: <name>".
  const workerClass = () => /\[INFO\] Using worker: (\S+)/.exec(log)?.[1] ?? null;

  if (mode === 'sync') {
    const r = await measureCloseAfterResponse({ port });
    if (r.error) await stop(4, `could not measure: ${r.error}`);
    if (!/^gunicorn/.test(r.serverHeader ?? '')) await stop(4, `could not measure: the reply came from ${JSON.stringify(r.serverHeader)}, not gunicorn`);
    if (stopping) await stop(4);
    child.off('exit', exitedEarly);
    out.resolution = { sweepStepMs: 1, injectedLatencyMs: 0 };
    out.observed = { workerClass: workerClass() };
    out.measured = { closesAfterResponse: r.closesAfterResponse, connectionCloseHeader: r.connectionCloseHeader, closeMs: r.closeMs };
  } else {
    const r = await measureIdleClose({ port, capMs: capS * 1000 });
    if (r.idleCloseMs === null) await stop(4, `could not measure: ${r.error}`);
    const want = (mode === 'precedence' || mode === 'uvicorn-worker-keepalive' || isUvicorn) ? 'uvicorn' : 'gunicorn';
    if (!(r.serverHeader ?? '').toLowerCase().startsWith(want)) await stop(4, `could not measure: the reply came from ${JSON.stringify(r.serverHeader)}, not ${want}`);
    if (stopping) await stop(4);
    child.off('exit', exitedEarly);
    out.resolution = { sweepStepMs: 1, injectedLatencyMs: 0 };
    out.observed = isUvicorn ? {} : { workerClass: workerClass() };
    out.measured = { idleCloseMs: r.idleCloseMs };
  }
  console.log(JSON.stringify(out));
  await stop(0);
} catch (e) {
  await stop(4, `could not measure: ${e.message.split('\n')[0]}`);
}
