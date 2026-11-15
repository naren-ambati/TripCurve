# Real-repository check (bolt B14)

Trimmed copies of four public repositories, run through the built `tripcurve`, with every result judged by hand against the real files. The point is to try the tool on data the maintainer did not write. Dates are 2026; lookups and copies are 2026-11-12 (UTC).

## Selection criteria (written before any file was copied)

1. **Licence.** MIT, Apache-2.0 or BSD at the repository root, read again from the clone on the day of copying (all four are MIT). The files copied were grepped for a differing licence header, an SPDX tag or a copyright line: none. Any doubt means the repository or the file is skipped. MIT-0 and repositories with no detected licence were skipped.
2. **Owner.** A personal account. A company-owned repository is not used, because each NOTICE names its source repository by `owner/repo`.
3. **Only the files tripcurve reads.** Kubernetes manifests, Dockerfiles, `package.json`, `requirements*.txt`, the Node server source and `*.tf` files, with their relative paths kept. Copied files are byte-identical to upstream and are never edited.
4. **No secret-like files.** Left out: peermetrics `k8s/overlays/example/secrets.env.example`; DevOpsDojo `k8s/secrets.yaml`, the `*.json` policy files and `infra/`; publikes `secret.tf` and `iam_lambda.tf`. A grep of every copied file for keys, tokens and passwords found only references by name (`secretKeyRef`, `secretRef`, `aws_secretsmanager_secret.secret.arn`) and no value.
5. **Shapes covered**: Python/gunicorn behind an ALB, Node behind an ALB, and an SQS-to-Lambda pair. A shape with no qualifying repository gets a named synthetic fixture (below).
6. **The maintainer approved the list** on 2026-11-12 before any file was copied.

Each copy has the upstream `LICENSE` (unchanged), a `NOTICE` (source URL, commit, date, licence, files copied, "trimmed") and, after judging, `expected.txt`. The tripcurve project has no licence of its own yet: it is decided by the maintainer before release.

## The copies

| Directory | Source (commit, copied 2026-11-12) | Files copied | Shape |
|---|---|---|---|
| `peermetrics__peermetrics` | https://github.com/peermetrics/peermetrics at `4447defd13602af03904218b8e16dfde7cc7b80d` (MIT) | 4: `k8s/base/{web,api,ingress,kustomization}.yaml` | A: gunicorn behind an ALB Ingress |
| `akhileshmishrabiz__DevOpsDojo` | https://github.com/akhileshmishrabiz/DevOpsDojo at `13162e3d0f91d2cd253d2e36dccf2968055935e0` (MIT) | 9: 4 manifests, 2 Dockerfiles, `requirements.txt`, `package.json`, `server.js` | A and B: gunicorn Dockerfile; Express with no `keepAliveTimeout`; ALB Ingress |
| `sorah__publikes` | https://github.com/sorah/publikes at `095cffb6cc26bb002b56dcabdfc0fda604102d50` (MIT) | 4: `sqs.tf`, `lambda.tf`, `variables.tf`, `versions.tf` | C: Terraform SQS to Lambda |
| `DanielDaCosta__apiGateway-sqs-lambda` | https://github.com/DanielDaCosta/apiGateway-sqs-lambda at `8283b64230b15a695cf0d8923aa2fe772f6fd284` (MIT) | 4: `sqs.tf`, `lambda.tf`, `variables.tf`, `main.tf` | C: Terraform; default visibility against a 30 s timeout |

`test/e2e/real-repos.e2e.test.ts` runs the built command in each directory (`tripcurve .`) and compares stdout byte for byte with `expected.txt`, checks exit 1 and an empty stderr, and checks that each NOTICE lists exactly the files present. The second DevOpsDojo run uses the declaration file `test/fixtures/real-declared/devopsdojo-frontend.yaml` (ours, not upstream's), copied into a temporary directory as `tripcurve.yaml`; its output is `expected-declared.txt`.

## Results and verdicts

Verdicts: **correct** (follows from the files under the spec), **honest UNRESOLVED** (the files do not establish the value), **false positive** (a FAIL or WARN the files do not support), **false negative** (a PASS that hides a problem), **known limit** (right per the spec but surprising; documented in `docs/limits.md`). Every line was read against the real files.

The first run (bolt B14, 2026-11-12) found no false positive, no false negative, no crash, no hang and no input text in the tool's voice, and no PASS: every run exited 1. Its real finding was that real repositories rarely write down the numbers a PASS needs, and that the Terraform pairs were UNRESOLVED only because the spec linked by file and read no arithmetic. The maintainer delegated those fixes on 2026-11-12 (bolt B17): a reference links within its own folder, integer arithmetic on literals is evaluated exactly, T4 is a FAIL when visibility is below 6 x the function timeout whatever the batching window is, and the hint under an unidentified program is neutral. After B17 the four copies were run again and every changed line was judged again against the real files, by hand, before `expected.txt` was rewritten (the "B17 re-judging" section below). Now: 4 repositories, 1 PASS (`sorah/publikes`), 1 real FAIL of T4 and 1 of T2, and the rest UNRESOLVED; three runs exit 1 and the publikes run exits 0.

| Repository / workload | Rule | Result | Why, and the source line it rests on | Verdict |
|---|---|---|---|---|
| peermetrics `peermetrics-web` | T2 | FAIL | No `preStop` and no drain; the Ingress target type is `ip` (`k8s/base/ingress.yaml:8`), the Service `web` port 8080 routes to the container (`k8s/base/web.yaml:35`); the server is gunicorn (`web.yaml:33`), whose in-process drains tripcurve does not read, so "none declared" is the statement. | correct (a real missing shutdown delay; the "not read" wording is on the line) |
| peermetrics `peermetrics-web` | T1 | UNRESOLVED | `envFrom` (`web.yaml:37`) could set `GUNICORN_CMD_ARGS` from a ConfigMap and a Secret that are not in the files; the ALB idle is the assumed default 60 s (no annotation). | honest UNRESOLVED (known limit: `envFrom`) |
| peermetrics `peermetrics-web` | T3 | NOT EVALUATED | T2 failed. | correct |
| peermetrics `peermetrics-api` | T1, T2, T3 | UNRESOLVED | The container has an image and no command (`k8s/base/api.yaml:31`), so the server is not identified. | honest UNRESOLVED (known limit: image without command) |
| DevOpsDojo `frontend` | T1, T2, T3 | UNRESOLVED | The manifest image `livingdevopswithakhilesh/devopsdozo:frontend-latest-1` (`k8s/frontend.yaml:25`) is not built by any file in the repository, and has no command, so `frontend/server.js` and `frontend/Dockerfile` cannot be linked without a declaration. | honest UNRESOLVED (known limit: no Dockerfile-to-image link) |
| DevOpsDojo `backend` | listed under Assumptions | not checked | `backend` is a `ClusterIP` Service behind no Ingress (the only Ingress routes to `frontend`, `k8s/ingress.yaml:29`), so there is no load balancer for T1 to T3. | correct |
| DevOpsDojo `frontend`, with the declaration | T1 | VERSION-DEPENDENT | `source: frontend/server.js` is read: `app.listen(PORT, '0.0.0.0', ...)` (`server.js:68`) sets no `keepAliveTimeout`. `node:20-alpine` (`frontend/Dockerfile:21`) is declared as `runtime.node: "20"`; the ALB idle 60 s is declared. Node 20 closes an idle connection at 6 s from 20.20.2 (measured), so "idle close 6 s would FAIL"; below 20.20.2 there is no entry. | correct (a real T1 failure, but never shown as FAIL while the minor version is open) |
| DevOpsDojo `frontend`, with the declaration | T2, T3 | UNRESOLVED | `server.js` imports `express` and `http-proxy-middleware` (`server.js:1,3`), whose code may register shutdown handlers, so "no drain" is not established. | honest UNRESOLVED (known limit: imported packages) |
| publikes `collector-sqs` | T4 | PASS (B17) | The mapping (`lambda.tf:58-59`) names `aws_sqs_queue.queue` (declared in `sqs.tf`) and `aws_lambda_function.collector-sqs` (`lambda.tf`), both in the one folder, so both link (B14 left this UNRESOLVED: it linked by file). The visibility is `60 + (30 * 6)` (`sqs.tf:4`) = 240 s, the function timeout is 30 s (`lambda.tf:47`) and the batching window 60 s (`lambda.tf:62`). By hand: 6 x 30 + 60 = 240, and 240 >= 240, so visibility covers it exactly. | correct (and the first PASS: it follows from every value being written; the computation is printed beside the number) |
| DanielDaCosta `event_source_mapping` | T4 | FAIL (B17) | The mapping (`sqs.tf:17,19`) names `aws_sqs_queue.queue` (`sqs.tf`) and `aws_lambda_function.lambda_sqs` (`lambda.tf`), one folder, so both link. The queue sets no `visibility_timeout_seconds`, so the documented default 30 s applies; the function timeout is 30 s (`lambda.tf:16`); the mapping sets no batching window. By hand: the need is at least 6 x 30 = 180 s whatever the window is, and 30 < 180. | correct (a real misconfiguration: visibility equal to the function timeout; B14 could only say UNRESOLVED because the batching window was assumed) |

### B17 re-judging (2026-11-12)

After the B17 changes the four copies were run again through the built command. Every changed line was read against the real files (upstream clones at the NOTICE commits, byte-identical to the copies) before `expected.txt` was rewritten.

| Copy | What changed in the output | Judged |
|---|---|---|
| publikes | T4 UNRESOLVED became PASS `visibility 240 s covers 240 s`, exit 0. Real files: one `aws_sqs_queue` named `queue`, one `aws_lambda_function` named `collector-sqs` and one mapping, no override file and no duplicate address anywhere in the 14 files of the upstream folder; `60 + (30 * 6)` is 240; 6 x 30 + 60 = 240. | correct |
| DanielDaCosta | T4 UNRESOLVED became FAIL `visibility 30 s is less than 6 x 30 s = 180 s; the batching window is not set, and any window only raises the need`, exit 1. The Assumptions block does not list the assumed batching window, because the FAIL does not rest on it. Real files: one queue, one function, one mapping, no override file or duplicate in the 7 upstream files; the queue has no visibility (default 30 s), the function timeout is 30 s. | correct |
| peermetrics `api` | Only the hint under T1: `pin the image to an exact Node version tag, or declare runtime.node ...` became `name the program in the container command or args ...; for Node, tripcurve.yaml can instead declare runtime.node ...`. The image `peermetrics/api:latest` has no command (`k8s/base/api.yaml:31`). On a scratch copy a `dockerfile:` declaration did not identify the server, and `runtime.node` did identify a Node program, so the new text says what is true. | correct |
| DevOpsDojo `frontend` | The same hint change under T1. The image is built by no file in the repository. `expected-declared.txt` is unchanged: there the Node program is identified and the Node hint is the right one. | correct |
| peermetrics `web`, DevOpsDojo `backend` | no change | correct |

The scratch observation of B14 (the two files of each pair concatenated into one `main.tf`) is now what the tool does with the real folders.

## What the check shows for the maintainer

Of the four gaps B14 reported, gap 4 (Terraform in one folder) and the Terraform arithmetic are closed by B17. Three remain, each following the approved spec and documented in `docs/limits.md` ("Real-repository check"); none is a wrong verdict.

1. **`envFrom`** hides `GUNICORN_CMD_ARGS` and `NODE_OPTIONS`, so a real gunicorn deployment is UNRESOLVED for T1.
2. **An image the files do not build** cannot be linked to a Dockerfile or source without a `tripcurve.yaml` declaration.
3. **The ALB idle timeout** is rarely set in the files; the assumed 60 s default keeps T1 at UNRESOLVED for Node.

Still open from B14 and not part of B17: an imported `express` blocks the claim that there is no drain (T2 and T3 stay UNRESOLVED for a typical Express app).

## Shapes with no real candidate: named synthetic fixtures

No qualifying repository was found for these shapes (read-only searches on 2026-11-12: the uvicorn matches had no licence or a copyleft one or no ALB; the SAM code search returned nothing, which is inconclusive, not proof that none exists). Each is covered by an existing fixture, listed here and in the release notes (`CHANGELOG.md`):

| Shape | Covered by |
|---|---|
| gunicorn with the uvicorn worker | `demo/k8s/api.yaml` (`"-k", "uvicorn_worker.UvicornWorker"`, the class of the `uvicorn-worker` package), run as `api` in `demo/expected/first-run.txt`; `test/fixtures/python/api-admin/k8s/api.yaml` (the same class, `uvicorn_worker.UvicornWorker`, as the value after `-k`) |
| gunicorn with `--threads`, `GUNICORN_CMD_ARGS` or `gunicorn.conf.py` | `test/fixtures/python/precision/threads-2/`, `cmd-args-override/`, `conf-literals/` |
| Terraform `aws_lb` | in-memory trees in `test/link/terraform-lb.test.ts` and `test/evaluate/t4.test.ts` (no on-disk repository) |
| SAM with an SQS event | `test/fixtures/iac/sam/orders/template.yaml` |
| a real preStop hook with a grace period | `demo-fixed/k8s/web.yaml` (`preStop` `sleep 10`, `terminationGracePeriodSeconds`), `test/fixtures/k8s/shapes/prestop.yaml` |
