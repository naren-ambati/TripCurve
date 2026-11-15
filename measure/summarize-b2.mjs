// Print the B2 results table from the raw lines, so the README table can be
// checked against the JSONL: node measure/summarize-b2.mjs measure/results/<date>-b2.jsonl
import { readFileSync } from 'node:fs';
const file = process.argv[2];
if (!file) { console.error('usage: summarize-b2.mjs <results.jsonl>'); process.exit(2); }
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  // Round 4 lines also differ by protocol and installed httptools (plain vs [standard] venv).
  const key = `${r.version}\t${r.entry}\t${JSON.stringify(r.case)}${r.protocol ? `\t${r.protocol}\thttptools ${r.observed.httptools}` : ''}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
for (const [key, rs] of groups) {
  const [version, entry, c, , tools] = key.split('\t');
  const m = rs.map((r) => (r.measured.idleCloseMs !== undefined ? `${r.measured.idleCloseMs}` : `closes=${r.measured.closesAfterResponse} header=${r.measured.connectionCloseHeader} closeMs=${r.measured.closeMs}`));
  const wc = [...new Set(rs.map((r) => r.observed.workerClass))].join('|');
  // Round 4 lines carry the protocol the app saw serving the request.
  const proto = [...new Set(rs.map((r) => r.protocol))].filter(Boolean).join('|');
  console.log(`${version} | ${entry} | ${c} | worker=${wc}${proto ? ` | protocol=${proto} (${tools})` : ''} | ${m.join(', ')}`);
}
console.log(`${rows.length} lines`);
