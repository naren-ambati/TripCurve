// A stand-in for a measurement script, used only by the lane runner tests. It starts no server and
// uses no network. The runner gives it a clean environment, so its behaviour comes from two files
// next to it: line.json (the line it prints) and mode.txt (how it misbehaves).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const mode = readFileSync(`${dir}mode.txt`, 'utf8').trim();
const line = JSON.parse(readFileSync(`${dir}line.json`, 'utf8'));
if (mode === 'env') line.observed = { ...line.observed, envKeys: Object.keys(process.env).sort(), argv: process.argv.slice(2) };
if (mode === 'ignoreterm') {
  // ignores SIGTERM and never finishes: only SIGKILL stops it
  writeFileSync(`${dir}pid.txt`, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'grandchild') {
  // a server the script started: it ignores SIGTERM too, and only a group kill reaches it
  const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  writeFileSync(`${dir}gpid.txt`, String(g.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'exit0onterm') {
  // on SIGTERM it prints a good line and exits 0, as if it had finished
  writeFileSync(`${dir}pid.txt`, String(process.pid));
  process.on('SIGTERM', () => {
    console.log(JSON.stringify(line));
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'noline') process.exit(0);
if (mode === 'notjson') {
  console.log('this is not json');
  process.exit(0);
}
console.log(JSON.stringify(line));
if (mode === 'twolines') console.log(JSON.stringify(line));
if (mode === 'exit3') process.exit(3);
if (mode === 'exit4') process.exit(4);
