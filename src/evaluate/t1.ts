// Rule T1: the app's idle close must be STRICTLY longer than the
// load balancer's idle timeout. Equal is FAIL.
//
// Honesty: a verdict rests only on established values.
//   - an assumed, unresolved or `to be measured` input never gives PASS, and never
//     gives FAIL either: the result is UNRESOLVED with what to declare;
//   - PASS is built only through makeFinding, whose factory converts a PASS that
//     rests on an unverified value into UNRESOLVED (so a mistake here cannot print PASS);
//   - candidates are combined here: one candidate, its verdict stands; more
//     than one remaining range is VERSION-DEPENDENT with one branch per range, even when
//     all agree. A range with no number (no entry covers it, or the rule could not be
//     applied) is a branch that reads UNRESOLVED, and a `to be measured` range is a branch
//     that reads `unresolved: to be measured`: neither can support PASS, so a result with such a
//     branch is never PASS and never clean. A single candidate whose entry is `to be measured`
//     is UNRESOLVED.
//   - the gunicorn sync worker is N/A: the `workerModel` field, which the resolver
//     fills from the settings it read (bolt B2); it is never set for a server that is not gunicorn.
// Rules read only the resolved model and never a file or the clock.

import {
  BRANCH_UNRESOLVED_TO_BE_MEASURED,
  type Branch,
  type ChainStep,
  type Finding,
  isSourcedValue,
  isUnresolved,
  makeFinding,
  makeSourcedValue,
  makeUnresolved,
  PASS_REFUSAL_HEADLINES,
  passBlocker,
  type SourcedValue,
} from '../core/index.js';
import type { Candidate, ResolvedWorkload } from '../resolve/index.js';
import {
  DECLARE_NO_GUNICORN_VERSION,
  DECLARE_NO_UVICORN_VERSION,
  DECLARE_NODE_VERSION,
  isUnknownInterval,
} from '../resolve/index.js';

export const DECLARE_DUPLICATE = 'keep one object for each kind, namespace and name';

/** Seconds as printed: whole numbers bare, otherwise up to three decimals without trailing zeros. */
export function formatSeconds(seconds: number): string {
  if (Number.isInteger(seconds)) return String(seconds);
  return seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function inSeconds(v: SourcedValue): number | undefined {
  if (typeof v.value !== 'number') return undefined;
  if (v.unit === 's') return v.value;
  if (v.unit === 'ms') return v.value / 1000;
  return undefined;
}

/** What the runtime is called in a version-dependent headline, and what to declare for its version. */
function versionWords(w: ResolvedWorkload): { noun: string; declare: string } {
  switch (w.server.family) {
    case 'gunicorn':
      return { noun: 'gunicorn', declare: DECLARE_NO_GUNICORN_VERSION };
    case 'uvicorn':
      return { noun: 'uvicorn', declare: DECLARE_NO_UVICORN_VERSION };
    default:
      return { noun: 'Node', declare: DECLARE_NODE_VERSION };
  }
}

/** The headline of a VERSION-DEPENDENT result: Node says what is known about the version. */
function versionDependentHeadline(w: ResolvedWorkload, ranges: number): string {
  if (w.server.family === 'node') {
    return w.nodeVersion !== undefined && isUnknownInterval(w.nodeVersion.interval)
      ? 'Node version unknown'
      : 'Node version spans several knowledge-base ranges';
  }
  return `idle close depends on the ${versionWords(w).noun} version: ${ranges} ranges apply`;
}

function problemSteps(w: ResolvedWorkload): ChainStep[] {
  return w.idleClose.problems.map((p) => ({ label: p.label, value: p.value }));
}

function chainOf(w: ResolvedWorkload, first?: ChainStep): ChainStep[] {
  return [
    ...(first === undefined ? [] : [first]),
    ...w.idleClose.evidence,
    ...problemSteps(w),
    ...w.behindLb.lbIdleSteps,
  ];
}

function unresolved(
  w: ResolvedWorkload,
  headline: string,
  chain: readonly ChainStep[],
  declare: readonly string[],
): Finding {
  return makeFinding({
    rule: 'T1',
    subject: w.workload,
    kind: 'UNRESOLVED',
    headline,
    chain,
    declare,
  });
}

function compare(candidate: Candidate, lbSeconds: number): 'PASS' | 'FAIL' | undefined {
  if (isUnresolved(candidate.value)) return undefined;
  const idle = inSeconds(candidate.value);
  if (idle === undefined) return undefined;
  return idle > lbSeconds ? 'PASS' : 'FAIL';
}

export function evaluateT1(w: ResolvedWorkload): Finding {
  // 1. a link that is ambiguous (duplicates) can attribute settings to the wrong object
  if (w.linkState === 'unresolved-more-than-one-match') {
    return unresolved(
      w,
      'more than one match: this workload cannot be linked to one object',
      [{ label: 'link', value: makeUnresolved(w.linkProblem ?? 'more than one match') }],
      [DECLARE_DUPLICATE],
    );
  }

  // 2. the seam for B2: the gunicorn sync worker closes after every response
  const model = w.server.workerModel;
  if (model !== undefined && model.model === 'sync') {
    return makeFinding({
      rule: 'T1',
      subject: w.workload,
      kind: 'N/A',
      headline: 'gunicorn sync worker closes after every response',
      // The default worker has no flag to point at: the source is the command.
      ...(model.fromDefault === true ? { decidingNote: 'no -k given' } : {}),
      chain: [
        {
          label: 'worker',
          value: makeSourcedValue({
            value: 'sync',
            unit: 'none',
            source: model.source,
            basis: 'declared',
          }),
        },
      ],
    });
  }

  // 3. the load balancer
  const lb = w.behindLb;
  if (!isSourcedValue(lb.lbIdle) || lb.kind !== 'alb') {
    const reason = isSourcedValue(lb.lbIdle)
      ? 'the load balancer is not one ALB'
      : lb.lbIdle.reason;
    const headline = lb.kind === 'nlb' ? reason : `LB idle not established: ${reason}`;
    return unresolved(w, headline, chainOf(w), [...lb.declare, ...w.idleClose.declare]);
  }
  const lbIdle = lb.lbIdle;
  const lbSeconds = inSeconds(lbIdle);
  if (lbSeconds === undefined) {
    return unresolved(
      w,
      'LB idle not established: it is not a number of seconds',
      chainOf(w),
      lb.declare,
    );
  }

  // 4. the idle close
  const idle = w.idleClose;
  const candidates = w.idleCloseCandidates;
  if (candidates.length === 0) {
    const first = idle.problems[0];
    const reason = first === undefined ? 'no idle close candidate' : first.value.reason;
    return unresolved(w, `idle close not established: ${reason}`, chainOf(w), idle.declare);
  }

  // 5. the load balancer idle is assumed, not read: say what it would mean, never PASS or FAIL
  const assumed =
    lbIdle.basis === 'assumed' || lbIdle.confidence === 'assumed' || lb.assumedFrom !== undefined;
  const [only] = candidates;
  if (assumed) {
    let headline =
      lb.assumedFrom === 'terraform-name'
        ? `LB idle ${formatSeconds(lbSeconds)} s is linked to a Terraform load balancer by name only (assumed)`
        : `LB idle is not set in the files; assumed ${formatSeconds(lbSeconds)} s`;
    if (candidates.length === 1 && only !== undefined && !isUnresolved(only.value)) {
      const idleSeconds = inSeconds(only.value);
      if (idleSeconds !== undefined && only.supportsPass) {
        headline += `, so idle close ${formatSeconds(idleSeconds)} s ${
          idleSeconds > lbSeconds ? 'is longer (T1 would pass)' : 'is not longer (T1 would FAIL)'
        }`;
      }
    }
    return unresolved(
      w,
      headline,
      chainOf(
        w,
        only === undefined || candidates.length > 1 || isUnresolved(only.value)
          ? undefined
          : { label: 'idle close', value: only.value },
      ),
      lb.declare,
    );
  }

  // 6. several ranges remain: VERSION-DEPENDENT, one branch per range
  if (candidates.length > 1) {
    const branches: Branch[] = candidates.map((c) => ({
      range: c.condition,
      outcome: isUnresolved(c.value)
        ? 'UNRESOLVED'
        : c.supportsPass
          ? (compare(c, lbSeconds) ?? 'UNRESOLVED')
          : BRANCH_UNRESOLVED_TO_BE_MEASURED,
      chain: [{ label: 'idle close', value: c.value }],
    }));
    return makeFinding({
      rule: 'T1',
      subject: w.workload,
      kind: 'VERSION-DEPENDENT',
      headline: versionDependentHeadline(w, candidates.length),
      chain: chainOf(w),
      branches,
      ...(w.server.family === 'node' ? { rangeNoun: 'Node' } : {}),
      declare: [versionWords(w).declare],
    });
  }

  // 7. one candidate: its verdict stands
  if (only === undefined)
    return unresolved(w, 'idle close not established', chainOf(w), idle.declare);
  if (isUnresolved(only.value)) {
    return unresolved(
      w,
      `idle close not established: ${only.value.reason}`,
      chainOf(w),
      idle.declare,
    );
  }
  const step: ChainStep = {
    label: 'idle close',
    value: only.value,
    ...(only.decidedBy === undefined ? {} : { decidedBy: only.decidedBy }),
  };
  const chain = chainOf(w, step);
  const idleSeconds = inSeconds(only.value);
  if (idleSeconds === undefined) {
    return unresolved(
      w,
      'idle close not established: it is not a number of seconds',
      chain,
      idle.declare,
    );
  }
  if (!only.supportsPass) {
    return unresolved(w, PASS_REFUSAL_HEADLINES['to-be-measured-default'], chain, [
      versionWords(w).declare,
    ]);
  }
  if (idleSeconds > lbSeconds) {
    return makeFinding({
      rule: 'T1',
      subject: w.workload,
      kind: 'PASS',
      headline: `idle close ${formatSeconds(idleSeconds)} s is longer than LB idle ${formatSeconds(lbSeconds)} s`,
      chain,
      ...(only.note === undefined ? {} : { decidingNote: only.note }),
    });
  }
  // A FAIL rests on the same values a PASS would: refuse it when any is unverified.
  const blocker = passBlocker(chain);
  if (blocker !== undefined) {
    return unresolved(w, PASS_REFUSAL_HEADLINES[blocker], chain, [versionWords(w).declare]);
  }
  return makeFinding({
    rule: 'T1',
    subject: w.workload,
    kind: 'FAIL',
    headline: `idle close ${formatSeconds(idleSeconds)} s is not longer than LB idle ${formatSeconds(lbSeconds)} s`,
    chain,
  });
}
