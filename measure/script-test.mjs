// Script-level checks for py-idle-close.mjs against real servers.
// Run: node measure/script-test.mjs <venv with gunicorn, uvicorn-worker, uvicorn>
// An interrupt during the measurement must never produce a result line:
// stopping the server closes the connection, and that close is not an
// idle close (regression for a fake 1556 ms result with exit 0).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const venv = process.argv[2];
if (!venv) { console.error('usage: script-test.mjs <venv>'); process.exit(2); }
const script = fileURLToPath(new URL('./py-idle-close.mjs', import.meta.url));

function runInterrupted(kind, afterMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, venv, kind], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    setTimeout(() => p.kill('SIGINT'), afterMs);
    p.on('exit', (code) => resolve({ code, out }));
  });
}

let failed = 0;
// gunicorn closes after about 2 s; interrupt after 1.5 s, mid-measurement.
for (const [kind, afterMs] of [['gunicorn-uvicorn', 1500], ['uvicorn', 3000]]) {
  const r = await runInterrupted(kind, afterMs);
  const ok = r.code === 4 && r.out.trim() === '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${kind} interrupted at ${afterMs} ms: exit ${r.code}, stdout ${JSON.stringify(r.out.trim())}`);
  if (!ok) failed++;
}
// py-b2.mjs: the same interrupt regression (gthread closes at about 2 s;
// interrupt at 1.5 s), and bad usage exits 2 with no result line.
function run(script2, args, afterMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script2, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    if (afterMs) setTimeout(() => p.kill('SIGINT'), afterMs);
    p.on('exit', (code) => resolve({ code, out }));
  });
}
const b2 = fileURLToPath(new URL('./py-b2.mjs', import.meta.url));
const ht = fileURLToPath(new URL('./py-b2-httptools.mjs', import.meta.url));
const checks = [
  { name: 'py-b2 threads interrupted at 1500 ms', args: [venv, 'threads'], after: 1500, code: 4 },
  { name: 'py-b2 precedence interrupted at 1500 ms', args: [venv, 'precedence', 'cli'], after: 1500, code: 4 },
  { name: 'py-b2 unknown mode', args: [venv, 'bogus'], code: 2 },
  { name: 'py-b2 unknown precedence source', args: [venv, 'precedence', 'cli,bogus'], code: 2 },
  { name: 'py-b2 precedence without a list', args: [venv, 'precedence'], code: 2 },
  { name: 'py-b2 not installed', args: [`${venv}-missing`, 'sync'], code: 3 },
];
// py-b2-httptools.mjs: usage and not-installed exits, and the same interrupt
// regression (the default uvicorn idle close is 5 s; interrupt at 1.5 s).
checks.push(
  { name: 'py-b2-httptools bad http value', script: ht, args: [venv, 'uvicorn', 'bogus'], code: 2 },
  { name: 'py-b2-httptools bad N', script: ht, args: [venv, 'worker', '0'], code: 2 },
  { name: 'py-b2-httptools not installed', script: ht, args: [`${venv}-missing`, 'worker'], code: 3 },
  { name: 'py-b2-httptools uvicorn interrupted at 1500 ms', script: ht, args: [venv, 'uvicorn', 'auto'], after: 1500, code: 4 },
);
for (const c of checks) {
  const r = await run(c.script ?? b2, c.args, c.after);
  const ok = r.code === c.code && r.out.trim() === '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: exit ${r.code}, stdout ${JSON.stringify(r.out.trim())}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'script-test: all cases passed' : `script-test: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
