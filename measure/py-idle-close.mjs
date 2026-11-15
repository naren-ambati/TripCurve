// Default idle close of gunicorn with the uvicorn worker, or uvicorn alone,
// from a given virtualenv: `node measure/py-idle-close.mjs <venv> <gunicorn-uvicorn|uvicorn>`.
// Starts the server on 127.0.0.1 only, with a clean environment and (for
// gunicorn) an explicit empty config file, so nothing outside this script
// changes the defaults. Prints one JSON line. For gunicorn the line also carries
// `observed.workerClass`, read from gunicorn's own "Using worker:" startup line (B8; an
// additive change: the lines of B0 simply do not have it).
// Exit 0 measured, 2 usage, 3 server not installed, 4 could not measure.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { measureIdleClose } from './lib/idle-close.mjs';

const [venv, kind] = process.argv.slice(2);
if (!venv || !['gunicorn-uvicorn', 'uvicorn'].includes(kind)) { console.error('usage: py-idle-close.mjs <venv> <gunicorn-uvicorn|uvicorn>'); process.exit(2); }
const bin = (n) => `${venv}/bin/${n}`;
const want = kind === 'uvicorn' ? 'uvicorn' : 'gunicorn';
if (!existsSync(bin(want)) || !existsSync(bin('python'))) { console.error(`server not installed: ${bin(want)}`); process.exit(3); }
const here = fileURLToPath(new URL('.', import.meta.url));
const env = { PATH: `${venv}/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? '/', PYTHONDONTWRITEBYTECODE: '1' };

let child = null;
let stopping = false;
// Stop the server's whole process group and wait until it has gone, so the
// next run never overlaps this one; SIGKILL after 10 s is only a backstop.
// Once a stop has begun, every later caller waits forever: in particular the
// measurement path can never go on to print a result, because stopping the
// server closes the connection and that close is not an idle close.
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
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(4, `could not measure: interrupted by ${sig}`));

try {
  // Versions first, from the virtualenv itself, before anything is started.
  const py = (code) => execFileSync(bin('python'), ['-c', code], { env }).toString().trim();
  const ver = (mod) => py(`import importlib.metadata as m; print(m.version("${mod}"))`);
  const pythonVersion = py('import sys; print(sys.version.split()[0])');
  const version = kind === 'uvicorn' ? ver('uvicorn') : `gunicorn ${ver('gunicorn')} + uvicorn-worker ${ver('uvicorn-worker')} + uvicorn ${ver('uvicorn')}`;

  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const args = kind === 'uvicorn'
    ? ['--host', '127.0.0.1', '--port', String(port), 'app:app']
    : ['-c', `${here}gunicorn-empty.conf.py`, '--log-level', 'info', '-k', 'uvicorn_worker.UvicornWorker', '-w', '1', '-b', `127.0.0.1:${port}`, 'app:app'];
  child = spawn(bin(want), args, { cwd: here, env, stdio: ['ignore', 'ignore', kind === 'uvicorn' ? 'ignore' : 'pipe'], detached: true });
  let log = '';
  if (child.stderr) child.stderr.on('data', (d) => { if (log.length < 200000) log += d; });
  child.on('error', (e) => stop(4, `could not measure: the server did not start (${e.code})`));
  const exitedEarly = (code) => stop(4, `could not measure: the server exited early (code ${code})`);
  child.on('exit', exitedEarly);

  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    up = await new Promise((r) => { const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) await stop(4, 'could not measure: the server did not start within 15 s');
  const r = await measureIdleClose({ port });
  if (r.idleCloseMs === null) await stop(4, `could not measure: ${r.error}`);
  // Both servers answer with "server: uvicorn"; anything else is not ours.
  if (r.serverHeader !== 'uvicorn') await stop(4, `could not measure: the reply came from ${JSON.stringify(r.serverHeader)}, not uvicorn`);
  if (stopping) await stop(4);
  child.off('exit', exitedEarly);
  console.log(JSON.stringify({
    entry: kind === 'uvicorn' ? 'uvicorn-keepalive' : 'gunicorn-keepalive-uvicorn-worker', server: kind, version,
    platform: `${process.platform}-${process.arch}, CPython ${pythonVersion}`, date: new Date().toISOString().slice(0, 10),
    resolution: { sweepStepMs: 1, injectedLatencyMs: 0 },
    ...(kind === 'uvicorn' ? {} : { observed: { workerClass: /\[INFO\] Using worker: (\S+)/.exec(log)?.[1] ?? null } }),
    measured: { idleCloseMs: r.idleCloseMs },
  }));
  await stop(0);
} catch (e) {
  await stop(4, `could not measure: ${e.message.split('\n')[0]}`);
}
