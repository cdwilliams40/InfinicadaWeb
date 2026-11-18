/**
 * Client for the Garmin Connect Personal API.
 *
 * Auth flow (https://developer.garmin.com/gc-developer-program/personal/personal-api):
 * the Personal API key is exchanged for a 24-hour bearer token. There are no
 * refresh tokens, so an expired or revoked token is replaced by exchanging the
 * key again. Tokens are cached per isolate and in KV, bound to a hash of the key
 * so rotating the key invalidates the cache.
 */

const BASE_URLS = {
  global: "https://personal.connectapi.garmin.com",
  cn: "https://personal.connectapi.garmin.cn",
} as const;

const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const REQUEST_TIMEOUT_MS = 20_000;
/** Treat a token as expired this long before its `exp`, so it never dies mid-request. */
const TOKEN_EXPIRY_MARGIN_S = 10 * 60;

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Record<string, QueryValue>;

export interface GarminConfig {
  apiKey: string;
  region: string;
  kv: KVNamespace;
  fetch?: typeof fetch;
}

/** An error worth showing to the model: what failed and what to do about it. */
export class GarminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GarminApiError";
  }
}

interface CachedToken {
  accessToken: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

const memoryTokens = new Map<string, CachedToken>();

export class GarminClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #kv: KVNamespace;
  readonly #fetch: typeof fetch;

  constructor(config: GarminConfig) {
    if (!config.apiKey) {
      throw new GarminApiError(
        "GARMIN_API_KEY is not configured. Create a key at https://connect.garmin.com/app/settings/personalApiToken and set it as a Worker secret.",
        500,
      );
    }
    this.baseUrl = config.region === "cn" ? BASE_URLS.cn : BASE_URLS.global;
    this.#apiKey = config.apiKey;
    this.#kv = config.kv;
    this.#fetch = config.fetch ?? fetch.bind(globalThis);
  }

  /** GET a JSON endpoint. Returns `null` when Garmin answers 204 (no data). */
  async getJson<T = unknown>(path: string, query?: Query): Promise<T | null> {
    const response = await this.#get(path, query, "application/json");
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  /** GET a binary endpoint, such as an activity file download. */
  async getBytes(path: string, query?: Query): Promise<Uint8Array> {
    const response = await this.#get(path, query, "*/*");
    return new Uint8Array(await response.arrayBuffer());
  }

  async #get(path: string, query: Query | undefined, accept: string): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
      else url.searchParams.set(key, String(value));
    }

    let token = await this.#token();
    let response = await this.#send(url, token, accept);
    // A token can be revoked before it expires; exchange the key once more and retry.
    if (response.status === 401) {
      token = await this.#token({ forceRefresh: true });
      response = await this.#send(url, token, accept);
    }
    if (!response.ok) throw await toApiError(response, path);
    return response;
  }

  async #send(url: URL, token: string, accept: string): Promise<Response> {
    try {
      return await this.#fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(error);
    }
  }

  async #token({ forceRefresh = false } = {}): Promise<string> {
    const cacheKey = `garmin:token:${await sha256(`${this.baseUrl}|${this.#apiKey}`)}`;
    const now = Date.now() / 1000;
    const isFresh = (token: CachedToken | null | undefined): token is CachedToken =>
      !!token && token.expiresAt - TOKEN_EXPIRY_MARGIN_S > now;

    if (!forceRefresh) {
      const inMemory = memoryTokens.get(cacheKey);
      if (isFresh(inMemory)) return inMemory.accessToken;
      const stored = await this.#kv.get<CachedToken>(cacheKey, "json");
      if (isFresh(stored)) {
        memoryTokens.set(cacheKey, stored);
        return stored.accessToken;
      }
    }

    const token = await this.#exchangeKey();
    memoryTokens.set(cacheKey, token);
    const ttl = Math.floor(token.expiresAt - TOKEN_EXPIRY_MARGIN_S - now);
    // KV requires a TTL of at least 60 seconds.
    if (ttl >= 60) await this.#kv.put(cacheKey, JSON.stringify(token), { expirationTtl: ttl });
    return token.accessToken;
  }

  async #exchangeKey(): Promise<CachedToken> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(TOKEN_PATH, this.baseUrl), {
        method: "POST",
        // The endpoint answers with the raw token and rejects `Accept: application/json` (406).
        headers: { Authorization: `ApiKey ${this.#apiKey}`, Accept: "*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(error);
    }

    if (response.status === 401 || response.status === 403) {
      throw new GarminApiError(
        "Garmin rejected the Personal API key: it may have expired or been deleted. Create a new key at https://connect.garmin.com/app/settings/personalApiToken and update the GARMIN_API_KEY secret.",
        response.status,
      );
    }
    if (!response.ok) throw await toApiError(response, TOKEN_PATH);

    const accessToken = parseAccessToken(await response.text());
    return { accessToken, expiresAt: jwtExpiry(accessToken) ?? Date.now() / 1000 + 3600 };
  }
}

/** The token endpoint may answer with a raw token or a JSON object holding it. */
function parseAccessToken(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const token = json.access_token ?? json.accessToken ?? json.token;
    if (typeof token === "string" && token) return token;
    throw new GarminApiError("Garmin's token endpoint returned an unexpected response.", 502);
  }
  if (!trimmed) throw new GarminApiError("Garmin's token endpoint returned an empty response.", 502);
  return trimmed.replace(/^"|"$/g, "");
}

function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp : undefined;
  } catch {
    return undefined;
  }
}

async function toApiError(response: Response, path: string): Promise<GarminApiError> {
  const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
  const suffix = detail ? ` Garmin said: ${detail}` : "";
  const status = response.status;
  const messages: Record<number, string> = {
    400: "Garmin rejected the request parameters. Check the date format (YYYY-MM-DD), that the range is within the endpoint's limit, and that IDs and filter keys are valid.",
    401: "Garmin rejected the access token even after renewing it. The Personal API key may have been deleted.",
    403: "This Garmin account is not allowed to access this resource.",
    404: "Garmin found nothing at this address. Check that the ID exists and belongs to this account.",
    429: "Garmin is rate limiting requests. Wait a minute and retry, or request a smaller date range.",
  };
  const message =
    messages[status] ??
    (status >= 500
      ? `Garmin had a server error (HTTP ${status}). Retry later.`
      : `Garmin returned HTTP ${status} for ${path}.`);
  return new GarminApiError(`${message}${suffix}`, status);
}

function networkError(error: unknown): GarminApiError {
  const timedOut = error instanceof DOMException && error.name === "TimeoutError";
  return new GarminApiError(
    timedOut
      ? `Garmin did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Retry, or request a smaller date range.`
      : "Could not reach Garmin's Personal API. Retry later.",
    504,
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
