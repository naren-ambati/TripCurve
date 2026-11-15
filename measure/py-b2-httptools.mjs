// B2 round 4: idle close with the httptools protocol, and proof of which HTTP
// implementation served the request.
//   node measure/py-b2-httptools.mjs <venv> worker [N]          gunicorn -k uvicorn_worker.UvicornWorker, --keep-alive N if given
//   node measure/py-b2-httptools.mjs <venv> uvicorn <http> [N]  uvicorn alone, --http <auto|httptools|h11>, --timeout-keep-alive N if given
// The app (app_std.py) prints which protocol class and event loop serve the
// request; this script reads that from the server's stderr pipe. A run whose
// protocol cannot be established is exit 4, never a line. Clean environment,
// 127.0.0.1 only, own process group, killed on exit or interrupt.
// Exit 0 measured, 2 usage, 3 not installed, 4 could not measure.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { measureIdleClose } from './lib/idle-close.mjs';

const [venv, mode, a3, a4] = process.argv.slice(2);
const HTTP = ['auto', 'httptools', 'h11'];
const http = mode === 'uvicorn' ? a3 : undefined;
const nArg = mode === 'uvicorn' ? a4 : a3;
const n = nArg === undefined ? null : /^[1-9][0-9]{0,3}$/.test(nArg) ? Number(nArg) : NaN;
if (!venv || !['worker', 'uvicorn'].includes(mode) || Number.isNaN(n) || (mode === 'uvicorn' && !HTTP.includes(http)) || (mode === 'worker' && a4 !== undefined)) {
  console.error('usage: py-b2-httptools.mjs <venv> worker [N] | <venv> uvicorn <auto|httptools|h11> [N]'); process.exit(2);
}
const capS = Math.max(120, (n ?? 0) + 100);
const bin = (x) => `${venv}/bin/${x}`;
const exe = mode === 'worker' ? 'gunicorn' : 'uvicorn';
if (!existsSync(bin(exe)) || !existsSync(bin('python'))) { console.error(`server not installed: ${bin(exe)}`); process.exit(3); }
const here = fileURLToPath(new URL('.', import.meta.url));
const env = { PATH: `${venv}/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? '/', PYTHONDONTWRITEBYTECODE: '1' };

let child = null;
let stopping = false;
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
  const py = (code) => execFileSync(bin('python'), ['-c', code], { env }).toString().trim();
  const ver = (mod) => py(`import importlib.metadata as m\ntry: print(m.version("${mod}"))\nexcept m.PackageNotFoundError: print("not installed")`);
  const pythonVersion = py('import sys; print(sys.version.split()[0])');
  const packages = { httptools: ver('httptools'), uvloop: ver('uvloop') };
  const version = mode === 'worker' ? `gunicorn ${ver('gunicorn')} + uvicorn-worker ${ver('uvicorn-worker')} + uvicorn ${ver('uvicorn')}` : `uvicorn ${ver('uvicorn')}`;

  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  let args;
  if (mode === 'worker') args = ['-c', `${here}gunicorn-empty.conf.py`, '-k', 'uvicorn_worker.UvicornWorker', '-w', '1', '-b', `127.0.0.1:${port}`, ...(n ? ['--keep-alive', String(n)] : []), 'app_std:app'];
  else args = ['--host', '127.0.0.1', '--port', String(port), '--http', http, ...(n ? ['--timeout-keep-alive', String(n)] : []), 'app_std:app'];
  child = spawn(bin(exe), args, { cwd: here, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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
  const r = await measureIdleClose({ port, capMs: capS * 1000 });
  if (r.idleCloseMs === null) await stop(4, `could not measure: ${r.error}`);
  if (r.serverHeader !== 'uvicorn') await stop(4, `could not measure: the reply came from ${JSON.stringify(r.serverHeader)}, not uvicorn`);
  // The protocol marker, printed by the app while it served the request.
  const marks = [...log.matchAll(/^TRIPCURVE-PROTOCOL (\S+) loop=(\S+)$/gm)];
  if (marks.length !== 1) await stop(4, `could not measure: expected one protocol line from the app, found ${marks.length}`);
  const [, protocolClass, loopClass] = marks[0];
  const protocol = { 'uvicorn.protocols.http.httptools_impl.HttpToolsProtocol': 'httptools', 'uvicorn.protocols.http.h11_impl.H11Protocol': 'h11' }[protocolClass];
  if (!protocol) await stop(4, `could not measure: the protocol could not be established (${JSON.stringify(protocolClass)})`);
  if (stopping) await stop(4);
  child.off('exit', exitedEarly);
  console.log(JSON.stringify({
    entry: mode === 'worker' ? 'gunicorn-keepalive-uvicorn-worker-http' : 'uvicorn-keepalive-http', server: mode === 'worker' ? 'gunicorn-uvicorn' : 'uvicorn', version,
    platform: `${process.platform}-${process.arch}, CPython ${pythonVersion}`, date: new Date().toLocaleDateString('en-CA'),
    case: mode === 'worker' ? { args: n ? `--keep-alive ${n}` : '(none)' } : { args: `--http ${http}${n ? ` --timeout-keep-alive ${n}` : ''}` },
    protocol, resolution: { sweepStepMs: 1, injectedLatencyMs: 0 },
    observed: { protocolClass, loopClass, httptools: packages.httptools, uvloop: packages.uvloop },
    measured: { idleCloseMs: r.idleCloseMs },
  }));
  await stop(0);
} catch (e) {
  await stop(4, `could not measure: ${e.message.split('\n')[0]}`);
}
