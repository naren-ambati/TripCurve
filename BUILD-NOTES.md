# Build notes

A running log of the build, bolt by bolt: what was built, what was measured, what each independent review found and how it was fixed. A bolt is one build step: B7 is build step 7 (the numbers are not in the order they were built). Within one review, findings are labelled C (Critical), M (Major) and m (Minor) with a number, so "M2" in one section is not "M2" in another. The design documents (requirements, user stories, the report mockups, the interaction spec and the build plan) were written before the code and are kept outside this repository; where this file cites one, the rule it set is restated here.

## Ground rules for the build (2026-11-11)

- The maintainer said go on building on 2026-11-11, after approving the build plan.
- **Source of truth.** The design documents written before the build (requirements, stories, mockups, the interaction spec, units, contracts and the build plan) win. A set of per-unit designs written earlier was not taken through the same review; where it disagrees with them, the design documents win.
- **Each bolt:**
  - a local worktree branch under `.worktrees/` (git-ignored);
  - tests and expected output first;
  - the verify command;
  - an independent Sonnet adversarial review, with honesty rules first;
  - a failing test before every fix;
  - a squash-merge into `main`.
  - Nothing is pushed.
- **Verify command (assumption).** It is `npm run verify`, the candidate, from B1 on, when `package.json` exists. B0 has no package; its check is `node measure/selftest.mjs`.

## B0 Day-1 measurement (2026-11-11)

- **Installed** into `.cache/` (git-ignored):
  - Node 22.23.5, 24.22.3 and 26.13.1, from official tarballs with checksums verified;
  - uv virtualenvs with gunicorn 26.2.0 or 27.0.0, plus uvicorn 0.54.0 and uvicorn-worker 0.4.0.
  - the official Node 22.23.2 tarball too, so every Node measured comes from one checked source (the Homebrew 22.23.2 was used only in the first, discarded run).
- **Lookups 2026-11-11 19:12Z and 19:34Z** (raw output in `measure/results/2026-11-11-lookups.txt`):
  - newest Node lines: 22.23.5, 24.22.3 and 26.13.1;
  - gunicorn 27.0.0, released 2026-11-10, a new major;
  - uvicorn 0.54.0 and uvicorn-worker 0.4.0, unchanged.
- **Results** (3 runs each, final scripts):
  - Node default idle close is 6.0 s on all of 22.23.2, 22.23.5, 24.22.3 and 26.13.1;
  - gunicorn with the uvicorn worker is 2.0 s on 26.2.0 and on 27.0.0;
  - uvicorn alone is 5.0 s.
  - Every research default still holds. Node 24 and 26 and gunicorn 27 are newly measured. The table is in `measure/README.md`, and the dated summary is in `docs/research.md` section 13.
- **Method** differs from the research's 502 reproduction: it times the FIN directly, with no sweep and no proxy, so the resolution is 1 ms with 0 injected latency. In practice every value was 1 to 3 ms above nominal and none below. B1's `toleranceMs` must cover that spread, not just the 1 ms minimum.
- **Review 1** (independent, Sonnet) found 3 Major and 4 Minor. All are fixed, with failing tests first:
  - **Major: environment overrides.** `GUNICORN_CMD_ARGS`, `UVICORN_*` or a stray `gunicorn.conf.py` changed the "default" and still exited 0 (reproduced: 7001 and 9003 ms). Fix: a clean environment, an explicit empty gunicorn config, a `server: uvicorn` check, and Node refusing a set `NODE_OPTIONS`.
  - **Major: bad replies became numbers.** A `Connection: close` reply, HTTP/1.0, a 404 or a 500 was reported as an idle close. Fix: the measurer accepts only an HTTP/1.1 200 keep-alive reply with a length; anything else is an error and exit 4.
  - **Major: the self-test could not fail** for timing from the request, an error turned into a number, and similar mutations. Fix: 12 cases, 15 ms slack, and 8 mutations checked, all caught.
  - **Minor:**
    - orphaned servers on a crash or an interrupt (fix: version first, kill the process group, wait for exit);
    - the runner mixed failure lines into the results and always exited 0;
    - the system Node was used for 22.23.2 (now the official tarball);
    - unsupported claims (24/26 split not measured, lookups now saved raw, darwin only, plain uvicorn install).
- **Found while fixing.** An interrupt during the measurement killed the server. That close was then printed as a measured idle close with exit 0 (982 and 2647 ms). `measure/script-test.mjs` reproduced it before the fix, and it passes after. The cause was removing all exit listeners, which dropped the stop's own wait.
- **Not done here** (later bolts): an explicit `keepAliveTimeout` (B3), gunicorn precedence (B2), and old Node (B13).
- **Review 2** (second pass, because the fixes changed what counts as measured): all 7 findings confirmed fixed, no Critical or Major. Five Minor points were fixed:
  - the measurer now rejects ambiguous lengths and bytes after the body, with failing cases first;
  - a lower-case `content-length` case was added;
  - the README states the 15 ms slack honestly;
  - a SIGKILL of the script leaves the server running, and the README now says so;
  - stale notes were corrected.

## B1 Thin slice (started 2026-11-11)

- **Step 0 decisions** (lookups 2026-11-11):
  - **Pins:** commander 15.1.0, yaml 2.9.1, ts-morph 28.0.0, typescript 7.0.2, vitest and @vitest/coverage-v8 5.1.0, @biomejs/biome 2.6.6, @types/node 22.20.5. None has an install script, and all support Node 22.12 or later.
  - **Controller string:** the IngressClass controller is `ingress.k8s.aws/alb`, and the legacy annotation `alb` is still supported (from the AWS LB Controller guide).
  - **ALB default:** `idle_timeout.timeout_seconds` is 60 s (from the AWS ALB guide).
- **Limits,** recorded in `docs/limits.md`:
  - 5,000,000 bytes per file, from the maintainer-confirmed envelope;
  - YAML aliases capped at 100, the yaml 2.9.1 default, passed explicitly;
  - a file nested deeply enough to overflow the stack is caught and reported unchecked ("too deeply nested");
  - no limit on total files or bytes, because nothing gives a basis for a number.
- **Seed entries:**
  - **Node 22.x:** from 22.19.0, where the buffer landed (research section 2 and the Node 22 docs).
  - **Node 24.x and 26.x:** start at the measured version (24.22.3 and 26.13.1), so anything older is UNRESOLVED. The Node 24 docs say the buffer was "Added in: v24.6.0" (read 2026-11-11). Measuring an older 24.x would let the maintainer widen the range.
  - **Tolerance:** 4 ms, the largest B0 deviation (3 ms) plus the 1 ms resolution.
- **Area 1 (scaffold, core, knowledge base):** 157 tests and 98.5% line coverage; `npm run verify` is green. One mishap: `biome check --write .` reformatted 5 Markdown files, which were restored byte for byte from HEAD. Biome is now scoped to code.
- **Open items for the release checks** (none blocks the build):
  - `npm audit` reports 3 moderate findings, all `minimatch` (GHSA-g3hv-75wg-m249), reached through ts-morph 28.0.0. The suggested fix is a downgrade to ts-morph 17, which was not taken. The maintainer decides before release.
  - The lockfile lists `fsevents`, a vite optional, with `hasInstallScript`. `--ignore-scripts` skips it, but the "no install scripts" check needs a decision.
  - `.github/workflows/verify.yml` uses the mutable tags `actions/checkout@v4` and `actions/setup-node@v4`. They need a dated lookup and SHA pinning before the file ever runs.
- **Area 2 (intake, config and Kubernetes readers):** 293 tests and 97.3% line coverage. In a hand mutation check, 20 of 22 mutations were caught; the two survivors led to new tests.
  - **Secrets:** a Secret keeps only its kind, name and namespace, in the syntax tree and in the value. A merge key carried Secret data through in a fixture, so the scrub covers that path too.
  - **One door for raw text:** parsers get raw text only through `rawTextForParser` in `src/parse/intake/`.
  - **Over-size files:** a YAML file over 5 MB is reported, not ignored.
  - **Deep nesting:** the yaml parser itself reports `RESOURCE_EXHAUSTION`, which maps to "too deeply nested". The depth where this happens depends on the stack (600 levels parsed, 1000 refused on this machine). This is a mild tension with determinism for files near the edge, and is recorded in `docs/limits.md`.
  - **ALB recognition:** follows the recorded option A literally. An Ingress that is not ALB is recorded as not checked.
  - **Unresolved values:**
    - a malformed or padded `load-balancer-attributes` value is unresolved. Whether the controller trims spaces is not looked up yet.
    - a preStop is read only in the three forms; anything else has an unresolved duration.
  - **Config:** the whole schema is read. A path that is absolute or contains `..` becomes a link the linker refuses, not a configuration error.
  - Ad hoc timing: 1,000 Deployment files took 1.1 s through intake and the Kubernetes read. This is not the measurement.
  - **Open for the maintainer** (none blocks the build):
    - the requirements say declared numbers are "at most a documented maximum", but no maximum is documented, so none is applied;
    - stdin line numbers count across the whole stream, not per document;
    - padded attribute lists stay unresolved until a dated lookup says the controller trims them.
- **Area 3 (Node readers):** 335 tests and 97.4% line coverage.
  - **Source reader:** it reads `keepAliveTimeout`, `headersTimeout` and `requestTimeout` with ts-morph and never runs the code. It follows local imports itself.
  - **Default evidence:** "no setting found" counts as evidence for the default only when `searchComplete` is true: a construction site was found, every file was read, and every local import was followed.
  - **Unresolved values:**
    - several different writes of one setting;
    - non-literal values, spreads and compound assignments.
  - **Assumptions,** recorded in `docs/limits.md`:
    - a sole identifier passed to `createServer(app)` is taken to be the request handler;
    - any receiver of `x.keepAliveTimeout = ...` counts, since there is no type information to check it is a server.
  - **Node version:** only `X.Y` and `X.Y.Z` tags of the official image give a version. `node:22`, `lts`, variant suffixes and digest-only references give an unknown version. A tag with a digest is read by its tag.
  - **Dockerfile:** the version comes from the last stage's `FROM`.
- **Area 4 (link, resolve and rule T1):** 533 tests and 96.3% line coverage. The demo `web` T1 FAIL carries the exact chain:
  - idle close 6 s, with its default citation;
  - `Node 22.23`, from the image at `k8s/web.yaml:17`;
  - `source`: no setting found in 1 file read;
  - LB idle 60 s at `k8s/ingress.yaml:9`.
- **Choices made:**
  - **Explicit `keepAliveTimeout` in source.** It is UNRESOLVED until B3 measures whether the 1 s buffer is added. Even a clear FAIL like 1000 ms against 60 s is UNRESOLVED for now, because a FAIL from a guessed effect is not established. B3 can revisit this.
  - **Assumed LB default.** It is UNRESOLVED, printed with the assumed 60 s and what it would mean, and listed in Assumptions. A FAIL whose chain holds an unverified value is also turned into UNRESOLVED.
  - **Container match.** The container is matched by port only. A container with no declared ports is not assumed, because mesh sidecars can be injected. Real repositories without `ports:` will show UNRESOLVED; B14 will show how often.
  - **Declared `source:`.** If it fails, it does not fall through to the container command. Absolute command paths are refused as paths inside the container.
  - **npm script route.** It uses the `package.json` nearest the manifest, and adds an Assumption that the container's working directory is not read.
  - **Node version evidence.** The first Node evidence source decides. If it gives no exact version the result is UNRESOLVED, and no weaker source is tried.
  - **More than one load balancer.** A workload behind two LBs is UNRESOLVED.
  - **NLB.** An NLB gives `no measured evidence for NLBs`.
  - **VERSION-DEPENDENT.** It is implemented, and tested with custom KBs.
- **Test hygiene (main session).** Eight tests asserted wall-clock budgets: 4.5 s, 4 s, 2 s and 1 s. One failed under coverage load. These were picked numbers that depend on the machine.
  - Replaced by `test/support/scaling.ts`: time at n and 2n (fastest of 3 runs), and the ratio must be below 3. Linear work roughly doubles; quadratic roughly quadruples.
  - The helper has its own test, proving it tells linear from quadratic.
  - The "does not hang" tests (alias bomb, FIFO, symlink loop, deep nesting) keep only their behavioural assertions; a hang hits vitest's test timeout.
- **Area 5 (human report, summary, CLI and golden):** 691 tests and 96.2% line coverage; `npm run build` is clean, and the KB JSON reaches `dist/`.
  - **Golden test.** `test/golden/web-t1.txt` was written before the renderer. It is the `web` T1 block only, because B1 has no T2 to T4. The header says `4 files read`, with exit 1. Each reading of the spec is noted in `test/golden/README.md`.
  - **Honesty property.** 2000 seeded cases: no green line and no exit 0 whenever anything is unresolved, unchecked, errored or empty, with `clean == (exit == 0)` throughout.
  - **Hostile output.** 500 seeded cases: ASCII only, 80 columns at most, and no line starts with a quote.
- **Speed record (B1 definition of done).** Apple M5, 10 cores, 32 GB, Node 22.23.2, `node dist/cli/main.js .`, 3 runs each:
  - demo fixture (4 files): 380, 379 and 375 ms. Target: under 2 s.
  - generated 1,000-file tree (about 9.3 MB, every file under 5 MB): 10,374, 10,405 and 9,954 ms. Target: under 30 s.
  - About 9.4 s of that comes from two 2.8 MB YAML files, each one map of 30,000 keys. The yaml library's duplicate-key check (`uniqueKeys`) is quadratic in the number of keys in one map. Without those two files, the remaining 998 files take 685 to 764 ms. This is handed to the B1 review as a hostile-input concern.
- **Review 1** (independent, Sonnet) returned 6 Major, 8 Minor and no Critical. Honesty was mostly sound: no PASS was reachable from an assumed LB default, a duplicate, a missing KB entry, a partial tag or an explicit `keepAliveTimeout`. But four file shapes that look normal gave a wrong PASS:
  - **M1.** A YAML map with many keys freezes the tool: the yaml duplicate-key check is quadratic (60,000 keys took 25.7 s; about 500,000 would take minutes or more, still under 5 MB).
  - **M2.** Code that runs before or beside the entry file is not read: `--require`/`--import` preloads, `NODE_OPTIONS`, `prestart`, dynamic `require`/`import`, non-local packages, and frameworks such as Fastify, where any `.listen` call counted as the construction site.
  - **M3.** The source path is resolved against the checked root, ignoring `workingDir` and the manifest's folder, so a decoy file can be read.
  - **M4.** A Kubernetes object the reader cannot identify (an unquoted Helm `{{ }}` name) vanishes silently, and a raw yaml warning reaches stderr.
  - **M5.** An ALB IngressGroup (`group.name`) is not understood. One shared ALB can carry a different idle timeout.
  - **M6.** An explicit non-ALB class plus ALB annotations is read as an ALB.
  - **Minor:**
    - tag plus digest is read by the tag;
    - an ALB idle of 0 is accepted;
    - the Ingress backend port is not checked against the Service;
    - `.YAML` in upper case is ignored;
    - the equal case of the VERSION-DEPENDENT comparison is untested;
    - nonexistent versions such as `node:22.99.9` fall inside the KB ranges (a known limit; the citation already says "measured on 22.23.2");
    - a declared `runtime.node` outranks the tag silently (intended);
    - the deep-nesting limit depends on the stack (known).
- **Lookups 2026-11-11:**
  - ALB idle "valid range is 1 to 4000 seconds" (AWS ALB attributes guide).
  - `load-balancer-attributes` has Exclusive merge in an IngressGroup: conflicting values make the controller fail for the entire group (AWS LB Controller annotations guide).
  - The attribute format is comma-separated `key=value`; the guide says nothing about spaces, so padded lists stay unresolved.
- **Fix plan:** test first, in two passes: the readers (M1, digest, range, case), then linking and resolving (M2, port, tests). A second review pass follows, because the fixes change what is flagged.
- **Fix pass 1 (readers), commit 0f82c3a.** Every fix has a regression test that failed first.
  - **M1:** duplicate keys are found with a Set per map; about 500,000 keys in 4.9 MB now take 3.5 s.
  - **M4:** an unidentifiable object makes its file unchecked ("a Kubernetes object could not be identified"), and yaml warnings are silenced.
  - **M6:** an explicit non-ALB class plus ALB annotations gives UNRESOLVED.
  - **Minor:**
    - tag@digest gives an unknown version;
    - an ALB idle outside 1 to 4000 s is unresolved (a declared value too, as UNRESOLVED, not the config-error case error);
    - YAML extensions are matched case-insensitively.
- **Fix pass 2 (link and resolve), commit ead2afb.**
  - **M2.** Any of the following makes the source search incomplete, so the result is UNRESOLVED:
    - preload flags whose file is not literal and local (local preloads are read);
    - `NODE_OPTIONS` from `valueFrom`;
    - any `envFrom`;
    - a dynamic `require`/`import()`;
    - the server passed to a non-local, non-built-in function;
    - a construction site not traced to `http`/`https` `createServer` or Express.

    A `prestart` script is not a gap: it runs in another process.
  - **M3.** A container `workingDir` gives UNRESOLVED. Otherwise the command's file is searched from the manifest's folder up to the root: one match is used, with the assumption "The container's working directory is taken to be ..." listed; several matches give UNRESOLVED.
  - **M5.** A shared ALB (`group.name`, or a repeated `load-balancer-name`) gives UNRESOLVED unless a `load_balancer` declaration states the idle value.
  - **m5.** A backend port that is not a Service port gives UNRESOLVED.
  - **m7.** Two surviving mutations are now killed.
  - **Golden.** It gained one Assumptions line, for the working directory (every assumption actually used is listed). The workload block and the summary are unchanged.
- **Cost for real repositories (for the maintainer).** These are honest, and they will show as UNRESOLVED on many real repositories:
  - any `envFrom`, the largest cost (it could inject `NODE_OPTIONS`);
  - `--require dotenv/config` or `tsx`;
  - `workingDir`;
  - monorepos with the same relative file in several packages;
  - shared ALBs;
  - Fastify, Koa and Hapi;
  - servers built through a helper function.

  `tripcurve.yaml` `source:` and `load_balancer` declarations are the escape hatches. B14 (real repositories) will show the size of the cost.
- **Review 2** (second pass): all 14 original findings are fixed or knowingly kept. m2 (nonexistent versions) and m4 (a declared version outranks the tag) are documented as known limits. No new wrong PASS was opened by the fixes, and 13 of 14 mutations of the new guards were killed. Remaining gaps in the same area:
  - **N1 (Major):** `--env-file` can supply `NODE_OPTIONS` from an unread file.
  - **N2 (Major):** an npm `pre<script>` hook runs unread code. This corrects the earlier note that `prestart` is not a gap: a pre-script can generate files the server then loads.
  - **N3:** setters that are neither read nor flagged (`Object.assign` with a variable, `Reflect.set`, `defineProperty`, computed keys, `eval`).
  - **N4:** quoted or short-form `NODE_OPTIONS` flags.
  - **N5:** the legacy class annotation conflicting with `ingressClassName`.
  - **N6:** path matching is case-insensitive on macOS, so it is not deterministic across machines.
  - **N7:** stderr silence is untested.

  Fix pass 3 is under way, test first.
- **Fix pass 3, commit e71cbbe.** 844 tests; golden unchanged. 30 of 38 new tests failed before the fixes.
  - **N1:** `--env-file` is always a gap. A Node docs lookup (2026-11-11) confirms that an env file's `NODE_OPTIONS` "are parsed and applied". Intake does not read `.env` files.
  - **N2:** an npm `pre<script>` for the script being run is a gap; `post<script>` is not.
  - **N3:** `Object.assign` with a non-literal source, `Reflect.set` and `defineProperty` are gaps, and so are `eval` and `new Function` anywhere in a read file. A computed write is a gap only on a receiver traced to the server, because otherwise every array write would count.
  - **N4:** `NODE_OPTIONS` names are matched with dashes stripped and `_` read as `-`, as the docs describe. A quote or backslash is a gap, and so is an unknown option starting with `r`. How Node parses quotes could not be looked up.
  - **N5:** two different class signals on one Ingress give UNRESOLVED.
  - **N6:** command paths are compared case-exactly, and a trailing slash is rejected.
  - **N7:** a CLI test checks that stderr stays silent, and kills the `logLevel` mutation.
- **New cost**, now UNRESOLVED:
  - `npm start` with a `prestart`, which is common;
  - `--env-file`;
  - source that contains `eval`;
  - code that calls `Object.assign(config, opts)`.

  A narrow third review pass is checking whether any of these guards is broader than honesty needs.
- **Review 3** (narrow third pass on e71cbbe): N1 to N6 are fixed for every form Node itself accepts. No plausible route to a wrong PASS was found. Left over:
  - alias spellings of the setter guards (N3a);
  - the stderr test claim (N7);
  - two guards broader than honesty needs (`Object.assign` on a local config object, and the `NODE_OPTIONS` `r` rule).
- **Fix pass 4:**
  - **N3a:** any reference in a read file to `eval`, `Function` or `Reflect`, to `defineProperty`, `defineProperties` or `setPrototypeOf`, to `vm`, a `.constructor(...)` call, or a timer given a string is a gap.
  - **`Object.assign`:** narrowed, so a local `const` object literal target is not a gap.
  - **`NODE_OPTIONS`:** an exact list of code-loading options replaces the `r`-prefix rule, which now lets `--report-on-signal` PASS.
  - **N7:** confirmed that `logLevel` is the real silencer; the test header was corrected.
  - **Node experiment** (2026-11-11, Node 22.23.2, 22.23.5, 24.22.3 and 26.13.1, recorded in `docs/limits.md`): `NODE_OPTIONS` loads code only through `-r`, `--require`, `--import` and `--loader`/`--experimental-loader` (underscore form too), and double quotes are parsed. Node refuses `--env-file` and the eval options inside `NODE_OPTIONS`.
  - **New cost:** any read file mentioning `Reflect` (for example `reflect-metadata` or NestJS) or a `Function` type is UNRESOLVED.
- **Main-session probe after pass 4** found two more wrong PASS routes: a local `const opts = {}` that is mutated through `Object.assign(opts, extra)` or a computed key write, then passed to `createServer(opts)`. The cost-1 narrowing had exempted it. A fix is under way: any object that flows into the server's settings is guarded like the server itself.
- **Options-object fix.** The `createServer` options object and its aliases are guarded exactly like the server: `Object.assign` targets, computed writes, and passing it to a non-local function are gaps, including a mutation made after the call. Six red tests failed first, then passed. Cost: an identifier passed as `createServer`'s first argument is treated as the options object even when it is really the handler.
- **Scaling checks made steady.** They now time n against 4n, take the fastest of 5 runs, grow n until the small run takes at least 20 ms, and use a limit of 8 (linear is about 4, quadratic about 16). The old 2x step with a limit of 3 failed linear work at 3.07 to 3.35 under parallel test load. Three verify runs in a row passed (895 tests, about 30 s each). The freeze test still fails when the quadratic YAML key check is put back.
- **Final narrow review** (on 19ef51b): one Major remained, J1: options built by a function (`createServer(mk(), h)`) gave PASS. There were also Minor variants (J2, J3, a `.constructor` alias) and a flaky helper test. After five rounds of patching one escape shape at a time, the approach changed (fix pass 6):
  - **The allow-list.** "No setting found" stands for the Node default only when every `createServer` call has one of the forms below; anything else is UNRESOLVED, "the createServer arguments are not in a form tripcurve reads":
    - no argument;
    - a handler: a function literal, a single local `const` or `function` binding, or something traced to `express()`, including the usual local export forms;
    - an in-place literal options object;
    - a `const` options literal referenced nowhere else.
  - **The `.constructor` alias:** any `constructor` access not on `this` is a gap.
  - **The helper test** takes the lowest of three ratios for its linear case; it passed 10 times out of 10.
  - **Results:** 935 tests, three verify runs green, golden unchanged.
  - **Cost:** a handler imported from a local file that is not Express, Koa's `app.callback()`, Next's `handle`, handlers built by a call or imported from a package, and a logged or exported options object are now UNRESOLVED. `tripcurve.yaml` declarations settle them.
- **Confirmation pass** (on 327900d): nothing Critical or Major, and every J1 to J3 and `.constructor` reproduction is fixed. The allow-list held against shadowing, hoisting, `.call`/`.apply`, aliases, second servers and fake Express re-exports. All 4 mutations of the allow-list were killed. Two Minor items, both fixed:
  - **K1:** a `let`, `var` or reassigned `function` handler could be reassigned to an options object and still give PASS. A handler name must now be a `const` or a `function` declaration and never written to anywhere in the file. Six red tests failed first, and a mutation check showed the guard is needed.
  - **K2:** the scaling tests were still occasionally flaky. A breach is now measured once more, keeping the lower ratio: noise only adds time, and real quadratic work breaches both times. Verify passed 4 of 4 runs (944 tests).
  - `coverage/` is git-ignored.
- **B1 is done.** It had one review, five follow-up passes and seven fix passes. Every finding was fixed with a failing test first.

## B2 Python servers and the worker model (started 2026-11-11)

- **Measurements** (commit f728b70; gunicorn 26.2.0 and 27.0.0, darwin-arm64, 3 runs each):
  - `--threads 2` and `GUNICORN_CMD_ARGS='--threads 4'` both run gthread with a 2.0 s idle close;
  - the sync worker sends `Connection: close` and closes at 0 ms;
  - `keepalive` precedence is command line > `GUNICORN_CMD_ARGS` > config file, where the config file is the `-c` file, or `./gunicorn.conf.py` only when there is no `-c` (an empty `-c` stops the default file from loading).

  Precedence is measured for `keepalive` only. Any other setting set by two disagreeing sources is UNRESOLVED. The largest deviation is +5 ms, so gunicorn entries use `toleranceMs` 6.
- **First code pass** (1217 tests, `web-t1` golden unchanged):
  - Python readers, plus a `gunicorn.conf.py` reader that reads literals only and never runs the file;
  - the worker model resolved before any default;
  - sync gives N/A T1 ("no -k given");
  - the measured precedence for `keepalive`;
  - stdin with the Helm `# Source:` comment quoted;
  - precision fixtures;
  - a new golden, `api-admin-t1.txt`.

  Fixed along the way: a hostile `NODE_OPTIONS` of 200,000 options crashed the run (B1 code, a huge array spread into `push`). Found, still open: a Node source with 200,000 imports or 150,000 assignments did not finish in 2 minutes.
- **Maintainer decision (2026-11-11): where the gunicorn or uvicorn version comes from.** No design document said, so `api` gave UNRESOLVED instead of FAIL. The maintainer chose "pins + declaration":
  - a `runtime.gunicorn` or `runtime.uvicorn` declaration in `tripcurve.yaml`;
  - else an exact pin in `requirements*.txt`, `pyproject.toml`, `poetry.lock` or `uv.lock`, nearest the workload, with an Assumption naming the file.

  Disagreeing pins, or no evidence at all, give UNRESOLVED with a declare line.
- **Explicit `keepalive` (main session, from evidence).** It equals the idle close only where measured: the uvicorn worker at 3 to 9 s in B2, and 75 s in research section 2. gthread and uvicorn alone are being measured now.
- **B2 review 1** (independent, Sonnet, on b614cb3): 1 Critical, 4 Major and 6 Minor findings. Several were checked against real gunicorn 26.2.0.
  - **C1:** a PEP 263 coding cookie (`unicode_escape`, `utf-7`) in `gunicorn.conf.py` turns a "comment" into a live `worker_class` or `keepalive`. tripcurve printed N/A with exit 0; real gunicorn would FAIL T1.
  - **M1:** `-r`, `-c`, `-e` and URL lines in a pin file were skipped, and the search fell through to a parent folder's pin.
  - **M2:** an environment marker on a pin was ignored.
  - **M3:** the printed "measured" basis claimed evidence for explicit values outside the measured span (600 s, httptools).
  - **M4:** two guards survived mutation.
  - **Minor:**
    - a skip reason was lost;
    - a skipped `gunicorn.conf.py` gave N/A;
    - `default:` was printed before an explicit value;
    - the Helm label wrapped mid-label;
    - surrogate-pair escapes;
    - a Poetry sub-table was read as absent.

  Fixes are under way, test first. The explicit keep-alive span is being widened by measuring 300 s on the real servers.
- **B2 fix pass** (1433 tests, both goldens unchanged). Every finding has a regression test that failed first.
  - **C1:** a coding cookie other than utf-8, ascii or latin-1, or a UTF-16/32 mark, makes `gunicorn.conf.py` opaque, so every setting it could set is UNRESOLVED.
  - **M1:** `-r`, `-c` and `-e`, and URL or path lines, make the pin file unreadable. Any mention of the package in the nearest folder stops the upward search.
  - **M2:** a pin under an environment marker is unreadable.
  - **M3:** an explicit keepalive applies only within the measured span: uvicorn worker 3 to 300 s, gthread 7 to 300 s, uvicorn alone 7 to 300 s (h11 only).
    - The printed basis states the span: `measured from 3 to 300 s on 26.2.0`, with no `default:` prefix.
    - The gthread tolerance is proportional (0.2 %, or 601 ms at 300 s), because its overshoot grows with the value.
    - Protocol rule: plain uvicorn and the gunicorn uvicorn worker are UNRESOLVED ("protocol implementation not measured") unless the pins show exactly one exact uvicorn pin and nothing that could bring in httptools. Any extra counts as possibly httptools.
  - **M4:** both guards now have tests; the mutations are killed.
  - **Minor:**
    - skip reasons are kept;
    - a skipped `gunicorn.conf.py` or pin file gives UNRESOLVED, never N/A or "no version";
    - the Helm label is never split;
    - non-BMP characters stay as two `\u` escapes (the approved rule);
    - a Poetry sub-table is unreadable.
- **300 s measurement:**
  - gthread 300487 to 300589 ms;
  - uvicorn worker and uvicorn alone 300001 to 300003 ms.
- **B2 review 2** (second pass on c441c68): every earlier finding is fixed, and the span edges and `--http` spellings behave correctly. Two new Majors are in the protocol rule:
  - **A:** `fastapi[standard]` and `litestar[standard]` bring in httptools without naming it.
  - **B:** for plain uvicorn, a declaration bypassed the pin check, and a `-r` include hid `uvicorn[standard]`.

  The real-server check found that uvicorn 0.54's `http: auto` uses httptools when it is installed, and gunicorn's uvicorn worker always uses `auto`. Root cause: "httptools is not mentioned, so it is h11" is a deny-list. Instead of patching it, the main session is measuring the httptools implementation on the real servers (in `.cache/`, installed by read-only download). If it behaves like h11, the protocol stops mattering for the measured versions and the rule can be removed.
- **httptools measured** (round 4, commit 6c9a4f4): it behaves exactly like h11, with uvicorn 0.54.0, httptools 0.9.0 and uvloop 0.23.0, on gunicorn 26.2.0 and 27.0.0. The protocol was read from the live protocol object serving each request.
  - **Protocol gate:** removed. Coverage is now keyed on the uvicorn version (0.54.x).
  - **uvicorn worker:** needs a uvicorn version, from a declaration or an exact pin. A gunicorn-only pin gives UNRESOLVED.
  - **Unknown `--http` values:** anything other than h11, httptools or auto (including `UVICORN_HTTP` in a linked Dockerfile) is UNRESOLVED.
  - **Event loop:** uvloop and asyncio were not separated; recorded in `docs/limits.md`.
- **Assumptions:** the uvicorn version source is now listed as an Assumption as well. The `api-admin` golden gains one combined line, "The gunicorn and uvicorn versions are taken from ...". The developer had first left it out to keep the golden unchanged; the main session overruled that, because a spec rule outranks the golden.
- **B2 final confirmation pass** (on bedb34d): no Critical or Major findings, and the reviewer recommends merging.
  - Major A and B now give value-based verdicts backed by the httptools measurement, and Minor C gives UNRESOLVED.
  - Every attempt to get past the uvicorn-version gate gives UNRESOLVED.
  - `uvicorn==0.54.1` gives a PASS that discloses 0.54.0 as the measured version.
  - Two Minor findings, both disclosed: the gate keys on the uvicorn version only, and pins found in different folders are each used and listed. The first is recorded in `docs/limits.md` as a known limit.
- **B2 done:** 1451 tests, 96.6% of lines, both goldens matching.

## B3 Node version edge cases and the buffer measurement (started 2026-11-11)

- **The explicit `keepAliveTimeout` question settled by measurement** (commit 5428832; Node 22.23.2, 22.23.5, 24.22.3 and 26.13.1, 3 runs each):
  - an explicit `keepAliveTimeout` K closes at K + 1 s: 7000 at 8 s, 12000 at 13 s, 65000 at 66 s, in the options form too;
  - `keepAliveTimeoutBuffer = 0` removes the buffer;
  - the research's "65 s" did not reproduce.

  The rule "an explicit `keepAliveTimeout` is UNRESOLVED" becomes "idle close = K + buffer", on the measured lines and spans.
- **Two agents running in parallel:**
  - a measurement agent is measuring the release where the buffer first appears in each line (22.18.0 and 22.19.0, 24.0.0 to 24.6.0, 26.0.0, plus 20.x and 18.x), from checksum-verified official tarballs, so that the KB ranges rest on evidence;
  - a developer agent is building version intervals, one candidate per range, VERSION-DEPENDENT output, image-tag intervals (`node:22`, `lts`, known variant suffixes), the explicit-setting rule, the `headersTimeout` trap and the after-fix demo golden.
- **B3 measurements** (commits 327c684 and 81175c7, recorded in `docs/research.md` section 14): the extra 1 s on Node's idle close is OLDER than the `keepAliveTimeoutBuffer` property.
  - Node 20.20.2, 22.12.0, 22.18.0, 24.0.0 and 24.5.0 close at 6.0 s, or at K + 1 s when K is set, but have no buffer property.
  - 18.20.8 closes at exactly 5.0 s, or exactly K.
  - The property, from 22.19.0, 24.6.0 and 26.x, can switch the extra second off.

  The ranges now start at the lowest version measured in each line: 18.x from 18.20.8, 20.x from 20.20.2, 22.x from 22.12.0, 24.x from 24.0.0, 26.x from 26.0.0. The `web-t1` citation is relabelled to the measured range.
- **B3 code** (f756e88, 2159 tests):
  - versions become intervals;
  - one candidate per range;
  - VERSION-DEPENDENT output for `node:lts`;
  - an explicit K closes at K + 1 s within the measured span;
  - the `headersTimeout` trap;
  - the after-fix golden `web-t1-fixed` (66 s, PASS).
- **B3 review 1:** no Critical, three Major.
  - **M1:** the printed bases overstate the evidence. "Measured from 7 to 65 s on 22.12.0 to 22.23.5" is wrong: 65 s was run only on 22.23.x. The reviewer confirmed on the real binaries that the behaviour is right, but it is not in the evidence.
  - **M2:** a setting on another object, or on a conditional or dead path, gave PASS.
  - **M3:** the listen-order check is quadratic (37 s for 8000 by 8000).
  - Plus Minor findings (a fractional K, https, the tag grammar, wording) and three mutation survivors.

  Fix plan: measure the missing points; bind each setting to the listening server on an unconditional path; make the listen-order check linear; write every basis from the evidence.
- **Open for the maintainer** (not changed): `engines` narrows a floating tag such as `node:lts` into one range, which can then give PASS. That follows the recorded rule ("engines only narrows"). Because `node:lts` gives no evidence of the actual version, the maintainer may want floating tags to stay VERSION-DEPENDENT even when engines is set.
- **Measurement self-test:** fixed a flake seen 1 time in 5, where a fake server read 1 ms under nominal (allowed slack is now 2 ms, and a -5 ms bias is still caught).
- **B4 measurements done** (commit d08bdda, on the B4 branch):
  - gunicorn's `graceful_timeout` ceiling is 30 s, or the set value, for sync, gthread and the uvicorn worker; `--timeout` does not move it;
  - uvicorn alone has no ceiling;
  - lightship 9.1.0 waits 5 s when `KUBERNETES_SERVICE_HOST` is set;
  - dated docs: the Kubernetes default grace period is 30 s, and terminus has no default `beforeShutdown` delay.
- **B3 fix pass** (767a106 plus one wording pass): every finding has a regression test that failed first.
  - **M1: bases are written from evidence.** Entries carry `measuredVersions`, `measuredKs` and options-form runs, regenerated from the JSONL. A test checks every claim against the raw lines. Examples of the printed basis:
    - `measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5`;
    - an unmeasured K inside the span says "interpolated between measured K = ...";
    - the options form prints its own runs.

    Buffer 1000 was measured only at K = 7 s.
  - **M2:** a setting counts only on the single listening server, in a plain statement before `listen` in the same block (the file, a function called by name at top level, or an IIFE).
  - **M3:** the listen-order check is linear (8000 by 8000 in 0.45 s).
  - **Minor:**
    - a fractional K is UNRESOLVED;
    - https is UNRESOLVED (not measured);
    - an explicit tag grammar;
    - wording follows the measurements.
- **More measurements** (commit 770c182): K = 12 and 65 s on every release, the options form at 65 s, and buffer 1000 and 0. Every 20.x to 26.x release closes at K + 1 s; 18.20.8 closes at K. One run came in 1 ms under (12999); T1 compares the nominal value, so no verdict depends on it.
- **B3 review 2:** no Major findings. About 35 attempts to get round the attribution rule all gave UNRESOLVED or a legitimate PASS. The two remaining Minor wording points (m-a, m-b) are fixed.
- **B3 done:** 2235 tests; the three goldens match.

## B4 Shutdown chain T2 and T3 (started 2026-11-12)

- **Code** (ae94122; 11,101 tests, mostly property cases; verify takes 25 s):
  - T2 and T3 with every outcome, and NOT EVALUATED when T2 failed;
  - in-process drains: lightship, terminus `beforeShutdown` and SIGTERM handlers, read with the allow-list approach;
  - the lightship version taken from pins or lock files (9.x from 9.1.0);
  - the grace period (the Kubernetes 30 s default, documented), preStop, and per-workload declarations;
  - ceilings: gunicorn 30 s measured, and 10 s explicit for sync on the command line only; uvicorn has none by default (5 s explicit); Node has none;
  - inline waiver comments read raw;
  - the config-error golden.

  The goldens gained T2 and T3 lines exactly as in the design mockup. The T1 lines are unchanged.
- **Decided by the main session, both toward caution:**
  - a Node "no drain" FAIL must not stand when a shutdown library that the reader does not read is imported, because that library could drain without being handed the server;
  - gunicorn's ceiling with `-w` above 1, and set via `GUNICORN_CMD_ARGS` or a config file, is being measured instead of inferred.
- **Open for the maintainer** (literal reading kept for now):
  1. Should a declared `drain.in_process_s` settle a preStop hook of unknown duration? The interaction spec's recovery table says yes; the requirements say UNRESOLVED.
  2. Lock files over 5 MB (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) appear under "Files not checked", which makes runs in large monorepos incomplete.
- **Ceiling measurements** (d6bbf01): two workers behave like one (30 s by default, 10 s when set). A 10 s value set by `GUNICORN_CMD_ARGS` or by a `-c` file is honoured on sync. The flag is honoured on sync, gthread and the uvicorn worker. All on 26.2.0 and 27.0.0.
- **B4 review 1:** no Critical. Four Major:
  - **M1:** a found drain plus an incomplete search still gave a T2 or T3 PASS.
  - **M2:** T3 counted a Python server's unread drain as 0 s without disclosing it.
  - **M3:** a drain library such as `close-with-grace` was not read, yet T2 said FAIL.
  - **M4:** three drain-search guards had no test that could fail.

  Also eight Minor findings.

  **Fix plan:**
  - a found drain needs a complete search or a declaration;
  - add the Assumption "In-process drains of Python servers are not read; counted as 0 s" (this keeps the `admin` T3 PASS);
  - known shutdown libraries, and bare side-effect imports, make the search incomplete;
  - tests for every guard;
  - minors: 0 s drain wording, rounding up at the T3 boundary, npm alias pins, a top-level `process.exit` making later code dead, quoted names in the config-error case, duplicate config entries;
  - widen the ceiling entries to the newly measured forms.

  Kept as is, with the reason: lightship 9.x from 9.1.0 follows the B2 convention, and its printed basis is accurate.
- **B4 fix pass** (e5db401, 10,923 tests). Every finding has a regression test that failed first; 21 of 22 mutations were killed, and the survivor is equivalent.
  - A found drain needs a complete search or a declaration.
  - The Python 0 s drain is listed as an Assumption.
  - Known shutdown libraries and bare side-effect imports make the search incomplete.
  - Every guard is tested.
  - Minors:
    - the wording for a 0 s drain;
    - rounding up at the T3 boundary;
    - npm alias pins;
    - a top-level `process.exit` or `throw` before `listen` makes everything after it UNRESOLVED;
    - the config-error case quotes the workload name;
    - two entries for one workload give the config-error case.
  - Ceiling entries are widened exactly to the measured forms.
- **B4 review 2:** no Major findings. Two Minor wrong-FAIL routes, both absence claims, are now fixed with an allow-list:
  - **The Node "no drain" claim (N1):** it holds only when every import is a local file that was read, a Node built-in, or type-only. Any npm package gives T2 UNRESOLVED ("declare drain.in_process_s or add a preStop"). A Node T2 FAIL now appears only for apps that import nothing but built-ins and local files.
  - **The terminus exemption (N2):** it covers only the exact `createTerminus(server, ...)` call.

  Main-session probes on the built CLI: an Express import with no drain gives UNRESOLVED; built-ins only gives FAIL; a local 5 s SIGTERM drain gives PASS.
- **B4 done:** 10,950 tests. The goldens match: T1 lines unchanged; T2 and T3 lines and the assumption lines added as the spec requires.

## B5 Terraform and T4 (started 2026-11-12)

- **Lookups** (`docs/lookups-b5.txt`, all dated):
  - the AWS rule "visibility timeout to six times your function timeout, plus MaximumBatchingWindowInSeconds";
  - provider source shows schema defaults for SQS visibility (30 s), Lambda timeout (3 s) and `aws_lb` idle (60 s, application load balancers only);
  - the batching window has no provider default (AWS applies 0 for SQS).
- **Reading:** a value with a provider schema default follows from the file when the attribute is absent, like the Kubernetes grace default. A missing batching window does not, because Terraform does not manage it, so it is UNRESOLVED with "assumed 0 s".
- **Code** (cc77261, 11,183 tests):
  - a non-recursive allow-list Terraform reader, plus Terraform JSON and `terraform show -json`;
  - event source mapping links;
  - T4;
  - declared and by-name LB links (by-name is an assumption and never PASS or FAIL);
  - Terraform inline waiver comments are read;
  - new goldens: `orders-t4` (FAIL, as in the design mockup) and `orders-t4-fixed`.
- **Process slip:** cc77261 was committed with one failing evidence test. The commit command did not depend on verify passing. The test asserted the old evidence state (source read only for SQS); the Lambda and `aws_lb` entries are now being updated to cite their source defaults. From now on, commit only after verify exits 0.
- **Open for the maintainer:** a mapping whose event source is a stream (Kinesis or DynamoDB) is UNRESOLVED, not N/A, so that a run cannot exit 0 on an event source tripcurve does not follow. Should a positively identified non-SQS stream be N/A instead?
- **B5 review 1: one Critical.** The Terraform lexer closed a heredoc differently from real HCL, which closes on a line whose trimmed text equals the marker.
  - **Effect:** an indented or trailing-space `EOF` did not close the heredoc. It ran on to a later `EOF`, the braces balanced by accident, and the attributes in between were silently lost. A real `visibility_timeout_seconds = 10` fell back to the 30 s default, giving a wrong PASS with exit 0.
  - **Lesson:** a hand-written reader for someone else's grammar must match that grammar's token boundaries exactly, or refuse the file. "Readable but different" is the dangerous case.
  - **Minor:**
    - a duplicate resource across files of one folder gave PASS;
    - files Terraform ignores (`.x.tf`, `#x.tf`) were read;
    - assumption lines went past 80 columns;
    - two guards had no test that could fail.

  Fixes are under way, test first, followed by an audit of every lexer boundary against HCL.
- **B5 fix pass** (97475da, 11,217 tests). Every finding has a regression test that failed first.
  - **Heredocs:** they now close by HCL's rule (the trimmed line equals the marker).
  - **Lexer audit:** constructs whose HCL boundary might differ now make the file unreadable instead of being guessed: a lone CR, a CR in a string, a vertical tab, form feed or no-break space in code, `${~`, and single quotes.
  - **Duplicates:** a resource declared twice in one folder gives UNRESOLVED.
  - **Ignored files:** names starting with `.` are skipped, matching Terraform's `IsIgnoredFile` (read 2026-11-12). It ignores names that start with `.`, names that end with `~`, and names that start and end with `#`; `#main.tf` is still read.
  - **Assumptions** stay within 80 columns.
- **B5 review 2:** nothing at Major or above.
  - The heredoc probes (tab and no-break-space closes, digit and hyphen markers, nested heredocs, comments between a name and `=`, CRLF) are read correctly or the file is unreadable; none stays readable with a changed value.
  - 27 of 29 fixture outputs are byte-identical to before the fix; the other two show the intended assumption-wrap change.
- **B5 done.**

## B6 Waivers, summary variants, exit codes and explain (started 2026-11-12)

- A developer agent is building waivers (inline and `tripcurve.yaml`), expiry against a UTC date the CLI reads once and injects, unmatched and invalid waivers, the `No failures:` ending, every exit code, and `--explain` (T4 credits cdk-nag and cfn-lint).
- **Prepared for B7 (SARIF schema licence).** The OASIS sarif-spec repository is under the OASIS IPR Policy (RF on RAND), not a standard permissive licence. Plan for B7: do not vendor the schema; use tripcurve's own validator for the SARIF subset it emits. **Maintainer decision:** vendor the official schema later, or not.
- **B6 code** (11,482 tests):
  - **Waivers.** Waivers are read from inline comments and from `tripcurve.yaml`, and WaiverApplier is the only validator. The CLI reads the clock once (`src/cli/clock.ts`); a scan test stops any other source file from reading it.
  - **Report endings.** The run handles expired, unmatched and invalid waivers, and ends `No failures:` when every waiver applies.
  - **`--explain`** prints T1 to T4 from the knowledge-base data, and T4 credits cdk-nag and cfn-lint.
  - **Property test.** 3000 seeded cases are checked against an independent oracle. The builder reported all 14 guard mutations killed. The review found that two guards survived the property test, and one of them survived every test; see review 1.
  - **Process caveat.** The waiver goldens were captured from the CLI and checked line by line against the design mockups, instead of being written first. The scenario inputs and line forms were written down beforehand.
- **Open for the maintainer (B6):**
  1. **Unknown rule.** `--explain` prints a fixed message. The design mockup echoes the quoted rule.
  2. **Inline waiver attachment.** A waiver attaches to the enclosing block, not to "the source line or next line". A Terraform comment in a queue or function block does not attach to the mapping's T4.
  3. **Two waivers for one finding.** Both are invalid.
  4. **Closing-line wrap.** It wraps greedily at 80 columns, which can leave a lone `0` at the end of a line.
- **B6 review 1:** no Critical or Major findings. About 200 crafted fixtures could not make a waiver produce a wrong PASS, a green line or exit 0. Seven Minor findings:
  - **M1:** a comment between documents or List items attached to the previous block.
  - **M2:** waiver comments in YAML files tripcurve does not classify were dropped silently, so a stale waiver in `values.yaml` was invisible.
  - **M3:** grouping waivers on one finding was quadratic (8 s for 90,000).
  - **M4:** a reason made only of invisible characters counted.
  - **M5:** the WAIVED line cut the reason at 50 characters; the property test held a tautology; two guards were untested; the clock scan was narrow.
  - **M6:** a wrongly shaped `waive:` key stopped the run, against the rule that an invalid waiver never stops the run.
  - **M7:** the `--explain` read dates were approximate.

  All seven are being fixed, test first. M2 and M6 change what makes a run unclean, so a second review pass follows.
- **B6 fix pass** (fdb4214). Every finding has a regression test, which was run red by reverting the fix.
  - **Waiver placement and scope:**
    - a comment between documents or List items is invalid;
    - stray waivers in unclassified YAML files are listed and make the run unclean;
    - a wrongly shaped `waive:` becomes a listed invalid waiver, and the run continues.
  - **Reasons:**
    - a reason needs a visible character;
    - long reasons print in full as quoted parts.
  - **Performance:** waiver grouping is linear.
  - **Tests and checks:**
    - the property-test tautology is removed;
    - the generator runs 4000 cases;
    - both guards that survived before are now killed (corrected mutation table: 19 of 19);
    - the clock scan is wider, and `utcToday` may be imported only in `src/cli`.
  - **Wording:** the explain dates now read "2026-10-29 to 2026-11-02".
- **B6 review 2:** nothing at Major or above. Two Minor findings, both fixed:
  - **N1:** a `...` or a directive line before `---` counts as between documents.
  - **N2:** the stray-file scan is a linear line pass and no longer parses YAML. On 1M `---` lines the scan took 146 times as long as a plain line split; it is now bounded below 25 times.
- **B6 done:** 11,560 tests.

## B7 JSON and SARIF (started 2026-11-12)

- **Code** (11,795 tests; the human goldens are byte-identical):
  - JSON and SARIF renderers built from the one Report model;
  - output is plain ASCII, with every character above `~` escaped;
  - SARIF levels follow the mapping recorded for the SARIF output;
  - unchecked or invalid files, invalid or unmatched waivers, and configuration errors all become `tripcurve-file` warning results;
  - suppressions are `inSource` or `external`;
  - NothingChecked gives one warning at the root.
- **Tests:**
  - **Goldens.** 18 JSON and SARIF goldens were hand-written first. Two were wrong (the waiver source type, and `notChecked[].line`); the model was right, so both goldens were corrected.
  - **Validator.** A hand-written SARIF subset validator in `test/support/` cites SARIF 2.1.0 sections (OASIS Errata 01, read 2026-11-12). It refuses all 66 broken-document mutations.
  - **Property test.** 2,500 seeded reports, checking that JSON and human output agree and that the SARIF result set is exact.
- **Open for the maintainer:**
  - vendor the official SARIF schema (OASIS IPR terms), or keep the subset validator, which is used meanwhile;
  - a `helpUri` per rule once a public location exists.
- **B7 review 1:** no Critical findings.
  - **Checked and fine:** all 93 fixture directories agree across human, JSON and SARIF on exit code and result sets, and no input can forge a `ruleId`, a level or a run property.
  - **M1 (Major).** A SARIF-only gate saw a clean run while the run was NotClean: with T1 and T2 waived, only T3's NOT EVALUATED `note` remained.
    - **Fix:** keep the approved mapping and add one `tripcurve-run` warning whenever `clean` is false and no unsuppressed error or warning exists.
  - **M2 (Major).** Input text could form an embedded link in a SARIF message (SARIF 3.11.6). Brackets are now escaped.
  - **Minor:**
    - the subset validator does not enforce closed property sets;
    - suppressions carry no expiry date;
    - on a ConfigError the result set differs between formats;
    - no note for workloads that were not checked;
    - missing Clean and NoChecksApply goldens;
    - a finding with no level could be dropped;
    - `--explain` ignores `--format`;
    - URI bases are not set.

  All are being fixed, test first.
- **B7 fix pass 1** (all 10 findings fixed, each with a test run red first):
  - **M1:** a `tripcurve-run` warning is added when the run is not clean and has no unsuppressed error or warning. The property test now checks on 2,500 reports that a run that is not clean has at least one unsuppressed error or warning.
  - **M2:** SARIF message text now escapes `[`, `]`, `{` and `}` (SARIF 3.11.5 and 3.11.6, quoted 2026-11-12).
  - **m1:** the validator now enforces closed key sets and enums, and refuses about 100 mutations.
  - **m2:** suppressions carry `until`, `mechanism` and `source`.
  - **m3:** the human report also lists the unreadable config file. Errors about the whole config file are now in plain words.
  - **m4:** each workload that was not checked gets a `tripcurve-not-checked` note.
  - **m5:** new goldens for a clean run, the no-checks-apply case and the run-level warning.
    - The NoChecksApply summary cannot be reached from files, because T2 and T3 never return N/A for a workload behind a load balancer. Its golden is therefore built from a report model.
  - **m6:** a finding that is not PASS or N/A and has no level becomes a `warning`, never nothing.
  - **m7:** `--explain` with a format other than human exits 2.
  - **m8:** `originalUriBaseIds.SRCROOT` is declared, and every relative URI uses it.
  - **Results:** 11,882 tests passed, with 94.4% of lines covered.
- **Process note:** while other sessions kept the machine's load average at 15 to 25, some older timing tests flaked (`waivers.e2e`, `scaling`, `honesty-property`, `python-hostile`). They passed once the load dropped.
  - My own verify run (load 6.5) passed.
  - Still open: making those tests robust under heavy load. This is not hidden; it is recorded here.
- **B7 review pass 2** (on ca09e75): no Critical or Major issues; the fixes hold.
  - Fixed, each with a test:
    - **m-A:** the SARIF level now follows `originalKind` even when the waiver is missing (only reachable through the library).
    - **m-C:** the validator refuses unescaped `[ ] { }` in message text.
    - **m-D:** every item that was not checked gets a note, including Ingress and kind items. The count of these notes now equals `notChecked` in every scenario.
  - **m-B:** on a config-error stop, `unchecked` lists the file while every count is 0. This follows the JSON design ("every count 0" on the config-error case stop), so the code was not changed. The rule is now tested and written in `docs/limits.md`.
  - **For the maintainer:** on a config-error stop, the human report labels the unreadable config file `UNRESOLVED (file)` while the counts stay 0.
  - **For the maintainer:** braces in messages are doubled per SARIF 3.11.5. Whether GitHub's viewer decodes `{{` back to `{` has not been checked.
  - **Results:** 11,904 tests passed.

## B9 GitHub Action (built 2026-11-12)

- **Files:** `action.yml` (composite; inputs `path`, `config`, `format`, `sarif-file`; outputs `sarif-file`, `exit-code`), `action/run.sh` (all shell logic, modes `build` and `check`), `action/dry-run.sh`, `docs/action.md`, `docs/lookups-b9.txt`, and `test/action/` (`action-file`, `run-script`, `dry-run` tests, `support.ts`). The only edit to existing config is `biome.json`: `test/action/*.test.ts` joins the existing `noTemplateCurlyInString` override, because the file test names `${{ }}` strings.
- **Pins (read-only `git ls-remote` on github.com, 2026-11-12 13:46Z, `docs/lookups-b9.txt`):** `actions/setup-node` v7.1.0 is 949feb24..., `github/codeql-action` v4.39.3 is 33d7b85d... (peeled commit). No `TODO(owner): pin SHA` remains. The file test accepts a marked TODO as a printed KNOWN GAP, and a second test asserts there is none today.
- **Decisions:**
  - `--` before the path is supported by the CLI (commander): `-- --format=json` is the path `--format=json` (checked by running it, and tested).
  - `sarif-file` is refused (exit 2) when absolute, when any path component is `..`, when it has a control character, when it names a directory or an existing symlink, or when its folder resolves outside the workspace (a symlinked folder). The Action's design is silent on this; the rule here is the one applied. A component check, not a substring check, so `a..b` is allowed.
  - `exit-code` is the raw code: 0 to 3 from the CLI, 127 for a missing `node` or CLI file, 128 + signal when killed, 3 for a failed build or for exit 0 with an untrustworthy SARIF file. Both runs failing gives the first non-zero code (the report run's).
  - The SARIF file is written to a temporary file next to its place and moved only when it is a JSON document with `version` `2.1.0` and a `runs` list (exit 0 or 1). The `sarif-file` output is set only then.
  - The B7 validator is test-only TypeScript, so the script uses the JSON parse plus version plus `runs` check allowed by the brief.
  - `set -e` is not used; every exit is explicit so the SARIF file and outputs are written before failing.
  - The `exit-code` Action output reads the check step and falls back to the build step, so a failed build still sets it. This relies on GitHub keeping outputs of a failed step: not tested on GitHub.
- **Found by the tests, before they passed:** a `sarif-file` with a newline slipped past a `grep`-based control-character check (grep works by line); a `tr -d` variant lost a trailing newline in `$(...)`. The check now compares the text with a copy where control characters became `?`. A node-less PATH test also needed the absolute `/bin/bash`.
- **Mutation check:** `exit "$code"` at the end of `run.sh` replaced by `exit 0`: 12 of 61 tests failed (every non-zero case). `elif [ "$sarif_ok" -ne 1 ]` replaced by `elif false`: the 3 empty, invalid and wrong-version SARIF tests failed. Both restored.
- **Dry run (`action/dry-run.sh`, fixture `test/fixtures/report/demo`)** printed `[dry-run] step build`, `[dry-run] npm ci --ignore-scripts (stubbed: nothing downloaded)`, the real `npm run build`, the full human report ending `Summary: 4 failed, 1 unresolved, 1 not evaluated, 1 not applicable, 3 passed; not a clean result`, then:
  ```
  tripcurve action: report run: failures were found (exit 1). See the report above.
  tripcurve action: failing: exit code 1.
  [dry-run] step check exited 1; outputs:
  sarif-file=tripcurve.sarif
  exit-code=1
  [dry-run] tripcurve.sarif: version 2.1.0, 6 results
  [dry-run] the upload step is disabled (if: false) and was not run
  ```
  The dry run's exit status was 1. The Action has never run on GitHub.
- **Tests that flake under load (carried from B7 and B8).**
  - **Method:** `loaded-test.sh` started N `node -e 'for(;;){}'` loops, ran `npx vitest run`, and always killed the loops (afterwards no loop remained). On 10 cores, 8 loops passed; 24 loops (load average 16 to 38) failed 9 tests:
    - 5 s default timeout: `waivers.e2e` "an unknown rule prints a fixed message" (a child process);
    - 60 s hang guard exceeded: `scaling-helper` and `waive/scaling`;
    - linear work measuring 8.3 to 10.6 against the limit of 8: `safe-text` 5 MB, `version-interval` 1 MB, `iac-hostile` heredoc, `python-hostile` (two), `waive/scaling` n blanks.
    A second run at 24 loops, after only raising the minimum timed size to 100 ms, still failed 4 (`version-interval` 13.1, `python-hostile` gunicorn.conf.py 8.6, `waive/stray` two at 9.9 and more). `honesty-property` did not fail in my runs (its 2000 cases can exceed 5 s only under heavier load); it is covered by the new global guard.
  - **Fixes, no assertion removed, `LINEAR_RATIO_LIMIT` still 8:**
    - `vitest.config.ts`: `testTimeout` and `hookTimeout` 120 s, commented as a hang guard only (covers the 5 s cases: `waivers.e2e`, `honesty-property` and any unnamed one).
    - `test/support/scaling.ts`: `SCALING_TEST_TIMEOUT_MS` 60 s to 300 s (hang guard).
    - `scalingRatio` now times CPU time (`process.cpuUsage`, user plus system) instead of wall time, because waiting for a core landed unevenly on the small and large runs. It relies on vitest's default `forks` pool (separate processes), noted in the file. `MIN_TIMED_MS` 20 to 50 ms (100 ms made the helper's own quadratic self-test take 46 s; with CPU time 50 ms is enough).
  - **Still fails when it should (mutations, run on an unloaded machine, both restored):**
    - the quadratic duplicate-key check (`uniqueKeys: true` in `src/parse/intake/yaml-documents.ts`): `yaml-keys` "work grows linearly with the number of keys" failed with ratio 13.69 (the freeze);
    - the honesty guard (`c.unresolvedFindings` removed from `notClean` in `src/report/summarize.ts`): 4 `honesty-property` tests failed (for example case 25: "All checks passed" printed with an UNRESOLVED result);
    - `scaling-helper` still asserts quadratic work gives a ratio above 8 and linear below it, and passes.
  - **Result under the same load:** with the fixes, `npx vitest run` passed under 24 loops (107 files, 11,967 tests) and under 32 loops (load average up to 55).
- **Results:** `npm run verify` passed twice in a row (107 files, 11,967 tests, 96.61% lines; the one Biome info is old). `npm run build` passed. No golden file changed.
- **Not done:** the hosted behaviour of the Action; whether setup-node v7 and codeql-action v4 suit the runner; `.github/workflows/verify.yml` still uses the mutable tags `actions/checkout@v4` and `actions/setup-node@v4`; the independent adversarial review of B9.
- **B9 review 1: READY.** No Critical or Major findings.
  - **Sound:**
    - Every way the Action can fail (missing node, failed build, killed by a signal, untrustworthy SARIF) fails with an exit code set.
    - No `${{ }}` appears in a `run:` body.
    - No workflow command (`::`) can start a log line, tested with hostile names.
    - The SHA pins were re-verified on 2026-11-12.
    - The upload step is disabled by a literal value.
    - The CPU-time scaling helper still fails on quadratic work: ratio 13.85 against the limit of 8.
  - **Minor findings:**
    - **M1:** a symlinked parent folder let `mkdir -p` create empty directories outside the workspace before the refusal.
    - **M2:** the final `mv` was not checked.
    - **M3:** SARIF with an empty `runs` list was accepted.
    - **M4:** four mutation survivors (stdin `/dev/null`, temp-file trap, a missing exit-code output, and one equivalent mutant).
  - **Also:** `verify.yml` uses mutable `@v4` tags. All of these are being fixed.
- **B9 review fixes (2026-11-12), each test red first:**
  - **M1** `mkdir -p` before the containment check: a symlink `out -> ../outside` with `out/new/deep/f.sarif` created `outside/new` (red: `expected [ 'new' ] to deeply equal []`). Now `run.sh` walks the folder part one component at a time: an existing component is resolved with `pwd -P` and must stay inside the workspace, a missing one is made only under a folder already shown to be inside. New tests: that case, and a symlink to a folder inside the workspace still works.
  - **M2** unchecked `mv`: red with a failing `mv` on PATH (`expected +0 to be 3`). A failed move is now exit 3 with `sarif-file` unset; the move goes to the resolved path.
  - **M3** `runs: []` was accepted (red: `expected +0 to be 3`); now `runs.length >= 1` is required. The stub SARIF in the tests now has one run.
  - **M4** three survivors are killed, each shown by mutation: without `< /dev/null` the open-stdin test times out (its own 20 s guard); without the `trap` the temp-file test fails; without `set_output exit-code 3` in the build `cd` branch the new build test fails. All restored.
  - **verify.yml** pinned: checkout v7.0.1 (3d3c42e5...) and setup-node v7.1.0 (949feb24..., same as the Action), looked up read-only 2026-11-12 14:16Z (`docs/lookups-b9.txt`); the file test covers verify.yml (red: `not pinned and not marked: - uses: actions/checkout@v4`). This closes the earlier "mutable tags" open item.
- **B9 fix pass 1:** all four Minor findings are fixed, each with a test seen red first.
  - **M1:** containment is checked one path component at a time before anything is created.
  - **M2:** the final move is checked and goes to the resolved path.
  - **M3:** `runs` must not be empty.
  - **M4:** three new tests catch the earlier mutation survivors.
  - **verify.yml:** pinned to checkout v7.0.1 `3d3c42e5…` and setup-node v7.1.0, looked up on 2026-11-12.
- **B9 review 2: MERGE.**
  - The component walk held against `.`, `//`, `-x`, symlink loops, a symlink to `/` and an unreadable folder.
  - No valid path was refused.
  - 8 of 9 new-line mutants were killed; the survivor is equivalent.
  - The pins were re-verified and are the newest release tags.
  - **Not verified:** the Action has never run on hosted GitHub.

## B10 Demo repository and end-to-end test (built 2026-11-12)

- **Files:**
  - `demo/` (14 files, the first run), `demo-fixed/` (15 files, after the fix), `demo/expected/first-run.txt`, `demo/expected/after-fix.txt`, `demo/README.md`;
  - `scripts/timed-check.mjs`, `scripts/timed-check-machine.json`;
  - `test/e2e/demo.e2e.test.ts`, `test/e2e/demo-sync.test.ts`, `test/scripts/timed-check.test.ts`, `test/support/demo.ts`;
  - `package.json`: a `timed-check` script, and `verify` ends with `npm run build && npm run timed-check`;
  - one code fix (below) in `src/resolve/python-server.ts`, with its test in `test/resolve/python-explicit.test.ts`;
  - `docs/limits.md`: the timed check and the demo.

  The npm `files` list is still `dist`, so `demo/` is not shipped. `test/fixtures/report/demo` (the 8-file B7 fixture) is untouched.
- **Layout (research section 10).** `k8s/ingress.yaml`, `api.yaml`, `admin.yaml`, `web.yaml`, `src/server.ts` (`web` runs `command: ["node", "src/server.ts"]`), `infra/queue.tf`. To reach "14 files read" honestly, with real files a shop would have: three Service files (needed to link the Ingress), `k8s/namespace.yaml`, `k8s/api-hpa.yaml`, `infra/providers.tf`, `requirements.txt` (the gunicorn and uvicorn pins, which the maintainer chose on 2026-11-11 as the version source) and `package.json`. Without `tripcurve.yaml` that is exactly 14; with it, 15 (as the design says). I placed the files and wrote the lines so that every line number cite is the real one: `ingress.yaml` 9 and 11, `api.yaml` 21 and (after the fix) 28, `web.yaml` 17, 26 and 30, `admin.yaml` 19, 24 and 31, `queue.tf` 3, 12 and 20, `src/server.ts` 12 (after the fix), `tripcurve.yaml` 4 and 7. So the line numbers needed no change to the expected output.
- **After-fix state: both a second tree and a test.** `demo-fixed/` is a full tree, so a person can `cd` into it and run the tool (the README's third step), and `test/e2e/demo-sync.test.ts` applies the documented edits (`FIX_EDITS` and `TRIPCURVE_YAML` in `test/support/demo.ts`) to a temp copy of `demo/` and compares it, byte for byte and file for file, with `demo-fixed/`. Each edit must match exactly once, so a change to `demo/` that breaks an edit fails the test. I chose this over a patch file because a patch needs `patch` or `git apply` and a clean tree; the second tree needs nothing, and the test is what keeps it honest. Cost: 15 duplicated small files.
- **Expected files.** I first wrote both from the design mockups M1 (the first run) and M2 (the run after the fixes; M2's `<MEASURED>` replaced by 66 after checking the KB entry `node-explicit-keepalive-22x`, range `>=22.12.0 <23.0.0`, measured at K = 7, 12 and 65 s on 22.12.0, 22.18.0, 22.19.0, 22.23.2 and 22.23.5; `node:22.23` is inside it). I then ran the built CLI and replaced them with the real output, never hand-edited. Before writing them I had already run the built CLI once on the new `demo/` to check line numbers, so the first-run file was not written fully blind; the copy written from the mockup was kept and diffed (below).
- **Differences from the design mockups, each decided by the order of the design documents** (requirements, stories, mockups, research notes, build plan):
  1. **M1 `web` T1 default line.**: `default: Node keepAliveTimeout 5 s + buffer 1 s (Node 22.x from 22.19; measured on 22.23.2)`. Real: `default: Node keepAliveTimeout 5 s + 1 s (Node 22.x from 22.12; measured on 5 releases from 22.12.0 to 22.23.5)`. B3 measured that the extra second is older than the buffer property and widened the range (research section 14), so the mockup is stale. The expected file follows the code.
  2. **M1 Assumptions.** The real list has three more bullets: `The gunicorn and uvicorn versions are taken from "requirements.txt".` (the maintainer's 2026-11-11 decision), `The container's working directory is taken to be ".".` and `In-process drains of Python servers are not read; counted as 0 s.` (B4). The rule that every assumption actually used is listed means the code is right and the mockup, written before those rules, is stale. The EKS bullet and the zero-downtime bullet are as in the mockups.
  3. **Line wrapping.** The mockup's two hand-wrapped lines (the EKS assumption and the `Summary:` line) wrap differently from the renderer's greedy wrap at 80 columns (spec rule 5). Real output follows the renderer. The mockup's `api` T3 wrap likewise.
  4. **M2 PASS headline.**: `idle close 75 s is longer than 60 s`. Real: `idle close 75 s is longer than LB idle 60 s`, the form of every golden since B1 (B7 JSON and SARIF goldens include it). It changes nothing a check flags. I kept the code's wording; if the maintainer wants the mockup's form, it is a change in `src/evaluate/t1.ts` plus about 20 goldens.
  5. **M2 `web` T1.** `("src/server.ts":12)` becomes `("src/server.ts":12, keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5))`: the basis B3 prints (its required every printed basis to come from evidence). The value is 66, from the KB, not from the mockup note.
  6. **M2 `api` T1 (a code defect, fixed).** The first real run printed `PASS T1 idle close 75 s is longer than LB idle 60 s (explicit keepalive, uvicorn worker (gunicorn 26.x; measured from 3 to 300 s on 26.2.0))` with **no file and line**: the knowledge-base citation stood where the deciding source belongs, so a reader could not see that the 75 came from `k8s/api.yaml` line 21. say a PASS line names the source of the value being checked. Node's explicit `keepAliveTimeout` already did this (`decidedBy`); the Python explicit keepalive did not. Fix: the candidate for an explicit gunicorn or uvicorn keepalive sets `decidedBy` to the setting's source and `note` to the basis, so the line reads `("k8s/api.yaml":21, explicit keepalive, uvicorn worker (gunicorn 26.x; measured from 3 to 300 s on 26.2.0))`. Test first: two tests in `test/resolve/python-explicit.test.ts` (gunicorn and uvicorn alone) failed (`expected undefined to be defined`) and now pass. It changes what a PASS line cites, not what is flagged or what counts as pass; no existing golden changed. It still needs the adversarial review.
  7. **M1 `api` T1 and `admin`, `orders`, `web` T2 to T4 lines** match the mockup exactly, including `(gunicorn 26.x; measured on 26.2.0)`.
- **The end-to-end test** (`test/e2e/demo.e2e.test.ts`) runs the built CLI (the `.cache/e2e-build` the global setup makes) with `cwd` in `demo/` and `demo-fixed/` and compares stdout byte for byte, exit codes 1 and 0, and empty stderr. It also runs a copy in a temp folder (no absolute path in the output) and checks the README's claims against the expected files (so a README number cannot drift). **It can fail**, shown by mutation (both restored; the tests pass again, 21 of 21): `visibility_timeout_seconds = 60` to `61` in `demo/infra/queue.tf` and `--keep-alive 75` to `70` in `demo-fixed/k8s/api.yaml` together failed 12 of the 21 tests in the two files (the byte comparison of both expected files, the second-run and copy tests, the sync tests and the README test). Inside the test, the temp-copy mutations (visibility 61; the preStop taken off `api` again) assert the output changes.
- **The timed check** (`scripts/timed-check.mjs`, `npm run timed-check`, the last step of `npm run verify`): the demo (budget 2 s) and a generated 1,000-file tree (budget 30 s), the fastest of 3 runs each, with machine model, CPU, Node version and date. Details and the tree's shape are in `docs/limits.md`.
  - **Measured on this machine** (Apple Mac17,3, Apple M5, Node v22.23.2, 2026-11-12): demo 0.23 s; tree 1.75 s and 1.77 s in two full `npm run verify` runs. Both well inside the budgets, so no re-run was needed.
  - **The identity file** `scripts/timed-check-machine.json` holds `Mac17,3` and `Apple M5` from the real `sysctl -n hw.model` and `sysctl -n machdep.cpu.brand_string`.
  - **Skipped, never passed:** another model or CPU, or a missing `sysctl`, prints `timed check: skipped (not the recorded machine)` and exits 0, before anything is timed. Tested with stand-ins (`test/scripts/timed-check.test.ts`, 13 tests): skip on another model, another CPU and an empty PATH; within budget with a fast stand-in; failure over 2 s with a stand-in that sleeps 2.3 s; failure for a fast run that is not the expected report (a crash cannot look fast), for the right text with exit 0, for the after-fix text, and for a tree run that read fewer than 1,000 files; the generated tree has 1,000 files, the largest 4,777,841 bytes, and is removed afterwards.
  - **Not tested:** the 30 s tree budget failure (a 30 s test is not worth it; the code is the same comparison as the demo's); the real command is never timed inside vitest because that would make a test depend on the machine's load.
  - **Test-only flags** `--machine-file`, `--cli`, `--runs`, `--only` exist so the tests can run stand-ins. `verify` never passes them. `--runs` below 3 can only make the fastest time larger (stricter), and `--only` prints which part was not run.
- **Results:** `npm run verify` passed twice in a row (110 files, 12,013 tests, 96.61% lines). One Biome info (an old template-string suggestion) remains. No golden file changed.
- **Not done:** the independent adversarial review of B10; the hosted workflow has never run, and on Linux the timed step is skipped. The headline wording (item 4) is left for the maintainer.
- **B10 review 1: READY.** No Critical or Major findings.
  - **Sound:**
    - Every printed basis is exact: K = 65 000 was measured with the assignment form on all five 22.x releases, so the line's claim holds.
    - The fix that makes a PASS line cite the deciding source is correct for the CLI, `GUNICORN_CMD_ARGS` and `-c` file sources, checked by hand.
    - The T3 PASS with Python drains counted as 0 s is a recorded B4 decision and is listed under Assumptions.
    - The e2e test is byte-exact and can fail, and the sync test catches drift between `demo/` and `demo-fixed/`.
    - The timed check skips on any other machine and cleans up after itself.
  - **Minor findings, being fixed:**
    - the `decidedBy` tests cannot tell which source was taken;
    - the budget comparison is only checked by grepping the source;
    - a malformed identity file skips silently or crashes;
    - one test has a misleading name.
  - **Observations, being fixed:**
    - an overridden `--cli` is not marked in the output;
    - `uvicorn-worker` is missing from the demo's `requirements.txt`;
    - the B3 result records carry the date 2026-11-12 while the knowledge base says 2026-11-11.

### B10 review fixes (2026-11-12, head e524ccc; review READY with 4 Minor findings)

Not committed. `npm run verify` result is at the end of this section.

- **M1 (python-explicit tests could not tell which source `decidedBy` took).**
  - Before: both tests had the worker and `--keep-alive` on one line, so a `decidedBy` set to the worker's source passed.
  - Added: `GUNICORN_CMD_ARGS` (expect `k8s/app.yaml:22`, not the worker's `:20`) and a `-c gunicorn.conf.py` file (expect `gunicorn.conf.py:2`).
  - Mutation (`decidedBy` set to the worker step's source): 6 tests failed, the two new ones with `expected 'k8s/app.yaml:20' to be 'k8s/app.yaml:22'` and `expected 'k8s/app.yaml:20' to be 'gunicorn.conf.py:2'`. Restored: 36 of 36 pass.
- **M2 (budget test only grepped source).**
  - After: `overBudget(seconds, budget)` is exported and used for both budgets; `scripts/timed-check.d.mts` types it for the tests. Unit test at 1.99, 2, 29.99, 30.
  - Mutations: `>=` changed to `>` fails the edge test; `return false` fails it and the over-2 s test.
- **M3 (identity file).**
  - Before (run on the earlier script): `{}` printed `timed check: skipped (not the recorded machine)` and exit 0; `null` crashed with a TypeError.
  - After: both exit 2 with `timed check: the recorded machine file must be a JSON object with a non-empty "model" and a non-empty "cpu" (text)`. A skip prints `timed check: skipped (not the recorded machine: found "Mac17,3, Apple M5", recorded "Other,1, Other CPU")`; values are bounded to 80 printable characters.
  - 9 malformed-file cases plus a missing file, bounding and the no-sysctl text are tested. Mutation (validIdentity accepts any object): 8 tests failed.
- **M4:** the test is renamed `the recorded machine file in the repository names Mac17,3 and Apple M5`, which is all it checks.
- **`--cli` and other hooks.** Marked as described in `docs/limits.md`. Mutation (marker always empty): 3 tests failed (marker and "no `on the recorded machine`"). The default, unmarked path is exercised by `npm run verify` itself, not by a unit test, because timing the real command inside vitest would depend on machine load.
- **`uvicorn-worker`.** Added `uvicorn-worker==0.4.0` to `demo/requirements.txt` and `demo-fixed/requirements.txt` (B0 measured uvicorn-worker 0.4.0). Output unchanged: both runs diff clean against the expected files and the 21 e2e tests pass, so it stays.
- **B3 dates.**
  - Records: every line of `2026-11-11-b3.jsonl`, `-b3-versions.jsonl` and `-b3-points.jsonl` has `"date": "2026-11-12"`; the lookup file says 2026-11-12T05:51Z; the commit is dated 2026-11-12 01:05:39 -0600 (d05f0e2). The B0 records are 2026-11-11.
  - KB: 13 `measuredOn.date` values in `src/kb/data/node-idle-close.json` said 2026-11-11 against records dated 2026-11-12 (`node-idle-close-18x`, `-20x`, all ten `node-explicit-*`). Now 2026-11-12. `docDate` fields stay (the B0 lookup of `index.json` on 2026-11-11 is real).
  - Left at 2026-11-11: `node-idle-close-22x`, `-24x`, `-26x` (the release the date names was measured in B0 on 2026-11-11), although the lower releases in their ranges were measured on 2026-11-12. One date field cannot say both; for the maintainer.
  - Only `node-idle-close.json` changed in `src/kb/data/`. One golden moved (`test/golden/explain-t1.txt`, 12 date lines), explained in `test/golden/README.md` item 11. Notes added to `measure/README-b3*.md`; no result file renamed.
  - Also noticed, not changed: `docs/research.md` section 14's heading says `[lookup 2026-11-11]` and BUILD-NOTES B3 says 2026-11-11 for measurements the records date 2026-11-12.
- **B10 fix pass 1:** all four Minor findings and three observations are fixed.
  - **Mutation checks** (the new tests passed when written, because the fixes already existed, so a mutation of each fix shows the tests can fail):
    - `decidedBy` taken from the worker's source: 6 tests failed.
    - the budget comparison flipped or made always false: tests failed.
    - the identity-file check loosened: 8 tests failed.
  - **The timed check** marks every overridden flag "not the real check".
  - **`uvicorn-worker==0.4.0`** is added to the demo's `requirements.txt`; the output is unchanged.
  - **The B3 dates:**
    - the result records use UTC dates (2026-11-12), while the file names and earlier notes use local time (UTC-6, 2026-11-11);
    - 13 knowledge-base `measuredOn` dates were corrected to the records' UTC date;
    - research section 14's heading now states both dates;
    - `node-idle-close-22x`, `-24x` and `-26x` keep 2026-11-11, because their `measuredOn` release was measured in B0 on that date;
    - the `explain-t1` golden changed in 12 date lines only.
- **B10 review 2: MERGE.**
  - Every corrected date matches its records.
  - A malformed identity file now exits 2, and that breaks no `verify` path.
  - No override marker can be bypassed.
  - No new test is unable to fail.
  - **Nit, not fixed:** `--runs=3` and `--cli=x` (the `=` forms) are silently ignored, so the real check runs; they cannot fake a pass.

## B12 SAM and CloudFormation (2026-11-12)
- **The new reader.** `src/parse/iac/read-cfn.ts` reads YAML and JSON templates into the same model the Terraform reader fills, so T4 is unchanged. The golden `sam-t4.txt` matches the Terraform `orders` case.
- **Defaults.** Looked up on 2026-11-12 in `docs/lookups-b12.txt`: SQS visibility 30 s, Lambda 3 s, SAM Function 3 s, ALB idle 60 s, and an SQS batching window of 0 s. A default is used only when the template was read in full.
- **What makes the whole template UNRESOLVED.** The template is also listed as not checked when it has any of these:
  - a `Transform` other than `AWS::Serverless-2016-10-31`;
  - `Fn::Transform` anywhere;
  - a SAM resource without the SAM transform;
  - an unreadable `Type`.
- **SAM `Globals.Function.Timeout`** is read as a literal. A `Globals` section that is not a plain mapping makes every SAM function's Timeout UNRESOLVED.
- **What counts as a literal.** Only plain decimal digits in the source text: no hex, octal, exponent, sign, quoted number or tag.
- **Tags.** Short-form and unknown tags are rewritten to the long form, so `!Bogus 60` is never read as 60.
- **What is ignored.** Parameters, nested stacks, conditions and streams are UNRESOLVED. CDK code, `cdk.out` and parameter files are ignored (unknown files are ignored without comment).
- **Shared intake changes:**
  - Every `.json` file is now sniffed for a template, up to 5 MB.
  - A YAML template is recognised only by a top-level key, which closes an older hole where a ConfigMap could have been read as a template.
  - A path lookup that was quadratic in the number of mapping keys now uses a single walk.
- **Mutations.** 17 guard mutations were killed. One survivor is equivalent: the own-property check on `Resources`.
- **Not done:**
  - A CFN load balancer is not linked to an Ingress for T1, because has no form for that.
  - `--explain` does not yet list the CFN defaults.
  - What SAM's `Ref` returns for a function was assumed, not looked up.
- **Results:** 12,154 tests passed.
- **B12 review 1: NOT-READY.** No Critical findings, 2 Major, 3 Minor.
  - **Sound:**
    - No wrong T4 number and no false PASS across about 30 odd template shapes.
    - Every default was re-checked against the live AWS pages on 2026-11-12.
    - SAM's `Ref` of a function returns its name, confirmed in the SAM "Return Values" section, so the earlier assumption holds.
    - The output of 92 existing fixtures is byte-identical in text, JSON and SARIF after the intake `getIn` rewrite.
    - Hostile input gave no crash and no freeze.
  - **M1:** a template with a macro and no `Resources` was dropped silently, and the run said "All checks passed".
  - **M2:** an unreadable `.json` (permission denied, outside the root, too large, bad encoding) was treated as "not a template".
    - Fix: always report permission and outside-root cases. For size and encoding, use a bounded content sniff, not file-name heuristics: guessing from names is the deny-list pattern.
  - **Minor:**
    - `--explain` T1/T4 is now false: it says "read from Terraform" and lists no CFN defaults.
    - Two mutation survivors: the event-level `Condition` check and `Globals` without a Timeout.
    - Silent misses: indented top-level YAML keys, and `*.template` files.
    - Wording: `terraform-not-read` shown for a template, and "YAML syntax error" for a JSON duplicate key.
    - The Lambda 900 s cap: the live page now mentions 5,400 s for Managed Instances. Keeping 900 gives UNRESOLVED, which is conservative.
- **B12 fix pass 1** (commit 88c35a4): both Major findings (M1, M2) and all the Minor findings are fixed.
- **B12 review 2: NOT MERGE.**
  - **R1 (Major), a regression.** The new any-indentation candidate rule makes non-template YAML a candidate, and in cfn mode its anchors are refused as `cfn-unreadable`. A `serverless.yml`, a compose file or a GitHub workflow with anchors makes a clean run unclean, and parsing every candidate made such trees 5 times slower.
    - Fix: test the parsed shape first, and re-parse in cfn mode only when the file really is a template.
  - **R2.** Dangling or outside-root `.json` symlinks are now reported.
    - Decided: keep reporting them, as YAML does. A link cannot be sniffed, and an input of a class tripcurve reads is never ignored silently.
    - **For the maintainer:** confirm.
  - **R3.** The sniff misses UTF-16 templates and markers past 64 KB.
    - Fix: report a file with a UTF-16 BOM or NUL bytes, and widen the sniff window to 1 MB, the documented deploy limit.
  - **R4:** document the new reason codes.
  - **R5:** `incompleteTemplates` has no consumer yet.
  - **Mutation survivors:** two in `isCfnTemplateValue`.
- **B12 fix pass 2** (1e21a77):
  - **Template detection:** a cheap scan for a template key at the document's own indentation, then an ordinary parse to check the template shape, and a cfn-mode parse only for real templates.
  - **The file sniff:** reads up to 1 MB; a NUL byte or a UTF-16 BOM means the file is reported.
  - **Reason codes:** documented.
  - **Two mutation survivors:** killed.
- **B12 review 3: MERGE.**
  - **Non-template YAML is quiet again:** Serverless, Compose, workflow, Helm, Ansible, OpenAPI and cdk.json files give output identical to main.
  - **No slowdown:** the timed tree is level with main when timed side by side (about 5.3 s at load 12). The earlier 4.97 s was machine load.
  - **Carried Minor findings, fixed before the merge:**
    - a flow-style template with unquoted keys was missed silently;
    - four scan branches had no test (CRLF blank line, second document, `%` directive, a `Resources`-only file).
- **B12 fix pass 3:**
  - A flow-style template with unquoted keys is now read.
  - Tests now cover the CRLF blank line, the second document, the `%` directive and a file with only `Resources`.
  - Every mutant of the new code is killed, except the equivalent directive-branch mutant.
  - **Process slip:** the developer's mutation script edited the worktree in place, and I killed it by mistake. It left one mutant (`return resourcesOnly;`). The developer found it by diffing and restored it. Mutations now run only in a scratch copy of the tree.
- **B12 final check: MERGE.**
  - Output is identical to before on all fixture directories.
  - Ordinary flow-style YAML (Helm values, OpenAPI, configs) is still silent.
  - A real flow-style SAM template is read with the right values and lines.
  - Newly reported: only broken or unreadable files that carry the template markers, the same terms block-style files already get.
  - **Minor, not fixed:** in `couldBeCfnFlow`, the `AWSTemplateFormatVersion` and `Transform` clauses overlap the `Resources` + `AWS::` clause, so neither is pinned by its own test.

## B8 Measurement harness lanes (2026-11-12)
- **What was built:** `measure/lanes.mjs` with a pinned lane and a latest lane (`npm run verify:measure` runs the pinned one), plus `measure/lib/lanes-core.mjs` and 73 or more tests in `test/kb/lanes.test.ts`, written first.
  - Each knowledge-base entry gets either a script run against its recorded versions or a printed stated reason (`NOT RUN`). A gap fails the lane. So does a `to be measured` entry: it is listed as a release blocker.
  - Nothing is retried. A lookup that does not return HTTP 200 stops the lane with exit 4, and is never read as "nothing newer".
- **Results:**
  - The pinned lane passed: 110 of 110 cases, 36 entries measured, 9 with a stated reason.
  - The latest lane passed 65 of 65. The newest releases found on 2026-11-12 are the pinned ones, so no drift was found.
- **Corrections made before review:**
  - The first runs used `--jobs=4`, then `--jobs=2`. Choosing 2 after a failure at 4 was a setting picked after seeing a result, so the default is now `--jobs=1` for a reason that holds before any run: timing measurements must not share the CPU. A higher value prints a skew warning. The earlier runs are kept as evidence.
  - Three tolerances failed the latest lane, and the reruns showed run-to-run variation, not drift. They were re-derived with the stated rule (largest observed deviation plus resolution) over all recorded observations:
    - gthread explicit keepalive: the deviation grows with the value (+24 ms at 7 s, +137 ms at 75 s, +589 ms at 300 s), so it stays relative, now 0.004 (was 0.002).
    - uvicorn explicit graceful: 208 ms (was 160).
    - No `src/` code reads a tolerance for a verdict. `test/kb/tolerance-evidence.test.ts` recomputes the tolerances from every results file.
- **Open maintainer question:** lightship 9.1.0 hard-codes `host: '0.0.0.0'` for its status server (`createLightship.ts`, lines 153 to 156). It offers no host option.
  - Effect: the B4 lightship measurement listens on all interfaces, on a random port, for a few seconds.
  - This departs from "localhost only". It is recorded in `docs/limits.md` and not hidden.
  - Choices: accept it, or drop the lightship line from the lanes.
- **B8 review 1 (NOT-READY):** no Critical findings, 3 Major, 9 Minor.
  - **Sound:**
    - Comparisons are two-sided and the version is checked; a failing script is always a FAIL.
    - Mutation testing on `lanes-core` killed 47 of 49 mutants; the two survivors are trivial.
    - The tolerance derivation is reproducible.
    - A 403 or 429 on a lookup exits 4.
    - Scripts run without a shell, with a restricted environment.
  - **M1:** the runner half (`lanes.mjs`) has no tests: 10 mutants survived, including the exit 4 on a lookup failure, the checksum check and the script exit codes.
  - **M2:** `notMeasurableLocally` was accepted on any entry. In the repro, a Node entry with value 99 and a reason gave LANE PASS.
    - Decided: a reason is allowed only for `documented` entries about services that cannot run on localhost (an allowlist).
    - The three old-Node `headersTimeout` entries become `DEFERRED (B13)`.
    - **For the maintainer:** the four AWS/Terraform default entries go beyond the letter of the decision (which names ALB idle and Kubernetes grace).
  - **M3:** the resolution rule (refuse a tolerance below the resolution) was not implemented. The lightship tolerance (10 ms) is below its poll interval (20 ms).
  - **Minor:**
    - **m1:** at 300 s the gthread tolerance cannot see a 1 s error. Fix: a per-K tolerance, derived only from `--jobs=1` runs.
    - **m2:** the observation counts were wrong.
    - **m3:** a cached Node was called "checksum-verified".
    - **m4:** wording of the summary counts and partial runs.
    - **m5:** an empty release list was read as "nothing newer".
    - **m6:** `--only-binary :all:` was missing.
    - **m7:** a misleading comment in the lightship script.
    - **m8:** two cases do not read back what they ran.
    - **m9:** the planner dropped mappings it did not know, silently.
- **B8 fix pass 1:** all 3 Major and 9 Minor findings are fixed, each with a test seen red first.
  - **M1, the runner:** it is now an injectable module, `measure/lib/lanes-runner.mjs`, with 44 tests. Every listed mutant is killed. Each lookup URL is tested with 403, 404, 429 and 500 responses.
  - **M2, stated reasons:** a reason is allowed only for `documented` entries with an allowlisted subject and runtime. The old-Node `headersTimeout` entries carry `deferredTo: B13` and print `DEFERRED (B13)`, and `--explain` now says "deferred to B13: not measured".
  - **M3, the resolution rule:** it is enforced. The lightship tolerance was re-derived to 24 ms.
  - **m1, tolerances per measured value:** gthread uses 22, 138 and 903 ms at 7, 75 and 300 s, so a 1 s error fails at every value. Only runs taken one at a time count as a basis for a tolerance. Every result file is classified as basis or evidence, and the test fails on any file that is not classified.
  - **Node tolerances:** re-derived with the same rule. One entry goes 5 to 7 ms, three go 5 to 4, and all stay under 100 ms. The official pinned lane, rechecked against the new tolerances, passes 110 of 110; the smallest margin is 1 ms.
  - **Host load:** the lane now prints the host load at start and end. A run on a busy host does not count as official.
  - **Official results:** the pinned lane passed 110 of 110 (54 min, load 2.4 to 1.2), and the latest lane passed 65 of 65 with no drift.
- **For the maintainer:** a narrow tolerance means a lane run on a busy machine can fail. Such runs are recorded as evidence and are never used as a basis.
- **B8 merge of main (B9, B10, B12):** conflicts in `package.json`, `src/kb/schema.ts`, BUILD-NOTES and `docs/limits.md`, all resolved.
  - **Allowed reasons:** the three CloudFormation default entries from B12 carry a stated reason, so they were added to the closed reason list (runtime `cloudformation`). The old-Node subject stays off that list, since those entries are deferred.
  - **Two tests** that listed the six reason entries now list nine.
  - **For the maintainer:** confirming the widening now covers seven entries.
  - **Process slip:** I ran `npx biome` in the main checkout, which has no `node_modules`. npx fetched and ran an unrelated registry package, `biome@0.3.3`, an environment-variable manager with no install scripts. Its only effect was an empty `~/.biome` folder; that folder and the npx cache entry are removed. From now on tools run only from a worktree's `node_modules`.
- **B8 review 2: NOT-READY.**
  - **Sound:**
    - the runner is a real thin wrapper, and its CLI paths were exercised;
    - 33 of 41 mutants were killed;
    - the resolution rule holds;
    - the reason allowlist holds;
    - all 16 Node tolerances recompute independently.
  - **B1:** `deferredTo` had no subject or runtime limit. In the repro, a Node entry deferred to "B99" still gave LANE PASS. Fix: a closed list, so only the old-Node `headersTimeout` subject with basis `from-changelogs` may be deferred.
  - **B2:** the busy-host rule was printed only. Fix: sample the load before every case. A busy run that passes prints "not an official run" and exits 5.
  - **Minor:**
    - the basis test must read the files' load lines;
    - the run with unknown load becomes evidence, not basis;
    - a stale line in `docs/limits.md`;
    - every planned value must have its own per-value tolerance;
    - the coverage checks are partly tautological;
    - drift lookups must cover deferred and reasoned runtimes;
    - restore the SIGKILL fallback on interrupt.
- **B8 fix pass 2** (350014e):
  - Deferral is a closed list: only the old-Node `headersTimeout` entries.
  - The load is sampled before every case. A passing run on a busy host prints "not an official run" and exits 5.
  - A basis file must have non-busy load lines.
  - run1 (unknown load) is evidence only, which tightened two tolerances: uvicorn graceful 229 to 214 ms and Node explicit-keepalive 22.x 7 to 5 ms. All official lines still pass.
  - Every planned value needs its own tolerance.
  - Three tautological coverage checks were removed.
  - Drift lookups now cover every runtime.
  - Process groups get SIGTERM, then SIGKILL.
- **B8 review 3: MERGE.**
  - Every new guard was killed by a mutant.
  - No busy run can end in a plain exit-0 PASS.
  - The 1 ms minimum margin comes from the tolerance rule by construction; the comparison is `<=`, not an off-by-one.
  - Small items fixed before the merge:
    - the per-case timeout now kills the whole process group;
    - a test for an interrupted script that exits 0;
    - the README exit-code line;
    - a note on the limits of the load rule;
    - B15's release checklist must name every deferred entry.

## B13 Old-Node measurement under Rosetta 2 (2026-11-12)
- **Result:** nothing was measured, because the old Node versions cannot run on this host.
  - `arch -x86_64 /usr/bin/true` gives "Bad CPU type in executable".
  - The Rosetta folder is absent, and `oahd` is not running.
  - nodejs.org `dist/index.json`, read 2026-11-12 at about 20:00Z, lists only x64 macOS builds for 10.15.x, 12.18.x and 13.12.x. The first `osx-arm64` build is v16.0.0.
- **Nothing installed or downloaded.** Installing Rosetta 2 is the maintainer's decision.
- **The three `node-headers-trap-*` entries:**
  - keep basis `from-changelogs`, printed as `from changelogs, not measured`;
  - stay `DEFERRED (B13)`;
  - have a deferral reason that now names the attempt record, `measure/results/2026-11-12-b13-attempt.txt`.
- **Golden:** `explain-t1` changed in those three lines only.
- **For the maintainer:** to measure them, install Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`) or provide an x64 or arm64 Linux host.
- **B13 review: MERGE.** Every claim in the attempt record was re-run and confirmed on 2026-11-12 at 20:07Z, and the tests can fail. I also fixed a stale paragraph in `docs/limits.md`: it said six entries carry a reason (there are nine) and that `--explain` prints "not measurable locally" for the deferred entries (it prints "deferred to B13: not measured").
- **Flaky B8 test fixed during the B13 merge.** `lanes-runner.test.ts` checked that a killed process was gone immediately, but the OS reaps a killed process shortly after the signal, so under load (load average 11.5) the check failed once. All four liveness checks now poll for up to 3 s (`goneWithin`). The fake grandchild never exits on its own, so the test can still fail: a mutant that SIGKILLs only the direct child, not the group, fails the grandchild test (run in a scratch copy). Four orphaned fake processes from test runs were found and killed.

## B15 Docs and release checks (2026-11-12)
- **Docs written:** README, `docs/rules.md`, `docs/how-defaults-were-measured.md`, `docs/add-a-knowledge-base-entry.md`, `docs/ci-and-sarif.md`, `docs/security.md`, `docs/release-checklist.md` and `CHANGELOG.md` (0.1.0, unreleased).
- **`test/docs/docs.test.ts` (96 tests) checks that:**
  - every Mermaid block has a text fallback;
  - every vendor quote appears word for word in its cited file, with a date;
  - every number with a unit appears in a file the same paragraph cites. This catches a number that no cited file contains; it does not prove the sentence true;
  - the 6-of-26 result always appears beside its limit;
  - there is no licence text;
  - `src/` imports no process or network module.
- **Release checks run locally** (full table in `docs/release-checklist.md`):
  - `npm run verify` passed.
  - The pinned lane passed 110 of 110 on a quiet host.
  - The npm name `tripcurve` is still free (E404 at 2026-11-12T21:09Z).
  - `npm audit` is **not clean**: 3 moderate findings, all one `minimatch` advisory reached through `ts-morph` 28.0.0. That is an open maintainer decision.
  - One dev-only optional package, `fsevents`, is flagged `hasInstallScript`. The production tree has 0 install scripts.
- **Open maintainer questions:** every open question is collected in the checklist, each with the bolt it came from.
- **Stale text found:**
  - `docs/research.md` sections 3, 8 and 10 differ from what was built, and the docs follow the code.
  - A maintainer-only project note still said the project had not started; it is not part of this repository and was left alone.
- **Fixed in the merge:** the lanes README said six entries carry a reason; it now says nine.
- **B15 review 1: NOT-READY.** One Major finding and seven Minor ones.
  - **Sound:**
    - About 40 claims checked against their sources and the built CLI.
    - The release checklist is honest: nothing marked done that was not run, and `npm audit` is reported as not clean.
    - All 32 maintainer questions are present.
    - The knowledge-base guide can be followed.
    - The security and SARIF docs match the code.
  - **M1:** `docs/security.md` said the Action has "no registry fetch to hijack", but `npm ci` downloads every locked dependency. The real protections are the lockfile integrity hashes, exact pins and `--ignore-scripts`.
  - **Minor:**
    - a wrong count of Node tolerances;
    - a quote attributed to the wrong pull request;
    - stale verify figures in the checklist;
    - inconsistent statements about the lanes;
    - a "never reads or prints secrets" heading broader than its evidence;
    - absence claims without dates;
    - docs checks that miss realistic errors: a wrong number found elsewhere in a large file, variants of "6 of 26", and claims of a hosted run outside the README.
- **B15 fix pass 1** (0c8032c):
  - The supply-chain wording is accurate.
  - The Node tolerance counts are computed from the data.
  - The PR attribution is corrected.
  - The verify figures and lane statements are consistent, and the B15 pinned run is saved as evidence.
  - The secrets heading is narrowed. A manual probe found that only waiver reasons are printed; the doc says not to put secrets in files tripcurve reads.
  - The absence claims are dated.
  - The number check is bound to units.
- **B15 review 2:** one blocker. The check against claims of a hosted run or a release was a deny-list of phrasings, so "available on npm" and "ran green on hosted runners" passed.
  - Fix: an allow-list. Every sentence in the docs that touches the topic must match an approved list exactly, so any new claim fails until a person reads it.
  - **Known limit, accepted:** the number check passes a wrong number that happens to appear with the same unit elsewhere in the cited file. The test comments say so.
- **B15 fix pass 2:** the check against claims of a hosted run or a release is now an approved-sentence allow-list.
  - 300 sentences were read and approved.
  - Three old sentences were reworded, not approved. Two of them only gained a hedge in parentheses in `docs/research.md`; no fact changed.
  - A second test fails when an approved sentence no longer occurs in the docs.
- **B15 review 3: MERGE.**
  - All planted claims fail.
  - Claims in table cells, headings, code spans and HTML comments are caught.
  - **Known limits, not fixed:**
    - a claim inside a fenced code block is not scanned;
    - a claim worded with no topic word ("It has been run on the machines") cannot be caught by any word-list check.

## B14 Real-repository check (2026-11-12)
- **Approval:** the maintainer approved the four recommended candidates on 2026-11-12.
- **Copies:** trimmed copies of the four repositories, each with its upstream LICENSE and a NOTICE (source URL, commit, date). The copied files are byte-identical to upstream; secret-like files were left out.
- **Results:** no false PASS, no false FAIL, no crash. One real T2 FAIL (peermetrics web: no preStop hook). Most other results are honest UNRESOLVED, for these reasons:
  - Terraform is linked within one file only, but real modules are split across the files of a folder;
  - Terraform arithmetic is not evaluated;
  - an import of `express` blocks the claim that there is no drain;
  - the image is built by no file in the repository;
  - `envFrom` on the container.
- **Tests:** `test/e2e/real-repos.e2e.test.ts` compares all four byte for byte. The results table is in `test/fixtures/real/README.md`.
- **Found and handed to B17 to fix:**
  - folder-scoped Terraform linking (Terraform's own module rule);
  - exact integer arithmetic on Terraform literals;
  - `express` added to the drain allow-list on source evidence;
  - a `--config` path outside the root is printed absolute and exposes the home directory;
  - the `runtime.node` hint is shown for an image that is not Node.
- **B14 review: MERGE.** Every copied file is byte-identical to upstream at the recorded commit (checked with `cmp`). No secret value was copied. Every verdict was judged correct against the real files. The e2e test can fail. The minor findings are already handed to B17.

## B17 Real-repository findings (2026-11-12)
The maintainer delegated these changes on 2026-11-12. The record is in `CHANGELOG.md`, `docs/limits.md`, `test/golden/README.md` (items 14 to 16) and `test/fixtures/real/README.md`.

- **Folder-scoped Terraform linking.** A module is a directory: Terraform docs, read 2026-11-12: "nested directories are treated as completely separate modules". References now resolve across `.tf` and `.tf.json` files in the same folder, never into a subfolder or a `module` block. Duplicates, variables, `count`, `for_each` and override files stay UNRESOLVED.
- **Exact integer arithmetic on Terraform literals.** Only `+`, `-`, `*`, parentheses and decimal literals, on one line, with at most 64 tokens and 8 levels of nesting, every intermediate a safe integer, and the result inside the documented range. The value shows its expression, for example `visibility 240 s = "60 + (30 * 6)"`.
- **T4 FAIL without the window.** When visibility is less than 6 x timeout, T4 FAILs even with the batching window unset or unknown, because any window only raises the need. At or above 6 x timeout with no window, the result stays UNRESOLVED.
- **`--config` paths.** A `--config` outside the root is printed as typed; it no longer exposes the home directory.
- **Setup hint.** The hint is now neutral. For Python, only the container command identifies gunicorn or uvicorn; a `dockerfile:` or `gunicorn_config:` declaration alone does not (checked on a copy of the peermetrics `api` workload).
- **Real repositories re-judged** against the upstream files:
  - publikes: T4 PASS (240 >= 240).
  - DanielDaCosta: T4 FAIL (30 < 180), a real misconfiguration.
  - Hints only changed for the rest.
- **Mutations:** 13 mutants run in a scratch copy; all are killed.
- **Results:** 12,774 tests passed.
- **B17 review 1: MERGE.**
  - No false PASS or false FAIL. Both real-repository verdicts were confirmed against the upstream files.
  - Minor findings, fixed with tests:
    - **A single Terraform file given as the root.** Every resource read from it is now UNRESOLVED ("only one file of the module was given"), because a sibling override could change any value.
    - **The `passBlocker` guard on the window-free FAIL** is now pinned by two more tests.
    - **The refusal text** for a refused numeric attribute is now accurate.
    - **The SARIF location of a `--config` file outside the root** is now a `file:` URI of the real path. The human report and JSON keep the path as typed, so the resolved path appears only in SARIF (documented).
- **B17 review 2: MERGE.**
  - The single-file rule touches only Terraform read from source: a `.tf` or `.tf.json` given alone. A SAM template, a K8s YAML or a plan JSON as the root is unaffected.
  - The SARIF `file:` URI follows SARIF 3.4.3 and 3.10.
  - The human report and JSON contain no resolved path.
  - **Known limits:**
    - a `--config` that does not exist outside the root is still located under SRCROOT by its typed path;
    - SARIF now carries the resolved path of a `--config` outside the root. That belongs in the release notes, because SARIF files are often uploaded.

## B16 Release fixes (2026-11-12)

- **Built on `bolt/b16-release-fixes`.** The main session committed 2774245 (an npm `overrides` entry pins `minimatch` to 11.0.8). This build session did the rest; it did not commit.
- **Clean audit documented.** `npm audit` printed `found 0 vulnerabilities` at 2026-11-12T23:06Z; `require('minimatch').minimatch` works from `@ts-morph/common`'s directory; the lockfile has 123 packages, all with integrity hashes, and only `fsevents` has an install script. Written in `docs/release-checklist.md`, `docs/security.md`, `docs/limits.md` and `CHANGELOG.md`.
- **Node compatibility.** Full suite, build and demo on Node 22.12.0, 22.23.5, 24.22.3 and 26.13.1; Node 20.20.2 and 18.20.8 print the unsupported-Node message and exit 2. The table is in `docs/release-checklist.md`.
  - **Failure found on Node 24.22.3 (two scaling tests, ratios 8.05 and 11.1):** linear work with one cost jump at one size. `scalingRatio` now also measures the step below when the first two measurements breach, and keeps the lowest ratio; the test with a simulated clock failed first (12 against 8). Quadratic work still breaches.
  - **Failure found on a second Node 24.22.3 run (`timed-check.test.ts`):** the test compared a shared temporary folder before and after, and was vacuous for the script's own folder. Fixed with a private `TMPDIR`; a mutant without cleanup is now caught.
- **Platform audit.** No `process.platform`, `os` or `win32` in `src/`; paths are `/` paths and the link stage uses `path.posix`. One finding: a `localeCompare` on unchecked reason codes, now `compareBytes`, with `test/platform/portability.test.ts` failing on it first. Linux was not run.
- **SARIF.** The official 2.1.0 schema (draft-04, validated with `ajv-draft-04` and `ajv-formats` in a scratch folder, `--ignore-scripts`) accepted every SARIF golden and the SARIF of `demo/` and `demo-fixed/`, and rejected four broken copies. Not vendored. Record: `docs/release-check-run-b16.txt`.
- **Decisions of 2026-11-12** (the maintainer said small things are decided by the build session) are in `docs/release-checklist.md`, "Decided on 2026-11-12". No behaviour changed for them. The npm publish, the name, the first hosted CI run and the SARIF upload stay open (external writes). Row 17 and B14 were not touched.
- **Not done:** the independent review of B16; any run on Linux; the install-script question for `fsevents`; the `measuredOn.date` question, the CloudFormation load balancer link and the B14 candidate list, which no instruction covered.
- **B16 review 1:** no Critical findings, 1 Major, 2 Minor.
  - **Sound:**
    - The `minimatch` override cannot be reached from tripcurve's use of ts-morph, which uses only an in-memory project.
    - `npm audit` reports 0 vulnerabilities.
    - The Node 26 suite and the official-schema validation were re-run and confirmed.
    - The timed-check test can fail.
  - **M1:** the docs reworded the SARIF-validation requirement instead of recording a deviation.
    - Fix: record the deviation under the fallback in the build plan (outside this repository). The schema's licence is the OASIS IPR policy (RF on RAND), read 2026-11-13T00:01Z. The project copies third-party files only under MIT, Apache-2.0 or BSD.
  - **m1:** the new lower-step remeasure in `scalingRatio` let work that is linear and then quadratic pass.
  - **m2:** the portability test claims more than it scans.
- **B16 fix pass 1** (review findings):
  - The requirement is quoted with its approved wording again. The deviation is recorded under the fallback, with the OASIS licence quote.
  - The `scalingRatio` lower-step remeasure is accepted only when the breach is below 16. Simulated work that is linear and then quadratic now fails.
  - The portability scan is widened, and a test checks the walk order.
- **Timed check on a busy host** (main session, 2026-11-13):
  - **Found:** a verify run measured the demo at 2.25 s at load 72; other sessions' mutation runs and the docs dry run were loading the machine.
  - **Rule:** the same busy rule as the lanes. A time within budget on a busy host still counts, and a wrong report always fails. Only an over-budget time on a busy host prints "skipped (host busy ...)" and exits 0; it never prints "within budget".
  - **Tests:** a `--load` test hook, marked as overridden. Four new tests; a scratch-copy mutant that makes `hostBusy` always false fails two of them.
- **Timed check: wait for the load to settle** (main session, after the second B16 review, F1).
  - **Problem:** verify runs its tests on every core just before the timed check, so the 1-minute load was often still above half the CPUs, and a real slowdown would have been skipped.
  - **Fix:** before timing, the script now waits up to 2 minutes (2 s steps) for the load to fall to half the CPUs or less. Load that verify itself made fades in that time; only lasting load can make an over-budget time "skipped".
  - **Tests:** they pass `--load 0` by default, so they never wait.
- **The metric-5 dry run (2026-11-13).** A fresh session given only the docs added a Node 25 entry in a scratch copy, which was not merged.
  - **Result:** partial success. The entry, its tests, its lane run and verify all passed, but the tolerance stayed provisional because the host never got quiet.
  - **Friction fixed in B16:**
    - a busy-host paragraph and the rule for naming busy result files;
    - a checklist of every place a new entry touches;
    - the odd-line policy;
    - notes on `.cache/e2e-build` and `dist/index.json`.
  - **Tests:** the counts and lists are now computed from the data, so a new entry fails only where a person must act.
  - **Decision:** an entry may not be added until a quiet basis run exists.
- **B16 final check: MERGE.** The settle wait works: a slowdown on a machine that quiets down FAILs, and only load lasting more than 120 s gives "skipped". The data-derived tests still fail on planted data changes. Two stale checklist lines were fixed before the merge.

## B18 Flush before exit (2026-11-13)
- **Found:** in the final fresh-checkout check, the full suite on Node 22.12.0 failed once under heavy load (load average about 38). `lanes.mjs pinned --list` (16,662 bytes) reached the test without its later lines: the entry on line 83 of about 110 was missing, though the exit code was 0. Quiet re-runs passed three times out of three.
- **Cause:** a write to a pipe on macOS can be queued when the pipe is full, and `process.exit()` drops queued writes. `measure/lanes.mjs` ended with `process.exit(code)` straight after printing.
- **Fix:** `measure/lib/exit-after-flush.mjs` writes an empty chunk to stdout, then to stderr, and exits in the last callback, so every earlier write has reached the OS. The CLI itself was already safe: it sets `process.exitCode` and never calls `process.exit`.
- **Tests:** held-write unit tests, plus a check that `lanes.mjs` ends through the helper. The check was seen red on the old `lanes.mjs`.
- **Limit:** the truncation itself cannot be reproduced on demand, because macOS grows the pipe to 64 KiB when it can.
- **B18 review: MERGE.** Checked on Node 22.12.0 and 26.13.1: a slow reader receives the whole output; EPIPE, closed fds and `/dev/null` all exit with the right code; the 40 s signal timer is unchanged; the test fails when the helper does not wait. **Optional follow-up:** the `measure/summarize-*` scripts also end with `process.exit` after printing one line per result row; their output is small.

## B19 Ready for the first hosted run (built 2026-11-13)

- **Files:** `action.yml` (input `upload-sarif`, default `"false"`; the upload step's condition is `always() && inputs.upload-sarif == 'true' && steps.check.outputs.sarif-file != ''`), `.github/workflows/verify.yml` (matrix: ubuntu-latest with Node 22.12.0, 24, 26; macos-latest with 22.12.0; `fail-fast: false`; `persist-credentials: false`), `.github/workflows/action-selftest.yml` (jobs clean, failing, upload), `action/dry-run.sh` (simulates the three jobs; never the upload), `docs/lookups-b19.txt`, `docs/action.md`, `docs/ci-and-sarif.md`, `docs/security.md`, `docs/release-checklist.md` (rows 12 to 14), `CHANGELOG.md`, `test/docs/approved-release-sentences.txt`, and tests `test/action/action-file.test.ts`, `test/action/workflows.test.ts` (new), `test/action/dry-run.test.ts`. All written test-first and seen red.
- **Decisions:** the upload job is guarded by `github.event.repository.visibility == 'public'` and by push or same-repository pull request. The action-selftest `upload` job cannot detect a failed upload (the Action step has `continue-on-error`); the upload result is read in the log and on the code-scanning page.
- **Not done:** nothing ran on GitHub. The independent adversarial review of B19.
- **B19 review: MERGE.** The workflow security is clean: push and pull_request triggers only, least permissions, no `${{ }}` in any run body, SHA pins, `persist-credentials: false`, and no write token for fork pull requests (GitHub docs, read 2026-11-13). A Linux run under Node 22.12.0 passed, apart from one test that only fails when run as root. **Follow-ups applied:** the upload job skips Dependabot (its token is read-only), and the docs now say `upload-sarif` is compared without regard to case. **Not changed:** the self-test upload publishes the demo's findings as code-scanning alerts on each push. That is intended: it shows the upload working.

## B20 Publication clean-up (2026-11-14)
- **Why:** the maintainer decided to publish the source at https://github.com/naren-ambati/TripCurve. The design-process files and the maintainer's project notes stay outside the public repository, so every published file has to stand on its own, and nothing personal may leave this machine.
- **Leak guard:** `test/docs/publication.test.ts` scans every file that would be published (names and contents) for design-process references, home and scratch paths, the maintainer's machine name, e-mail addresses and token shapes. It went from 45 hits to 0. The local export script re-runs the same scan and refuses to proceed on any hit.
- **Redactions:** 12 measurement records carried the repository's absolute path; they now say `<repo>` (and `<scratch>` for a temporary folder) with a first-line note. No measurement value changed.
- **Prose:** requirement and decision ids from the design documents were removed or restated in words; the design documents are named once per page as kept outside the repository. "owner" became "maintainer".
- **Package metadata:** `repository`, `homepage`, `bugs`, `keywords`, `author`; `private: true` and `license: UNLICENSED` unchanged (pinned by a test).
- **Review 1 (NOT READY):** no leak and no behaviour change (byte-identical CLI output against `main` on the demo and the real repositories), but three sentences still named the maintainer's notes file, the contributor guide repeated private rules ("never push") as if they applied to contributors, about 100 sentences were damaged by the id removal, and the export script could have wiped any checkout given a wrong path.
- **Fix pass:** all of it fixed; the export script now requires a clean target whose `origin` is the public repository (or a fresh `git init`) plus `--yes`, and prints what it will delete. The guard has two named, narrow exemptions: one generic phrase in the verbatim report extract, and the public ignore file, which lists the folders it ignores.
- **B20 review 2:** the guard caught the maintainer's own new log section, which named the excluded folders; reworded. Export clean (658 files), docs tests green, CLI output byte-identical to before. **Verdict: MERGE.**

## B21 Fixes from the hardcore local testing (2026-11-14)
Two black-box testing passes ran before publication: one over the CLI (46 flag cases, 52 repository inputs and 91 hostile cases in all three formats, 600 fuzz runs, the official SARIF schema, memory and concurrency, Node 22.12 to 26) and one over the fresh-user path (every command in the docs, the packed tarball, the Action dry runs, a clean-machine install).
- **Found (Critical): a Node/TypeScript source under the 5 MB limit hung the tool.** A 4.8 MB file of `var a = 1;` lines did not finish in 100 s at about 1 GB. Cause: a per-statement call into TypeScript's binder (`isExported()`), quadratic in the number of statements. Fixed by reading export syntax directly; a measured bound of 500,000 parsed nodes (about 1.7 MB of ordinary code, derived from 3 to 4 microseconds and 0.4 to 0.5 kB per node) now lists a larger source as `source-too-large` with T1 UNRESOLVED and no absence claim. After: 4.8 MB in 0.9 s.
- **Found (Critical): Kubernetes manifests in JSON, with quoted keys or in flow style were skipped silently**, so a Deployment that FAILs T1 as plain YAML made the run "All checks passed" as `web.json`. Cause: a text regex for a plain `apiVersion:` line. Fixed: manifests are decided by parsed shape in every form; broken files of those forms are listed as parse errors.
- **Found (Minor): a syntax error in a linked source was not named.** Now listed as `source-parse-error` with its first error line.
- **Packaging:** `npm-shrinkwrap.json` replaces `package-lock.json`; source maps no longer ship; the workflows run once per change (`push` on `main`, every `pull_request`); the lanes' `--only` on an entry that cannot be measured says NOT RUN and exits 2 instead of "LANE FAIL 0 of 0".
- **Not fixable here:** a consumer who installs the packed tarball still gets the vulnerable `minimatch`, because npm overrides do not ship and ts-morph's declared range excludes the fixed major. The package is private and not published, so the clean audit holds for every way this repository is used; the gap blocks any future npm publish and is written down.
- **Review 1 (NOT READY):** no false PASS and no remaining hang in the targeted shapes; 12 manifest forms gave identical findings; 28 export shapes unchanged. Majors: root-level arrays of manifests still skipped silently; a second quadratic path on files with thousands of `import` lines; release docs still said the audit was clean without the tarball caveat. Being fixed.
- **B21 fix pass and review 2: MERGE.** Root-level lists of manifests are read element by element (10,001-element list read; stray elements listed); unread imports are deduplicated (2.4 MB of import lines: 28 s to 1.1 s; a 16-shape timing table is in `docs/limits.md`); the audit wording is qualified everywhere and the fresh-install audit is a release row marked NOT CLEAN; the build empties `dist/` first. Minor left for B22: a manifest with a numeric `apiVersion` is counted but never listed; a root list with no text `kind` inside a multi-document stream is still ignored; historical CHANGELOG lines point to row 5b.

## B22 Documentation corrections and two small code items (2026-11-14)
- **Docs.** A `check` subcommand is no longer written anywhere (the command has one form, `tripcurve [options] [path]`); a test derives the allowed words after `tripcurve` from `--help` and fails on any published text that shows a subcommand. The changelog has one entry per bolt, B0 to B22, in order (a test), the dated lines that say an audit was clean point to row 5b, and the audit wording is stated once the same way everywhere: clean for a clone followed by `npm ci`, NOT clean for a fresh install of the packed tarball (reran 2026-11-15T03:51Z: 0 in the checkout, 4 moderate in the tarball install). The demo README says exactly where the `preStop` block goes; following it literally in a scratch copy reproduces `demo/expected/after-fix.txt` byte for byte. The research note's `npx tripcurve .` plan text carries a hedge. The shrinkwrap package count in the docs is checked against the file.
- **Code, test first (seen red before the fix).** A mapping with a text `kind` and an `apiVersion` that is not text is listed as `object-not-identified` in every form and for every kind (67 of 104 new cases red before); a root list with no object of text `kind` inside a stream is listed as it was alone in a file; a `--config` file that was never opened no longer says "at line 1" in the human report (JSON and SARIF keep the line the contract requires); with nothing checked, the human summary carries the unresolved count JSON carries.
- **Decision: SARIF workload names.** The hostile-input pass named `logicalLocations[].name`; tripcurve writes no `logicalLocations`. The name is in `properties.tripcurve.workload.name`, whole and ASCII-escaped like the JSON value it mirrors, so it is documented as a data field (`docs/ci-and-sarif.md`) instead of being cut.
- **Reading note.** The numeric `apiVersion` case as first described (a named Deployment "never listed") did not reproduce: a nameless one was listed and a named one was read; the real gap was every other kind and the missing listing. The fix lists all of them.
- The fresh-user testing's doc findings: `tripcurve check` (not a command) named in two docs; stale figures; the demo walkthrough's `preStop` step without an exact insertion point (following it literally now reproduces `after-fix.txt`); the real-repository README's worker-class name; the research plan's `npx tripcurve .` hedged. A test now derives the allowed invocations from `--help`, so no published doc can name a subcommand.
- The audit wording is qualified everywhere (clean for a clone plus `npm ci` and the hosted workflows; not for a consumer of the packed tarball; blocks any npm publish). The shrinkwrap count in the docs is computed from the file (123 packages, all with integrity hashes).
- Two small listing gaps from the B21 review: a manifest-shaped object whose `apiVersion` is not text, and a root list inside a multi-document stream with no text `kind`, are now listed as `object-not-identified` in every form instead of being skipped.
- A `--config` that could not be opened prints no line in the human report (JSON and SARIF keep `line: 1`, as their contract requires). With nothing checked, the human Summary now carries the same unresolved count as JSON.
- CHANGELOG: one entry per bolt B0 to B22 in order, tested.
- **B22 review: MERGE.** Outputs byte-identical to before except the intended nothing-checked Summary count on eight hostile fixtures; the demo walkthrough reproduces `after-fix.txt` literally; audit wording qualified everywhere outside dated history. Minor items fixed before the merge: a nested list inside a multi-document stream is now listed like the whole-file case; a test pins that plain data lists stay unlisted (its mutant now dies); a CHANGELOG line moved to the right bolt; one duplicate heading.

## B23 Test evidence (2026-11-15)
- After B20 to B22 were merged, a fresh checkout of `main` was installed and every evidence command was run once more and captured verbatim (`docs/evidence/*.txt`): the full `npm run verify` (141 files, 13,115 tests, 96.74% line coverage, timed check within budget), the demo before and after the fix (byte-equal to the expected files), the four real repositories, the JSON summary and the SARIF gate fields, `--explain T1`, the dependency scan (0 for the checkout), the packed-tarball listing (no source maps; the shrinkwrap included), the refusal on Node 20 and the demo on Node 22.12.0, the Action's two dry runs, and the measurement lanes' case list.
- The full suite and both demo runs were repeated on Node 22.12.0, 24.22.3 and 26.13.1 (identical; `docs/evidence/node-matrix.txt`), and every SARIF document (12 goldens, 6 live runs) was validated against the official SARIF 2.1.0 schema with three broken copies rejected (`docs/evidence/sarif-schema.txt`; ajv in a scratch folder, schema SHA-256 recorded).
- Screenshots (`docs/screenshots/*.png`) are renderings of those transcripts, taken with a browser from a loopback-only local page; long transcripts show their last 45 lines and say so, with the full text in `docs/evidence/`. The only edit to any transcript is the replacement of an absolute home or scratch path with `<repo>` or `<scratch>`.
- `docs/evidence/black-box-testing.md` summarises the two testing passes (224 CLI cases in three formats, 600 fuzz runs, 142 SARIF documents against the official schema; every command in the docs; the packed tarball installed into a clean project) and what each found.
- The README's no-badge test now allows local images under `docs/screenshots/` and still refuses any other image (a hosted status image would be a claim).
- The latest measurement lane was started on this host during the capture work; it flagged the host as busy, so that run is evidence only and an official run is still owed on a quiet host.
- **Latest lane, 2026-11-15 (evidence only).** Started during the evidence capture; the host was busy for 35 of 65 cases, and the run ended `LANE FAIL: 61 of 65` with four keepalive cases 9 to 24 ms over narrow tolerances (gunicorn gthread default on 27.0.1, uvicorn-worker 3 s and gthread 7 s on 26.2.0, gthread 7 s on 27.0.1), 0 drift findings; the newest releases found were node 26.13.1, gunicorn 27.0.1 (newer than the pinned 27.0.0), uvicorn 0.54.0, uvicorn-worker 0.4.0, lightship 9.1.0. Kept as `measure/results/2026-11-15-lanes-latest-loaded-run.*` (evidence, never a basis). An official latest lane on a quiet host is still owed before any release. (Done in B26, 2026-11-15.)
- **B23 review 1:** no leak; every number in the README table matched its transcript; the SARIF schema and real-repository claims held. Fixed: the lanes row overstated "every entry" (it is 36 measured, 9 not measurable locally, 3 deferred, from the 2026-11-12 run); the lead sentence now dates rows individually and says "excerpted where the image says so"; the demo rows say how byte-equality was checked; two screenshots had clipped long lines (pages now wrap); the badge rule allows only `docs/screenshots/<name>.png`. The reviewer also found an unhandled EPIPE stack trace when the reader closes early (`tripcurve demo | head -1`): fixed separately as B24.
- **B23 review 2: MERGE.** The re-shot screenshots show no clipped line; the lanes row is true against the 2026-11-12 record; the badge rule refuses traversal, other folders and hosted images and allows `docs/screenshots/<name>.png`; the added lane files carry no personal data.

## B24 No stack trace on a closed pipe (2026-11-15)
- **Found by the B23 review:** `sh -c 'sleep 1; exec tripcurve demo' | true` (the reader gone before the first write) printed an unhandled `write EPIPE` trace. A closed pipe (`| head`, `| cmp - file`, a closed terminal) is a normal condition, and the rule is that no condition produces a stack trace.
- **Fix** (`src/cli/main.ts` only): an `'error'` listener on stdout and stderr; on `EPIPE` the writes stop and the process exits with the run's computed code (1 if none is known yet); any other error is rethrown. Output and exit codes are otherwise unchanged; goldens untouched. Node reports a POSIX pipe write failure asynchronously and ignores SIGPIPE by default (`docs/lookups-b24.txt`).
- **Tests:** `test/e2e/closed-pipe.e2e.test.ts`, 10 cases over human, JSON and SARIF output with a reader gone, closed after the first bytes, or never reading; 7 were red before the fix.
- **Review: MERGE.** Confirmed on `demo`, `demo-fixed`, `--explain`, a usage error, and with stderr closed; a planted `EACCES` is still rethrown. Test gaps noted, not closed: no test pins the rethrow of a non-EPIPE error or an EPIPE on stderr alone.

## B25 The first hosted runs, recorded (2026-11-15)
- **What happened (from the maintainer's session, 2026-11-15):** the source was pushed to https://github.com/naren-ambati/TripCurve on 2026-11-15 as two commits authored by the maintainer: `6809df0` (the exported state, B0 to B23, committed 05:30:20Z) and `cf55f77` (B24, 05:42:00Z); `main` there holds exactly those two commits, and the repository has exactly two workflow runs, both `run_attempt 1`, created 05:42:22Z (`docs/evidence/gh-hosted-runs.txt`, the commit and run listings). **The public history starts at that export**; it does not contain the private history of the earlier bolts.
- **Hosted results:** GitHub ran both workflows on that push and every job passed on its first run. `verify` run 43682221175: `verify (ubuntu-latest, 22.12.0)`, `(ubuntu-latest, 24)`, `(ubuntu-latest, 26)` and `(macos-latest, 22.12.0)`, all success; the first time the suite ran on Linux (142 test files, 13,111 tests passed and 14 skipped on Node 22.12.0; the timed check skipped there, not the recorded machine). `action-selftest` run 43682221183: `clean`, `failing` and `upload`, all success. The `upload` job sent the demo's SARIF to code scanning: analysis created 2026-11-15T05:42:42Z, tool tripcurve 0.1.0, 6 results, 7 rules; six open alerts (T1 two errors, T2 error, T4 error, T3 warning, T3 note) at the demo's files and lines.
- **Evidence added:** `docs/evidence/gh-hosted-runs.txt`, `docs/evidence/gh-linux-verify.txt`, `docs/evidence/gh-code-scanning.txt` (read with the GitHub REST API on 2026-11-15) and four screenshots under `docs/screenshots/` (`gh-verify.png`, `gh-action-selftest.png`, `gh-code-scanning.png`, `gh-hosted.png`).
- **A test race fixed (found while re-running the docs and Action tests together):** `test/action/dry-run.test.ts` ran the Action's real build step in this checkout, and `npm run build` empties `dist/` first; `test/docs/package-shrinkwrap.test.ts` runs `npm pack --dry-run` on the same tree in parallel and failed once with ENOENT on a half-rebuilt `dist/` (2026-11-15). `action/dry-run.sh` now takes `DRY_RUN_ACTION_PATH` (default: this repository), the test builds in a scratch copy of the Action checkout (sources, build config, the script, `node_modules` linked), and a regression test checks that a dry run leaves this repository's `dist/cli/main.js` untouched (inode and mtime): it failed before the fix. The stale "never run" header comments in `action.yml`, both workflow files and `test/action/action-file.test.ts` are corrected too.
- **Documentation corrected:** the README (status paragraph, test-evidence section, two new rows, four screenshots; the verify row now says its 13,115-test figure is the B23 record and that a checkout today runs 13,126 tests in 142 files), `docs/action.md`, `docs/ci-and-sarif.md`, `docs/security.md`, `docs/limits.md`, `docs/release-checklist.md` (rows 12 to 14, the Linux lines and the known-limits lines), `docs/evidence/black-box-testing.md` and the CHANGELOG (a B25 entry; older lines that said "never run" are now dated history). The approved-sentences list was re-approved for exactly these sentences and the stale ones removed.
- **Tests:** the README status test now requires "The source is at <URL>" and "not published to npm"; the old "docs say it has not run" test is replaced by two tests (no page says the Action or the workflows have not run or are pending; the pages that mention them cite both run ids); the CHANGELOG order test runs to B25.
- **Still true:** not published to npm; licence decided by the owner before release; the shrinkwrap and tarball gap still blocks an npm publish (checklist row 5b).
- **B25 review 1 (FIX-FIRST):** the new regression test read `dist/cli/main.js` unconditionally and would have thrown ENOENT on a fresh checkout, where `dist/` does not exist while the tests run (the hosted runner included); it now records `absent` or the file's inode and mtime, and was shown to pass with `dist/` present and absent while the old script path still creates `dist/`. Also fixed: a stale "waits for the maintainer's go" code-scanning sentence in the release checklist; row 7 and `docs/action.md` now say the `exit-code` output was checked after a failed *check* step and that no job fails the build step; stale comments in `test/action/workflows.test.ts` and `test/platform/portability.test.ts`; the push time and "two commits", "only two runs", "first attempt" claims are now backed by the commit and run listings appended to `docs/evidence/gh-hosted-runs.txt`; the stale-wording test's history exemption requires both `B25` and the date.
- **B25 review 2 (FIX-FIRST, then fixed):** `docs/limits.md` still said no SARIF upload happens before the maintainer's go (fixed: code scanning accepted the demo's SARIF on 2026-11-15; the goldens were validated locally and never uploaded); the stale-wording regex now also catches "no hosted CI run", "no upload before", "has not been run" and "had never run", and its history exemption is limited to `CHANGELOG.md` and `BUILD-NOTES.md`; the release checklist's review table said B22's review was pending (it closed on 2026-11-14) and had no rows for B23 to B25. The verify of the reviewed tree: 142 test files, 13,127 tests, 96.74% lines, self-test passed, timed check within budget. The hosted runs were a push to a public repository: a pull request, a fork and a private repository were not tried.

## B26 The official latest lane (2026-11-15)
- **What ran:** `node measure/lanes.mjs latest` in a detached worktree of `main`, started 06:37:26Z (the file records the start; the end, about twelve minutes later, was read from the terminal), `--jobs=1`, with no busy sample per the lane's own check (no load sample above half the 10 cores; load 2.49 at start, 1.59 at end; the 15-minute average at start was 9.45, from the verify run just before). Result: `LANE PASS: 65 of 65 cases within tolerance, 36 entries planned, 36 entries passing, 9 carry a stated reason, 3 deferred and not measured, 0 release blockers, 0 drift findings`, exit 0. Newest releases found (GET only): node 26.13.1, gunicorn 27.0.1 (newer than the pinned 27.0.0; every gunicorn case passed on it), uvicorn 0.54.0, uvicorn-worker 0.4.0, lightship 9.1.0. Node 27.0.0-alpha pre-releases were listed and not compared, as designed.
- **Files:** `measure/results/2026-11-15-lanes-latest-b26.{txt,jsonl}` (paths redacted to `<repo>`), classified evidence-only in `test/kb/tolerance-evidence.test.ts` like the B15 pinned run (added after the tolerances were derived). An earlier attempt of the same day recorded 13 busy samples (load 8.53 to 37.19 on 10 cores; 65 of 65 within tolerance, `not an official run`, exit 5) and is kept as `measure/results/2026-11-15-lanes-latest-busy.{txt,jsonl}`; the `-busy` suffix classifies it as evidence automatically.
- **Docs:** release-checklist row 4 is done for 2026-11-15 and still says to run the lane again on the day of the go; `docs/how-defaults-were-measured.md` quotes the result and no longer says the latest lane was last run before B12; the README lanes row cites it; CHANGELOG B26.
- **No code changed.**
- **B26 review (FIX-FIRST, then fixed):** the notes said the earlier attempt had three busy samples (the file has 13, load 8.53 to 37.19) and gave an end time the file does not record; "quiet host" is now "no busy sample per the lane's own check" (the 15-minute load average at start was 9.45); the B23 note that an official lane was still owed points to B26; the review table has a B26 row.
