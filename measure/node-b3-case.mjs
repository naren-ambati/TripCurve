// B3 version runner: one case, run by the Node under test.
//   <node> measure/node-b3-case.mjs default|explicit7000|buffer0
// Calls the existing measurers unchanged as child processes (same Node,
// clean environment) and prints one JSON line with the case, the property
// values read back from a fresh server (null if missing) and the measurement.
// Exit 0 measured, 2 usage, 3 case not applicable (buffer0 where the
// property is missing: nothing printed), 4 could not measure.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const which = process.argv[2];
if (!['default', 'explicit7000', 'buffer0'].includes(which) || process.argv.length !== 3) {
  console.error('usage: node-b3-case.mjs default|explicit7000|buffer0'); process.exit(2);
}
if (process.env.NODE_OPTIONS) { console.error('could not measure: NODE_OPTIONS is set; run with a clean environment'); process.exit(4); }
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (v) => (typeof v === 'number' ? v : null);
const probe = http.createServer(() => {});
const defaults = { keepAliveTimeout: read(probe.keepAliveTimeout), keepAliveTimeoutBuffer: read(probe.keepAliveTimeoutBuffer) };
probe.close();
if (which === 'buffer0' && defaults.keepAliveTimeoutBuffer === null) { console.error('not applicable: keepAliveTimeoutBuffer does not exist on this Node'); process.exit(3); }

const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`could not measure: ${script} exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`); process.exit(4); }
  return JSON.parse(r.stdout.trim());
};
let m, observed, c;
if (which === 'default') { m = run('node-idle-close.mjs', []); observed = defaults; c = 'default'; }
else {
  m = which === 'explicit7000' ? run('node-explicit.mjs', ['7000']) : run('node-explicit.mjs', ['7000', '--buffer=0']);
  observed = m.observed; c = m.case;
}
console.log(JSON.stringify({
  entry: 'node-versions-b3', server: 'node http.createServer', version: m.version, platform: m.platform, date: m.date,
  case: c, resolution: m.resolution, observed, measured: m.measured,
}));
