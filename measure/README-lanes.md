# The measurement lanes (bolt B8)

`node measure/lanes.mjs <pinned|latest>` runs every knowledge-base entry's measurement script and compares
what it measured with what the entry says. `npm run verify:measure` is the pinned lane. It is a separate,
labelled step and is **not** part of `npm run verify`: it starts real servers on 127.0.0.1, takes
several minutes and is sensitive to machine load. `npm run verify` instead runs the lane logic against
recorded lines and fakes (`test/kb/lanes.test.ts`), including a planted-drift test that must fail.

## What it reads

- The knowledge-base data files `src/kb/data/*.json`, read as plain JSON. `lanes.mjs` and
  `lib/lanes-core.mjs` import nothing from `src/` (it reads the schema only).
- Each entry's `scriptRef` is the script that measures it. Nine entries (ALB idle, Kubernetes grace, the four
  Terraform and AWS defaults, and the three CloudFormation defaults added in B12) carry `{notMeasurableLocally: reason}` instead and are listed as `NOT RUN`
  with that reason; the reason is valid only for a documented value of a service that cannot run on localhost
  and never for a runtime the scripts can start (a gap otherwise). The three old-Node `headersTimeout` entries
  are runnable software and carry `deferredTo: {bolt: "B13", reason}`: the lane prints `DEFERRED (B13)`, counts
  them apart and never as a pass.
- The scripts are the hardened ones from B0 to B4. A case is one run of one script with fixed arguments;
  the runner adds no timing code of its own. The measuring script prints one JSON line; the runner
  requires exactly one line, valid JSON, and exit code 0.

## What counts as a pass

Every case must pass, and every entry that is not a stated-reason entry must have at least one case. A case
passes only when all of these hold:

1. The line names the release that ran (for the entry's own runtime) and it equals the release the case pins.
2. Where the script reads the setting back from the running server (Node `keepAliveTimeout` and buffer,
   gunicorn's worker class), the read-back equals what the case wrote.
3. The script's stated resolution (`sweepStepMs` + `injectedLatencyMs` + `pollMs`) is not coarser than the
   tolerance, and the line states one.
4. A case that runs the uvicorn worker is on a uvicorn release that a uvicorn entry covers, and the gunicorn
   worker class read back from the log is the one the case asked for (where the script reads it).
5. The measured number is a finite number within the entry's tolerance of the value the entry predicts
   (both sides: a value too low fails as well as one too high). The tolerance is the entry's `toleranceMs`;
   for a proportional entry (gthread) it is `toleranceMsAt` for a value that has observations of its own,
   else `V x 1000 x toleranceRelative + 1` ms. Each case line prints the tolerance and the margin.

Anything else is a FAIL: a script that could not measure (exit 4), a missing field, a wrong release, a
timeout, a missing toolchain. Nothing is retried. An entry with basis `to-be-measured` is listed as a release
blocker and fails the lane.

What each entry predicts:

| Entry subject | Case | Prediction |
|---|---|---|
| Node default idle close | `node-idle-close.mjs` on each release the entry cites | entry value |
| Node explicit `keepAliveTimeout` | `node-explicit.mjs K` for each K the entry lists, plus its `createServer` options runs | K + entry value (the extra seconds) |
| Node explicit buffer | the same with `--buffer=<value>` | K + buffer |
| gunicorn / uvicorn default keepalive | `py-idle-close.mjs`, `py-b2.mjs threads` | entry value |
| gunicorn sync | `py-b2.mjs sync` | closes after the response with `Connection: close`, within the tolerance |
| explicit Python keepalive | `py-b2.mjs <mode> K` for the smallest K in `measuredSpan` (`--full` adds the largest, 300 s) | K |
| gunicorn graceful ceiling (default) | `shutdown-b4.mjs` for each worker class in the entry's condition | entry value, connection ended by FIN, response cut |
| gunicorn graceful ceiling (explicit) | `shutdown-b4-more.mjs` for each (source, worker class) the entry lists | `measuredSpan` value |
| uvicorn graceful | `shutdown-b4.mjs uvicorn-graceful5` and `uvicorn` | 5 s; and no ceiling (the 60 s request finishes in full) |
| lightship | `lightship-b4.mjs k8s` | entry value (ms) |

## The two lanes

- **pinned** (default for `npm run verify:measure`): the releases each entry cites, from `.cache/`
  (official Node tarballs; the `py-g26` and `py-g27` virtualenvs; lightship 9.1.0).
- **latest**: looks up the newest release of Node (`nodejs.org/dist/index.json`), gunicorn, uvicorn,
  uvicorn-worker (`pypi.org/pypi/<name>/json`) and lightship (`registry.npmjs.org/lightship`) with GET
  only, picks the newest plain release inside each distinct entry range, installs what is missing into `.cache/`
  and runs the same cases against it. A lookup that returns 403, 404, a rate limit or anything but 200 stops the
  lane with exit 4 ("lane NOT RUN"); it is never read as "nothing newer". The newest release overall of each
  runtime that falls outside every range of that runtime is reported as drift and fails the lane.
  - Node: the tarball and `SHASUMS256.txt` come from the same release directory; the tarball's SHA-256 must
    equal its line before it is unpacked (the B0 method).
  - Python: `uv pip compile --generate-hashes`, then `uv pip install --require-hashes`.
  - lightship: `npm install --ignore-scripts`; npm checks the registry's sha512 integrity value.

The lane never changes a knowledge-base value. A difference is a finding for the maintainer.

## Options

`--jobs=N` (default 1) runs up to N scripts at once on different ephemeral ports. One at a time is the default because a timing measurement must not share the CPU with another one; any N above 1 prints `measurements ran in parallel; timing may be skewed`. The parallel runs made while building the lanes are kept in `results/*-jobs2.*` and `*-jobs4.*` (see `docs/limits.md`). `--list` prints the plan without running
anything. `--only=<entry id>`, `--full`, `--raw=<file>` (the script lines exactly as printed), `--cache=<dir>`
(default: `.cache/` of the repository, or of the main checkout when this is a worktree) and `--kb=<dir>`.
Exit codes: 0 clean pass, 1 lane failed or knowledge-base gap, 2 usage, 4 could not run, 5 passed on a busy host (not an official run); see "Exit codes" below.

A gap (an entry with no script or stated reason, no source URL, no range or no basis, a script that does not
exist, or an entry no case can be planned for) stops the lane before anything runs; the same check is a test.

## Load on the host

A timing measurement must not share the CPU with another one, and one script at a time (`--jobs=1`) does not
protect it from the rest of the machine. The lane samples the host load at its start, before every case and at
its end, prints the start and end, and calls the run busy when any sample is above half the cores: a passing busy
run exits 5 and is not an official run. Run the official lanes on a quiet machine. Tolerances are derived only
from runs taken one at a time (see `docs/limits.md`).

Limits of the rule:

- It reads only the 1-minute load average, at discrete points (start, before each case, end). A burst inside a
  long case is seen only at the next sample, and a burst after the last case is seen at the end sample only if the
  average has risen by then.
- A host that reports `[0, 0, 0]` (some containers and platforms do) never reads as busy.
- The core count is `os.cpus().length`, which ignores a container's CPU limit: in a container limited to fewer
  CPUs than the host shows, the threshold is too high.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | clean pass on a quiet host |
| 1 | the lane failed, or the knowledge base has a gap |
| 2 | usage error |
| 4 | the lane could not run (a lookup or download failed, a checksum differed) |
| 5 | every check passed but the host was busy (a load sample above half the cores at the start, before a case, or at the end): `LANE PASS (host was busy: not an official run)`; no gate may take it for a clean pass |
