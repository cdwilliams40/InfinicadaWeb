# InfinicadaWeb

The [infinicada.com](https://infinicada.com) website — landing page for
[Focus Pocus](https://github.com/cdwilliams40/FocusPocus) — plus the
**Coven Sync API** that lets the Android app and the
[browser extension](https://github.com/cdwilliams40/FocusPocus-Browser)
focus together.

## Layout

```
index.html            # landing page
warden.html           # Warden Mode explainer
privacy.html          # privacy policy (covers the app, extension, and Coven Sync)
worker.js             # Cloudflare Worker: /api/sync/v1 + static-asset fall-through
wrangler.jsonc        # Worker config: assets + SyncCoven Durable Object
tools/test-worker.mjs # API tests with stubbed bindings (node tools/test-worker.mjs)
```

The site deploys as a single Cloudflare Worker: `worker.js` answers
`/api/sync/v1/*` and every other request falls through to the static files.
The Durable Object migration in `wrangler.jsonc` provisions storage on deploy —
SQLite-backed DOs run on the free plan, and no dashboard setup is needed.

## Coven Sync API

A *coven* is one person's devices sharing focus state. There are no accounts:
creating a coven mints a random code (`FP1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`,
120 bits), and knowing the code is what makes a device a member. Each device
uploads a small envelope — chosen name, platform, running focus session, panic
timestamp, today's counters — and polls for the others'. Clients then mirror
original sessions as linked sessions and apply panic seals locally.

All routes are JSON under `/api/sync/v1`; authenticated routes take the coven
code as a bearer token. CORS is wide open (`*`) because the API is
credential-free apart from that bearer code — this is what lets the browser
extension call it without host permissions.

| Route | What it does |
|---|---|
| `POST /covens` | Mint a coven (+ optionally register the creating device). Returns the code. |
| `POST /covens/join` | `{ code, deviceId, device }` — join and register a device. |
| `GET /state?since=rev` | All device envelopes; `{ changed: false }` when nothing moved. |
| `PUT /devices/:id` | Upsert this device's envelope; response doubles as a pull. |
| `DELETE /devices/:id` | Leave; deleting the last device deletes the coven. |
| `DELETE /covens` | Delete the whole coven. |

Limits: 10 devices per coven, 4 KB per envelope. A coven with no authenticated
request for 90 days is wiped by a Durable Object alarm — that plus
leave-to-delete is the whole retention story (see `privacy.html`).

## Development

```bash
node tools/test-worker.mjs   # API tests, no dependencies
npx wrangler dev             # run site + API locally
npx wrangler deploy          # or let the connected Workers Build deploy on push
```
