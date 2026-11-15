# Release checklist: tripcurve 0.1.0 (unreleased)

Written in bolt B15 on 2026-11-12. **Nothing here publishes anything.** Releasing means publishing to npm and the GitHub Action, by hand, and only on the maintainer's explicit go; until then the package stays `private: true` with `license: UNLICENSED`, and the name is neither reserved nor published. The checks come from the team practices (Deployment) and the v0.1.0 definition (kept in the maintainer's design documents, outside this repository).

The design documents (requirements, user stories, the report mockups, the interaction spec and the build plan) were written before the code and are kept outside this repository; where this file cites one, the rule it set is restated here.

Every check is marked one of:

- **done locally**: it ran in this bolt, with the command and its real output (the raw record is `docs/release-check-run-b15.txt`, and the lookups are in `docs/lookups-b15.txt`);
- **cannot run before the maintainer's go**: with the reason;
- **open maintainer decision**: with the question;
- **pending**: not yet possible, with the reason.

Updated in bolt B16 on 2026-11-12: rows 5, 6, 7 and 18, the "Compatibility across Node releases" section, the platform audit, and the maintainer questions that were decided (the "Decided on 2026-11-12" section). Row 17 and B14 are not touched here, because B14 is built in parallel. The raw record of B16 is `docs/release-check-run-b16.txt`.

The state of `main` when this was written (2026-11-13): every bolt B0 to B17 is merged (B16 by the change that holds this text). (Status given by the main session.) Updated in B22 (2026-11-14): B0 to B21 are merged; B22, the change that holds this update, awaited its independent review, and the figures under "What ran" are from a run on 2026-11-14. Updated in B25 (2026-11-15): B0 to B24 are merged and reviewed, and rows 12 to 14 are done.

## The release checks

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | One local command passes: typecheck (tests included), Biome, unit, golden and end-to-end tests with the 80% coverage floor, measurement self-test, build and timed check | **done locally** | `npm run verify`: see "What ran" below |
| 2 | v0.1.0 definition, item by item | see the next table | |
| 3 | Pinned measurement lane (`npm run verify:measure`) | **done locally**: passed on a quiet host | 110 of 110 cases including the nine stated-reason entries, run 2026-11-12 from 20:27Z to 21:07Z; raw output in `measure/results/2026-11-12-lanes-pinned-b15.txt` and `.jsonl`, and in `docs/release-check-run-b15.txt` |
| 4 | Latest measurement lane (`node measure/lanes.mjs latest`) | **done in B8 on 2026-11-12, before B12; not re-run in B15; must be run again on the day of the go** | 65 of 65 cases, no drift (`measure/results/2026-11-12-lanes-latest.txt`), which predates the three CloudFormation entries; it needs the network (GET only) and installs into `.cache/` |
| 5 | `npm audit`, checkout and `npm ci` from `npm-shrinkwrap.json` | **done locally, 0 vulnerabilities (B16, 2026-11-12; rerun B21, 2026-11-14)**; not the same as row 5b | `npm audit` printed `found 0 vulnerabilities`, with an npm `overrides` entry that pins `minimatch` to 11.0.8; see "npm audit" below |
| 5b | Fresh-install audit of the packed tarball | **NOT CLEAN; must be clean before any npm publish** | 4 moderate findings, `minimatch` 10.2.6 (B21, 2026-11-14; `docs/release-check-run-b21.txt`); closed only by a ts-morph release that allows `minimatch` 11 or by replacing ts-morph; the package is private and not published to npm, so no such consumer exists today; see "npm audit" below |
| 6 | Pinned shrinkwrap with no install scripts | **done locally, with one finding, open maintainer decision** | exact direct pins and integrity hashes on all 123 packages of the shrinkwrap; one dev-only optional package is flagged; see "The shrinkwrap" below |
| 7 | Schema-valid SARIF | **done as the build-plan fallback; deviation from the acceptance criterion recorded** | The acceptance criterion asks for validation against a repo-kept schema; the schema is not vendored because its licence (OASIS IPR Policy, RF on RAND Terms Mode, read 2026-11-13, `docs/lookups-b16.txt`) is not MIT, Apache-2.0 or BSD. Instead, one-off on 2026-11-12: every SARIF golden and the SARIF of `demo/` and `demo-fixed/` validate against the official SARIF 2.1.0 JSON schema (`docs/release-check-run-b16.txt`); see "SARIF validity" below |
| 8 | The docs | **done locally** (written in B15) | README, rules, how defaults were measured, add an entry, CI and SARIF, security, CHANGELOG, this page; `test/docs/docs.test.ts` checks diagrams, quotes and sourced numbers |
| 9 | Every bolt's review closed | **done for B0 to B25** (see "Reviews" below; updated 2026-11-15) | see "Reviews" below |
| 10 | Release-quality dry run (metric 5): a fresh session adds an entry using only the docs | **done 2026-11-13: partial success** (the maintainer reviews it; it may want a re-run against the fixed guide) | `docs/add-a-knowledge-base-entry.md`, section 9; the record is below, "The metric-5 dry run (2026-11-13)" |
| 11 | A fresh re-check of the npm name | **done locally on 2026-11-12; repeat on the day of the go** | `npm view tripcurve` returned 404 at 2026-11-12T20:21Z (`docs/lookups-b15.txt`) |
| 12 | The hosted CI workflow runs | **done 2026-11-15**: `.github/workflows/verify.yml` ran on the first push; run 43682221175 succeeded on Ubuntu (Node 22.12.0, 24, 26) and macOS (Node 22.12.0), the first run of the suite on Linux | `docs/evidence/gh-hosted-runs.txt`; `docs/evidence/gh-linux-verify.txt`; `docs/ci-and-sarif.md`; `test/action/workflows.test.ts` |
| 13 | The GitHub Action runs on a hosted runner | **done 2026-11-15**: `.github/workflows/action-selftest.yml` ran on the first push, run 43682221183: `clean` (`demo-fixed`), `failing` and `upload` (`demo`) all succeeded | `docs/evidence/gh-hosted-runs.txt`;  `docs/action.md`, "The self-test workflow" and "Not tested" |
| 14 | SARIF upload to code scanning | **done 2026-11-15**: the `upload` job of run 43682221183 uploaded the demo's SARIF and GitHub created an analysis (tool tripcurve 0.1.0, 6 results, 7 rules) and six open alerts; the upload stays opt-in (`upload-sarif: "true"`, default off) | `docs/evidence/gh-code-scanning.txt`;  `docs/action.md`, "The SARIF upload is opt-in"; `docs/lookups-b19.txt` |
| 15 | Publish to npm; publish the Action | **cannot run before the maintainer's go** | |
| 16 | The licence | **open maintainer decision**: decided by the maintainer before release | no LICENSE file exists, and a test checks that |
| 17 | The real-repository check (B14) | **done locally on 2026-11-12; review closed (MERGE)**: four trimmed copies of public MIT repositories were run, and every result was judged against the real files. No wrong verdict was found; every run is UNRESOLVED or not clean, and the gaps are documented as known limits. | `test/fixtures/real/README.md` (selection criteria, results table, the synthetic fixtures for shapes with no real repository); `test/e2e/real-repos.e2e.test.ts`; `docs/limits.md`, "Real-repository check" |
| 17b | The real-repository check after B17 | **done locally on 2026-11-12; review closed (two passes, MERGE)**: the two Terraform copies were judged again after the folder-scoped link and the exact arithmetic (`sorah/publikes`: PASS; `DanielDaCosta/apiGateway-sqs-lambda`: FAIL), and the two hints under an unidentified program were judged again. No wrong verdict was found. | `test/fixtures/real/README.md` (results table); `docs/limits.md`, "Real-repository check"; `docs/lookups-b17.txt` |
| 18 | Compatibility across the supported Node releases | **done locally (B16, 2026-11-12)** | the tests, the build and the demo on four Node releases, and the unsupported-Node message on Node 20 and 18; see "Compatibility across Node releases" below |

### The v0.1.0 definition, item by item

| Release definition item | Status | Evidence or reason |
|---|---|---|
| Feature Areas 1 to 4 working on the demo repo: failures, a deliberate not-applicable pass, then green after the three-step fix | **done locally** | `test/e2e/demo.e2e.test.ts` runs the built command on `demo/` and `demo-fixed/` and compares the output byte for byte: exit 1 with 4 failed, 1 unresolved, 1 not evaluated, 1 not applicable and 3 passed, then exit 0 with `All checks passed (9), 1 not applicable.` The first run has more kinds than the v0.1.0 definition's wording ("four failures, one deliberate pass"); the differences were decided by the order of the design documents: requirements, stories, mockups, research notes, build plan (`BUILD-NOTES.md`, B10) |
| Precision fixtures green | **done locally** | the gunicorn sync worker, `--threads` above 1, `GUNICORN_CMD_ARGS` overrides, Node with and without the buffer, resolved and unresolved terminus `beforeShutdown`: part of `npm run verify` |
| SARIF with suppressions validated against the SARIF schema | **done as the build-plan fallback; deviation from the acceptance criterion recorded** (one-off, B16, 2026-11-12) | the official schema validated every SARIF golden (three of them carry suppressions) and the SARIF of `demo/` and `demo-fixed/`; `npm run verify` still uses `test/support/sarif-validate.ts`, a subset validator, because the official schema (OASIS IPR terms) is not vendored (decided 2026-11-12) |
| Knowledge-base entries each have a measurement script that passes locally | **partly** | 36 entries have a script, run by the pinned lane; 9 carry a stated reason because the service cannot run on localhost (the "not measurable locally" rule, widened beyond its letter for 7 of them: accepted, decided 2026-11-12); 3 are deferred and not measured (below) |
| The documentation set written | **done locally** | row 8 above |
| Every bolt adversarially reviewed with fixes verified | **not yet** | row 9 above |
| No unresolved "unverified" item hidden in the docs | **done locally** | the docs list what is unverified (below); a reviewer should confirm none is missing |

## What ran

### `npm run verify`: done locally

`npm run verify` runs the typecheck (the typecheck configuration includes `test/`), Biome, the unit, golden and end-to-end tests with the 80% line-coverage floor, the measurement self-test, the build and the timed check. It exited 0. The figures are from the run of 2026-11-15T03:55Z (2026-11-14 local time) on the B22 tree, run twice with the same counts (the first run, a few minutes earlier, ended before one unused import was removed). The B15 figures (263 files, 123 test files, 12,614 tests) are history, kept in `docs/release-check-run-b15.txt`. Verbatim from the second run (`npm run verify`, exit 0):

```text
Checked 282 files in 90ms. No fixes applied.
Found 2 infos.
 Test Files  141 passed (141)
      Tests  13115 passed (13115)
Statements   : 94.61% ( 8353/8828 )
Branches     : 89.54% ( 7455/8325 )
Functions    : 98.67% ( 1121/1136 )
Lines        : 96.74% ( 7321/7567 )
selftest: all cases passed
timed check: demo 0.22 s fastest of 3 (runs 0.22, 0.22, 0.22; budget under 2 s) on Mac17,3, Apple M5, Node v22.23.2, 2026-11-15
timed check: tree 1.90 s fastest of 3 (runs 1.97, 2.02, 1.90; budget under 30 s) on Mac17,3, Apple M5, Node v22.23.2, 2026-11-15
timed check: within budget on the recorded machine
npm run verify  657.04s user 37.90s system 457% cpu 2:31.96 total
```

Notes on that output:

- The 13,115 tests include the docs tests (`test/docs/docs.test.ts`), which check this page's own claims about commands, bolts and the shrinkwrap.
- "Found 2 infos" are two Biome style suggestions in test files from earlier bolts (`test/parse/iac-cfn-hostile.test.ts` and `test/report/sarif.test.ts`), not errors and not from this bolt; no rule was relaxed.
- The timed check enforces its budgets only on the recorded machine (`Mac17,3`, `Apple M5`); anywhere else it prints `skipped` and passes, so the hosted Linux jobs do not enforce them (the Node 22.12.0 Linux job printed `timed check: skipped`). (`docs/limits.md`, "The timed check and the demo")
- The coverage floor is 80% of lines on the core pipeline code and was not lowered. (`vitest.config.ts`)

### The pinned lane (`npm run verify:measure`): done locally

Run alone on a quiet host (the load average was 2.68 at the start and 1.21 at the end, on 10 cores, so it counts as an official run). It exited 0. Verbatim from `docs/release-check-run-b15.txt`:

```text
LANE PASS: 110 of 110 cases within tolerance, 36 entries planned, 36 entries passing, 9 carry a stated reason, 3 deferred and not measured, 0 release blockers, 0 drift findings
```

The raw lane output is `measure/results/2026-11-12-lanes-pinned-b15.txt` and `measure/results/2026-11-12-lanes-pinned-b15.jsonl` (kept as evidence, not as a tolerance basis). This is the first official run since B12 added the three CloudFormation entries (the B8 run said 6 stated reasons). The three `DEFERRED (B13)` lines in the record are the old-Node entries below, counted apart and not measured.

### SARIF validator: done locally

`test/report/sarif-validate.test.ts` and `test/report/sarif.test.ts` passed (177 tests, `docs/release-check-run-b15.txt`); they are also part of `npm run verify`. This is the subset validator, not the official schema (see "SARIF validity").

### Other commands run

- `npm run build` ran as the build step of `npm run verify` (above) and again on its own at the end of this bolt; see the end of `docs/release-check-run-b15.txt`.
- The goldens are byte-identical: `git status` at the end of the record shows no change under `test/golden/`.
- The shrinkwrap (then the lock file), `npm ls` and SARIF-gate checks are in `docs/release-check-run-b15.txt`; `npm audit` and the npm-name check are in `docs/lookups-b15.txt`.

## npm audit

The audit is clean (0 vulnerabilities) for every way this repository is used: a `git clone` followed by `npm ci` from `npm-shrinkwrap.json`, and the tree that the hosted workflows install (the same shrinkwrap; the audit itself was run locally, not on GitHub). It is NOT clean for a consumer who installs the packed tarball: npm `overrides` do not ship, and a shrinkwrap entry outside the dependent's declared range is dropped (`@ts-morph/common` 0.29.0 declares `minimatch ^10.0.1`; ts-morph 28.0.0 is the newest). The package is private and not published to npm, so no such consumer exists; before any npm publish this must be closed by a ts-morph release that allows minimatch 11 or by replacing ts-morph.

Rerun in B22 at 2026-11-15T03:51Z (2026-11-14 local; registry reads only, in scratch folders): `npm audit` in the checkout printed `found 0 vulnerabilities`; `npm pack` and `npm install --ignore-scripts` of that tarball into a fresh project, then `npm audit`, printed `4 moderate severity vulnerabilities`, with `npm ls minimatch` showing `minimatch@10.2.6` under `@ts-morph/common@0.29.0` under `ts-morph@28.0.0`.

**Clean for the checkout, with an override (B16, 2026-11-12).** Until B16, `npm audit` reported 3 moderate severity vulnerabilities: a denial of service in `minimatch` (GHSA-g3hv-75wg-m249, vulnerable range 7.0.0 to before 11.0.1), reached through `ts-morph` 28.0.0 and `@ts-morph/common` 0.29.0, which asks for `minimatch` `^10.0.1`. The only fix `npm audit` offered was `npm audit fix --force`, which installs `ts-morph@17.0.1`, a breaking change, and was not taken (first reported in B1, `BUILD-NOTES.md`). The dated lookups of 2026-11-12 (`docs/lookups-b15.txt`) found `ts-morph` 28.0.0 to be the newest release and `minimatch` 11.0.8 the newest `minimatch`.

The fix is one entry in `package.json`: `"overrides": { "minimatch": "11.0.8" }`. The reason: `npm audit` flags every `minimatch` below 11.0.1, `ts-morph` has no newer release that bumps it, and a downgrade of `ts-morph` is a breaking change. It was committed on 2026-11-12 (2774245).

How the override was checked on 2026-11-12 (`docs/release-check-run-b16.txt`):

- `npm ls minimatch` shows one copy, `minimatch@11.0.8 overridden`, under `ts-morph@28.0.0` and `@ts-morph/common@0.29.0`.
- `@ts-morph/common` calls `minimatch.minimatch(path, pattern)` (its `dist/ts-morph-common.js`, lines 1199 and 1287); loaded from `@ts-morph/common`'s own directory, `require('minimatch').minimatch` is a function, and it returned `true` for `a/b.ts` against `a/*.ts` and `false` for `a/b.js`.
- `minimatch` 11.0.8 declares `engines.node` as `20 || >=22`, which includes every Node release tripcurve supports.
- `npm run verify` passed with the override, and the tests also passed on the four Node releases below.

What that does not show: `ts-morph` was not tested on every code path that calls `minimatch` (it uses it for file globs). tripcurve hands `ts-morph` source text and not glob patterns from the files under check, so the denial-of-service input is probably not reachable, but that reasoning was not tested. The override should be dropped when `ts-morph` ships a release that bumps `minimatch` itself. (`docs/limits.md`, "The minimatch override")

`npm audit` run again at 2026-11-12T23:06Z (B16), verbatim from `docs/release-check-run-b16.txt`:

```text
found 0 vulnerabilities
```

## The shrinkwrap

The shrinkwrap (`npm-shrinkwrap.json`) has 123 packages, all with integrity hashes (counted again on 2026-11-14, B22). The first checks below were run against the lock file it replaced (`package-lock.json`, until B21; lockfile version 3, the same tree) on 2026-11-12, after the B16 override:

- **Pinned:** the 8 direct dependencies are exact versions (no `^` or `~`), and every one of the 123 packages has an integrity hash (counted with a short script, `docs/release-check-run-b16.txt`). The override added one package to the 122 of B15.
- **Install scripts:** one package is flagged `hasInstallScript`: `fsevents` 2.3.3, optional, dev-only and for macOS only, reached through `vitest` and `vite`. The production tree (`npm ls --omit=dev --all`: `commander`, `ts-morph`, `yaml` and their dependencies) has none. The CI workflow and the Action install with `--ignore-scripts`, so `fsevents`'s script never runs there. The installed `fsevents` `package.json` lists `clean`, `build`, `test` and `prepublishOnly` scripts and no `install`, `preinstall` or `postinstall`, and the package ships a prebuilt `fsevents.node` (checked 2026-11-12); why npm flags it was not investigated further. **Open maintainer decision:** is "no install scripts" satisfied by "none in the production tree", or must the dev tree have none too?

## SARIF validity

**Checked once against the official schema (B16, 2026-11-12), and not vendored.** The acceptance criterion says the output validates against the repo-kept SARIF 2.1.0 schema, and that wording stands. The official schema is in the OASIS `sarif-spec` repository under the OASIS IPR Policy (RF on RAND Terms Mode; read 2026-11-13, `docs/lookups-b16.txt`), which is not MIT, Apache-2.0 or BSD, and the project's Forbidden rule allows copying third-party files only under those, so it is not vendored (decided 2026-11-12). That follows the build plan's fallback (outside this repository) and is a recorded deviation from the acceptance criterion, not a pass against it. Instead, as a dated one-off check that is not part of `npm run verify`:

- the official JSON schema was downloaded read-only; its URL, size and SHA-256 are in `docs/release-check-run-b16.txt`. It declares JSON Schema draft-04, which plain `ajv` 8 does not load, so the check used `ajv-draft-04` with `ajv-formats`, installed with `--ignore-scripts` in a scratch folder outside the repository (none of them is a dependency of tripcurve);
- all 12 `test/golden/report-*.sarif.txt` files and the live SARIF of `demo/` and `demo-fixed/` validated; four deliberately broken copies of a golden (a missing `version`, an unknown top-level property, a result level outside the enum, a suppression kind outside the enum) were rejected, so the check can fail;
- the script and its real output are in `docs/release-check-run-b16.txt`.

`npm run verify` keeps using the hand-written validator for the subset tripcurve emits (`test/support/sarif-validate.ts`), so the day-to-day check does not depend on the downloaded schema. The one-off check should be repeated on the day of the maintainer's go, because the schema file is read from `main` of the `sarif-spec` repository. GitHub's code scanning read the demo's file on 2026-11-15 (run 43682221183: an analysis with 6 results and 7 rules, six alerts; `docs/evidence/gh-code-scanning.txt`); the goldens were not uploaded. (`docs/limits.md`, "SARIF validation"; `docs/ci-and-sarif.md`)

## The metric-5 dry run (2026-11-13)

A fresh session, given only the published docs, added a Node 25 entry, `node-idle-close-25x`, together with its script run, in a scratch copy. The entry is not merged and is not in the repository: odd-numbered Node lines have no entry by design. **Result: partial success.** The entry, the tests, the lane and `npm run verify` all worked; the tolerance is provisional only because the host never got quiet, so no quiet basis run existed.

The friction it found, all fixed in B16 in `docs/add-a-knowledge-base-entry.md` and in the tests:

- **The guide never said that odd-numbered Node lines have no entry**, so the session chose Node 25. Section 0 now states the policy and cites `docs/limits.md`.
- **Nothing said what to do on a host that stays busy**, how to name busy result files, or what the tolerance is while no quiet basis exists. Section 5 now has a "Busy host" paragraph. The rule: the entry may not be added until a quiet basis run exists, and `test/kb/tolerance-evidence.test.ts` fails a measured Node entry without basis observations and says so.
- **The test list in section 6 was a table that missed places and hard-coded values** (the entry id list, the entry counts, the notes date 2026-11-11, the tolerance counts in `docs.test.ts`, the entry totals). Those are now computed from the data, with a scratch copy showing the old tests failing on a new entry and the new tests failing only where a person must act. Section 6 is now a checklist.
- **The build and environment notes were missing** (`.cache/e2e-build`, where `node_modules` must resolve, how to list Node releases). Section 0 now has them.

The maintainer may want to re-run the dry run against the fixed guide.

## Compatibility across Node releases

`engines` is `>=22.12.0`. On 2026-11-12 (B16) the full test suite, the build and the demo were run with each of four official darwin-arm64 binaries first on `PATH` (the binaries are cached in `.cache/node/`), and the unsupported-Node message was checked on two older releases. Each row is one run of `node ./node_modules/vitest/vitest.mjs run`, then `npm run build`, then `node ../dist/cli/main.js .` inside `demo/`; "demo byte-equal" means the output is byte for byte `demo/expected/first-run.txt`, with exit code 1. Raw output: `docs/release-check-run-b16.txt`.

| Node | Test files | Tests passed | Build | Demo exit 1 and byte-equal | Date |
|---|---|---|---|---|---|
| 22.12.0 | 124 of 124 | 12,623 of 12,623 | exit 0 | yes | 2026-11-12 |
| 22.23.5 | 124 of 124 | 12,623 of 12,623 | exit 0 | yes | 2026-11-12 |
| 24.22.3 | 124 of 124 | 12,623 of 12,623 | exit 0 | yes | 2026-11-12 |
| 26.13.1 | 124 of 124 | 12,623 of 12,623 | exit 0 | yes | 2026-11-12 |

Node 24.22.3 failed two scaling tests on its first run (ratios 8.05 and 11.1 against a limit of 8). The work was linear; one 4x step straddled a one-off cost jump (a V8 string or heap step), and the same tests passed on the other three releases. The scaling helper now also measures the step below and keeps the lowest ratio, but only when the breach is below 16 (a one-off jump reads about 12, quadratic work 16 or more; the review of B16 found that work linear below a size and quadratic above it had slipped through, and eight simulated-clock tests now cover it), with a failing test first (`test/core/scaling-helper.test.ts`, a simulated clock); quadratic work still breaches. A later full run on Node 24.22.3 failed one test, in `test/scripts/timed-check.test.ts`: it compared the test process's own temporary folder before and after the run, and other test runs on the host (several were going) create `tripcurve-timed-test-*` folders there at any moment. That test was also unable to see what it claimed to check, because the script it runs has its own environment (`PATH` only), so its temporary folder is another one; a script that left its tree behind was not caught (shown with a mutant). The test now gives the script a private temporary folder and expects it to be empty afterwards; the mutant fails it and background churn in the shared folder does not. The table above is the full suite after both changes. (`docs/limits.md`, "Scaling tests on Node 24")

The unsupported-Node message, run on 2026-11-12 with the older binary first on `PATH`:

| Node | Output | Exit code |
|---|---|---|
| 20.20.2 | `tripcurve needs Node 22.12.0 or later; this is Node 20.20.2.` then `Nothing was checked.` | 2 |
| 18.20.8 | `tripcurve needs Node 22.12.0 or later; this is Node 18.20.8.` then `Nothing was checked.` | 2 |

**Linux: run once, on GitHub.** Every local run above is darwin-arm64. The suite ran on Linux for the first time on 2026-11-15, in the hosted verify run 43682221175 (Ubuntu with Node 22.12.0, 24 and 26), and every job succeeded; the source audit below was written before that run.

### Platform audit of `src/` (B16, 2026-11-12)

Read and searched for `process.platform`, `os` module use, Windows paths, `path.sep`, `realpath`, case handling, locale-dependent calls and directory-order assumptions:

- **No `process.platform`, `os` module, `darwin` or `win32` in `src/`.** Nothing branches on the host.
- **Directory order is not assumed.** The walk sorts entries by UTF-8 byte order (`compareBytes`), so the order is the same on macOS and on Linux. (`src/parse/intake/walk.ts`)
- **Logical paths are `/` paths.** The walk builds `rel` with `/`, and the link stage (`src/link/source-link.ts`, `src/link/gunicorn-config-link.ts`) uses `path.posix` for every path it takes from the files read. `sep` is used only in `isInside` and `toPosix`, where it converts a host path to a `/` path. A test fails if any file outside a two-file allow-list (`walk.ts` and `intake.ts`, each with its reason and its exact import line) imports a host `path` function, and a second one lists a directory with file names whose byte order and locale order differ and expects byte order.
- **File name matching is exact, on both hosts.** A name such as `Dockerfile` or `package.json` is matched as written; only `.yaml`, `.yml` and `.json` are matched in any case. macOS's default file system ignores case and Linux's does not, so a reference spelled with other capitals than the file name does not link on either host (the link table is a string map, not a file system lookup).
- **One finding, fixed.** `sortUnchecked` ordered the reason codes of two unchecked entries for the same file with `localeCompare`, which depends on the host's locale. It is now `compareBytes`, and a new test (`test/platform/portability.test.ts`) fails on any `localeCompare`, `toLocale*`, `Intl`, `process.platform`, `win32` or `os` module (in any import form) in `src/`, and on `process.env` outside `src/cli/main.ts` (which passes it on; only `NO_COLOR` is read). The test failed before the fix with that one line. No current pair of reason codes was found to sort differently under the usual locales, so the output did not change; the fix removes a dependency on the host.
- **Not covered by this audit:** `measure/` and the timed check are macOS-only by design (the measurements are darwin-arm64, and the timed check is skipped off the recorded machine). Symlink behaviour on Linux file systems and `realpath.native` were read, not run.

## Decided on 2026-11-12

The maintainer said on 2026-11-12 that small things are decided by the build session. Each decision below is recorded in the "Open questions for the maintainer" table, and no code behaviour was changed for any of them.

| Question (table #) | Decision |
|---|---|
| Widening the stated-reason rule: 9 entries (11) | **decided (2026-11-12): accept**, because these are documented AWS, Kubernetes and CloudFormation defaults that cannot run on localhost |
| Dangling or outside-root `.json` links are reported (26) | **decided (2026-11-12): keep**, because an input tripcurve reads is never silently ignored |
| lightship binds to `0.0.0.0` during its measurement (12) | **decided (2026-11-12): accept, and keep it documented**, because it is measurement-only, lasts a few seconds and uses a random port |
| Headline "longer than LB idle 60 s" against the design mockup (24) | **decided (2026-11-12): keep the code's wording**, which every golden uses (`demo/expected/first-run.txt`) |
| Narrow lane tolerances (13) | **decided (2026-11-12): accept**, because a busy run is already not an official run |
| `UNRESOLVED (file)` on a configuration-error stop (22) | **decided (2026-11-12): keep**, as the output contract requires |
| Doubled braces in SARIF messages (23) | **decided (2026-11-12): keep**, as SARIF 3.11.5 requires; how a viewer decodes them is unverified |
| SARIF `helpUri` (6) | **decided (2026-11-12): not in v0.1**, because it is optional in SARIF |
| Vendoring the SARIF schema (5) | **decided (2026-11-12): not vendored**, following the build plan's fallback (outside this repository), because the terms forbid copying it under this project's rule (OASIS IPR Policy, RF on RAND Terms Mode, not MIT, Apache-2.0 or BSD; read 2026-11-13, `docs/lookups-b16.txt`); the dated one-off validation of B16 is the v0.1 check; a recorded deviation from the acceptance criterion, not a pass against it |
| B1, B3, B4, B5 and B6 behaviour questions (14 to 21, 28 to 30) | **decided (2026-11-12): keep the current behaviour**, which is the conservative and honest one, already tested and documented |
| The "recommendation adopted, maintainer to confirm" decisions (32) | **decided (2026-11-12): adopted as recommended** |
| Rosetta 2 for the three old-Node entries (10) | **decided (2026-11-12): not installed**, because installing system software is not done; the entries stay DEFERRED and labelled unmeasured; this is a Should item |
| Reporting a vulnerability (9) | **decided (2026-11-12): once the repository is public, reports go through GitHub's private vulnerability reporting for the repository; until then there is no public channel**; written in `docs/security.md`, "Reporting a vulnerability" |
| The licence (1) | **left as the maintainer said**: decided by the maintainer before release; no LICENSE file |

**Not decidable here, so still open.** Each is an external write that waits for the maintainer's explicit go: publish to npm, reserve the name `tripcurve`, and enable the SARIF upload anywhere but this repository's own self-test (the hosted CI run and that self-test's upload were done on 2026-11-15, rows 12 to 14). The licence (1) also stays with the maintainer. Everything else in the maintainer-questions table is decided or done.

## Entries that must be named

**Deferred and not measured (3).** A release must never read these as measured. Each is `DEFERRED (B13)` in the lane and has the basis `from changelogs, not measured`:

| Entry | Applies to | Why unmeasured |
|---|---|---|
| `node-headers-trap-10x` | Node 10.x from 10.15.2 | no arm64 macOS build, no x64 runtime (Rosetta 2 absent, checked 2026-11-12) |
| `node-headers-trap-12x` | Node 12.x before 12.19.0 | the same |
| `node-headers-trap-13x` | Node 13.x before 13.13.0 | the same |

(`src/kb/data/node-idle-close.json`, `deferredTo`.) Bolt B13 attempted the measurement and measured nothing. Measuring them needs Rosetta 2 installed by the maintainer, or an x64 or arm64 Linux host.

**Documented only, with a stated reason instead of a script (9).** Values read from vendor documentation on the dates the entries carry; `NOT RUN` in the lane:

| Entry |
|---|
| `alb-idle-timeout-default` |
| `k8s-grace-period-default` |
| `terraform-lb-idle-timeout-default` |
| `terraform-sqs-visibility-default` |
| `terraform-lambda-timeout-default` |
| `lambda-sqs-batching-window-default` |
| `cfn-lb-idle-timeout-default` |
| `cfn-sqs-visibility-default` |
| `cfn-lambda-timeout-default` |

**Release blockers.** An entry with the basis `to be measured` is a release blocker and fails the lane. There are none today: the 48 entries are 36 measured, 9 documented and 3 from changelogs (counted from `src/kb/data/` on 2026-11-12).

## Reviews

Every bolt gets one independent read-only adversarial review, with a second pass when a fix changes what a check flags or what counts as pass. From `BUILD-NOTES.md`:

| Bolt | Review state | Last verdict |
|---|---|---|
| B0 | closed | review 2 (second pass): all findings fixed, no Critical or Major |
| B1 | closed | final confirmation pass: nothing Critical or Major; "B1 is done" |
| B2 | closed | final confirmation pass: no Critical or Major; merge recommended |
| B3 | closed | review 2: no Major findings; "B3 done" |
| B4 | closed | review 2: no Major findings; "B4 done" |
| B5 | closed | review 2: nothing at Major or above; "B5 done" |
| B6 | closed | review 2: nothing at Major or above; "B6 done" |
| B7 | closed | review pass 2: no Critical or Major issues |
| B8 | closed | review 3: MERGE |
| B9 | closed | review 2: MERGE |
| B10 | closed | review 2: MERGE |
| B11 | not used | the build plan skips the number 11 |
| B12 | closed | final check: MERGE |
| B13 | closed | review: MERGE; nothing was measured (status given by the main session, 2026-11-12) |
| B14 | closed | review 1: MERGE (`BUILD-NOTES.md`); the maintainer approved the four candidates on 2026-11-12 |
| B15 | closed | review 3: MERGE (`BUILD-NOTES.md`) |
| B16 | closed | review 2: MERGE after the deviation was recorded and the scaling remeasure bounded; the settle wait and the guide fixes were checked in the final pass (`BUILD-NOTES.md`) |
| B17 | closed | review 2: MERGE (`BUILD-NOTES.md`) |
| B18 | closed | review: MERGE (`BUILD-NOTES.md`) |
| B19 | closed | review: MERGE; the follow-ups were applied (`BUILD-NOTES.md`) |
| B20 | closed | review 2: MERGE (`BUILD-NOTES.md`) |
| B21 | closed | review 2: MERGE; the two minor items it left are B22's (`BUILD-NOTES.md`) |
| B22 | closed | review: MERGE (`BUILD-NOTES.md`, "B22") |
| B23 | closed | review 2: MERGE; review 1 fixed the lanes row and found the closed-pipe trace that became B24 (`BUILD-NOTES.md`, "B23") |
| B24 | closed | review: MERGE (`BUILD-NOTES.md`, "B24") |
| B25 | closed | review 2: FIX-FIRST items fixed before merge, the stale `limits.md` upload sentence among them (`BUILD-NOTES.md`, "B25") |

Minor findings carried, not fixed, each recorded in `BUILD-NOTES.md`: B10 (`--runs=3` and `--cli=x` with an `=` are silently ignored by the timed check, and cannot fake a pass), B12 (two clauses of `couldBeCfnFlow` overlap, so neither is pinned by its own test).

## Unverified items the docs disclose

None is hidden; each is stated where it matters:

- The "6 of 26" result is Node 22.23 and gunicorn with uvicorn on one laptop through toxiproxy, not an ALB; the ALB's real behaviour at the idle boundary is not measured. (`README.md`; `docs/research.md` section 12)
- The old-Node `headersTimeout` trap is from changelogs, not measured. (`docs/rules.md`)
- The `minimatch` override was checked by one call and by the test suite, not on every `ts-morph` code path. (above, "npm audit")
- Linux values are inferred, not measured; every measurement is darwin-arm64. (`docs/how-defaults-were-measured.md`)
- Locally nothing was run on Linux: the source audit of B16 found no host-dependent code, but that is reading, not running; the hosted Linux run of 2026-11-15 (run 43682221175) is the first running. (above, "Platform audit of `src/`")
- The GitHub Action, the hosted workflow and the SARIF upload ran once, on 2026-11-15, and every job succeeded (runs 43682221175 and 43682221183); they were not tried on a pull request, from a fork or in a private repository, and runner details beyond the self-test's assertions are unverified. (`docs/action.md`; `docs/ci-and-sarif.md`)
- Whether GitHub's viewer decodes the doubled braces `{{` in SARIF messages back to `{` has not been checked. (`docs/ci-and-sarif.md`)
- The official SARIF schema was applied once, on 2026-11-12, to the goldens and the demo output, not to a real upload. (above, "SARIF validity")
- The release-quality dry run (metric 5) was run once, on 2026-11-13, against the guide before its B16 fixes; it has not been re-run against the fixed guide. (row 10)
- The latest lane was last run (in B8) before the three CloudFormation default entries existed; the B15 pinned run includes them. (`docs/how-defaults-were-measured.md`)

## Open questions for the maintainer

Collected from `BUILD-NOTES.md` and the decision register, each with the bolt it came from. None blocks the build; the first group blocks the release.

| # | Question | Bolt | State |
|---|---|---|---|
| 1 | The licence for tripcurve: decided by the maintainer before release | B15 (all) | **open**: decided by the maintainer before release |
| 2 | The go: publish to npm and publish the Action; reserve the name `tripcurve`, still free on 2026-11-12 | B15 | **open**: external write, waits for the maintainer's explicit go |
| 3 | `npm audit`: 3 moderate findings (`minimatch` through `ts-morph`). Accept with a reason, force an override, downgrade `ts-morph`, or replace it | B1 | **closed for the checkout (B16)**: the override; reopened for the packed tarball by B21, see row 5b: the audit is NOT clean for a fresh install of it |
| 4 | "No install scripts": is a dev-only optional package (`fsevents`) with an install script acceptable when the production tree has none? | B1 | **decided (2026-11-13)**: accept. `fsevents` is an optional, dev-only macOS dependency of the test tooling; it is not in the production tree (0 install scripts there), and every install here runs with `--ignore-scripts` |
| 5 | SARIF: vendor the official schema (OASIS IPR terms), or keep the subset validator | B6, B7 | **decided (2026-11-12)**: not vendored (build-plan fallback, licence not MIT, Apache-2.0 or BSD); the B16 one-off validation is the v0.1 check; a recorded deviation from |
| 6 | SARIF `helpUri` per rule, once a public location exists | B7 | **decided (2026-11-12)**: not in v0.1; optional in SARIF |
| 7 | The Action's name and ref (`<owner>/tripcurve@<sha>`) and when to enable the upload step elsewhere; the first hosted run and the `exit-code` output after a failed check step were checked on 2026-11-15 (run 43682221183; no job fails the build step, so that case is still untested) | B9 | **open**: the name and ref and the upload elsewhere are external writes that wait for the maintainer's go; the hosted run is done |
| 8 | The metric-5 dry run: run it, and review the result | B15 | **done (2026-11-13)**: partial success; the friction it found is fixed in B16 (see "The metric-5 dry run" above); the maintainer may re-run it against the fixed guide |
| 9 | A channel for reporting a vulnerability, decided at release (none exists without a remote) | B15 | **decided (2026-11-12)**: GitHub private vulnerability reporting once the repository is public; no public channel until then |
| 10 | The three old-Node trap entries: install Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`), provide an x64 or arm64 Linux host, or release with them deferred and unmeasured. The v0.1.0 definition asks for a script on every entry | B13 | **decided (2026-11-12)**: Rosetta 2 is not installed; the entries stay DEFERRED and labelled unmeasured (a Should item) |
| 11 | Widening the stated-reason rule: seven documented AWS, Terraform and CloudFormation entries carry a stated reason beyond the letter of the decision (which names the ALB idle and Kubernetes grace entries) | B5, B8, B12 | **decided (2026-11-12)**: accept; documented defaults that cannot run on localhost |
| 12 | Lightship 9.1.0 binds its status server to `0.0.0.0` (no host option), which departs from the "localhost only" contract: accept it, or drop the lightship entry from the lanes | B8 | **decided (2026-11-12)**: accept and keep it documented; measurement-only, a few seconds, a random port |
| 13 | The lane tolerances are narrow on purpose; a run on a busy machine can fail and is "not an official run". Accept, or widen with a basis | B8 | **decided (2026-11-12)**: accept; a busy run is already not official |
| 14 | `engines` narrows a floating tag such as `node:lts` to one range, which can then give PASS. Keep (the recorded rule), or keep floating tags VERSION-DEPENDENT even when `engines` is set | B3 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 15 | Should a declared `drain.in_process_s` settle a preStop hook of unknown duration? The interaction spec's recovery table says yes; say UNRESOLVED (the literal reading is kept) | B4 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 16 | Lock files over 5 MB (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) appear under "Files not checked", which makes runs in large monorepos incomplete | B4 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 17 | A mapping whose event source is a stream (Kinesis, DynamoDB) is UNRESOLVED, not N/A, so a run cannot exit 0 on a source tripcurve does not follow. Should a positively identified non-SQS stream be N/A? | B5 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 18 | `--explain` with an unknown rule prints a fixed message; the design mockup quotes the rule. Keep, or echo it through SafeText | B6 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 19 | An inline waiver attaches to the enclosing block, not to "the source line or the next line": a Terraform comment in a queue or function block does not attach to the mapping's T4. Keep? | B6 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 20 | Two waivers that cover one finding are both invalid. Keep? | B6 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 21 | The closing line wraps greedily at 80 columns, which can leave a lone `0` at the end of a line | B6 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 22 | On a configuration-error stop the human report labels the unreadable config file `UNRESOLVED (file)` while every count stays 0 | B7 | **decided (2026-11-12)**: keep, as the output contract requires |
| 23 | The `{{` and `}}` doubling of braces in SARIF messages (SARIF 3.11.5): untested on GitHub's viewer | B7 | **decided (2026-11-12)**: keep, as SARIF 3.11.5 requires; viewer decoding unverified |
| 24 | The `web` T1 headline reads `idle close 75 s is longer than LB idle 60 s`, not the design mockup's `... than 60 s`. Keep (about 20 goldens would change; `demo/expected/after-fix.txt`) | B10 | **decided (2026-11-12)**: keep the code's wording, which every golden uses |
| 25 | `measuredOn.date` of `node-idle-close-22x`, `-24x` and `-26x` is 2026-11-11 although lower releases in their ranges were measured on 2026-11-12: one date field cannot say both | B10 | **decided (2026-11-13)**: keep. Each `measuredOn` names one release and the date that release was measured (B0, 2026-11-11); the lower releases and their dates are in the result files |
| 26 | A dangling or outside-root `.json` symlink is reported as unchecked (as YAML already is): confirm | B12 | **decided (2026-11-12)**: keep; an input tripcurve reads is never silently ignored |
| 27 | A CloudFormation load balancer is not linked to an Ingress for T1, because the configuration contract has no form for it. Add one? | B12 | **decided (2026-11-13)**: not in v0.1; the configuration contract has no form for it, and an unlinked CloudFormation load balancer never supports a result |
| 28 | The requirements say declared numbers are "at most a documented maximum", but no maximum is documented, so none is applied | B1 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 29 | Standard-input line numbers count across the whole stream, not per document | B1 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 30 | A padded `load-balancer-attributes` value stays UNRESOLVED until a dated lookup shows the controller trims spaces | B1 | **decided (2026-11-12)**: keep the current behaviour (conservative, tested, documented) |
| 31 | The B14 candidate list | B14 | **decided (2026-11-12)**: the maintainer approved the four recommended MIT repositories |
| B17.1 | The fixes the real-repository check found, **decided (2026-11-12)**: the maintainer delegated them. A Terraform reference links within its own folder (this widens the earlier rule "the same file"); integer arithmetic on literals is evaluated exactly; T4 is a FAIL when visibility is below 6 x the function timeout even when the batching window is not set; a `--config` path outside the checked folder is printed as typed; the hint for an unidentified program is neutral. Each follows the tool's own documented semantics (`docs/lookups-b17.txt`). The `express` allow-list item found by B14 was not part of this bolt | B17 | **decided (2026-11-12)** |
| 32 | Decisions still "recommendation adopted, maintainer to confirm": the by-name load balancer link is an assumption and never PASS; how source ties to a workload; derived limits; the command name `npm run verify`; the Action builds from its own checkout; a hand-written seeded generator; an unmatched waiver makes a run unclean; waivers have no `until` cap | B1 to B9 | **decided (2026-11-12)**: adopted as recommended |
| 33 | The public repository: where the source will live | B20 | **decided (2026-11-14)**: https://github.com/naren-ambati/TripCurve, the source goes there only on the maintainer's go, and tripcurve stays unpublished to npm |

(Source: `BUILD-NOTES.md`.)

## Stale or conflicting text found while writing the docs

Reported, not changed (the source files are other bolts' records):

- `docs/research.md` section 3 says a terminus `beforeShutdown` of unresolved duration passes T2. The shipped rule gives UNRESOLVED (a maintainer decision, `docs/limits.md`, "Rules T2 and T3"). `docs/rules.md` follows the rule and says so.
- `docs/research.md` section 10 predicts the demo's output (four failures and one deliberate pass). The real output differs in seven ways, each decided in B10 (`BUILD-NOTES.md`); the README and `demo/README.md` follow the real output.
- `measure/README-lanes.md` still says six entries carry a stated reason; there are nine (`docs/limits.md`, "The measurement lanes", is current).
- `docs/research.md` section 8 names `@cdktf/hcl2json` for Terraform; the build reads Terraform with its own bounded reader and no HCL dependency (the maintainer's decision, feasibility).
