// Shared by rules T2 and T3 (bolt B4): the words both print, the values they read from the model, and
// the seconds arithmetic. A rule reads only the resolved model; nothing here reads a file or
// the clock.

import {
  type Assumption,
  type ChainStep,
  makeSourcedValue,
  makeUnresolved,
  type SourcedValue,
  type SourceRef,
  type UnresolvedValue,
} from '../core/index.js';
import type { K8sPreStop } from '../parse/index.js';
import type { ResolvedWorkload } from '../resolve/index.js';

/** The standing assumption of every T2 verdict: a delay is checked for, not its sufficiency. */
export const PROPAGATION_ASSUMPTION: Assumption = {
  text: "Endpoint removal needs time to propagate; AWS's EKS guide suggests a preStop of 10 s. tripcurve checks a delay exists, not that it is enough.",
  reason: 'T2 checks that a delay exists, not how long it must be',
};

/** A T3 verdict that counts a Python server's in-process drain as 0 s used this: no reader exists for it. */
export const PYTHON_DRAIN_ASSUMPTION: Assumption = {
  text: 'In-process drains of Python servers are not read; counted as 0 s.',
  reason: 'in-process drains are read for Node source only, so T3 adds none unless one is declared',
};

/** Seconds as whole milliseconds, or undefined when the value is not a safe count (no float sums). */
export function toMs(seconds: number, round: 'up' | 'down' = 'up'): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  // Float noise (1.1 * 1000 = 1100.0000000000002) is removed first; real sub-millisecond precision is
  // rounded in the safe direction: a time to be covered goes UP, the grace period that covers it goes DOWN.
  const exact = Number((seconds * 1000).toFixed(6));
  const ms = round === 'up' ? Math.ceil(exact) : Math.floor(exact);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/** A value in seconds (unit `s`) or in milliseconds (unit `ms`) as whole milliseconds. */
export function valueMs(v: SourcedValue, round: 'up' | 'down' = 'up'): number | undefined {
  if (typeof v.value !== 'number') return undefined;
  if (v.unit === 's') return toMs(v.value, round);
  if (v.unit === 'ms') return Number.isSafeInteger(v.value) && v.value >= 0 ? v.value : undefined;
  return undefined;
}

/** Whole milliseconds as printed seconds: `10`, `0.5`, `1.25`. */
export function secondsText(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export type PreStop =
  | { readonly kind: 'none' }
  | { readonly kind: 'delay'; readonly value: SourcedValue; readonly ms: number }
  | { readonly kind: 'hook'; readonly source: SourceRef; readonly reason: UnresolvedValue };

export function preStopOf(w: ResolvedWorkload): PreStop {
  const p: K8sPreStop | undefined = w.preStop;
  if (p === undefined) return { kind: 'none' };
  if (p.form === 'hook') return { kind: 'hook', source: p.source, reason: p.delay };
  const ms = valueMs(p.delay);
  return ms === undefined
    ? {
        kind: 'hook',
        source: p.source,
        reason: makeUnresolved('the preStop delay is not a number'),
      }
    : { kind: 'delay', value: p.delay, ms };
}

/** A step that points at a place in the files with the fixed word `unknown` as its value (it prints `drain unknown  "src/server.ts":40`). */
export function unknownStep(label: string, at: SourceRef): ChainStep {
  return {
    label,
    value: makeSourcedValue({ value: 'unknown', unit: 'none', source: at, basis: 'declared' }),
  };
}

/** `preStop none     in "k8s/api.yaml"`: the workload's own file, quoted, or the standard-input stream. */
export function preStopNoneStep(w: ResolvedWorkload): ChainStep {
  const at = w.file;
  if (at.type === 'file' || at.type === 'declared') {
    return { label: 'preStop none', value: at.file, detail: 'in', plain: true };
  }
  if (at.type === 'stdin') {
    return { label: 'preStop none', value: { note: `in <stdin> document ${at.document}` } };
  }
  return { label: 'preStop none', value: { note: 'in the input' } };
}
