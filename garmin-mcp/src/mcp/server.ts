import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GarminClient } from "../garmin/client";
import { today } from "../garmin/dates";
import type { ToolContext } from "./context";
import { registerActivityTools } from "./tools/activities";
import { registerBodyTools } from "./tools/body";
import { registerDailyTools } from "./tools/daily";
import { registerProfileTools } from "./tools/profile";
import { registerSleepTools } from "./tools/sleep";

export const SERVER_INFO = { name: "garmin-mcp", title: "Garmin Connect", version: "0.1.0" } as const;

function instructions(date: string, timeZone: string): string {
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `Read-only access to the user's own Garmin Connect data through Garmin's official Personal API.

Today is ${weekday} ${date} (${timeZone}); today's data is partial until the day ends and the watch syncs. Dates are YYYY-MM-DD in the user's local calendar; when omitted, tools use today. Sleep and overnight HRV belong to the wake-up date, so Friday night's sleep is Saturday's record. "This week" is ambiguous: say which days you used.

Choosing tools:
- One day at a glance: garmin_get_daily_summary, then garmin_get_sleep and garmin_get_hrv for recovery.
- Trends: garmin_get_daily_summaries, garmin_get_sleep_history, garmin_get_hrv_history, garmin_get_steps, garmin_get_stress, garmin_get_body_battery. Long ranges are split into the windows Garmin allows automatically. For months or a year, use period=week or period=month on the daily and sleep summaries and on garmin_get_weigh_ins, and groupBy on garmin_search_activities for distance or time totals; don't add up rows yourself.
- Training: garmin_search_activities to find activities, garmin_get_activity for the summary and splits, garmin_get_activity_fit for laps and the second-by-second timeline.

Units are metric unless noted: distance in metres, duration in seconds, speed in m/s, weight in kilograms. Timestamps are ISO 8601: fields ending in GMT are UTC; fields ending in Local are wall-clock time in the watch's time zone at that moment, which changes when the user travels. Bulky sample arrays are left out unless a tool's includeSamples/includeReadings/includeRecords option is set. The Personal API is read-only and has no training readiness, VO2 max, race predictions, devices, gear, courses or workout uploads; say so rather than estimating them. Fitness age (garmin_get_fitness_age) is the closest fitness indicator available.`;
}

/** Build a fresh server per request (the handler is stateless). */
export function createServer(env: Env): McpServer {
  const timeZone = env.TIMEZONE || "UTC";
  const ctx: ToolContext = {
    server: new McpServer(SERVER_INFO, { instructions: instructions(today(timeZone), timeZone) }),
    garmin: new GarminClient({ apiKey: env.GARMIN_API_KEY, region: env.GARMIN_REGION, kv: env.OAUTH_KV }),
    today: today(timeZone),
  };

  registerDailyTools(ctx);
  registerSleepTools(ctx);
  registerActivityTools(ctx);
  registerBodyTools(ctx);
  registerProfileTools(ctx);
  registerPrompts(ctx.server);
  return ctx.server;
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "readiness_check",
    {
      title: "Readiness check",
      description: "How recovered am I today, and what kind of training fits?",
      argsSchema: z.object({ date: z.string().optional().describe("Day to assess (YYYY-MM-DD). Defaults to today.") }),
    },
    ({ date }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Assess my readiness to train ${date ? `on ${date}` : "today"}. Use last night's sleep, overnight HRV against my baseline, Body Battery, resting heart rate and stress, compare them with my last 2 weeks, and look at my training load over the last 7 days. Then recommend the kind and intensity of session that fits, and say which signal drives the recommendation.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "training_review",
    {
      title: "Training review",
      description: "Review my recent training: volume, intensity, recovery and trends.",
      argsSchema: z.object({ weeks: z.string().optional().describe("How many weeks to review. Defaults to 4.") }),
    },
    ({ weeks }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review my last ${weeks || "4"} weeks of training. Summarise weekly volume per sport (distance, time, sessions), intensity (heart rate, training effect, load), long sessions and key workouts, and how sleep and HRV evolved alongside. Point out risky ramps, missing recovery and what is going well.`,
          },
        },
      ],
    }),
  );
}
