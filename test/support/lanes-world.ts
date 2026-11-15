// A throwaway repository for the lane runner tests: a knowledge base of a few entries, fake
// measurement scripts, and a cache folder whose "Node" is the Node running the test. No server
// starts, and the only network is a stub that refuses any address a test did not list.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RawEntry } from '../../measure/lib/lanes-core.mjs';
import { runLane } from '../../measure/lib/lanes-runner.mjs';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'lanes', 'fake-script.mjs');

export interface Route {
  readonly status?: number;
  readonly body: string | object | Uint8Array;
}

export function stubFetch(routes: Readonly<Record<string, Route>>, seen: string[] = []) {
  return async (url: string | URL): Promise<Response> => {
    const u = String(url);
    seen.push(u);
    const route = routes[u];
    if (route === undefined) throw new Error(`unexpected request to ${u}`);
    const body =
      route.body instanceof Uint8Array || typeof route.body === 'string'
        ? route.body
        : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200 });
  };
}

export interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
}

export interface World {
  readonly root: string;
  readonly cache: string;
  readonly kb: string;
  readonly calls: Call[];
  setLine(script: string, line: object, mode?: string): void;
  cacheNode(version: string): void;
  lane(
    argv: readonly string[],
    over?: {
      fetch?: (url: string | URL) => Promise<Response>;
      run?: Runner;
      load?: number[];
      loads?: number[];
      signal?: AbortSignal;
      killAfterMs?: number;
      caseLimitMs?: number;
    },
  ): Promise<{ code: number; stdout: string[]; stderr: string[] }>;
  cleanup(): void;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  what: string,
  env?: Record<string, string>,
) => string;

export function makeWorld(entries: readonly RawEntry[]): World {
  const root = mkdtempSync(join(tmpdir(), 'tc-lanes-world-'));
  const measure = join(root, 'measure');
  const cache = join(root, 'cache');
  const kb = join(root, 'kb');
  mkdirSync(measure, { recursive: true });
  mkdirSync(kb, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const scripts = new Set(
    entries.flatMap((e) => (typeof e.scriptRef === 'string' ? [basename(e.scriptRef)] : [])),
  );
  // Every fake sits in measure/ and reads the one line.json and mode.txt beside it.
  for (const name of scripts) copyFileSync(FAKE, join(measure, name));
  writeFileSync(join(measure, 'mode.txt'), 'ok');
  writeFileSync(join(kb, 'fixture.json'), JSON.stringify({ schemaVersion: 1, entries }));
  const calls: Call[] = [];
  const world: World = {
    root,
    cache,
    kb,
    calls,
    setLine(_script, line, mode = 'ok') {
      writeFileSync(join(measure, 'line.json'), JSON.stringify(line));
      writeFileSync(join(measure, 'mode.txt'), mode);
    },
    cacheNode(version) {
      const bin = join(cache, 'node', `node-v${version}-darwin-arm64`, 'bin');
      mkdirSync(bin, { recursive: true });
      if (!existsSync(join(bin, 'node'))) symlinkSync(process.execPath, join(bin, 'node'));
    },
    async lane(argv, over = {}) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const run: Runner = over.run ?? fakeRun;
      const code = await runLane([...argv, `--cache=${cache}`, `--kb=${kb}`], {
        rootDir: root,
        fetch: over.fetch ?? stubFetch({}),
        run: (cmd, args, what, env) => {
          calls.push({ cmd, args });
          return run(cmd, args, what, env);
        },
        spawn,
        platform: 'darwin',
        arch: 'arm64',
        env: { PATH: '/usr/bin:/bin', HOME: root, NODE_OPTIONS: '--no-warnings' },
        now: () => new Date('2026-11-12T00:00:00Z'),
        loadavg: () => {
          if (over.loads === undefined) return over.load ?? [0.1, 0.1, 0.1];
          const v =
            over.loads.length > 1 ? (over.loads.shift() as number) : (over.loads[0] as number);
          return [v, v, v];
        },
        ...(over.signal === undefined ? {} : { signal: over.signal }),
        ...(over.killAfterMs === undefined ? {} : { killAfterMs: over.killAfterMs }),
        ...(over.caseLimitMs === undefined ? {} : { caseLimitMs: over.caseLimitMs }),
        cores: 8,
        out: (t: string) => stdout.push(t),
        err: (t: string) => stderr.push(t),
        fs: {
          existsSync,
          mkdirSync,
          readFileSync,
          writeFileSync,
          rmSync,
          appendFileSync: appendTo,
        },
      });
      return { code, stdout, stderr };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}

import { appendFileSync } from 'node:fs';

function appendTo(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
}

/** Stands in for uv, npm and tar: makes the folders and files the runner goes on to read. */
export const fakeRun: Runner = (cmd, args) => {
  if (cmd === 'uv' && args[0] === 'venv') mkdirSync(String(args[1]), { recursive: true });
  if (cmd === 'npm') {
    const dir = String(args[args.indexOf('--prefix') + 1]);
    mkdirSync(join(dir, 'node_modules', 'lightship'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'lightship', 'package.json'), '{}');
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/lightship': { integrity: 'sha512-fake' } } }),
    );
  }
  return '';
};
