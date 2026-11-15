// The one place tripcurve reads the clock. A waiver runs through its `until` date, inclusive, in
// UTC; the command reads the date once, at the top of a run, and hands it down. Rules,
// the waiver applier and the report read no clock, and a test scans for it.

/** The current UTC calendar date, `YYYY-MM-DD`. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
