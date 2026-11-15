# B3 extra points: explicit 12000 and 65000, options form, explicit buffer

Follow-up to `measure/README-b3-versions.md`, filling the points the B3 review found missing. Same method: the existing `node-explicit.mjs`, unchanged, run as a child of the Node under test with a clean environment, by `measure/node-b3-points.mjs` (one case per call). Idle close is the B0 measurer's time from the last response byte to the server's FIN, whole ms, 127.0.0.1 only.

- `sh measure/run-b3-points.sh .cache > measure/results/2026-11-11-b3-points.jsonl`: 12 versions in parallel (each run has its own port; cases and runs within a version are sequential), three runs per case, 102 lines. The 65000 cases use a measurer cap of 120000 ms. No run failed or was skipped. Timer load from running versions in parallel was not controlled; all deviations stayed within +0 to +4 ms, except one run 1 ms below K + 1000 (22.18.0, K 12000, 12999 ms).
- The case set per version: `keepAliveTimeout` 12000 and 65000 on the nine versions of the earlier run; the options form at 65000 on 22.12.0, 22.23.5, 24.0.0 and 26.0.0; an explicit buffer of 1000 with K = 7000, and buffer 0 with K = 65000, on the six versions that have the property (22.19.0, 22.23.5, 24.6.0, 24.22.3, 26.0.0, 26.13.1). The 12000 and 65000 cases on 22.23.5, 24.22.3 and 26.13.1, and 12000 on 22.23.2 and 26.13.1, come from `2026-11-11-b3.jsonl` (earlier run).
- `node measure/summarize-b3-versions.mjs measure/results/2026-11-11-b3-points.jsonl measure/README-b3-points.md` checks this table against the JSONL. The `date` field is UTC and may differ from the CST run date.

## Results

"Observed" is `keepAliveTimeout / keepAliveTimeoutBuffer` as read back; `null` means the property does not exist. Idle close in ms, three runs.

| Version | Case | Observed | Idle close, runs (ms) |
|---|---|---|---|
| 18.20.8 | `assign keepAliveTimeout=12000` | 12000 / null | 12004, 12002, 12001 |
| 18.20.8 | `assign keepAliveTimeout=65000` | 65000 / null | 65002, 65003, 65003 |
| 20.20.2 | `assign keepAliveTimeout=12000` | 12000 / null | 13000, 13002, 13002 |
| 20.20.2 | `assign keepAliveTimeout=65000` | 65000 / null | 66003, 66001, 66002 |
| 22.12.0 | `assign keepAliveTimeout=12000` | 12000 / null | 13004, 13001, 13001 |
| 22.12.0 | `assign keepAliveTimeout=65000` | 65000 / null | 66003, 66001, 66001 |
| 22.12.0 | `createServer-options keepAliveTimeout=65000` | 65000 / null | 66001, 66003, 66001 |
| 22.18.0 | `assign keepAliveTimeout=12000` | 12000 / null | 12999, 13002, 13001 |
| 22.18.0 | `assign keepAliveTimeout=65000` | 65000 / null | 66001, 66001, 66001 |
| 22.19.0 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13001, 13002, 13001 |
| 22.19.0 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66002, 66003 |
| 22.19.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8002, 8002, 8000 |
| 22.19.0 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65001, 65001, 65001 |
| 22.23.5 | `createServer-options keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66003, 66001 |
| 22.23.5 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8004, 8002, 8001 |
| 22.23.5 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65003, 65002, 65002 |
| 24.0.0 | `assign keepAliveTimeout=12000` | 12000 / null | 13000, 13002, 13003 |
| 24.0.0 | `assign keepAliveTimeout=65000` | 65000 / null | 66001, 66002, 66003 |
| 24.0.0 | `createServer-options keepAliveTimeout=65000` | 65000 / null | 66003, 66003, 66002 |
| 24.5.0 | `assign keepAliveTimeout=12000` | 12000 / null | 13000, 13002, 13001 |
| 24.5.0 | `assign keepAliveTimeout=65000` | 65000 / null | 66001, 66002, 66002 |
| 24.6.0 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13002, 13002, 13002 |
| 24.6.0 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66001, 66003, 66001 |
| 24.6.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8000, 8001, 8004 |
| 24.6.0 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65002, 65002, 65001 |
| 24.22.3 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8002, 8002, 8002 |
| 24.22.3 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65003, 65002, 65001 |
| 26.0.0 | `assign keepAliveTimeout=12000` | 12000 / 1000 | 13001, 13002, 13002 |
| 26.0.0 | `assign keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66001, 66000 |
| 26.0.0 | `createServer-options keepAliveTimeout=65000` | 65000 / 1000 | 66002, 66000, 66002 |
| 26.0.0 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8002, 8003, 8003 |
| 26.0.0 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65003, 65002, 65003 |
| 26.13.1 | `assign keepAliveTimeout=7000 keepAliveTimeoutBuffer=1000` | 7000 / 1000 | 8002, 8003, 8000 |
| 26.13.1 | `assign keepAliveTimeout=65000 keepAliveTimeoutBuffer=0` | 65000 / 0 | 65003, 65003, 65001 |

## What this settles, for these exact versions on darwin-arm64

- **18.20.8 closes at exactly K** at 7000 (earlier run), 12000 (12001 to 12004 ms) and 65000 (65002 to 65003 ms). It is the only tested version where "idle close = K" holds.
- **20.20.2, 22.12.0, 22.18.0, 24.0.0 and 24.5.0 close at K + 1 s** at 12000 (12999 to 13004 ms) and 65000 (66001 to 66003 ms), with the property `null`. Together with 7000 from the earlier run, K + 1 s holds at three K values on each of them (22.12.0, 22.18.0, 24.0.0, 24.5.0: all three; 20.20.2: all three).
- **22.19.0, 24.6.0 and 26.0.0** (property 1000) close at K + 1 s at 12000 and 65000 too.
- **The options form equals assignment** at 65000: 66001 to 66003 ms on 22.12.0, 22.23.5, 24.0.0 and 26.0.0 (property `null` on 22.12.0 and 24.0.0, 1000 on the others).
- **An explicit buffer of 1000 changes nothing**: with K = 7000 it closes at 8000 to 8004 ms on all six property versions.
- **Buffer 0 gives exactly K at 65000** (65001 to 65003 ms) on all six property versions, so the buffer is added to a large K and is settable there.
- **The research's "65 s" report for an explicit 65000** matches 18.20.8 here (65.0 s), and no later version tested; every 20.x to 26.x version tested closes at 66.0 s.

## What this does not settle

- Versions not listed, in particular releases between 18.20.8 and 20.20.2 (where the extra second starts) and other releases within each line.
- Values of K other than 7000, 12000 and 65000, and a buffer other than 0 and 1000 (for example a value above 1000).
- Other platforms, frameworks, and the effect of parallel timer load beyond the observed millisecond deviations.

## Every version and K measured so far (default close, assign, options form, buffer)

Marked D = default (K 5000), A = assign form, O = options form, B = explicit buffer values; K in ms. Sources: `2026-11-11-b3-versions.jsonl`, `2026-11-11-b3.jsonl`, this run.

| Line | Version | Measured |
|---|---|---|
| 18.x | 18.20.8 | D; A 7000, 12000, 65000 |
| 20.x | 20.20.2 | D; A 7000, 12000, 65000 |
| 22.x | 22.12.0 | D; A 7000, 12000, 65000; O 65000 |
| 22.x | 22.18.0 | D; A 7000, 12000, 65000 |
| 22.x | 22.19.0 | D; A 7000, 12000, 65000; B 0 at 7000, B 1000 at 7000, B 0 at 65000 |
| 22.x | 22.23.2 | A 7000, 12000, 65000; B 0 at 7000; O 7000 |
| 22.x | 22.23.5 | A 7000, 12000, 65000; B 0 at 7000; O 7000, 65000; B 1000 at 7000; B 0 at 65000 |
| 24.x | 24.0.0 | D; A 7000, 12000, 65000; O 65000 |
| 24.x | 24.5.0 | D; A 7000, 12000, 65000 |
| 24.x | 24.6.0 | D; A 7000, 12000, 65000; B 0 at 7000, B 1000 at 7000, B 0 at 65000 |
| 24.x | 24.22.3 | A 7000, 12000, 65000; B 0 at 7000; O 7000; B 1000 at 7000; B 0 at 65000 |
| 26.x | 26.0.0 | D; A 7000, 12000, 65000; O 65000; B 0 at 7000, B 1000 at 7000, B 0 at 65000 |
| 26.x | 26.13.1 | A 7000, 12000, 65000; B 0 at 7000; O 7000; B 1000 at 7000; B 0 at 65000 |

Defaults (D) were measured only where marked; 22.23.x, 24.22.3 and 26.13.1 defaults are in the B0 results (`2026-11-11-b0.jsonl`).

## Dates (note added in the B10 review)

Every record in the matching `measure/results/2026-11-11-b3*.jsonl` file says `"date": "2026-11-12"`; the lookup file `2026-11-11-lookups-b3.txt` says it was taken 2026-11-12T05:51Z; the git commit of these files is dated 2026-11-12 01:05 -0600 (`git log --format=%ci`). The file names carry 2026-11-11, which is presumably the day the bolt started (an inference, not recorded anywhere). The records are right and the files are not renamed. The knowledge-base entries that cite these records now say 2026-11-12 (`measuredOn.date`).

