// Print the B4-more table from the raw lines, or check README-b4-more.md against them:
//   node measure/summarize-b4-more.mjs <results.jsonl>                      print the table
//   node measure/summarize-b4-more.mjs <results.jsonl> <README-b4-more.md>  exit 1 unless every row is in the README verbatim and the README has no other data row
import { readFileSync } from 'node:fs';
const [file, readme] = process.argv.slice(2);
if (!file) { console.error('usage: summarize-b4-more.mjs <results.jsonl> [README-b4-more.md]'); process.exit(2); }
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const key = `${r.version}\t${r.case.name}\t${r.case.args}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const uniq = (a) => [...new Set(a)].join(' ; ');
const lines = [];
for (const [key, rs] of groups) {
  const p = key.split('\t');
  const m = rs.map((r) => r.measured);
  lines.push(`| ${p[0]} | \`${p[1]}\` | \`${p[2]}\` | ${m.map((x) => x.sigtermToConnectionClosedMs).join(', ')} | ${m.map((x) => `[${x.sigtermToEachWorkerGoneMs.join(' / ')}]`).join(', ')} | ${m.map((x) => x.sigtermToMainExitMs).join(', ')} | ${uniq(m.map((x) => x.responseComplete))} | ${uniq(m.map((x) => `${x.connectionClose}, exit ${x.mainExit.code}`))} |`);
}
if (!readme) { console.log(lines.join('\n')); console.log(`${rows.length} lines`); process.exit(0); }
const text = readFileSync(readme, 'utf8');
const missing = lines.filter((l) => !text.split('\n').includes(l));
const tableRows = text.split('\n').filter((l) => /^\| gunicorn \d/.test(l));
const extra = tableRows.filter((l) => !lines.includes(l));
for (const l of missing) console.error(`missing from README: ${l}`);
for (const l of extra) console.error(`not in JSONL: ${l}`);
const ok = missing.length === 0 && extra.length === 0;
console.log(ok ? `table matches ${rows.length} JSONL lines (${lines.length} rows)` : 'MISMATCH');
process.exit(ok ? 0 : 1);
