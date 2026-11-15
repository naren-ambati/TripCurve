# B4 measurements: the shutdown chain

Measurements and lookups for the T2 and T3 rules: how long a
server keeps serving after SIGTERM, what lightship adds under Kubernetes, and
what Kubernetes and terminus document. Run on 2026-11-12 (system date; the
files carry the bolt day 2026-11-11), macOS arm64, CPython 3.14.7, Node 22.23.5.
Raw lines: `results/2026-11-11-b4.jsonl` (75 lines). Dated lookups with quotes:
`results/2026-11-11-lookups-b4.txt`. The tables below are checked against the raw
lines by `node measure/summarize-b4.mjs measure/results/2026-11-11-b4.jsonl measure/README-b4.md`.

Scripts: `shutdown-b4.mjs` (gunicorn and uvicorn), `lightship-b4.mjs` +
`lightship-app.mjs` (lightship), `slow_wsgi.py` and `slow_asgi.py` (the slow
endpoint), `run-b4.sh` (all runs), `summarize-b4.mjs` (tables and the check).
Style as in `py-b2.mjs`: clean environment, explicit empty gunicorn config
(`gunicorn-empty.conf.py`), process-group kill, exit codes 0/2/3/4, 127.0.0.1 only,
a line printed only when something was measured. One exception for lightship, below.

## Method

1. Start the server on 127.0.0.1 (gunicorn with `-w 1`).
2. Send `GET /sleep?s=N` on one keep-alive connection. `long` = N 60 (longer than any
   ceiling under test), `short` = N 3.
3. Wait until the app itself reports (marker file) that the request is being handled,
   then 0.5 s more. Then send SIGTERM to the server's main process only.
4. From the moment `kill()` returns, time (10 ms polling for the worker; events for
   the rest): the in-flight connection closing, the gunicorn worker process
   disappearing (`kill(pid, 0)`), the main process exiting.

Times are milliseconds, three runs per row, in run order. The measuring
overhead is a few ms (event loop, polling), so read the long values as
"30.0 s plus up to about 120 ms".

## gunicorn and uvicorn: SIGTERM with a request in flight

Columns: version, case, request kind, SIGTERM until the connection closed, until the
worker was gone, until the main process exited, whether the response arrived
complete (`HTTP/1.1 200` and body `done`), how the connection ended.

Cases: `sync` (no flags), `sync-graceful10` (`--graceful-timeout 10`),
`sync-timeout120` (`--timeout 120`, an extra case that separates the worker
`timeout` from the graceful timeout), `uvicorn-worker` (`-k uvicorn_worker.UvicornWorker`),
`gthread` (`--threads 2`, the way B2 selects it), and uvicorn alone (`uvicorn`, and
`uvicorn-graceful5` = `--timeout-graceful-shutdown 5`, an extra case that shows the flag works).

| Version | Case | Request | Connection closed (ms) | Worker gone (ms) | Main exit (ms) | Response complete | Connection end |
|---|---|---|---|---|---|---|---|
| gunicorn 26.2.0 | `sync` | long | 30010, 30074.1, 30099.1 | 30028.6, 30089.8, 30108 | 30028.6, 30082.5, 30108 | false | fin |
| gunicorn 26.2.0 | `sync-graceful10` | long | 10078, 10091.8, 10031.8 | 10091.9, 10104.9, 10046 | 10087.7, 10103.5, 10040.5 | false | fin |
| gunicorn 26.2.0 | `sync-timeout120` | long | 30057.5, 30047.8, 30090.1 | 30087.1, 30067.4, 30106 | 30079.4, 30057.3, 30106.1 | false | fin |
| gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker` | long | 30095.2, 30098.3, 30025.4 | 30109.4, 30109, 30036.2 | 30106.8, 30109.1, 30036.2 | false | fin |
| gunicorn 26.2.0 | `gthread` | long | 30096.1, 30021.6, 30044.6 | 30118.3, 30034.6, 30064.8 | 30115.7, 30030.1, 30062.1 | false | fin |
| gunicorn 26.2.0 | `sync` | short | 2405.9, 2420.1, 2421.2 | 2440.7, 2511, 2548.4 | 2561.6, 2642, 2680.1 | true | fin |
| gunicorn 26.2.0 | `sync-graceful10` | short | 2434.5, 2422.8, 2439.9 | 2560, 2447.2, 2498 | 2679.8, 2556, 2612.6 | true | fin |
| gunicorn 26.2.0 | `sync-timeout120` | short | 2437.1, 2440.2, 2507.4 | 2488.8, 2554.2, 2658 | 2595.1, 2666.1, 2781.3 | true | fin |
| gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker` | short | 2413.3, 2425, 2433.5 | 2532.4, 2549.2, 2536.1 | 2664.3, 2652.8, 2663.1 | true | fin |
| gunicorn 26.2.0 | `gthread` | short | 2434.2, 2427.9, 2427.9 | 2544, 2560, 2524.3 | 2673.4, 2683.4, 2656.4 | true | fin |
| gunicorn 27.0.0 | `sync` | long | 30017.5, 30005.7, 30003.5 | 30041.9, 30026.8, 30016.4 | 30031.8, 30022.9, 30012.1 | false | fin |
| gunicorn 27.0.0 | `sync-graceful10` | long | 10074.1, 10105.2, 10036.9 | 10083.5, 10128.8, 10046.9 | 10083.6, 10116.2, 10045.6 | false | fin |
| gunicorn 27.0.0 | `sync-timeout120` | long | 30011.1, 30010.4, 30038.9 | 30029.7, 30026.2, 30065 | 30022.9, 30019.8, 30059.8 | false | fin |
| gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker` | long | 30050.5, 30072.7, 30078.2 | 30072.5, 30094.2, 30099.4 | 30061.4, 30082.4, 30088.5 | false | fin |
| gunicorn 27.0.0 | `gthread` | long | 30038.4, 30021.3, 30027.9 | 30077.7, 30029.5, 30048.7 | 30067.8, 30029.5, 30047.4 | false | fin |
| gunicorn 27.0.0 | `sync` | short | 2420, 2417.1, 2419.7 | 2528.6, 2557.7, 2548.9 | 2664.8, 2676.3, 2669.1 | true | fin |
| gunicorn 27.0.0 | `sync-graceful10` | short | 2463.5, 2430.8, 2437.5 | 2592, 2516.6, 2501.8 | 2710, 2631.5, 2607.2 | true | fin |
| gunicorn 27.0.0 | `sync-timeout120` | short | 2441, 2446.2, 2439.1 | 2506.9, 2536.1, 2548.2 | 2621, 2658.9, 2672.3 | true | fin |
| gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker` | short | 2421, 2419.5, 2437.8 | 2555.9, 2468.2, 2560.8 | 2697.9, 2589.6, 2693.5 | true | fin |
| gunicorn 27.0.0 | `gthread` | short | 2428.1, 2433.1, 2427.7 | 2534.9, 2557.8, 2536.9 | 2665.1, 2681.2, 2657.5 | true | fin |
| uvicorn 0.54.0 | `uvicorn` | long | 59451.6, 59451.6, 59455.8 | n/a, n/a, n/a | 59545.2, 59516.7, 59478 | true | fin |
| uvicorn 0.54.0 | `uvicorn` | short | 2447, 2448.2, 2450.4 | n/a, n/a, n/a | 2494, 2501, 2538.2 | true | fin |
| uvicorn 0.54.0 | `uvicorn-graceful5` | long | 5116.2, 5151.8, 5120.9 | n/a, n/a, n/a | 5116.3, 5151.8, 5121 | false | fin |

What the tables show:

- **gunicorn 26.2.0 and 27.0.0, all worker classes, default settings: a request still
  running at SIGTERM is cut off 30.0 s later** (range over all long runs of the
  default cases: 30003 to 30118 ms), with no response bytes, the
  connection closed by FIN, the worker gone and the main process exited with code 0.
  This holds for sync, gthread and the uvicorn worker.
- `--graceful-timeout 10` moves the cut-off to 10.0 s (10031 to 10129 ms); `--timeout 120`
  does not move it (still 30 s). So the 30 s is `graceful_timeout`, not the worker `timeout`.
- **A request that finishes before the ceiling completes normally**: the 3 s request
  returned `200 done` in full in every `short` run, about 2.4 s after SIGTERM, and the
  server then went away within about 0.3 s. gunicorn waits for the in-flight request;
  it does not abandon it at SIGTERM.
- No difference between 26.2.0 and 27.0.0 in any case.
- **uvicorn 0.54.0 alone, default: no ceiling.** A SIGTERM during a 60 s request let
  the request finish (response complete, connection closed about 59.45 s later, which is
  the request's own end) and the process exited then. The cap on the wait was 90 s.
  With `--timeout-graceful-shutdown 5` the request was cut at about 5.1 s (uvicorn logs
  "Cancel 1 running task(s), timeout graceful shutdown exceeded"). uvicorn re-raises
  SIGTERM when it ends, so its main-process exit shows as signal SIGTERM, not code 0.
- Under gunicorn the uvicorn worker is cut at gunicorn's 30 s (observed in both versions),
  although uvicorn alone has no limit.

## lightship: SIGTERM under Kubernetes

lightship 9.1.0 (latest on npm on 2026-11-12), installed with `npm install --ignore-scripts`
into `.cache/lightship`, defaults (`createLightship({})`) plus one shutdown handler that
closes the app's own server. Kubernetes is detected by `process.env.KUBERNETES_SERVICE_HOST`
being set (code: `Boolean(process.env.KUBERNETES_SERVICE_HOST)`, the README does not say).
`k8s` = the variable set to 127.0.0.1; `local` = unset (lightship's local mode).
Columns: SIGTERM until `/ready` first answered 500 (polled every 20 ms, so a value
under 25 ms means "at once"), until the shutdown handler started, until the app's server
closed, until the process exited.

| Version | Mode | /ready not ready (ms) | Handler start (ms) | Server closed (ms) | Process exit (ms) |
|---|---|---|---|---|---|
| lightship 9.1.0 | `k8s` | 0.6, 24.8, 23 | 5002.5, 5003.9, 5003.5 | 5002.6, 5004, 5003.6 | 5008.5, 5009.8, 5006.9 |
| lightship 9.1.0 | `local` | n/a, n/a, n/a | 0.1, 0.1, 0.1 | 0.2, 0.3, 0.3 | 3.4, 3.2, 3.2 |

- **Under Kubernetes the shutdown handlers run 5.0 s after SIGTERM** (5002 to 5004 ms),
  the documented `shutdownDelay` default of 5000 ms; `/ready` turns not-ready at once.
  Outside Kubernetes (variable unset) the delay is 0 (handler within 0.1 ms), as documented.
- Exception to "localhost only": lightship's own status server listens on `0.0.0.0` (its
  code), on a port moved off 9000 with `LIGHTSHIP_PORT`. Nothing was connected to it except
  the runner's own probes on 127.0.0.1, and the process ran for under 6 s.
- Not measured: `gracefulShutdownTimeout` (30 s, "includes the time allowed to live
  beacons"; the timer starts after the shutdown delay, from the code) and
  `shutdownHandlerTimeout` (5 s). These apply to apps that use beacons or slow handlers;
  the runs used neither. Documented values are in the lookups file.

## Lookups (docs only, see `results/2026-11-11-lookups-b4.txt` for URLs and quotes)

| Fact | Value | Source, date |
|---|---|---|
| gunicorn `graceful_timeout` default | 30 s ("Workers still alive after the timeout ... are force killed"); the sentence says "restart signal", the measurement above shows SIGTERM behaves the same | gunicorn.org settings page, 2026-11-12; installed 26.2.0 and 27.0.0 `config.py` |
| uvicorn `--timeout-graceful-shutdown` default | docs give no default; installed 0.54.0 code `None`; measured: no ceiling | uvicorn.dev settings page, 2026-11-12 |
| lightship `shutdownDelay` default | 5000 ms; 0 in local mode | lightship README, 2026-11-12 |
| Kubernetes `terminationGracePeriodSeconds` default | 30 s ("The default terminationGracePeriodSeconds setting is 30 seconds"); the countdown starts before preStop runs and covers preStop plus stopping | kubernetes.io pod lifecycle, PodSpec and lifecycle hooks pages, 2026-11-12. Not measurable without a cluster |
| terminus `beforeShutdown` | optional, no default delay; the 5000 ms is only in the README example | @godaddy/terminus README, 4.12.1, 2026-11-12 |
| terminus `timeout` | default 1000 ms, "number of milliseconds before forceful exiting"; the README does not say whether this covers the time spent in `beforeShutdown` | same |

## What is settled and what is not

Settled (measured, 3 runs each, both gunicorn versions):

- gunicorn's ceiling for a running request after SIGTERM is `graceful_timeout`: 30 s by
  default, 10 s with `--graceful-timeout 10`, independent of `--timeout`, for sync,
  gthread (`--threads 2`) and the uvicorn worker, on 26.2.0 and 27.0.0.
- A request that ends before the ceiling completes in full.
- uvicorn alone has no ceiling by default; `--timeout-graceful-shutdown` works as documented.
- lightship 9.1.0 delays its shutdown handlers by 5 s under `KUBERNETES_SERVICE_HOST`, 0 outside.

Settled by documentation only (dated, not measured):

- Kubernetes default grace period 30 s; terminus `beforeShutdown` has no default delay.

Not settled:

- **terminus `timeout`**: whether the 1000 ms default also limits `beforeShutdown` is not
  in the README. Reading the source or measuring would settle it; not done (docs only was asked).
  Until then a terminus `beforeShutdown` of unknown duration stays UNRESOLVED.
- gunicorn with the `gevent`, `eventlet`, `tornado` and `gaiohttp` classes, `--workers` above 1
  (only the single-worker case was run), and other signals (SIGQUIT, SIGINT, SIGHUP) were not measured.
  A multi-worker run is expected to behave per worker; that is an expectation, not a measurement.
- lightship `gracefulShutdownTimeout` / `shutdownHandlerTimeout` behaviour and its version
  history (only 9.1.0 was run); other versions' `shutdownDelay` defaults are not checked.
- The Kubernetes default and the actual kill (SIGKILL after the grace period) are documented, not observed.
- macOS only, one machine; signal timing on Linux containers is not measured. gunicorn's
  timer is in its own code (a `time.time()` comparison), so a large platform difference
  is not expected, but it is not measured.
- Numbers are one session's; the ceiling values are 30 s and 10 s because those are the
  configured values, so the spread (up to about 120 ms) is measurement noise, not a property of gunicorn.
