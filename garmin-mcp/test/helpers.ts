import { vi } from "vitest";

export const GARMIN = "https://personal.connectapi.garmin.com";

/** An unsigned JWT that expires in `seconds`; the client only reads `exp`. */
export function fakeJwt(seconds = 86_400): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

/**
 * Route outbound requests to Garmin through `handler` and record them. Other
 * requests (the test's own calls into the Worker) pass through untouched.
 */
export function mockGarmin(handler: Route) {
  const calls: URL[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== GARMIN) return realFetch(input, init);
    calls.push(url);
    if (url.pathname.endsWith("/personal-api-key/token")) return new Response(fakeJwt());
    return (await handler(url, init)) ?? new Response("not mocked", { status: 500 });
  });
  return { calls, restore: () => spy.mockRestore() };
}
