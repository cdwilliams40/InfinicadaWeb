import { z } from "zod";
import { type ToolContext, READ_ONLY, dateRange, optionalDate, resolveRange } from "../context";
import { error, jsonResult, safely } from "../result";
import { aggregate, period } from "../summaries";

const WEIGH_IN_FIELDS = [
  "calendarDate",
  "timestampGMT",
  "weight",
  "bmi",
  "bodyFat",
  "bodyWater",
  "boneMass",
  "muscleMass",
  "visceralFat",
  "weightDelta",
  "sourceType",
];

const compactWeighIn = (entry: Record<string, unknown>) =>
  Object.fromEntries(WEIGH_IN_FIELDS.map((field) => [field, entry[field]]));

/** Mass fields Garmin reports in grams, although its API reference says kilograms. */
const GRAM_FIELDS = new Set(["weight", "minWeight", "maxWeight", "boneMass", "muscleMass", "weightDelta"]);

/**
 * Convert mass fields to kilograms, so a model never reads 70000 as a weight.
 * Also drops `metabolicAge`, which Garmin fills with an epoch timestamp.
 */
export function inKilograms(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inKilograms);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "metabolicAge" && typeof item === "number" && item > 1e11) continue;
    const isGrams =
      GRAM_FIELDS.has(key) || (key === "goalValue" && String(record.userGoalType ?? "").endsWith("GRAMS"));
    result[key] = typeof item === "number" && isGrams ? item / 1000 : inKilograms(item);
  }
  if (typeof record.userGoalType === "string") result.userGoalType = record.userGoalType.replace(/GRAMS$/, "KILOGRAMS");
  return result;
}

/** Weight and body composition, fitness age and heart rate zones. */
export function registerBodyTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_get_weight",
    {
      title: "Get weight",
      description:
        "Weight summary for a range as Garmin computes it: per day, the number of weigh-ins, min/max weight and the latest weigh-in with body composition; totalAverage for the range; previousDateWeight and nextDateWeight, the nearest weigh-ins outside the range. Masses are in kilograms. For trends over months, garmin_get_weigh_ins with period=month is lighter. Defaults to the last 30 days.",
      inputSchema: z.object({
        ...dateRange,
        includeAll: z.boolean().default(false).describe("Include every weigh-in of each day, not only the latest."),
      }),
      annotations: { title: "Get weight", ...READ_ONLY },
    },
    ({ includeAll, ...input }) =>
      safely(async () => {
        const range = resolveRange(today, input, { defaultDays: 30 });
        if ("error" in range) return error(range.error);
        return jsonResult(
          inKilograms(await garmin.getJson(`/weight-service/weight/range/${range.start}/${range.end}`, { includeAll })),
        );
      }),
  );

  server.registerTool(
    "garmin_get_weigh_ins",
    {
      title: "List weigh-ins",
      description:
        "Every individual weigh-in in a range: weight, BMI, body fat %, body water %, bone and muscle mass, visceral fat, change from the previous entry and source. Masses are in kilograms. Best for weight trends: period=week or month averages the entries and adds weightMin/weightMax per period. Defaults to the last 30 days; up to 366 days.",
      inputSchema: z.object({ ...dateRange, period }),
      annotations: { title: "List weigh-ins", ...READ_ONLY },
    },
    ({ period, ...input }) =>
      safely(async () => {
        const range = resolveRange(today, input, { defaultDays: 30 });
        if ("error" in range) return error(range.error);
        const entries = inKilograms(
          await garmin.getJson(`/weight-service/weight/all/${range.start}/${range.end}`),
        ) as Array<Record<string, unknown>> | null;
        const rows = (entries ?? []).map(compactWeighIn);
        const latest = rows.map((row) => String(row.calendarDate ?? "")).sort().at(-1);
        const note = latest
          ? `${rows.length} weigh-ins; the latest is from ${latest}.${period === "day" ? "" : " Periods without weigh-ins are not listed."}`
          : undefined;
        if (period === "day") return jsonResult(rows, { note });
        // The mean of changes between weigh-ins means nothing, so leave weightDelta out.
        const oldestFirst = rows
          .map(({ weightDelta: _, ...row }) => row)
          .sort((a, b) => String(a.calendarDate).localeCompare(String(b.calendarDate)));
        return jsonResult(aggregate(oldestFirst, period, { countKey: "weighIns", extremes: ["weight"] }), { note });
      }),
  );

  server.registerTool(
    "garmin_get_weight_goals",
    {
      title: "Get weight goals",
      description:
        "The user's effective weight goals and goal ranges during a date range, in kilograms. Defaults to the last 30 days.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get weight goals", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input, { defaultDays: 30 });
        if ("error" in range) return error(range.error);
        return jsonResult(
          inKilograms(await garmin.getJson(`/goal-service/goal/user/effective/weightgoal/${range.start}/${range.end}`)),
        );
      }),
  );

  server.registerTool(
    "garmin_get_fitness_age",
    {
      title: "Get fitness age",
      description:
        "Garmin's Fitness Age as of a date: chronological age, fitness age, achievable fitness age, previous value and the components behind it (vigorous days and minutes, resting heart rate…).",
      inputSchema: z.object({
        date: optionalDate("Reference date; the latest Fitness Age on or before it is returned"),
        fullHistoryScan: z
          .boolean()
          .default(true)
          .describe("Search the whole history for the latest value; false limits the search to the 28 days before date."),
      }),
      annotations: { title: "Get fitness age", ...READ_ONLY },
    },
    ({ date = today, fullHistoryScan }) =>
      safely(async () =>
        jsonResult(await garmin.getJson(`/fitnessage-service/fitnessage/v2/${date}`, { fullHistoryScan })),
      ),
  );

  server.registerTool(
    "garmin_get_heart_rate_zones",
    {
      title: "Get heart rate zones",
      description:
        "The user's current heart rate zone configuration: training method (HR_MAX, HR_RESERVE, LACTATE_THRESHOLD or CUSTOM), the lower bound of zones 1-5 in bpm (zone 5 ends at the max HR), and the resting, max and lactate-threshold HR used. DEFAULT applies to every sport without its own entry (RUNNING, CYCLING, SWIMMING, ROWING). Activities keep the zones that were current when recorded.",
      inputSchema: z.object({
        generateDefaults: z
          .boolean()
          .default(true)
          .describe("Return Garmin's default zones when the user has not configured any."),
      }),
      annotations: { title: "Get heart rate zones", ...READ_ONLY },
    },
    ({ generateDefaults }) =>
      safely(async () =>
        jsonResult(await garmin.getJson("/biometric-service/heartRateZones/v2", { generateDefaults })),
      ),
  );
}
