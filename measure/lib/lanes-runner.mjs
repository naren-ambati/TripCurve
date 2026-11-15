// The runner half of the measurement lanes (bolt B8): arguments, read-only lookups, checksummed
// downloads, installs into .cache/, running a script with a clean environment, and the exit code.
// Everything that touches the outside (fetch, child processes, the file system, the clock, the
// output) is passed in, so the tests drive it with a fetch stub, a stand-in for uv/npm/tar and
// fake scripts (test/kb/lanes-runner.test.ts). lanes.mjs passes the real ones.
//
// Exit codes: 0 lane passed, 1 lane failed or the knowledge base has a gap, 2 usage, 4 the lane
// could not run (a lookup or a download failed, a checksum differed): never read as "no change".
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  compareVersions,
  judgeLane,
  kbGaps,
  latestTargets,
  loadEntries,
  newerOutsideRanges,
  parseVersion,
  planCases,
  runCases,
  statedReasons,
  deferredEntries,
  unrecognisedVersions,
} from './lanes-core.mjs';

// The Node that drives the Python scripts (B0 to B4 used 22.23.2) and lightship (B4 used 22.23.5).
const DRIVER_NODE = '22.23.2';
const LIGHTSHIP_NODE = '22.23.5';
const USAGE =
  'usage: node measure/lanes.mjs <pinned|latest> [--jobs=1..16] [--list] [--full] [--only=<entry id>] [--raw=<file>] [--cache=<dir>] [--kb=<dir>]';
const NODE_FILE_ID = {
  'darwin-arm64': 'osx-arm64-tar',
  'darwin-x64': 'osx-x64-tar',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

/** Reads the command line. Returns {opt} or {message} for a usage error. */
export function parseArgs(argv, defaultKb) {
  const [lane, ...rest] = argv;
  if (lane !== 'pinned' && lane !== 'latest') return { message: 'the first argument is pinned or latest' };
  const opt = { lane, jobs: 1, list: false, full: false, only: null, raw: null, cache: null, kb: defaultKb };
  for (const a of rest) {
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (!m) return { message: `unknown argument ${JSON.stringify(a.slice(0, 40))}` };
    const [, key, value] = m;
    if (key === 'list' && value === undefined) opt.list = true;
    else if (key === 'full' && value === undefined) opt.full = true;
    else if (key === 'jobs' && /^[1-9]\d?$/.test(value ?? '') && Number(value) <= 16) opt.jobs = Number(value);
    else if (['only', 'raw', 'cache', 'kb'].includes(key) && value) opt[key] = value;
    else return { message: `bad option ${JSON.stringify(a.slice(0, 40))}` };
  }
  return { opt };
}

/**
 * Runs one lane and returns the exit code.
 * deps: rootDir, fetch, run(cmd, args, what, env) -> stdout (throws on failure), spawn, fs, platform,
 * arch, env {PATH, HOME}, now(), out(text), err(text), signal (an AbortSignal that interrupts).
 */
export async function runLane(argv, deps) {
  const { rootDir, fs, out, err } = deps;
  const measureDir = join(rootDir, 'measure');
  const parsed = parseArgs(argv, join(rootDir, 'src', 'kb', 'data'));
  if (parsed.message !== undefined) {
    err(`usage error: ${parsed.message}`);
    err(USAGE);
    return 2;
  }
  const opt = parsed.opt;
  const platform = `${deps.platform}-${deps.arch}`;

  // ---- the knowledge base and the gap check: nothing runs over a gap ----
  let allEntries;
  try {
    allEntries = loadEntries(opt.kb);
  } catch (e) {
    err(`could not read the knowledge base: ${String(e.message).split('\n')[0]}`);
    return 1;
  }
  const gaps = kbGaps(allEntries, measureDir);
  if (gaps.length > 0) {
    for (const g of gaps) err(`gap: ${g.entryId}: ${g.field}: ${g.message}`);
    err('lane not run: the knowledge base has gaps');
    return 1;
  }
  const entries = opt.only ? allEntries.filter((e) => e.id === opt.only) : allEntries;
  if (entries.length === 0) {
    err(`usage error: no entry named ${JSON.stringify(opt.only)}`);
    err(USAGE);
    return 2;
  }

  // ---- the cache folder: <repo>/.cache, or the main checkout's when this is a worktree ----
  const cache = (() => {
    if (opt.cache) return resolve(opt.cache);
    // The first one that holds installed runtimes: other tools (the end-to-end build) use .cache/ too.
    for (const c of [join(rootDir, '.cache'), join(rootDir, '..', '..', '.cache')]) if (fs.existsSync(join(c, 'node'))) return c;
    return join(rootDir, '.cache');
  })();
  const nodeBin = (version) => join(cache, 'node', `node-v${version}-${platform}`, 'bin', 'node');

  // ---- listing ----
  if (opt.list) {
    for (const e of entries) {
      const reason = statedReasons([e])[0];
      const deferred = deferredEntries([e])[0];
      if (reason) {
        out(`${e.id}: not measurable locally: ${reason.reason}`);
        continue;
      }
      if (deferred) {
        out(`${e.id}: DEFERRED (${deferred.bolt}), not measured: ${deferred.reason}`);
        continue;
      }
      const cases = planCases(e, { full: opt.full, entries: allEntries });
      out(`${e.id}: ${cases.length} case${cases.length === 1 ? '' : 's'}`);
      for (const c of cases) {
        out(`  ${c.label}: ${c.script} ${c.args.join(' ')} -> entry ${c.expectedMs === null ? 'n/a' : `${c.expectedMs} ms`}, tolerance ${c.toleranceMs} ms`);
      }
    }
    return 0;
  }

  // ---- read-only lookups and downloads (GET only, into .cache/) ----
  async function get(url, what, asBuffer = false) {
    let res;
    try {
      res = await deps.fetch(url, { signal: AbortSignal.timeout(asBuffer ? 600000 : 60000), headers: { 'user-agent': 'tripcurve-measure-lanes' } });
    } catch (e) {
      throw new Error(`could not look up ${what}: ${e.cause?.code ?? e.name ?? 'network error'}`);
    }
    // A 403, a 404 or a rate limit is "could not look up", never "nothing newer".
    if (!res.ok) throw new Error(`could not look up ${what}: HTTP ${res.status}`);
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
  }
  const newestOf = (versions) => versions.filter((v) => parseVersion(v) !== null).sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)))[0];

  async function lookups() {
    out(`## lookups, read-only GET, ${deps.now().toISOString()}`);
    // every runtime that has any entry (scripted, deferred or reasoned) is looked up, so drift is still seen
    const wanted = new Set(allEntries.map((e) => e.applies?.runtime));
    const releases = {};
    let worker;
    const check = (runtime, list) => {
      const bad = unrecognisedVersions(list);
      for (const v of bad.slice(0, 20)) out(`${runtime}: unrecognised version, not compared: ${JSON.stringify(String(v).slice(0, 40))}`);
      if (bad.length > 20) out(`${runtime}: ... and ${bad.length - 20} more unrecognised versions, not compared`);
      if (list.length === bad.length) throw new Error(`could not look up ${runtime}: the list has no plain X.Y.Z release (lookup failure)`);
    };
    let nodeHere = [];
    if (wanted.has('node')) {
      const index = JSON.parse(await get('https://nodejs.org/dist/index.json', 'the Node release index'));
      const fileId = NODE_FILE_ID[platform];
      if (!fileId) throw new Error(`the latest lane does not know the Node download name for ${platform}`);
      releases.node = index.map((r) => String(r.version).replace(/^v/, ''));
      nodeHere = index.filter((r) => r.files?.includes(fileId)).map((r) => String(r.version).replace(/^v/, ''));
      check('node', releases.node);
    }
    const pypi = async (name) => {
      const j = JSON.parse(await get(`https://pypi.org/pypi/${name}/json`, `PyPI ${name}`));
      // A release counts only while at least one of its files is still available (not yanked).
      return Object.entries(j.releases ?? {}).filter(([, files]) => files.length > 0 && !files.every((f) => f.yanked)).map(([v]) => v);
    };
    for (const name of ['gunicorn', 'uvicorn']) {
      if (!wanted.has(name)) continue;
      releases[name] = await pypi(name);
      check(name, releases[name]);
    }
    if (wanted.has('lightship')) {
      const npm = JSON.parse(await get('https://registry.npmjs.org/lightship', 'the npm entry for lightship'));
      releases.lightship = Object.keys(npm.versions ?? {});
      check('lightship', releases.lightship);
    }
    if (wanted.has('gunicorn')) {
      const list = await pypi('uvicorn-worker');
      check('uvicorn-worker', list);
      worker = newestOf(list);
    }
    const newest = Object.fromEntries(Object.entries(releases).map(([k, v]) => [k, [newestOf(v)].filter(Boolean)]));
    out(`newest releases: ${Object.entries(newest).map(([k, v]) => `${k} ${v[0]}`).join(', ')}${worker ? `, uvicorn-worker ${worker}` : ''}`);
    const targets = latestTargets(allEntries, { ...releases, ...(wanted.has('node') ? { node: nodeHere } : {}) });
    for (const [k, v] of Object.entries(targets)) out(`newest release inside each ${k} range: ${v.join(', ') || 'none'}`);
    return { newest, targets, worker };
  }

  function run(cmd, args, what, extraEnv = {}) {
    try {
      return deps.run(cmd, args, what, { PATH: deps.env.PATH ?? '/usr/bin:/bin', HOME: deps.env.HOME ?? '/', ...extraEnv });
    } catch (e) {
      throw new Error(`${what} failed: ${String(e.message).split('\n')[0].slice(0, 300)}`);
    }
  }

  async function installNode(version) {
    if (fs.existsSync(nodeBin(version))) {
      out(`node ${version}: found in the cache ${cache}/node, not re-verified (the tarball is not kept, so its checksum cannot be checked again)`);
      return;
    }
    const name = `node-v${version}-${platform}.tar.gz`;
    const base = `https://nodejs.org/dist/v${version}`;
    const sums = await get(`${base}/SHASUMS256.txt`, `SHASUMS256.txt of Node ${version}`);
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name)?.[0];
    if (!want) throw new Error(`SHASUMS256.txt of Node ${version} has no line for ${name}`);
    const bytes = await get(`${base}/${name}`, name, true);
    const have = createHash('sha256').update(bytes).digest('hex');
    if (have !== want) throw new Error(`checksum mismatch for ${name}: got ${have}, SHASUMS256.txt says ${want}`);
    fs.mkdirSync(join(cache, 'downloads'), { recursive: true });
    const tmp = join(cache, 'downloads', name);
    fs.writeFileSync(tmp, bytes);
    fs.mkdirSync(join(cache, 'node'), { recursive: true });
    run('tar', ['-xzf', tmp, '-C', join(cache, 'node')], `unpacking ${name}`);
    fs.rmSync(tmp, { force: true });
    out(`node ${version}: downloaded ${name}, sha256 ${have} equals its line in SHASUMS256.txt`);
  }

  function installVenv(key, gunicorn, uvicorn, worker) {
    const dir = join(cache, `py-latest-${key}-gunicorn-${gunicorn}-uvicorn-${uvicorn}-worker-${worker}`);
    if (fs.existsSync(join(dir, 'bin', 'gunicorn'))) {
      out(`${key}: gunicorn ${gunicorn}, uvicorn ${uvicorn}, uvicorn-worker ${worker}: found in ${dir}, not re-verified`);
      return dir;
    }
    run('uv', ['--version'], 'uv is needed to build the Python environments; uv');
    fs.rmSync(dir, { recursive: true, force: true });
    run('uv', ['venv', dir], 'creating the virtualenv');
    const req = join(dir, 'requirements.in');
    fs.writeFileSync(req, `gunicorn==${gunicorn}\nuvicorn==${uvicorn}\nuvicorn-worker==${worker}\n`);
    const python = join(dir, 'bin', 'python');
    // Every file is pinned by the hash PyPI lists, the install refuses any file that differs, and
    // only built wheels are used, so no package runs a build script.
    run('uv', ['pip', 'compile', req, '--generate-hashes', '--python', python, '-o', join(dir, 'requirements.txt')], 'resolving the Python requirements');
    run('uv', ['pip', 'install', '--require-hashes', '--only-binary', ':all:', '--python', python, '-r', join(dir, 'requirements.txt')], 'installing the Python requirements');
    out(`${key}: installed gunicorn ${gunicorn}, uvicorn ${uvicorn}, uvicorn-worker ${worker} into ${dir} with hashes from PyPI required and wheels only (uv pip install --require-hashes --only-binary :all:)`);
    return dir;
  }

  function installLightship(version) {
    const dir = join(cache, `lightship-${version}`);
    if (fs.existsSync(join(dir, 'node_modules', 'lightship', 'package.json'))) {
      out(`lightship ${version}: found in ${dir}, not re-verified`);
      return dir;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'package.json'), '{"name":"tc-lightship-latest","private":true}\n');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--cache', join(cache, 'npm-cache'), '--prefix', dir, `lightship@${version}`], 'npm install');
    const lock = JSON.parse(fs.readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    out(`lightship ${version}: installed with --ignore-scripts into ${dir}; npm checked ${lock.packages?.['node_modules/lightship']?.integrity ?? '(no integrity recorded)'} against the registry`);
    return dir;
  }

  // ---- running one case: the script, with a clean environment ----
  const children = new Set();
  let interrupted = false;
  // The script's process group gets SIGTERM, and SIGKILL after a bounded wait if it ignores it.
  const killGroup = (c, signal) => {
    try {
      process.kill(-c.pid, signal);
    } catch {
      try {
        c.kill(signal);
      } catch {}
    }
  };
  deps.signal?.addEventListener('abort', () => {
    interrupted = true;
    for (const c of children) killGroup(c, 'SIGTERM');
    const t = setTimeout(() => {
      for (const c of children) killGroup(c, 'SIGKILL');
    }, deps.killAfterMs ?? 20000);
    t.unref?.();
  });

  function makeRunner(where) {
    return (c) =>
      new Promise((resolveLine, reject) => {
        if (interrupted) return reject(new Error('could not measure: the lane was interrupted'));
        const argv = [join(rootDir, c.script)];
        let bin;
        if (c.toolchain === 'node') bin = nodeBin(c.version);
        else if (c.toolchain === 'lightship') {
          bin = nodeBin(LIGHTSHIP_NODE);
          argv.push(where.lightship(c.version));
        } else {
          bin = nodeBin(DRIVER_NODE);
          argv.push(where.venv(c.venv));
        }
        if (!fs.existsSync(bin)) return reject(new Error(`could not measure: ${c.toolchain === 'node' ? `Node ${c.version}` : 'the driver Node'} is not installed at ${bin}`));
        const dirArg = argv[1];
        if (c.toolchain !== 'node' && (dirArg === undefined || !fs.existsSync(dirArg))) {
          return reject(new Error(`could not measure: ${c.toolchain === 'venv' ? `no ${c.venv} Python environment` : 'no lightship install'} at ${dirArg}`));
        }
        argv.push(...c.args);
        const child = deps.spawn(bin, argv, { cwd: rootDir, env: { PATH: '/usr/bin:/bin', HOME: deps.env.HOME ?? '/' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        children.add(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { if (stdout.length < 1e6) stdout += d; });
        child.stderr.on('data', (d) => { if (stderr.length < 1e5) stderr += d; });
        const limit = deps.caseLimitMs ?? (c.expectedMs ?? 70000) + 180000;
        // past the limit the script's whole process group gets SIGTERM, then SIGKILL after a bounded wait
        const timer = setTimeout(() => {
          killGroup(child, 'SIGTERM');
          setTimeout(() => killGroup(child, 'SIGKILL'), deps.killAfterMs ?? 15000).unref();
        }, limit);
        child.on('error', (e) => { children.delete(child); clearTimeout(timer); reject(new Error(`could not measure: ${e.code ?? e.message}`)); });
        child.on('close', (code, signal) => {
          children.delete(child);
          clearTimeout(timer);
          if (interrupted) return reject(new Error('could not measure: the lane was interrupted'));
          if (code !== 0) {
            const why = signal ? `killed by ${signal} after the ${limit / 1000} s limit` : `exit ${code}`;
            return reject(new Error(`could not measure (${why}): ${stderr.split('\n').filter(Boolean)[0] ?? 'no message'}`));
          }
          const lines = stdout.split('\n').filter((l) => l.trim() !== '');
          if (lines.length !== 1) return reject(new Error(`could not measure: the script printed ${lines.length} lines, not one`));
          let parsed;
          try {
            parsed = JSON.parse(lines[0]);
          } catch {
            return reject(new Error('could not measure: the script line is not JSON'));
          }
          if (opt.raw) fs.appendFileSync(opt.raw, `${lines[0]}\n`);
          resolveLine(parsed);
        });
      });
  }

  // ---- the lane ----
  try {
    out(`tripcurve measurement lane: ${opt.lane}`);
    out(`started ${deps.now().toISOString()}, ${platform}, runner node ${process.version}, cache ${cache}, jobs ${opt.jobs}${opt.full ? ', --full' : ''}`);
    // A timing measurement must not share the CPU with another one: one script at a time by default.
    if (opt.jobs > 1) out('measurements ran in parallel; timing may be skewed');
    // Nor with the rest of the machine: the load is printed at the start and at the end, and a busy host is said to be.
    // A run is busy if any sample (start, before each case, end) is above half the cores (B8 second review B2).
    let busy = false;
    const sample = () => {
      const l = deps.loadavg();
      if (l[0] > deps.cores / 2) busy = true;
      return l;
    };
    const loadLine = (when) => {
      const [one, five, fifteen] = sample();
      const text = `host load average (1, 5, 15 min) at ${when}: ${one.toFixed(2)} ${five.toFixed(2)} ${fifteen.toFixed(2)} on ${deps.cores} cores`;
      return one > deps.cores / 2 ? `${text}; host is busy, timing may be skewed` : text;
    };
    out(loadLine('start'));
    // `--only` on an entry that carries a stated reason or is deferred has nothing to run: say that, not "FAIL, 0 of 0
    // cases". Exit 2, as for any request the runner cannot act on; a full lane is unchanged.
    if (opt.only !== null && entries.length === 1) {
      const only = entries[0];
      const stated = statedReasons([only])[0];
      const deferredOnly = deferredEntries([only])[0];
      if (stated) {
        out(`NOT RUN (partial: --only): ${only.id} carries a stated reason; nothing to measure`);
        return 2;
      }
      if (deferredOnly) {
        out(`NOT RUN (partial: --only): ${only.id} is deferred to ${deferredOnly.bolt}; nothing to measure`);
        return 2;
      }
    }
    const where = { venv: (key) => join(cache, key === 'g27' ? 'py-g27' : 'py-g26'), lightship: () => join(cache, 'lightship') };
    let drift = [];
    let cases;
    if (opt.lane === 'pinned') {
      cases = entries.flatMap((e) => planCases(e, { full: opt.full, entries: allEntries }));
    } else {
      const { newest, targets, worker } = await lookups();
      drift = newerOutsideRanges(allEntries, newest);
      for (const v of targets.node ?? []) await installNode(v);
      const venvs = new Map();
      for (const g of targets.gunicorn ?? []) {
        const u = (targets.uvicorn ?? [])[0];
        if (u === undefined || worker === undefined) continue;
        const key = `g${parseVersion(g).major}`;
        venvs.set(key, installVenv(key, g, u, worker));
      }
      const lightships = new Map();
      for (const v of targets.lightship ?? []) lightships.set(v, installLightship(v));
      // The Node drivers of the Python and lightship scripts must exist too.
      for (const v of [DRIVER_NODE, LIGHTSHIP_NODE]) if (!fs.existsSync(nodeBin(v))) await installNode(v);
      where.venv = (key) => venvs.get(key) ?? join(cache, `no-${key}-environment`);
      where.lightship = (v) => lightships.get(v) ?? join(cache, `no-lightship-${v}`);
      cases = entries.flatMap((e) => planCases(e, { full: opt.full, versions: targets[e.applies.runtime] ?? [], entries: allEntries }));
    }
    out(`${cases.length} cases for ${entries.length} entries`);
    let done = 0;
    const runOne = makeRunner(where);
    const verdicts = await runCases(cases, (c) => {
      const l = sample();
      if (l[0] > deps.cores / 2) out(`host is busy before ${c.label}: load ${l[0].toFixed(2)} on ${deps.cores} cores`);
      return runOne(c);
    }, opt.jobs, (v) => {
      done++;
      err(`[${done}/${cases.length}] ${v.ok ? 'PASS' : 'FAIL'} ${v.entryId} ${v.label}`);
    });
    out(loadLine('end'));
    const result = judgeLane({ entries, verdicts, drift, partial: opt.only !== null, busy });
    for (const l of result.lines) out(l);
    // 5: every check passed but the host was busy, so this is not an official run; no script or gate may take it for a clean pass.
    if (!result.ok) return 1;
    return busy ? 5 : 0;
  } catch (e) {
    err(`lane NOT RUN: ${String(e.message).split('\n')[0]}`);
    return 4;
  }
}
