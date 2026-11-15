// Print the B3 table from the raw lines, or check a README against them:
//   node measure/summarize-b3.mjs <results.jsonl>              print the table
//   node measure/summarize-b3.mjs <results.jsonl> <README-b3.md>  exit 1 unless every row is in the README verbatim
import { readFileSync } from 'node:fs';
const [file, readme] = process.argv.slice(2);
if (!file) { console.error('usage: summarize-b3.mjs <results.jsonl> [README-b3.md]'); process.exit(2); }
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const key = `${r.version}\t${r.case}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const fmt = (v) => (v === null ? 'null' : String(v));
const lines = [];
for (const [key, rs] of groups) {
  const [version, c] = key.split('\t');
  const obs = [...new Set(rs.map((r) => `${fmt(r.observed.keepAliveTimeout)} / ${fmt(r.observed.keepAliveTimeoutBuffer)}`))].join(' ; ');
  lines.push(`| ${version} | \`${c}\` | ${obs} | ${rs.map((r) => r.measured.idleCloseMs).join(', ')} |`);
}
if (!readme) { console.log(lines.join('\n')); console.log(`${rows.length} lines`); process.exit(0); }
const text = readFileSync(readme, 'utf8');
const missing = lines.filter((l) => !text.includes(l));
const tableRows = text.split('\n').filter((l) => /^\| \d+\.\d+\.\d+ \| `/.test(l));
const extra = tableRows.filter((l) => !lines.includes(l));
for (const l of missing) console.error(`missing from README: ${l}`);
for (const l of extra) console.error(`not in JSONL: ${l}`);
console.log(missing.length === 0 && extra.length === 0 ? `table matches ${rows.length} JSONL lines (${lines.length} rows)` : 'MISMATCH');
process.exit(missing.length === 0 && extra.length === 0 ? 0 : 1);
