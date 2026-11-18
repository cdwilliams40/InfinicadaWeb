import { z } from "zod";
import { type ToolContext, READ_ONLY, dateRange, fetchInWindows, includeSamples, optionalDate, resolveRange } from "../context";
import { error, jsonResult, safely } from "../result";
import { aggregate, detail, period, summarizeDay } from "../summaries";

const HEART_RATE_SAMPLES = ["heartRateValues", "heartRateValueDescriptors"];
const SPO2_SAMPLES = [
  "spO2SingleValues",
  "spO2SingleValuesDescriptorList",
  "monitoringEnvironmentValues",
  "monitoringEnvironmentValuesDescriptorList",
];
const BODY_BATTERY_SAMPLES = ["bodyBatteryValuesArray", "bodyBatteryValueDescriptorDTOList"];

type BodyBatteryReport = Record<string, unknown> & {
  startTimestampGMT?: string;
  startTimestampLocal?: string;
  bodyBatteryValuesArray?: Array<[number, number | null]>;
};

/** Garmin's "2026-11-01T23:00:00.0" timestamps, read as UTC. */
const parseGarminTime = (value: string | undefined) => (value ? Date.parse(`${value.replace(/\.\d+$/, "")}Z`) : NaN);

/**
 * Replace the [epoch ms, level] pairs with labelled values in the report's own
 * local time, which is what people ask about ("at 8 am"). With `chunks`, the
 * pairs are grouped back into their intervals as { start, end, min, max }.
 */
function withLocalLevels(
  { bodyBatteryValuesArray, bodyBatteryValueDescriptorDTOList: _, ...report }: BodyBatteryReport,
  chunks: number | undefined,
) {
  const dayStart = parseGarminTime(report.startTimestampGMT);
  const dayEnd = parseGarminTime(report.endTimestampGMT as string | undefined);
  const offset = parseGarminTime(report.startTimestampLocal) - dayStart;
  const local = (timestamp: number) =>
    new Date(timestamp + (Number.isNaN(offset) ? 0 : offset)).toISOString().slice(0, 16);
  const readings = (bodyBatteryValuesArray ?? []).filter(
    (pair): pair is [number, number] => typeof pair[1] === "number",
  );

  if (!chunks || Number.isNaN(dayStart) || Number.isNaN(dayEnd)) {
    return { ...report, levels: readings.map(([timestamp, level]) => ({ timeLocal: local(timestamp), level })) };
  }
  const length = (dayEnd - dayStart) / chunks;
  const intervals = Array.from({ length: chunks }, (_, index) => ({
    start: local(dayStart + index * length),
    end: local(dayStart + (index + 1) * length),
    levels: [] as number[],
  }));
  for (const [timestamp, level] of readings) {
    intervals[Math.min(chunks - 1, Math.max(0, Math.floor((timestamp - dayStart) / length)))]!.levels.push(level);
  }
  return {
    ...report,
    intervals: intervals
      .filter(({ levels }) => levels.length > 0)
      .map(({ start, end, levels }) => ({ start, end, min: Math.min(...levels), max: Math.max(...levels) })),
  };
}

/** Daily wellness: summaries, steps, stress, hydration, heart rate, SpO2 and Body Battery. */
export function registerDailyTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_get_daily_summary",
    {
      title: "Get daily summary",
      description:
        "Everything Garmin tracked on one day: steps, distance, calories (active/BMR), floors, intensity minutes, resting/min/max heart rate, stress, Body Battery, SpO2, respiration and hydration. Start here for questions about a single day.",
      inputSchema: z.object({ date: optionalDate() }),
      annotations: { title: "Get daily summary", ...READ_ONLY },
    },
    ({ date = today }) =>
      safely(async () =>
        jsonResult(await garmin.getJson("/usersummary-service/usersummary/daily", { calendarDate: date })),
      ),
  );

  server.registerTool(
    "garmin_get_daily_summaries",
    {
      title: "Get daily summaries",
      description:
        "Wellness summaries for a range: steps, distance, floors, calories, resting/min/max heart rate, intensity minutes, stress, Body Battery, respiration and SpO2. Best for trends: by default one compact row per day; period=week or month averages them, which fits a whole year. Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object({ ...dateRange, detail, period }),
      annotations: { title: "Get daily summaries", ...READ_ONLY },
    },
    ({ detail, period, ...input }) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        if (detail === "full" && period !== "day") return error("period only applies to detail=summary.");
        const days = await fetchInWindows<Record<string, unknown>>(range.start, range.end, 365, async (from, to) => {
          const page = await garmin.getJson<{ data?: Array<Record<string, unknown>> }>("/usersummary-service/v2/dailysummaries", {
            startDate: from,
            endDate: to,
          });
          return page?.data ?? [];
        });
        return jsonResult(detail === "full" ? days : aggregate(days.map(summarizeDay), period));
      }),
  );

  server.registerTool(
    "garmin_get_steps",
    {
      title: "Get daily steps",
      description: "Total steps, distance and step goal per day for a range. Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get daily steps", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        return jsonResult(
          await fetchInWindows(range.start, range.end, 28, (from, to) =>
            garmin.getJson<unknown[]>(`/usersummary-service/stats/steps/daily/${from}/${to}`),
          ),
        );
      }),
  );

  server.registerTool(
    "garmin_get_stress",
    {
      title: "Get daily stress",
      description:
        "Daily stress levels for a range (Garmin's 0-100 scale; higher is more stressed). Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get daily stress", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        return jsonResult(
          await fetchInWindows(range.start, range.end, 28, (from, to) =>
            garmin.getJson<unknown[]>(`/usersummary-service/stats/stress/daily/${from}/${to}`),
          ),
        );
      }),
  );

  server.registerTool(
    "garmin_get_hydration",
    {
      title: "Get daily hydration",
      description:
        "Logged water intake, goal and estimated sweat loss per day for a range (millilitres). Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get daily hydration", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        return jsonResult(
          await fetchInWindows(range.start, range.end, 31, (from, to) =>
            garmin.getJson<unknown[]>(`/usersummary-service/stats/hydration/daily/${from}/${to}`),
          ),
        );
      }),
  );

  server.registerTool(
    "garmin_get_heart_rate",
    {
      title: "Get daily heart rate",
      description:
        "Heart rate for one day: resting, minimum and maximum, 7-day average resting HR, and abnormal-HR thresholds and readings. Set includeSamples for the all-day timeline ([timestamp ms, bpm] pairs).",
      inputSchema: z.object({ date: optionalDate(), includeSamples }),
      annotations: { title: "Get daily heart rate", ...READ_ONLY },
    },
    ({ date = today, includeSamples }) =>
      safely(async () =>
        jsonResult(await garmin.getJson("/wellness-service/wellness/dailyHeartRate", { date }), {
          omit: includeSamples ? [] : HEART_RATE_SAMPLES,
        }),
      ),
  );

  server.registerTool(
    "garmin_get_spo2",
    {
      title: "Get daily SpO2",
      description:
        "Blood oxygen (pulse ox) for one day: average, lowest, latest, 7-day average, sleep average and hourly averages. Set includeSamples for individual readings and monitoring-environment (altitude) values.",
      inputSchema: z.object({ date: optionalDate(), includeSamples }),
      annotations: { title: "Get daily SpO2", ...READ_ONLY },
    },
    ({ date = today, includeSamples }) =>
      safely(async () =>
        jsonResult(await garmin.getJson(`/wellness-service/wellness/daily/spo2acclimation/${date}`), {
          omit: includeSamples ? [] : SPO2_SAMPLES,
        }),
      ),
  );

  server.registerTool(
    "garmin_get_body_battery",
    {
      title: "Get Body Battery",
      description:
        "Daily Body Battery reports for a range: energy charged and drained, activity events (sleep, workouts) and Garmin's feedback. For levels through the day, set `chunks` (e.g. 24 for hourly): `intervals` then lists each interval's local start and end with its min and max level. includeSamples (without chunks) returns every reading as `levels`. For daily min/max, garmin_get_daily_summaries is lighter. Defaults to the last 7 days; up to 366 days.",
      inputSchema: z.object({
        ...dateRange,
        chunks: z
          .number()
          .int()
          .min(1)
          .max(96)
          .optional()
          .describe("Split each day into this many intervals and return the min/max level of each."),
        includeSamples,
      }),
      annotations: { title: "Get Body Battery", ...READ_ONLY },
    },
    ({ chunks, includeSamples, ...input }) =>
      safely(async () => {
        const range = resolveRange(today, input);
        if ("error" in range) return error(range.error);
        const reports = await fetchInWindows(range.start, range.end, 31, (from, to) =>
          garmin.getJson<BodyBatteryReport[]>("/wellness-service/wellness/bodyBattery/reports/daily", {
            startDate: from,
            endDate: to,
            chunks,
          }),
        );
        // With `chunks`, the per-interval values come back in the sample array.
        return includeSamples || chunks
          ? jsonResult(reports.map((report) => withLocalLevels(report, chunks)))
          : jsonResult(reports, { omit: BODY_BATTERY_SAMPLES });
      }),
  );
}
