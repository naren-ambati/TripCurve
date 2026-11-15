// Rule T4: the queue's visibility timeout must cover redelivery of a batch:
//     visibility >= 6 x function timeout + batching window            (all in seconds)
// The AWS Lambda guide says to set the visibility timeout to at least six times the function timeout, and
// plus the batching window when one is set (docs/lookups-b5.txt). Equal passes (>=).
//
// Outcomes:
//   - every input established: PASS, or FAIL with the arithmetic (`visibility 60 s is less than 6 x 30 s
//     + 5 s = 185 s`);
//   - any input not established (a variable, an unlinked queue or function ...): UNRESOLVED with what to
//     declare, never PASS and never FAIL;
//   - the batching window not set, or not known (a variable, out of range): a window is 0 s or more (documented
//     range 0 to 300 s), so it can only RAISE the need. Visibility below 6 x timeout is then a FAIL whatever the
//     window is (bolt B17): the rule's headline says the window is not set (or not known) and not used. A
//     visibility at or above 6 x timeout needs the window to settle, so the assumed 0 s is shown with what it
//     would mean ("T4 would pass") and the result is UNRESOLVED: a PASS never rests on an assumed value.
// A PASS or FAIL is built only through makeFinding / passBlocker, so an unverified value cannot give one.
// `--explain T4` and its cdk-nag credit are bolt B6. The rule reads only the resolved model.

import {
  type ChainStep,
  type Finding,
  isSourcedValue,
  isUnresolved,
  makeFinding,
  PASS_REFUSAL_HEADLINES,
  passBlocker,
  type SourcedValue,
} from '../core/index.js';
import type { QueueInput, ResolvedQueueWorkload } from '../resolve/index.js';
import { formatSeconds } from './t1.js';

function seconds(v: SourcedValue): number | undefined {
  return typeof v.value === 'number' && v.unit === 's' && Number.isSafeInteger(v.value)
    ? v.value
    : undefined;
}

function chainOf(w: ResolvedQueueWorkload): ChainStep[] {
  return [w.visibility.step, w.functionTimeout.step, w.batchingWindow.step];
}

function unresolved(
  w: ResolvedQueueWorkload,
  headline: string,
  declare: readonly string[],
): Finding {
  return makeFinding({
    rule: 'T4',
    subject: w.queue,
    kind: 'UNRESOLVED',
    headline,
    chain: chainOf(w),
    declare,
    // every UNRESOLVED result shows the chain with the assumed window in it, so it lists the assumption
    assumptions: w.assumptions,
  });
}

/**
 * Visibility below 6 x timeout, with the window not established (B17). Undefined when this does not apply:
 * either input is not established or not verified (a PASS-grade value is needed, as for any FAIL), or the window
 * is a written literal (the full arithmetic below then applies).
 */
function failWithoutWindow(w: ResolvedQueueWorkload): Finding | undefined {
  const windowOpen = w.batchingAssumed || isUnresolved(w.batchingWindow.value);
  if (!windowOpen) return undefined;
  const visibility = w.visibility.value;
  const timeout = w.functionTimeout.value;
  if (!isSourcedValue(visibility) || !isSourcedValue(timeout)) return undefined;
  const v = seconds(visibility);
  const t = seconds(timeout);
  if (v === undefined || t === undefined || v >= 6 * t) return undefined;
  // The verdict rests on these two values only; the assumed window is left out of the chain.
  const chain = [w.visibility.step, w.functionTimeout.step];
  if (passBlocker(chain) !== undefined) return undefined;
  const why = w.batchingAssumed ? 'is not set' : 'is not known';
  return makeFinding({
    rule: 'T4',
    subject: w.queue,
    kind: 'FAIL',
    headline: `visibility ${formatSeconds(v)} s is less than 6 x ${formatSeconds(t)} s = ${formatSeconds(6 * t)} s; the batching window ${why}, and any window only raises the need`,
    chain,
  });
}

export function evaluateT4(w: ResolvedQueueWorkload): Finding {
  const certain = failWithoutWindow(w);
  if (certain !== undefined) return certain;
  const inputs: readonly [string, QueueInput][] = [
    ['visibility timeout', w.visibility],
    ['function timeout', w.functionTimeout],
    ['batching window', w.batchingWindow],
  ];
  // 1. an input that is not established (the assumed window is handled in 3)
  for (const [name, input] of inputs) {
    if (isUnresolved(input.value)) {
      const declare = [
        ...new Set(inputs.flatMap(([, i]) => (isUnresolved(i.value) ? i.declare : []))),
      ];
      return unresolved(w, `${name} not established: ${input.value.reason}`, declare);
    }
  }
  const visibility = w.visibility.value;
  const timeout = w.functionTimeout.value;
  const window = w.batchingWindow.value;
  if (!isSourcedValue(visibility) || !isSourcedValue(timeout) || !isSourcedValue(window)) {
    return unresolved(w, 'an input of this check is not established', []);
  }
  const v = seconds(visibility);
  const t = seconds(timeout);
  const b = seconds(window);
  if (v === undefined || t === undefined || b === undefined) {
    return unresolved(w, 'an input of this check is not a whole number of seconds', []);
  }
  const need = 6 * t + b;
  const sum = `6 x ${formatSeconds(t)} s + ${formatSeconds(b)} s = ${formatSeconds(need)} s`;
  const passes = v >= need;

  // 3. the batching window is assumed, not set: say what it would mean, never PASS or FAIL
  if (w.batchingAssumed) {
    const blocked = passBlocker([w.visibility.step, w.functionTimeout.step]);
    const would =
      blocked === undefined
        ? `, so ${
            passes
              ? `visibility ${formatSeconds(v)} s covers ${formatSeconds(need)} s (T4 would pass)`
              : `visibility ${formatSeconds(v)} s is less than ${sum} (T4 would FAIL)`
          }`
        : '';
    return unresolved(
      w,
      `batching window is not set in the files; assumed ${formatSeconds(b)} s${would}`,
      w.batchingWindow.declare,
    );
  }

  const chain = chainOf(w);
  if (passes) {
    return makeFinding({
      rule: 'T4',
      subject: w.queue,
      kind: 'PASS',
      headline: `visibility ${formatSeconds(v)} s covers ${formatSeconds(need)} s`,
      chain,
    });
  }
  // A FAIL rests on the same values a PASS would: refuse it when any is unverified.
  const blocker = passBlocker(chain);
  if (blocker !== undefined) {
    return unresolved(w, PASS_REFUSAL_HEADLINES[blocker], []);
  }
  return makeFinding({
    rule: 'T4',
    subject: w.queue,
    kind: 'FAIL',
    headline: `visibility ${formatSeconds(v)} s is less than ${sum}`,
    chain,
  });
}
