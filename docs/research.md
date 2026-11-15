# tripcurve: research

Everything the arena report says about tripcurve, organised. Source: the arena report "Unique project candidates 2026-10-28" (sweep 2026-10-29, re-checks through 2026-11-02), section 2 plus the shared sections. A verbatim copy is in `docs/arena-report-extract.md`. Every number below is the report's unless marked **[lookup 2026-11-10]**, which means I checked it myself on that date.

Dates in this file are 2026 unless a year is shown. "11-02" means 2026-11-02.

## 0. Provenance and how far to trust it

- The report is one person's research, scored and attacked by a 100-agent arena (see section 11). Stars and push dates come from the GitHub REST API (`pushed_at`). Measured numbers come from local experiments on one 10-core macOS laptop, not on an ALB or a CI runner.
- No fresh web lookups were made when this workspace was set up, except two: **[lookup 2026-11-10]** `npm view tripcurve` returned 404 (name still free) and `npm view mel-check` returned 404.
- Anything that moves (stars, issue state, Node release lines, gunicorn/uvicorn versions) must be re-checked before it is quoted in a public README.

## 1. What it is

A static config linter that reads values spread across Kubernetes YAML, container args, app code and Terraform, fills in unwritten defaults from a versioned, sourced knowledge base, and fails CI when the timeouts *between* infrastructure layers are ordered wrongly. Every printed number carries its source.

The analogy: electrical engineers do a time-current coordination study so that a fault clears at the nearest device and nothing upstream trips first. Timeouts between layers need the same ordering, and with today's defaults they are often backwards.

Three problems (T1-T3 are the new ones; T4 is a port):

1. **Keep-alive.** An AWS ALB keeps idle connections to targets for 60 s by default. Most Python and Node servers close idle connections much sooner. AWS: "We also recommend that you configure the idle timeout of your application to be larger than the idle timeout configured for the load balancer. Otherwise ... the load balancer sends an HTTP 502 Bad Gateway error to the client."
2. **Pod shutdown.** On a rollout, Kubernetes sends SIGTERM and starts endpoint removal at the same time. AWS's EKS guide recommends a preStop `sleep 10` so the load balancer stops routing first. preStop 10 s plus gunicorn's default 30 s graceful timeout (a ceiling, not a duration) exceeds the default 30 s grace period. Workers are SIGKILLed only if a request is still running about 20 s after SIGTERM. tripcurve reports that as a worst-case bound and turns it into pass/fail once the longest request is declared.
3. **Queues.** An SQS queue with 60 s visibility feeding a 30 s Lambda: AWS recommends visibility of at least 6 x the function timeout plus the batching window.

## 2. Measured defaults (11-02, local, by the report's author)

Method: send one keep-alive request, then time how long the server takes to close the idle socket.

| Server | Measured idle close | Notes |
|---|---|---|
| uvicorn 0.54.0 alone | 5.0 s | |
| gunicorn 26.2.0 + uvicorn worker (usual FastAPI deployment) | 2.0 s | same with `--threads 2` or `GUNICORN_CMD_ARGS='--threads 4'`, which silently switch the default worker to gthread |
| Node v22.23.2 `http.createServer` defaults | 6.0 s | `keepAliveTimeout` 5 s plus the 1 s `keepAliveTimeoutBuffer` added in v22.19.0 |
| gunicorn default **sync** worker | 0 ms (closes after every response) | NOT exposed: sends `Connection: close`; docs: "``sync`` worker does not support persistent connections and will ignore this option" (`gunicorn/config.py`); `workers/sync.py` calls `resp.force_close()` |

- Node: every released line keeps the 5 s default until v27. PR #62782 (merged 2026-04-26) raised it to 65 s and is labelled `semver-major`, so it will not be backported. Node 26 entered LTS on 2026-10-28 and is supported until 2029-04-30 (nodejs/Release `schedule.json`), so the 5 s default stays in supported Node until then. v26.0.0 and v24.11.0 still document `5000`.
- `headersTimeout` question (11-02): with `keepAliveTimeout` 12 s and `headersTimeout` 4 s, the idle close was 12.0 s on Node 18.19.0, 20.11.0, 20.12.0 and 13.0 s on 22.23.2 (its 1 s buffer), with the default connection-check interval and with a 1 s one. So on later versions `headersTimeout` does not touch the idle gap.
- Node 12.18.4 and 12.19.0 would not run: no arm64 macOS binary. The old-version `headersTimeout` behaviour (below) comes from changelogs and the issue thread and is **not measured**.

### The harm, reproduced (11-02)

A load balancer reuses an idle backend connection until its own idle timeout runs out. If it sends a request just as the server closes that connection, the request gets no response and an ALB answers 502. Reproduced with a raw-socket client that reuses the connection unless the server's FIN has already arrived, through toxiproxy with 20 ms client-to-server latency, idle gap swept in 4 ms steps.

| Server | Idle close | Requests failed | Failing gaps |
|---|---|---|---|
| Node 22.23, defaults | 6.0 s | **6 of 26** | 5,980-6,000 ms (the 20 ms before the close) |
| Node 22.23, `keepAliveTimeout = 65000` | 65 s | **0 of 26** | - |
| gunicorn 26.2.0 + uvicorn worker, defaults | 2.0 s | **6 of 26** | 1,980-2,000 ms |
| the same with `--keep-alive 75` | 75 s | **0 of 26** | - |
| Node defaults, no added latency (1 ms steps) | 6.0 s | 2 of 31 | 6,000-6,001 ms |

- The failure window equals the one-way delay. In a VPC it is narrow, so failures are intermittent. They cluster on connections idle for about the server's close time (low or bursty traffic).
- An earlier attempt found 0 failures in 70. The report calls it a flawed experiment: it swept gaps around 5.0 s while Node >= 22.19 closes at 6.0 s, and used Node's own HTTP agent rather than a client that reuses connections like a load balancer.
- **Limit:** the reproduction ran on Node 22.23 only, and shows the mechanism, not an ALB measurement.

## 3. Rules

- **T1:** the app's effective idle close must exceed the LB idle timeout. On the old Node versions in section 6, the effective close is the smaller of `keepAliveTimeout` and `headersTimeout`, so `keepAliveTimeout = 65_000` with the default `headersTimeout` fails there (40 s or 60 s <= 60 s). Not applicable when the server closes every connection (gunicorn sync): printed as a pass with its reason.
- **T2:** a pod behind a load balancer delays its shutdown so endpoint removal can propagate. Any of these counts: a preStop `exec: sleep N` or `sleep` handler; an in-process drain (lightship, terminus `beforeShutdown`, a literal SIGTERM-handler delay); a declared drain. A terminus `beforeShutdown` whose duration cannot be resolved passes T2 and makes T3 *unresolved*, printed, not guessed.
- **T3 (worst-case bound unless the longest request is known):** `terminationGracePeriodSeconds` >= preStop delay + in-process drain delay + L + 1 s, where L is `longest_request_s` declared in `tripcurve.yaml`, otherwise the server's graceful timeout as a ceiling. With L undeclared a T3 finding is a **warning**: "workers are SIGKILLed only if a request is still running {grace - preStop - drain} s after SIGTERM". With L declared it is pass/fail.
- **T4 (ported from cdk-nag, credited in `--explain`):** SQS visibility >= 6 x function timeout + batching window.
- **Waivers:** inline comment (`# tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31`) or a `waive:` entry in `tripcurve.yaml`. Each needs a reason and an expiry date. Waived findings are printed and emitted as SARIF `suppressions` (`kind: inSource` or `external`, reason as `justification`). An expired waiver fails again.
- **Deliberately NOT a rule:** `deregistrationDelay < sleep < terminationGracePeriod` (suggested in aws-load-balancer-controller #2366). AWS's own EKS guide recommends `sleep 10` against a 300 s default deregistration delay, which that inequality would flag; a rule contradicting the vendor guide needs its own evidence and there is none. So tripcurve does not parse the deregistration delay.

## 4. Where the analogy breaks, and the fix

- (a) Breaker curves are fixed; software defaults move. Each knowledge-base entry carries a version range and a doc URL. The runtime version comes from the image tag, `engines` or the Dockerfile `FROM` line. If unknown, both values are evaluated and the finding is marked "version-dependent".
- (b) Pod termination is a race, not a measured quantity. Endpoint removal and SIGTERM are concurrent (EKS guide), so no static inequality proves a rollout safe. tripcurve checks only what is statically checkable (a drain delay exists, the grace period covers it) and prints the propagation allowance (AWS's `sleep 10`) as an assumption.
- (c) Some settings live outside Git (LB attributes edited in the console). The MVP reports "unresolved, default assumed". Reading live AWS attributes is the paid tier.
- (d) A coordinated config does not prove the app drains; whether code handles SIGTERM is a runtime question and out of scope.
- (e) Curves must come from tests, not catalogue text. gunicorn `keepalive` does nothing on the default sync worker. Node >= 22.19 closes 1 s later than `keepAliveTimeout` says. So tripcurve resolves the **worker model** before applying a keep-alive default: it reads `-k` / `--worker-class`, `worker_class` in `gunicorn.conf.py`, `GUNICORN_CMD_ARGS`, and treats `--threads` > 1 as gthread, as gunicorn does. Every knowledge-base entry ships with its measurement script (about 15 lines: one request, then time the close). CI reruns it against each pinned server version, so a default that changes upstream fails tripcurve's own build before it gives users a wrong verdict (the report's plan; no hosted CI has run).

## 5. Prior art (verified non-existence)

The missing piece: cross-file checks of LB idle vs app keep-alive and of the pod termination chain, with sourced and measured defaults. T4 exists for CloudFormation and CDK, so it is a credited port, not claimed new. The novelty is T1-T3.

### Closest three

| Item | Stars | Last push | What it is / how tripcurve differs |
|---|---|---|---|
| https://github.com/cdklabs/cdk-nag (rule `LambdaEventSourceSQSVisibilityTimeout`) | 1,051 | 2026-11-02 (rule added 2024-11-01, PR #1813) | "SQS queue visibility timeout of Lambda Event Source Mapping is at least 6 times timeout of Lambda function". Exactly T4, CDK only, without the batching window. Nothing for LB idle vs keep-alive or pod termination (`idleTimeout`, `deregistration` return 0 hits in the repo). |
| https://github.com/hasanyelaldi/plimsoll | 0 | 2026-10-28 (created 10-14) | Extracts retry, timeout and circuit-breaker settings from Java/Spring/Istio config with a library-defaults knowledge base; computes RPC call-graph limits. README: "pre-v0.1 ... Nothing is usable yet". Knowledge-base files (http, istio, resilience4j, spring-*) have no LB idle, pod-termination or queue entries. This tool is what cut the earlier RPC deadline-lint idea. |
| https://github.com/zegl/kube-score | 3,106 | 2026-05-20 | Single-object Kubernetes checks. No rule relates `terminationGracePeriodSeconds`, a preStop delay and the server's graceful timeout across a workload chain. Same for stackrox/kube-linter (3,527 stars, 2026-10-28) and FairwindsOps/polaris (3,399 stars, 2026-11-02). |

### Also seen

- aws-cloudformation/cfn-lint rule E3505 (2,646 stars, 2026-11-02): "Validate SQS 'VisibilityTimeout' is greater than a function's 'Timeout'". T4's pair with a weaker ">" threshold, CloudFormation only.
- telemetry-sh/keepalive-mismatch-lab (0 stars, 2026-07-29): an interactive lab, not a checker.
- canonical/data-platform-k8s-mutator (1 star): sets the grace period.
- npm `@neurocode.io/k8s-graceful-shutdown`: a runtime library.
- retrystack (0 stars), Suryadeep02/Stormcheck (0), sibasispadhi/resilience-config-lint (0): RPC graphs, hand-declared or resilience4j only.
- Kubernetes linters kube-score, kube-linter, Polaris, Popeye, Kubescape, Datree check single objects.

### Searches run (all dates 10-29 to 11-02)

- **GitHub repo queries, zero results:** `preStop hook lint`, `deregistration delay kubernetes`, `keep-alive timeout load balancer 502`, `visibility timeout lambda check`, `keepalive timeout lint`, `sqs visibility timeout lint`, `drain timing kubernetes lint`, `kubernetes graceful shutdown checker`. Others: `graceful shutdown lint` 2 (Go templates); `terminationGracePeriodSeconds` 3 (a mutating webhook, an empty repo, a drain experiment); `zero downtime deployment check kubernetes` 10 (deployers); `idle timeout mismatch` 2 (a lab, an FTC SDK); `celery visibility timeout` 4 (examples); `timeout coordination` 6 (runtime libraries); `timeout retry static analysis` 3 (plimsoll, resilience-config-lint, Stormcheck).
- **Code search in existing linters:** kube-score `preStop` 1 (README_PROBES.md), `terminationGracePeriod` 1 (testdata). kube-linter `preStop` 0, `terminationGracePeriod` 1 (test fixture). Polaris, Popeye, Kubescape regolibrary, Datree `preStop` 0 each. Kyverno policies `terminationGracePeriodSeconds` 18 (single-field policies such as `mutate-large-termination-gps`). gatekeeper-library `preStop` 17 (host-probe security policy). checkov `idle_timeout` 12 and `deregistration_delay` 1, all test fixtures. cfn-lint `DeregistrationDelay` 0, `idle_timeout` 0, `VisibilityTimeout` 5 (E3505).
- **Terraform and IaC linters** (11-02 night, code search for `visibility_timeout_seconds`, `visibility_timeout`, `VisibilityTimeout`, `idle_timeout`, `deregistration_delay`): terraform-linters/tflint-ruleset-aws only attribute type mappings (`rules/models/mappings/sqs.hcl`, `elbv2.hcl`), no cross-resource rule; Checkmarx/kics test fixtures and a shared library file; bridgecrewio/checkov one test fixture; aquasecurity/trivy-checks only a kubelet rule; tenable/terrascan, fugue/regula, terraform-compliance/cli, aquasecurity/tfsec, aws-cloudformation/aws-guard-rules-registry, stelligent/cfn_nag: 0. cdklabs/cdk-nag: the T4 rule.
- **npm:** `keepalive timeout lint`, `graceful shutdown kubernetes lint`, `prestop`, `load balancer idle timeout`, `sqs visibility timeout` return only runtime libraries and SDKs.
- **Name:** npm `tripcurve` free (404 on 11-02; **[lookup 2026-11-10] still 404**); GitHub `tripcurve in:name` has 2 unrelated repos.
- **Not swept (the judges' last note):** awesome-* lists and PyPI.

## 6. Node `headersTimeout` trap (from nodejs/node #27363)

- From the CVE-2019-5737 change (6.17.0, 8.15.1, 10.15.2, 11.10.1) until PR #32329 (12.19.0 and 13.13.0; never backported to 10.x), the headers timer also ran across the idle gap between keep-alive requests. On those versions the effective idle close is min(`keepAliveTimeout`, `headersTimeout`), and the default `headersTimeout` is 40 s on 10.x and 60 s on 12.x and 13.x (`doc/api/http.md` at v10.15.3, v10.24.1, v12.18.4, v13.12.0).
- Source for this range: changelogs `CHANGELOG_V6.md`, `V8`, `V10`, `V11`, `V12`, `V13`, `V14` and the issue thread. **Not measured** (no arm64 build).
- Thread content: "A service which runs behind the AWS Application Load Balancer" got "HTTP 502 errors thrown by the load balancer". The old fix was "setting `server.keepAliveTimeout = X` where X is higher than the keep-alive timeout on the load balancer side". But "With version 10.15.3 setting `server.keepAliveTimeout = X` does not work anymore and we see regular 502 errors". The workaround (2019-10-10): "ELB timeout < keepAliveTimeout < headersTimeout".
- Comments from 2024-2025 report ALB 502s on Node 20.x with `keepAliveTimeout` 65 s, and one advises `headersTimeout` of at least 66 s. In the report's measurement on 20.11.0 and 20.12.0, `headersTimeout` did not shorten the idle close, so those reports have an unidentified cause and are **not counted**.

## 7. Demand evidence

- **kubernetes-sigs/aws-load-balancer-controller** (4,343 stars). Three issues, all closed *not planned* by the stale-issue bot, not fixed:
  - **#2366** "pod termination might cause dropped connections": 95 thumbs-up, 77 comments, closed 2025-11-13 because the project "lacks enough active contributors". The body says SIGTERM handling and target-group removal "are decoupled from one another ... The LB will in-turn reply with 5xx responses". The report read all 77 comments through the API: 31 discuss a preStop sleep (regex counts: preStop/sleep 31, grace 15, deregistration 15, readiness gate 8). The maintainer's first reply: "I'm not aware of any general solution that is better than a preStop hook". A commenter asks whether the right config is `deregistrationDelay < sleep duration < terminationGracePeriod`; tripcurve checks only the second inequality (see section 3). **The report counts #2366 as demand for the configuration check only**, not for a fix to the race.
  - **#1719** "Getting 502/504 with Pod Readiness Gates during rolling updates": 70 reactions, 50 comments (closed 2025-10-31).
  - **#1064** "ALB sending requests to pods after ingress controller deregisters them leading to 504": 36 reactions, 49 comments (closed 2025-05-19).
- **Node.js core changed its default.** PR #62782 (merged 2026-04-26) raised `keepAliveTimeout` to 65 s. The superseded PR #59203 (29 comments): "The previous default of 5 seconds is shorter than the defaults used by common infrastructure". Related issue #59193.
- **nodejs/node #27363** "Regression issue with keep alive connections": 32 reactions, 32 comments, closed 2020-04-02 (section 6). Fix shipped in 12.19.0 (PR #32329).
- **AWS docs state the rules but enforce none across files:**
  - ALB attributes: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html (the 502 quote above; default idle 60 s).
  - EKS Best Practices, Load Balancing: https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html (preStop "can be a simple Exec handler such as `sleep 10`"; deregistration delay "300 seconds by default"; afterwards "any in-flight requests to that target is forcibly dropped"; grace period "30 seconds by default").
  - Lambda + SQS: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html ("We recommend setting your queue's visibility timeout to six times your Event Function timeout, plus the value of `MaximumBatchingWindowInSeconds`"). Lambda itself errors only when the timeout exceeds visibility outright.
- **Reddit (Arctic Shift archive):** r/aws "Diagnose Bad Gateway 502 on Internet Facing ALB?" (37 comments) and "Why is it that my REST API is intermittently returning 502?" (13 comments). Not read to confirm cause, **not counted**.
- **Honest limit (report):** the issues describe the symptom. None asks for a linter by name. The evidence mapping one-to-one onto a rule is T1's: Node changed its own default, #27363 describes the ALB 502, and the reproduction shows the mechanism. For gunicorn, T1 applies only to threaded, async and uvicorn workers; the sync default is immune.

## 8. MVP scope and estimate (5-7 days, one person, Claude Code, part-time)

- **Parsers:**
  - Kubernetes YAML (raw files, or `kustomize build` / `helm template` output with flags).
  - AWS LB Controller annotations: Ingress `load-balancer-attributes` (`idle_timeout.timeout_seconds`), `target-type`, plus the NLB Service equivalents.
  - Pod spec: `terminationGracePeriodSeconds`, and preStop as `exec: sleep N` or the `sleep` handler.
  - Server settings: gunicorn (`--keep-alive`, `--graceful-timeout`, `-k` / `--worker-class`, `--threads`), uvicorn (`--timeout-keep-alive`), `GUNICORN_CMD_ARGS`, `gunicorn.conf.py` literals (`keepalive`, `worker_class`, `threads`), Node `keepAliveTimeout`, `keepAliveTimeoutBuffer`, `headersTimeout` assignments (ts-morph).
  - In-process drain: `lightship` in `package.json` with a literal `shutdownDelay` in `createLightship({...})`, or its default; `@godaddy/terminus` with `beforeShutdown`; a literal `setTimeout(..., N)` inside a SIGTERM handler. Unresolvable drains are declared in `tripcurve.yaml` (`drain: {workload: api, in_process_s: 15}`).
  - Node version from the image tag, `engines` or `FROM`.
  - Terraform via npm `@cdktf/hcl2json` (v0.21.0): `aws_lb.idle_timeout`, `aws_sqs_queue.visibility_timeout_seconds`, `aws_lambda_function.timeout`, `aws_lambda_event_source_mapping.maximum_batching_window_in_seconds`; SAM/CloudFormation for the same.
- **Linking:** Ingress -> Service -> workload (selector match) -> container -> server; event source mapping -> queue + function.
- **Defaults knowledge base** (each entry: doc URL, version range, measurement script):
  - ALB idle 60 s; grace 30 s.
  - Node effective idle close: 5 s (< v22.19), 6 s (>= v22.19), 65 s + buffer (>= v27).
  - Node `headersTimeout` entry (section 6).
  - gunicorn: keep-alive 2 s for gthread, gevent, eventlet, tornado and the uvicorn worker; not applicable for sync; graceful timeout 30 s.
  - lightship (v9.1.0): `shutdownDelay` 5,000 ms when it detects Kubernetes and 0 ms otherwise (`src/factories/createLightship.ts`); its README says "defaults to `0`" for local mode only, so source, not docs, sets the value.
  - uvicorn keep-alive 5 s.
- **Output:** each finding prints the chain and each value's source (`file:line`, or `default: <doc URL> (Node <= 26)`); SARIF, JSON and a GitHub Action; `--explain T1` prints the vendor quote.
- **Plan:** day 1 Kubernetes parsing and linking; day 2 server and worker-model detection, knowledge base and measurement scripts; day 3 rules T1-T3 (in-process drain forms, `longest_request_s`) and provenance output; day 4 Terraform/SAM and T4; day 5 SARIF with suppressions, waivers, the Action, fixture tests; day 6 demo repo and README; day 7 buffer.
- **Leaves out:** GCP and Azure load balancers; layered proxy timeouts (ingress-nginx, Envoy, Istio); Kafka and Celery consumers; Go and Java servers; live AWS reads and auto-fix PRs.
- **Libraries named by the report:** ts-morph, `@cdktf/hcl2json` 0.21.0. Versions checked: lightship 9.1.0 (532 stars), `@godaddy/terminus` 4.12.1 (1,912 stars), gunicorn latest release 26.2.2 (2026-09-06), Kludex/uvicorn-worker (130 stars, last push 2025-12-01; encode/uvicorn `uvicorn/workers.py` is deprecated in its favour with the same mapping).

## 9. Monetisation (path to a paid product)

- Hosted fleet scan with a read-only AWS role: compares Git with live LB and queue attributes ("Git says 60 s, the live ALB says 120 s"), ranks findings by the ALB's CloudWatch `HTTPCode_ELB_502_Count`.
- Team tier: PR comments and a fleet view.
- Enterprise: GCP/Azure knowledge bases and org policy packs.
- The report's definition: a free OSS core that produces a verdict, plus a hosted or team tier that keeps verdicts over time and across repos or clusters.

## 10. Demo (under 5 minutes, static, no containers)

Sample repo:
- `k8s/ingress.yaml`: ALB, target-type ip, idle 60 s.
- `k8s/api.yaml`: FastAPI, `gunicorn app:app -k uvicorn_worker.UvicornWorker -w 4`, no preStop.
- `k8s/admin.yaml`: Flask, `gunicorn admin:app -w 2` (default sync worker), preStop `sleep 10`, `terminationGracePeriodSeconds: 45`.
- `k8s/web.yaml`: image `node:22.23`, preStop `sleep 10`, grace 45 s, `src/server.ts` never sets `keepAliveTimeout`.
- `infra/queue.tf`: visibility 60 s, Lambda timeout 30 s, batching window 5 s.

1. `npx tripcurve .` prints four failures and one deliberate pass, each value traced to a file line or a cited, measured default (the report's plan; no package is published; the real first-run output is demo/expected/first-run.txt):
   - `T1 web  idle close 6 s (Node 22.23 default: keepAliveTimeout 5 s + buffer 1 s) <= ALB idle 60 s (k8s/ingress.yaml:9)`
   - `T1 api  idle close 2 s (gunicorn keepalive default, uvicorn worker: k8s/api.yaml:21) <= ALB idle 60 s`
   - `T1 admin  n/a: gunicorn sync worker sends Connection: close after every response`
   - `T2 api  no drain delay before SIGTERM (target-type ip)`
   - `T4 orders  visibility 60 s < 6 x 30 s + 5 s = 185 s (infra/queue.tf:3, :12, :20)`

   The `admin` line is the precision check: a naive keep-alive rule would flag it.
2. Apply the fixes: `server.keepAliveTimeout = 65_000`, gunicorn `--keep-alive 75`, preStop `sleep 10` on `api`, visibility 190. Rerun. T3 now warns for `api`: "worst case: grace 30 s (default) < preStop 10 s + gunicorn graceful-timeout ceiling 30 s + 1 s; workers are killed only if a request outlives SIGTERM by 20 s".
3. Either declare `longest_request_s: 5` for `api` (T3 passes: 30 >= 10 + 5 + 1) or set `terminationGracePeriodSeconds: 45`. T1-T4 go green. Green does not mean zero-downtime: the SIGTERM race and the deregistration delay are outside the rules. Upload `--format sarif` and the earlier findings appear as code-scanning annotations on the PR (the report's expectation; no upload has been made).

## 11. Scoring, and the arena's verdict

Scoring (0-3 on five criteria; gap is a gate, below 2 is cut):

| Gap | Demand | Solo-buildable | Paid path | Demo-able | Total | Verdict |
|---|---|---|---|---|---|---|
| 3 | 2 | 3 | 2 | 2 | **12** | in |

- Gap stays 3 because nothing checks T1-T3. T4 is a credited port.
- Demand fell from 3 to 2 on the last re-check: #2366 supports only the configuration half of T2/T3, and T1 does not apply to gunicorn's default worker.
- The report is the output of a 100-agent single-elimination arena (champion a044, 7 wins, final 81.5-78.5). tripcurve began as the replacement for the cut RPC deadline-lint idea (plimsoll exists, gap 1).

### Weaknesses the judges and attackers raised (arena run record, rounds 3-7), and how the report answered

- **Fatal: gunicorn sync-worker false positive** (round 4). A naive keep-alive rule flags the default sync worker, which closes after every response. Fixed: worker-model detection, T1 not applicable for sync, demo rebuilt on the uvicorn worker with measured defaults.
- **#2366 overcounted** (round 4). Restricted to the configuration check; the headline moved to Node PR #62782.
- **Unused deregistration parser** and #2366's first inequality (round 6). Parser removed, inequality explicitly not checked, with the reason (section 3).
- **T3 over-claimed** (round 6). Relabelled a worst-case warning; pass/fail only with a declared `longest_request_s`.
- **Flawed first keep-alive experiment** (round 5). Rerun with a raw-socket client and a 20 ms latency toxic; disclosed in the report body.
- **In-process drain** (round 5). lightship, terminus and SIGTERM-handler forms added.
- **Selective quote of nodejs/node #27363** (round 7). Quoted in full; `headersTimeout` modelled for 10.15.2 to 12.18/13.12 and measured on later versions.
- **Leftover slips the final judge named:** a day-12-of-42 mismatch in pr-rla's demo (not tripcurve), a 130,401 vs 130,388 count (pr-rla), and no awesome-* or PyPI sweep (applies to every project, including this one).
- Only the judges' verdict summaries (the `reason` and `survived` fields for every match the champion played) were read for this section, not every attack and defence transcript. No tripcurve-specific unresolved attack appears in them; that is not proof there are none.

## 12. What is thin or uncertain (consolidated)

1. No issue asks for a linter by name; demand is inferred from symptoms and from Node changing its own default.
2. The race reproduction is Node 22.23 and gunicorn+uvicorn on one laptop through toxiproxy, not an ALB. The ALB's real behaviour at the idle boundary is not measured.
3. Old-Node `headersTimeout` behaviour (10.15.2 to 12.18, 13.12) is from changelogs and an issue thread, not measured; no arm64 build.
4. 2024-2025 reports of 502s on Node 20.x with 65 s keep-alive are unexplained and excluded.
5. Defaults move: gunicorn is on 26.2.x, uvicorn 0.54.0, Node 27 will change the default. The knowledge base must be rebuilt from measurement scripts, not copied from this file.
6. T4 is not novel (cdk-nag, cfn-lint). Do not market it as new.
7. Paid-path assumptions (live AWS reads, CloudWatch ranking) are unvalidated.
8. A tool that runs on 0 stars today competes with nothing but also has no proven user pull: 5-7 days is the estimate for the OSS core only.

## 13. Day-1 re-measurement (bolt B0) **[lookup 2026-11-11]**

Measured on 2026-11-11 by the build's own scripts (`measure/`), on one macOS darwin-arm64 machine, three runs per version. Raw lines: `measure/results/2026-11-11-b0.jsonl`; version lookups, tarball checksums and package lists: `measure/results/2026-11-11-lookups.txt`. Method: one keep-alive request, time from the last response byte to the server's FIN (no sweep, no proxy).

| Server (all defaults) | Idle close measured | Note |
|---|---|---|
| Node 22.23.2, 22.23.5 | 6.0 s (6002 to 6003 ms) | 22.23.5 is the newest 22.x on 2026-11-11 |
| Node 24.22.3 | 6.0 s (6002 to 6003 ms) | newest 24.x; first measurement of this line |
| Node 26.13.1 | 6.0 s (6002 to 6003 ms) | newest 26.x; first measurement of this line |
| gunicorn 26.2.0 and 27.0.0, each with uvicorn-worker 0.4.0 and uvicorn 0.54.0 | 2.0 s (2001 to 2003 ms) | gunicorn 27.0.0 was uploaded to PyPI on 2026-11-10 |
| uvicorn 0.54.0 alone (plain install, h11) | 5.0 s (5002 to 5003 ms) | |

- For Node 24 and 26 only the total is measured. The split into 5 s `keepAliveTimeout` plus a 1 s buffer comes from the 22.x research (section 2).
- Every value is 1 to 3 ms above the nominal setting and none below.
- Linux values are inferred, not measured.

## 14. Node's explicit keepAliveTimeout and where the extra second starts (bolt B3) **[lookup 2026-11-11 local time, UTC-6; the result records carry the UTC date 2026-11-12, for example the lookup at 2026-11-12T05:51Z]**

Measured by `measure/node-explicit.mjs` and `measure/node-b3-case.mjs` from checksum-verified official darwin-arm64 tarballs, 3 runs each. Raw lines: `measure/results/2026-11-11-b3.jsonl` and `measure/results/2026-11-11-b3-versions.jsonl`; tarball hashes in `measure/results/2026-11-11-lookups-b3.txt`.

| Node | `keepAliveTimeoutBuffer` property | Default idle close | Explicit K |
|---|---|---|---|
| 18.20.8 | absent | 5.0 s | K (7000 gives 7.0 s) |
| 20.20.2, 22.12.0, 22.18.0, 24.0.0, 24.5.0 | absent | 6.0 s | K + 1 s (7000 gives 8.0 s) |
| 22.19.0, 24.6.0, 26.0.0 | 1000 (0 removes the extra second) | 6.0 s | K + 1 s |
| 22.23.2, 22.23.5, 24.22.3, 26.13.1 | 1000 | 6.0 s | K + 1 s for K = 7000, 12000, 65000 |

- **Correction to section 2.** The extra second is older than the `keepAliveTimeoutBuffer` property, which first appears in 22.19.0 and 24.6.0. Section 2 attributed the second to the property ("plus the 1 s `keepAliveTimeoutBuffer` added in v22.19.0"). That is wrong for idle close: 20.20.2, 22.12.0 and 22.18.0 already close at 6.0 s.
- **Research conflict settled.** The research reported 65 s for an explicit 65000. On every measured version it closes at 66 s, matching the research's own 13.0 s for an explicit 12000.
- **Not measured.** Where between 18.20.8 and 20.20.2 the extra second starts. Each range is bracketed by the versions above, not measured release by release. All values are for darwin-arm64.
