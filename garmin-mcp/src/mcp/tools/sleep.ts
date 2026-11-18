import { z } from "zod";
import { type ToolContext, READ_ONLY, dateRange, fetchInWindows, optionalDate, resolveRange } from "../context";
import { error, jsonResult, safely } from "../result";
import { aggregate, detail, period, summarizeSleep } from "../summaries";

/** Sleep and heart rate variability. */
export function registerSleepTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_get_sleep",
    {
      title: "Get sleep",
      description:
        "One night of sleep, by the calendar date Garmin assigns to it (the wake-up date): duration, deep/light/REM/awake seconds, sleep scores and Garmin's feedback, sleep need, SpO2, respiration, sleep stress, average HR and naps.",
      inputSchema: z.object({ date: optionalDate("Wake-up date") }),
      annotations: { title: "Get sleep", ...READ_ONLY },
    },
    ({ date = today }) =>
      safely(async () => jsonResult(await garmin.getJson("/sleep-service/sleep/dailySleep", { date }))),
  );

  server.registerTool(
    "garmin_get_sleep_history",
    {
      title: "Get sleep history",
      description:
        "Sleep for a range of nights (by wake-up date): duration, deep/light/REM/awake time, sleep score, sleep need, heart rate, stress, respiration and SpO2. By default one compact row per night; period=week or month averages them. detail=full returns the same records as garmin_get_sleep. Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object({ ...dateRange, detail, period }),
      annotations: { title: "Get sleep history", ...READ_ONLY },
    },
    ({ detail, period, ...input }) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        if (detail === "full" && period !== "day") return error("period only applies to detail=summary.");
        const nights = await fetchInWindows(range.start, range.end, 31, (from, to) =>
          garmin.getJson<Array<Record<string, unknown>>>("/sleep-service/sleep/dailySleepSummariesByDate", {
            startDate: from,
            endDate: to,
          }),
        );
        return jsonResult(detail === "full" ? nights : aggregate(nights.map(summarizeSleep), period));
      }),
  );

  server.registerTool(
    "garmin_get_hrv",
    {
      title: "Get overnight HRV",
      description:
        "Overnight heart rate variability for one night (by wake-up date): last-night average, 5-minute high, weekly average, baseline range and status (BALANCED, UNBALANCED, LOW…). Set includeReadings for the 5-minute readings.",
      inputSchema: z.object({
        date: optionalDate("Wake-up date"),
        includeReadings: z.boolean().default(false).describe("Include the individual 5-minute HRV readings."),
      }),
      annotations: { title: "Get overnight HRV", ...READ_ONLY },
    },
    ({ date = today, includeReadings }) =>
      safely(async () =>
        jsonResult(await garmin.getJson(`/hrv-service/hrv/${date}`), { omit: includeReadings ? [] : ["hrvReadings"] }),
      ),
  );

  server.registerTool(
    "garmin_get_hrv_history",
    {
      title: "Get HRV history",
      description:
        "Daily HRV summaries for a range: last-night average, weekly average, baseline and status per day. Use for recovery trends. Defaults to the last 28 days; up to 366 days.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get HRV history", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input, { defaultDays: 28 });
        if ("error" in range) return error(range.error);
        // The per-request limit is undocumented; 31 days matches Garmin's other range endpoints.
        const summaries = await fetchInWindows(range.start, range.end, 31, async (from, to) => {
          const page = await garmin.getJson<{ hrvSummaries?: unknown[] }>(`/hrv-service/hrv/daily/${from}/${to}`);
          return page?.hrvSummaries ?? [];
        });
        return jsonResult(summaries);
      }),
  );
}
