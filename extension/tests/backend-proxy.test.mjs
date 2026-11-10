// Service-worker-mediated planner requests: the destination is validated and
// resolved on the service-worker side, requests carry no credentials, and every
// failure mode degrades to a FAILED plan response instead of throwing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { backendRequest, handleBackendRequest, handleBackendCancel, BACKEND_PATHS } from '../services/backend-proxy.js';
import { VercelBackendAdapter } from '../providers/vercel-backend-adapter.js';

const PROD = 'https://screen-pilot-j1az.vercel.app';
const store = (v) => ({ async get(k) { return v === undefined ? {} : { [k]: v }; } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch(impl) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const quiet = (fn) => async () => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { await fn(); } finally { console.error = e; console.warn = w; } };

// ── backendRequest ──────────────────────────────────────────────────────────
test('HTTPS production backend: POSTs JSON to the fixed path, no credentials', async () => {
  const f = stubFetch(() => json({ result: 'OK' }));
  try {
    const r = await backendRequest({ baseUrl: PROD, path: '/api/plan', body: { goal: 'g' },
      headers: { 'Content-Type': 'application/json', 'X-Session-ID': 's1', Authorization: 'Bearer nope', 'X-Api-Key': 'nope', Cookie: 'a=b' } });
    assert.deepEqual(r, { ok: true, status: 200, data: { result: 'OK' } });
    assert.equal(f.calls[0].url, `${PROD}/api/plan`);
    assert.equal(f.calls[0].init.credentials, 'omit');
    const names = Object.keys(f.calls[0].init.headers).map((h) => h.toLowerCase()).sort();
    assert.deepEqual(names, ['content-type', 'x-session-id']);
  } finally { f.restore(); }
});

test('invalid destination or request is refused before any fetch', async () => {
  const f = stubFetch(() => json({}));
  try {
    for (const baseUrl of ['nonsense', 'ftp://x.com', 'http://example.com', 'https://u:p@x.com', 'javascript:1', '', undefined]) {
      const r = await backendRequest({ baseUrl, path: '/api/plan', body: {} });
      assert.equal(r.errorCode, 'INVALID_REQUEST', String(baseUrl));
    }
    for (const path of ['/api/other', '/', '//evil.com/api/plan', '/api/plan/../x', undefined]) {
      assert.equal((await backendRequest({ baseUrl: PROD, path, body: {} })).errorCode, 'INVALID_REQUEST', String(path));
    }
    for (const body of [null, 'str', [1], undefined]) {
      assert.equal((await backendRequest({ baseUrl: PROD, path: '/api/plan', body })).errorCode, 'INVALID_REQUEST');
    }
    const cyc = {}; cyc.self = cyc;
    assert.equal((await backendRequest({ baseUrl: PROD, path: '/api/plan', body: cyc })).errorCode, 'INVALID_REQUEST');
    assert.equal(f.calls.length, 0);
    assert.ok(BACKEND_PATHS.every((p) => /^\/api\/[a-z]+$/.test(p)));
  } finally { f.restore(); }
});

test('backend unavailable → NETWORK_ERROR; hang → REQUEST_TIMEOUT', quiet(async () => {
  let f = stubFetch(() => { throw new TypeError('fetch failed'); });
  try { assert.equal((await backendRequest({ baseUrl: 'http://localhost:3999', path: '/api/plan', body: {} })).errorCode, 'NETWORK_ERROR'); } finally { f.restore(); }
  f = stubFetch((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  try { assert.equal((await backendRequest({ baseUrl: PROD, path: '/api/plan', body: {}, timeoutMs: 20 })).errorCode, 'REQUEST_TIMEOUT'); } finally { f.restore(); }
}));

test('malformed responses (HTML, non-object JSON) are parse errors', async () => {
  for (const resp of [() => new Response('<html>', { status: 200 }), () => new Response('[1,2]', { status: 200 }), () => new Response('null', { status: 200 })]) {
    const f = stubFetch(resp);
    try { assert.equal((await backendRequest({ baseUrl: PROD, path: '/api/plan', body: {} })).parseError, true); } finally { f.restore(); }
  }
});

// ── handleBackendRequest (service-worker entry) ──────────────────────────────
test('localhost backend reached from the service worker; destination comes from storage, never the message', async () => {
  const f = stubFetch(() => json({ result: 'OK' }));
  try {
    const r = await handleBackendRequest({ reqId: 'r1', path: '/api/plan', body: { goal: 'g' }, url: 'https://evil.example.com', baseUrl: 'https://evil.example.com' }, undefined, { storageArea: store('http://localhost:3000') });
    assert.equal(r.ok, true);
    assert.equal(f.calls[0].url, 'http://localhost:3000/api/plan');
  } finally { f.restore(); }
});

test('no override → production; invalid stored override → production (never the bad value)', quiet(async () => {
  for (const stored of [undefined, 'http://evil.example.com', 'garbage']) {
    const f = stubFetch(() => json({ result: 'OK' }));
    try {
      await handleBackendRequest({ path: '/api/plan', body: {} }, undefined, { storageArea: store(stored) });
      assert.equal(f.calls[0].url, `${PROD}/api/plan`);
    } finally { f.restore(); }
  }
}));

test('custom backend URL persists: a fresh handler call (new service-worker life) reads the same stored value', async () => {
  const backing = { screenPilotBackendUrl: 'https://sp.example.com/base/' };
  const area = { async get(k) { return { [k]: backing[k] }; } };
  const f = stubFetch(() => json({ result: 'OK' }));
  try {
    await handleBackendRequest({ path: '/api/plan', body: {} }, undefined, { storageArea: area });
    await handleBackendRequest({ path: '/api/recover', body: {} }, undefined, { storageArea: area });
    assert.deepEqual(f.calls.map((c) => c.url), ['https://sp.example.com/base/api/plan', 'https://sp.example.com/base/api/recover']);
  } finally { f.restore(); }
});

test('messages from other senders are rejected; cancel aborts an in-flight request', async () => {
  globalThis.chrome = { runtime: { id: 'ext-id' } };
  const f = stubFetch((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
  try {
    const bad = await handleBackendRequest({ path: '/api/plan', body: {} }, { id: 'other-ext' }, { storageArea: store(undefined) });
    assert.equal(bad.errorCode, 'INVALID_REQUEST');
    assert.equal(f.calls.length, 0);
    const pending = handleBackendRequest({ reqId: 'c1', path: '/api/plan', body: {} }, { id: 'ext-id' }, { storageArea: store(undefined) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(handleBackendCancel({ reqId: 'c1' }).cancelled, true);
    assert.equal((await pending).errorCode, 'ABORTED');
  } finally { f.restore(); delete globalThis.chrome; }
});

// ── adapter inside the extension (page / content-script context) ─────────────
function withRuntime(onMessage, fn) {
  const sent = [];
  globalThis.chrome = { runtime: { id: 'ext-id', lastError: undefined, sendMessage(msg, cb) { sent.push(msg); onMessage(msg, cb, globalThis.chrome.runtime); } } };
  const realFetch = globalThis.fetch; let pageFetches = 0;
  globalThis.fetch = async () => { pageFetches++; throw new Error('page-context fetch must not be used'); };
  return Promise.resolve(fn(sent, () => pageFetches)).finally(() => { delete globalThis.chrome; globalThis.fetch = realFetch; });
}

test('from an https page the adapter never fetches itself and never names a destination', async () => {
  await withRuntime((m, cb) => cb({ ok: true, status: 200, data: { result: 'OK', plan: 1 } }), async (sent, pageFetches) => {
    const r = await new VercelBackendAdapter({ sessionId: 'abc' }).plan({ goal: 'g' });
    assert.deepEqual(r, { result: 'OK', plan: 1 });
    assert.equal(pageFetches(), 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'BACKEND_REQUEST');
    assert.equal(sent[0].path, '/api/plan');
    assert.ok(!('url' in sent[0]) && !('baseUrl' in sent[0]));
    const flat = JSON.stringify(sent[0]).toLowerCase();
    assert.ok(!/authorization|api[-_]?key|bearer|cookie/.test(flat), flat);
  });
});

test('end to end: adapter → service worker → localhost backend', async () => {
  const proxied = [];
  await withRuntime(
    (m, cb) => {
      // Inside the service worker fetch is allowed; give it its own stub.
      const pageFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => { proxied.push({ url, init }); return json({ result: 'OK', state: 'planned' }); };
      handleBackendRequest(m, { id: 'ext-id' }, { storageArea: store('http://localhost:3917') })
        .then(cb).finally(() => { globalThis.fetch = pageFetch; });
    },
    async (sent, pageFetches) => {
      const r = await new VercelBackendAdapter().plan({ goal: 'g' });
      assert.equal(r.result, 'OK');
      assert.equal(pageFetches(), 0);
      assert.equal(proxied[0].url, 'http://localhost:3917/api/plan');
    }
  );
});

test('service-worker messaging failures become FAILED NETWORK_ERROR, not exceptions', quiet(async () => {
  const cases = [
    (m, cb, rt) => { rt.lastError = { message: 'Could not establish connection' }; cb(undefined); rt.lastError = undefined; },
    (m, cb) => cb(undefined),
    (m, cb) => cb('garbage'),
    () => { throw new Error('extension context invalidated'); },
  ];
  for (const impl of cases) {
    await withRuntime(impl, async () => {
      const r = await new VercelBackendAdapter().plan({ goal: 'g' });
      assert.equal(r.result, 'FAILED');
      assert.equal(r.errorCode, 'NETWORK_ERROR');
    });
  }
}));

test('proxy-reported failures keep their codes (parse error, HTTP error, timeout)', quiet(async () => {
  const run = async (resp) => withRuntime((m, cb) => cb(resp), () => new VercelBackendAdapter().plan({ goal: 'g' }));
  assert.equal((await run({ parseError: true, status: 200 })).errorCode, 'PARSE_ERROR');
  assert.equal((await run({ networkError: true, errorCode: 'REQUEST_TIMEOUT', message: 't' })).errorCode, 'REQUEST_TIMEOUT');
  const http = await run({ ok: false, status: 502, data: { error: 'nope', errorCode: 'UPSTREAM_ERROR' } });
  assert.deepEqual([http.result, http.errorCode], ['FAILED', 'UPSTREAM_ERROR']);
}));

test('caller abort sends BACKEND_CANCEL and resolves ABORTED', quiet(async () => {
  const ac = new AbortController();
  await withRuntime((m, cb) => { if (m.type === 'BACKEND_REQUEST') setTimeout(() => ac.abort(), 5); /* never answers until aborted */ if (m.type === 'BACKEND_REQUEST') setTimeout(() => cb({ networkError: true, errorCode: 'ABORTED', message: 'x' }), 30); }, async (sent) => {
    const r = await new VercelBackendAdapter().plan({ goal: 'g' }, { signal: ac.signal });
    assert.equal(r.errorCode, 'ABORTED');
    assert.ok(sent.some((m) => m.type === 'BACKEND_CANCEL'));
  });
  const pre = new AbortController(); pre.abort();
  await withRuntime((m, cb) => cb({ ok: true, status: 200, data: {} }), async (sent) => {
    assert.equal((await new VercelBackendAdapter().plan({ goal: 'g' }, { signal: pre.signal })).errorCode, 'ABORTED');
    assert.equal(sent.length, 0);
  });
}));
