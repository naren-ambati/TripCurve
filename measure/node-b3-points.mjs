// B3 extra points, run by the Node under test:
//   <node> measure/node-b3-points.mjs explicit12000|explicit65000|options65000|buffer1000-k7000|buffer0-k65000
// Calls node-explicit.mjs unchanged (child process, same Node, clean
// environment). Exit 0 measured, 2 usage, 3 not applicable (buffer cases
// where the property is missing; nothing printed), 4 could not measure.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CASES = {
  explicit12000: ['12000'],
  explicit65000: ['65000', '--cap-ms=120000'],
  options65000: ['65000', '--form=options', '--cap-ms=120000'],
  'buffer1000-k7000': ['7000', '--buffer=1000'],
  'buffer0-k65000': ['65000', '--buffer=0', '--cap-ms=120000'],
};
const which = process.argv[2];
if (!Object.hasOwn(CASES, which) || process.argv.length !== 3) { console.error(`usage: node-b3-points.mjs ${Object.keys(CASES).join('|')}`); process.exit(2); }
if (process.env.NODE_OPTIONS) { console.error('could not measure: NODE_OPTIONS is set; run with a clean environment'); process.exit(4); }
if (which.startsWith('buffer')) {
  const p = http.createServer(() => {}); const has = typeof p.keepAliveTimeoutBuffer === 'number'; p.close();
  if (!has) { console.error('not applicable: keepAliveTimeoutBuffer does not exist on this Node'); process.exit(3); }
}
const here = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(here, 'node-explicit.mjs'), ...CASES[which]], { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' }, encoding: 'utf8' });
if (r.status !== 0) { console.error(`could not measure: node-explicit.mjs exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`); process.exit(4); }
const m = JSON.parse(r.stdout.trim());
console.log(JSON.stringify({ entry: 'node-points-b3', server: 'node http.createServer', version: m.version, platform: m.platform, date: m.date, case: m.case, resolution: m.resolution, observed: m.observed, measured: m.measured }));
