export const DEMO_BUDGET_S: number;
export const TREE_BUDGET_S: number;
/** True when `seconds` is not under `budget` (the budgets say "under": equal is over). */
export function overBudget(seconds: number, budget: number): boolean;
/** True when the 1-minute load is above half the CPUs (the measurement lanes' busy rule). */
export function hostBusy(load: number, cpus: number): boolean;
export const SETTLE_MAX_MS: number;
/** Waits (via `sleep`) until the load read is not busy or `maxMs` passed; returns the last load read. */
export function settle(
  readLoad: () => number,
  cpus: number,
  maxMs: number,
  sleep: (ms: number) => void,
): number;
/** True when `value` is a non-empty string, usable as a recorded model or CPU. */
export function validIdentity(value: unknown): value is { model: string; cpu: string };
/** A sysctl value bounded to 80 printable ASCII characters, for printing. */
export function printable(value: string): string;
export function generateTree(root: string, files?: number): void;
