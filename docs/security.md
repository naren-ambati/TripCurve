# Security

What tripcurve does and does not do with the files it reads, what the GitHub Action does, and the one thing a reviewer must watch: **a pull request can add a waiver.** Dates are 2026. tripcurve 0.1.0 is tagged (2026-11-15) as a GitHub Action ref, and its container image is published by the release workflow from that tag (B29; B30 records the result), not on npm; the licence is still undecided and none is granted until then.

## What a run of `tripcurve [path]` never does

- **It never runs your code.** Application source is parsed with ts-morph and read as a syntax tree; `gunicorn.conf.py` is read for literals only and is never executed; Terraform is read by tripcurve's own bounded reader (no HCL library), and SAM, CloudFormation and Kubernetes files are parsed as data. A file that cannot be read in full is reported as unchecked, never guessed. (`docs/limits.md`, "Python server readers" and "Terraform and rule T4 (B5)")
- **It never uses the network and sends no telemetry.** No file under `src/` imports `child_process`, `net`, `http`, `https`, `dns`, `tls` or `vm`, and none calls `fetch`, `eval` or `new Function` (a search of `src/` on 2026-11-12; `test/docs/docs.test.ts` fails if one appears). The strings `http` and `https` in `src/parse/node/read-node-source.ts` are module names it looks for in the source it reads. The `--help` text says the same: "Reads files only; never runs your code, makes network calls or sends data." (`src/cli/main.ts`)
- **It does not read Kubernetes Secret data.** A Secret keeps only its kind, name and namespace in the syntax tree and in the value; a YAML merge key cannot carry Secret data through, and a test covers that path. (`BUILD-NOTES.md`, B1 "Area 2")
- **What it does read, and what a report can show.** It reads the files it recognises, so env values (for example `GUNICORN_CMD_ARGS` and `NODE_OPTIONS`), ConfigMaps, Terraform literals, `package.json` and source are read, and text from them can appear quoted in the report: names, image tags, config keys, waiver reasons and source file names. The report prints the setting it derived (for example the derived keepalive with its file and line), not the raw env string: in a manual probe on 2026-11-12, a copy of the demo with `GUNICORN_CMD_ARGS` set to `--keep-alive 5` and an unrelated env var `API_TOKEN` printed the derived keepalive at its file and line, and neither the token value nor the raw string appeared in the human or JSON output. That probe is not an automated test. Do not put secrets in files tripcurve reads, and do not assume a value is hidden because it is not usually printed.
- **It never sends credentials anywhere.** There is nowhere to send them: no network, and the Action requests no token (below).

## Input is untrusted data

Everything a file says is data. A name, a comment, a reason or a path can be anything, including text that looks like an instruction or a link.

- **Quoted, never in tripcurve's own voice.** Input text in a report goes through one quoting function (SafeText): printable ASCII only, at most 80 columns per line, quoted, and a quoted line never starts with a quote mark. Hostile output is property-tested over 500 seeded cases. In JSON every character above `~` is escaped as `\uXXXX`, so no control, bidirectional or invisible character reaches a reader's screen raw. In SARIF, message text escapes `[`, `]`, `{` and `}` so a name such as an embedded link cannot become a link. (`BUILD-NOTES.md`, B1 "Area 5"; `docs/limits.md`, "Text shown in a report", "What the JSON adds to", "Review of B7")
- **A result's words are tripcurve's own.** The result kind, the headline and the "declare" hints are fixed text; input can only appear inside quotes. (`docs/limits.md`)
- **Waiver text is data too.** A reason with no visible character, or longer than 200 characters, makes the waiver invalid; a long reason is printed whole, in quoted parts, never cut. (`docs/limits.md`, "Waivers and `--explain`")

## Reads are bounded

| Bound | Value | What happens past it |
|---|---|---|
| file size | 5,000,000 bytes | the file is reported unchecked (`over-size`) and the run is not clean |
| YAML alias expansion | 100 | the file is reported unchecked (`alias-limit`) |
| nesting depth | no picked number; a stack overflow is caught | the file is reported unchecked ("too deeply nested") |
| symlinks | never followed out of the root; a link to an ancestor is a loop | reported (`outside-root`, `symlink-loop`) |
| source search | each local import read once, bounded by the files intake already read | an incomplete search gives UNRESOLVED, never "default applies" |

(`docs/limits.md`, "Input limits" and "What intake does at each limit".) Work is linear in the input: hostile shapes (a map of 500,000 keys, 8000 listeners, 20,000 invalid waivers) have scaling tests, and tripcurve uses no wall-clock timer, so its output does not depend on the machine. (`BUILD-NOTES.md`, B1 fix pass 1, B3 and B6; `docs/limits.md`, "Where there is no separate limit")

## The GitHub Action

The Action ran on GitHub once, on 2026-11-15 (self-test run 43682221183; the verify workflow ran in run 43682221175) (`docs/action.md`, [ci-and-sarif.md](ci-and-sarif.md)). Its design, as checked by tests without GitHub:

- **It builds from its own checkout.** tripcurve itself is built from the Action's checkout and is never fetched from a registry at run time. Its dependencies are: the build step (`action/run.sh`) and `.github/workflows/verify.yml` run `npm ci --ignore-scripts`, which downloads every package the shrinkwrap requires for the platform from the registry, development dependencies included (optional packages such as `fsevents` are skipped on Linux). The shrinkwrap pins each version and records an integrity hash that `npm ci` checks, and install scripts are disabled. That does not protect against a compromised version that was already locked: a bad release pinned in `npm-shrinkwrap.json` is installed as pinned, and the hash only proves it is the release that was locked. After a release the maintainer may replace the build with an exact pinned version of tripcurve. (`docs/action.md`)
- **Third-party Actions are pinned by commit SHA.** `actions/setup-node` v7.1.0 and `github/codeql-action/upload-sarif` v4.39.3 in `action.yml`, and `actions/checkout` v7.0.1 with the same setup-node in `.github/workflows/verify.yml`, looked up read-only with `git ls-remote` on 2026-11-12 (`docs/lookups-b9.txt`). A test fails on a mutable tag.
- **No input is ever written into a script body.** The four inputs reach `action/run.sh` as environment variables (`TRIPCURVE_PATH`, `TRIPCURVE_CONFIG`, `TRIPCURVE_FORMAT`, `TRIPCURVE_SARIF_FILE`) and are quoted in the script. A test fails if a `run:` body contains `${{`. No workflow command (`::`) can start a log line, tested with hostile names. (`docs/action.md`, "Security notes"; `BUILD-NOTES.md`, B9)
- **The SARIF path is confined to the workspace.** `sarif-file` is refused (exit 2) when absolute, when any path component is `..`, when it has a control character, when it names a directory or an existing symlink, or when its folder resolves outside the workspace; the folder is checked one component at a time before anything is created. (`docs/action.md`, "Inputs"; `BUILD-NOTES.md`, B9 review fixes)
- **Least privilege.** The Action requests no token and prints no secret; `permissions: contents: read` is enough. The SARIF upload is off by default, and turning it on (`upload-sarif: "true"`) needs `security-events: write` in the calling job. (`docs/action.md`)

## A pull request can add a waiver

**Waivers live in the files under check.** A waiver is an inline comment (`tripcurve: ignore <RULE> reason="<text>" until=<YYYY-MM-DD>`) in a YAML or Terraform file, or a `waive:` entry in `tripcurve.yaml`. Anyone who can change those files in a pull request can therefore silence a finding. This is a deliberate choice, and the control is visibility, not prevention. **Reviewers must read the waiver lines in a pull request.**

What tripcurve does to keep a waiver visible:

- every waiver is printed as a `WAIVED` line with its date, its reason and where it is written, and the closing line says `No failures:` with the waived count and the expiry dates, never `All checks passed`; a run with a waiver never says "All checks passed". (`docs/limits.md`, "What the report prints")
- SARIF carries a `suppressions` entry with the justification and, in `properties.tripcurve`, the waiver's `until`, `mechanism` and `source`. (`docs/limits.md`, "Review of B7")
- a waiver needs a visible reason (200 characters at most) and a valid date; an invalid one suppresses nothing and is listed, and makes the run not clean. (`docs/limits.md`, "Waivers and `--explain`")
- it covers one rule on one workload, never a PASS, and never changes how a rule is computed; after its date, in UTC, the finding returns. (`docs/limits.md`)
- a waiver that matches nothing makes the run not clean, so stale waivers cannot pile up silently. (`docs/limits.md`)

What tripcurve does **not** do:

- **Waivers have no `until` cap.** `9999-12-31` is a valid date. No number was derived for a cap, and a number would have been invented; visibility is the control. (`docs/limits.md`, "What a waiver is, and the one validator")
- It does not require a particular reviewer or approve waivers. A repository that wants that has to enforce it with its own review rules, for example by requiring an owner's approval for changes to `tripcurve.yaml`; that is advice, not something tripcurve checks.

## The measurement scripts and lightship

The scripts under `measure/` are not part of the shipped package and never run during a run of `tripcurve [path]`. They start real servers, on 127.0.0.1 only, in a clean environment, and download runtimes with GET requests into the git-ignored `.cache/`, with a checksum or hash verified. (`measure/README.md`; `docs/limits.md`, "The measurement lanes")

**One exception, accepted (decided 2026-11-12).** `measure/lightship-b4.mjs` runs lightship 9.1.0, whose own status server is started with a fixed `host: '0.0.0.0'` (`src/factories/createLightship.ts`, lines 153 to 156 of the installed package) and no option to change it. While the script runs, a listener is therefore open on all interfaces, on a random free port in local mode or on `LIGHTSHIP_PORT` in Kubernetes mode, for a few seconds. This departs from the contract's "localhost only"; it is accepted because the 5 s delay is lightship's own behaviour and cannot be measured otherwise. It stays in the lanes and stays documented here, because it is measurement-only, lasts a few seconds and uses a random port in local mode (decided 2026-11-12). (`docs/limits.md`, "The measurement lanes"; `BUILD-NOTES.md`, B8)

## Dependencies and the supply chain

- Three runtime dependencies, exact-pinned: `commander`, `ts-morph` and `yaml`; the shrinkwrap records an integrity hash for every package. (`package.json`; `npm-shrinkwrap.json`)
- The CI and Action install every package the shrinkwrap requires for the platform (development dependencies included; optional packages such as `fsevents` are skipped on Linux) from the registry with `npm ci --ignore-scripts`, which checks the integrity hashes and runs no install scripts. One dev-only optional package in the shrinkwrap (`fsevents`, through vitest) is flagged as having an install script; the production tree has none. (`docs/release-checklist.md`)
- `npm audit` on the checkout printed `found 0 vulnerabilities` on 2026-11-12 and again on 2026-11-14. Until then it reported 3 moderate findings, all one `minimatch` issue (GHSA-g3hv-75wg-m249) reached through `ts-morph`; an npm `overrides` entry in `package.json` now pins `minimatch` to 11.0.8, because `ts-morph` 28.0.0 is the newest release and a downgrade is a breaking change. The override was checked by one call (`require('minimatch').minimatch` from `@ts-morph/common`'s directory) and by `npm run verify`, not on every `ts-morph` code path; drop it when `ts-morph` bumps `minimatch` itself. (`docs/release-checklist.md`, "npm audit"; `docs/limits.md`, "The minimatch override")
- The audit is clean (0 vulnerabilities) for every way this repository is used: a `git clone` followed by `npm ci`, and the tree that the hosted workflows install (the same shrinkwrap; the audit itself was run locally, not on GitHub). It is NOT clean for a consumer who installs the packed tarball: npm `overrides` do not ship, and a shrinkwrap entry outside the dependent's declared range is dropped (`@ts-morph/common` 0.29.0 declares `minimatch ^10.0.1`; ts-morph 28.0.0 is the newest). The package is private and not published to npm, so no such consumer exists; before any npm publish this must be closed by a ts-morph release that allows minimatch 11 or by replacing ts-morph. (`docs/release-checklist.md`, row 5b)
- The shrinkwrap (`npm-shrinkwrap.json`) has 123 packages, all with integrity hashes; the only package with an install script is the optional, dev-only, macOS-only `fsevents`. (`docs/release-checklist.md`, "The shrinkwrap")

## Reporting a vulnerability

Once the repository is public, report a vulnerability through GitHub's private vulnerability reporting for the repository. Until the repository is public there is no public channel, so a report cannot be received. This was decided on 2026-11-12. Private vulnerability reporting is a setting of the repository, which the maintainer switches on after the maintainer's go; how GitHub presents it was not looked up. Please do not put the details of a vulnerability in a public issue. (`docs/release-checklist.md`, "Decided on 2026-11-12")
