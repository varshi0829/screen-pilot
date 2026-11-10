// Backend URL configuration: one source of truth for the planner AND vision paths.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BACKEND_URL, normalizeBackendUrl, resolveBackendBaseUrl } from '../lib/backend-config.js';
import { VercelBackendAdapter } from '../providers/vercel-backend-adapter.js';

const PROD = 'https://screen-pilot-j1az.vercel.app';
const area = (stored) => ({ async get(key) { return stored === undefined ? {} : { [key]: stored }; } });

test('default is the production deployment when nothing is stored', async () => {
  assert.equal(DEFAULT_BACKEND_URL, PROD);
  assert.equal(await resolveBackendBaseUrl(area(undefined)), PROD);
  assert.equal(await resolveBackendBaseUrl(area('')), PROD);
  assert.equal(await resolveBackendBaseUrl(null), PROD);
});

test('a stored custom https backend is used', async () => {
  assert.equal(await resolveBackendBaseUrl(area('https://sp.example.com/')), 'https://sp.example.com');
  assert.equal(await resolveBackendBaseUrl(area('https://sp.example.com/base/')), 'https://sp.example.com/base');
});

test('local development URLs are accepted over plain http', async () => {
  for (const [input, want] of [
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000']
  ]) {
    assert.deepEqual(normalizeBackendUrl(input), { ok: true, url: want });
    assert.equal(await resolveBackendBaseUrl(area(input)), want);
  }
});

test('a legacy stored endpoint URL is reduced to the base', () => {
  assert.equal(normalizeBackendUrl('http://localhost:3000/api/analyze').url, 'http://localhost:3000');
  assert.equal(normalizeBackendUrl('https://sp.example.com/api/plan/').url, 'https://sp.example.com');
});

test('invalid or unsupported URLs are rejected', () => {
  for (const bad of [undefined, null, 42, '', '   ', 'not a url', 'localhost:3000', 'ftp://example.com', 'javascript:alert(1)',
    'https://user:pw@example.com', 'https://example.com/?k=v', 'https://example.com/#x', 'http://example.com', 'http://192.168.1.5:3000']) {
    const r = normalizeBackendUrl(bad);
    assert.equal(r.ok, false, `should reject ${String(bad)}`);
    assert.ok(r.error);
  }
});

test('an invalid stored value falls back to production instead of being used', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await resolveBackendBaseUrl(area('http://evil.example.com')), PROD);
    assert.equal(await resolveBackendBaseUrl(area('garbage')), PROD);
  } finally { console.warn = warn; }
});

test('a storage read that throws falls back to production', async () => {
  assert.equal(await resolveBackendBaseUrl({ async get() { throw new Error('boom'); } }), PROD);
});

// ── adapter wiring ──────────────────────────────────────────────────────────
function withFetch(impl, fn) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('adapter targets production by default and a local backend when configured', async () => {
  await withFetch(() => ok({ result: 'OK' }), async (calls) => {
    await new VercelBackendAdapter().plan({ goal: 'g' });
    await new VercelBackendAdapter({ baseUrl: 'http://localhost:3000' }).plan({ goal: 'g' });
    assert.equal(calls[0].url, `${PROD}/api/plan`);
    assert.equal(calls[1].url, 'http://localhost:3000/api/plan');
  });
});

test('adapter constructor rejects an invalid or insecure backend URL', () => {
  assert.throws(() => new VercelBackendAdapter({ baseUrl: 'nonsense' }), /Invalid backend URL/);
  assert.throws(() => new VercelBackendAdapter({ baseUrl: 'http://example.com' }), /Invalid backend URL/);
});

test('adapter never sends a provider credential header', async () => {
  await withFetch(() => ok({ result: 'OK' }), async (calls) => {
    await new VercelBackendAdapter({ baseUrl: 'http://localhost:3000' }).plan({ goal: 'g' });
    const names = Object.keys(calls[0].init.headers).map((h) => h.toLowerCase());
    assert.ok(!names.some((h) => /authorization|api-key|x-goog|bearer/.test(h)), names.join(','));
  });
});

test('unreachable backend → FAILED/NETWORK_ERROR, not a throw', async () => {
  await withFetch(() => { throw new TypeError('fetch failed'); }, async () => {
    const err = console.error; console.error = () => {};
    try {
      const r = await new VercelBackendAdapter({ baseUrl: 'http://localhost:3999' }).plan({ goal: 'g' });
      assert.equal(r.result, 'FAILED');
      assert.equal(r.errorCode, 'NETWORK_ERROR');
    } finally { console.error = err; }
  });
});

test('non-JSON and HTTP-error responses are reported as FAILED', async () => {
  const err = console.error; console.error = () => {};
  try {
    await withFetch(() => new Response('<html>', { status: 200 }), async () => {
      const r = await new VercelBackendAdapter({ baseUrl: 'http://localhost:3000' }).plan({ goal: 'g' });
      assert.equal(r.errorCode, 'PARSE_ERROR');
    });
    await withFetch(() => new Response(JSON.stringify({ error: 'nope', errorCode: 'UPSTREAM_ERROR' }), { status: 502 }), async () => {
      const r = await new VercelBackendAdapter({ baseUrl: 'http://localhost:3000' }).plan({ goal: 'g' });
      assert.deepEqual([r.result, r.errorCode], ['FAILED', 'UPSTREAM_ERROR']);
    });
  } finally { console.error = err; }
});
