// The logic of the measurement lanes, with no I/O beyond reading
// the knowledge-base JSON and checking that a script file exists. It reads the knowledge-base data
// files directly and imports nothing from src/ (U12 -> reads the schema only), so the range
// grammar and the entry fields are read here on their own.
//
// A "case" is one run of one measurement script against one pinned release, with the value the
// entry states for it and the tolerance the entry states. `compareLine` judges the one JSON
// line a script printed against its case. Anything that is not a clear match is a failure: a
// missing field, a wrong release, a non-number, a script that could not measure.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

// ---- versions and ranges (the range grammar: `*`, `>=X.Y.Z`, `<X.Y.Z`, or both) ----

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = VERSION_RE.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function parseRange(text) {
  if (typeof text !== 'string') return null;
  if (text === '*') return {};
  const parts = text.split(' ');
  const range = {};
  let i = 0;
  const lower = /^>=(.+)$/.exec(parts[i] ?? '');
  if (lower) {
    const v = parseVersion(lower[1]);
    if (!v) return null;
    range.lower = v;
    i++;
  }
  const upper = /^<(.+)$/.exec(parts[i] ?? '');
  if (upper) {
    const v = parseVersion(upper[1]);
    if (!v) return null;
    range.upper = v;
    i++;
  }
  if (i === 0 || i !== parts.length) return null;
  return range;
}

export function inRange(range, versionText) {
  const v = parseVersion(versionText);
  if (!v) return false;
  if (range.lower && compareVersions(v, range.lower) < 0) return false;
  if (range.upper && compareVersions(v, range.upper) >= 0) return false;
  return true;
}

// ---- loading ----

export function loadEntries(kbDir) {
  const entries = [];
  for (const name of readdirSync(kbDir).filter((n) => n.endsWith('.json')).sort()) {
    const file = JSON.parse(readFileSync(join(kbDir, name), 'utf8'));
    if (file === null || typeof file !== 'object' || file.schemaVersion !== 1 || !Array.isArray(file.entries)) {
      throw new Error(`${name}: a knowledge-base file is {schemaVersion: 1, entries: [...]}`);
    }
    entries.push(...file.entries);
  }
  return entries;
}

// ---- the gap check ----

const BASES = ['measured', 'documented', 'from-source', 'from-changelogs', 'to-be-measured'];
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isReason = (ref) =>
  ref !== null && typeof ref === 'object' && !Array.isArray(ref) && isText(ref.notMeasurableLocally);

/** The reason given in place of a script, or undefined when the entry has a script or none. */
function reasonOf(entry) {
  return isReason(entry.scriptRef) ? entry.scriptRef.notMeasurableLocally : undefined;
}

// "Not measurable locally" is for services that cannot run on localhost, and only for a
// documented value. It is never a way out for a runtime the scripts can start.
const SCRIPTED_RUNTIMES = ['node', 'gunicorn', 'uvicorn', 'lightship'];
const REASON_RUNTIMES = ['alb', 'kubernetes', 'terraform', 'cloudformation'];
const REASON_SUBJECTS = [
  'alb-idle-timeout', // ALB/ELB
  'k8s-grace-period', // Kubernetes
  'terraform-lb-idle-timeout', // the Terraform provider schema default of an ALB
  'terraform-sqs-visibility', // SQS
  'terraform-lambda-timeout', // AWS Lambda
  'lambda-sqs-batching-window', // AWS Lambda event source mapping
  'cfn-lb-idle-timeout', // the CloudFormation default of an ALB (bolt B12)
  'cfn-sqs-visibility', // SQS, CloudFormation default (bolt B12)
  'cfn-lambda-timeout', // AWS Lambda, CloudFormation default (bolt B12)
];

/** Why a stated reason is not allowed for this entry, or null when it is. */
function reasonProblem(entry) {
  const runtime = entry.applies?.runtime;
  if (SCRIPTED_RUNTIMES.includes(runtime)) return `runtime ${runtime} has measurement scripts, so it is never "not measurable locally"`;
  if (entry.basis !== 'documented') return 'a stated reason is allowed only for an entry whose basis is documented';
  if (!REASON_RUNTIMES.includes(runtime) || !REASON_SUBJECTS.includes(entry.subject)) {
    return 'is not in the closed list of services that cannot run on localhost (ALB/ELB, Kubernetes, AWS Lambda, SQS, Terraform provider schema defaults)';
  }
  return null;
}

const isDeferredShape = (d) => d !== null && typeof d === 'object' && !Array.isArray(d) && /^B\d+$/.test(d.bolt ?? '') && isText(d.reason);
// A deferral is valid only for the old-Node trap entries (B8 second review B1): runnable software that
// cannot be run on this host, whose basis is changelogs. Never for a subject the scripts can measure.
const DEFERRED_SUBJECT = 'node-headers-timeout-trap';
const DEFERRED_BASIS = 'from-changelogs';
const deferredAllowed = (e) => e.subject === DEFERRED_SUBJECT && e.basis === DEFERRED_BASIS;

/** The entries whose measurement is deferred to a later bolt: runnable software that has not been run yet. */
export function deferredEntries(entries) {
  return entries.filter((e) => isDeferredShape(e.deferredTo) && deferredAllowed(e)).map((e) => ({ entryId: e.id, bolt: e.deferredTo.bolt, reason: e.deferredTo.reason }));
}

export function pinnedVersions(entry) {
  if (Array.isArray(entry.measuredVersions) && entry.measuredVersions.length > 0) return entry.measuredVersions;
  if (entry.measuredOn && isText(entry.measuredOn.version)) return [entry.measuredOn.version];
  return [];
}

function scriptProblem(ref, measureDir) {
  const path = normalize(ref);
  if (!path.startsWith(`measure${sep}`) || path.includes('..') || !path.endsWith('.mjs')) {
    return 'a script must be a measure/*.mjs path';
  }
  if (!existsSync(join(measureDir, path.slice('measure/'.length)))) return `script ${ref} does not exist`;
  return null;
}

/** Every entry without a script (or the stated reason), source URL, range or basis, and every script no case can be planned for. */
export function kbGaps(entries, measureDir) {
  const gaps = [];
  const seen = new Set();
  for (const [position, entry] of entries.entries()) {
    const id = isText(entry?.id) ? entry.id : `#${position}`;
    const gap = (field, message) => gaps.push({ entryId: id, field, message });
    if (seen.has(id)) gap('id', 'is not unique');
    seen.add(id);
    if (entry === null || typeof entry !== 'object') {
      gap('(entry)', 'is not an object');
      continue;
    }
    const ref = entry.scriptRef;
    if (isText(ref)) {
      const problem = scriptProblem(ref, measureDir);
      if (problem) gap('scriptRef', problem);
      if (!(typeof entry.toleranceMs === 'number' && Number.isFinite(entry.toleranceMs) && entry.toleranceMs > 0)) {
        gap('toleranceMs', 'a measurement script needs a stated tolerance in ms');
      }
      if (entry.toleranceRelative !== undefined) {
        for (const k of [entry.measuredSpan?.min, entry.measuredSpan?.max]) {
          if (k === undefined || entry.toleranceMsAt?.[String(k)] === undefined) {
            gap('toleranceMsAt', `no per-value tolerance for K = ${k} s: a value the plan runs needs its own, with no fallback to the relative rule`);
          }
        }
      }
      if (entry.basis === 'measured' && pinnedVersions(entry).length === 0) {
        gap('measuredVersions', 'a measured entry needs the pinned version the lane runs (measuredVersions or measuredOn.version)');
      }
    } else if (isReason(ref)) {
      const problem = reasonProblem(entry);
      if (problem) gap('scriptRef', `a stated reason is not allowed: ${problem}`);
    } else if (entry.deferredTo !== undefined) {
      // handled below, with the other checks of a deferred entry
    } else {
      gap('scriptRef', 'is missing: a script path, or {notMeasurableLocally: reason}, or deferredTo');
    }
    if (entry.deferredTo !== undefined) {
      if (!isDeferredShape(entry.deferredTo)) gap('deferredTo', 'deferredTo is {bolt: "B<n>", reason: text}');
      if (ref !== undefined) gap('deferredTo', 'an entry is either deferred or has a script or a reason, not both');
      if (!deferredAllowed(entry)) gap('deferredTo', `a deferral is valid only for subject ${DEFERRED_SUBJECT} with basis ${DEFERRED_BASIS} (it is unmeasured), never for a subject the scripts measure`);
    }
    let https = false;
    try {
      https = isText(entry.docUrl) && new URL(entry.docUrl).protocol === 'https:';
    } catch {
      https = false;
    }
    if (!https) gap('docUrl', 'a source URL is missing or is not an https URL');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.docDate ?? '')) gap('docDate', 'the date the source was read is missing');
    const range = entry.applies ? entry.applies.versionRange : undefined;
    if (!isText(range)) gap('applies.versionRange', 'a version range is missing');
    else if (parseRange(range) === null) gap('applies.versionRange', 'is not in the version range grammar');
    if (!BASES.includes(entry.basis)) gap('basis', 'is missing or not a known basis');
    if (isText(ref) && parseRange(range) !== null && entry.basis !== undefined) {
      if (!gaps.some((g) => g.entryId === id)) {
        if (planCases(entry).length === 0) {
          gap('scriptRef', 'no measurement case can be planned for this entry (a script nothing runs is a gap)');
        } else {
          for (const message of coverageGaps(entry)) gap('scriptRef', message);
        }
      }
    }
  }
  return gaps;
}

export function releaseBlockerIds(entries) {
  return entries.filter((e) => e.basis === 'to-be-measured').map((e) => e.id);
}

/** The entries that carry an allowed stated reason instead of a script. */
export function statedReasons(entries) {
  return entries.filter((e) => reasonOf(e) !== undefined && reasonProblem(e) === null).map((e) => ({ entryId: e.id, reason: reasonOf(e) }));
}

/** The tolerance the stated rule gives: the largest observed deviation plus the resolution (B1, docs/limits.md). */
export function derivedToleranceMs(deviationsMs, resolutionMs) {
  if (deviationsMs.length === 0) throw new Error('no observations to derive a tolerance from');
  return Math.ceil(Math.max(...deviationsMs) + resolutionMs);
}

// ---- planning: one case per release and setting an entry names ----

const unitMs = (entry) => (entry.unit === 'ms' ? entry.value : entry.value * 1000);
const classesOf = (entry) => {
  const m = /^workerClass in \[(.*)\]$/.exec(entry.applies.condition ?? '');
  return m ? m[1].split(', ') : [];
};
const toleranceAt = (entry, nominalMs) =>
  entry.toleranceRelative === undefined ? entry.toleranceMs : Math.ceil(nominalMs * entry.toleranceRelative + 1);
/** The tolerance for a run at K seconds: the entry's own figure for that K when it has one, else the relative rule. */
const toleranceAtK = (entry, k) => entry.toleranceMsAt?.[String(k)] ?? toleranceAt(entry, k * 1000);

/** The graceful-timeout cases, by (source, worker class): the name of the case in the shutdown scripts. */
const GRACEFUL_BY_SOURCE = {
  command: { sync: 'sync-w2-graceful10', gthread: 'gthread-graceful10', uvicorn: 'uvicorn-worker-graceful10' },
  env: { sync: 'sync-env-graceful10' },
  'config-file': { sync: 'sync-conf-graceful10' },
};
const GRACEFUL_DEFAULT = { sync: 'sync', gthread: 'gthread', uvicorn: 'uvicorn-worker' };
const UVICORN_WORKER_CLASS = 'uvicorn_worker.UvicornWorker';

/**
 * The cases for one entry. With no `versions` they run against the releases the entry names
 * (the pinned lane); with `versions` against those (the latest lane), but only the ones inside the
 * entry's range. `full` adds the largest measured explicit value, which can take minutes. `entries`
 * (the whole knowledge base) lets a case that runs the uvicorn worker also require that the uvicorn
 * in its environment is one a uvicorn entry covers.
 */
export function planCases(entry, { versions, full = false, entries } = {}) {
  if (!isText(entry.scriptRef)) return [];
  const range = parseRange(entry.applies?.versionRange);
  if (range === null) return [];
  const pinned = (versions ?? pinnedVersions(entry)).filter((v) => inRange(range, v));
  const runtime = entry.applies.runtime;
  const script = entry.scriptRef;
  const cases = [];
  const base = (version, extra) => ({ entryId: entry.id, runtime, version, script, ...extra });
  const venvOf = (version) => (runtime === 'gunicorn' ? `g${parseVersion(version)?.major}` : 'g26');
  const uvicornRanges = entries
    ? [...new Set(entries.filter((e) => e.applies?.runtime === 'uvicorn' && e.subject === 'uvicorn-keepalive').map((e) => e.applies.versionRange))]
    : null;
  // A uvicorn worker's timers are uvicorn's code: its release must be one an entry covers.
  const withUvicorn = (check) => (uvicornRanges === null ? check : { ...check, companion: { runtime: 'uvicorn', ranges: uvicornRanges } });
  for (const version of pinned) {
    switch (entry.subject) {
      case 'node-idle-close':
        cases.push(base(version, { label: `node ${version} default`, toolchain: 'node', args: [], check: { type: 'idleClose' }, expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version } }));
        break;
      case 'node-keepalive-explicit':
      case 'node-keepalive-buffer-explicit': {
        const buffer = entry.subject === 'node-keepalive-buffer-explicit';
        const extra = unitMs(entry);
        const plan = (k, form) => {
          const args = [String(k * 1000)];
          if (buffer) args.push(`--buffer=${extra}`);
          if (form === 'options') args.push('--form=options');
          args.push(`--cap-ms=${k * 1000 + 10000}`);
          const observed = { keepAliveTimeout: k * 1000, ...(buffer ? { keepAliveTimeoutBuffer: extra } : {}) };
          cases.push(base(version, {
            label: `node ${version} ${form === 'options' ? 'createServer options' : 'assign'} K=${k}s${buffer ? ` buffer=${extra}ms` : ''}`,
            toolchain: 'node', args, check: { type: 'idleClose', observed },
            expectedMs: k * 1000 + extra, toleranceMs: entry.toleranceMs, covers: { version, k, form },
          }));
        };
        for (const k of entry.measuredKs ?? []) plan(k, 'assign');
        for (const o of entry.measuredOptions ?? []) if (o.versions.includes(version)) plan(o.k, 'options');
        break;
      }
      case 'gunicorn-keepalive': {
        const v = venvOf(version);
        for (const cls of classesOf(entry)) {
          if (cls === 'uvicorn') cases.push(base(version, { label: `gunicorn ${version} uvicorn worker default`, toolchain: 'venv', venv: v, args: ['gunicorn-uvicorn'], check: withUvicorn({ type: 'idleClose', workerClass: UVICORN_WORKER_CLASS }), expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version, cls } }));
          if (cls === 'gthread') cases.push(base(version, { label: `gunicorn ${version} gthread default`, toolchain: 'venv', venv: v, args: ['threads'], check: { type: 'idleClose', workerClass: 'gthread' }, expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version, cls } }));
        }
        break;
      }
      case 'uvicorn-keepalive':
        cases.push(base(version, { label: `uvicorn ${version} default`, toolchain: 'venv', venv: venvOf(version), args: ['uvicorn'], check: { type: 'idleClose' }, expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version } }));
        break;
      case 'gunicorn-sync-keepalive':
        cases.push(base(version, { label: `gunicorn ${version} sync worker`, toolchain: 'venv', venv: venvOf(version), args: ['sync'], check: { type: 'syncCloses', workerClass: 'sync' }, expectedMs: null, toleranceMs: entry.toleranceMs, covers: { version, cls: 'sync' } }));
        break;
      case 'gunicorn-keepalive-explicit':
      case 'uvicorn-keepalive-explicit': {
        const span = entry.measuredSpan;
        const ks = [span.min, ...(full && span.max !== span.min ? [span.max] : [])];
        const modes = entry.subject === 'uvicorn-keepalive-explicit'
          ? [['uvicorn-flag', undefined], ['uvicorn-env', undefined]]
          : classesOf(entry).map((c) => [c === 'uvicorn' ? 'uvicorn-worker-keepalive' : c === 'gthread' ? 'gthread-keepalive' : null, c]);
        for (const [mode, cls] of modes) {
          if (mode === null) continue;
          for (const k of ks) {
            const args = [mode, String(k)];
            if (k > 100) args.push(String(k + 100));
            const check = mode === 'gthread-keepalive' ? { type: 'idleClose', workerClass: 'gthread' }
              : mode === 'uvicorn-worker-keepalive' ? withUvicorn({ type: 'idleClose', workerClass: UVICORN_WORKER_CLASS })
              : { type: 'idleClose' };
            cases.push(base(version, {
              label: `${runtime} ${version} ${mode} ${k}s`, toolchain: 'venv', venv: venvOf(version), args, check,
              expectedMs: k * 1000, toleranceMs: toleranceAtK(entry, k), covers: { version, cls, k },
            }));
          }
        }
        break;
      }
      case 'gunicorn-graceful-timeout': {
        for (const cls of classesOf(entry)) {
          const name = GRACEFUL_DEFAULT[cls];
          if (!name) continue;
          const check = { type: 'closeAt', responseComplete: false };
          cases.push(base(version, { label: `gunicorn ${version} ${cls} graceful ceiling`, toolchain: 'venv', venv: venvOf(version), args: [name, 'long'], check: cls === 'uvicorn' ? withUvicorn(check) : check, expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version, cls } }));
        }
        break;
      }
      case 'gunicorn-graceful-timeout-explicit': {
        for (const source of entry.sources ?? []) {
          for (const cls of classesOf(entry)) {
            const name = GRACEFUL_BY_SOURCE[source]?.[cls];
            if (!name) continue;
            const check = { type: 'closeAt', responseComplete: false };
            cases.push(base(version, { label: `gunicorn ${version} ${cls} graceful ${entry.measuredSpan.min}s from ${source}`, toolchain: 'venv', venv: venvOf(version), args: [name, 'long'], check: cls === 'uvicorn' ? withUvicorn(check) : check, expectedMs: entry.measuredSpan.min * 1000, toleranceMs: entry.toleranceMs, covers: { version, cls, source } }));
          }
        }
        break;
      }
      case 'uvicorn-graceful-timeout-explicit':
        cases.push(base(version, { label: `uvicorn ${version} --timeout-graceful-shutdown ${entry.measuredSpan.min}`, toolchain: 'venv', venv: venvOf(version), args: ['uvicorn-graceful5', 'long'], check: { type: 'closeAt', responseComplete: false }, expectedMs: entry.measuredSpan.min * 1000, toleranceMs: entry.toleranceMs, covers: { version, k: entry.measuredSpan.min } }));
        cases.push(base(version, { label: `uvicorn ${version} default: no ceiling`, toolchain: 'venv', venv: venvOf(version), args: ['uvicorn', 'long'], check: { type: 'noCeiling' }, expectedMs: null, toleranceMs: entry.toleranceMs, covers: { version, k: 0 } }));
        break;
      case 'lightship-shutdown-delay':
        cases.push(base(version, { label: `lightship ${version} k8s shutdown delay`, toolchain: 'lightship', args: ['k8s'], check: { type: 'handlerStart' }, expectedMs: unitMs(entry), toleranceMs: entry.toleranceMs, covers: { version } }));
        break;
      default:
        break;
    }
  }
  return cases;
}

/**
 * What the plan fails to cover of what the entry names (B8): every pinned release inside
 * the range, every worker class of its condition, every source, every explicit value K and every
 * options-form run. A name no case covers is a gap, never a silent drop.
 */
export function coverageGaps(entry) {
  const problems = [];
  const range = parseRange(entry.applies?.versionRange);
  const versions = pinnedVersions(entry);
  for (const v of versions) if (range && !inRange(range, v)) problems.push(`the pinned release ${v} is outside the entry's range`);
  const cases = planCases(entry, { full: true });
  const has = (version, match) => cases.some((c) => c.version === version && Object.entries(match).every(([k, v]) => c.covers?.[k] === v));
  const classed = ['gunicorn-keepalive', 'gunicorn-keepalive-explicit', 'gunicorn-graceful-timeout', 'gunicorn-graceful-timeout-explicit'];
  for (const version of versions.filter((v) => range && inRange(range, v))) {
    if (classed.includes(entry.subject)) {
      for (const cls of classesOf(entry)) {
        if (!cases.some((c) => c.version === version && c.covers?.cls === cls)) problems.push(`no case covers worker class ${cls}`);
        for (const source of entry.subject === 'gunicorn-graceful-timeout-explicit' ? entry.sources ?? [] : []) {
          if (!has(version, { cls, source })) problems.push(`no case covers source ${source} for worker class ${cls}`);
        }
      }
    }
  }
  for (const o of entry.measuredOptions ?? []) for (const v of o.versions) if (!versions.includes(v)) problems.push(`the options-form release ${v} is not one of the pinned releases`);
  return [...new Set(problems)];
}

// ---- comparing one script line with its case ----

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The release a script says it ran, for the runtime the entry is about. */
export function reportedVersion(line, runtime) {
  const text = isObj(line) ? line.version : undefined;
  if (typeof text !== 'string') return undefined;
  const named = new RegExp(`(?:^|[\\s+])${runtime} (\\d+\\.\\d+\\.\\d+)(?=$|[\\s+])`).exec(text);
  if (named) return named[1];
  return VERSION_RE.test(text) ? text : undefined;
}

const ms = (n) => `${Number.isInteger(n) ? n : Number(n.toFixed(1))} ms`;

/** The finest step the script says its result can be known to: sweep step, injected latency and poll interval added. */
function lineResolutionMs(line) {
  const r = line.resolution;
  if (!isObj(r)) return undefined;
  let sum = 0;
  let seen = false;
  for (const key of ['sweepStepMs', 'injectedLatencyMs', 'pollMs']) {
    if (r[key] === undefined) continue;
    if (!isNum(r[key]) || r[key] < 0) return undefined;
    sum += r[key];
    seen = true;
  }
  return seen ? sum : undefined;
}

export function compareLine(c, line) {
  const out = (ok, measured, entry, reason, margin = 'n/a') => ({
    ok, entryId: c.entryId, label: c.label, measured, entry,
    tolerance: c.toleranceMs === undefined ? 'n/a' : `${c.toleranceMs} ms`, margin, reason: ok ? null : reason,
  });
  const entryText = c.expectedMs === null ? 'n/a' : ms(c.expectedMs);
  const fail = (reason, measured = 'none') => out(false, measured, entryText, reason);
  if (!isObj(line)) return fail('the script printed no result line');
  const ran = reportedVersion(line, c.runtime);
  if (ran === undefined) return fail('the result line does not say which release ran');
  if (ran !== c.version) return fail(`the script ran ${c.runtime} ${ran}, not the pinned ${c.version}`);
  const m = isObj(line.measured) ? line.measured : {};
  const observed = isObj(line.observed) ? line.observed : {};
  const check = c.check;
  const resolution = lineResolutionMs(line);
  if (resolution === undefined) return fail('the result line states no resolution (sweepStepMs, injectedLatencyMs or pollMs)');
  if (resolution > c.toleranceMs) return fail(`the script's resolution of ${resolution} ms is coarser than the tolerance of ${c.toleranceMs} ms`);
  if (check.companion) {
    const text = typeof line.version === 'string' ? line.version : '';
    const found = new RegExp(`(?:^|[\\s+])${check.companion.runtime} (\\d+\\.\\d+\\.\\d+)(?=$|[\\s+])`).exec(text)?.[1];
    if (found === undefined) return fail(`the result line does not say which ${check.companion.runtime} release the worker ran on`);
    if (!check.companion.ranges.some((r) => { const range = parseRange(r); return range !== null && inRange(range, found); })) {
      return fail(`${check.companion.runtime} ${found} is not covered by any ${check.companion.runtime} entry, and the worker's timers are its code`);
    }
  }
  if (check.workerClass !== undefined && observed.workerClass !== check.workerClass) {
    return fail(`gunicorn reported worker class ${JSON.stringify(observed.workerClass ?? null)}, not ${check.workerClass}`);
  }
  if (check.observed) {
    for (const [key, want] of Object.entries(check.observed)) {
      if (observed[key] !== want) return fail(`the server read back ${key} ${JSON.stringify(observed[key] ?? null)}, not ${want}`);
    }
  }
  const within = (value, label) => {
    if (!isNum(value)) return fail(`the result line has no number for ${label}`);
    const diff = value - c.expectedMs;
    if (Math.abs(diff) > c.toleranceMs) {
      return out(false, ms(value), entryText, `differs by ${diff > 0 ? '+' : '-'}${ms(Math.abs(diff))}, more than the tolerance`, ms(c.toleranceMs - Math.abs(diff)));
    }
    return out(true, ms(value), entryText, null, ms(c.toleranceMs - Math.abs(diff)));
  };
  switch (check.type) {
    case 'idleClose':
      return within(m.idleCloseMs, 'idleCloseMs');
    case 'handlerStart':
      return within(m.sigtermToHandlerStartMs, 'sigtermToHandlerStartMs');
    case 'closeAt': {
      if (m.connectionClose !== 'fin') return fail(`the connection did not end with a FIN (${JSON.stringify(m.connectionClose ?? null)})`);
      if (m.responseComplete !== check.responseComplete) return fail('the in-flight response was not cut at the ceiling as the entry says');
      return within(m.sigtermToConnectionClosedMs, 'sigtermToConnectionClosedMs');
    }
    case 'noCeiling':
      if (m.responseComplete !== true) return fail('the long request did not finish in full, so a ceiling applied');
      return out(true, 'request finished in full', 'no ceiling', null);
    case 'syncCloses': {
      if (m.closesAfterResponse !== true || m.connectionCloseHeader !== true || !isNum(m.closeMs)) {
        return fail('the sync worker did not close the connection after the response with Connection: close');
      }
      if (m.closeMs > c.toleranceMs) return out(false, `closed ${ms(m.closeMs)} after the response`, entryText, `closed later than the ${c.toleranceMs} ms tolerance`, ms(c.toleranceMs - m.closeMs));
      return out(true, `closes after the response (${ms(m.closeMs)})`, 'n/a (closes after every response)', null, ms(c.toleranceMs - m.closeMs));
    }
    default:
      return fail('the case has an unknown check');
  }
}

export function formatVerdict(v) {
  const head = v.ok ? 'PASS' : 'FAIL';
  const text = `${head}  ${v.entryId}  [${v.label}]  measured ${v.measured}  entry ${v.entry}  tolerance ${v.tolerance}  margin ${v.margin}`;
  return v.ok ? text : `${text}  <- ${v.reason}`;
}

// ---- running a plan with a bound on parallel runs ----

/** Runs every case once with `runOne(case)` (resolving to the script's line); returns one verdict per case, in plan order. */
export async function runCases(cases, runOne, jobs = 1, onVerdict = () => {}) {
  const verdicts = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      let v;
      try {
        v = compareLine(c, await runOne(c));
      } catch (e) {
        v = {
          ok: false, entryId: c.entryId, label: c.label, measured: 'none',
          entry: c.expectedMs === null ? 'n/a' : ms(c.expectedMs), tolerance: `${c.toleranceMs} ms`, margin: 'n/a',
          reason: String(e?.message ?? e).split('\n')[0].slice(0, 200),
        };
      }
      verdicts[i] = v;
      onVerdict(v);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, cases.length)) }, worker));
  return verdicts;
}

// ---- judging a whole lane ----

export function judgeLane({ entries, verdicts, drift = [], partial = false, busy = false }) {
  const lines = verdicts.map(formatVerdict);
  let ok = entries.length > 0 && verdicts.length > 0;
  const ids = new Set(entries.map((e) => e.id));
  const reasons = statedReasons(entries);
  const reasonIds = new Set(reasons.map((r) => r.entryId));
  const deferred = deferredEntries(entries);
  const deferredIds = new Set(deferred.map((d) => d.entryId));
  const blockers = releaseBlockerIds(entries);
  const planned = entries.filter((e) => !reasonIds.has(e.id) && !deferredIds.has(e.id) && !blockers.includes(e.id));
  let passing = 0;
  for (const e of planned) {
    const mine = verdicts.filter((v) => v.entryId === e.id);
    if (mine.length === 0) {
      ok = false;
      lines.push(`FAIL  ${e.id}  no case ran for this entry`);
    } else if (mine.some((v) => !v.ok)) ok = false;
    else passing++;
  }
  if (verdicts.some((v) => !ids.has(v.entryId))) ok = false;
  const failed = verdicts.filter((v) => !v.ok).length;
  for (const id of blockers) {
    ok = false;
    lines.push(`FAIL  release blocker: ${id} has basis "to be measured", so nothing was compared`);
  }
  for (const r of reasons) lines.push(`NOT RUN  ${r.entryId}  not measurable locally: ${r.reason}`);
  for (const d of deferred) lines.push(`DEFERRED (${d.bolt})  ${d.entryId}  not measured: ${d.reason}`);
  for (const d of drift) {
    ok = false;
    lines.push(`FAIL  drift  ${d}`);
  }
  lines.push(
    `${ok ? 'LANE PASS' : 'LANE FAIL'}${partial ? ' (partial: --only)' : ''}${ok && busy ? ' (host was busy: not an official run)' : ''}: ${verdicts.length - failed} of ${verdicts.length} cases within tolerance, ${planned.length} entries planned, ${passing} entries passing, ${reasons.length} carry a stated reason, ${deferred.length} deferred and not measured, ${blockers.length} release blockers, ${drift.length} drift ${drift.length === 1 ? 'finding' : 'findings'}`,
  );
  return { ok, lines };
}

// ---- the latest lane: which releases to run, and which are outside every range ----

/** The plain X.Y.Z releases, newest first. Pre-release and any other text is dropped. */
function plainReleases(list) {
  return list.map((t) => ({ t, v: parseVersion(t) })).filter((x) => x.v !== null).sort((a, b) => compareVersions(b.v, a.v)).map((x) => x.t);
}

/** For each runtime: the newest plain release inside each distinct range of its entries. */
export function latestTargets(entries, releasesByRuntime) {
  const out = {};
  for (const [runtime, list] of Object.entries(releasesByRuntime)) {
    const releases = plainReleases(list);
    const ranges = [...new Set(entries.filter((e) => e.applies.runtime === runtime && isText(e.scriptRef)).map((e) => e.applies.versionRange))]
      .map((r) => parseRange(r)).filter((r) => r !== null);
    const picked = [];
    for (const range of ranges) {
      const newest = releases.find((v) => inRange(range, v));
      if (newest && !picked.includes(newest)) picked.push(newest);
    }
    out[runtime] = picked.sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));
  }
  return out;
}

/** The releases (given per runtime) that no range of any entry of that runtime covers. */
export function newerOutsideRanges(entries, newestByRuntime) {
  const drift = [];
  for (const [runtime, list] of Object.entries(newestByRuntime)) {
    // only entries a script measures cover a release: the ranges of deferred and reasoned entries do not
    const ranges = entries.filter((e) => e.applies.runtime === runtime && typeof e.scriptRef === 'string').map((e) => parseRange(e.applies.versionRange)).filter((r) => r !== null);
    for (const v of plainReleases(list)) {
      if (!ranges.some((r) => inRange(r, v))) drift.push(`${runtime} ${v} is outside every knowledge-base range for ${runtime}`);
    }
  }
  return drift;
}

/** The versions in a release list that are not a plain X.Y.Z (they are never compared). */
export function unrecognisedVersions(list) {
  return list.filter((v) => parseVersion(v) === null);
}
