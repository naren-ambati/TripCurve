// Rule T2: a workload behind a load balancer must have a drain, a delay
// between SIGTERM and the server stopping, so endpoint removal can propagate. Any of these counts:
// a preStop delay (the forms), an in-process drain the source shows (lightship, terminus
// `beforeShutdown`, a literal delay in a SIGTERM handler), or a declared `drain.in_process_s`.
//
// Honesty:
//   - PASS only when a drain is established from a file, a declaration or a measured default: a drain
//     of unknown duration (a hook, a terminus `beforeShutdown` whose delay is not a literal, a
//     lightship release that is not known) is UNRESOLVED with what to declare, never PASS, even when
//     another drain exists (maintainer decision 2026-11-10). A declared drain settles an in-process
//     drain whose duration is unknown, as the recovery table says; it does not settle a preStop hook,
//     whose duration has no declaration key;
//   - FAIL only when the drain search was complete: the Node source linked and read in full, or a
//     server that is gunicorn or uvicorn, for which no in-process reader exists (the detail line
//     says so). A Node workload whose source is not linked and that has no preStop delay is
//     UNRESOLVED, not FAIL;
//   - a delay of 0 s is not a drain.
// The rule reads only the resolved model and never a file or the clock.

import {
  type ChainStep,
  type Finding,
  isSourcedValue,
  makeFinding,
  makeUnresolved,
} from '../core/index.js';
import type { InProcessDrain, ResolvedWorkload } from '../resolve/index.js';
import {
  DECLARE_DRAIN,
  REASON_SEVERAL_DRAINS,
  REASON_SOURCE_NOT_LINKED,
} from '../resolve/index.js';
import {
  PROPAGATION_ASSUMPTION,
  preStopNoneStep,
  preStopOf,
  secondsText,
  unknownStep,
  valueMs,
} from './shutdown-common.js';

export const DECLARE_SOURCE_OR_DRAIN =
  'set source for this workload in tripcurve.yaml, or declare drain.in_process_s for it';
export const DECLARE_PRESTOP_FORM =
  'write the preStop as an exec sleep (["sleep", "N"] or ["/bin/sh", "-c", "sleep N"]) or the sleep handler, so its delay can be read';

/** Where an unknown duration is (`drain of unknown duration in <words>`). */
const KIND_WORDS = {
  lightship: 'lightship',
  terminus: 'terminus beforeShutdown',
  'sigterm-handler': 'a SIGTERM handler',
} as const;

/** The parenthesised source of a PASS headline (`in-process drain 5 s (<words>)`). */
const PASS_WORDS = {
  lightship: 'lightship',
  terminus: 'terminus beforeShutdown',
  'sigterm-handler': 'SIGTERM handler',
} as const;

/** The two link problems both rules stop at before they look at any shutdown value. */
export function linkProblemFinding(w: ResolvedWorkload, rule: 'T2' | 'T3'): Finding | undefined {
  if (w.linkState === 'unresolved-more-than-one-match') {
    return makeFinding({
      rule,
      subject: w.workload,
      kind: 'UNRESOLVED',
      headline: 'more than one match: this workload cannot be linked to one object',
      chain: [{ label: 'link', value: makeUnresolved(w.linkProblem ?? 'more than one match') }],
      declare: ['keep one object for each kind, namespace and name'],
    });
  }
  if (w.linkState === 'unresolved-container-not-determined') {
    return makeFinding({
      rule,
      subject: w.workload,
      kind: 'UNRESOLVED',
      headline: 'link unresolved: container not determined',
      chain: [
        {
          label: 'container',
          value: makeUnresolved(w.linkProblem ?? 'the container is not determined'),
        },
      ],
      declare: ['give exactly one container a containerPort that the Service targetPort names'],
    });
  }
  return undefined;
}

function unresolved(
  w: ResolvedWorkload,
  headline: string,
  chain: readonly ChainStep[],
  declare: readonly string[],
): Finding {
  return makeFinding({
    rule: 'T2',
    subject: w.workload,
    kind: 'UNRESOLVED',
    headline,
    chain,
    declare,
  });
}

function drainUnknown(
  w: ResolvedWorkload,
  d: Extract<InProcessDrain, { state: 'unresolved' }>,
): Finding {
  const where = d.kind === undefined ? 'in-process drains' : KIND_WORDS[d.kind];
  const chain: ChainStep[] = [];
  if (d.at !== undefined) chain.push(unknownStep('drain', d.at));
  chain.push({ label: 'reason', value: { note: d.reason } });
  return unresolved(
    w,
    d.reason === REASON_SEVERAL_DRAINS
      ? REASON_SEVERAL_DRAINS
      : `drain of unknown duration in ${where}`,
    chain,
    d.declare.length > 0 ? d.declare : [DECLARE_DRAIN],
  );
}

export function evaluateT2(w: ResolvedWorkload): Finding {
  const stop = linkProblemFinding(w, 'T2');
  if (stop !== undefined) return stop;

  const pre = preStopOf(w);
  const declared = w.declaredDrain;
  const inproc = w.inProcessDrain;

  // 1. a drain of unknown duration is never PASS, whatever else exists; a declared drain
  //    settles an in-process one that cannot be read, but not a preStop hook
  if (pre.kind === 'hook') {
    return unresolved(
      w,
      'preStop hook of unknown duration',
      [
        unknownStep('preStop', pre.source),
        { label: 'reason', value: { note: 'the preStop hook has no delay tripcurve can read' } },
      ],
      [DECLARE_PRESTOP_FORM],
    );
  }
  if (declared === undefined && inproc.state === 'unresolved') return drainUnknown(w, inproc);

  // 2. the drains that are established. A declared drain cannot lower a drain the code shows: when
  //    both exist the larger one decides, and the chain shows both.
  const preMs = pre.kind === 'delay' ? pre.ms : 0;
  const declaredMs = declared === undefined ? undefined : valueMs(declared);
  // A drain the source shows is established only when the search was complete (or the user declares the
  // drain): with unread code left, a handler there could stop the server sooner.
  const found = inproc.state === 'found' && w.drainSearchComplete ? inproc : undefined;
  const foundMs = found === undefined ? undefined : valueMs(found.value);
  const steps: ChainStep[] = [];
  if (pre.kind === 'delay') steps.push({ label: 'preStop', value: pre.value });
  if (declared !== undefined) steps.push({ label: 'drain', value: declared });
  if (found !== undefined) steps.push({ label: 'drain', value: found.value, decidedBy: found.at });

  if (preMs > 0) {
    return makeFinding({
      rule: 'T2',
      subject: w.workload,
      kind: 'PASS',
      headline: `preStop sleep ${secondsText(preMs)} s`,
      chain: steps,
      assumptions: [PROPAGATION_ASSUMPTION],
    });
  }
  if (
    found !== undefined &&
    foundMs !== undefined &&
    foundMs > 0 &&
    (declaredMs === undefined || foundMs > declaredMs)
  ) {
    return makeFinding({
      rule: 'T2',
      subject: w.workload,
      kind: 'PASS',
      headline: `in-process drain ${secondsText(foundMs)} s (${PASS_WORDS[found.kind]})`,
      chain: [
        ...steps.filter((x) => x.decidedBy !== undefined),
        ...steps.filter((x) => x.decidedBy === undefined),
      ],
      decidingNote: found.note,
      assumptions: [PROPAGATION_ASSUMPTION, ...found.assumptions],
    });
  }
  if (declared !== undefined && declaredMs !== undefined && declaredMs > 0) {
    return makeFinding({
      rule: 'T2',
      subject: w.workload,
      kind: 'PASS',
      headline: `declared drain ${secondsText(declaredMs)} s`,
      chain: steps,
      assumptions: [PROPAGATION_ASSUMPTION],
    });
  }

  // 3. no drain with a delay: FAIL only when the search for one was complete
  if (declared === undefined && inproc.state === 'not-read') {
    return unresolved(
      w,
      REASON_SOURCE_NOT_LINKED,
      [preStopNoneStep(w), { label: 'source', value: makeUnresolved(inproc.why) }],
      [DECLARE_SOURCE_OR_DRAIN],
    );
  }
  if (declared === undefined && !w.drainSearchComplete) {
    return unresolved(
      w,
      'the search for a drain is not complete',
      [
        preStopNoneStep(w),
        {
          label: 'drain',
          value: makeUnresolved(w.drainSearchReason ?? 'the drain search is not complete'),
        },
      ],
      [DECLARE_DRAIN],
    );
  }
  const chain: ChainStep[] = [];
  const target = w.behindLb.targetType;
  if (target !== undefined && isSourcedValue(target))
    chain.push({ label: 'target-type', value: target });
  chain.push(pre.kind === 'delay' ? { label: 'preStop', value: pre.value } : preStopNoneStep(w));
  if (declared !== undefined) {
    chain.push({ label: 'drain', value: declared });
  } else if (inproc.state === 'found') {
    // a drain was read but it is no delay: say so, at its place (B4 review, minor 1)
    chain.push({
      label: 'drain',
      value: inproc.value,
      detail: 'a drain of 0 s was found at',
    });
  } else if (
    inproc.state === 'none' &&
    inproc.filesRead !== undefined &&
    inproc.filesRead.length > 0
  ) {
    const [first, ...more] = inproc.filesRead;
    if (first !== undefined) {
      chain.push({
        label: 'drain none',
        value: first,
        ...(more.length > 0 ? { more } : {}),
        detail: `no lightship, terminus or SIGTERM drain found in ${inproc.filesRead.length} ${inproc.filesRead.length === 1 ? 'file' : 'files'} read`,
      });
    }
  } else {
    chain.push({
      label: 'drain none',
      value: { note: 'in-process drains are read for Node source only; none declared' },
    });
  }
  return makeFinding({
    rule: 'T2',
    subject: w.workload,
    kind: 'FAIL',
    headline: 'no drain delay before SIGTERM',
    chain,
  });
}
