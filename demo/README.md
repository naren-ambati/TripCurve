# tripcurve demo

A small made-up shop, four workloads and one queue, that you can check in under five
minutes with no containers, no cluster and no cloud account. tripcurve only reads the
files in this folder; it never runs them and never touches the network.

| Workload | Files | What it is |
|---|---|---|
| `api` | `k8s/api.yaml`, `requirements.txt` | gunicorn with the uvicorn worker, no preStop |
| `admin` | `k8s/admin.yaml` | gunicorn with the default sync worker, preStop `sleep 10`, grace 45 s |
| `web` | `k8s/web.yaml`, `src/server.ts` | image `node:22.23`, runs `node src/server.ts`, preStop `sleep 10`, grace 45 s |
| `orders` | `infra/queue.tf` | queue visibility 60 s, function timeout 30 s, batching window 5 s |

The load balancer is an ALB Ingress (`k8s/ingress.yaml`): target type `ip`, idle timeout
60 s. The Python application code is not part of the demo because tripcurve does not read it.

Build once from the repository root (`npm run build`), then run from this folder. Once
the tool is installed, `tripcurve .` does the same.

## 1. First run

```sh
cd demo
node ../dist/cli/main.js .
```

It reads 14 files, prints 4 failures, 1 unresolved, 1 not evaluated, 1 not applicable and
3 passed, and exits 1. The whole output is in [`expected/first-run.txt`](expected/first-run.txt);
the end-to-end test compares it byte for byte. Every value in it names the file and line it
came from, or the measured default it rests on:

- `api` T1: the uvicorn worker closes an idle connection after 2 s, before the load balancer's 60 s.
- `api` T2: no preStop delay, and target type `ip`.
- `web` T1: Node 22.23 closes after 6 s by default and `src/server.ts` sets nothing.
- `orders` T4: visibility 60 s is less than 6 x 30 s + 5 s = 185 s.
- `admin` T1 is not applicable: the gunicorn sync worker closes after every response, so a
  naive keep-alive rule would be wrong here and tripcurve does not flag it.

## 2. Apply the three fixes

`demo-fixed/` holds the result, and a test keeps it equal to these edits. Make them in a copy:

1. `src/server.ts` line 12: replace the comment with `server.keepAliveTimeout = 65_000;`.
2. `k8s/api.yaml`: add `"--keep-alive", "75"` to the end of the gunicorn command on line 21,
   and add a `lifecycle.preStop` block that runs `sleep 10` as the last key of the container,
   directly after the `ports:` entry and at the same indentation as `ports:` (ten spaces).
   The end of the file then reads as in the block below this list.
3. `infra/queue.tf` line 3: `visibility_timeout_seconds = 190`.

The end of `k8s/api.yaml` after edit 2 (the `ports:` lines are already there; the last four
lines are new):

```yaml
          ports:
            - name: http
              containerPort: 8000
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "10"]
```

The line numbers in the report depend on where the block goes. Placed as above, the `sleep`
line is line 28, the `k8s/api.yaml:28` that `expected/after-fix.txt` cites for `api` T2; placed
straight after `command`, it would be line 25 and the output would differ.

Run it again. The four failures are gone, but the run still exits 1: `api` has a worst-case
T3 warning (grace 30 s is less than 10 s + 30 s + 1 s) and `web` T3 is unresolved, because
tripcurve does not know how long the longest request is.

## 3. Declare the longest request

Add `tripcurve.yaml` (see `demo-fixed/tripcurve.yaml`) with `longest_request_s: 5` for `api`
and for `web`. Run again:

```text
All checks passed (9), 1 not applicable.
Green does not mean zero-downtime: see Assumptions.
```

The exit code is 0. The whole output is in [`expected/after-fix.txt`](expected/after-fix.txt).
The `web` idle close there is 66 s, not 65 s: Node adds 1 s to an explicit
`keepAliveTimeout`. A `keepAliveTimeout` of 65000 was measured closing at 66 s on Node 22.23.2
and 22.23.5 (`docs/research.md` section 14).

Green is not a promise of zero downtime. The SIGTERM race and the load balancer's
deregistration delay are outside these rules, and the report says so under Assumptions.

## Where the numbers come from

- 14 files, the counts of failures and passes, and every line number: `expected/first-run.txt`.
- 9 passes and 1 not applicable, 66 s: `expected/after-fix.txt`.
- Idle-close defaults (6 s for Node 22.23, 2 s for gunicorn with the uvicorn worker):
  `docs/research.md` section 2, and printed in the report with their basis. The 60 s load
  balancer idle timeout is written in `k8s/ingress.yaml` line 9.
- The 185 s is 6 x 30 s + 5 s, rule T4 (`docs/research.md` section 3).
