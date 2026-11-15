# B4 follow-up: graceful timeout with more workers and other ways to set it

Follow-up to `README-b4.md` (which ran `-w 1` only and set the ceiling only with a flag). Run on
2026-11-12 (system date; the files carry the bolt day 2026-11-11), macOS arm64, CPython 3.14.7,
Node 22.23.5. Raw lines: `results/2026-11-11-b4-more.jsonl` (36 lines: 2 versions x 6 cases x 3 runs).
The table is checked against the raw lines by
`node measure/summarize-b4-more.mjs measure/results/2026-11-11-b4-more.jsonl measure/README-b4-more.md`.

Scripts (all new): `shutdown-b4-more.mjs` (a copy of `shutdown-b4.mjs` with the new cases; same method
and style: clean environment, process-group kill, 10 ms polling, 127.0.0.1 only, exit codes 0/2/3/4, a line
printed only when something was measured), `gunicorn-gt10.conf.py` (a config file that sets
`graceful_timeout = 10`), `run-b4-more.sh`, `summarize-b4-more.mjs`.

## Method

As in `README-b4.md`: start the server on 127.0.0.1, send `GET /sleep?s=60` on one connection, wait until the
app reports that the request is being handled, wait 0.5 s more, send SIGTERM to the main process only, and time
from the moment `kill()` returned. All cases use the long (60 s) request only, three runs each, in run order.
Every case except the `-w 2` ones uses `-w 1`. Every case passes `-c` with a config file: the empty one
(`gunicorn-empty.conf.py`) except `sync-conf-graceful10`, which passes `gunicorn-gt10.conf.py` instead. `GUNICORN_CMD_ARGS`
is set only in `sync-env-graceful10` and is otherwise absent from the child's environment.

With two workers the runner records the time each worker was gone, as `[a / b]` sorted ascending; one
worker handled the request, the other was idle (which is which is not recorded). Single-worker cases show `[a]`.

## Results

Columns: version, case, the setting under test, SIGTERM until the in-flight connection closed (ms), until each
worker process was gone (ms), until the main process exited (ms), whether the response arrived complete, and how
the connection ended plus the main process exit code.

| Version | Case | Setting | Connection closed (ms) | Each worker gone (ms) | Main exit (ms) | Response complete | Connection end |
|---|---|---|---|---|---|---|---|
| gunicorn 26.2.0 | `sync-w2` | `-w 2` | 30012.2, 30090.4, 30004.3 | [112.6 / 30037], [101.8 / 30099.7], [109.2 / 30029.2] | 30029.3, 30099.8, 30020.5 | false | fin, exit 0 |
| gunicorn 26.2.0 | `sync-w2-graceful10` | `-w 2 --graceful-timeout 10` | 10086.6, 10096.5, 10025.8 | [115.5 / 10104.3], [104 / 10106.5], [109.9 / 10042.6] | 10095, 10105.2, 10036.3 | false | fin, exit 0 |
| gunicorn 26.2.0 | `sync-env-graceful10` | `GUNICORN_CMD_ARGS='--graceful-timeout 10'` | 10016.2, 10009.4, 10003.2 | [10033.2], [10028.8], [10013.3] | 10033.3, 10026.1, 10012 | false | fin, exit 0 |
| gunicorn 26.2.0 | `sync-conf-graceful10` | `-c gunicorn-gt10.conf.py (graceful_timeout = 10)` | 10004.9, 10059.7, 10073.7 | [10024.9], [10083.8], [10100.8] | 10022.2, 10078.5, 10090.6 | false | fin, exit 0 |
| gunicorn 26.2.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker-graceful10` | `-k uvicorn_worker.UvicornWorker --graceful-timeout 10` | 10079.1, 10044.6, 10096.1 | [10105.8], [10065.3], [10115.1] | 10098.1, 10065.4, 10115.1 | false | fin, exit 0 |
| gunicorn 26.2.0 | `gthread-graceful10` | `--threads 2 --graceful-timeout 10` | 10064.2, 10101.7, 10012 | [10083.6], [10125.9], [10020.4] | 10081, 10119.5, 10020.5 | false | fin, exit 0 |
| gunicorn 27.0.0 | `sync-w2` | `-w 2` | 30073.1, 30020.6, 30087.8 | [103.3 / 30087.6], [103 / 30039.7], [110.2 / 30106.5] | 30081.3, 30029.3, 30096.5 | false | fin, exit 0 |
| gunicorn 27.0.0 | `sync-w2-graceful10` | `-w 2 --graceful-timeout 10` | 10016.9, 10099.2, 10018 | [116.2 / 10033.9], [114.3 / 10110.9], [109.7 / 10041.7] | 10033.9, 10107.8, 10035.5 | false | fin, exit 0 |
| gunicorn 27.0.0 | `sync-env-graceful10` | `GUNICORN_CMD_ARGS='--graceful-timeout 10'` | 10098.8, 10088.4, 10036.8 | [10112.6], [10106.1], [10047.3] | 10107.4, 10096.9, 10046 | false | fin, exit 0 |
| gunicorn 27.0.0 | `sync-conf-graceful10` | `-c gunicorn-gt10.conf.py (graceful_timeout = 10)` | 10082.9, 10091, 10069 | [10099.2], [10106.3], [10077.6] | 10090.9, 10100.8, 10077.6 | false | fin, exit 0 |
| gunicorn 27.0.0 + uvicorn-worker 0.4.0 + uvicorn 0.54.0 | `uvicorn-worker-graceful10` | `-k uvicorn_worker.UvicornWorker --graceful-timeout 10` | 10012.6, 10029.5, 10101.3 | [10025.9], [10046.1], [10117.8] | 10023.5, 10039.9, 10112 | false | fin, exit 0 |
| gunicorn 27.0.0 | `gthread-graceful10` | `--threads 2 --graceful-timeout 10` | 10089.2, 10079.8, 10052.6 | [10103.3], [10092.3], [10064.9] | 10098.1, 10089.1, 10065 | false | fin, exit 0 |

What the table shows (all 36 runs): the request was cut with no response bytes, the connection closed by FIN,
and the main process exited with code 0.

- **`-w 2`, default ceiling: 30 s** (30004 to 30100 ms), same as `-w 1`. **`-w 2 --graceful-timeout 10`: 10 s**
  (10017 to 10107 ms). The idle worker was gone after about 0.1 s (101 to 116 ms) in every run; only the worker
  holding the request lived to the ceiling. The main process waits for the busy worker, so the ceiling is per
  run, not multiplied by the worker count.
- **`GUNICORN_CMD_ARGS='--graceful-timeout 10'` with no flag: 10 s** (10003 to 10113 ms). The environment variable
  sets the ceiling.
- **`-c <file>` with `graceful_timeout = 10`: 10 s** (10005 to 10107 ms). The config file sets the ceiling.
- **uvicorn worker with `--graceful-timeout 10`: 10 s** (10013 to 10116 ms), and **gthread (`--threads 2`) with
  `--graceful-timeout 10`: 10 s** (10012 to 10126 ms).
- No difference between 26.2.0 and 27.0.0 in any case.
- The spread above the configured value (up to about 125 ms) is measurement and process-teardown noise,
  as in `README-b4.md`.

## What is settled and what is not

Settled (measured, 3 runs each, both versions, macOS):

- With two sync workers the ceiling for a running request after SIGTERM to the master is the same as with one:
  30 s by default, 10 s with `--graceful-timeout 10`. The idle worker exits at once.
- `graceful_timeout` takes effect when set by flag, by `GUNICORN_CMD_ARGS`, or by a `-c` config file
  (a plain assignment), for sync. Flag with the uvicorn worker and with gthread also takes effect.

Not settled:

- Precedence when the same setting is given in more than one place (flag vs `GUNICORN_CMD_ARGS` vs config file)
  was not run; each place was tested alone. Documented precedence was not looked up in this follow-up.
- The environment variable and the config file were measured only with the sync worker; the uvicorn worker and gthread
  were measured only with the flag. A different place with those worker classes is expected to behave the same
  (they read the same setting); that is an expectation, not a measurement.
- A config file that sets the value in some computed way (not a plain assignment) was not run.
- Both workers busy, or more than two workers, were not run; neither were the other signals, the other worker
  classes (gevent, eventlet, tornado), a request that finishes before the ceiling with `-w 2`, other platforms,
  or a Kubernetes cluster. One machine, one session.
