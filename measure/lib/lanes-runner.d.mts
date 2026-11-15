// Types for lanes-runner.mjs, so the typechecked tests can import it.

export interface RunnerDeps {
  rootDir: string;
  fetch: (url: string | URL, init?: object) => Promise<Response>;
  run: (
    cmd: string,
    args: readonly string[],
    what: string,
    env: Record<string, string>,
  ) => string;
  spawn: (...args: any[]) => any;
  fs: {
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string, options?: object) => unknown;
    readFileSync: (path: string, encoding: 'utf8') => string;
    writeFileSync: (path: string, data: string | Uint8Array) => void;
    rmSync: (path: string, options?: object) => void;
    appendFileSync: (path: string, data: string) => void;
  };
  platform: string;
  arch: string;
  env: { PATH?: string | undefined; HOME?: string | undefined } & Record<string, string | undefined>;
  now: () => Date;
  loadavg: () => number[];
  cores: number;
  out: (text: string) => void;
  err: (text: string) => void;
  signal?: AbortSignal;
  killAfterMs?: number;
  caseLimitMs?: number;
}

export function parseArgs(
  argv: readonly string[],
  defaultKb: string,
): { opt: Record<string, unknown>; message?: undefined } | { message: string; opt?: undefined };
export function runLane(argv: readonly string[], deps: RunnerDeps): Promise<number>;
