# garmin-mcp

> **Vendored copy.** This folder is [barcia/garmin-mcp](https://github.com/barcia/garmin-mcp) (MIT) at commit `3dd9dd85a87ab9485f935c163f09ad7d2b2ae7e8`, changed only to deploy as its own Worker, `infinicadaweb-garmin-mcp`, with `TIMEZONE` set to `America/New_York`. It is a separate Worker from the static site at the repo root: the site's `.assetsignore` keeps this folder out of the site's assets, and the site's build never touches it. CI for it lives in `.github/workflows/garmin-mcp.yml`. Deploy it from this folder.

A remote MCP server that gives Claude (web, desktop, mobile and Claude Code), or any MCP client, read-only access to your Garmin Connect data. It uses Garmin's [official Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api): no Garmin password, no scraping. It runs on Cloudflare Workers with the [Agents SDK](https://developers.cloudflare.com/agents/) and is protected by OAuth 2.1.

Everyone deploys it to their own Cloudflare account with their own Garmin key: it is a single-user server (see [Deployment](#deployment)).

## Contents

- [How it works](#how-it-works)
- [Tools and prompts](#tools-and-prompts)
- [Repository layout](#repository-layout)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Tests, CI and evals](#tests-ci-and-evals)
- [Deployment](#deployment)
- [Connecting a client](#connecting-a-client)
- [Operations](#operations)
- [Security](#security)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## How it works

```
MCP client  ──OAuth 2.1──▶ garmin-mcp Worker ─┬─ /authorize       consent page, behind Cloudflare Access
(Claude, Cursor…)                              ├─ /token, /register, /.well-known/*   OAuth server (OAuthProvider)
                                               └─ /mcp            MCP server (Streamable HTTP, stateless)
                                                                   └─▶ personal.connectapi.garmin.com
```

1. **The client connects to `/mcp`.** Without a token it gets a `401` pointing to the OAuth metadata (`/.well-known/oauth-protected-resource/mcp`).
2. **The client registers itself**, through dynamic client registration (`/register`) or a Client ID Metadata Document, and opens `/authorize` in the browser.
3. **You sign in and approve.** [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) protects `/authorize`: it asks for a one-time code sent to your email before the page loads, and only your address is allowed. The consent page then shows which application is asking and where the token will be sent, and you click *Allow*. The server has exactly one user: you.
4. **The client gets its tokens:** a 1-hour access token and a refresh token. The refresh token lasts as long as you use the client at least once a month, for up to a year.
5. **The server calls Garmin.** On each tool call it exchanges your Personal API key for a 24-hour Garmin token, caches it in memory and in KV, and calls the API.

The Garmin key never leaves the Worker: MCP clients only receive OAuth tokens issued by this server.

On top of forwarding API calls, the server shapes the responses so a model reads them well:

- **Long ranges:** date ranges are split into the windows each endpoint allows (28 days for steps and stress, 31 for sleep or Body Battery, 1 year for daily summaries) and the results are merged.
- **Compact views:** activity search and the daily and sleep histories return one row of key metrics by default; `detail=full` returns Garmin's complete response.
- **Aggregation:**
  - Daily, sleep and weigh-in histories average by week or month (`period`).
  - Activity search totals by period and sport (`groupBy`), merging subtypes: street, trail and treadmill running all count as running.
- **Clean output:**
  - Nulls and social noise are dropped.
  - Epoch timestamps become ISO 8601 and decimals are rounded.
  - Sample arrays are left out unless requested (`includeSamples`), and each result is capped at about 100,000 characters.
- **Fixed units:** Garmin sends weight and body composition in grams although its reference says kilograms; the server returns kilograms.
- **Decoded FIT files:** `garmin_get_activity_fit` downloads the original ZIP and decodes it with Garmin's [official FIT SDK](https://github.com/garmin/fit-javascript-sdk). It returns sessions, laps, per-kilometre splits computed from every record, Garmin's own splits, time in zones and, on request, the timeline as a table.
- **Actionable errors:** Garmin failures (expired key, invalid range, 429…) reach the model as tool errors that say how to fix them.
- **"Today" in your time zone:** set by `TIMEZONE`. The server instructions include today's date and weekday.

## Tools and prompts

There is one tool per Personal API endpoint (26), with every documented parameter. All of them are read-only (`readOnlyHint`).

| Tool | Returns | Garmin endpoint |
|---|---|---|
| **Daily** | | |
| `garmin_get_daily_summary` | One whole day: steps, calories, floors, intensity minutes, heart rate, stress, Body Battery, SpO2, respiration, hydration | `usersummary/daily` |
| `garmin_get_daily_summaries` | A summary per day for a range, or weekly or monthly averages | `v2/dailysummaries` |
| `garmin_get_steps` | Steps, distance and goal per day | `stats/steps/daily` |
| `garmin_get_stress` | Daily stress (0-100) | `stats/stress/daily` |
| `garmin_get_hydration` | Logged water, goal and estimated sweat loss | `stats/hydration/daily` |
| `garmin_get_heart_rate` | One day's heart rate: resting, min/max, 7-day average and, optionally, the full timeline | `wellness/dailyHeartRate` |
| `garmin_get_spo2` | One day's pulse oximetry and hourly averages | `wellness/daily/spo2acclimation` |
| `garmin_get_body_battery` | Body Battery per day, with `chunks` for min and max per interval (e.g. hourly) | `wellness/bodyBattery/reports/daily` |
| **Sleep and HRV** | | |
| `garmin_get_sleep` | One night: stages, score, sleep need, heart rate, stress, SpO2 | `sleep/dailySleep` |
| `garmin_get_sleep_history` | The nights in a range, or weekly or monthly averages | `sleep/dailySleepSummariesByDate` |
| `garmin_get_hrv` | Overnight HRV: average, baseline and status | `hrv-service/hrv/{date}` |
| `garmin_get_hrv_history` | HRV per day for a range | `hrv-service/hrv/daily` |
| **Activities** | | |
| `garmin_search_activities` | Search with every Garmin filter; with `groupBy`, totals per week, month or range and sport | `activitylist-service/activities/search` |
| `garmin_get_activity` | Full summary of one activity and its splits | `activity-service/activity/{id}` |
| `garmin_get_activity_workouts` | Structured workout performed during the activity | `activity-service/activity/{id}/workouts` |
| `garmin_get_activity_fit` | The decoded FIT file: sessions, laps, per-km splits, zones and timeline | `download-service/files/activity/{id}` |
| `garmin_get_wellness_activities` | Wellness activities in a range | `wellnessactivity-service/activity/summary/range` |
| **Body** | | |
| `garmin_get_weight` | Weight summary per day, range average and neighbouring weigh-ins | `weight-service/weight/range` |
| `garmin_get_weigh_ins` | Every weigh-in with body composition, or weekly or monthly averages with min and max | `weight-service/weight/all` |
| `garmin_get_weight_goals` | Weight goals | `goal-service/goal/user/effective/weightgoal` |
| `garmin_get_fitness_age` | Fitness age and its components | `fitnessage-service/fitnessage/v2` |
| `garmin_get_heart_rate_zones` | Heart rate zones configured per sport | `biometric-service/heartRateZones/v2` |
| **Other** | | |
| `garmin_get_nutrition` | Logged meals, goals and totals | `nutrition-service/food/logs` |
| `garmin_get_menstrual_cycle` | Menstrual cycle summary | `periodichealth-service/menstrualcycle/summary` |
| `garmin_get_menstrual_cycle_day` | Menstrual cycle detail for one day | `periodichealth-service/menstrualcycle/dayview` |
| `garmin_get_profile_settings` | Units, time zone and profile preferences | `userprofile-service/userprofile/settings` |

Prompts (shortcuts that clients show as commands):

- `readiness_check`: how ready am I to train today? Combines sleep, HRV, Body Battery, resting heart rate, stress and recent load.
- `training_review`: a review of recent weeks of training (volume, intensity, recovery).

## Repository layout

```
src/
  index.ts              Entry point: OAuthProvider protects /mcp and serves /authorize
  env.d.ts              Types for the bindings OAuthProvider adds at runtime
  auth/authorize.ts     Consent page, served only to requests that passed Cloudflare Access
  garmin/
    client.ts           Personal API client: key exchange, token cache, errors
    dates.ts            Dates: "today" per time zone, range windows
    fit.ts              FIT unzipping and decoding, distance splits
  mcp/
    server.ts           MCP server: instructions, tool and prompt registration
    context.ts          Shared schemas (dates, ranges) and range splitting
    result.ts           Response formatting: cleanup, timestamps, size cap, errors
    summaries.ts        Compact views and aggregations (period, groupBy)
    tools/              Tools by area: daily, sleep, activities, body, profile
test/                   Vitest suite running inside workerd (Garmin mocked)
evals/                  Synthetic prompts and a runner to test with real Claude
.github/workflows/      CI: typecheck and tests on every push and PR
wrangler.jsonc          Worker configuration: bindings, variables, required secrets
worker-configuration.d.ts  Types generated with `pnpm cf-typegen`
```

## Configuration

### Secrets

They live in `.env` locally and as Worker secrets in production. They never go to git.

| Name | What it is | Where to get it |
|---|---|---|
| `GARMIN_API_KEY` | The Personal API key of your Garmin Connect account. The server exchanges it for 24-hour tokens. | In [Garmin Connect → Personal API](https://connect.garmin.com/app/settings/personalApiToken), signed in on the web: *Create Key*, accept the terms and pick an expiry (30, 90, 180 days or 1 year). It is shown **only once**. Only one key can be active: creating another requires deleting the current one. |
| `ACCESS_AUD` | Audience (AUD) tag of the Cloudflare Access application that protects `/authorize`. The Worker only serves the consent page to requests Access authenticated for this application, so nothing else can approve clients. It is not secret, but it is specific to your account. | Zero Trust → Access → Applications → your application → *Overview* (see [Cloudflare Access](#cloudflare-access)). Locally, keep `local-dev`. |

### Variables

Set in `wrangler.jsonc`, under `vars`. They are not secret.

| Name | Value | Purpose |
|---|---|---|
| `GARMIN_REGION` | `global` | `global` uses `personal.connectapi.garmin.com`; `cn` uses the Garmin Connect China endpoint. |
| `TIMEZONE` | `Europe/Madrid` | IANA time zone used to resolve "today" when a tool gets no date. |

### Bindings

| Binding | Type | Purpose |
|---|---|---|
| `OAUTH_KV` | KV namespace (`infinicadaweb-garmin-mcp-oauth-kv`) | OAuth state: registered clients, granted consents and tokens (stored only as hashes, with their data encrypted). It also caches the Garmin token so every Worker instance shares it. |

### Cloudflare Access

`/authorize` is protected by a self-hosted Access application, so only you can approve clients. It has no password to leak or brute-force: Access signs you in with a one-time code sent to your email.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks you to pick a team name.
2. Go to **Access → Applications → Add an application → Self-hosted**:
   - **Domain:** `infinicadaweb-garmin-mcp.<your-subdomain>.workers.dev`, path `authorize`. Only that path is protected; `/mcp`, `/token`, `/register` and the metadata must stay reachable for MCP clients.
   - **Login method:** *One-time PIN*, the only one enabled, with *instant auth* so you skip the provider screen.
   - **Policy:** *Allow*, include *Emails* → your email address.
   - **Session duration:** 24 hours is a good default.
3. Copy the application's **Application Audience (AUD) tag** and store it as `ACCESS_AUD`.

`wrangler dev` simulates Access with the `access.dev` block in `wrangler.jsonc`, so locally `ACCESS_AUD=local-dev` and no sign-in is needed.

### Environment files

| File | In git | Contents |
|---|---|---|
| `.env.example` | yes | Template with the keys documented and empty |
| `.env` | no | Your local secrets. `wrangler dev` loads them and a deploy can upload them (`--secrets-file .env`). |

## Local development

You need Node 26 (`fnm use` reads `.node-version`) and pnpm, at the version pinned by `packageManager`.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Fill in `GARMIN_API_KEY` in `.env` (`ACCESS_AUD` stays `local-dev`) and start the server. It runs at `http://localhost:8787/mcp`:

```bash
pnpm dev
```

To try it by hand you have two options:

- **MCP Inspector:** start it and connect to `http://localhost:8787/mcp`. It takes you to the consent page.

  ```bash
  pnpm dlx @modelcontextprotocol/inspector
  ```

- **Claude Code**, on the same machine:

  ```bash
  claude mcp add --transport http garmin-local http://localhost:8787/mcp
  ```

Locally, KV is simulated and stored in `.wrangler/state`, and Access is simulated by `access.dev` in `wrangler.jsonc`.

Scripts:

| Script | What it does |
|---|---|
| `pnpm dev` | Local server with hot reload |
| `pnpm check` | Typecheck and tests |
| `pnpm typecheck` | TypeScript for `src/` and `test/` |
| `pnpm test` | Vitest suite inside workerd |
| `pnpm run deploy` | Deploy to Cloudflare (plain `pnpm deploy` is a different pnpm command) |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `pnpm evals` | Run the synthetic prompts against a running server |

## Tests, CI and evals

- **Tests (`test/`)** run inside the Workers runtime with `@cloudflare/vitest-plugin`, mocking Garmin's responses. They cover:
  - the Garmin client: key exchange, token cache, retry on 401 and errors;
  - the full OAuth flow, and that the consent page refuses requests without this Access application's identity;
  - range splitting and search filters;
  - compact views, aggregations and the kilogram conversion;
  - a real FIT file generated with the SDK's encoder.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `pnpm typecheck` and `pnpm test` on every push to `main` and every pull request. It does not deploy.
- **Evals:** `evals/prompts.json` holds 25 realistic questions: sleep, recovery, trends, training, totals, and cases with no data or out of scope. They are in Spanish on purpose, plus one in English, to test a non-English user. `evals/run.mjs` runs them through Claude Code in headless mode against a running server, with no tools other than this MCP. It records which tools the model chose, errors, sizes and the answer. It needs the Claude CLI signed in. Results contain your data and go to `evals/results/`, which is git-ignored.

  ```bash
  pnpm evals --base http://localhost:8787 --model sonnet
  ```

## Deployment

### What gets deployed

| | |
|---|---|
| Worker | `garmin-mcp`, in your Cloudflare account |
| MCP URL | `https://infinicadaweb-garmin-mcp.<your-subdomain>.workers.dev/mcp` (the `workers.dev` subdomain of your account) |
| Root (`/`) | JSON with the name, version and MCP URL, handy as a health check |
| KV | `infinicadaweb-garmin-mcp-oauth-kv`, created by the first deploy and reused by later ones |
| Secrets | `GARMIN_API_KEY`, `ACCESS_AUD` (type `secret_text`) |
| Access | A self-hosted Access application on `/authorize` that only allows your email |
| Observability | Workers logs on (dashboard → Workers & Pages → garmin-mcp → Logs) |
| Preview URLs | Off: the production origin is the only OAuth issuer |
| How it's deployed | By hand from your machine with `pnpm run deploy`. CI only checks. |

### First deploy

1. Sign in to wrangler (if it hangs, see [Troubleshooting](#troubleshooting)):

   ```bash
   pnpm wrangler login
   ```

2. Create the [Cloudflare Access](#cloudflare-access) application for `/authorize` and put its AUD tag in `.env` as `ACCESS_AUD`, next to `GARMIN_API_KEY`. If you don't know your `workers.dev` subdomain yet, deploy first: until `ACCESS_AUD` matches, `/authorize` answers 403.
3. Deploy, uploading both secrets at the same time:

   ```bash
   pnpm wrangler deploy --secrets-file .env
   ```

4. Wrangler prints the Worker URL: add `/mcp` and [connect a client](#connecting-a-client).

### Deploying changes

Check and deploy. Secrets and KV are kept between deploys:

```bash
pnpm check && pnpm run deploy
```

## Connecting a client

- **Claude (web, desktop, mobile):** on [claude.ai](https://claude.ai), Settings → Connectors → Add custom connector, with the MCP URL. A connector added there is also available in the desktop and mobile apps.
- **Claude Code:**

  ```bash
  claude mcp add --transport http garmin https://infinicadaweb-garmin-mcp.<your-subdomain>.workers.dev/mcp
  ```

  Then authenticate it from `/mcp`.
- **Other clients (Cursor, VS Code…):** any MCP client with OAuth and Streamable HTTP transport. Add it with the same URL.

The client opens `/authorize` in your browser: sign in with the code Access emails you, check the application name and destination on the consent page, and click *Allow*. This flow has been tested end to end with Claude on the web.

## Operations

- **The Garmin key expires:** Garmin emails you a week before. Create a new key (deleting the old one) and update the secret. The cached Garmin token stops being used on its own, because the cache is tied to the key.

  ```bash
  pnpm wrangler secret put GARMIN_API_KEY
  ```

- **Change who can approve clients:** edit the policy of the Access application (Zero Trust → Access → Applications). Clients already connected keep working until their tokens expire.

- **Live logs:**

  ```bash
  pnpm wrangler tail garmin-mcp
  ```

- **Disconnect every client:** clear the `infinicadaweb-garmin-mcp-oauth-kv` namespace from the dashboard. Clients will have to authorize again.

## Security

- **Access to `/mcp`:** only with an OAuth token issued by this server for its own URL, with the `garmin:read` scope.
- **Consent page:**
  - It shows the application's name, whether it is verified and the host the token will be sent to, and warns when the destination is a local app.
  - The form carries a single-use handle bound to the browser and cannot be embedded in another site.
  - Only you reach it: Cloudflare Access signs you in with a one-time code to your email, and the Worker fails closed (403) unless the request carries this Access application's identity (`ctx.access`), so it can't be bypassed through another route.
- **Secrets:** the Garmin key only lives in the Worker's secrets. MCP clients never see it, and it never appears in logs or responses.
- **Read-only:** the Personal API cannot write, and the server only sends `GET` requests.
- **Personal use:** the Personal API is for the key's owner. This server is meant for a single user and should not be shared with others.

## Limits

- **What the Personal API doesn't offer:** Training Readiness, VO2 max, race predictions, devices, gear, courses, or uploading workouts. It is read-only and on demand, with no webhooks.
- **Rate limits:** Garmin publishes none. The server makes the requests for a range one after another, and `groupBy` scans at most 1,000 activities (10 requests).
- **CPU:** decoding a long FIT file takes more than the 10 ms of CPU per request of the Workers Free plan. The heaviest FIT file tested in production used 157 ms and worked.
- **Cost:** a single user's KV and Workers usage fits comfortably in Cloudflare's free tier.

## Troubleshooting

- **`wrangler login` waits and times out:** use the device code flow. It doesn't need the browser to call back to `localhost`, and here it only asks for the permissions this project needs:

  ```bash
  pnpm wrangler login --device --scopes account:read user:read workers:write workers_kv:write workers_scripts:write workers_tail:read
  ```

- **`/authorize` answers 403 "Access required":** the request didn't come through the Access application, or `ACCESS_AUD` doesn't match its AUD tag. Check the application's domain and path and the secret.
- **Tools answer "Garmin rejected the Personal API key":** the key expired or was deleted. Create another and update `GARMIN_API_KEY`.
- **A client can't connect or asks to authorize again:** its refresh token expired (over a month without use) or the KV was cleared. Authorize it again from the client.
- **Two `wrangler dev` at once fail with `SQLITE_BUSY`:** they share `.wrangler/state`. Start the second one with its own state:

  ```bash
  pnpm dev --port 8788 --persist-to /tmp/garmin-mcp-state
  ```

## License

[MIT](LICENSE) © Iván Barcia
