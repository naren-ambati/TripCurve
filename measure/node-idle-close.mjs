// Default idle close of Node's http.createServer, measured with the Node
// that runs this script: `<node> measure/node-idle-close.mjs`. Prints one
// JSON line. Exit 0 measured, 4 could not measure.
import http from 'node:http';
import { measureIdleClose } from './lib/idle-close.mjs';

// NODE_OPTIONS could change the server under test, so a set value refuses.
if (process.env.NODE_OPTIONS) { console.error('could not measure: NODE_OPTIONS is set; run with a clean environment'); process.exit(4); }
const line = process.version.replace(/^v(\d+)\..*/, '$1');
const srv = http.createServer((req, res) => res.end('ok')); // all defaults
srv.listen(0, '127.0.0.1', async () => {
  const r = await measureIdleClose({ port: srv.address().port });
  srv.close();
  if (r.idleCloseMs === null) { console.error(`could not measure: ${r.error}`); process.exit(4); }
  console.log(JSON.stringify({
    entry: `node-idle-close-${line}x`, server: 'node http.createServer (defaults)', version: process.version.slice(1),
    platform: `${process.platform}-${process.arch}`, date: new Date().toISOString().slice(0, 10),
    resolution: { sweepStepMs: 1, injectedLatencyMs: 0 }, measured: { idleCloseMs: r.idleCloseMs },
  }));
});
