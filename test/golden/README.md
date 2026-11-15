# Golden output

In this file "the mockup" means the report mockups drawn before the build. Where a golden differs from them, this file says why. The design documents (requirements, user stories, the report mockups, the interaction spec and the build plan) were written before the code and are kept outside this repository; where this file cites one, the rule it set is restated here.

`web-t1.txt` is the exact human output of `tripcurve .` run inside
`test/fixtures/link/web-demo/` (the one-workload demo fixture; the full demo
repository is bolt B10). The test `test/cli/golden.e2e.test.ts` runs the built
command through a child process and compares stdout byte for byte and the exit
code (1). The file was written from the mockups and the interaction spec before
the renderer existed.

## Where this golden differs from the design mockup, and why

The first-run mockup shows the complete demo (four workloads, 14 files). This fixture is smaller and
bolt B1 has only rule T1, so each point below says how the mockup was read. Each reading cites the spec
section it follows.

1. **Header file count: `4 files read`, not `14`.** The fixture holds four files
   (`k8s/ingress.yaml`, `k8s/service.yaml`, `k8s/web.yaml`, `src/server.ts`).
   The mockup's notes say "the count `14 files read` ... [is] set by the final demo
   fixture". Grammar: `header`, `N files read`; `N` is the number of files intake read.
2. **Header path: `"."`.** The path is printed as typed (grammar: `header`,
   `QUOTED_PATH_OR_STDIN`; the no-files case shows `"./docs"`). The test runs the command with
   the fixture as its working directory and the argument `.`, so no absolute path
   enters the golden (NFR: output is deterministic).
3. **One block, `web`, with the T1 line only.** The mockup's `web` block also has
   `UNRESOLVED T3` and `PASS T2` lines. B1 has no T2 or T3 rule, so the report
   prints nothing about them (the B1 scope). The block is
   the mockup's `web` T1 text: headline, the four chain lines in its order, same labels and
   columns (label column 16 wide, value column at 28, spec grammar `detail`).
4. **Assumptions prints, with two bullets.** The block is printed once at the
   end of every run that has a result and lists every assumption actually used. The
   first bullet, `The container's working directory is taken to be ".".`, is used by
   this fixture: the command is `node src/server.ts`, a relative path, the container
   sets no `workingDir`, and the only file it can name is `src/server.ts` at the root
   (searched from the manifest's folder `k8s` up to the root). The files do not say
   what the container's working directory is, so the folder is assumed and printed
   (review finding M3). The folder is input text, so it is quoted; the root is
   written `"."`. The order follows the mockup: the assumptions this run used first,
   the standing note last. The mockup's first bullet (the propagation allowance) belongs to
   rule T2, so it is not an assumption this run used and is left out. The standing
   bullet ("Green never means zero-downtime ...") is the target of "see Assumptions"
   in the clean closing line and is kept. Assumptions are printed only when a result
   exists (the no-files mockup has no Assumptions block; the nothing-checked mockup has one only for its not-checked
   workload).
5. **Summary counts only what was evaluated: `Summary: 1 failed; not a clean
   result`.** Spec "Closing lines": `Summary: <counts in fixed order>; not a clean
   result`; counting rule: zero counts are not printed (M1 omits "0 warning").
   The line is short enough to need no wrap (M1's hand-wrapped Summary lines wrap
   earlier than 80 columns; the renderer wraps greedily at 80, spec rule 5).
6. **The text ends with one newline; no colour** (stdout is not a terminal, spec
   rule 4).

---

# `api-admin-t1.txt`: the Python servers fixture

`api-admin-t1.txt` is the exact human output of `tripcurve .` run inside
`test/fixtures/python/api-admin/` (bolt B2). It was first written before the Python readers
existed, from the design mockup's `admin` and `api` T1 lines, and was updated (2026-11-11) when the maintainer
decided where a gunicorn or uvicorn version comes from: a `runtime.gunicorn` / `runtime.uvicorn`
declaration, else an exact pin in the repository. The fixture holds a `requirements.txt` with
`gunicorn==26.2.0` and `uvicorn==0.54.0`. Where the text differs from the design mockup, and why:

1. **Header file count: `5 files read`.** Four Kubernetes files plus `requirements.txt`, which intake
   now reads (class `python-pin`). The mockup says the count is set by the final demo fixture.
2. **`api` is `FAIL T1`, as in the design mockup,** with citation `default: gunicorn keepalive, uvicorn worker
   (gunicorn 26.x; measured on 26.2.0)`. The release is known from the pin, so the entry applies.
   The mockup shows the worker line at `"k8s/api.yaml":21`; in this fixture the value `uvicorn_worker.UvicornWorker`
   is on line 22 of its own manifest.
3. **No version line in the chain; the versions are one Assumption.** The mockup's `api` block has no line for
   the gunicorn version, so none is printed for a pin; the pin source is an Assumption instead. The uvicorn
   worker's keep-alive timer is uvicorn's code, so a uvicorn version is used too (the worker's entries apply
   only for a covered uvicorn version, 0.54.x from 0.54.0), and the rule that every assumption actually
   used is listed applies. Both versions here come from the same file, so there is one line: `The gunicorn and
   uvicorn versions are taken from "requirements.txt".` (the file is input text, so it is quoted). When they
   come from different files there is one line each, gunicorn first. A `runtime.gunicorn` or
   `runtime.uvicorn` declaration is a chain line (`gunicorn 26.2.0 declared: ...`), as a `runtime.node`
   declaration is for Node, and no Assumption. **This line changed on 2026-11-11** (it was `The gunicorn
   version is taken from "requirements.txt".` while the uvicorn version was used without being listed):
   the `api` and `admin` blocks and the summary did not change, only the Assumptions line.
4. **Assumptions order.** The assumption this run used comes first, the standing note last (as in the design mockup and
   `web-t1.txt`).
5. **`admin` is the mockup's text.** The `N/A` line and its source line (`("k8s/admin.yaml":18, no -k given)`)
   follow the mockup; the line is the one of the command, because the sync worker is the default and no flag names
   it (interaction spec rule 8). The sync worker needs no version, so it adds no Assumption.
6. **Block order.** `api` holds a FAIL, so its block comes first (interaction spec rule 3), then `admin`.
   The mockup lists `api` first too.
7. **Summary** counts only what B2 evaluates (`1 failed, 1 not applicable`); there is no T2 to T4 here.
8. **No T2 to T4 lines and no working-directory assumption.** B2 has only rule T1, and the commands name no
   relative file.

Without the `requirements.txt` (or on standard input, which has no repository) `api` is `UNRESOLVED T1`
("no gunicorn version in the files") with the line `declare runtime.gunicorn for this workload in
tripcurve.yaml`: `test/cli/python.e2e.test.ts` checks that form too.

---

# Bolt B3: `web-t1.txt` changed, and `web-t1-fixed.txt` (the demo after the fix)

## Why `web-t1.txt` changed (evidence, 2026-11-11)

Only the citation lines of the `idle close` step changed; the headline, the verdict, the other chain lines, the assumptions and the summary are byte for byte as before:

```text
before: default: Node keepAliveTimeout 5 s + buffer 1 s (Node 22.x from 22.19; measured on 22.23.2)
after:  default: Node keepAliveTimeout 5 s + 1 s (Node 22.x from 22.12; measured on 22.12.0 to 22.23.5)
```

The B3 version measurement (`measure/results/2026-11-11-b3-versions.jsonl`, lines 13 to 15, 19 to 21 and 25 to 27; `measure/README-b3-versions.md`) showed that the extra second of the idle close is older than the `keepAliveTimeoutBuffer` property: 22.12.0 and 22.18.0 have no such property (read back `null`) and still close at 6001 to 6004 ms, and the property first appears at 22.19.0. So the range starts at 22.12.0, the lowest measured 22.x, and "buffer" is no longer true of the whole range; the basis names the measured versions (22.12.0, 22.18.0, 22.19.0 and, from B0, 22.23.2 and 22.23.5). Mockup wording for this line was written before that measurement. The value (6 s), the verdict and the golden's structure did not change.

## `web-t1-fixed.txt`: the `web` demo after `server.keepAliveTimeout = 65000`

`web-t1-fixed.txt` is the exact human output of `tripcurve .` run inside `test/fixtures/link/web-demo-fixed/` (the one-workload demo with `server.keepAliveTimeout = 65000;` on line 7 of `src/server.ts`). It was written before the resolver learned the explicit-setting rule, from the design mockup and the measurement in `measure/results/2026-11-11-b3.jsonl` (22.23.2, 22.23.5, 24.22.3 and 26.13.1: an explicit K closes at K + 1 s for K = 7000, 12000 and 65000), then corrected once for the version measurement above. `test/cli/golden.e2e.test.ts` compares it byte for byte and the exit code (0). Where it differs from, and why:

1. **The one `web` block only,** with the T1 line and no T2 or T3 (B3 has only rule T1), and `4 files read`, as `web-t1.txt` (README items 1 to 3 above).
2. **`66 s`, not `<MEASURED>`.** The after-fix mockup says the expected-output file takes the knowledge-base measurement: 65 s plus the measured 1 s is 66 s (66001 to 66004 ms on all four versions).
3. **The headline is the renderer's, `idle close 66 s is longer than LB idle 60 s`,** as every T1 PASS prints it (the mockup's `idle close 75 s is longer than 60 s` is shorter than the grammar's headline for T1; `web-t1.txt` and the Python goldens use the long form).
4. **The deciding source is `"src/server.ts":7`, the line of the setting,** as in the design mockup (`("src/server.ts":12)`): the value being checked is the idle close the file sets. The measured basis follows it inside the parentheses, as the interaction spec's PASS line allows (`decidingNote`): `keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; measured from 7 to 65 s on 22.12.0 to 22.23.5)`, so a reader sees what the 66 s rests on: the measured rule, its range and the span of K it was measured over. With `--verbose` the same value prints as a chain line citing the rule.
5. **The "both effects" rule does not apply.** The run before the measurement showed both candidate effects, 65 s without and 66 s with the buffer, and UNRESOLVED. With the effect measured there is one rule per range, so there are no two candidates and no `to be measured` entry; the rule is superseded.
6. **Summary is the clean closing,** `All checks passed (1), 0 not applicable.` and the zero-downtime line, exit 0: nothing unresolved, no unchecked file. The Assumptions block keeps the working-directory line (the command names a relative file) and the standing note.

## `node:lts` has no golden file

`test/cli/node-versions.e2e.test.ts` checks the output of `web-demo-lts/` (`image: node:lts`) structurally against the shipped knowledge base: the headline `Node version unknown`, one branch line for every entry range with its value, verdict and basis, and one `unresolved` line for every stretch no entry covers. An exact golden would have to change every time a range is widened in the data (the ranges are data and are still being widened), which is the case the structural check covers.

## `node:lts`: how the branch block differs from the design mockup (B3 review m5)

The block header follows: `every known Node range evaluated:` (the report says which kind of range it lists). The rows differ from the mockup on purpose:

1. **Stretches no entry covers are rows of their own** and read `unresolved: no knowledge-base entry covers this range`. The mockup shows only the known ranges; with partial coverage a reader would otherwise take the listed ranges for all of them. The rows are honest, which the mockup has no case for.
2. **The `Node ` of a range label is dropped on the row** (`22.x from 22.12`), as the mockup shows it.
3. **Gap labels are written from the numbers** (`before 18.20.8`, `19 to before 20.20.2`, `27 and later`).

## Basis wording after the B3 points measurement (B3 review)

The basis words now state exactly what was run, from the `measuredVersions` and `measuredKs` of each entry (checked against the result files by `test/kb/node-evidence.test.ts`). Both goldens changed, and only in the basis words:

```text
web-t1.txt:       measured on 22.12.0 to 22.23.5
              ->  measured on 5 releases from 22.12.0 to 22.23.5
web-t1-fixed.txt: measured from 7 to 65 s on 22.12.0 to 22.23.5
              ->  measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5
```

The old text read as a continuous range of releases and of K values; only five releases (22.12.0, 22.18.0, 22.19.0, 22.23.2, 22.23.5) and three values of K were run. The verdicts, values and structure are unchanged.

---

# Bolt B4: T2 and T3 in the demo goldens, and the config-error golden

Rules T2 and T3 arrived in B4, so every golden that runs the whole pipeline gained their lines. The goldens were rewritten from the design mockup (and for the fixed `web`) before the rules existed, and the T1 lines were not touched: every T1 line of `web-t1.txt` and `api-admin-t1.txt` is byte for byte as before (the B4 diff of those two files only adds lines and the summary and the Assumptions bullets).

## The fixtures changed (they now carry what the mockup shows)

`web` and `admin` have a preStop and a grace period; the fixtures did not. The settings were appended to the END of each manifest, so no earlier line number moved (every T1 source line, `"k8s/web.yaml":17` and `"k8s/admin.yaml":18`, is the same):

- `test/fixtures/link/web-demo/k8s/web.yaml` and `.../web-demo-fixed/k8s/web.yaml`: `lifecycle.preStop.exec.command: ["sleep", "10"]` (the delay is on line 25, the line of the `command` key) and `terminationGracePeriodSeconds: 45` (line 26). The mockup shows lines 26 and 30; ours are the fixture's own.
- `test/fixtures/python/api-admin/k8s/admin.yaml`: the same two settings (lines 24 and 25). `api.yaml` is unchanged: no preStop and no drain, which is the mockup's T2 failure.
- `test/fixtures/link/web-demo-fixed/tripcurve.yaml` (new): `longest_request_s: 5` for `web`, as the after-fix mockup says (the file count rises by one).
- The T1 tests keep using the demo without these settings (`DEMO_FILES` in `test/support/analyse.ts` strips them), so a T1 test is about T1; `DEMO_FILES_SHUTDOWN` is the fixture as it is on disk.

## `web-t1.txt` (exit 1)

New lines, from the mockup's `web` block: `UNRESOLVED T3  no graceful-timeout ceiling known for a Node server` with `grace 45 s`, `preStop 10 s` and the `declare longest_request_s ...` line, and `PASS T2  preStop sleep 10 s ("k8s/web.yaml":25)`. Non-pass lines come first (rule 3 of the grammar), so T3 is above T2, as in the design mockup. The Assumptions block gains the propagation allowance (the mockup's first bullet: a T2 PASS used it) between the working-directory line and the standing note. The summary reads `1 failed, 1 unresolved, 1 passed`.

## `api-admin-t1.txt` (exit 1)

- `api`: `FAIL T2  no drain delay before SIGTERM` with `target-type ip  "k8s/ingress.yaml":8`, `preStop none  in "k8s/api.yaml"` and `drain none  in-process drains are read for Node source only; none declared` (word for word from the mockup), then `NOT EVALUATED T3  T2 failed for this workload`.
- `admin`: `PASS T2  preStop sleep 10 s ("k8s/admin.yaml":24)` and `PASS T3  grace 45 s covers 10 s + 0 s + 30 s + 1 s ("k8s/admin.yaml":25)`. The 30 s is the measured gunicorn ceiling (`measured on 26.2.0`, shown with `--verbose`), which needs the gunicorn release: it comes from the same `requirements.txt` as `api`'s, so the existing Assumptions line already names it. (When only a sync gunicorn workload exists, the line is `The gunicorn version is taken from "requirements.txt".`; when a longer line already says the same, the shorter one is dropped.)
- The propagation allowance is the second Assumptions bullet. The summary reads `2 failed, 1 not evaluated, 1 not applicable, 2 passed`.

## `web-t1-fixed.txt` (exit 0)

`web` block: `PASS T1`, `PASS T2  preStop sleep 10 s ("k8s/web.yaml":25)` and `PASS T3  grace 45 s covers 10 s + 0 s + 5 s + 1 s ("k8s/web.yaml":26)`, the header says `5 files read` (the new `tripcurve.yaml`), and the closing is `All checks passed (3), 0 not applicable.` The T1 lines are unchanged.

## Where these goldens differ from the design mockup, and why

1. **The propagation bullet wraps by the renderer.** The mockup hand-wraps it earlier than 80 columns; the renderer wraps greedily at 80 (rule 5), so its first line ends at `preStop`.
2. **`drain none` for a Node server** names what was searched instead of "in-process drains are read for Node source only": `no lightship, terminus or SIGTERM drain found in 1 file read ("src/server.ts"); ...` (no golden shows it; `test/evaluate/t2.test.ts` does). "Node source only" would be false there.
3. **Chain lines of a PASS** are not printed without `--verbose` (rule 8): the PASS lines print one deciding source, as the mockup does.
4. **The `grace` source of a default** prints as `default: Kubernetes terminationGracePeriodSeconds (documented)`, as in the mockup, shown by no golden here because both demos set the grace period.

## `e4-config-error.txt` (exit 2)

`tripcurve .` run inside `test/fixtures/config/e4-golden/`: a `tripcurve.yaml` whose `longest_request_s` is `fast`. It follows the config-error mockup: the error names the key quoted and the form it expects, in tripcurve's own words, then `Nothing was checked.`; nothing is read past the configuration (no header, no result line), nothing goes to stderr, and the exit code is 2. Differences from the config-error case: the key prints as its path (`workloads[0].longest_request_s`), which is how the reader reports every key (earlier bolts' tests pin that), not the bare name; the line is the fixture's (7, where shows 6); and the sentence ends with a full stop. The expected form (`a number of seconds, for example longest_request_s: 5`) is also written for `drain.in_process_s` and `load_balancer.idle_timeout_s`. (a declaration naming no workload) is unchanged: it still reads `key "<name>" names no workload that was read.`

## B4 review fix: `api-admin-t1.txt` gained one Assumptions line (M2)

`admin`'s `PASS T3  grace 45 s covers 10 s + 0 s + 30 s + 1 s` counts the in-process drain as 0 s, but no reader exists for the in-process drains of a Python server (they are read for Node source only). A verdict that rests on that is an assumption, the rule that every assumption actually used is listed applies, so the block now says `In-process drains of Python servers are not read; counted as 0 s.` The verdict, every result line and the summary are unchanged (M1 shows the same PASS). The line is printed only when a T3 verdict counted a Python server's drain as 0 s: not for a Node workload, not when a drain is declared, and not for a T3 that was NOT EVALUATED or UNRESOLVED. `web-t1.txt` and `web-t1-fixed.txt` are Node and unchanged.

---

# Bolt B5: `orders-t4.txt` and `orders-t4-fixed.txt` (T4, the `orders` event source mapping)

Rule T4 arrived in B5 with the Terraform reader. No existing golden changed: the demo fixtures have no Terraform, so T4 adds no block to them (the three goldens above are byte for byte as before).

`orders-t4.txt` is the exact human output of `tripcurve .` run inside `test/fixtures/terraform/orders/` (one file, `infra/queue.tf`, laid out so the three values are on the lines the design mockup shows: visibility on line 3, timeout on line 12, batching on line 20). It was written from the mockup before the Terraform reader and rule T4 existed, and the first run of the code matched it. `orders-t4-fixed.txt` is the same fixture with `visibility_timeout_seconds = 190` (`test/fixtures/terraform/orders-fixed/`), from mockup. Where they differ from the design mockup, and why:

1. **One block, `orders`.** The mockup shows the whole demo (four workloads, 14 files); this fixture holds the one Terraform file, so the header says `1 file read` (grammar: `N files read`, with the singular for 1).
2. **`FAIL T4  visibility 60 s is less than 6 x 30 s + 5 s = 185 s`, word for word from the design mockup,** and its three detail lines in order and labels (`visibility 60 s`, `timeout 30 s`, `batching 5 s`), each a value read from the file with its line.
3. **`PASS T4  visibility 190 s covers 185 s ("infra/queue.tf":3)`, word for word from the design mockup:** the deciding source is the visibility (interaction spec rule 8).
4. **The Assumptions block holds only the standing note,** as for every report that holds a result (the mockup's first bullet, the propagation allowance, belongs to T2 and is not used here), and the closing lines are the renderer's (`Summary: 1 failed; not a clean result`; `All checks passed (1), 0 not applicable.` with the zero-downtime line).
5. **The block header names the mapping resource (`"orders"`) and kind `event source mapping`** (named after the mapping's resource name, quoted).

---

# Waiver and `--explain` goldens (bolt B6)

The files `waivers-*.txt` and `explain-*.txt`. `test/cli/waivers.e2e.test.ts` runs the built command through
`test/support/with-today.mjs`, which calls the real `CliApp` with an injected UTC date (the command has no
hidden variable or flag for it), and compares stdout byte for byte, the exit code and an empty stderr.
The inputs are in `test/support/waiver-scenarios.ts`. The texts were written from the design mockups (the expired-waiver case, the unmatched-waiver case, the invalid-waiver case)
and the interaction spec, then checked line by line against them.

| Golden                               | Scenario                                                                                                                                                 | Date       | Exit |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| `waivers-valid.txt`                  | `test/fixtures/waivers/valid`: the waived `stream` NLB line (T1, from `tripcurve.yaml`), two inline waivers (T2, T3) and the closing line `No failures:` | 2026-11-12 | 0    |
| `waivers-valid-not-checked.txt`      | the same plus a workload with no load balancer: the other closing line, `...; 1 workload not checked.`                                                   | 2026-11-12 | 0    |
| `waivers-t4-terraform.txt`           | a T4 result of a Terraform mapping waived by a comment inside the mapping block (`test/fixtures/terraform/orders`)                                       | 2026-11-12 | 0    |
| `waivers-long-reason.txt`            | a 187-character reason, printed whole as `reason (part k of n)` lines (B6 review)                                                                        | 2026-11-12 | 1    |
| `waivers-e5-expired.txt`             | the expired-waiver case: an inline waiver for T2 that ended on 2026-10-31                                                                                | 2026-11-12 | 1    |
| `waivers-e6-unmatched.txt`           | the unmatched-waiver case: a waiver for T2 of `admin`, which passes                                                                                      | 2026-11-12 | 1    |
| `waivers-e9-invalid.txt`             | the invalid-waiver case: an inline waiver with no reason                                                                                                 | 2026-11-12 | 1    |
| `waivers-invalid-kinds.txt`          | an unknown workload, a bad date, a 201-character reason, an empty reason, a missing reason, an unknown rule                                              | 2026-11-12 | 1    |
| `explain-t1.txt` to `explain-t4.txt` | `tripcurve --explain T<n>`                                                                                                                               | none       | 0    |
| `explain-unknown.txt`                | `tripcurve --explain T9` (stderr)                                                                                                                        | none       | 2    |

## Where these goldens differ from the mockups, and why

1. **Wrapping.** Every line wraps greedily at 80 columns (interaction spec rule 5; the B1 golden README, item 5).
   The mockups of the expired, unmatched and invalid-waiver cases show hand wraps. In particular the `No failures:` line can break before `not applicable.` and in the invalid-waiver case the
   line wraps before `at "k8s/api.yaml":6`, because a continuation line never starts with quoted input (rule 5)
   so the word `at` moves down with it.
2. **Expired-waiver line order.** `waiver expired on <date>` and the `reason ... from ...` line come directly under the result
   line, before the chain lines, as in the expired-waiver case. The expired-waiver case elides the chain lines of its FAIL; the golden keeps them.
3. **Unmatched-waiver and invalid-waiver counts.** The mockups show their own counts (`9 passed`); the goldens show the counts of their
   fixture. The wording of the Waivers not applied lines is that of the unmatched-waiver and invalid-waiver mockups.
4. **The waiver text in the invalid-waiver case.** An inline comment is quoted without its comment mark (`tripcurve: ignore T2 ...`),
   as in the invalid-waiver case. A `waive:` entry is quoted on one line, its YAML written as read (`rule: "T2" workload: "api"`), cut
   with `...` when long.
5. **WAIVED lines have no chain lines** (none under a WAIVED line); `--verbose` adds them.
6. **`explain-*.txt`.** The text follows the explain mockup in its three parts (the rule and quote, the defaults, when it does not
   apply). The defaults are one list item per knowledge-base entry (M6 groups them), headed by the entry id, so two
   entries of one range stay apart, and each carries the date of its measurement or of the page it was read from.
   The dates of the vendor quotes are written under the heading of each quote.
7. **`explain-unknown.txt`** has no quoted rule (see `docs/limits.md`, "`--explain <rule>`").
8. **A long reason is printed whole** (B6 review: the reason is what a reviewer reads). A reason that
   does not fit on the WAIVED line (more than 50 characters quoted) is no longer cut at 50: the `until` line is
   followed by `reason (part k of n) "<piece>"` lines (pieces of at most 44 escaped characters, never splitting
   an escape) and a `from <source>` line. The fixed words keep every line from starting with quoted input.
   Short reasons are unchanged, so the other goldens did not move for this. `waivers-long-reason.txt` is new.
9. **The valid fixtures moved a line** (B6 review): `waivers/valid/k8s/stream.yaml` had its T3 comment as the
   last line of the Deployment, directly before the `---`, which now sits between two documents and is invalid.
   The comment moved inside the Deployment, so `waivers-valid*.txt` say `"k8s/stream.yaml":17` where they said `:20`.
10. **`explain-t1.txt`, `explain-t2.txt` and `explain-t4.txt`** print the research-notes quotes as
    `read 2026-10-29 to 2026-11-02, research notes` (B6 review): the notes give the span of the sweep, not a day.
11. **`explain-t1.txt`** (B8 review, 2026-11-12): the three `node-headers-trap-*` entries used to end with
    `not measurable locally`. They are runnable software whose measurement waits for bolt B13, so they now end with
    `deferred to B13: not measured (<reason>)`, the reason being fixed knowledge-base text (`deferredTo.reason`), not input.
    Only those three entry lines changed, and only in `explain-t1.txt`; T2, T3 and T4 print no such entry.

12. **`explain-t1.txt` dates (B10 review).** Twelve `dated` dates moved from 2026-11-11 to 2026-11-12: the entries
    `node-idle-close-18x` and `-20x` and every `node-explicit-*` entry. Their measurement records
    (`measure/results/2026-11-11-b3*.jsonl`) carry `"date": "2026-11-12"`, and the lookup file says 2026-11-12T05:51Z; the
    knowledge base said 2026-11-11, which the records contradict. The file names keep the bolt's start date and were not
    renamed (`measure/README-b3*.md`). `node-idle-close-22x`, `-24x` and `-26x` keep 2026-11-11: the release the date names
    (22.23.5, 24.22.3, 26.13.1) was measured on 2026-11-11 (`2026-11-11-b0.jsonl`), though some releases in their ranges
    were measured on 2026-11-12. Nothing else in the file moved.

## B7: the JSON and SARIF goldens (`report-<name>.json.txt`, `report-<name>.sarif.txt`)

The files end in `.txt` so that Biome does not reformat them. Each was written by hand from contracts and mockups (and the human goldens above, for the values) before the renderers existed, then compared with the output of the built command (`test/cli/report-formats.e2e.test.ts`). The inputs are in `test/support/report-scenarios.ts`. Where the first comparison differed, the output was checked against the model and the golden was corrected only where the model, not the renderer, was right. There were two such corrections, both noted here.

| Golden             | Input                                                                  | Exit | Shows                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report-demo`      | `test/fixtures/report/demo` (api, web, orders, admin)                  | 1    | the demo: four failures, so exactly four `error` results in SARIF, one `warning` (web T3) and one `note` (api T3 NOT EVALUATED); PASS and N/A are only in JSON                       |
| `report-waived`    | `waivers/valid`, date 2026-11-12                                       | 0    | three applied waivers: one `external` (tripcurve.yaml), two `inSource`; each keeps the level of its original kind; ends `NoFailures`                                                 |
| `report-expired`   | `python/api-admin` with an inline waiver ending 2026-10-31             | 1    | the waiver is expired: no `suppressions`, the result keeps its level; the waiver is in `waivers[]` with state `expired`                                                              |
| `report-e1`        | `hostile/no-files`                                                     | 2    | one `tripcurve-file` warning at the checked root `.`; JSON has `noFiles`                                                                                                             |
| `report-e4`        | `config/e4-golden`                                                     | 2    | `outcome` ConfigError, no workloads, every count 0, `clean: false`; SARIF has the configuration error as a warning at `tripcurve.yaml:7`                                             |
| `report-e10`       | `report/e10` (a Deployment with no load balancer)                      | 2    | one warning "files were read but no check was evaluated"; the workload is in `notChecked`                                                                                            |
| `report-unchecked` | `hostile/bad-yaml`                                                     | 2    | the nothing-checked warning and, after it, the unchecked file as its own warning at `broken.yaml:5`                                                                                  |
| `report-stream`    | `report/stream` (an NLB)                                               | 1    | three UNRESOLVED results, `warning` in SARIF, never pass                                                                                                                             |
| `report-hostile`   | the web demo with a hostile workload name, waiver reason and file name | 1    | quote, backslash, right-to-left override, lone surrogate, astral character, escape sequence: all escaped, plain ASCII; the lone surrogate is U+FFFD; the file URI is percent-encoded |

### Readings

1. **Order of SARIF results.** The nothing-checked result (if any), then the rule results in the order of the human report, then unchecked files, waivers not applied, and configuration errors. For NothingChecked outcomes with unchecked files (`report-unchecked`) "exactly one result" is read as "exactly one nothing-checked result": the unchecked file is still its own result, because the project rule is that unchecked files are always results.
2. **A config waiver's source is `declared`, not `file`** (correction 1): the model gives a `tripcurve.yaml` entry a `declared` source, and the JSON says so.
3. **`notChecked[].line`** is present when the model has it (correction 2): the line of the object (the `kind:` line).
4. **`unchecked[].reason` is the words, the line is its own field.** The SARIF mockup wrote "YAML syntax error at line 14" in the reason; the JSON contract says `line` is a field "only for a parse error". The reason is "YAML syntax error", the line is `line`; the SARIF message joins them.
5. **The human report's closing line for NothingChecked and ConfigError prints no counts**, while the JSON summary always has them (an invalid waiver counts under `unresolved` even when nothing was checked). The two do not contradict each other: the human report lists those waivers.
6. **Suppressions are omitted, not empty,** for a result with no valid waiver: the JSON contract says `suppressions` appear "only for a valid waiver", which wins over the mockup's `"suppressions": []`.
7. **The first SARIF run property set is the contract's** (`outcome`, `clean`, `summary`, `exitCode`) plus `notChecked`, the number of objects listed as not checked, so a consumer that reads only SARIF can tell that "All checks passed" had workloads it did not look at.

### Review of B7: what changed in these goldens

- **Rules.** Every SARIF golden lists seven rules: T1 to T4, `tripcurve-file`, `tripcurve-run` and `tripcurve-not-checked`.
- **URIs.** Every relative `uri` has `"uriBaseId": "SRCROOT"` and every run declares `originalUriBaseIds.SRCROOT` (m8). The root is `"."` whatever was typed.
- **Suppressions** carry `properties.tripcurve` with `until`, `mechanism` and `source` (m2): `report-waived`, `report-hostile`, `report-runlevel`.
- **Notes** for workloads that were not checked (m4): `report-e10` and `report-unchecked` each gain a `tripcurve-not-checked` note.
- **Brackets** in a message are escaped (review M2): the config-error message reads `workloads\\[0\\].longest_request_s` in the golden file, which is `workloads\[0\]` once decoded.
- **New goldens:** `report-runlevel` (T1 and T2 waived, T3 NOT EVALUATED, so the only unsuppressed result before the fix was a note; the new `tripcurve-run` warning is last), `report-clean` (the demo after the fix: no result, `Clean`, `clean: true`) and `report-noapply` (NoChecksApply, built from a Report, see `docs/limits.md`).
- **Human goldens** are unchanged: no config-error golden has an unchecked file, so the new `Files not checked` section of m3 does not appear in any of them. It is tested in `test/cli/config-error-formats.e2e.test.ts`.

## `sam-t4.txt` (bolt B12)

The human output of `tripcurve .` run inside `test/fixtures/iac/sam/orders/`: a SAM template with an
`AWS::Serverless::Function` and an SQS event, read into the same model as the Terraform `orders` case. It was
written before the reader existed, from `orders-t4.txt`. The verdict line and the arithmetic are the same
(`FAIL T4  visibility 60 s is less than 6 x 30 s + 5 s = 185 s`); the file is `template.yaml`, the three sources
are lines 7, 14 and 21 of it, and the workload is named after the function and the event, quoted:
`Workload "OrdersFunction/OrdersEvent" (event source mapping) in "template.yaml"` (a mapping is named by its
resource name; a SAM event has no resource of its own, so the name is `<function>/<event>`).

### B12 review: `explain-t1.txt` and `explain-t4.txt` changed, on purpose (m3)

`--explain T4` said its values were "read from Terraform" and listed only the Terraform defaults; since B12 it reads SAM
and CloudFormation templates too. T4 now lists `cfn-sqs-visibility-default` and `cfn-lambda-timeout-default`, and its
"when it does not apply" line names the templates. T1 now lists `cfn-lb-idle-timeout-default` and says a
CloudFormation load balancer is read but not yet linked to an Ingress (there is no CloudFormation form in
`tripcurve.yaml`). The old text was no longer true, so these two goldens had to change; no other golden did.

13. **`explain-t1.txt`** (B13, 2026-11-12): the `deferredTo.reason` of the three `node-headers-trap-*` entries now names
    the B13 attempt ("Attempted in B13 (2026-11-12): cannot run on this host") and its record file
    `measure/results/2026-11-12-b13-attempt.txt`, and says what would make it run (Rosetta 2 or an x64 host). Value,
    basis (`from changelogs, not measured`) and subject are unchanged. Only those three entry lines changed, and only in
    `explain-t1.txt`.

## B17: the real-repository fixes (2026-11-12)

14. **`explain-t4.txt`** changed, on purpose. The "when it does not apply" lines said T4 is UNRESOLVED, never PASS or FAIL,
    when a batching window is not written. That is no longer true: since B17 visibility below 6 x the function timeout is a
    FAIL whatever the window is (a window is 0 s or more, so it only raises the need), and a Terraform mapping links to its
    queue and function in the same folder, not the same file. The old line is split in four: the folder link, the arithmetic
    on literals, the window-independent FAIL, and the UNRESOLVED cases that remain. Nothing else in that file changed.
    The maintainer delegated these changes on 2026-11-12.
15. **The hint under a workload whose program is not identified** (peermetrics `api`, DevOpsDojo `frontend`; goldens in
    `test/fixtures/real/*/expected.txt`, not in this folder). It said `pin the image to an exact Node version tag, or
    declare runtime.node for this workload in tripcurve.yaml`, which misleads for a Python image. It now says `name the
    program in the container command or args (node, npm, gunicorn or uvicorn); for Node, tripcurve.yaml can instead declare
    runtime.node for this workload, with source for its entry file`. The reason line above it is unchanged. No golden in
    this folder shows that hint (checked by `grep` on 2026-11-12), so no other golden changed.
16. **`folder-split-t4.txt`, `folder-override-t4.txt`, `folder-duplicate-t4.txt`, `folder-arith-t4.txt` and `python-no-command-t1.txt`**
    (new, B17; run by `test/cli/real-repo-fixes.e2e.test.ts` on `test/fixtures/terraform/folder-*` and
    `test/fixtures/link/python-no-command`). Each was read against its files before it was saved. `folder-split`: queue
    `30 * 2` = 60 s in `queue.tf`, function timeout 30 s in `function.tf`, mapping in `mapping.tf`, no batching window, so FAIL
    (60 < 6 x 30 = 180 whatever the window is); the `modules/child` mapping names the same addresses but is another module, so
    it is UNRESOLVED. `folder-override`: `override.tf` names the queue, so its value is UNRESOLVED. `folder-duplicate`: the queue
    address is declared in two files, which Terraform rejects, so UNRESOLVED. `folder-arith`: `60 + (30 * 6)` = 240, with a
    60 s window, so 6 x 30 + 60 = 240 and PASS (equal passes). `python-no-command`: an image with no command is not a Node
    program, and the hint is the neutral one.
