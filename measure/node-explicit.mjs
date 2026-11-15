// Idle close of Node's http.createServer with an EXPLICIT keepAliveTimeout,
// measured with the Node that runs this script:
//   <node> measure/node-explicit.mjs <keepAliveTimeoutMs> [--buffer=<ms>] [--form=assign|options] [--cap-ms=<ms>]
// assign (default): server.keepAliveTimeout = N after createServer.
// options: http.createServer({keepAliveTimeout: N}, handler); no --buffer.
// Prints one JSON line: plus `case` and `observed` (the values
// read back from the running server; null when the property does not exist).
// Exit 0 measured, 2 usage error, 4 could not measure.
import http from 'node:http';
import { measureIdleClose } from './lib/idle-close.mjs';

const usage = (m) => { console.error(`usage error: ${m}\nusage: node-explicit.mjs <keepAliveTimeoutMs 1..300000> [--buffer=<0..60000>] [--form=assign|options] [--cap-ms=<1000..600000>]`); process.exit(2); };
const whole = (s, lo, hi, what) => {
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(s)) usage(`${what} must be a whole number, got ${JSON.stringify(String(s).slice(0, 40))}`);
  const n = Number(s);
  if (n < lo || n > hi) usage(`${what} must be ${lo}..${hi}, got ${n}`);
  return n;
};
const args = process.argv.slice(2);
if (args.length < 1) usage('missing keepAliveTimeoutMs');
const timeoutMs = whole(args[0], 1, 300000, 'keepAliveTimeoutMs');
let bufferMs = null, form = 'assign', capMs = 30000;
for (const a of args.slice(1)) {
  const m = /^--(buffer|form|cap-ms)=(.*)$/s.exec(a);
  if (!m) usage(`unknown argument ${JSON.stringify(a.slice(0, 40))}`);
  if (m[1] === 'buffer') bufferMs = whole(m[2], 0, 60000, '--buffer');
  else if (m[1] === 'cap-ms') capMs = whole(m[2], 1000, 600000, '--cap-ms');
  else if (m[2] === 'assign' || m[2] === 'options') form = m[2];
  else usage('--form must be assign or options');
}
if (form === 'options' && bufferMs !== null) usage('--buffer is not allowed with --form=options');
if (capMs <= timeoutMs + (bufferMs ?? 1000)) usage('--cap-ms must exceed keepAliveTimeoutMs plus the buffer');

// NODE_OPTIONS could change the server under test, so a set value refuses.
if (process.env.NODE_OPTIONS) { console.error('could not measure: NODE_OPTIONS is set; run with a clean environment'); process.exit(4); }
const handler = (req, res) => res.end('ok');
const read = (v) => (typeof v === 'number' ? v : null);
let srv;
if (form === 'options') srv = http.createServer({ keepAliveTimeout: timeoutMs }, handler);
else {
  srv = http.createServer(handler);
  srv.keepAliveTimeout = timeoutMs;
  if (bufferMs !== null) srv.keepAliveTimeoutBuffer = bufferMs;
}
srv.listen(0, '127.0.0.1', async () => {
  const observed = { keepAliveTimeout: read(srv.keepAliveTimeout), keepAliveTimeoutBuffer: read(srv.keepAliveTimeoutBuffer) };
  const r = await measureIdleClose({ port: srv.address().port, capMs });
  srv.close();
  if (r.idleCloseMs === null) { console.error(`could not measure: ${r.error}`); process.exit(4); }
  const c = form === 'options' ? `createServer-options keepAliveTimeout=${timeoutMs}`
    : `assign keepAliveTimeout=${timeoutMs}${bufferMs === null ? '' : ` keepAliveTimeoutBuffer=${bufferMs}`}`;
  console.log(JSON.stringify({
    entry: 'node-explicit-keepalive', server: 'node http.createServer (explicit)', version: process.version.slice(1),
    platform: `${process.platform}-${process.arch}`, date: new Date().toISOString().slice(0, 10), case: c,
    resolution: { sweepStepMs: 1, injectedLatencyMs: 0 }, observed, measured: { idleCloseMs: r.idleCloseMs },
  }));
});
