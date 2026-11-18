import { describe, expect, it } from "vitest";
import { addDays, dateWindows, daysBetween, isValidDate, today } from "../src/garmin/dates";
import { downsample } from "../src/garmin/fit";
import { MAX_RESULT_CHARS, jsonResult } from "../src/mcp/result";
import { activityTotals, aggregate, sportOf, summarizeSleep } from "../src/mcp/summaries";

describe("dates", () => {
  it("resolves today in the configured time zone", () => {
    const lateEvening = new Date("2026-11-03T23:30:00Z");
    expect(today("Europe/Madrid", lateEvening)).toBe("2026-11-04");
    expect(today("America/New_York", lateEvening)).toBe("2026-11-03");
  });

  it("splits ranges into windows without gaps or overlaps", () => {
    expect(dateWindows("2026-01-01", "2026-02-15", 28)).toEqual([
      ["2026-01-01", "2026-01-28"],
      ["2026-01-29", "2026-02-15"],
    ]);
    expect(dateWindows("2026-03-01", "2026-03-01", 31)).toEqual([["2026-03-01", "2026-03-01"]]);
  });

  it("does date arithmetic across month and DST boundaries", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(3);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
  });
});

describe("jsonResult", () => {
  it("drops nulls and omitted keys", () => {
    const result = jsonResult({ a: 1, b: null, samples: [1, 2], nested: { c: null, d: 2 } }, { omit: ["samples"] });
    expect(result.content.at(-1)).toEqual({ type: "text", text: '{"a":1,"nested":{"d":2}}' });
  });

  it("turns epoch timestamps into ISO strings and trims float noise", () => {
    const result = jsonResult({
      sleepStartTimestampGMT: 1767997800000,
      sleepStartTimestampLocal: 1768001400000,
      averageSpeed: 0.8330000162124634,
      steps: 12345,
    });
    expect(JSON.parse((result.content.at(-1) as { text: string }).text)).toEqual({
      sleepStartTimestampGMT: "2026-01-09T22:30:00.000Z",
      sleepStartTimestampLocal: "2026-01-09T23:30:00.000",
      averageSpeed: 0.833,
      steps: 12345,
    });
  });

  it("explains an empty answer instead of returning null", () => {
    expect(jsonResult(null).content[0]).toMatchObject({ text: expect.stringContaining("no data") });
  });

  it("truncates large arrays and says so", () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ index, padding: "x".repeat(100) }));
    const result = jsonResult(rows);
    const body = result.content.at(-1) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Truncated") });
  });

  it("rejects large objects with an actionable error", () => {
    const result = jsonResult({ blob: "x".repeat(MAX_RESULT_CHARS + 1) });
    expect(result.isError).toBe(true);
  });
});

describe("downsample", () => {
  it("keeps the first and last items", () => {
    const sample = downsample([...Array(1000).keys()], 5);
    expect(sample).toEqual([0, 250, 500, 749, 999]);
  });
});

describe("summaries", () => {
  it("flattens a night of sleep", () => {
    const row = summarizeSleep({
      calendarDate: "2026-01-10",
      sleepTimeSeconds: 27000,
      sleepScores: { overall: { value: 80, qualifierKey: "GOOD" } },
      sleepNeed: { actual: 480 },
    });
    expect(row).toMatchObject({ calendarDate: "2026-01-10", sleepScore: 80, sleepScoreQualifier: "GOOD", sleepNeedMinutes: 480 });
  });

  it("averages per ISO week, skipping timestamps and missing values", () => {
    const rows = [
      { calendarDate: "2026-11-01", restingHeartRate: 50, sleepStartLocal: 1768001400000 }, // Sunday
      { calendarDate: "2026-11-02", restingHeartRate: 52, sleepStartLocal: 1768001400000 }, // Monday
      { calendarDate: "2026-11-03", restingHeartRate: 54 },
      { calendarDate: "2026-11-04" },
    ];
    expect(aggregate(rows, "week")).toEqual([
      { weekStarting: "2026-10-26", days: 1, restingHeartRate: 50 },
      { weekStarting: "2026-11-02", days: 3, restingHeartRate: 53 },
    ]);
    expect(aggregate(rows, "month")).toEqual([{ month: "2026-11", days: 4, restingHeartRate: 52 }]);
  });
});

describe("activityTotals", () => {
  const activities = [
    { startTimeLocal: "2026-02-03 08:00:00", activityType: "street_running", distance: 10_000, duration: 3000, averageHR: 150 },
    { startTimeLocal: "2026-02-10 08:00:00", activityType: "trail_running", distance: 5000, duration: 3000, averageHR: 140 },
    { startTimeLocal: "2026-02-12 08:00:00", activityType: "strength_training", duration: 1800, movingDuration: 300 },
    { startTimeLocal: "2026-03-01 08:00:00", activityType: "running", distance: 8000, duration: 2400 },
  ];

  it("merges subtypes into sports and adds an all row per period", () => {
    expect(activityTotals(activities, "month")).toEqual([
      expect.objectContaining({ month: "2026-02", sport: "running", activityTypes: ["street_running", "trail_running"], count: 2, distanceKm: 15, durationHours: 1.67, avgHeartRate: 145 }),
      expect.objectContaining({ month: "2026-02", sport: "strength_training", count: 1, durationHours: 0.5, movingHours: 0.08 }),
      expect.objectContaining({ month: "2026-02", sport: "all", count: 3, distanceKm: 15 }),
      expect.objectContaining({ month: "2026-03", sport: "running", count: 1, distanceKm: 8 }),
      expect.objectContaining({ month: "2026-03", sport: "all", count: 1, distanceKm: 8 }),
    ]);
    expect(activityTotals(activities, "month")[3]).not.toHaveProperty("activityTypes");
  });

  it("labels weeks with their start and end", () => {
    expect(activityTotals(activities.slice(0, 1), "week")[0]).toMatchObject({ weekStarting: "2026-02-02", weekEnding: "2026-02-08" });
  });

  it("totals the whole range without a period key", () => {
    const rows = activityTotals(activities, "total");
    expect(rows.find((row) => row.sport === "all")).toMatchObject({ count: 4, distanceKm: 23 });
    expect(rows.every((row) => !("month" in row) && !("weekStarting" in row))).toBe(true);
  });

  it("maps activity types to sport families", () => {
    expect(["treadmill_running", "road_biking", "lap_swimming", "kayaking_v2", "other"].map(sportOf)).toEqual([
      "running",
      "cycling",
      "swimming",
      "kayaking",
      "other",
    ]);
  });
});
