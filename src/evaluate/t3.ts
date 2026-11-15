// Rule T3: the pod's grace period must cover the whole shutdown:
//     grace >= preStop + in-process drain + L + 1 s
// where grace is `terminationGracePeriodSeconds` (the pod spec's value, else the documented default
// of 30 s), and L is the declared `longest_request_s`, else the server's graceful timeout as a
// CEILING.
//
// Outcomes:
//   - T2 failed for the workload: NOT EVALUATED, with the reason;
//   - a term that is not established (no ceiling and no declared L, a drain or a preStop hook of
//     unknown duration, an unlinked Node source, a grace period that is not a number): UNRESOLVED
//     with what to declare, never PASS and never FAIL;
//   - a ceiling and no declaration: PASS when grace covers the bound, else WARN (the worst case:
//     workers are killed only if a request is still running that long after SIGTERM);
//   - L declared: PASS or FAIL, with the arithmetic shown.
// The sum is whole milliseconds, so no float error can move a verdict. A PASS, WARN or FAIL rests on
// the same values: any unresolved, assumed or `to be measured` value makes it UNRESOLVED.
// The rule reads only the resolved model and never a file or the clock.

import {
  type Assumption,
  type ChainStep,
  type Finding,
  isSourcedValue,
  isUnresolved,
  makeFinding,
  makeUnresolved,
  PASS_REFUSAL_HEADLINES,
  passBlocker,
} from '../core/index.js';
import type { ResolvedWorkload } from '../resolve/index.js';
import { DECLARE_DRAIN, DECLARE_LONGEST_REQUEST } from '../resolve/index.js';
import {
  PYTHON_DRAIN_ASSUMPTION,
  preStopOf,
  secondsText,
  unknownStep,
  valueMs,
} from './shutdown-common.js';
import {
  DECLARE_PRESTOP_FORM,
  DECLARE_SOURCE_OR_DRAIN,
  evaluateT2,
  linkProblemFinding,
} from './t2.js';

function unresolved(
  w: ResolvedWorkload,
  headline: string,
  chain: readonly ChainStep[],
  declare: readonly string[],
): Finding {
  return makeFinding({
    rule: 'T3',
    subject: w.workload,
    kind: 'UNRESOLVED',
    headline,
    chain,
    declare,
  });
}

/** The in-process term of the sum: declared, else read, else why it is not known. */
type DrainTerm =
  | {
      readonly ok: true;
      readonly ms: number;
      readonly steps: readonly ChainStep[];
      readonly used: readonly Assumption[];
    }
  | {
      readonly ok: false;
      readonly finding: (w: ResolvedWorkload, head: readonly ChainStep[]) => Finding;
    };

function drainTerm(w: ResolvedWorkload): DrainTerm {
  const declared = w.declaredDrain;
  const d = w.inProcessDrain;
  const declaredMs = declared === undefined ? undefined : valueMs(declared);
  if (declared !== undefined && declaredMs === undefined) {
    return {
      ok: false,
      finding: (x, head) =>
        unresolved(x, 'the declared drain is not a number of seconds', [...head], [DECLARE_DRAIN]),
    };
  }
  // A declaration settles an in-process drain that is unknown or not read; it cannot lower one the
  // code shows: when both are known the larger counts, and the chain shows both.
  if (d.state === 'found' && w.drainSearchComplete) {
    const foundMs = valueMs(d.value);
    if (foundMs !== undefined) {
      const steps: ChainStep[] = [];
      if (declared !== undefined) steps.push({ label: 'drain', value: declared });
      steps.push({ label: 'drain', value: d.value, decidedBy: d.at });
      const readCounts = declaredMs === undefined || foundMs >= declaredMs;
      return {
        ok: true,
        ms: readCounts ? foundMs : (declaredMs ?? 0),
        steps,
        used: readCounts ? d.assumptions : [],
      };
    }
  }
  if (declared !== undefined && declaredMs !== undefined) {
    return { ok: true, ms: declaredMs, steps: [{ label: 'drain', value: declared }], used: [] };
  }
  switch (d.state) {
    case 'found':
    case 'none':
      if (w.drainSearchComplete && d.state === 'none') {
        // A Python server has no in-process reader: its drain is counted as 0 s, and that is an assumption.
        const python = w.server.family === 'gunicorn' || w.server.family === 'uvicorn';
        return { ok: true, ms: 0, steps: [], used: python ? [PYTHON_DRAIN_ASSUMPTION] : [] };
      }
      return {
        ok: false,
        finding: (x, head) =>
          unresolved(
            x,
            'drain not established; grace cannot be checked',
            [
              ...head,
              {
                label: 'drain',
                value: makeUnresolved(x.drainSearchReason ?? 'the drain search is not complete'),
              },
            ],
            [DECLARE_DRAIN],
          ),
      };
    case 'unresolved':
      return {
        ok: false,
        finding: (x, head) =>
          unresolved(
            x,
            'drain duration unknown; grace cannot be checked',
            [
              ...head,
              ...(d.at === undefined ? [] : [unknownStep('drain', d.at)]),
              { label: 'reason', value: { note: d.reason } },
            ],
            d.declare.length > 0 ? d.declare : [DECLARE_DRAIN],
          ),
      };
    case 'not-read':
      return {
        ok: false,
        finding: (x, head) =>
          unresolved(
            x,
            'drain not known: source not linked; link it or declare a drain',
            [...head, { label: 'source', value: makeUnresolved(d.why) }],
            [DECLARE_SOURCE_OR_DRAIN],
          ),
      };
    default:
      return {
        ok: false,
        finding: (x, head) =>
          unresolved(x, 'the drain is not a number of seconds', [...head], [DECLARE_DRAIN]),
      };
  }
}

function evaluate(w: ResolvedWorkload): Finding {
  // 1. T2 failed: there is nothing to add the grace period to
  const t2 = evaluateT2(w);
  if (t2.kind === 'FAIL') {
    return makeFinding({
      rule: 'T3',
      subject: w.workload,
      kind: 'NOT EVALUATED',
      headline: 'T2 failed for this workload',
      chain: [],
    });
  }

  // 2. the grace period
  const grace = w.grace;
  const graceStep: ChainStep = { label: 'grace', value: grace };
  const graceMs = isSourcedValue(grace) ? valueMs(grace, 'down') : undefined;
  if (graceMs === undefined) {
    const reason = isUnresolved(grace)
      ? grace.reason
      : 'the grace period is not a number of seconds';
    return unresolved(
      w,
      `grace period not established: ${reason}`,
      [graceStep],
      ['write terminationGracePeriodSeconds as a whole number of seconds in the pod spec'],
    );
  }
  const head: ChainStep[] = [graceStep];

  // 3. the preStop term: a hook has no readable duration, so the sum cannot be made
  const pre = preStopOf(w);
  if (pre.kind === 'hook') {
    return unresolved(
      w,
      'preStop hook of unknown duration; grace cannot be checked',
      [...head, unknownStep('preStop', pre.source)],
      [DECLARE_PRESTOP_FORM],
    );
  }
  const preMs = pre.kind === 'delay' ? pre.ms : 0;
  if (pre.kind === 'delay') head.push({ label: 'preStop', value: pre.value });

  // 4. the in-process term
  const drain = drainTerm(w);
  if (!drain.ok) return drain.finding(w, head);
  head.push(...drain.steps);

  // 5. L: declared, else the server's ceiling, else nothing to check against
  const longest = w.longestRequest;
  let lMs: number;
  let kind: 'declared' | 'ceiling';
  const tail: ChainStep[] = [];
  let used = [...drain.used];
  if (longest !== undefined) {
    const ms = valueMs(longest);
    if (ms === undefined) {
      return unresolved(w, 'the declared longest request is not a number of seconds', head, [
        DECLARE_LONGEST_REQUEST,
      ]);
    }
    lMs = ms;
    kind = 'declared';
    tail.push({ label: 'longest req', value: longest });
  } else if (w.ceiling.state === 'known') {
    const ms = valueMs(w.ceiling.value);
    if (ms === undefined) {
      return unresolved(w, 'the graceful-timeout ceiling is not a number of seconds', head, [
        DECLARE_LONGEST_REQUEST,
      ]);
    }
    lMs = ms;
    kind = 'ceiling';
    if (w.ceiling.setting !== undefined) tail.push({ label: 'graceful', value: w.ceiling.setting });
    tail.push({ label: 'ceiling', value: w.ceiling.value });
    used = [...used, ...w.ceiling.assumptions];
  } else {
    return unresolved(w, w.ceiling.reason, head, w.ceiling.declare);
  }
  const chain = [...head, ...tail];

  // 6. the sum, in whole milliseconds
  const needMs = preMs + drain.ms + lMs + 1000;
  if (!Number.isSafeInteger(needMs)) {
    return unresolved(w, 'a value is too large to compare', chain, []);
  }
  const g = secondsText(graceMs);
  const sum = `${secondsText(preMs)} s + ${secondsText(drain.ms)} s + ${secondsText(lMs)} s + 1 s`;
  const ok = graceMs >= needMs;
  // Every verdict rests on the same values: refuse one that rests on an unverified value.
  const blocker = passBlocker(chain);
  if (blocker !== undefined) {
    return unresolved(w, PASS_REFUSAL_HEADLINES[blocker], chain, []);
  }
  if (ok) {
    return makeFinding({
      rule: 'T3',
      subject: w.workload,
      kind: 'PASS',
      headline: `grace ${g} s covers ${sum}`,
      chain,
      assumptions: used,
    });
  }
  if (kind === 'declared') {
    return makeFinding({
      rule: 'T3',
      subject: w.workload,
      kind: 'FAIL',
      headline: `grace ${g} s is less than ${sum}`,
      chain,
      assumptions: used,
    });
  }
  const left = graceMs - preMs - drain.ms;
  const killed =
    left > 0
      ? `workers are killed only if a request is still running ${secondsText(left)} s after SIGTERM`
      : 'the grace period ends before the server can stop';
  return makeFinding({
    rule: 'T3',
    subject: w.workload,
    kind: 'WARN',
    headline: `worst case: grace ${g} s is less than preStop ${secondsText(preMs)} s + drain ${secondsText(drain.ms)} s + graceful timeout ${secondsText(lMs)} s + 1 s; ${killed}`,
    chain,
    declare: [
      'declare longest_request_s for this workload in tripcurve.yaml, for a pass or a fail',
    ],
    assumptions: used,
  });
}

export function evaluateT3(w: ResolvedWorkload): Finding {
  return linkProblemFinding(w, 'T3') ?? evaluate(w);
}
