# B3 Node versions: where the 1 s idle-close buffer appears

Question: the Node docs say `keepAliveTimeoutBuffer` was "Added in: v22.19.0" (22.x) and "v24.6.0" (24.x) (read 2026-11-11). Does the idle close of older versions equal exactly the default 5.0 s, and exactly K when `keepAliveTimeout` is set to K? Measured on nine official darwin-arm64 releases.

## Method

- Versions chosen from a dated, read-only lookup of `https://nodejs.org/dist/index.json` on 2026-11-11 (raw output in `measure/results/2026-11-11-lookups-b3.txt`): newest 18.x (18.20.8) and 20.x (20.20.2), 22.12.0 (tripcurve's engines floor), 22.18.0, 22.19.0, 24.0.0, 24.5.0 (the last 24.x before 24.6.0), 24.6.0 and 26.0.0. Every one had an `osx-arm64-tar` file; each tarball's SHA-256 matched that release's `SHASUMS256.txt` (hashes in the lookups file).
- `sh measure/run-b3-versions.sh .cache > measure/results/2026-11-11-b3-versions.jsonl`: per version three cases, three runs each: `default` (`node-idle-close.mjs`, unchanged), `assign keepAliveTimeout=7000` and, only where the property exists, `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` (both `node-explicit.mjs`, unchanged). 63 lines. The runner `measure/node-b3-case.mjs` calls the unchanged scripts as child processes of the Node under test, with a clean environment, and adds the properties read back from a fresh server (`null` if the property is missing; for `default` this is a separate fresh `http.createServer` with no listen).
- Idle close is measured as in B0 (`measure/lib/idle-close.mjs`): one keep-alive request to 127.0.0.1, last response byte to the server's FIN, whole ms. Localhost only; every server closed by its script.
- The `date` field is UTC and may read 2026-11-12 for runs made on 2026-11-11 CST.
- `node measure/summarize-b3-versions.mjs measure/results/2026-11-11-b3-versions.jsonl measure/README-b3-versions.md` checks this table against the JSONL.

## Results

"Observed" is `keepAliveTimeout / keepAliveTimeoutBuffer` as read back; `null` means the property does not exist. Idle close is in ms, three runs. The `keepAliveTimeoutBuffer=0` case has no row for a version where the property does not exist (skipped, not failed).

| Version | Case | Observed | Idle close, runs (ms) |
|---|---|---|---|
| 18.20.8 | `default` | 5000 / null | 5002, 5003, 5001 |
| 18.20.8 | `assign keepAliveTimeout=7000` | 7000 / null | 7001, 7002, 7002 |
| 20.20.2 | `default` | 5000 / null | 6003, 6002, 6001 |
| 20.20.2 | `assign keepAliveTimeout=7000` | 7000 / null | 8002, 8003, 8003 |
| 22.12.0 | `default` | 5000 / null | 6001, 6003, 6003 |
| 22.12.0 | `assign keepAliveTimeout=7000` | 7000 / null | 8001, 8003, 8002 |
| 22.18.0 | `default` | 5000 / null | 6003, 6004, 6002 |
| 22.18.0 | `assign keepAliveTimeout=7000` | 7000 / null | 8002, 8003, 8003 |
| 22.19.0 | `default` | 5000 / 1000 | 6002, 6000, 6003 |
| 22.19.0 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8001, 8002, 8001 |
| 22.19.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7001, 7003, 7004 |
| 24.0.0 | `default` | 5000 / null | 6003, 6004, 6001 |
| 24.0.0 | `assign keepAliveTimeout=7000` | 7000 / null | 8001, 8004, 8003 |
| 24.5.0 | `default` | 5000 / null | 6001, 6003, 6002 |
| 24.5.0 | `assign keepAliveTimeout=7000` | 7000 / null | 8001, 8002, 8002 |
| 24.6.0 | `default` | 5000 / 1000 | 6003, 6002, 6003 |
| 24.6.0 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8002, 8003, 8003 |
| 24.6.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7001, 7002, 7004 |
| 26.0.0 | `default` | 5000 / 1000 | 6003, 6002, 6003 |
| 26.0.0 | `assign keepAliveTimeout=7000` | 7000 / 1000 | 8003, 8004, 8003 |
| 26.0.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=0` | 7000 / 0 | 7002, 7002, 7003 |

## What this settles, for these exact versions on darwin-arm64

- **The property and the behaviour are two different things.** The property `server.keepAliveTimeoutBuffer` is first seen at 22.19.0 (absent at 22.18.0) and at 24.6.0 (absent at 24.5.0), as the docs say; it is present on 26.0.0. It is `null` on 18.20.8, 20.20.2, 22.12.0, 22.18.0, 24.0.0 and 24.5.0.
- **The extra second is older than the property.** 20.20.2, 22.12.0, 22.18.0, 24.0.0 and 24.5.0 have no property but already close about 1 s late: default 6001 to 6004 ms, and 8001 to 8003 ms with `keepAliveTimeout = 7000`. So a knowledge-base range "buffer from 22.19 / 24.6" would be wrong for idle close: on 22.12.0 (the engines floor), 22.18.0 and 24.0 to 24.5 the default idle close is 6.0 s, not 5.0 s.
- **Only 18.20.8 closes at exactly K.** Default 5001 to 5003 ms (5.0 s) and 7001 to 7002 ms with 7000. No pre-buffer-property version in the 20, 22 or 24 line closes at exactly 5.0 s or exactly K; each closes at K + 1 s (+0 to +4 ms).
- **From 22.19.0, 24.6.0 and 26.0.0 the property reads 1000 and idle close is K + 1 s** (default 6000 to 6003 ms, 8001 to 8004 ms at 7000); setting the buffer to 0 gives 7.00 s (7001 to 7004 ms).
- **The default `keepAliveTimeout` reads 5000 on all nine versions.**

## What this does not settle

- **Where the extra second first appears.** Between 18.20.8 (none) and 20.20.2 (present) is untested: 18.x releases between and 19.x, 20.0.0 to 20.20.1 were not run. Why the 1 s exists before the property (the cause in Node's code) was not investigated.
- **Other versions in each line.** Only the nine versions above, plus the B3 explicit-timeout run (22.23.2, 22.23.5, 24.22.3, 26.13.1). The claim "every 20.x, 22.12 to 22.18 and 24.0 to 24.5 close at K + 1 s" is shown for one version of each range or fewer, not for each release.
- **Values other than 5000 and 7000**, `server.setTimeout`, `headersTimeout`, frameworks and platforms other than darwin-arm64 were not measured here.
- **Whether the 1 s applies to a buffer set to a value other than 0 on 22.19.0 and later** was not measured here.

## Dates (note added in the B10 review)

Every record in the matching `measure/results/2026-11-11-b3*.jsonl` file says `"date": "2026-11-12"`; the lookup file `2026-11-11-lookups-b3.txt` says it was taken 2026-11-12T05:51Z; the git commit of these files is dated 2026-11-12 01:05 -0600 (`git log --format=%ci`). The file names carry 2026-11-11, which is presumably the day the bolt started (an inference, not recorded anywhere). The records are right and the files are not renamed. The knowledge-base entries that cite these records now say 2026-11-12 (`measuredOn.date`).

