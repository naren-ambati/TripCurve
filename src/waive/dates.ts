// Dates for waivers. Every date is a UTC calendar date `YYYY-MM-DD`; fixed width, so comparing two
// valid dates as text compares them as dates. Nothing here reads a clock: the date of the
// run is an input.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysIn(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** A real calendar date in the form YYYY-MM-DD, year 0001 to 9999. There is no upper bound on `until`. */
export function isIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

/**
 * Whether a waiver that runs until `until` has expired on `today`: it applies through its own
 * date, inclusive, and has expired from the day after. Both must be valid dates.
 */
export function hasExpired(until: string, today: string): boolean {
  return until < today;
}
