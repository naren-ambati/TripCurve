# Black-box testing before publication (2026-11-14 to 2026-11-15)

Two independent testers worked only against the built command and the published documents, on this machine (Mac17,3, Apple M5, macOS), with no access to the source beyond what a user has. Their defect reports were fixed in build steps B21 and B22 (see `../../BUILD-NOTES.md`); this page records what was run. The transcripts of the final evidence run, made on a fresh checkout after the fixes, are the other files in this folder.

## The command (224 cases, three formats each)

| Group | Cases | Result after the fixes |
|---|---|---|
| Flags and arguments (`--help`, `--version`, `--format`, `--config`, `--explain`, `--verbose`, `-`, `--`, unknown flags, paths starting with `-`) | 46 | all as documented |
| Repository inputs (`demo/`, `demo-fixed/`, every fixture directory, the four real repositories), each in human, JSON and SARIF | 52 | same exit code and counts in every format; JSON parses; SARIF parses |
| Hostile inputs (10 MB files, 100,000-deep nesting, alias bombs, binary and UTF-16 files, CRLF, names with `::error::`, ANSI escapes, newlines and 255 characters, 10,000-document streams, symlink loops, a 20,000-file tree, permission-denied files, a FIFO, hostile `tripcurve.yaml`, 10,000 Terraform resources, broken HCL and templates, a 4.8 MB source) | 91 | no crash, no stack trace, no hang, output ASCII, no input text in the tool's own voice, no home path |
| Fuzzing: random mutations of the demo files (byte flips, truncation, duplicated and deleted lines, inserted keys), three formats each | 600 runs | exit always 0, 1 or 2; stderr empty or one fixed line; JSON and SARIF always parse |
| Official SARIF 2.1.0 schema (ajv, draft-04) over every SARIF document produced above | 142 documents | valid |
| Resources: wall time and peak memory on the demo, a 1,000-file tree, a 20,000-file tree and a 4.9 MB YAML; four concurrent runs | 6 | bounded; concurrent output identical to a single run |
| Node releases: the suite and the demo on 22.12.0, 22.23.2, 24.22.3 and 26.13.1; 20.20.2 and 18.20.8 refused | 6 | identical output; the fixed refusal message, exit 2 |
| Working-directory independence and determinism (five runs per format) | 8 | outputs differ only in the printed path; byte-identical across runs; no timestamps |

Defects this found, all fixed before publication: a hang on a large TypeScript source (Critical); Kubernetes manifests in JSON, quoted-key, flow and root-list forms skipped silently, so a failing Deployment made the run look clean (Critical); a broken manifest of those forms not reported (Major); a syntax error in a linked source not named (Minor).

## The fresh-user path

Every command in the README and the docs was run as written and compared with what the surrounding text claims; every relative link and cited file was checked; the whole tree was searched for personal information, internal references and secrets; `npm pack` was inspected and the tarball installed into a clean project; the Action's dry runs were executed for the clean, failing and refused cases; a clean-machine install (`npm ci`, build, demo) was timed on Node 22.12.0.

Defects this found, all fixed: a non-existent `tripcurve check` command named in two documents; an ambiguous step in the demo walkthrough; stale figures; a worker-class name; a measurement-lane verdict of "FAIL 0 of 0" when nothing could be measured; source maps shipped for sources that were not; workflows that would run twice on a pull request. One finding cannot be fixed here: a consumer who installs the packed tarball still gets the vulnerable `minimatch` that ts-morph pins, because npm overrides do not ship; the package is private and not published, and the gap blocks any npm publish (see `../security.md`).

## What was not run

At the time of the testing nothing had been run on GitHub, and Linux had not been run on this machine. The hosted runs came after, on 2026-11-15, and every job succeeded (runs 43682221175 and 43682221183; `docs/evidence/gh-hosted-runs.txt`). The fuzzing base (`demo/`) always exits 1, so it could not expose a false clean; the manifest-form equivalence tests added in B21 cover `demo-fixed/` for that.
