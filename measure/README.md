# Measurement scripts

Standalone scripts that measure the server defaults tripcurve's knowledge base
cites. They are not part of the shipped package and are never started by
a run of `tripcurve [path]`. Each one starts the server under test on 127.0.0.1 only,
sends one keep-alive request, times how long the server keeps the idle
connection open after the response, and prints one JSON line:

```
{entry, server, version, platform, date, resolution: {sweepStepMs, injectedLatencyMs}, measured: {idleCloseMs}}
```

Exit codes: 0 measured, 2 usage error, 3 server not installed, 4 could not
measure. A script prints a result line only when it measured one. Any other
outcome exits 4 with no line on stdout:

- the reply is not `HTTP/1.1 200` with a `Content-Length`;
- the reply says `Connection: close`;
- the connection is reset;
- the server never closes;
- the server exits early;
- the run is interrupted with SIGINT or SIGTERM.

A SIGKILL of the script itself cannot be caught, so it leaves the server running; kill it by hand.

## Method and accuracy

The method is the one in `docs/research.md` section 2: one keep-alive request,
then time how long the server takes to close the idle socket.

- **Timing.** The scripts take the timestamp of the last response byte, then the timestamp of the server's FIN, on a monotonic clock rounded to whole milliseconds. No gap is swept and no latency is injected, so the recorded resolution is `sweepStepMs: 1, injectedLatencyMs: 0`.
- **The research's experiment is different.** Its 502 reproduction swept 4 ms steps through a proxy with 20 ms latency. That experiment shows the harm, and it is not repeated here.
- **Accuracy in practice.** Across the 24 runs below, every value was 1 to 3 ms above the server's nominal setting (6000, 2000 and 5000 ms), and never below. The client sees the response a little late, and timers fire a little late.
- **Tolerance for the knowledge base.** An entry's `toleranceMs` must therefore cover the observed spread, not only the 1 ms resolution that minimum allows. A 1 ms tolerance would fail at random.

**The server sees only its defaults.**

- **Clean environment.** Each script starts the server with an environment containing only `PATH`, `HOME` and `PYTHONDONTWRITEBYTECODE`. So `GUNICORN_CMD_ARGS`, `UVICORN_*` and `WEB_CONCURRENCY` in the caller's shell cannot change it.
- **gunicorn config.** gunicorn gets `-c gunicorn-empty.conf.py`, so a `gunicorn.conf.py` in the working directory is not loaded.
- **Node.** The Node script refuses to run (exit 4) when `NODE_OPTIONS` is set.
- **Right server.** The reply must carry `server: uvicorn`, so a different process that took the port is not measured.
- **Version.** It is read from the runtime or the virtualenv that ran, never from an argument.
- **uvicorn install.** uvicorn is the plain `uvicorn` install (h11, no `[standard]` extras). The keep-alive default is the same setting either way, but only the plain install was measured.

## Tests

- **`selftest.mjs`** checks the measurer against fake servers whose behaviour is known:
  - closes 300 ms and 1200 ms after the response;
  - replies only after 500 ms, then closes 300 ms later, so the timer must start at the response, not at the request;
  - the header arrives split across two writes;
  - never closes;
  - replies with `Connection: close`, or with `Connection: keep-alive, close`;
  - replies with HTTP/1.0, 404 or chunked;
  - the body is cut short;
  - the connection is reset;
  - a lower-case `content-length`, as real servers send it;
  - `Content-Length` together with `Transfer-Encoding`, or two `Content-Length` headers;
  - extra bytes after the body, in the same write or later.

  Allowed slack is 15 ms above the true value, and nothing below it. The slack lets a bias of up to about 15 ms through: a +10 ms mutation survives. Real bias was 1 to 3 ms, and the slack is kept so the test does not fail at random on a busy machine. Each of these mutations was caught: timing from connect or from the request, a reset turned into a number, a missing completeness check, a short reply turned into 0, a +40 ms bias, accepting non-200 replies, and ignoring `Connection: close`.
- **`measureCloseAfterResponse` cases in `selftest.mjs`** (bolt B2). It records facts and keeps `measureIdleClose` strict. Cases: `Connection: close` with an immediate FIN; a lower-case header with a token list; the header present but the server never closes; no header and a FIN 300 ms after a reply that came 400 ms after the request; no header and never closes; the header split across two writes; and errors for a 404, an HTTP/1.0 reply, a cut-short body, a reset, extra bytes, no `Content-Length` and silence. Mutations of the new function, each caught: the header always reported true; only the first `Connection` token read; a still-open connection reported as closed; a 500 ms bias; a short reply reported as a close.
- **`script-test.mjs <venv>`** runs `py-idle-close.mjs` against the real servers and interrupts it mid-measurement. It must exit 4 with no result line. This is a regression test: before the fix, an interrupt closed the connection, and that close was printed as a measured idle close. The failing run is recorded in `BUILD-NOTES.md` (982 ms and 2647 ms, exit 0).

## Files

| File | What it does | Run as |
|---|---|---|
| `lib/idle-close.mjs` | the shared measurer | imported |
| `selftest.mjs` | tests the measurer | `node measure/selftest.mjs` |
| `script-test.mjs` | tests `py-idle-close.mjs` against real servers | `node measure/script-test.mjs <venv>` |
| `node-idle-close.mjs` | Node `http.createServer` default idle close | `<node under test> measure/node-idle-close.mjs` |
| `py-idle-close.mjs` + `app.py` + `gunicorn-empty.conf.py` | gunicorn with `uvicorn_worker.UvicornWorker` (`-w 1`), or uvicorn alone, all defaults | `node measure/py-idle-close.mjs <venv> <gunicorn-uvicorn\|uvicorn>` |
| `py-b2.mjs` + `wsgi_app.py` + `app.py` | gunicorn worker model (`threads`, `threads-env`, `sync`) and `keepalive` precedence (`precedence <sources>`), bolt B2 | `node measure/py-b2.mjs <venv> <mode> [sources]` |
| `run-b2.sh` | every B2 case, three runs each, both gunicorn versions; exit 1 if any run failed | `sh measure/run-b2.sh <cache-dir>` |
| `run-b2-explicit.sh` | the explicit keep-alive follow-up (below), three runs per case; slow (75 s cases) | `sh measure/run-b2-explicit.sh <cache-dir>` |
| `run-b2-explicit-300.sh` | the 300 s explicit values (below), two runs per case, the five cases in parallel, cap 400 s | `sh measure/run-b2-explicit-300.sh <cache-dir>` |
| `py-b2-httptools.mjs` + `app_std.py` | idle close with the httptools protocol, plus proof of the protocol class that served the request (round 4) | `node measure/py-b2-httptools.mjs <venv> worker [N]` or `<venv> uvicorn <auto\|httptools\|h11> [N]` |
| `run-b2-httptools.sh` | every round 4 case, in parallel streams; needs `py-g26-std` and `py-g27-std` | `sh measure/run-b2-httptools.sh <cache-dir>` |
| `summarize-b2.mjs` | prints the B2 results grouped as in the table below, from the raw lines | `node measure/summarize-b2.mjs measure/results/2026-11-11-b2.jsonl` |
| `run-b0.sh` | every seed above, three runs each, in a clean environment; exit 1 if any run failed | `sh measure/run-b0.sh <cache-dir>` |

## Setting up the servers (local only)

Servers are installed into a git-ignored `.cache/` folder at the repository
root, never globally:

- **Node**: official `darwin-arm64` tarballs from `https://nodejs.org/dist/v<version>/`, each checked against that release's `SHASUMS256.txt`, unpacked to `.cache/node/`. This includes 22.23.2, so every Node measured comes from the same source.
- **Python servers**: `uv venv --python 3.14 .cache/py-g26`, then `uv pip install --python .cache/py-g26/bin/python gunicorn==26.2.0 uvicorn==0.54.0 uvicorn-worker==0.4.0`. `py-g27` is the same with `gunicorn==27.0.0`.

## Results: day-1 measurement (bolt B0), 2026-11-11

Machine: macOS on Apple silicon (darwin-arm64), CPython 3.14.7. One machine, three runs per version.

The versions current on 2026-11-11 were looked up at 19:12Z and again at 19:34Z, from `https://nodejs.org/dist/index.json` and the PyPI JSON API. The raw output, tarball checksums and installed package lists are in `results/2026-11-11-lookups.txt`.

- Node 22.23.5 (released 2026-11-11), 24.22.3 (2026-11-10) and 26.13.1 (2026-11-10).
- gunicorn 27.0.0 (uploaded 2026-11-10), a new major after the research's 26.2.0.
- uvicorn 0.54.0 and uvicorn-worker 0.4.0, unchanged.

Raw lines: `results/2026-11-11-b0.jsonl` (24 runs). They were measured with the scripts of commit d05a167. The later measurer change only rejects contrived replies (ambiguous length, extra bytes); the real servers were re-checked under it, with one run each of gunicorn 27.0.0, uvicorn 0.54.0 and Node 26.13.1: 2003, 5002 and 6003 ms.

| Entry | Version measured | Idle close, 3 runs (ms) | Research (11-02) |
|---|---|---|---|
| `node-idle-close-22x` | Node 22.23.2 | 6003, 6002, 6003 | 6.0 s on 22.23.2 |
| `node-idle-close-22x` | Node 22.23.5 | 6003, 6003, 6002 | |
| `node-idle-close-24x` | Node 24.22.3 | 6002, 6003, 6003 | not measured |
| `node-idle-close-26x` | Node 26.13.1 | 6003, 6003, 6002 | not measured |
| `gunicorn-keepalive-uvicorn-worker` | gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | 2002, 2001, 2003 | 2.0 s on 26.2.0 |
| `gunicorn-keepalive-uvicorn-worker` | gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | 2002, 2001, 2003 | not measured |
| `uvicorn-keepalive` | uvicorn 0.54.0 (in both virtualenvs) | 5002, 5003, 5003, 5003, 5003, 5003 | 5.0 s on 0.54.0 |

What this settles, for these exact versions on this platform:

- **Node.** The research's default holds on the newest 22.x (22.23.5). The default idle close of Node 24.22.3 and 26.13.1, which the research had not measured, is also 6.0 s. Only the total was measured. The split into a 5 s `keepAliveTimeout` plus a 1 s buffer comes from the 22.x research and is not measured on 24 or 26.
- **gunicorn.** gunicorn 27.0.0 with the uvicorn worker still closes at 2.0 s, the same as 26.2.0.
- **uvicorn.** uvicorn 0.54.0 alone still closes at 5.0 s.

What this does not settle:

- **Explicit `keepAliveTimeout`.** The effect of an explicit value on Node 22.19 and later (65 s or 66 s) is bolt B3.
- **gunicorn precedence.** gunicorn's setting precedence is bolt B2.
- **Old Node.** The old-Node `headersTimeout` behaviour is bolt B13.
- **ALB and Kubernetes.** The ALB idle timeout and the Kubernetes grace period cannot be measured locally.
- **Other platforms and versions.** Every number here is darwin-arm64. That a Linux deployment closes at the same time is an inference, not a measurement. Other versions within a release line are not measured either.

## Results: gunicorn worker model and setting precedence (bolt B2), 2026-11-11

Machine: macOS on Apple silicon (darwin-arm64), CPython 3.14.7, Node 22.23.2 running the scripts. gunicorn 26.2.0 and 27.0.0, each with uvicorn-worker 0.4.0 and uvicorn 0.54.0 (the `py-g26` and `py-g27` virtualenvs of B0). Three runs per case and version, 126 lines in `results/2026-11-11-b2.jsonl` (`sh measure/run-b2.sh .cache`, 8 min 54 s). Dates are the local date of the run (Wed 2026-11-11 20:45 CST, which is already 2026-11-12 UTC). `node measure/summarize-b2.mjs measure/results/2026-11-11-b2.jsonl` prints the groups below; the table is that output.

**Method.** `py-b2.mjs` starts gunicorn on 127.0.0.1 with a clean environment (`PATH`, `HOME`, `PYTHONDONTWRITEBYTECODE`; `GUNICORN_CMD_ARGS` only in the cases that name it), one worker (`-w 1`), `--log-level info`, its own process group, and stderr on a pipe. The worker class is read from gunicorn's own line `Using worker: <class>`. The exit codes and the stop-on-interrupt rule are those of `py-idle-close.mjs`.

- **Worker model.** `threads`: `--threads 2`, no `-k`. `threads-env`: `GUNICORN_CMD_ARGS='--threads 4'`, no `-k`. `sync`: no `-k`, no `--threads`. All three use `wsgi_app.py` and an explicit empty `-c` file, so a `gunicorn.conf.py` in the folder is not loaded. `threads` and `threads-env` use the strict idle-close measurer. `sync` uses `measureCloseAfterResponse`, which records whether the reply says `Connection: close` and the time from the last response byte to the FIN.
- **Precedence.** gunicorn with `-k uvicorn_worker.UvicornWorker`, whose idle close was 2.0 s by default in B0, so the measured idle close shows which `keepalive` applied. The working directory is a fresh folder holding only `app.py` and what the case adds, deleted afterwards. Sources and values: `cli` is `--keep-alive 3`; `env` is `GUNICORN_CMD_ARGS='--keep-alive 5'`; `file` is `-c conf-file.py` containing `keepalive = 7`; `default` is `./gunicorn.conf.py` in the working directory containing `keepalive = 9` with no `-c`; `emptyfile` is `-c` of a file that sets nothing. All 4 singles, all 6 pairs, all 4 triples, the quadruple, `emptyfile` alone, `emptyfile` with `default`, and no source at all were measured.

| Version | Case | Worker class gunicorn logged | Result, 3 runs |
|---|---|---|---|
| gunicorn 26.2.0 | `--threads 2` | gthread | idle close 2003, 2002, 2003 ms |
| gunicorn 26.2.0 | `GUNICORN_CMD_ARGS='--threads 4'` | gthread | idle close 2003, 2003, 2003 ms |
| gunicorn 26.2.0 | sync (no `-k`, no `--threads`) | sync | closes=true header=true closeMs=0, closes=true header=true closeMs=0, closes=true header=true closeMs=0 |
| gunicorn 27.0.0 | `--threads 2` | gthread | idle close 2004, 2005, 2003 ms |
| gunicorn 27.0.0 | `GUNICORN_CMD_ARGS='--threads 4'` | gthread | idle close 2002, 2005, 2003 ms |
| gunicorn 27.0.0 | sync (no `-k`, no `--threads`) | sync | closes=true header=true closeMs=0, closes=true header=true closeMs=0, closes=true header=true closeMs=0 |

Precedence, idle close in ms (3 runs), gunicorn 26.2.0 and then 27.0.0:

| Sources set | 26.2.0 | 27.0.0 | Value that applied |
|---|---|---|---|
| none | 2001, 2002, 2001 | 2001, 2002, 2001 | 2 s (default) |
| cli (3) | 3003, 3003, 3002 | 3002, 3002, 3002 | 3 |
| env (5) | 5004, 5002, 5003 | 5001, 5002, 5001 | 5 |
| file (7) | 7003, 7002, 7002 | 7002, 7002, 7002 | 7 |
| default (9), no `-c` | 9003, 9003, 9003 | 9002, 9001, 9002 | 9 |
| emptyfile | 2002, 2001, 2001 | 2002, 2002, 2002 | 2 s (default) |
| emptyfile + default (9) | 2003, 2001, 2001 | 2001, 2001, 2000 | 2 s: the default file was not loaded |
| cli + env | 3002, 3002, 3003 | 3002, 3002, 3002 | cli (3) |
| cli + file | 3001, 3003, 3003 | 3002, 3000, 3001 | cli (3) |
| cli + default | 3003, 3003, 3003 | 3002, 3002, 3002 | cli (3) |
| env + file | 5003, 5003, 5003 | 5001, 5002, 5002 | env (5) |
| env + default | 5003, 5003, 5000 | 5002, 5002, 5002 | env (5) |
| file + default | 7001, 7003, 7000 | 7001, 7002, 7001 | file (7) |
| cli + env + file | 3003, 3003, 3001 | 3002, 3002, 3001 | cli (3) |
| cli + env + default | 3002, 3003, 3003 | 3002, 3002, 3002 | cli (3) |
| cli + file + default | 3003, 3002, 3003 | 3002, 3002, 3002 | cli (3) |
| env + file + default | 5001, 5003, 5003 | 5002, 5000, 5002 | env (5) |
| cli + env + file + default | 3003, 3003, 3003 | 3002, 3002, 3002 | cli (3) |

The last column is a reading of the numbers (each is within 5 ms above one of the set values, never at another), not a separate measurement.

What this settles, for these exact versions on this platform, with the uvicorn worker and a literal integer `keepalive`:

- **gthread by default.** `--threads 2` and `GUNICORN_CMD_ARGS='--threads 4'` both made gunicorn log `Using worker: gthread`, and both closed an idle connection at 2.0 s (largest deviation +5 ms), on 26.2.0 and 27.0.0. The research's 2.0 s holds.
- **sync worker.** gunicorn logged `Using worker: sync`; the reply carried `Connection: close` and the FIN came 0 ms after the last response byte (all 6 runs), so it closes after every response. Only the `closeMs` of 0 and the header were observed, not how the worker sends them.
- **Precedence of `keepalive`.** The command line `--keep-alive` beats `GUNICORN_CMD_ARGS`, which beats a config file. The config file is `-c`'s file, or, only when no `-c` is given, `./gunicorn.conf.py` from the working directory. Every pair, triple and the quadruple agree with the order cli > env > config file on both versions, and each source on its own applied its own value.
- **`-c` replaces the default file.** With `-c` of a file that sets nothing, a `./gunicorn.conf.py` with `keepalive = 9` was not loaded: the idle close stayed at 2.0 s. (The pair `file + default` alone cannot show this: its 7 is also what an overriding file would give.)

What this does not settle:

- **Other settings.** Only `keepalive` was measured. That the same order holds for another setting (`--threads`, `-k`, `--graceful-timeout`, `--timeout`) is an inference, not a measurement. The `GUNICORN_CMD_ARGS` effect on `--threads` is shown only alone, not against a flag or a file.
- **Other forms.** `GUNICORN_CMD_ARGS` with several flags or quoting, `-c` with a `python:module` name, a config file that computes its value, an environment-variable reference in the file, `--config` spelled in `GUNICORN_CMD_ARGS`, and a `gunicorn.conf.py` found through `--chdir` or a different working directory were not measured. The one case of two `-c` sources (`-c` in the command and `-c` in `GUNICORN_CMD_ARGS`) was not measured either.
- **Equal results are not identity.** The default-file case shows only that its value was not used when `-c` was given. It does not show whether gunicorn reads the file at all.
- **Worker class and keepalive.** `keepalive` was measured only with the uvicorn worker; on sync it is ignored (research section 2), and on gthread only the default 2.0 s was measured, not an explicit `--keep-alive`.
- **Deviation.** Every one of the 120 idle-close values was 0 to 5 ms above the nominal setting, never below. The B0 spread was 3 ms; 27.0.0 gthread gave +5 ms, so a knowledge-base tolerance should cover 5 ms plus the 1 ms resolution.
- **Other platforms, other versions.** darwin-arm64 only, these two gunicorn versions only.

## Results: explicit keep-alive values (bolt B2 follow-up), 2026-11-11

Question: does an explicit setting map one-to-one to the idle close? Same machine, platform and versions as the B2 section above (darwin-arm64, CPython 3.14.7; gunicorn 26.2.0 and 27.0.0, uvicorn-worker 0.4.0, uvicorn 0.54.0). Three runs per case, 27 lines in `results/2026-11-11-b2-explicit.jsonl` (`sh measure/run-b2-explicit.sh .cache`, finished 2026-11-11 22:36 CST). The measurer's cap was 120 s (above the 75 s values). The uvicorn-alone rows hold 6 runs because uvicorn 0.54.0 is in both virtualenvs; three ran from each. Mode names in `py-b2.mjs`: `gthread-keepalive N`, `uvicorn-worker-keepalive N`, `uvicorn-flag N`, `uvicorn-env N`. The env case sets `UVICORN_TIMEOUT_KEEP_ALIVE=7` deliberately and nothing else in the environment. The table is the output of `node measure/summarize-b2.mjs measure/results/2026-11-11-b2-explicit.jsonl`.

| Version | Case | Worker class gunicorn logged | Idle close, runs (ms) |
|---|---|---|---|
| gunicorn 26.2.0 | `--threads 2 --keep-alive 7` | gthread | 7008, 7002, 7005 |
| gunicorn 26.2.0 | `--threads 2 --keep-alive 75` | gthread | 75073, 75077, 75074 |
| gunicorn 27.0.0 | `--threads 2 --keep-alive 7` | gthread | 7008, 7007, 7007 |
| gunicorn 27.0.0 | `--threads 2 --keep-alive 75` | gthread | 75115, 75137, 75134 |
| gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | uvicorn worker, `--keep-alive 75` | uvicorn_worker.UvicornWorker | 75002, 75003, 75002 |
| uvicorn 0.54.0 | `--timeout-keep-alive 7` | not applicable | 7003, 7000, 7003, 7002, 7002, 7003 |
| uvicorn 0.54.0 | `UVICORN_TIMEOUT_KEEP_ALIVE=7` | not applicable | 7003, 7005, 7001, 7002, 7003, 7003 |

What this settles, for these exact versions on this platform:

- **gthread.** An explicit `--keep-alive` of 7 s and of 75 s each gave an idle close at that value, on both versions. The deviation is above the value and grows with it: +2 to +8 ms at 7 s, +73 to +77 ms at 75 s on 26.2.0, and +115 to +137 ms at 75 s on 27.0.0. A tolerance for gthread must therefore be larger than the 5 ms of the default-value runs; at 75 s on 27.0.0 the largest observed deviation is 137 ms (plus the 1 ms resolution). Why it grows was not investigated.
- **uvicorn worker.** `--keep-alive 75` gave 75.002 to 75.003 s on 27.0.0 (the research measured 75 s on 26.2.0 only). 26.2.0 was not repeated here.
- **uvicorn alone.** `--timeout-keep-alive 7` and `UVICORN_TIMEOUT_KEEP_ALIVE=7` each gave 7.000 to 7.005 s. The env form takes effect without the flag.

What this does not settle:

- **Other values.** Only 7 s and 75 s (gthread), 75 s (uvicorn worker) and 7 s (uvicorn alone) were measured. Values between or beyond, and whether the gthread deviation is linear in the value, are not known.
- **Not repeated.** The uvicorn worker at 75 s on 26.2.0, and the uvicorn worker or gthread at other explicit values on either version.
- **Precedence with the env form of uvicorn.** `UVICORN_TIMEOUT_KEEP_ALIVE` against `--timeout-keep-alive` was not measured, and neither was a `--timeout-keep-alive` given under gunicorn's uvicorn worker.
- **Other platforms and versions.** darwin-arm64 and these versions only.

### Explicit keep-alive of 300 s (round 3), 2026-11-11

The 75 s results above left larger values to inference, so the span was widened to 300 s. Same machine, platform and versions. Two runs per case, 10 lines in `results/2026-11-11-b2-explicit-300.jsonl` (`sh measure/run-b2-explicit-300.sh .cache`, finished 2026-11-11 23:11 CST). The measurer cap was 400 s, given to `py-b2.mjs` as its fifth argument. The five cases ran in parallel, each with its own ephemeral port and process group, so the machine was busier than in the earlier runs. Uvicorn alone ran from one virtualenv (0.54.0 is in both). The table is the output of `node measure/summarize-b2.mjs measure/results/2026-11-11-b2-explicit-300.jsonl`.

| Version | Case | Worker class gunicorn logged | Idle close, runs (ms) |
|---|---|---|---|
| gunicorn 26.2.0 | `--threads 2 --keep-alive 300` | gthread | 300487, 300589 |
| gunicorn 27.0.0 | `--threads 2 --keep-alive 300` | gthread | 300488, 300579 |
| gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | uvicorn worker, `--keep-alive 300` | uvicorn_worker.UvicornWorker | 300003, 300001 |
| gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | uvicorn worker, `--keep-alive 300` | uvicorn_worker.UvicornWorker | 300003, 300001 |
| uvicorn 0.54.0 | `--timeout-keep-alive 300` | not applicable | 300003, 300003 |

What this settles, for these exact versions on this platform:

- **One-to-one at 300 s.** All 10 runs closed at the explicit value plus a small overshoot, and none came in below it.
  - gthread: +487 to +589 ms on both versions.
  - The uvicorn worker: +1 to +3 ms.
  - uvicorn alone: +3 ms.
- **The gthread overshoot keeps growing with the value.** Largest observed overshoot per explicit value: +8 ms at 7 s (both versions), +77 ms at 75 s on 26.2.0 and +137 ms at 75 s on 27.0.0, +589 ms at 300 s (both versions). As a share of the value it is 0.1% to 0.2% in these runs (8/7000, 77/75000, 137/75000, 589/300000). A tolerance for gthread has to scale with the value, not be a fixed few ms. The cause was not investigated, and values between the measured points were not measured.
- **The uvicorn worker and uvicorn alone do not drift.** Their overshoot was 1 to 3 ms at 75 s and at 300 s (uvicorn alone also at 7 s: 0 to 5 ms).
- **26.2.0 and 27.0.0 now agree for the uvicorn worker at an explicit value**, at 300 s (the 75 s case was measured on 27.0.0 only).

What this does not settle:

- **Only two runs per case**, so the spread at 300 s is a small sample.
- **Parallel load.** These runs shared the machine with each other. Whether the gthread overshoot depends on load was not tested.
- **Values above 300 s, between the measured values, and 300 s for the env form of uvicorn** were not measured.
- **Other platforms and versions.** darwin-arm64 and these versions only.

## Results: the httptools protocol (bolt B2, round 4), 2026-11-11

Question: does uvicorn's httptools protocol change the idle close, so that tripcurve would need to tell h11 from httptools? Same machine and platform (darwin-arm64, CPython 3.14.7). New virtualenvs `py-g26-std` and `py-g27-std` (gitignored `.cache/`) hold `gunicorn==26.2.0` or `27.0.0`, `uvicorn[standard]==0.54.0` and `uvicorn-worker==0.4.0`. Installed at 2026-11-11 23:24 CST: **httptools 0.9.0, uvloop 0.23.0** (also h11 0.16.0, websockets 17.4, watchfiles 1.3.0, anyio 4.16.0, click 8.5.1, python-dotenv 1.2.4, pyyaml 6.0.3, idna 3.20, typing-extensions 4.16.0); the full `uv pip list` of both is in `results/2026-11-11-lookups-b2-std.txt`. 36 lines in `results/2026-11-11-b2-httptools.jsonl` (`sh measure/run-b2-httptools.sh .cache`, finished 2026-11-11, about 6 minutes; the 75 s and 300 s cases ran in parallel with each other and with the short cases). Three runs per case, two for the 300 s cases. The table is the output of `node measure/summarize-b2.mjs measure/results/2026-11-11-b2-httptools.jsonl`.

**Which protocol served the request.** Installed is not proof. `app_std.py` finds, while it serves a request, the live `asyncio.Protocol` object whose `cycle.scope` is the very scope dict handed to the app, and prints that object's class and the event loop's class on stderr. `py-b2-httptools.mjs` reads that one line from the server's stderr pipe and puts it in the JSON line as `protocol` (`httptools` for `uvicorn.protocols.http.httptools_impl.HttpToolsProtocol`, `h11` for `uvicorn.protocols.http.h11_impl.H11Protocol`), with the full class names, the loop class and the installed httptools and uvloop versions under `observed`. A run with zero or several such lines, or any other class, exits 4 and prints nothing. The method can tell the two apart: the control rows below ran in the plain virtualenv (no httptools) and reported h11, and before the real runs a `--http h11` run in the standard virtualenv also reported h11 (that one is not in the JSONL).

| Version | Case | Protocol (from the app) | Idle close, runs (ms) |
|---|---|---|---|
| gunicorn 26.2.0, uvicorn worker | default | httptools | 2002, 2003, 2003 |
| gunicorn 26.2.0, uvicorn worker | `--keep-alive 3` | httptools | 3002, 3003, 3003 |
| gunicorn 26.2.0, uvicorn worker | `--keep-alive 75` | httptools | 75003, 75002, 75002 |
| gunicorn 26.2.0, uvicorn worker | `--keep-alive 300` | httptools | 300003, 300003 |
| gunicorn 27.0.0, uvicorn worker | default | httptools | 2003, 2002, 2003 |
| gunicorn 27.0.0, uvicorn worker | `--keep-alive 3` | httptools | 3002, 3001, 3001 |
| gunicorn 27.0.0, uvicorn worker | `--keep-alive 75` | httptools | 75000, 75002, 75003 |
| gunicorn 27.0.0, uvicorn worker | `--keep-alive 300` | httptools | 300000, 300003 |
| uvicorn 0.54.0, `--http httptools` | default | httptools | 5001, 5001, 5004 |
| uvicorn 0.54.0, `--http httptools` | `--timeout-keep-alive 7` | httptools | 7003, 7002, 7003 |
| uvicorn 0.54.0, `--http httptools` | `--timeout-keep-alive 300` | httptools | 300001, 300000 |
| uvicorn 0.54.0, `--http auto`, standard venv | default | httptools | 5001, 5003, 5003 |
| uvicorn 0.54.0, `--http auto`, plain venv (control) | default | h11 | 5003, 5003, 5003 |

Every line of the standard virtualenvs ran with uvloop as the event loop (`uvloop.Loop`); the plain-venv control ran on `asyncio.unix_events._UnixSelectorEventLoop`. The `[standard]` install therefore changes two things at once, the HTTP protocol and the loop, and this round did not separate them.

What this settles, for these exact versions on this platform:

- **No difference from h11.** With httptools (and uvloop) the idle close equals the explicit value, or the default (2.0 s for the gunicorn worker, 5.0 s for uvicorn alone), with an overshoot of 0 to 4 ms, the same as with h11 in B0, B2 and the explicit-value rounds (7 s, 75 s, 300 s for the worker; 7 s and 300 s for uvicorn alone). So for these rows tripcurve does not need to tell h11 from httptools.
- **`--http auto` picks httptools when it is installed** and h11 when it is not, shown by the class that served the request.
- **Versions.** gunicorn 26.2.0 and 27.0.0 agree on every case.

What this does not settle:

- **Protocol and loop together.** A difference that only appears with httptools on the asyncio loop, or with h11 on uvloop, was not looked for (one `--http h11` run on uvloop gave 5002 ms, outside the JSONL, so it is a single unrecorded observation).
- **Values not measured:** the gunicorn worker with `--http` given another way, uvicorn alone with httptools at 75 s, other explicit values, and the env form with httptools.
- **Other versions of httptools and uvloop**, other Python versions, other platforms.
