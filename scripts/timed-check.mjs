// The timed check of the one local command.
//
// It times two runs of the built command: the demo (budget 2 s) and a generated 1,000-file tree
// (budget 30 s), taking the fastest of 3 runs of each (noise only adds time). The budgets are the
// maintainer-confirmed numbers and no others.
//
// The budgets are enforced only on the recorded machine (scripts/timed-check-machine.json: model and
// CPU of the maintainer's laptop, written from sysctl). On any other machine, or where sysctl is missing
// (Linux), it prints `timed check: skipped (not the recorded machine: found "X", recorded "Y")` and exits 0. It never prints
// "within budget" or "passed" for a machine it did not verify.
//
// Usage: node scripts/timed-check.mjs
//   Test hooks (verify never uses them): --machine-file <path>, --cli <path>, --runs <n>, --only demo|tree,
//   --load <n> (the 1-minute load to assume instead of reading it).
//   Any of them marks every result line and the last line `(... overridden: not the real check)`.
//   A recorded machine file that is not {"model": text, "cpu": text} (non-empty) exits 2.
//
// Before timing it waits up to 2 minutes for the 1-minute load to fall to half the CPUs or less (the
// verify steps before it load every CPU). A busy host (the 1-minute load still above half the CPUs at
// the start, between runs or at the end; the same rule as the measurement lanes) can only add time. So a time within budget on a busy host still
// counts, a wrong report always fails, and only an over-budget time measured on a busy host is not a
// measurement: it prints `timed check: skipped (host busy: ...)` and exits 0, never "within budget".
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The maintainer-confirmed budgets in seconds. No other number is used. */
export const DEMO_BUDGET_S = 2;
export const TREE_BUDGET_S = 30;
/** The one comparison for both budgets: the budgets say "under", so a time equal to the budget is over. */
export function overBudget(seconds, budget) {
  return seconds >= budget;
}
/** Busy by the lanes' rule: the 1-minute load is above half the CPUs. */
export function hostBusy(load, cpus) {
  return load > cpus / 2;
}
/** How long to wait for the load to settle before timing (review F1: the verify steps before the
 * timed check load every CPU, and a 1-minute average takes about a minute to fall). */
export const SETTLE_MAX_MS = 120_000;
const SETTLE_STEP_MS = 2_000;
/**
 * Waits until `readLoad()` is not busy or `maxMs` has passed; returns the last load read. Load left
 * over from verify's own test run fades within that time, so on an otherwise quiet machine the
 * timing starts quiet and an over-budget time FAILs; only load that stays (other work) can make it
 * "skipped".
 */
export function settle(readLoad, cpus, maxMs, sleep) {
  let load = readLoad();
  for (let waited = 0; hostBusy(load, cpus) && waited < maxMs; waited += SETTLE_STEP_MS) {
    sleep(SETTLE_STEP_MS);
    load = readLoad();
  }
  return load;
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const RUNS = 3;
const TREE_FILES = 1000;

/** A model or CPU is a non-empty string; anything else in the identity file is a malformed file. */
export function validIdentity(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    typeof value.cpu === 'string' &&
    value.cpu.trim() !== ''
  );
}

/** A value for printing: printable ASCII only, at most 80 characters (sysctl is not untrusted, but bound it anyway). */
export function printable(value) {
  const clean = String(value).replace(/[^\x20-\x7e]/g, '?');
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

const BAD_IDENTITY =
  'timed check: the recorded machine file must be a JSON object with a non-empty "model" and a non-empty "cpu" (text)';

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** `sysctl -n <key>` trimmed, or undefined when sysctl is missing or fails (Linux, a stripped PATH). */
function sysctl(key) {
  try {
    const out = execFileSync('sysctl', ['-n', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

/** The tree for the 1,000-file budget: every kind of file tripcurve reads, three of them near the 5 MB file limit. */
export function generateTree(root, files = TREE_FILES) {
  const BIG = 3;
  const write = (rel, text) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const ports = (n) => 8000 + (n % 50);
  let made = 0;
  // 600 Deployments, alternating a Node server and a gunicorn server, each with a shutdown chain.
  const deployments = Math.round(files * 0.6);
  for (let n = 0; n < deployments; n++) {
    const node = n % 2 === 0;
    const command = node
      ? '["node", "src/server.js"]'
      : '["gunicorn", "app:app", "-k", "uvicorn_worker.UvicornWorker", "-w", "2"]';
    write(
      `svc-${n % 40}/k8s/deploy-${n}.yaml`,
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        `  name: app-${n}`,
        `  namespace: ns-${n % 10}`,
        'spec:',
        '  selector:',
        '    matchLabels:',
        `      app: app-${n}`,
        '  template:',
        '    metadata:',
        '      labels:',
        `        app: app-${n}`,
        '    spec:',
        '      containers:',
        '        - name: app',
        `          image: ${node ? 'node:22.23' : 'example/app:1'}`,
        `          command: ${command}`,
        '          ports:',
        `            - containerPort: ${ports(n)}`,
        '          lifecycle:',
        '            preStop:',
        '              exec:',
        '                command: ["sleep", "10"]',
        '      terminationGracePeriodSeconds: 45',
        '',
      ].join('\n'),
    );
    made++;
  }
  // 200 Services in front of them.
  const services = Math.round(files * 0.2);
  for (let n = 0; n < services; n++) {
    write(
      `svc-${n % 40}/k8s/service-${n}.yaml`,
      [
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        `  name: app-${n}`,
        `  namespace: ns-${n % 10}`,
        'spec:',
        '  selector:',
        `    app: app-${n}`,
        '  ports:',
        '    - port: 80',
        `      targetPort: ${ports(n)}`,
        '',
      ].join('\n'),
    );
    made++;
  }
  // 100 Terraform files, each a queue, a function and an event source mapping.
  const terraform = Math.round(files * 0.1);
  for (let n = 0; n < terraform; n++) {
    write(
      `infra/queue-${n}.tf`,
      [
        `resource "aws_sqs_queue" "q${n}" {`,
        `  name                       = "q${n}"`,
        `  visibility_timeout_seconds = ${60 + (n % 200)}`,
        '}',
        '',
        `resource "aws_lambda_function" "f${n}" {`,
        `  function_name = "f${n}"`,
        '  handler       = "index.handler"',
        '  runtime       = "nodejs22.x"',
        `  timeout       = ${10 + (n % 30)}`,
        '}',
        '',
        `resource "aws_lambda_event_source_mapping" "m${n}" {`,
        `  event_source_arn                   = aws_sqs_queue.q${n}.arn`,
        `  function_name                      = aws_lambda_function.f${n}.arn`,
        '  batch_size                         = 10',
        '  maximum_batching_window_in_seconds = 5',
        '}',
        '',
      ].join('\n'),
    );
    made++;
  }
  // Node source files: the rest, less the Ingress and the large files.
  const sources = files - made - 1 - BIG;
  for (let n = 0; n < sources; n++) {
    write(
      `svc-${n % 40}/src/server-${n}.js`,
      [
        "import http from 'node:http';",
        '',
        'const server = http.createServer((req, res) => {',
        `  res.end('app ${n}');`,
        '});',
        `server.listen(${ports(n)});`,
        '',
      ].join('\n'),
    );
    made++;
  }
  write(
    'k8s/ingress.yaml',
    [
      'apiVersion: networking.k8s.io/v1',
      'kind: Ingress',
      'metadata:',
      '  name: big',
      '  namespace: ns-0',
      '  annotations:',
      '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60',
      'spec:',
      '  ingressClassName: alb',
      '  rules:',
      '    - http:',
      '        paths:',
      '          - path: /',
      '            pathType: Prefix',
      '            backend:',
      '              service:',
      '                name: app-0',
      '                port:',
      '                  number: 80',
      '',
    ].join('\n'),
  );
  made++;
  // Three ConfigMaps of about 4.6 MB (under the 5,000,000-byte file limit): one map of many keys is what a large real file looks like.
  for (let b = 0; b < BIG; b++) {
    const lines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', `  name: big-${b}`, 'data:'];
    for (let k = 0; k < 100000; k++) lines.push(`  key-${b}-${k}: "value number ${k} of config ${b}"`);
    lines.push('');
    write(`config/big-${b}.yaml`, lines.join('\n'));
    made++;
  }
  if (made !== files) throw new Error(`generated ${made} files, wanted ${files}`);
}

/** One timed run of the command: wall seconds, plus what it printed, for checking the run was real. */
function timedRun(cli, cwd) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [cli, '.'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  const seconds = (performance.now() - start) / 1000;
  return { seconds, stdout: r.stdout ?? '', status: r.status, stderr: r.stderr ?? '' };
}

function fastestOf(runs, cli, cwd, accept) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const r = timedRun(cli, cwd);
    const problem = accept(r);
    if (problem !== undefined) return { problem, times };
    times.push(r.seconds);
  }
  return { fastest: Math.min(...times), times };
}

function main() {
  const args = process.argv.slice(2);
  const identityPath = option(args, '--machine-file') ?? join(HERE, 'timed-check-machine.json');
  const cli = option(args, '--cli') ?? join(ROOT, 'dist', 'cli', 'main.js');
  const runs = Number(option(args, '--runs') ?? RUNS);
  const only = option(args, '--only') ?? 'both';
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('timed check: --runs must be a whole number of 1 or more');
    return 2;
  }
  if (!['both', 'demo', 'tree'].includes(only)) {
    console.error('timed check: --only is demo, tree or both');
    return 2;
  }

  let recorded;
  try {
    recorded = JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch {
    console.error(BAD_IDENTITY);
    return 2;
  }
  if (!validIdentity(recorded)) {
    console.error(BAD_IDENTITY);
    return 2;
  }
  const model = sysctl('hw.model');
  const cpu = sysctl('machdep.cpu.brand_string');
  if (model === undefined || cpu === undefined || model !== recorded.model || cpu !== recorded.cpu) {
    const found =
      model === undefined || cpu === undefined
        ? 'no sysctl answer'
        : `${printable(model)}, ${printable(cpu)}`;
    console.log(
      `timed check: skipped (not the recorded machine: found "${found}", recorded "${printable(recorded.model)}, ${printable(recorded.cpu)}")`,
    );
    return 0;
  }
  // Any option that changes what is timed or where the identity comes from makes this not the real check.
  const overridden = [
    ...(option(args, '--machine-file') === undefined ? [] : ['machine-file']),
    ...(option(args, '--cli') === undefined ? [] : ['cli']),
    ...(runs === RUNS ? [] : ['runs']),
    ...(only === 'both' ? [] : ['only']),
    ...(option(args, '--load') === undefined ? [] : ['load']),
  ];
  const marker = overridden.length === 0 ? '' : ` (${overridden.join(', ')} overridden: not the real check)`;
  const cpus = availableParallelism();
  const assumedLoad = option(args, '--load');
  const readLoad = () => (assumedLoad === undefined ? (loadavg()[0] ?? 0) : Number(assumedLoad));
  let maxLoad = 0;
  const sampleLoad = () => {
    const l = readLoad();
    if (l > maxLoad) maxLoad = l;
  };
  // An assumed load (test hook) never changes, so waiting for it would only waste time.
  settle(readLoad, cpus, assumedLoad === undefined ? SETTLE_MAX_MS : 0, sleepSync);
  sampleLoad();

  const date = new Date().toISOString().slice(0, 10);
  const record = { machineModel: model, cpu, node: process.version, date, results: {} };
  const failures = [];
  const overs = [];
  const expectedFirstRun = readFileSync(join(ROOT, 'demo', 'expected', 'first-run.txt'), 'utf8');

  if (only !== 'tree') {
    // The demo run must be the real, expected report: a crash that ends fast must not count as fast.
    const r = fastestOf(runs, cli, join(ROOT, 'demo'), (run) =>
      run.stdout === expectedFirstRun && run.status === 1
        ? undefined
        : `the demo run did not print demo/expected/first-run.txt and exit 1 (exit ${run.status})`,
    );
    if (r.problem !== undefined) failures.push(`demo: ${r.problem}`);
    else {
      record.results.demo = { seconds: r.fastest, runs: r.times, budgetSeconds: DEMO_BUDGET_S };
      if (overBudget(r.fastest, DEMO_BUDGET_S)) {
        overs.push(`demo: ${r.fastest.toFixed(2)} s is not under ${DEMO_BUDGET_S} s`);
      }
    }
  }
  sampleLoad();
  if (only !== 'demo') {
    const root = mkdtempSync(join(tmpdir(), 'tripcurve-timed-'));
    try {
      generateTree(root);
      const r = fastestOf(runs, cli, root, (run) =>
        run.stdout.split('\n')[0]?.endsWith(`${TREE_FILES} files read`) &&
        (run.status === 0 || run.status === 1)
          ? undefined
          : `the run did not read ${TREE_FILES} files (exit ${run.status})`,
      );
      if (r.problem !== undefined) failures.push(`tree: ${r.problem}`);
      else {
        record.results.tree = { seconds: r.fastest, runs: r.times, budgetSeconds: TREE_BUDGET_S };
        if (overBudget(r.fastest, TREE_BUDGET_S)) {
          overs.push(`tree: ${r.fastest.toFixed(2)} s is not under ${TREE_BUDGET_S} s`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  sampleLoad();
  const where = `${model}, ${cpu}, Node ${process.version}, ${date}`;
  for (const [name, res] of Object.entries(record.results)) {
    console.log(
      `timed check: ${name} ${res.seconds.toFixed(2)} s fastest of ${res.runs.length} ` +
        `(runs ${res.runs.map((s) => s.toFixed(2)).join(', ')}; budget under ${res.budgetSeconds} s) on ${where}${marker}`,
    );
  }
  try {
    mkdirSync(join(ROOT, '.cache'), { recursive: true });
    writeFileSync(join(ROOT, '.cache', 'timed-check-result.json'), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // the record file is a convenience; the printed lines above are the record
  }
  if (failures.length > 0) {
    for (const f of [...failures, ...overs]) console.error(`timed check: FAILED, ${f}`);
    return 1;
  }
  if (overs.length > 0) {
    if (hostBusy(maxLoad, cpus)) {
      console.log(
        `timed check: skipped (host busy: load ${maxLoad.toFixed(2)} on ${cpus} CPUs; an over-budget time on a busy host is not a measurement)${marker}`,
      );
      return 0;
    }
    for (const f of overs) console.error(`timed check: FAILED, ${f}`);
    return 1;
  }
  console.log(
    overridden.length === 0
      ? 'timed check: within budget on the recorded machine'
      : `timed check: within budget${marker}`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
