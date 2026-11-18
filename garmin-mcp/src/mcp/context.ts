import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GarminClient } from "../garmin/client";
import { addDays, daysBetween, dateWindows, isValidDate } from "../garmin/dates";

/** What every tool module receives. */
export interface ToolContext {
  server: McpServer;
  garmin: GarminClient;
  /** Today's date in the user's time zone. */
  today: string;
}

/** Every Garmin tool only reads the user's own data from an external service. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Most tools accept multi-month ranges and split them into the windows Garmin allows. */
export const MAX_RANGE_DAYS = 366;

/**
 * A calendar date. A short pattern plus a refinement instead of `z.iso.date()`,
 * whose JSON Schema regex adds ~330 characters to every date parameter in
 * tools/list.
 */
export const date = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidDate, "Not a valid calendar date")
    .describe(`${description} (YYYY-MM-DD).`);

export const optionalDate = (description = "Calendar date") =>
  date(`${description}. Defaults to today in the user's time zone`).optional();

export const dateRange = {
  startDate: date("First day of the range, inclusive").optional(),
  endDate: date("Last day of the range, inclusive. Defaults to today").optional(),
};

export const includeSamples = z
  .boolean()
  .default(false)
  .describe("Include the full-resolution sample arrays (hundreds of points per day). Leave off unless a timeline is needed.");

/**
 * Resolve an optional range: `endDate` defaults to today and `startDate` to
 * `defaultDays` days ending on `endDate`. Returns an error message when invalid.
 */
export function resolveRange(
  today: string,
  input: { startDate?: string; endDate?: string },
  { defaultDays = 7, maxDays = MAX_RANGE_DAYS } = {},
): { start: string; end: string } | { error: string } {
  const end = input.endDate ?? today;
  const start = input.startDate ?? addDays(end, -(defaultDays - 1));
  if (start > end) return { error: `startDate (${start}) is after endDate (${end}).` };
  const days = daysBetween(start, end);
  if (days > maxDays) {
    return { error: `The range covers ${days} days; this tool accepts at most ${maxDays}. Split it into smaller ranges.` };
  }
  return { start, end };
}

/**
 * Fetch a range that may exceed an endpoint's per-request limit, one window at
 * a time (Garmin publishes no rate limits, so requests stay sequential), and
 * concatenate the results.
 */
export async function fetchInWindows<T>(
  start: string,
  end: string,
  maxDaysPerRequest: number,
  fetchWindow: (from: string, to: string) => Promise<T[] | null>,
): Promise<T[]> {
  const results: T[] = [];
  for (const [from, to] of dateWindows(start, end, maxDaysPerRequest)) {
    results.push(...((await fetchWindow(from, to)) ?? []));
  }
  return results;
}
