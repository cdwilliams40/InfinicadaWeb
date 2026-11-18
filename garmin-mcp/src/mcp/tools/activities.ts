import { z } from "zod";
import { decodeFit, unzipActivity } from "../../garmin/fit";
import { type ToolContext, READ_ONLY, date, dateRange, fetchInWindows, resolveRange } from "../context";
import { error, jsonResult, safely } from "../result";
import { activityTotals } from "../summaries";

const PAGE_SIZE = 100;
/** Upper bound for groupBy, which pages through every match: ten requests. */
const MAX_GROUPED_ACTIVITIES = 1000;

/** Social and display fields that only add noise for the model. */
const ACTIVITY_NOISE = [
  "ownerProfileImageUrlSmall",
  "ownerProfileImageUrlMedium",
  "ownerProfileImageUrlLarge",
  "ownerDisplayName",
  "ownerFullName",
  "activityLikeDisplayNames",
  "activityLikeFullNames",
  "activityLikeProfileImageUrls",
  "likedByUser",
  "commentedByUser",
  "requestorRelationship",
  "numberOfActivityLikes",
  "numberOfActivityComments",
];

type Activity = Record<string, unknown>;

const typeKey = (value: unknown) => (value as { typeKey?: string } | undefined)?.typeKey;

/** The fields that answer most questions about a list of activities (~0.5 KB instead of ~3 KB each). */
function summarizeActivity(activity: Activity): Activity {
  const pick = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, activity[key]]));
  return {
    ...pick("activityId", "activityName"),
    activityType: typeKey(activity.activityType),
    eventType: typeKey(activity.eventType),
    ...pick(
      "startTimeLocal",
      "locationName",
      "distance",
      "duration",
      "movingDuration",
      "elapsedDuration",
      "elevationGain",
      "averageSpeed",
      "averageHR",
      "maxHR",
      "avgPower",
      "normPower",
      "calories",
      "activityTrainingLoad",
      "aerobicTrainingEffect",
      "anaerobicTrainingEffect",
      "trainingEffectLabel",
      "vO2MaxValue",
      "lapCount",
      "hrTimeInZone_1",
      "hrTimeInZone_2",
      "hrTimeInZone_3",
      "hrTimeInZone_4",
      "hrTimeInZone_5",
    ),
  };
}

const activityId = z.number().int().positive().describe("Garmin activity ID, from garmin_search_activities.");

export function registerActivityTools({ server, garmin, today }: ToolContext) {
  server.registerTool(
    "garmin_search_activities",
    {
      title: "Search activities",
      description:
        "Search the user's recorded activities (runs, rides, swims, strength, hikes…) with filters, newest first by default. For totals (\"km run per month\", \"hours of cycling this year\"), set groupBy: the server pages through every match (up to 1000) and returns, per period and sport (running merges street, trail and treadmill running, and so on; activityTypes lists what was merged) plus an `all` row per period: count, distanceKm, durationHours (timer time: use it for \"hours trained\"), movingHours (excludes standing still, so much lower for strength), ascent, calories, training load and average HR. Sport 'other' holds Track Me recordings and activities without a sport, which are often travel rather than training. Otherwise each result is a compact summary: type, start time, distance (m), duration (s), speed (m/s), heart rate, power, elevation (m), calories, training load and effect, and time in HR zones 1-5 (s). detail=full returns Garmin's complete records (~3 KB each). Activities recorded with Track Me or without a sport usually have type 'other'. Use the activityId with garmin_get_activity or garmin_get_activity_fit for details.",
      inputSchema: z.object({
        startDate: date("Earliest local start date, inclusive").optional(),
        endDate: date("Latest local start date, inclusive").optional(),
        activityType: z
          .string()
          .optional()
          .describe(
            "Parent activity type key, such as running, cycling, swimming, walking, hiking, fitness_equipment. A parent includes its subtypes (running also returns street_running, trail_running, treadmill_running).",
          ),
        activitySubType: z
          .string()
          .optional()
          .describe("Subtype key within activityType, such as trail_running, treadmill_running, road_biking, lap_swimming."),
        excludedActivitySubTypes: z.array(z.string()).optional().describe("Subtype keys to exclude."),
        eventType: z
          .enum(["race", "training", "recreation", "fitness", "specialEvent", "uncategorized"])
          .optional()
          .describe("Event classification."),
        search: z.string().optional().describe("Text to find in activity names and descriptions."),
        favoritesOnly: z.boolean().optional().describe("true: only favorites; false: only non-favorites."),
        minDistanceMeters: z.number().int().nonnegative().optional(),
        maxDistanceMeters: z.number().int().nonnegative().optional(),
        minDurationSeconds: z.number().int().nonnegative().optional().describe("Timer duration, excluding pauses."),
        maxDurationSeconds: z.number().int().nonnegative().optional().describe("Timer duration, excluding pauses."),
        minElapsedSeconds: z.number().int().nonnegative().optional().describe("Elapsed duration, including pauses."),
        maxElapsedSeconds: z.number().int().nonnegative().optional().describe("Elapsed duration, including pauses."),
        minElevationGainMeters: z.number().int().nonnegative().optional(),
        maxElevationGainMeters: z.number().int().nonnegative().optional(),
        minAvgPowerWatts: z.number().int().nonnegative().optional(),
        boundingBox: z
          .object({
            north: z.number().min(-90).max(90),
            south: z.number().min(-90).max(90),
            east: z.number().min(-180).max(180),
            west: z.number().min(-180).max(180),
          })
          .optional()
          .describe("Only activities that start inside this box, in decimal degrees."),
        dive: z
          .object({
            minMaxDepthCm: z.number().int().nonnegative().optional(),
            maxMaxDepthCm: z.number().int().nonnegative().optional(),
            minBottomTimeSeconds: z.number().int().nonnegative().optional(),
            maxBottomTimeSeconds: z.number().int().nonnegative().optional(),
            decompression: z.boolean().optional(),
          })
          .optional()
          .describe("Filters for dive activities."),
        requiredFields: z
          .array(z.string())
          .optional()
          .describe("Activity fields that must be present, e.g. ['avgPower'] for rides with a power meter."),
        includeChildren: z
          .boolean()
          .default(false)
          .describe("Include the individual legs of multisport activities as separate results."),
        sortBy: z.string().optional().describe("Field to sort by, such as distance or duration. Default: start time."),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        start: z.number().int().nonnegative().default(0).describe("Zero-based offset for pagination."),
        limit: z.number().int().min(1).max(100).default(20).describe("Results per page (1-100)."),
        detail: z
          .enum(["summary", "full"])
          .default("summary")
          .describe("summary: compact rows (100 fit in one call). full: Garmin's complete records, for at most ~30 activities."),
        groupBy: z
          .enum(["week", "month", "total"])
          .optional()
          .describe("Return totals per ISO week, calendar month or for the whole range instead of activities; start, limit and detail are ignored."),
      }),
      annotations: { title: "Search activities", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const search = (start: number, limit: number) =>
          garmin.getJson<Activity[]>("/activitylist-service/activities/search/activities", {
            start,
            limit,
            startDate: input.startDate,
            endDate: input.endDate,
            activityType: input.activityType,
            activitySubType: input.activitySubType,
            excludedActivitySubType: input.excludedActivitySubTypes,
            eventType: input.eventType,
            search: input.search,
            favorite: input.favoritesOnly === undefined ? undefined : input.favoritesOnly ? 1 : 0,
            minDistance: input.minDistanceMeters,
            maxDistance: input.maxDistanceMeters,
            minDuration: input.minDurationSeconds,
            maxDuration: input.maxDurationSeconds,
            minElapsedDuration: input.minElapsedSeconds,
            maxElapsedDuration: input.maxElapsedSeconds,
            minElevation: input.minElevationGainMeters,
            maxElevation: input.maxElevationGainMeters,
            minAvgPower: input.minAvgPowerWatts,
            upperLatitude: input.boundingBox?.north,
            lowerLatitude: input.boundingBox?.south,
            rightLongitude: input.boundingBox?.east,
            leftLongitude: input.boundingBox?.west,
            lowerMaxDepth: input.dive?.minMaxDepthCm,
            upperMaxDepth: input.dive?.maxMaxDepthCm,
            minBottomTime: input.dive?.minBottomTimeSeconds,
            maxBottomTime: input.dive?.maxBottomTimeSeconds,
            decoDive: input.dive?.decompression,
            requiredField: input.requiredFields,
            excludeChildren: !input.includeChildren,
            sortBy: input.sortBy,
            sortOrder: input.sortOrder,
          });

        if (input.groupBy) {
          const all: Activity[] = [];
          for (let start = 0; start < MAX_GROUPED_ACTIVITIES; start += PAGE_SIZE) {
            const page = (await search(start, PAGE_SIZE)) ?? [];
            all.push(...page);
            if (page.length < PAGE_SIZE) break;
          }
          const totals = activityTotals(all.map(summarizeActivity), input.groupBy);
          const grand = activityTotals(all.map(summarizeActivity), "total").find((row) => row.sport === "all");
          const capped = all.length >= MAX_GROUPED_ACTIVITIES;
          const note =
            `${all.length} activities in total: ${grand?.distanceKm ?? 0} km, ${grand?.durationHours ?? 0} h.` +
            " Periods without activities are not listed." +
            (capped ? ` Capped at ${MAX_GROUPED_ACTIVITIES} activities: narrow the date range for complete totals.` : "");
          return jsonResult(totals, { note });
        }

        const rows = (await search(input.start, input.limit)) ?? [];
        const note =
          rows.length === input.limit
            ? `${rows.length} activities (page full; more may exist: call again with start=${input.start + input.limit}).`
            : `${rows.length} activit${rows.length === 1 ? "y" : "ies"}; no more results.`;
        return input.detail === "full"
          ? jsonResult(rows, { note, omit: ACTIVITY_NOISE })
          : jsonResult(rows.map(summarizeActivity), { note });
      }),
  );

  server.registerTool(
    "garmin_get_activity",
    {
      title: "Get activity details",
      description:
        "Full summary of one activity: metadata, measurements (training effect, load, power, dynamics, temperature…) and split summaries (intervals, run/walk, climbs).",
      inputSchema: z.object({ activityId }),
      annotations: { title: "Get activity details", ...READ_ONLY },
    },
    ({ activityId }) =>
      safely(async () => jsonResult(await garmin.getJson(`/activity-service/activity/${activityId}`))),
  );

  server.registerTool(
    "garmin_get_activity_workouts",
    {
      title: "Get activity workouts",
      description:
        "Structured workouts (planned steps and targets) that were performed during an activity. Empty when the activity was not a structured workout.",
      inputSchema: z.object({ activityId }),
      annotations: { title: "Get activity workouts", ...READ_ONLY },
    },
    ({ activityId }) =>
      safely(async () => jsonResult(await garmin.getJson(`/activity-service/activity/${activityId}/workouts`))),
  );

  server.registerTool(
    "garmin_get_activity_fit",
    {
      title: "Decode activity file",
      description:
        "Download an activity's original FIT file and decode it: sessions, laps, distanceSplits (per-km splits with pace, average HR and ascent, computed from every record; time while the watch was paused is excluded, walk breaks are not; the last split may be shorter), Garmin's own splits (run/walk, intervals), time in zones (seconds per zone, from zone 0 below zone 1; hrZoneHighBoundary gives the bpm limits used), devices and events. Coordinates are in degrees. FIT cadence is per leg: double it for running steps per minute. Set includeRecords for the timeline as a table (elapsedSeconds, distance m, speed m/s, heartRate, cadence, power, altitude m, lat/lon, temperature), evenly downsampled to maxRecords rows.",
      inputSchema: z.object({
        activityId,
        includeRecords: z.boolean().default(false).describe("Include the record timeline as a table."),
        maxRecords: z
          .number()
          .int()
          .min(10)
          .max(1000)
          .default(200)
          .describe("Maximum timeline rows when includeRecords is set; the timeline is evenly downsampled."),
        splitDistanceMeters: z
          .number()
          .int()
          .min(100)
          .max(50_000)
          .default(1000)
          .describe("Length of distanceSplits: 1000 for kilometres, 1609 for miles."),
      }),
      annotations: { title: "Decode activity file", ...READ_ONLY },
    },
    ({ activityId, includeRecords, maxRecords, splitDistanceMeters }) =>
      safely(async () => {
        const archive = await garmin.getBytes(`/download-service/files/activity/${activityId}`);
        const files = unzipActivity(archive).filter(({ name }) => /\.fit$/i.test(name));
        if (files.length === 0) {
          return error("The activity file has no FIT data (it may have been imported as GPX or TCX).");
        }
        const decoded = files.map(({ name, data }) =>
          decodeFit(name, data, { includeRecords, maxRecords, splitDistance: splitDistanceMeters }),
        );
        return jsonResult(decoded.length === 1 ? decoded[0] : decoded);
      }),
  );

  server.registerTool(
    "garmin_get_wellness_activities",
    {
      title: "Get wellness activities",
      description:
        "Wellness activity summaries for a date range (sessions Garmin records as wellness activities rather than workouts), with summary values, time in zones and device metadata.",
      inputSchema: z.object(dateRange),
      annotations: { title: "Get wellness activities", ...READ_ONLY },
    },
    (input) =>
      safely(async () => {
        const range = resolveRange(today, input, { defaultDays: 30 });
        if ("error" in range) return error(range.error);
        // The per-request limit is undocumented; 31 days matches Garmin's other range endpoints.
        const items = await fetchInWindows(range.start, range.end, 31, (from, to) =>
          garmin.getJson<unknown[]>(`/wellnessactivity-service/activity/summary/range/${from}/${to}`),
        );
        return jsonResult(items);
      }),
  );
}
