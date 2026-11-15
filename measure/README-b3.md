# B3: Node explicit `keepAliveTimeout` and the 1 s buffer

Question: say Node 22.19 and later added a 1 s `keepAliveTimeoutBuffer` to the default. Is the buffer also added to an explicit `keepAliveTimeout`? The research disagrees with itself: an explicit 12000 closed at 13.0 s on 22.23.2, but an explicit 65000 was reported as 65 s (`docs/research.md` sections 2 and 13).

## Method

- `measure/node-explicit.mjs <keepAliveTimeoutMs> [--buffer=<ms>] [--form=assign|options] [--cap-ms=<ms>]`, run by the Node under test. It uses the same measurer as B0 (`measure/lib/idle-close.mjs`): one keep-alive request to 127.0.0.1, then the time from the last response byte to the server's FIN, monotonic, whole ms.
- Arguments are whole numbers only: `keepAliveTimeout` 1 to 300000, `--buffer` 0 to 60000, `--cap-ms` 1000 to 600000 (it must exceed the timeout plus the buffer). Anything else exits 2. A set `NODE_OPTIONS` exits 4; the runner uses a clean environment (`env -i`).
- `assign` form: `server.keepAliveTimeout = N` after `http.createServer(handler)`, and `server.keepAliveTimeoutBuffer = B` when `--buffer` is given. `options` form: `http.createServer({keepAliveTimeout: N}, handler)`.
- Each JSON line carries `observed.keepAliveTimeout` and `observed.keepAliveTimeoutBuffer`, read from the running server after `listen` (`null` if the property is not a number). In every line both were numbers, so no `null` occurred.
- `sh measure/run-b3.sh .cache > measure/results/2026-11-11-b3.jsonl`: five cases, three runs each, on four Node versions (60 lines). The 65000 case uses a measurer cap of 120000 ms. The run finished at 2026-11-11 23:00 CST.
- Platform darwin-arm64, official Node tarballs 22.23.2, 22.23.5, 24.22.3, 26.13.1. Localhost only.
- The `date` field in each line says 2026-11-12: the scripts take it from UTC, and the runs were on 2026-11-11 CST.
- No new measuring helper was written, so there is no `selftest-b3.mjs`; `node measure/selftest.mjs` passed. `measure/summarize-b3.mjs` prints this table from the JSONL and, given this file, fails unless every row matches.

## Results

"Observed" is `keepAliveTimeout / keepAliveTimeoutBuffer` as read back from the server. Idle close is in ms, three runs.

| Version | Case | Observed | Idle close, runs (ms) |
|---|---|---|---|
| 22.23.2 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8002, 8000, 8003 |
| 22.23.2 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13002, 13001, 13002 |
| 22.23.2 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66003, 66002, 66004 |
| 22.23.2 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7001, 7003, 7002 |
| 22.23.2 | `createServer-options keepAliveTimeout=7000` | 7000 / 1000 | 8003, 8003, 8003 |
| 22.23.5 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8002, 8002, 8001 |
| 22.23.5 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13002, 13002, 13003 |
| 22.23.5 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66003, 66001 |
| 22.23.5 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7003, 7004, 7002 |
| 22.23.5 | `createServer-options keepAliveTimeout=7000` | 7000 / 1000 | 8001, 8002, 8002 |
| 24.22.3 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8002, 8002, 8003 |
| 24.22.3 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13000, 13002, 13002 |
| 24.22.3 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66002, 66000 |
| 24.22.3 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7001, 7002, 7003 |
| 24.22.3 | `createServer-options keepAliveTimeout=7000` | 7000 / 1000 | 8003, 8001, 8002 |
| 26.13.1 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8002, 8000, 8003 |
| 26.13.1 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13001, 13002, 13002 |
| 26.13.1 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66001, 66001, 66002 |
| 26.13.1 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7000, 7003, 7002 |
| 26.13.1 | `createServer-options keepAliveTimeout=7000` | 7000 / 1000 | 8001, 8002, 8002 |

## What this settles, for these exact versions on darwin-arm64

- **The buffer is added to explicit values, on all four versions.** With `server.keepAliveTimeout = N` and the buffer left alone, the idle close was N + 1 s at 7000, 12000 and 65000 (deviation +0 to +4 ms above N + 1000, never below). The 65000 case closed at 66.0 s on all four, so the research's "65 s" report does not hold on these versions; the 13.0 s for 12000 on 22.23.2 does.
- **The default buffer is 1000 ms on all four versions.** `server.keepAliveTimeoutBuffer` read 1000 on a fresh server and the property exists on 22.23.2, 22.23.5, 24.22.3 and 26.13.1.
- **The buffer is settable.** `keepAliveTimeoutBuffer = 0` with 7000 closed at 7.00 s (7000 to 7004 ms) on all four versions.
- **The options form behaves like assignment.** `createServer({keepAliveTimeout: 7000}, handler)` read back 7000 / 1000 and closed at 8.0 s on all four versions.
- **Effective idle close on these versions** is `keepAliveTimeout + keepAliveTimeoutBuffer`.

## What this does not settle

- **The default `keepAliveTimeout` itself.** It was not read back or measured here. The research notes PR #62782 (raising the default to 65 s, merged 2026-04-26); whether any tested version carries it is not established here (the B0 results are the evidence for the defaults).
- **Other versions.** 22.19 to 22.23.1, 22.23.3, 22.23.4, other 24.x and 26.x releases, and 22.18 and earlier (where the research reports no buffer) were not run. Where the buffer first appeared is not measured here.
- **Other ways to set the values.** `server.setTimeout`, `--max-http-header-size`, `headersTimeout` and `connectionsCheckingInterval` interplay, a buffer larger than 0 but not 1000, and values set after `listen` were not measured. Values below 1000 ms and above 65000 ms were not measured.
- **Frameworks.** Express, Fastify, Koa or a wrapper that sets its own `keepAliveTimeout` were not measured.
- **Other platforms.** darwin-arm64 only; Linux timers may deviate differently.
- **Cause of the research's 65 s report** is not identified. A possible reason is a Node release outside the four tested, or a measurement without the buffer, but neither was tested.

## Dates (note added in the B10 review)

Every record in the matching `measure/results/2026-11-11-b3*.jsonl` file says `"date": "2026-11-12"`; the lookup file `2026-11-11-lookups-b3.txt` says it was taken 2026-11-12T05:51Z; the git commit of these files is dated 2026-11-12 01:05 -0600 (`git log --format=%ci`). The file names carry 2026-11-11, which is presumably the day the bolt started (an inference, not recorded anywhere). The records are right and the files are not renamed. The knowledge-base entries that cite these records now say 2026-11-12 (`measuredOn.date`).

