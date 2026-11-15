# Arena report extract: tripcurve

Verbatim copy of the shared sections and this project's section from the arena report "Unique project candidates 2026-10-28" (sweep 2026-10-29, re-checks through 2026-11-02). It is the primary source for docs/research.md. Do not edit; treat as read-only evidence. Other projects mentioned inside the shared sections belong to the owner's other personal projects.

---

## Assumptions and limits

- **"Does not exist" means no substantially equivalent open-source tool.** Well-starred *primitives* (toxiproxy, Argo CD sync windows) may exist. Each section names the missing layer and how it differs from the closest items.
- **Gate rule.** An idea needs a gap score of at least 2 (see the matrix). A gap of 1 means the same mechanism already exists somewhere, so the idea would be a feature or a port, not a new project.
- **The last re-check changed the set.** My earlier project 2, an RPC timeout/retry coordination linter, is cut. Four partial tools appeared in 2026, and one of them (hasanyelaldi/plimsoll) already extracts those values from real Java/Spring/Istio config. Project 2 is now **tripcurve**. It uses the same analogy on the layer none of them check: load-balancer idle timeouts, pod shutdown and queue visibility.
- **Stack.** TypeScript throughout. Estimates assume one person using Claude Code, part-time.
- **"Path to a paid product"** means a free OSS core that produces a verdict, plus a hosted or team tier that keeps verdicts over time and across repos or clusters.
- **Sources reached:**
  - GitHub search, REST, GraphQL and code search; the npm registry; HN Algolia; the arXiv API.
  - The Atlassian Marketplace REST API and Atlassian's public issue tracker.
  - The official plugin repos (anthropics/claude-plugins-official, openai/plugins).
  - skills.sh, skillsmp.com, claude-plugins.dev and agentskills.io (site-restricted web search plus page fetches).
  - Vendor docs; controller source read at release tags.
- **Reddit.** reddit.com's JSON endpoints return HTTP 403 and the pullpush archive returned 522. I reached Reddit through the **Arctic Shift archive API**. Title search worked for r/ExperiencedDevs, r/sre, r/aws, r/node and r/ArgoCD. It timed out for r/kubernetes and for some r/devops queries. Scores are as the archive recorded them.
- **Local experiments.** I ran these on one 10-core laptop (macOS) with real tools:
  - mel-check's fault modes: redis-server, toxiproxy 2.13.0 (binary SHA-256 checked against the release's `checksums.txt`), ioredis 5.11.1, node-postgres 8.23.1 with PostgreSQL 16.15, and Node 22.23 `http`/`https`.
  - tripcurve's keep-alive defaults and the keep-alive race: gunicorn 26.2.0, uvicorn 0.54.0, uvicorn-worker 0.4.0 and Node v22.23.2.
  - more mel-check clients: Node `http2`, @grpc/grpc-js 1.14.7, redis-py 8.1.0 (Python 3.14), Go 1.27.1 `net/http`, Node `fetch`, and curl through toxiproxy to api.sendgrid.com.
  - crankpath's rendering inputs: helm v4.3.1 (tarball SHA-256 checked) rendering hashicorp/vault-helm v0.34.1 and khuedoan/homelab at commit 8b9d40f.
  - mel-check's crash path: a minimal Express app (5.3.0, and 4.22.3 for comparison) with a node-postgres 8.23.1 `Pool` and `fetch()`, its dependency's proxy disabled after a warm-up.
  - tripcurve's `headersTimeout` question: idle-close timings on Node 18.19.0, 20.11.0 and 20.12.0 (the npm `node` binaries) and 22.23.2.

  They are the source of the measured numbers in projects 2–4. A laptop is not a CI runner, and where that matters I say so. The Docker daemon was not available, so nothing at the docker-compose level (mel-check's generated override) has been run; I say so where it applies.

## Summary

| # | Name | Size | Kind / channel | Build estimate | Strongest demand number | Closest existing item |
|---|---|---|---|---|---|---|
| 1 | **pr-rla**: risk-limiting audit for agent PRs that merged with no recorded human review | S | AI-agent governance: CLI + GitHub Action + Claude Code skill | 3 days (v0.1 at day 2); the first pre-registered certificate about 7 weeks after day 1 (a six-week window) | github/gh-aw: **2,719 of 2,949** merged Copilot PRs had no recorded human approval or change request (every review read via GraphQL). A named human account clicked merge on every one, so the problem is shallow review, not absent review; GitHub search classifies **130,401 of 138,064** Q3 Copilot-agent PRs as `review:none`. Buyer: SOC 2 auditors already test change control on samples of **25 → 40 → 60** changes | atelierfactory/agent-pr-ledger (0★; counts reviews, no inference) |
| 2 | **tripcurve**: coordination study for timeouts *between* layers (LB idle ↔ app keep-alive, pod shutdown chain, queue visibility) | M | Static config linter (SARIF / GitHub code scanning) | 5–7 days | Node.js core raised its keep-alive default 5 s → 65 s (PR #62782) because 5 s "is shorter than the defaults used by common infrastructure". aws-load-balancer-controller #2366 (**👍95**) counts only for the termination *config*: 31 of its 77 comments are about the preStop/grace settings T2/T3 check. Harm reproduced locally: **6 of 26** requests in an idle-gap sweep failed, all in the 20 ms before a default server's idle close; **0 of 26** after the fix | cdklabs/cdk-nag rule `LambdaEventSourceSQSVisibilityTimeout` (1,051★): T4's 6× rule, CDK only; nothing for T1–T3 |
| 3 | **mel-check**: Minimum Equipment List for a service's dependencies, verified in CI | M | Declarative CI test framework (docker compose + toxiproxy) | 2.5 weeks | Cloudflare 2025-06-12: one storage dependency caused **2 h 28 min** of impact; **90.22%** of Workers KV requests failed | filibuster-testing/filibuster (74★, archived 2022): per-call faults raised as exceptions, so it never tests a real timeout; a new release is announced |
| 4 | **crankpath**: black-start planner and cycle finder for GitOps estates | L− | Static DR planner (CLI + Action; no cluster needed) | 3 weeks | Two extracted cycles in khuedoan/homelab (**9,710★**): Argo CD reads its Git from a Gitea it deploys, and Argo CD manages itself. The repo breaks both by hand in its bootstrap playbook. A Flux maintainer says cross-kind cycles "will also not be detectable" under RFC #5879 (31 reactions). Ordering, not cycles: argo-cd #7437, 391 reactions | stuttgart-things/clusterscope (0★; graph picture only) |
| 5 | **kube-tagout**: lockout–tagout for cluster automation during incidents | L | Incident-ops CLI + MCP server (agents request, humans approve); hosted lock board behind incident-tool webhooks | 3–4 weeks | argo-cd #3039 "Ability to suspend an argo application": **👍120**, closed *not planned*. The manual freeze takes "**10 to 20 minutes** … while the incident is active" | kube-green/kube-green (1,384★): scheduled multi-kind patch with saved restore; no on-demand lock, ordering, owner or verification |

Build order: 1 → 2 → 3 → 4 → 5.
- Projects 1, 2 and 4 need no containers to demo.
- Project 3 needs docker compose.
- Project 5 needs a kind cluster, and it is the only one that writes to a live cluster. Its key mechanisms (the verify barrier and the KEDA hand-off) are source-verified but not yet run, so its first build day is a go/no-go spike.

## How the five were chosen

Each candidate was scored 0–3 on five criteria. **Gap** is a gate: a gap of 0 means an equivalent exists, and a gap of 1 means the mechanism exists elsewhere. Both are cut, whatever the total.

| Candidate (source analogy) | Gap | Demand | Solo-buildable | Paid path | Demo-able | Total | Verdict |
|---|---|---|---|---|---|---|---|
| pr-rla (election risk-limiting audit) | 3 | 2 | 3 | 2 | 3 | **13** | in |
| kube-tagout (industrial lockout–tagout) | 2 | 3 | 2 | 2 | 3 | **12** | in |
| tripcurve (breaker coordination across voltage levels) | 3 | 2 | 3 | 2 | 2 | **12** | in |
| mel-check (aviation MEL) | 2 | 2 | 2 | 3 | 3 | **12** | in |
| crankpath (grid black start) | 2 | 2 | 2 | 3 | 2 | **11** | in |
| RPC deadline-lint (breaker coordination, call graphs) | 1 | 3 | 3 | 2 | 3 | 12 | cut by gate (plimsoll) |
| Instigator-aware approval check (two-person rule) | 1 | 2 | 3 | 2 | 3 | 11 | cut by gate (a policy-bot option) |
| LLM-judge Gage R&R (manufacturing MSA) | 1 | 2 | 3 | 2 | 2 | 10 | cut by gate |
| Bitbucket PR-comment trigger for Agentic Pipelines | 1 | 1 | 3 | 1 | 3 | 9 | cut by gate |
| Prior-art / novelty-check skill (patent search) | 2 | 0 | 3 | 1 | 3 | 9 | cut: no demand found |
| Jira automation-rule analyzer (firewall rule-anomaly analysis) | 1 | 2 | 2 | 0 | 2 | 7 | cut by gate (paid apps exist) |
| `@claude` pipe for Bitbucket; Bitbucket merge queue; "Dependabot for LLM model IDs"; skills lockfile, agent file-claims, AGENTOWNERS, CLAUDE.md path-rot | 0 | – | – | – | – | — | equivalents exist |

Score changes on the latest re-check:
- kube-tagout's gap fell from 3 to 2. kube-green already restores multi-kind patches from saved inverse patches, on a schedule. Its paid path fell from 3 to 2: the Marketplace's freeze apps have 0–1 installs, so the Jira app is no longer the wedge.
- pr-rla's demand fell from 3 to 2. The population is real and large, but the named teams above the floor are few, and nobody asks for sampling by name.
- tripcurve's demand fell from 3 to 2. Its biggest issue (#2366) supports only the configuration half of T2/T3, and T1 does not apply to gunicorn's default worker.
- crankpath's demand fell from 3 to 2. Its headline issue asks for ordering, not cycle detection.
- deadline-lint's gap fell to 1, after retrystack (10-29) and plimsoll (10-14) were found.
- tripcurve is new. Its gap stays 3 because nothing checks T1–T3. Its fourth rule (T4) is not new: cdk-nag already has it for CDK, so in tripcurve it is a credited port to Terraform.
- mel-check's gap stays 2 after the last sweep found filibuster-testing/filibuster. It explores per-call faults from tests, but it raises exceptions in place of the calls, so it cannot test whether a timeout exists or has the declared value. Its announced Go/TypeScript release is the risk named in project 3.
- No total changed in the later checks. pr-rla's paid path stays at 2, now with a named buyer (SOC 2-audited teams) but no customer yet. crankpath's estimate rose to 3 weeks, because two input forms moved into the MVP after a measurement.

---

## 2. tripcurve: coordination study for the timeouts between layers

**Pitch.** Electrical engineers coordinate protective devices across voltage levels. A time–current study proves that each breaker, fuse and relay trips in the right order, so a fault clears at the nearest device and nothing upstream trips first. The timeouts *between* infrastructure layers need the same ordering, and with today's defaults they often have it backwards:
- **Keep-alive.** An AWS ALB keeps idle connections to targets for 60 s by default. Most Python and Node servers close them far sooner. I measured each one on 11-02: send one keep-alive request, then time how long the server takes to close the idle socket.
  - uvicorn 0.54.0 on its own: **5.0 s**.
  - gunicorn 26.2.0 with the uvicorn worker (the usual FastAPI deployment): **2.0 s**. The same with `--threads 2` or `GUNICORN_CMD_ARGS='--threads 4'`, which silently switch the default worker to gthread.
  - Node v22.23.2 `http.createServer` defaults: **6.0 s**. That is `keepAliveTimeout` 5 s plus the 1 s `keepAliveTimeoutBuffer` added in v22.19.0. Every released line keeps the 5 s default until v27. The change (PR #62782) is labelled `semver-major`, so it will not be backported. Node 26 entered LTS on 2026-10-28 and is supported until 2029-04-30 (nodejs/Release `schedule.json`), so the 5 s default stays in supported Node until then.
  - gunicorn's default **sync** worker is *not* exposed. It sends `Connection: close` and closes after every response (0 ms), so the ALB never reuses an idle connection to it. Its docs say so: "``sync`` worker does not support persistent connections and will ignore this option" (`gunicorn/config.py`).

  AWS: "We also recommend that you configure the idle timeout of your application to be larger than the idle timeout configured for the load balancer. Otherwise … the load balancer sends an HTTP 502 Bad Gateway error to the client."

  **The harm, reproduced (11-02).** A load balancer reuses an idle backend connection until *its own* idle timeout runs out. If it sends a request just as the server closes that connection, the request gets no response, and an ALB answers the client with a 502. I reproduced this with a raw-socket client that behaves that way: it reuses the connection unless the server's FIN has already arrived. It ran through toxiproxy with 20 ms of client→server latency, and swept the idle gap in 4 ms steps.

  | Server | Idle close | Requests failed | Failing gaps |
  |---|---|---|---|
  | Node 22.23, defaults | 6.0 s | **6 of 26** | 5,980–6,000 ms: the 20 ms before the close |
  | Node 22.23, `keepAliveTimeout = 65000` | 65 s | **0 of 26** | – |
  | gunicorn 26.2.0 + uvicorn worker, defaults | 2.0 s | **6 of 26** | 1,980–2,000 ms |
  | the same with `--keep-alive 75` | 75 s | **0 of 26** | – |
  | Node defaults, no added latency (1 ms steps) | 6.0 s | 2 of 31 | 6,000–6,001 ms |

  The failure window equals the one-way delay. In a VPC it is narrow, so failures are intermittent, which matches the issues below. They cluster on connections that sit idle for about the server's close time, which is typical of low or bursty traffic. An earlier attempt of mine found 0 failures in 70. That was a flawed experiment, not a negative result: it swept gaps around 5.0 s, but Node ≥ 22.19 closes at 6.0 s, and its client was Node's own HTTP agent, not a client that reuses connections the way a load balancer does.
- **Pod shutdown.** On a rollout, Kubernetes sends SIGTERM and starts endpoint removal at the same time. AWS's EKS guide recommends a preStop `sleep 10` so the load balancer stops routing first. But preStop 10 s plus gunicorn's default 30 s graceful timeout, a ceiling rather than a duration, exceeds the default 30 s grace period. Workers are SIGKILLed only if a request is still running about 20 s after SIGTERM. tripcurve reports that as a worst-case bound, and turns it into pass/fail when the longest request is declared.
- **Queues.** An SQS queue with 60 s visibility feeding a 30 s Lambda: AWS recommends visibility of at least 6 × the function timeout plus the batching window.

Each of these is an inequality between values in *different* files: Ingress annotations, the Deployment spec, container args, app code and Terraform. Most of the values are defaults nobody wrote down. Some also depend on which worker model the server runs. `tripcurve` reads them all and fills in defaults from a versioned knowledge base that cites a source for each. It fails CI on miscoordination and prints every number with its source.

**What is new against the closest tools.**
- The RPC tools model service-to-service retries and timeouts, and none has a rule for LB idle vs keep-alive, the pod termination chain or queue visibility. They are retrystack, Stormcheck, resilience-config-lint and plimsoll; I checked their READMEs and plimsoll's knowledge-base files.
- Only T4's pair exists elsewhere: cfn-lint rule E3505 (a weaker ">" check) and cdk-nag rule `LambdaEventSourceSQSVisibilityTimeout` (AWS's 6× rule, without the batching window) cover it for CloudFormation and CDK. No Terraform linter has it (eight searched; see below). So in tripcurve T4 is a credited port to Terraform, not a new rule. The novelty is T1–T3.
- The Kubernetes linters (kube-score, kube-linter, Polaris, Popeye, Kubescape, Datree) check single objects.

**Where the analogy breaks, and the fix.**
- **(a) Breaker curves are fixed; software defaults move.** Node raised `keepAliveTimeout` from 5 s to 65 s in PR #62782 (merged 2026-04-26), shipping in v27. So each knowledge-base entry carries a version range and a doc URL.
  - The runtime version comes from the image tag, `engines` or the Dockerfile `FROM` line.
  - If the version is unknown, both values are evaluated and the finding is marked "version-dependent".
- **(b) Breakers act on a measured quantity; pod termination is a race.** Endpoint removal and SIGTERM are concurrent (EKS guide), so no static inequality proves a rollout safe. tripcurve checks only what is statically checkable: a drain delay exists, and the grace period covers it. It prints the propagation allowance (AWS's `sleep 10`) as an assumption, not a guarantee.
- **(c) Some settings live outside Git**, such as LB attributes edited in the console. The MVP reports them as "unresolved, default assumed". Reading live AWS attributes is the paid tier.
- **(d) A coordinated config does not prove the app drains.** Whether the code handles SIGTERM is a runtime question (project 3's territory) and out of scope.
- **(e) A device's curve depends on how it is built, and the curve must come from a test.** Breaker curves come from type tests, not from the catalogue text. Server defaults need the same treatment, because reading docs is not enough:
  - gunicorn's `keepalive` setting does nothing on its default sync worker. `workers/sync.py` calls `resp.force_close()` on every request ("Force the connection closed until someone shows a buffering proxy that supports Keep-Alive to the backend").
  - Node ≥ 22.19 closes 1 s later than its `keepAliveTimeout` says, and older lines (10.15.2 to 12.18, among others in the knowledge base) closed at `headersTimeout` when that was shorter.

  So tripcurve resolves the **worker model** before it applies a keep-alive default. It reads `-k` / `--worker-class`, `worker_class` in `gunicorn.conf.py` and `GUNICORN_CMD_ARGS`, and treats `--threads` > 1 as gthread, as gunicorn does. For a sync worker, T1 reports *not applicable* with the reason. Every knowledge-base entry also ships with the measurement script used for the numbers above (about 15 lines: one request, then time the close). CI reruns it against each pinned server version, so a default that changes upstream fails tripcurve's own build before it gives users a wrong verdict.

**Verified non-existence.** The missing piece is *cross-file checks of LB idle vs app keep-alive and of the pod termination chain, with sourced and measured defaults*. Queue visibility vs consumer timeout (T4) already exists for CloudFormation and CDK, so it is included as a port, not claimed as new.
- **GitHub repo queries:**
  - all zero: `preStop hook lint`, `deregistration delay kubernetes`, `keep-alive timeout load balancer 502`, `visibility timeout lambda check`, `keepalive timeout lint`, `sqs visibility timeout lint`, `drain timing kubernetes lint`, `kubernetes graceful shutdown checker`;
  - `graceful shutdown lint` (2, Go templates);
  - `terminationGracePeriodSeconds` (3: a mutating webhook, an empty repo, a drain experiment);
  - `zero downtime deployment check kubernetes` (10, deployers);
  - `idle timeout mismatch` (2: a lab, an FTC SDK);
  - `celery visibility timeout` (4, examples);
  - `timeout coordination` (6, runtime libraries);
  - `timeout retry static analysis` (3: plimsoll, resilience-config-lint, Stormcheck, all RPC call-graph tools).
- **Code search in existing linters:**
  - kube-score: `preStop` 1 hit (README_PROBES.md), `terminationGracePeriod` 1 (testdata).
  - kube-linter: `preStop` 0, `terminationGracePeriod` 1 (a test fixture).
  - Polaris, Popeye, Kubescape regolibrary, Datree: `preStop` 0 each.
  - Kyverno policies: `terminationGracePeriodSeconds` 18 (single-field policies such as `mutate-large-termination-gps`).
  - gatekeeper-library: `preStop` 17 (a host-probe security policy).
  - checkov: `idle_timeout` 12 and `deregistration_delay` 1, all test fixtures.
  - cfn-lint: `DeregistrationDelay` 0, `idle_timeout` 0, `VisibilityTimeout` 5 (rule E3505).
- **Terraform and other IaC linters** (11-02 night, code search for `visibility_timeout_seconds`, `visibility_timeout`, `VisibilityTimeout`, `idle_timeout` and `deregistration_delay` in each repo):
  - terraform-linters/tflint-ruleset-aws: only attribute type mappings (`rules/models/mappings/sqs.hcl`, `elbv2.hcl`), no cross-resource rule;
  - Checkmarx/kics: test fixtures and a shared library file; bridgecrewio/checkov: one test fixture; aquasecurity/trivy-checks: only a kubelet rule;
  - tenable/terrascan, fugue/regula, terraform-compliance/cli, aquasecurity/tfsec, aws-cloudformation/aws-guard-rules-registry, stelligent/cfn_nag: 0;
  - **cdklabs/cdk-nag: the rule `src/rules/lambda/LambdaEventSourceSQSVisibilityTimeout.ts`**, which is T4 (below).
- **npm:** `keepalive timeout lint`, `graceful shutdown kubernetes lint`, `prestop`, `load balancer idle timeout`, `sqs visibility timeout` return only runtime libraries and SDKs.
- **Name:** npm `tripcurve` is free (404); GitHub `tripcurve in:name` has 2 unrelated repos.

Closest three:

| Item | Stars | Last push | What it is / what it lacks |
|---|---|---|---|
| https://github.com/cdklabs/cdk-nag (rule `LambdaEventSourceSQSVisibilityTimeout`) | 1,051 | 2026-11-02 (rule added 2024-11-01, PR #1813) | "SQS queue visibility timeout of Lambda Event Source Mapping is at least 6 times timeout of Lambda function". Exactly T4, for CDK apps only, without the batching window. Nothing for LB idle vs keep-alive or pod termination (`idleTimeout` and `deregistration` return 0 hits in the repo). Found by code search `VisibilityTimeout repo:cdklabs/cdk-nag`. |
| https://github.com/hasanyelaldi/plimsoll | 0 | 2026-10-28 (created 10-14) | Extracts retry, timeout and circuit-breaker settings from Java/Spring/Istio config with a library-defaults knowledge base, and computes RPC call-graph limits. The README says "pre-v0.1 … Nothing is usable yet". Its knowledge-base files (http, istio, resilience4j, spring-*) have no LB idle, pod-termination or queue entries. Found by `timeout retry static analysis` (11-02). |
| https://github.com/zegl/kube-score | 3,106 | 2026-05-20 | Single-object Kubernetes checks. No rule relates `terminationGracePeriodSeconds`, a preStop delay and the server's graceful timeout across a workload chain. The same holds for stackrox/kube-linter (3,527★, 2026-10-28) and FairwindsOps/polaris (3,399★, 2026-11-02). Found by code search (above). |

Also seen:
- aws-cloudformation/cfn-lint rule E3505 (2,646★, 2026-11-02): "Validate SQS 'VisibilityTimeout' is greater than a function's 'Timeout'". T4's pair with a weaker ">" threshold, CloudFormation only. Found by code search `repo:aws-cloudformation/cfn-lint VisibilityTimeout`.
- telemetry-sh/keepalive-mismatch-lab (0★, 2026-07-29): an interactive lab, not a checker.
- canonical/data-platform-k8s-mutator (1★): sets the grace period.
- npm `@neurocode.io/k8s-graceful-shutdown`: a runtime library.
- retrystack (0★), Suryadeep02/Stormcheck (0★), sibasispadhi/resilience-config-lint (0★): RPC graphs, hand-declared or resilience4j only.

**Demand evidence.**
- **kubernetes-sigs/aws-load-balancer-controller** (4,343★). All three issues below were closed *not planned* by the stale-issue bot, not fixed:
  - **#2366** "pod termination might cause dropped connections": **👍95, 77 comments**. Its body: SIGTERM handling and target-group removal "are decoupled from one another … The LB will in-turn reply with 5xx responses". Closed 2025-11-13 because the project "lacks enough active contributors".
    - **What tripcurve can and cannot do for it.** The race itself (SIGTERM against target removal) cannot be checked statically. A config that passes T2/T3 can still drop connections if the sleep is shorter than the propagation time.
    - **What the thread asks for is configuration.** I read all 77 comments through the API. 31 discuss a preStop sleep. The controller maintainer's first reply: "I'm not aware of any general solution that is better than a preStop hook". A commenter asks: "would you agree that a correct configuration to handle this issue looks like `deregistrationDelay < sleep duration < terminationGracePeriod`?" tripcurve checks only the second inequality. It does not encode the first because AWS's own EKS guide (quoted below) recommends `sleep 10` against a 300 s default deregistration delay, which that inequality would flag; a rule that contradicts the vendor guide needs its own evidence, and I have none, so tripcurve does not parse the deregistration delay. Another posts a Helm template that derives the grace period from the sleep.
    - T2/T3 check that this workaround is present and that the grace period bounds it. They do not prove the sleep is long enough; tripcurve prints the sleep as an assumption. So I count #2366 as demand for the **configuration check only**, not for a fix to the race.
  - **#1719** "Getting 502/504 with Pod Readiness Gates during rolling updates": 70 reactions, 50 comments (closed 2025-10-31).
  - **#1064** "ALB sending requests to pods after ingress controller deregisters them leading to 504": 36 reactions, 49 comments (closed 2025-05-19).
- **Node.js core changed its default because of this mismatch.** PR #62782 (merged 2026-04-26) raised `keepAliveTimeout` to 65 s. The superseded PR #59203 (29 comments) gives the reason: "The previous default of 5 seconds is shorter than the defaults used by common infrastructure". v26.0.0 and v24.11.0 still document `5000`, so every released line keeps the old default until v27.
- **nodejs/node #27363** "Regression issue with keep alive connections" (32 reactions, 32 comments; closed 2020-04-02). A "service which runs behind the AWS Application Load Balancer" hit "HTTP 502 errors thrown by the load balancer". The thread shows both halves of T1:
  - The old fix was "setting `server.keepAliveTimeout = X` where X is higher than the keep-alive timeout on the load balancer side". But "With version 10.15.3 setting `server.keepAliveTimeout = X` does not work anymore and we see regular 502 errors", because from 10.15.2 the headers timer also ran across the idle gap.
  - The workaround was "ELB timeout < keepAliveTimeout < headersTimeout" (2019-10-10), and the fix shipped in 12.19.0 (PR #32329).
  - So a rule that read only `keepAliveTimeout` would pass those versions falsely. That is why the knowledge base carries `headersTimeout` for them (MVP, below).
  - Comments from 2024–2025 report ALB 502s on Node 20.x with `keepAliveTimeout` 65 s, and one advises setting `headersTimeout` to at least 66 s. In my measurement on 20.11.0 and 20.12.0, `headersTimeout` did not shorten the idle close, so those reports have a cause I have not identified, and I do not count them. My reproduction of the race (above) ran on Node 22.23 only.
- **AWS docs state the rules but enforce none of them across files:**
  - ALB attributes (https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html): the 502 quote above; default idle 60 s.
  - EKS Best Practices, Load Balancing (https://docs.aws.amazon.com/eks/latest/best-practices/load-balancing.html): preStop "can be a simple Exec handler such as `sleep 10`"; deregistration delay "300 seconds by default"; afterwards "any in-flight requests to that target is forcibly dropped"; grace period "30 seconds by default".
  - Lambda + SQS (https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html): "We recommend setting your queue's visibility timeout to six times your Event Function timeout, plus the value of `MaximumBatchingWindowInSeconds`". Lambda itself errors only when the timeout exceeds visibility outright.
- **Reddit (archive):** r/aws "Diagnose Bad Gateway 502 on Internet Facing ALB?" (37 comments) and "Why is it that my REST API is intermittently returning 502?" (13 comments). I did not read them to confirm the cause, so they are not counted.
- **Honest limit.** The issues describe the symptom. None asks for a linter by name. The evidence that maps one-to-one onto a rule is T1's: Node changed its own default because of this mismatch, #27363 describes exactly the ALB 502, and the reproduction above shows the mechanism (not an ALB measurement). For gunicorn, T1 applies only to the threaded, async and uvicorn workers; the sync default is immune (see e).

**MVP scope and estimate (5–7 days).**
- **Parsers:**
  - Kubernetes YAML (raw files, or `kustomize build` / `helm template` output with flags).
  - AWS LB Controller annotations: Ingress `load-balancer-attributes` (`idle_timeout.timeout_seconds`), `target-type`, plus the NLB Service equivalents.
  - Pod spec: `terminationGracePeriodSeconds`, and preStop as `exec: sleep N` or the `sleep` handler.
  - Server settings: container command/args for gunicorn (`--keep-alive`, `--graceful-timeout`, `-k` / `--worker-class`, `--threads`) and uvicorn (`--timeout-keep-alive`); the `GUNICORN_CMD_ARGS` env var; `gunicorn.conf.py` literals (`keepalive`, `worker_class`, `threads`); Node `keepAliveTimeout`, `keepAliveTimeoutBuffer` and `headersTimeout` assignments (ts-morph).
  - In-process drain, for T2/T3: `lightship` in `package.json` with a literal `shutdownDelay` in `createLightship({…})`, or its default; `@godaddy/terminus` with a `beforeShutdown` option; a literal `setTimeout(…, N)` inside a SIGTERM handler. A drain that the parser cannot resolve is declared in `tripcurve.yaml` (`drain: {workload: api, in_process_s: 15}`).
  - Node version from the image tag, `engines` or `FROM`.
  - Terraform via npm `@cdktf/hcl2json` (v0.21.0): `aws_lb.idle_timeout`, `aws_sqs_queue.visibility_timeout_seconds`, `aws_lambda_function.timeout` and `aws_lambda_event_source_mapping.maximum_batching_window_in_seconds`; SAM/CloudFormation for the same.
- **Linking:**
  - Ingress → Service → workload (selector match) → container → server.
  - Event source mapping → queue + function.
- **Defaults knowledge base.** Each entry has a doc URL, a version range and a measurement script:
  - ALB idle 60 s; grace 30 s.
  - Node: effective idle close 5 s (< v22.19), 6 s (≥ v22.19: 5 s + 1 s buffer), 65 s + buffer (≥ v27).
  - Node `headersTimeout`, the trap in #27363 (below). From the CVE-2019-5737 change (6.17.0, 8.15.1, 10.15.2, 11.10.1) until PR #32329 (12.19.0 and 13.13.0; never backported to 10.x), the headers timer also ran across the idle gap between keep-alive requests. On those versions the effective idle close is min(`keepAliveTimeout`, `headersTimeout`), and the default `headersTimeout` is 40 s on 10.x and 60 s on 12.x and 13.x (`doc/api/http.md` at v10.15.3, v10.24.1, v12.18.4 and v13.12.0). This range comes from the changelogs and the issue thread; I could not measure it, because Node 10–13 has no build for my arm64 laptop. On later versions `headersTimeout` does not touch the idle gap, measured on 11-02: with `keepAliveTimeout` 12 s and `headersTimeout` 4 s, the idle close was 12.0 s on 18.19.0, 20.11.0 and 20.12.0, and 13.0 s on 22.23.2 (its 1 s buffer), both with the default connection-check interval and with a 1 s one.
  - gunicorn: keep-alive 2 s for gthread, gevent, eventlet, tornado and the uvicorn worker; *not applicable* for sync (closed after each response); graceful timeout 30 s.
  - lightship (v9.1.0): `shutdownDelay` 5,000 ms when it detects Kubernetes and 0 ms otherwise (`src/factories/createLightship.ts`). Its README says "defaults to `0`" for local mode only, another case where the source, not the docs, sets the knowledge-base value.
  - uvicorn keep-alive 5 s.
- **Rules:**
  - **T1:** the app's effective idle close > LB idle timeout. On the Node versions in the `headersTimeout` entry, the effective close is the smaller of the two timeouts, so `keepAliveTimeout = 65_000` with the default `headersTimeout` fails there (40 s or 60 s ≤ 60 s). Not applicable when the server closes every connection (gunicorn sync), which is printed as a pass with its reason.
  - **T2:** a pod behind a load balancer delays its shutdown so endpoint removal can propagate. Any of these counts: a preStop `exec: sleep N` or `sleep` handler; an in-process drain (lightship, terminus `beforeShutdown`, a literal SIGTERM-handler delay); or a declared drain. A terminus `beforeShutdown` whose duration cannot be resolved passes T2 and makes T3 *unresolved*, which is printed, not guessed.
  - **T3 (a worst-case bound unless the longest request is known):** `terminationGracePeriodSeconds` ≥ preStop delay + in-process drain delay + L + 1 s, where L is `longest_request_s` declared for the workload in `tripcurve.yaml` and otherwise the server's graceful timeout as a ceiling. The graceful timeout is the longest a draining worker can wait, not how long it waits: a worker exits when its in-flight requests finish. So with L undeclared a T3 finding is a **warning** that prints "workers are SIGKILLed only if a request is still running {grace − preStop − drain} s after SIGTERM"; with L declared it is pass/fail. A service whose requests take under a second passes by declaring `longest_request_s: 2`.
  - **T4 (ported from cdk-nag, credited in `--explain`):** SQS visibility ≥ 6 × function timeout + batching window.
  - **Waivers.** An inline comment (`# tripcurve: ignore T2 reason="drains in sidecar" until=2027-01-31`) or a `waive:` entry in `tripcurve.yaml`. Each needs a reason and an expiry date. Waived findings are printed and emitted as SARIF `suppressions` (`kind: inSource` or `external`, with the reason as `justification`), and an expired waiver fails again.
- **Output:**
  - each finding prints the chain and each value's source (`file:line`, or `default: <doc URL> (Node ≤ 26)`);
  - SARIF, JSON and a GitHub Action;
  - `--explain T1` prints the vendor quote behind a rule.
- **Plan:**
  - day 1, Kubernetes parsing and linking;
  - day 2, server and worker-model detection, the knowledge base and its measurement scripts;
  - day 3, rules T1–T3 (including the in-process drain forms and `longest_request_s`) and the provenance output;
  - day 4, Terraform/SAM and T4;
  - day 5, SARIF with suppressions, waivers, the Action and fixture tests;
  - day 6, demo repo and README;
  - day 7, buffer.
- **Leaves out:**
  - GCP and Azure load balancers;
  - layered proxy timeouts (ingress-nginx, Envoy, Istio);
  - Kafka and Celery consumers;
  - Go and Java servers;
  - live AWS reads and auto-fix PRs.

**Monetisation.**
- **Hosted fleet scan with a read-only AWS role.** It compares Git with live LB and queue attributes ("Git says 60 s, the live ALB says 120 s"). It ranks findings by the ALB's CloudWatch `HTTPCode_ELB_502_Count`, so each finding comes with its measured cost.
- **Team tier:** PR comments and a fleet view.
- **Enterprise:** GCP/Azure knowledge bases and org policy packs.

**Demo (< 5 min, static, no containers).** The sample repo has:
- `k8s/ingress.yaml`: an ALB, target-type ip, idle 60 s;
- `k8s/api.yaml`: a FastAPI service, `gunicorn app:app -k uvicorn_worker.UvicornWorker -w 4`, with no preStop;
- `k8s/admin.yaml`: a Flask service, `gunicorn admin:app -w 2` (default sync worker), with preStop `sleep 10` and `terminationGracePeriodSeconds: 45`;
- `k8s/web.yaml`: image `node:22.23`, preStop `sleep 10`, grace 45 s, and `src/server.ts` never sets `keepAliveTimeout`;
- `infra/queue.tf`: visibility 60 s, Lambda timeout 30 s, batching window 5 s.

Steps:
1. `npx tripcurve .` prints four failures and one deliberate pass, each value traced to a file line or a cited, measured default:
   - `T1 web  idle close 6 s (Node 22.23 default: keepAliveTimeout 5 s + buffer 1 s) ≤ ALB idle 60 s (k8s/ingress.yaml:9)`
   - `T1 api  idle close 2 s (gunicorn keepalive default, uvicorn worker: k8s/api.yaml:21) ≤ ALB idle 60 s`
   - `T1 admin  n/a: gunicorn sync worker sends Connection: close after every response`
   - `T2 api  no drain delay before SIGTERM (target-type ip)`
   - `T4 orders  visibility 60 s < 6 × 30 s + 5 s = 185 s (infra/queue.tf:3, :12, :20)`

   The `admin` line is the precision check. A naive keep-alive rule would flag it; tripcurve knows the sync worker never holds an idle connection.
2. Apply the fixes: `server.keepAliveTimeout = 65_000`, gunicorn `--keep-alive 75`, preStop `sleep 10` on `api`, visibility 190. Rerun. T3 now warns for `api`: `worst case: grace 30 s (default) < preStop 10 s + gunicorn graceful-timeout ceiling 30 s + 1 s; workers are killed only if a request outlives SIGTERM by 20 s`. Fixing one device exposes the next one in the chain, as in a real coordination study.
3. Either declare `longest_request_s: 5` for `api` (T3 now passes: 30 ≥ 10 + 5 + 1) or set `terminationGracePeriodSeconds: 45` for the worst case. T1–T4 go green. Green does not mean zero-downtime: the SIGTERM race and the deregistration delay are outside the rules (see #2366 above). Upload `--format sarif` and the earlier findings appear as code-scanning annotations on the PR.

---

## Runner-ups

- **RPC deadline-lint (extract timeouts and retries from service code, check them across call paths).** Cut on re-verification. Four partial tools appeared in 2026:
  - Suryadeep02/Stormcheck (06-06) and rashedhasan090/retrystack (10-29): hand-declared graphs;
  - sibasispadhi/resilience-config-lint (08-14): resilience4j YAML only;
  - hasanyelaldi/plimsoll (10-14): extracts from real Java/Spring/Istio config with a library-defaults knowledge base. That was exactly my remaining differentiator.

  A TypeScript port would not be unique. One finding carries over to anyone building it: library semantics change the numbers. axios-retry by default does not retry timed-out requests (`ECONNABORTED` is excluded), and with `shouldResetTimeout: false` one axios `timeout` is spent across all attempts. A hand-declared graph would usually get both wrong.
- **`@claude` agent pipe for Bitbucket.** Cut. Atlassian's **Agentic Pipelines** (open beta; Claude Code as a provider since 2026-05-19) already defines agents in `bitbucket-pipelines.yml` with scoped OAuth tokens and a Bitbucket MCP server. The only residual gap is a PR-*comment* trigger (no comment event among the documented start conditions). That is a 2–3-day Forge app with high platform risk. Demand persists: claude-code #38179 "Native Bitbucket Integration" is at 👍83.
- **Instigator-aware approval check (two-person rule for agent PRs).** GitHub discards the requester's approval only for Copilot coding-agent PRs. For other agents, the person who typed `@claude` can approve the bot's PR, because palantir/policy-bot (1,069★) excludes authors and committers but not instigators. Cut as feature-sized (one option for policy-bot) in a crowding space (interlock, agent-pr-ledger, Korext/enforce-action, governance-control-system).
- **Jira automation-rule analyzer (firewall rule-anomaly analysis).** No OSS tool (GitHub `jira automation lint` 1, `jira automation analyzer` 4, both unrelated). The paid path is taken on the Marketplace: "Automation Map for Jira (Rule Dependencies & Cost Savings)" and "RuleSignal Automation Audit for Jira".

---


---

## Everything I searched (tools, and this project's search record)

**Tools.**
- GitHub search API (repos, issues, code; qualifiers `review:none`, `author:app/…`, `merged:`); GitHub REST and GraphQL.
- npm registry search and `npm view`; HN Algolia; the arXiv API and HTML full text.
- Atlassian Marketplace REST (`/rest/2/addons?text=…&application=…&hosting=cloud`); the Atlassian public tracker (`jira.atlassian.com/rest/api/2/search`, BCLOUD by votes).
- Reddit through the Arctic Shift API (`/api/posts/search?subreddit=…&title=…`). reddit.com JSON returned 403 and api.pullpush.io returned 522.
- General web search; page fetches; the drand HTTP API.
- A local lab: redis-server, toxiproxy-server v2.13.0 (release binary, SHA-256 `21e5d0cb…` matching `checksums.txt`), ioredis 5.11.1. A first attempt at the keep-alive race there (a Node proxy with a keep-alive agent, gaps swept around 5.0 s) found 0 failures in 70. It was flawed, and the corrected run in the third lab supersedes it (see tripcurve).
- A second local lab (11-02 evening):
  - node-postgres 8.23.1 + PostgreSQL 16.15 (a scratch `initdb` with SCRAM auth) and Node 22.23 `http`/`https` with a self-signed certificate, all through toxiproxy;
  - a CPU-oversubscription run (20 and 60 busy-loop processes, and `nice 10`);
  - idle-close timings for gunicorn 26.2.0 (sync, `--threads 2`, `-k gthread --keep-alive 75`, `-k uvicorn_worker.UvicornWorker`, `GUNICORN_CMD_ARGS='--threads 4'`), uvicorn 0.54.0 and Node v22.23.2. Each timing sends one raw HTTP/1.1 keep-alive request and times the server's FIN.
- A third local lab (11-02 night; the same toxiproxy binary, checksum re-verified, on its own API port; its own redis-server and PostgreSQL instances on non-default ports):
  - `race.js`: a raw-socket, LB-like client; 20 ms upstream latency toxic; idle gaps swept in 4 ms steps around each server's measured close (Node defaults and `keepAliveTimeout 65000`; gunicorn + uvicorn worker defaults and `--keep-alive 75`), plus a 1 ms sweep with no added latency;
  - `h2.js`, `h2size.js`: HTTP/2 cleartext and TLS, warm and new sessions, responses of 1 KB–1 MB; `grpc.js`: grpc-js 1.14.7 unary calls, warm and new channels, and the 200 ms deadline boundary;
  - `rpy.py`, `rpy2.py`: redis-py 8.1.0 k, the `socket_timeout` boundary with defaults and with `Retry(NoBackoff(), 0)`, and its default retry policy read from the installed `redis/client.py`;
  - `gohttp/main.go`: Go 1.27.1 `net/http` k and the `Client.Timeout` boundary;
  - `nogo.js`: node-postgres `Pool` and Node `fetch` in down and black-hole modes, with defaults and with timeouts;
  - curl via toxiproxy to `api.sendgrid.com:443` (`--connect-to`), with and without a 300 ms latency toxic.
  - Binding port 443 on the host was refused (`bind: permission denied`), which is why the TLS test overrides the port as well as the address.

**tripcurve.**
- GitHub repos: `graceful shutdown lint` 2, `preStop hook lint` 0, `terminationGracePeriodSeconds` 3, `deregistration delay kubernetes` 0, `zero downtime deployment check kubernetes` 10, `keep-alive timeout load balancer 502` 0, `visibility timeout lambda check` 0, `celery visibility timeout` 4, `timeout coordination` 6, `idle timeout mismatch` 2, `drain timing kubernetes lint` 0, `keepalive timeout lint` 0, `sqs visibility timeout lint` 0, `kubernetes graceful shutdown checker` 0, `timeout retry static analysis` 3, `tripcurve in:name` 2.
- Code search:
  - `repo:zegl/kube-score preStop` 1, `… terminationGracePeriod` 1;
  - `repo:stackrox/kube-linter terminationGracePeriod` 1, `… preStop` 0;
  - `repo:FairwindsOps/polaris preStop` 0;
  - `repo:kyverno/policies terminationGracePeriodSeconds` 18;
  - `repo:open-policy-agent/gatekeeper-library preStop` 17;
  - `repo:bridgecrewio/checkov deregistration_delay` 1, `… idle_timeout` 12;
  - `repo:aws-cloudformation/cfn-lint DeregistrationDelay` 0, `… idle_timeout` 0;
  - `repo:derailed/popeye preStop` 0, `repo:kubescape/regolibrary preStop` 0, `repo:datreeio/datree preStop` 0.
- Issues:
  - `repo:kubernetes-sigs/aws-load-balancer-controller 502 rolling update` 9, and `… deregistration delay preStop` 17 (→ #2366, #1719, #1064, #1834);
  - `repo:kubernetes/ingress-nginx 502 rolling update` 12; `repo:nodejs/node keepAliveTimeout load balancer 502` 5 (→ #27363); `repo:benoitc/gunicorn keepalive load balancer 502` 3;
  - Node PRs #62782 and #59203, issue #59193.
- Source: Node `doc/api/http.md` at HEAD, v26.0.0, v24.11.0 and v22.23.2 (`keepAliveTimeoutBuffer`, "added: v22.19.0", default 1000); uvicorn `uvicorn/config.py`.
- gunicorn source: `config.py` (Keepalive: "``sync`` worker does not support persistent connections"; WorkerClass default `sync`; WorkerThreads: sync with threads > 1 → gthread; `GUNICORN_CMD_ARGS`), `workers/sync.py` (`resp.force_close()`) and `workers/gthread.py`; latest release 26.2.2 (2026-09-06).
- uvicorn workers: Kludex/uvicorn-worker `uvicorn_worker/_workers.py` (`"timeout_keep_alive": self.cfg.keepalive`; 130★, last push 2025-12-01); encode/uvicorn `uvicorn/workers.py` (deprecated in favour of uvicorn-worker; same mapping).
- aws-load-balancer-controller #2366: all 77 comments through the API, with regex counts (preStop/sleep 31, grace 15, deregistration 15, readiness gate 8).
- READMEs: plimsoll (plus its tree and knowledge-base files), resilience-config-lint (plus `references/rules-catalog.md`), Stormcheck, retrystack.
- npm: the five queries in the section; `tripcurve` (404); `@cdktf/hcl2json` (0.21.0).
- Docs: ALB attributes; EKS Best Practices load balancing; Lambda SQS configuration.
- Reddit (archive): r/aws `502`, r/node `502`, r/node `keepAliveTimeout`.
- 11-02 night:
  - IaC linter sweep (code search, 7 s apart to respect the limit): `visibility_timeout`, `visibility_timeout_seconds` and `VisibilityTimeout` in terraform-linters/tflint-ruleset-aws, aquasecurity/trivy-checks, Checkmarx/kics, tenable/terrascan, fugue/regula, terraform-compliance/cli, bridgecrewio/checkov, cdklabs/cdk-nag, aws-cloudformation/aws-guard-rules-registry, stelligent/cfn_nag and aquasecurity/tfsec; `idle_timeout` and `deregistration_delay` in tflint-ruleset-aws, kics and trivy-checks; `idleTimeout` and `deregistration` in cdk-nag. Read: cdk-nag `src/rules/lambda/LambdaEventSourceSQSVisibilityTimeout.ts` and its commit history; tflint-ruleset-aws `rules/models/mappings/sqs.hcl`.
  - nodejs/node PR #62782 labels (`semver-major`); nodejs/Release `schedule.json` (v22, v24, v26, v27).
  - lightship `src/factories/createLightship.ts` and README (`shutdownDelay`); terminus README (`beforeShutdown`); npm `lightship` 9.1.0, `@godaddy/terminus` 4.12.1.


Last checks (11-02, night):
- **tripcurve.**
  - nodejs/node #27363: the body and all 32 comments through the API.
  - Changelogs `CHANGELOG_V6.md`, `V8`, `V10`, `V11`, `V12`, `V13` and `V14`, searched for CVE-2019-5737 and PR #32329 (fix in 12.19.0 and 13.13.0; none in 10.x).
  - `doc/api/http.md` at v10.15.3, v10.24.1, v12.18.4, v13.12.0 and v14.0.0 for the `headersTimeout` default.
  - `hto.js` (one keep-alive request, then time the server's close) on Node 18.19.0, 20.11.0 and 20.12.0 (`npx -p node@<version>`) and 22.23.2. Node 12.18.4 and 12.19.0 would not run: there is no arm64 macOS binary.

REST verifications and issues relevant here are in the section text above.
