// B4: lightship's shutdown timing, with and without the Kubernetes env var.
//   node measure/lightship-b4.mjs <lightship-dir> <k8s|local>
// k8s   = KUBERNETES_SERVICE_HOST set (this is how lightship's isKubernetes() decides)
// local = variable not set (lightship's own "local mode")
// Starts the app (lightship-app.mjs) on 127.0.0.1, sends SIGTERM, and times from
// the moment kill() returned: lightship's /ready turning not-ready, the shutdown
// handler starting, the app's server closing, the process exiting.
// Note: lightship's own status server listens on 0.0.0.0 (its code); it is moved
// off its default port 9000 with LIGHTSHIP_PORT in k8s mode. lightship has no option for the host (its
// source hard-codes 0.0.0.0), so for the few seconds of a run that port accepts connections from other
// machines; this script sends nothing outside the machine itself.
// Exit 0 measured, 2 usage, 3 not installed, 4 could not measure.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const [dir, mode] = process.argv.slice(2);
if (!dir || !['k8s', 'local'].includes(mode)) { console.error('usage: lightship-b4.mjs <lightship-dir> <k8s|local>'); process.exit(2); }
if (!existsSync(`${dir}/node_modules/lightship/package.json`)) { console.error(`lightship not installed in ${dir}`); process.exit(3); }
const version = JSON.parse(readFileSync(`${dir}/node_modules/lightship/package.json`, 'utf8')).version;
const here = fileURLToPath(new URL('.', import.meta.url));
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const appPort = await free(); const lsPort = await free();
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LIGHTSHIP_DIR: dir, APP_PORT: String(appPort), LIGHTSHIP_PORT: String(lsPort) };
if (mode === 'k8s') env.KUBERNETES_SERVICE_HOST = '127.0.0.1';

let stopping = false;
const child = spawn(process.execPath, [`${here}lightship-app.mjs`], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const stop = async (code, msg) => {
  if (stopping) return new Promise(() => {}); stopping = true;
  if (msg) console.error(msg);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  process.exit(code);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(4, `could not measure: interrupted by ${sig}`));
let t0 = null; const t = {}; let out = ''; let errOut = ''; let exitInfo = null;
child.stdout.on('data', (d) => { out += d; for (const l of String(d).split('\n')) { if (t0 !== null && /HANDLER_START|SERVER_CLOSED/.test(l)) t[l.trim()] ??= process.hrtime.bigint(); } });
child.stderr.on('data', (d) => { if (errOut.length < 20000) errOut += d; });
child.on('exit', (code, signal) => { if (t0 === null) stop(4, `could not measure: the app exited early (code ${code}) ${errOut.slice(0, 200)}`); else { exitInfo = { code, signal }; t.exit = process.hrtime.bigint(); } });
for (let i = 0; i < 150 && !out.includes('APP_READY'); i++) await new Promise((r) => setTimeout(r, 100));
if (!out.includes('APP_READY')) await stop(4, 'could not measure: the app did not start within 15 s');
// which port does lightship listen on? local mode picks a random one; k8s mode uses LIGHTSHIP_PORT
const lsAddr = (/listening on http:\/\/[^:]+:(\d+)/.exec(errOut) ?? [])[1];
const readyPort = mode === 'k8s' ? lsPort : Number(lsAddr);
const probe = () => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port: readyPort, path: '/ready' }, (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }); q.on('error', () => r(null)); q.setTimeout(500, () => { q.destroy(); r(null); }); });
const readyBefore = readyPort ? await probe() : null;
t0 = process.hrtime.bigint();
process.kill(child.pid, 'SIGTERM');
let tNotReady = null; const deadline = Date.now() + 60000;
while (Date.now() < deadline && t.exit === undefined) {
  if (tNotReady === null && readyPort) { const s = await probe(); if (s === 500) tNotReady = process.hrtime.bigint(); }
  await new Promise((r) => setTimeout(r, 20));
}
if (t.exit === undefined) await stop(4, 'could not measure: the app did not exit within 60 s');
const d = (x) => (x === undefined || x === null ? null : Math.round(Number(x - t0) / 1e5) / 10);
const result = {
  entry: 'lightship-shutdown-delay', server: 'lightship', version: `lightship ${version}`,
  platform: `${process.platform}-${process.arch}, node ${process.version}`, date: new Date().toLocaleDateString('en-CA'),
  case: { mode, KUBERNETES_SERVICE_HOST: mode === 'k8s' ? '127.0.0.1' : '(unset)', config: 'createLightship({}) (defaults)' },
  resolution: { pollMs: 20 },
  measured: { readyBeforeSigterm: readyBefore, sigtermToNotReadyMs: d(tNotReady), sigtermToHandlerStartMs: d(t.HANDLER_START), sigtermToServerClosedMs: d(t.SERVER_CLOSED), sigtermToExitMs: d(t.exit), exit: exitInfo },
};
console.log(JSON.stringify(result));
await stop(0);
