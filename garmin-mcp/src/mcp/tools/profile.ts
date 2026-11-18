import { z } from "zod";
import { type ToolContext, READ_ONLY, optionalDate } from "../context";
import { jsonResult, safely } from "../result";

/** Nutrition, women's health and profile settings. */
export function registerProfileTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_get_nutrition",
    {
      title: "Get nutrition log",
      description:
        "Food logged in Garmin Connect for one day: calorie and macronutrient goals, totals consumed, logged foods with serving sizes and a per-meal breakdown.",
      inputSchema: z.object({
        date: optionalDate(),
        mealId: z.number().int().positive().optional().describe("Only this meal (breakfast, lunch, dinner or snacks ID)."),
        includeGoals: z.boolean().default(true).describe("Include the day's nutrition goals."),
        includeNutrition: z.boolean().default(true).describe("Include nutrient details."),
        includeMedia: z.boolean().default(false).describe("Include food image URLs."),
      }),
      annotations: { title: "Get nutrition log", ...READ_ONLY },
    },
    ({ date = today, ...query }) =>
      safely(async () => jsonResult(await garmin.getJson(`/nutrition-service/food/logs/${date}`, query))),
  );

  server.registerTool(
    "garmin_get_menstrual_cycle",
    {
      title: "Get menstrual cycle summary",
      description:
        "Menstrual cycle summary as of a date: current phase, day in cycle, days until the next phase, period length, fertile window, predicted ovulation and next cycle, or pregnancy tracking details.",
      inputSchema: z.object({ date: optionalDate() }),
      annotations: { title: "Get menstrual cycle summary", ...READ_ONLY },
    },
    ({ date = today }) =>
      safely(async () =>
        jsonResult(await garmin.getJson(`/periodichealth-service/menstrualcycle/summary/${date}`)),
      ),
  );

  server.registerTool(
    "garmin_get_menstrual_cycle_day",
    {
      title: "Get menstrual cycle day",
      description:
        "Detailed menstrual cycle view for one day: logged symptoms, flow and mood, the cycle summary for that day and, during pregnancy, weekly weight goal ranges.",
      inputSchema: z.object({
        date: optionalDate(),
        includeAnalysis: z.boolean().default(false).describe("Include Garmin's cycle analysis."),
        reducedResponse: z.boolean().default(false).describe("Return a lighter payload."),
        includeBabyMovement: z.boolean().default(true).describe("Include baby movement (kick count) data."),
      }),
      annotations: { title: "Get menstrual cycle day", ...READ_ONLY },
    },
    ({ date = today, includeAnalysis, reducedResponse, includeBabyMovement }) =>
      safely(async () =>
        jsonResult(
          await garmin.getJson(`/periodichealth-service/menstrualcycle/dayview/${date}`, {
            todayDate: today,
            includeAnalysis,
            reducedResponse,
            skipbm: !includeBabyMovement,
          }),
        ),
      ),
  );

  server.registerTool(
    "garmin_get_profile_settings",
    {
      title: "Get profile settings",
      description:
        "The user's profile settings: display name, locale, time zone, measurement system and unit/format preferences, first day of week, hydration containers, wheelchair mode, and preferred training days. Useful for interpreting units and dates.",
      inputSchema: z.object({}),
      annotations: { title: "Get profile settings", ...READ_ONLY },
    },
    () => safely(async () => jsonResult(await garmin.getJson("/userprofile-service/userprofile/settings"))),
  );
}
