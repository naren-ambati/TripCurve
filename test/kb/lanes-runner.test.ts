// B8: the runner half of the lanes (lookups, downloads, checksums, installs, running a
// script, the exit code) with a fetch stub, a stand-in for uv/npm/tar and fake scripts. No
// server starts and no network is used. Every test here exists because a mutant of the runner
// survived the first version of the suite; the mutant each one kills is named in its title.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEntries, type RawEntry } from '../../measure/lib/lanes-core.mjs';
import { makeWorld, stubFetch, type World } from '../support/lanes-world.js';

// A killed process is reaped by the OS shortly after the signal, not at once, so "gone" is polled for a
// bounded time. The fake grandchild never exits on its own (setInterval, SIGTERM ignored), so a process
// that was not killed is still alive after the wait and the assertion fails.
async function goneWithin(pid: number, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const KB_DIR = join(import.meta.dirname, '..', '..', 'src', 'kb', 'data');
const shipped = loadEntries(KB_DIR);
const node = process.versions.node;
const major = Number(node.split('.')[0]);

function entry(id: string, patch: Record<string, unknown> = {}): RawEntry {
  const e = shipped.find((x) => x.id === id);
  if (e === undefined) throw new Error(`no entry ${id}`);
  return { ...structuredClone(e), ...patch } as RawEntry;
}
const nodeEntry = (patch: Record<string, unknown> = {}) =>
  entry('node-idle-close-22x', {
    id: 'fixture-node',
    applies: { runtime: 'node', versionRange: `>=${major}.0.0 <${major + 1}.0.0` },
    measuredVersions: [node],
    ...patch,
  });
const NODE_LINE = {
  entry: 'fake',
  server: 'fake',
  version: node,
  platform: 'x',
  date: '2026-11-12',
  resolution: { sweepStepMs: 1, injectedLatencyMs: 0 },
  measured: { idleCloseMs: 6001 },
};
const GUN_LINE = {
  ...NODE_LINE,
  version: 'gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0',
  observed: { workerClass: 'uvicorn_worker.UvicornWorker' },
};

let world: World | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
});
function make(entries: readonly RawEntry[]): World {
  world = makeWorld(entries);
  world.cacheNode(node);
  world.cacheNode('22.23.2');
  world.cacheNode('22.23.5');
  return world;
}

describe('running a script (pinned lane, fake script, real child process)', () => {
  it('a script inside the tolerance passes: exit 0, LANE PASS, the raw line saved as printed', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const raw = join(w.root, 'raw.jsonl');
    const r = await w.lane(['pinned', `--raw=${raw}`]);
    expect(r.code).toBe(0);
    expect(r.stdout.at(-1)).toMatch(/^LANE PASS/);
    expect(readFileSync(raw, 'utf8')).toBe(`${JSON.stringify(NODE_LINE)}\n`);
  });

  it('a script that prints a good line but exits non-zero is a failure (mutant: exit code not checked)', async () => {
    for (const mode of ['exit3', 'exit4']) {
      const w = make([nodeEntry()]);
      w.setLine('node-idle-close.mjs', NODE_LINE, mode);
      const r = await w.lane(['pinned']);
      expect(r.code, mode).toBe(1);
      expect(r.stdout.join('\n'), mode).toMatch(/FAIL .*could not measure \(exit [34]\)/);
      w.cleanup();
    }
  });

  it('a script must print exactly one JSON line (mutant: line count not checked)', async () => {
    for (const mode of ['twolines', 'noline', 'notjson']) {
      const w = make([nodeEntry()]);
      w.setLine('node-idle-close.mjs', NODE_LINE, mode);
      const r = await w.lane(['pinned']);
      expect(r.code, mode).toBe(1);
      expect(r.stdout.join('\n'), mode).toContain('FAIL');
      w.cleanup();
    }
  });

  it('a value that drifted from the entry fails the lane with exit 1 (mutant: lane exit code)', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', { ...NODE_LINE, measured: { idleCloseMs: 6100 } });
    const r = await w.lane(['pinned']);
    expect(r.code).toBe(1);
    expect(r.stdout.at(-1)).toMatch(/^LANE FAIL/);
  });

  it('the script gets a clean environment: PATH and HOME only', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'env');
    const raw = join(w.root, 'raw.jsonl');
    await w.lane(['pinned', `--raw=${raw}`]);
    const line = JSON.parse(readFileSync(raw, 'utf8')) as { observed: { envKeys: string[] } };
    expect(line.observed.envKeys.filter((k) => !k.startsWith('__CF'))).toEqual(['HOME', 'PATH']);
  });

  it('a Node that is not installed fails the case, never passes it', async () => {
    const w = make([
      nodeEntry({
        measuredVersions: ['0.0.1'],
        applies: { runtime: 'node', versionRange: '>=0.0.1 <1.0.0' },
      }),
    ]);
    w.setLine('node-idle-close.mjs', { ...NODE_LINE, version: '0.0.1' });
    const r = await w.lane(['pinned']);
    expect(r.code).toBe(1);
    expect(r.stdout.join('\n')).toContain('is not installed');
  });

  it('refuses to run over a knowledge-base gap, with exit 1 and nothing measured', async () => {
    const w = make([nodeEntry({ scriptRef: undefined })]);
    const r = await w.lane(['pinned']);
    expect(r.code).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/gap: fixture-node: scriptRef/);
  });

  it('prints the host load at the start and the end, and says when the host is busy', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const quiet = await w.lane(['pinned'], { load: [0.5, 0.4, 0.3] });
    const q = quiet.stdout.join('\n');
    expect(q).toMatch(
      /host load average \(1, 5, 15 min\) at start: 0\.50 0\.40 0\.30 on 8 cores$/m,
    );
    expect(q).toMatch(/host load average \(1, 5, 15 min\) at end: /);
    expect(q).not.toContain('host is busy');
    const busy = await w.lane(['pinned'], { load: [9.5, 8, 7] });
    expect(busy.stdout.join('\n')).toMatch(
      /at start: 9\.50 .* on 8 cores; host is busy, timing may be skewed/,
    );
    // exactly half the cores is not busy
    const edge = await w.lane(['pinned'], { load: [4, 4, 4] });
    expect(edge.stdout.join('\n')).not.toContain('host is busy');
  });

  it('a lane over a part of the knowledge base says so (--only)', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['pinned', '--only=fixture-node']);
    expect(r.code).toBe(0);
    expect(r.stdout.at(-1)).toMatch(/^LANE PASS \(partial: --only\)/);
  });
});

const indexFor = (versions: readonly string[]) =>
  versions.map((v) => ({ version: `v${v}`, files: ['osx-arm64-tar', 'linux-x64'] }));
const NODE_IDX = 'https://nodejs.org/dist/index.json';
const PYPI = (n: string) => `https://pypi.org/pypi/${n}/json`;
const NPM = 'https://registry.npmjs.org/lightship';
const rel = (...vs: string[]) => ({
  releases: Object.fromEntries(vs.map((v) => [v, [{ yanked: false }]])),
});

function fullEntries(): RawEntry[] {
  return [
    nodeEntry(),
    entry('gunicorn-keepalive-uvicorn-worker-26x'),
    entry('uvicorn-keepalive-0-54x'),
    entry('lightship-shutdown-delay-9x'),
  ];
}
function fullRoutes(over: Record<string, { status?: number; body: string | object }> = {}) {
  return {
    [NODE_IDX]: { body: indexFor([node]) },
    [PYPI('gunicorn')]: { body: rel('26.2.0') },
    [PYPI('uvicorn')]: { body: rel('0.54.0') },
    [PYPI('uvicorn-worker')]: { body: rel('0.4.0') },
    [NPM]: { body: { versions: { '9.1.0': {} } } },
    ...over,
  };
}

describe('the latest lane: lookups (mutants: non-200 read as success, lookup failure exit code)', () => {
  for (const status of [403, 404, 429, 500]) {
    for (const url of [NODE_IDX, PYPI('gunicorn'), PYPI('uvicorn'), PYPI('uvicorn-worker'), NPM]) {
      it(`HTTP ${status} from ${url} stops the lane with exit 4, even when the body is a valid list`, async () => {
        const w = make(fullEntries());
        w.setLine('node-idle-close.mjs', NODE_LINE);
        const good = fullRoutes();
        const body = good[url]?.body ?? '';
        const r = await w.lane(['latest'], {
          fetch: stubFetch({ ...good, [url]: { status, body } }),
        });
        expect(r.code).toBe(4);
        expect(r.stderr.join('\n')).toContain(`HTTP ${status}`);
        expect(r.stdout.join('\n')).not.toMatch(/LANE (PASS|FAIL)/);
      });
    }
  }

  it('a network failure stops the lane with exit 4', async () => {
    const w = make(fullEntries());
    const r = await w.lane(['latest'], {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(r.code).toBe(4);
    expect(r.stderr.join('\n')).toMatch(/could not look up/);
  });

  it('a runtime with entries but no plain release in the list is a lookup failure (exit 4)', async () => {
    const w = make(fullEntries());
    const r = await w.lane(['latest'], {
      fetch: stubFetch(fullRoutes({ [PYPI('gunicorn')]: { body: { releases: {} } } })),
    });
    expect(r.code).toBe(4);
    expect(r.stderr.join('\n')).toMatch(/gunicorn: the list has no plain X\.Y\.Z release/);
  });

  it('a version that is not a plain X.Y.Z is printed as unrecognised, not compared', async () => {
    const w = make(fullEntries());
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['latest'], {
      fetch: stubFetch(
        fullRoutes({ [PYPI('gunicorn')]: { body: rel('26.2.0', '28.0', '29.0.0rc1') } }),
      ),
    });
    const text = r.stdout.join('\n');
    expect(text).toMatch(/unrecognised version, not compared.*28\.0/);
    expect(text).toMatch(/unrecognised version, not compared.*29\.0\.0rc1/);
  });

  it('only runtimes the knowledge base has entries for are looked up', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const seen: string[] = [];
    const r = await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node]) } }, seen),
    });
    expect(seen).toEqual([NODE_IDX]);
    expect(r.code).toBe(0);
  });
});

describe('the latest lane: downloads, hashes and installs', () => {
  const NEWER = `${major}.99.0`;
  const tarName = `node-v${NEWER}-darwin-arm64.tar.gz`;
  const bytes = new TextEncoder().encode('not really a tarball');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const routes = (sum: string) => ({
    [NODE_IDX]: { body: indexFor([node, NEWER]) },
    [`https://nodejs.org/dist/v${NEWER}/SHASUMS256.txt`]: { body: `${sum}  ${tarName}\n` },
    [`https://nodejs.org/dist/v${NEWER}/${tarName}`]: { body: bytes },
  });

  it('a tarball whose SHA-256 differs from SHASUMS256.txt is refused: exit 4, never unpacked (mutant: hash not compared)', async () => {
    const w = make([nodeEntry()]);
    const r = await w.lane(['latest'], { fetch: stubFetch(routes('0'.repeat(64))) });
    expect(r.code).toBe(4);
    expect(r.stderr.join('\n')).toMatch(/checksum mismatch/);
    expect(w.calls.some((c) => c.cmd === 'tar')).toBe(false);
    expect(existsSync(join(w.cache, 'node', `node-v${NEWER}-darwin-arm64`))).toBe(false);
  });

  it('a matching hash is unpacked with tar into the cache, and its hash is printed', async () => {
    const w = make([nodeEntry()]);
    const r = await w.lane(['latest'], { fetch: stubFetch(routes(sha)) });
    const tar = w.calls.find((c) => c.cmd === 'tar');
    expect(tar?.args[0]).toBe('-xzf');
    expect(tar?.args).toContain(join(w.cache, 'node'));
    expect(r.stdout.join('\n')).toContain(sha);
  });

  it('SHASUMS256.txt with no line for the tarball is refused', async () => {
    const w = make([nodeEntry()]);
    const r = await w.lane(['latest'], {
      fetch: stubFetch({
        ...routes(sha),
        [`https://nodejs.org/dist/v${NEWER}/SHASUMS256.txt`]: { body: `${sha}  other.tar.gz\n` },
      }),
    });
    expect(r.code).toBe(4);
    expect(w.calls.some((c) => c.cmd === 'tar')).toBe(false);
  });

  it('a Node already in the cache is said to be found there, not re-verified', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node]) } }),
    });
    const text = r.stdout.join('\n');
    expect(text).toMatch(/found in the cache .*, not re-verified/);
    expect(text).not.toMatch(/checksum-verified/);
  });

  it('a newer release outside every range fails the lane with exit 1 (mutant: drift not passed to the verdict)', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node, `${major + 1}.0.0`]) } }),
    });
    expect(r.code).toBe(1);
    expect(r.stdout.join('\n')).toMatch(new RegExp(`FAIL +drift .*node ${major + 1}\\.0\\.0`));
    expect(r.stdout.at(-1)).toMatch(/^LANE FAIL.*1 drift finding/);
  });

  it('the same lookup with nothing newer passes, so the drift test above can tell the two apart', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node]) } }),
    });
    expect(r.code).toBe(0);
  });

  it('a yanked release and a release with no files are never picked (mutant: yanked filter)', async () => {
    const w = make(fullEntries());
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const gunicorn = {
      releases: {
        '26.2.0': [{ yanked: false }],
        '26.3.0': [{ yanked: true }, { yanked: true }],
        '26.4.0': [],
      },
    };
    await w.lane(['latest'], {
      fetch: stubFetch(fullRoutes({ [PYPI('gunicorn')]: { body: gunicorn } })),
    });
    const venv = w.calls.find((c) => c.cmd === 'uv' && c.args[0] === 'venv');
    expect(venv?.args[1]).toContain('gunicorn-26.2.0');
    const req = readFileSync(join(String(venv?.args[1]), 'requirements.in'), 'utf8');
    expect(req).toContain('gunicorn==26.2.0');
    expect(req).not.toMatch(/26\.[34]\.0/);
  });

  it('a release with one yanked and one live file is still picked', async () => {
    const w = make(fullEntries());
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const gunicorn = {
      releases: { '26.5.0': [{ yanked: true }, { yanked: false }], '26.6.0': [{ yanked: true }] },
    };
    await w.lane(['latest'], {
      fetch: stubFetch(fullRoutes({ [PYPI('gunicorn')]: { body: gunicorn } })),
    });
    const venv = w.calls.find((c) => c.cmd === 'uv' && c.args[0] === 'venv');
    expect(venv?.args[1]).toContain('gunicorn-26.5.0');
  });

  it('Python is installed from hashes only, wheels only (mutants: --require-hashes, --only-binary)', async () => {
    const w = make(fullEntries());
    w.setLine('node-idle-close.mjs', NODE_LINE);
    await w.lane(['latest'], { fetch: stubFetch(fullRoutes()) });
    const compile = w.calls.find(
      (c) => c.cmd === 'uv' && c.args[0] === 'pip' && c.args[1] === 'compile',
    );
    const install = w.calls.find(
      (c) => c.cmd === 'uv' && c.args[0] === 'pip' && c.args[1] === 'install',
    );
    expect(compile?.args).toContain('--generate-hashes');
    expect(install?.args).toContain('--require-hashes');
    const i = install?.args.indexOf('--only-binary') ?? -1;
    expect(i).toBeGreaterThan(-1);
    expect(install?.args[i + 1]).toBe(':all:');
  });

  it('lightship is installed without running any install script (mutant: --ignore-scripts)', async () => {
    const w = make(fullEntries());
    w.setLine('node-idle-close.mjs', NODE_LINE);
    await w.lane(['latest'], { fetch: stubFetch(fullRoutes()) });
    const npm = w.calls.find((c) => c.cmd === 'npm');
    expect(npm?.args).toContain('--ignore-scripts');
    expect(npm?.args).toContain('lightship@9.1.0');
  });

  it('the uvicorn worker entry runs against the venv built for its gunicorn line', async () => {
    const w = make(fullEntries());
    w.setLine('py-idle-close.mjs', GUN_LINE);
    const r = await w.lane(['latest', '--only=gunicorn-keepalive-uvicorn-worker-26x'], {
      fetch: stubFetch(fullRoutes()),
    });
    expect(r.stdout.join('\n')).toMatch(/g26: installed gunicorn 26\.2\.0, uvicorn 0\.54\.0/);
  });
});

describe('B2 (second review): a run on a busy host is not an official run', () => {
  const twoCases = () => nodeEntry({ measuredVersions: [node, node] });
  const run = async (loads: number[], line: object = NODE_LINE) => {
    const w = make([twoCases()]);
    w.setLine('node-idle-close.mjs', line);
    return w.lane(['pinned'], { loads });
  };
  const OFFICIAL = /^LANE PASS( |:)/;

  it('a quiet run is a clean pass: exit 0', async () => {
    // cores are 8, so 4 is the edge and is not busy
    const r = await run([0.2, 4, 0.3, 0.1]);
    expect(r.code).toBe(0);
    expect(r.stdout.at(-1)).toMatch(OFFICIAL);
    expect(r.stdout.at(-1)).not.toContain('busy');
  });

  for (const [label, loads] of [
    ['at the start', [4.1, 0.1, 0.1, 0.1]],
    ['before a case in the middle', [0.1, 0.1, 4.1, 0.1]],
    ['at the end', [0.1, 0.1, 0.1, 4.1]],
    ['only in the middle, then quiet again', [0.1, 9, 0.1, 0.1]],
  ] as const) {
    it(`a run that passes but was busy ${label} is not official: exit 5`, async () => {
      const r = await run([...loads]);
      expect(r.code).toBe(5);
      expect(r.stdout.at(-1)).toMatch(/^LANE PASS \(host was busy: not an official run\): /);
      expect(r.stdout.join('\n')).toContain('host is busy');
    });
  }

  it('a busy run that fails stays FAIL with exit 1', async () => {
    const r = await run([9, 9, 9, 9], { ...NODE_LINE, measured: { idleCloseMs: 6100 } });
    expect(r.code).toBe(1);
    expect(r.stdout.at(-1)).toMatch(/^LANE FAIL/);
  });

  it('the load is sampled at the start, before every case and at the end', async () => {
    const r = await run([0.11, 0.12, 0.13, 0.14]);
    const text = r.stdout.join('\n');
    expect(text).toMatch(/at start: 0\.11 /);
    // four samples were taken: start, two cases, end, so the end line shows the fourth
    expect(text).toMatch(/at end: 0\.14 /);
  });
});

describe('m6 (second review): a worker on an uncovered uvicorn release fails through runLane', () => {
  const workerLine = (uvicorn: string) => ({
    ...NODE_LINE,
    version: `gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn ${uvicorn}`,
    observed: { workerClass: 'uvicorn_worker.UvicornWorker' },
    measured: { idleCloseMs: 2002 },
  });
  const run = async (uvicorn: string) => {
    const w = make([
      entry('gunicorn-keepalive-uvicorn-worker-26x'),
      entry('uvicorn-keepalive-0-54x'),
    ]);
    mkdirSync(join(w.cache, 'py-g26'), { recursive: true });
    w.setLine('py-idle-close.mjs', workerLine(uvicorn));
    const r = await w.lane(['pinned', '--only=gunicorn-keepalive-uvicorn-worker-26x']);
    return r;
  };
  it('a covered uvicorn release passes (control)', async () => {
    const r = await run('0.54.0');
    expect(r.stdout.join('\n')).toMatch(/PASS +gunicorn-keepalive-uvicorn-worker-26x/);
    expect(r.code).toBe(0);
  });
  it('an uncovered uvicorn release fails the case and the lane', async () => {
    const r = await run('0.55.0');
    expect(r.stdout.join('\n')).toMatch(
      /FAIL +gunicorn-keepalive-uvicorn-worker-26x .*uvicorn 0\.55\.0 is not covered/,
    );
    expect(r.code).toBe(1);
  });
});

describe('m7 (second review): lookups cover every runtime with an entry; deferred ranges do not count as covered', () => {
  const trapWide = () =>
    entry('node-headers-trap-10x', {
      applies: { runtime: 'node', versionRange: '>=0.0.0 <200.0.0' },
    });
  it('a runtime that has only a deferred entry is still looked up', async () => {
    const w = make([trapWide()]);
    const seen: string[] = [];
    await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node]) } }, seen),
    });
    expect(seen).toEqual([NODE_IDX]);
  });
  it('a newer release is drift even when only a deferred entry range contains it', async () => {
    const w = make([nodeEntry(), trapWide()]);
    w.setLine('node-idle-close.mjs', NODE_LINE);
    const r = await w.lane(['latest'], {
      fetch: stubFetch({ [NODE_IDX]: { body: indexFor([node, `${major + 1}.0.0`]) } }),
    });
    expect(r.code).toBe(1);
    expect(r.stdout.join('\n')).toMatch(new RegExp(`FAIL +drift .*node ${major + 1}\\.0\\.0`));
  });
});

describe('m8 (second review): an interrupt kills a script that ignores SIGTERM', () => {
  it('SIGTERM first, SIGKILL after a bounded wait, and no process is left', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'ignoreterm');
    const ctl = new AbortController();
    const pidFile = join(w.root, 'measure', 'pid.txt');
    const started = Date.now();
    const lane = w.lane(['pinned'], { signal: ctl.signal, killAfterMs: 300 });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    ctl.abort();
    const r = await lane;
    expect(Date.now() - started).toBeLessThan(15000);
    expect(r.code).toBe(1);
    expect(r.stdout.join('\n')).toMatch(/FAIL .*interrupted/);
    expect(await goneWithin(pid)).toBe(true);
  }, 20000);

  it('a server the script started (a grandchild) is killed with the script', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'grandchild');
    const ctl = new AbortController();
    const gFile = join(w.root, 'measure', 'gpid.txt');
    const lane = w.lane(['pinned'], { signal: ctl.signal, killAfterMs: 300 });
    for (let i = 0; i < 200 && !existsSync(gFile); i++) await new Promise((r) => setTimeout(r, 25));
    const gpid = Number(readFileSync(gFile, 'utf8'));
    expect(() => process.kill(gpid, 0)).not.toThrow();
    ctl.abort();
    await lane;
    expect(await goneWithin(gpid)).toBe(true);
  }, 20000);

  it('a script that exits 0 after the abort is still an interrupted case, a FAIL', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'exit0onterm');
    const ctl = new AbortController();
    const pidFile = join(w.root, 'measure', 'pid.txt');
    const lane = w.lane(['pinned'], { signal: ctl.signal, killAfterMs: 5000 });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 25));
    ctl.abort();
    const r = await lane;
    expect(r.stdout.join('\n')).toMatch(/FAIL .*interrupted/);
    expect(r.stdout.join('\n')).not.toMatch(/PASS +fixture-node/);
    expect(r.code).toBe(1);
  }, 20000);

  it('the per-case time limit kills the script and its grandchild (SIGTERM, then SIGKILL) and the case fails', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'grandchild');
    const gFile = join(w.root, 'measure', 'gpid.txt');
    const r = await w.lane(['pinned'], { caseLimitMs: 400, killAfterMs: 300 });
    expect(r.stdout.join('\n')).toMatch(/FAIL .*killed by SIG(TERM|KILL) after the/);
    expect(r.code).toBe(1);
    const gpid = Number(readFileSync(gFile, 'utf8'));
    expect(await goneWithin(gpid)).toBe(true);
  }, 20000);

  it('the per-case time limit kills a script that ignores SIGTERM', async () => {
    const w = make([nodeEntry()]);
    w.setLine('node-idle-close.mjs', NODE_LINE, 'ignoreterm');
    const r = await w.lane(['pinned'], { caseLimitMs: 400, killAfterMs: 300 });
    expect(r.code).toBe(1);
    const pid = Number(readFileSync(join(w.root, 'measure', 'pid.txt'), 'utf8'));
    expect(await goneWithin(pid)).toBe(true);
  }, 20000);
});
