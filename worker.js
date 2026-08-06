// Infinicada site worker: serves the static site and the Focus Pocus
// Coven Sync API under /api/sync/v1/.
//
// A "coven" is a small group of one person's devices (the Android app and the
// browser extension) that share focus state: the active session, panic seals,
// and today's counters. There are no accounts — creating a coven mints a
// random coven code (FP1-XXXX-…), and knowing the code is what makes a device
// a member. The server never sees names, emails, or app/site lists; each
// device only uploads a small self-describing envelope.
//
// Storage is one Durable Object per coven (SQLite-backed, free plan). The DO
// keeps a per-coven revision counter so clients can poll cheaply, and an
// idle alarm wipes covens untouched for 90 days.
//
// This file is plain JavaScript with no imports so tools/test-worker.mjs can
// load it in Node with stubbed bindings and exercise the full API.

const API_PREFIX = '/api/sync/v1';

/** Purge a coven after this long without a single authenticated request. */
const IDLE_PURGE_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_DEVICES = 10;
const MAX_ENVELOPE_BYTES = 4096;
const MAX_BODY_BYTES = 16 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Coven code layout: FP1- prefix + Crockford base32 of covenId(6B) ++ secret(9B). */
const CODE_PREFIX = 'FP1';
const COVEN_ID_BYTES = 6;
const SECRET_BYTES = 9;

// ---------------------------------------------------------------------------
// Coven codes (Crockford base32, human-friendly: no I/L/O/U ambiguity)
// ---------------------------------------------------------------------------

const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function b32encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Formats a fresh coven code from random bytes: FP1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
function formatCovenCode(covenIdBytes, secretBytes) {
  const raw = b32encode(new Uint8Array([...covenIdBytes, ...secretBytes]));
  return `${CODE_PREFIX}-${raw.match(/.{1,4}/g).join('-')}`;
}

/**
 * Parses a coven code however the user typed it (any case, with or without
 * dashes, I/L read as 1 and O as 0). Returns { covenId, secret } as hex
 * strings, or null if the code is malformed.
 */
function parseCovenCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s.startsWith(CODE_PREFIX)) return null;
  s = s.slice(CODE_PREFIX.length).replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
  const expectedChars = Math.ceil(((COVEN_ID_BYTES + SECRET_BYTES) * 8) / 5);
  if (s.length !== expectedChars) return null;
  const bytes = b32decode(s);
  if (!bytes || bytes.length < COVEN_ID_BYTES + SECRET_BYTES) return null;
  return {
    covenId: bytesToHex(bytes.slice(0, COVEN_ID_BYTES)),
    secret: bytesToHex(bytes.slice(COVEN_ID_BYTES, COVEN_ID_BYTES + SECRET_BYTES))
  };
}

function newCovenCode() {
  const covenId = crypto.getRandomValues(new Uint8Array(COVEN_ID_BYTES));
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return {
    code: formatCovenCode(covenId, secret),
    covenId: bytesToHex(covenId),
    secret: bytesToHex(secret)
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

const PLATFORMS = new Set(['android', 'browser']);

function cleanString(v, maxLen) {
  return typeof v === 'string' ? v.slice(0, maxLen) : null;
}

function cleanNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Validates and normalizes a device envelope. Unknown fields are dropped so a
 * coven never stores more than the protocol defines. Returns the clean
 * envelope, or null if the input is not usable.
 */
function sanitizeEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (JSON.stringify(raw).length > MAX_ENVELOPE_BYTES) return null;
  const platform = PLATFORMS.has(raw.platform) ? raw.platform : null;
  if (!platform) return null;
  const out = {
    name: cleanString(raw.name, 48) || 'Device',
    platform,
    appVersion: cleanString(raw.appVersion, 32),
    sentAt: cleanNumber(raw.sentAt),
    session: null,
    lastEnded: null,
    panicAt: cleanNumber(raw.panicAt),
    stats: null
  };
  const s = raw.session;
  if (s && typeof s === 'object' && typeof s.id === 'string') {
    out.session = {
      id: s.id.slice(0, 64),
      label: cleanString(s.label, 64),
      startedAt: cleanNumber(s.startedAt),
      endsAt: cleanNumber(s.endsAt),
      onBreak: !!s.onBreak,
      origin: s.origin === 'linked' ? 'linked' : 'local',
      originDeviceId: cleanString(s.originDeviceId, 64)
    };
  }
  const e = raw.lastEnded;
  if (e && typeof e === 'object' && typeof e.id === 'string') {
    out.lastEnded = { id: e.id.slice(0, 64), at: cleanNumber(e.at), completed: !!e.completed };
  }
  const st = raw.stats;
  if (st && typeof st === 'object' && typeof st.date === 'string') {
    out.stats = { date: st.date.slice(0, 10) };
    for (const f of ['opens', 'reflexOpens', 'pactMinutes', 'seals', 'focusMinutes']) {
      const n = cleanNumber(st[f]);
      if (n != null) out.stats[f] = Math.max(0, Math.round(n));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  // The browser extension calls this API from its background context, which
  // is cross-origin; the API is bearer-authenticated and cookie-free, so a
  // wildcard origin exposes nothing.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

function errorResponse(status, code, message) {
  return json(status, { error: code, message });
}

async function readJsonBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return { error: 'too-large' };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return { error: 'too-large' };
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: 'bad-json' };
  }
}

/** Extracts { covenId, secret } from "Authorization: Bearer <coven code>". */
function credentialsFrom(request) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? parseCovenCode(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Worker entry: static site + API routing
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX + '/')) {
      // Everything else is the static site.
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error('sync api error', e);
      return errorResponse(500, 'internal', 'Something went wrong.');
    }
  }
};

async function handleApi(request, env, url) {
  const route = url.pathname.slice(API_PREFIX.length);
  const method = request.method;

  // POST /covens — mint a coven and optionally register the creating device.
  if (route === '/covens' && method === 'POST') {
    const { body, error } = await readJsonBody(request);
    if (error) return errorResponse(400, error, 'Unreadable request body.');
    const minted = newCovenCode();
    const result = await covenOp(env, minted.covenId, '/op/create', {
      secretHash: await sha256Hex(minted.secret),
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      device: body.device ?? null
    });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, { code: minted.code, covenId: minted.covenId, ...result });
  }

  // POST /covens/join — join an existing coven with its code.
  if (route === '/covens/join' && method === 'POST') {
    const { body, error } = await readJsonBody(request);
    if (error) return errorResponse(400, error, 'Unreadable request body.');
    const creds = parseCovenCode(body.code);
    if (!creds) return errorResponse(400, 'bad-code', 'That does not look like a coven code.');
    if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) {
      return errorResponse(400, 'bad-device-id', 'deviceId is required.');
    }
    const result = await covenOp(env, creds.covenId, '/op/join', {
      secretHash: await sha256Hex(creds.secret),
      deviceId: body.deviceId,
      device: body.device ?? null
    });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, { covenId: creds.covenId, ...result });
  }

  // Everything below authenticates with the coven code as a bearer token.
  const creds = credentialsFrom(request);
  if (!creds) return errorResponse(401, 'unauthorized', 'Send the coven code as a Bearer token.');
  const secretHash = await sha256Hex(creds.secret);

  if (route === '/state' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const result = await covenOp(env, creds.covenId, '/op/state', { secretHash, since });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, result);
  }

  const deviceMatch = /^\/devices\/([A-Za-z0-9_-]{8,64})$/.exec(route);
  if (deviceMatch && method === 'PUT') {
    const { body, error } = await readJsonBody(request);
    if (error) return errorResponse(400, error, 'Unreadable request body.');
    const result = await covenOp(env, creds.covenId, '/op/put-device', {
      secretHash,
      deviceId: deviceMatch[1],
      device: body.device ?? body
    });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, result);
  }
  if (deviceMatch && method === 'DELETE') {
    const result = await covenOp(env, creds.covenId, '/op/delete-device', {
      secretHash,
      deviceId: deviceMatch[1]
    });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, result);
  }

  if (route === '/covens' && method === 'DELETE') {
    const result = await covenOp(env, creds.covenId, '/op/delete-coven', { secretHash });
    if (result.error) return errorResponse(result.status, result.error, result.message);
    return json(200, result);
  }

  return errorResponse(404, 'not-found', 'Unknown sync API route.');
}

/** Runs one internal op on the coven's Durable Object and parses the reply. */
async function covenOp(env, covenId, op, payload) {
  const stub = env.SYNC_COVEN.get(env.SYNC_COVEN.idFromName(covenId));
  const response = await stub.fetch('https://coven' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) return { status: response.status, ...body };
  return body;
}

// ---------------------------------------------------------------------------
// SyncCoven Durable Object — one instance per coven
// ---------------------------------------------------------------------------

export class SyncCoven {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname;
    const payload = await request.json();
    const meta = await this.storage.get('meta');

    if (op === '/op/create') {
      if (meta) {
        // A 48-bit random id collided with a live coven; the caller just
        // mints another code. Astronomically rare, cheap to handle.
        return this.reply(409, { error: 'coven-exists', message: 'Try creating again.' });
      }
      const fresh = { secretHash: payload.secretHash, createdAt: Date.now(), rev: 1 };
      await this.storage.put('meta', fresh);
      if (payload.deviceId && DEVICE_ID_RE.test(payload.deviceId)) {
        const set = await this.putDevice(fresh, payload.deviceId, payload.device);
        if (set.error) return this.reply(set.status, set);
      }
      await this.touch();
      return this.reply(200, await this.stateBody(0));
    }

    if (!meta) return this.reply(404, { error: 'coven-not-found', message: 'No such coven — it may have been deleted or expired.' });
    if (payload.secretHash !== meta.secretHash) {
      return this.reply(403, { error: 'forbidden', message: 'Wrong coven code.' });
    }
    await this.touch();

    if (op === '/op/join') {
      const existing = await this.storage.get('dev:' + payload.deviceId);
      if (!existing) {
        const count = (await this.deviceEntries()).length;
        if (count >= MAX_DEVICES) {
          return this.reply(409, { error: 'coven-full', message: `A coven holds at most ${MAX_DEVICES} devices.` });
        }
      }
      const set = await this.putDevice(meta, payload.deviceId, payload.device);
      if (set.error) return this.reply(set.status, set);
      return this.reply(200, await this.stateBody(0));
    }

    if (op === '/op/state') {
      return this.reply(200, await this.stateBody(payload.since ?? 0));
    }

    if (op === '/op/put-device') {
      const set = await this.putDevice(meta, payload.deviceId, payload.device);
      if (set.error) return this.reply(set.status, set);
      return this.reply(200, await this.stateBody(0));
    }

    if (op === '/op/delete-device') {
      await this.storage.delete('dev:' + payload.deviceId);
      const remaining = await this.deviceEntries();
      if (remaining.length === 0) {
        await this.wipe();
        return this.reply(200, { rev: 0, deleted: true, devices: {} });
      }
      meta.rev += 1;
      await this.storage.put('meta', meta);
      return this.reply(200, await this.stateBody(0));
    }

    if (op === '/op/delete-coven') {
      await this.wipe();
      return this.reply(200, { rev: 0, deleted: true, devices: {} });
    }

    return this.reply(404, { error: 'bad-op', message: 'Unknown op.' });
  }

  /** Idle covens self-destruct: every authenticated op re-arms this alarm. */
  async alarm() {
    await this.storage.deleteAll();
  }

  async touch() {
    await this.storage.setAlarm(Date.now() + IDLE_PURGE_MS);
  }

  async wipe() {
    await this.storage.deleteAll();
    if (this.storage.deleteAlarm) await this.storage.deleteAlarm();
  }

  reply(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async deviceEntries() {
    const map = await this.storage.list({ prefix: 'dev:' });
    return [...map.entries()];
  }

  async putDevice(meta, deviceId, rawEnvelope) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return { status: 400, error: 'bad-device-id', message: 'deviceId is required.' };
    }
    const envelope = sanitizeEnvelope(rawEnvelope);
    if (!envelope) {
      return { status: 400, error: 'bad-envelope', message: 'Device envelope is missing or oversized.' };
    }
    const existing = await this.storage.get('dev:' + deviceId);
    if (!existing) {
      const count = (await this.deviceEntries()).length;
      if (count >= MAX_DEVICES) {
        return { status: 409, error: 'coven-full', message: `A coven holds at most ${MAX_DEVICES} devices.` };
      }
    }
    meta.rev += 1;
    await this.storage.put('meta', meta);
    await this.storage.put('dev:' + deviceId, {
      ...envelope,
      rev: meta.rev,
      updatedAt: Date.now(),
      joinedAt: existing?.joinedAt ?? Date.now()
    });
    return { ok: true };
  }

  async stateBody(since) {
    const meta = await this.storage.get('meta');
    const rev = meta?.rev ?? 0;
    if (since > 0 && since === rev) return { rev, changed: false };
    const devices = {};
    for (const [key, value] of await this.deviceEntries()) {
      devices[key.slice(4)] = value;
    }
    return { rev, changed: true, devices };
  }
}
