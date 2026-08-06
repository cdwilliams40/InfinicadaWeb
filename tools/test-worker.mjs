#!/usr/bin/env node
// Integration tests for the Coven Sync API: loads worker.js with stubbed
// Cloudflare bindings (in-memory Durable Object storage, fake ASSETS) and
// drives the full HTTP surface.  Run:  node tools/test-worker.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// worker.js is an ES module without the .mjs extension (Wrangler is fine with
// that; Node is not) — import it through a temp copy.
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-sync-')), 'worker.mjs');
fs.copyFileSync(path.join(repoRoot, 'worker.js'), tmp);
const workerModule = await import(pathToFileURL(tmp).href);
const worker = workerModule.default;
const { SyncCoven } = workerModule;

// --- Stub bindings ----------------------------------------------------------

class StubStorage {
  constructor() {
    this.map = new Map();
    this.alarmAt = null;
  }
  async get(key) {
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }
  async put(key, value) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  async deleteAll() {
    this.map.clear();
  }
  async list({ prefix = '' } = {}) {
    const out = new Map();
    for (const key of [...this.map.keys()].sort()) {
      if (key.startsWith(prefix)) out.set(key, structuredClone(this.map.get(key)));
    }
    return out;
  }
  async setAlarm(at) {
    this.alarmAt = at;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}

const doInstances = new Map();
const env = {
  SYNC_COVEN: {
    idFromName: (name) => name,
    get(id) {
      if (!doInstances.has(id)) doInstances.set(id, new SyncCoven({ storage: new StubStorage() }));
      const instance = doInstances.get(id);
      return { fetch: (url, init) => instance.fetch(new Request(url, init)) };
    }
  },
  ASSETS: {
    fetch: async (request) => new Response('asset:' + new URL(request.url).pathname, { status: 200 })
  }
};

function call(method, apiPath, { body, code } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (code) headers.Authorization = `Bearer ${code}`;
  return worker.fetch(
    new Request('https://infinicada.com' + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    env
  );
}

// --- Tiny test harness ------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
function eq(a, b, label) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

const envelope = (over = {}) => ({
  name: 'Test phone',
  platform: 'android',
  appVersion: '1.0',
  sentAt: Date.now(),
  session: null,
  lastEnded: null,
  panicAt: null,
  stats: { date: '2026-08-06', opens: 3, reflexOpens: 1 },
  ...over
});

// --- Tests ------------------------------------------------------------------

// Static site fall-through.
let res = await worker.fetch(new Request('https://infinicada.com/warden.html'), env);
eq(await res.text(), 'asset:/warden.html', 'non-API paths serve the static site');
res = await worker.fetch(new Request('https://infinicada.com/api/other'), env);
eq(await res.text(), 'asset:/api/other', 'non-sync /api paths still fall through');

// CORS preflight for the extension.
res = await call('OPTIONS', '/api/sync/v1/state');
eq(res.status, 204, 'preflight ok');
eq(res.headers.get('Access-Control-Allow-Origin'), '*', 'preflight allows any origin');

// Create a coven, registering the creating device in the same call.
res = await call('POST', '/api/sync/v1/covens', {
  body: { deviceId: 'phone-device-1', device: envelope() }
});
eq(res.status, 200, 'create coven ok');
const created = await res.json();
assert(/^FP1(-[0-9A-HJKMNP-TV-Z]{4}){6}$/.test(created.code), `code shape (${created.code})`);
eq(created.rev, 2, 'create with device bumps rev');
eq(Object.keys(created.devices), ['phone-device-1'], 'creator registered');
const code = created.code;

// Join with a sloppily typed code (lowercase, no dashes).
const sloppy = code.toLowerCase().replace(/-/g, '');
res = await call('POST', '/api/sync/v1/covens/join', {
  body: { code: sloppy, deviceId: 'browser-device-1', device: envelope({ name: 'Chrome', platform: 'browser' }) }
});
eq(res.status, 200, 'join with sloppy code ok');
const joined = await res.json();
eq(Object.keys(joined.devices).sort(), ['browser-device-1', 'phone-device-1'], 'both devices in roster');

// Wrong code (flip a payload character, keeping the prefix) is rejected.
const flip = (ch) => (ch === 'A' ? 'B' : 'A');
const wrongCode = code.slice(0, -1) + flip(code.slice(-1));
res = await call('GET', '/api/sync/v1/state', { code: wrongCode });
assert(res.status === 403 || res.status === 404, `wrong code rejected (${res.status})`);

// No auth at all.
res = await call('GET', '/api/sync/v1/state');
eq(res.status, 401, 'missing auth rejected');

// Push a session and read it back.
res = await call('PUT', '/api/sync/v1/devices/phone-device-1', {
  code,
  body: {
    device: envelope({
      session: { id: 'sess-1', label: 'Deep Work', startedAt: 1000, endsAt: 2000, origin: 'local' },
      junkField: 'dropped'
    })
  }
});
eq(res.status, 200, 'push ok');
const pushed = await res.json();
eq(pushed.devices['phone-device-1'].session.label, 'Deep Work', 'session stored');
eq(pushed.devices['phone-device-1'].junkField, undefined, 'unknown fields dropped');
eq(pushed.devices['phone-device-1'].session.origin, 'local', 'origin preserved');

// Cheap polling: unchanged rev returns changed:false with no devices.
res = await call('GET', `/api/sync/v1/state?since=${pushed.rev}`, { code });
let state = await res.json();
eq(state.changed, false, 'poll with current rev is cheap');
res = await call('GET', `/api/sync/v1/state?since=${pushed.rev - 1}`, { code });
state = await res.json();
eq(state.changed, true, 'stale rev gets full state');
assert(state.devices['browser-device-1'], 'full state includes all devices');

// Envelope limits: oversized payloads are rejected.
res = await call('PUT', '/api/sync/v1/devices/phone-device-1', {
  code,
  body: { device: envelope({ name: 'x'.repeat(8000) }) }
});
eq(res.status, 400, 'oversized envelope rejected');

// Bad platform rejected.
res = await call('PUT', '/api/sync/v1/devices/phone-device-1', {
  code,
  body: { device: envelope({ platform: 'toaster' }) }
});
eq(res.status, 400, 'unknown platform rejected');

// Device cap: an 11th device cannot join (2 already registered).
for (let i = 3; i <= 10; i++) {
  res = await call('POST', '/api/sync/v1/covens/join', {
    body: { code, deviceId: `extra-device-${i}`, device: envelope() }
  });
  eq(res.status, 200, `device ${i} joins`);
}
res = await call('POST', '/api/sync/v1/covens/join', {
  body: { code, deviceId: 'extra-device-11', device: envelope() }
});
eq(res.status, 409, '11th device rejected');

// Leaving: deleting a device removes it; deleting the last device wipes the coven.
res = await call('DELETE', '/api/sync/v1/devices/browser-device-1', { code });
eq(res.status, 200, 'leave ok');
state = await (await call('GET', '/api/sync/v1/state', { code })).json();
eq(state.devices['browser-device-1'], undefined, 'left device gone');

// Delete the whole coven; the code stops working.
res = await call('DELETE', '/api/sync/v1/covens', { code });
eq(res.status, 200, 'delete coven ok');
res = await call('GET', '/api/sync/v1/state', { code });
eq(res.status, 404, 'deleted coven is gone');

// Idle purge: the alarm wipes storage.
res = await call('POST', '/api/sync/v1/covens', { body: { deviceId: 'phone-device-9', device: envelope() } });
const created2 = await res.json();
const instance = doInstances.get(created2.covenId);
assert(instance !== undefined, 'DO instance exists');
await instance.alarm();
res = await call('GET', '/api/sync/v1/state', { code: created2.code });
eq(res.status, 404, 'idle purge wipes the coven');

// Unknown API route 404s without touching assets.
res = await call('GET', '/api/sync/v1/nope', { code: created2.code });
eq(res.status, 404, 'unknown sync route 404s');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
