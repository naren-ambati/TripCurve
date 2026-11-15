// Print the B4 tables from the raw lines, or check README-b4.md against them:
//   node measure/summarize-b4.mjs <results.jsonl>                  print the tables
//   node measure/summarize-b4.mjs <results.jsonl> <README-b4.md>   exit 1 unless every row is in the README verbatim and the README has no other data row
import { readFileSync } from 'node:fs';
const [file, readme] = process.argv.slice(2);
if (!file) { console.error('usage: summarize-b4.mjs <results.jsonl> [README-b4.md]'); process.exit(2); }
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const key = r.entry === 'lightship-shutdown-delay' ? `L\t${r.version}\t${r.case.mode}` : `S\t${r.version}\t${r.case.name}\t${r.case.kind}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const uniq = (a) => [...new Set(a)].join(' ; ');
const lines = [];
for (const [key, rs] of groups) {
  const p = key.split('\t');
  const m = rs.map((r) => r.measured);
  if (p[0] === 'L') {
    lines.push(`| ${p[1]} | \`${p[2]}\` | ${m.map((x) => x.sigtermToNotReadyMs ?? 'n/a').join(', ')} | ${m.map((x) => x.sigtermToHandlerStartMs ?? 'n/a').join(', ')} | ${m.map((x) => x.sigtermToServerClosedMs ?? 'n/a').join(', ')} | ${m.map((x) => x.sigtermToExitMs ?? 'n/a').join(', ')} |`);
  } else {
    lines.push(`| ${p[1]} | \`${p[2]}\` | ${p[3]} | ${m.map((x) => x.sigtermToConnectionClosedMs).join(', ')} | ${m.map((x) => x.sigtermToWorkerGoneMs ?? 'n/a').join(', ')} | ${m.map((x) => x.sigtermToMainExitMs).join(', ')} | ${uniq(m.map((x) => x.responseComplete))} | ${uniq(m.map((x) => x.connectionClose))} |`);
  }
}
if (!readme) { console.log(lines.join('\n')); console.log(`${rows.length} lines`); process.exit(0); }
const text = readFileSync(readme, 'utf8');
const missing = lines.filter((l) => !text.includes(`${l}\n`) && !text.endsWith(l));
const tableRows = text.split('\n').filter((l) => /^\| (gunicorn|uvicorn|lightship) \d/.test(l));
const extra = tableRows.filter((l) => !lines.includes(l));
for (const l of missing) console.error(`missing from README: ${l}`);
for (const l of extra) console.error(`not in JSONL: ${l}`);
console.log(missing.length === 0 && extra.length === 0 ? `tables match ${rows.length} JSONL lines (${lines.length} rows)` : 'MISMATCH');
process.exit(missing.length === 0 && extra.length === 0 ? 0 : 1);
