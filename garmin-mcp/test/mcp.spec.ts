import { Encoder, Profile } from "@garmin/fitsdk";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import { handleAuthorize } from "../src/auth/authorize";
import { mockGarmin } from "./helpers";

const BASE = "https://garmin-mcp.example.com";
const REDIRECT = "https://client.example.com/callback";

/**
 * An execution context as Cloudflare passes it once Access has signed the
 * owner in (`access.dev` in wrangler.jsonc only applies to `wrangler dev`).
 */
function contextWithAccess(ctx: ExecutionContext): ExecutionContext {
  const access = { aud: env.ACCESS_AUD, getIdentity: async () => ({ email: "owner@example.com" }) };
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "access") return access;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  // Requests reaching a Worker carry incoming `cf` properties; these tests don't need any.
  const request = new Request(`${BASE}${path}`, init) as Request<unknown, IncomingRequestCfProperties>;
  const response = await worker.fetch(request, env, contextWithAccess(ctx));
  await waitOnExecutionContext(ctx);
  return response;
}
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Run the whole OAuth flow (DCR, consent, PKCE token exchange) and return an access token. */
async function authorize(): Promise<string | Response> {
  const client = await (
    await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    })
  ).json<{ client_id: string }>();

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    scope: "garmin:read",
    resource: `${BASE}/mcp`,
  });

  const consent = await call(`/authorize?${query}`);
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const cookie = consent.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  const approval = await call(`/authorize?${query}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  if (approval.status !== 302) return approval;

  const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
  const token = await (
    await call("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    })
  ).json<{ access_token: string }>();
  return token.access_token;
}

let accessToken: string;
let rpcId = 0;

async function rpc<T = any>(method: string, params: object = {}): Promise<T> {
  const response = await call("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await response.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result as T;
}

const callTool = (name: string, args: object = {}) =>
  rpc<{ content: Array<{ text: string }>; isError?: boolean }>("tools/call", { name, arguments: args });

describe("OAuth", () => {
  it("challenges unauthenticated MCP requests", async () => {
    const response = await call("/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("serves the consent page only to requests that passed this Access application", async () => {
    const request = new Request(`${BASE}/authorize?client_id=x`);
    const withAccess = (aud: string) =>
      ({ access: { aud, getIdentity: async () => ({ email: "owner@example.com" }) } }) as unknown as ExecutionContext;

    expect((await handleAuthorize(request, env, {} as ExecutionContext)).status).toBe(403);
    expect((await handleAuthorize(request, env, withAccess("another-app"))).status).toBe(403);
    expect((await handleAuthorize(request, { ...env, ACCESS_AUD: "" }, withAccess(""))).status).toBe(403);
  });
});

describe("MCP server", () => {
  let garmin: ReturnType<typeof mockGarmin> | undefined;

  beforeAll(async () => {
    const token = await authorize();
    if (typeof token !== "string") throw new Error(`authorization failed: ${token.status}`);
    accessToken = token;
    await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  });

  afterEach(() => garmin?.restore());

  it("exposes one read-only tool per Personal API endpoint", async () => {
    const { tools } = await rpc<{ tools: Array<{ name: string; annotations: Record<string, boolean> }> }>("tools/list");
    expect(tools).toHaveLength(26);
    expect(tools.every((tool) => tool.name.startsWith("garmin_") && tool.annotations.readOnlyHint)).toBe(true);
  });

  it("splits long ranges into Garmin's per-request windows", async () => {
    garmin = mockGarmin((url) => {
      const [, , , , , from] = url.pathname.split("/");
      return Response.json([{ calendarDate: from, totalSteps: 1000, stepGoal: null }]);
    });
    const result = await callTool("garmin_get_steps", { startDate: "2026-01-01", endDate: "2026-02-15" });

    const stepCalls = garmin.calls.filter((url) => url.pathname.includes("/stats/steps/"));
    expect(stepCalls.map((url) => url.pathname)).toEqual([
      "/usersummary-service/stats/steps/daily/2026-01-01/2026-01-28",
      "/usersummary-service/stats/steps/daily/2026-01-29/2026-02-15",
    ]);
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual([
      { calendarDate: "2026-01-01", totalSteps: 1000 },
      { calendarDate: "2026-01-29", totalSteps: 1000 },
    ]);
  });

  it("leaves sample arrays out unless asked", async () => {
    garmin = mockGarmin(() => Response.json({ restingHeartRate: 48, heartRateValues: [[0, 50]] }));
    const lean = await callTool("garmin_get_heart_rate", { date: "2026-11-01" });
    expect(JSON.parse(lean.content.at(-1)!.text)).toEqual({ restingHeartRate: 48 });

    const full = await callTool("garmin_get_heart_rate", { date: "2026-11-01", includeSamples: true });
    expect(JSON.parse(full.content.at(-1)!.text)).toHaveProperty("heartRateValues");
  });

  it("maps search filters to Garmin's query parameters", async () => {
    garmin = mockGarmin(() => Response.json([{ activityId: 1, ownerFullName: "Me", distance: 5000 }]));
    const result = await callTool("garmin_search_activities", {
      activityType: "running",
      favoritesOnly: true,
      boundingBox: { north: 43, south: 42, east: -8, west: -9 },
      limit: 1,
    });

    const url = garmin.calls.find((call) => call.pathname.includes("/activities/search/"))!;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      activityType: "running",
      favorite: "1",
      upperLatitude: "43",
      leftLongitude: "-9",
      excludeChildren: "true",
      limit: "1",
    });
    expect(result.content[0]!.text).toContain("start=1");
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual([{ activityId: 1, distance: 5000 }]);
  });

  it("reports weights in kilograms although Garmin sends grams", async () => {
    garmin = mockGarmin(() =>
      Response.json([{ calendarDate: "2026-01-15", weight: 70500, muscleMass: 55000, bodyFat: 21, metabolicAge: 1199163188000 }]),
    );
    const result = await callTool("garmin_get_weigh_ins", { startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual([
      { calendarDate: "2026-01-15", weight: 70.5, muscleMass: 55, bodyFat: 21 },
    ]);
  });

  it("pages through every match to total activities", async () => {
    // 150 runs of 5 km in January: two pages of up to 100.
    garmin = mockGarmin((url) => {
      const start = Number(url.searchParams.get("start"));
      const count = Math.max(0, Math.min(100, 150 - start));
      return Response.json(
        Array.from({ length: count }, (_, index) => ({
          activityId: start + index,
          startTimeLocal: "2026-01-15 08:00:00",
          activityType: { typeKey: "running" },
          distance: 5000,
          duration: 1500,
        })),
      );
    });
    const result = await callTool("garmin_search_activities", { startDate: "2026-01-01", groupBy: "month" });
    expect(garmin.calls.filter((url) => url.pathname.includes("/search/")).map((url) => url.searchParams.get("start"))).toEqual(["0", "100"]);
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual([
      expect.objectContaining({ month: "2026-01", sport: "running", count: 150, distanceKm: 750 }),
      expect.objectContaining({ month: "2026-01", sport: "all", count: 150 }),
    ]);
    expect(result.content[0]!.text).toContain("150 activities in total: 750 km");
  });

  it("averages weigh-ins per month with min and max", async () => {
    garmin = mockGarmin(() =>
      Response.json([
        { calendarDate: "2026-02-20", weight: 75000, samplePk: 2 },
        { calendarDate: "2026-02-01", weight: 77000, samplePk: 1 },
      ]),
    );
    const result = await callTool("garmin_get_weigh_ins", { startDate: "2026-02-01", endDate: "2026-02-28", period: "month" });
    expect(JSON.parse(result.content.at(-1)!.text)).toEqual([
      { month: "2026-02", weighIns: 2, weight: 76, weightMin: 75, weightMax: 77 },
    ]);
  });

  it("labels Body Battery levels with local times", async () => {
    garmin = mockGarmin(() =>
      Response.json([
        {
          date: "2026-01-15",
          startTimestampGMT: "2026-01-14T23:00:00.0",
          startTimestampLocal: "2026-01-15T00:00:00.0",
          endTimestampGMT: "2026-01-15T23:00:00.0",
          bodyBatteryValuesArray: [[1768452660000, 50], [1768457340000, null]],
          bodyBatteryValueDescriptorDTOList: [{ bodyBatteryValueDescriptorKey: "timestamp" }],
        },
      ]),
    );
    const result = await callTool("garmin_get_body_battery", { startDate: "2026-01-15", endDate: "2026-01-15", chunks: 24 });
    const [report] = JSON.parse(result.content.at(-1)!.text);
    expect(report.intervals).toEqual([{ start: "2026-01-15T05:00", end: "2026-01-15T06:00", min: 50, max: 50 }]);
    expect(report).not.toHaveProperty("bodyBatteryValuesArray");
  });

  it("returns Garmin errors as tool errors", async () => {
    garmin = mockGarmin(() => new Response(null, { status: 404 }));
    const result = await callTool("garmin_get_activity", { activityId: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/nothing at this address/);
  });

  it("rejects ranges that run backwards", async () => {
    const result = await callTool("garmin_get_sleep_history", { startDate: "2026-02-01", endDate: "2026-01-01" });
    expect(result.isError).toBe(true);
  });
});

describe("activity files", () => {
  let garmin: ReturnType<typeof mockGarmin> | undefined;
  afterEach(() => garmin?.restore());

  /** A small FIT activity: 600 one-second records at a fixed test location, one lap, one session. */
  function fitActivity(): Uint8Array {
    const start = new Date("2026-11-01T08:00:00Z");
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    const semicircles = (degrees: number) => Math.round(degrees * (2 ** 31 / 180));
    const mesgNum = Profile.MesgNum as Record<"FILE_ID" | "RECORD" | "LAP" | "SESSION" | "ACTIVITY", number>;
    const encoder = new Encoder();
    // Generic so each message literal keeps its own fields; onMesg() is typed with the base Mesg.
    const write = <T extends object>(num: number, mesg: T) => encoder.onMesg(num, mesg);
    write(mesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: start });
    for (let second = 0; second < 600; second++) {
      write(mesgNum.RECORD, {
        timestamp: at(second),
        heartRate: 140,
        distance: second * 3,
        positionLat: semicircles(48.8584),
        positionLong: semicircles(2.2945),
      });
    }
    const totals = { startTime: start, totalElapsedTime: 600, totalTimerTime: 600, totalDistance: 1800 };
    write(mesgNum.LAP, { timestamp: at(600), ...totals });
    write(mesgNum.SESSION, { timestamp: at(600), sport: "running", avgHeartRate: 140, ...totals });
    write(mesgNum.ACTIVITY, { timestamp: at(600), numSessions: 1, totalTimerTime: 600 });
    return encoder.close();
  }

  it("unzips and decodes the FIT file, downsampling the timeline", async () => {
    const archive = zipSync({ "123_ACTIVITY.fit": fitActivity() });
    garmin = mockGarmin(() => new Response(archive, { headers: { "content-type": "application/x-zip-compressed" } }));

    const result = await callTool("garmin_get_activity_fit", { activityId: 123, includeRecords: true, maxRecords: 50 });
    const decoded = JSON.parse(result.content.at(-1)!.text);

    expect(decoded.fileName).toBe("123_ACTIVITY.fit");
    expect(decoded.sessions[0]).toMatchObject({ sport: "running", totalDistance: 1800, avgHeartRate: 140 });
    expect(decoded.laps).toHaveLength(1);
    expect(decoded.recordCount).toBe(600);
    // 3 m/s for 600 s: one full kilometre and an 800 m remainder, at 5:33/km.
    expect(decoded.distanceSplits).toEqual([
      { split: 1, distanceMeters: 1000, seconds: 333, pacePerKm: "5:33", avgHeartRate: 140 },
      { split: 2, distanceMeters: 797, seconds: 266, pacePerKm: "5:33", avgHeartRate: 140 },
    ]);
    const { columns, rows } = decoded.records;
    expect(columns).toEqual(["elapsedSeconds", "distance", "heartRate", "lat", "lon"]);
    expect(rows).toHaveLength(50);
    expect(rows.at(-1)[0]).toBe(599);
    expect(rows[0][columns.indexOf("lat")]).toBeCloseTo(48.8584, 4);
    expect(rows[0][columns.indexOf("lon")]).toBeCloseTo(2.2945, 4);
  });

  it("explains archives without FIT data", async () => {
    garmin = mockGarmin(() => new Response(zipSync({ "activity.gpx": new TextEncoder().encode("<gpx/>") })));
    const result = await callTool("garmin_get_activity_fit", { activityId: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no FIT data/);
  });
});
