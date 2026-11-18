/** Calendar-date helpers. Dates are plain `YYYY-MM-DD` strings in the user's local calendar. */

const DAY_MS = 86_400_000;

/** Today's date in the given IANA time zone. */
export function today(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Number of days in the inclusive range. */
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Split an inclusive range into consecutive windows of at most `maxDays` days. */
export function dateWindows(start: string, end: string, maxDays: number): Array<[string, string]> {
  const windows: Array<[string, string]> = [];
  for (let from = start; from <= end; from = addDays(from, maxDays)) {
    const to = addDays(from, maxDays - 1);
    windows.push([from, to < end ? to : end]);
  }
  return windows;
}
