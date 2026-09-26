// Shared harness for server (Next.js route) tests. Run with:
//   NODE_NO_WARNINGS=1 node --test tests/server/*.test.mjs
import './_setup.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
let counter = 0;

/** Import a fresh copy of a route module (fresh module-level rate-limit state). */
export async function freshRoute(name) {
  const file = pathToFileURL(path.join(ROOT, 'src', 'app', 'api', name, 'route.ts')).href;
  return import(`${file}?fresh=${++counter}`);
}

export const KEYS = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'PLANNER_PROVIDER', 'PLANNER_MODEL', 'VISION_PROVIDER', 'VISION_MODEL',
  'FALLBACK_PROVIDER', 'FALLBACK_MODEL', 'RATE_LIMIT_SESSION_PER_MIN', 'RATE_LIMIT_GLOBAL_PER_MIN', 'PII_BACKSTOP'];

/** Run fn with exactly these env vars set (all router/limiter vars cleared first). */
export async function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/** Replace global fetch; `handler(url, init, callIndex)` returns a Response-like or throws. */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, headers: normalizeHeaders(init.headers), body: safeJson(init.body) };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function normalizeHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

export const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** Capture console output (routes log heavily); returns the captured lines. */
export function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  return { lines, restore() { Object.assign(console, orig); } };
}

// ── canned provider responses ────────────────────────────────────────────────

export const PLAN_JSON = {
  result: 'OK',
  state: 'planned',
  interpretation: { goalType: 'navigation', application: 'GitHub', pageType: 'dashboard', navigationRequired: true, authenticated: true },
  blockers: [],
  plannerSummary: 'Use the New button.',
  confidence: 0.9,
  plan: {
    goalType: 'navigation',
    confidence: 0.85,
    applicationId: 'GitHub',
    steps: [{ id: 1, description: "Click 'New'", targetElement: { text: 'New', type: 'button' } }]
  },
  goalCompletionCriteria: { goalType: 'action', match: 'all', successSignals: [{ type: 'url_matches', urlPattern: '/new' }] }
};

export const openRouterOk = (content = JSON.stringify(PLAN_JSON), finish = 'stop') =>
  jsonResponse({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50 } });

export const geminiOk = (text = JSON.stringify(PLAN_JSON), finish = 'STOP') =>
  jsonResponse({ candidates: [{ content: { parts: [{ text }] }, finishReason: finish }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });

export const upstreamError = (status, message = 'boom') => jsonResponse({ error: { message } }, status);

export const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

// ── request builders ─────────────────────────────────────────────────────────

export function planBody(overrides = {}) {
  return {
    goal: 'create a repository called test',
    requestId: 'req-1',
    page: { url: 'https://github.com/', title: 'GitHub', screenshot: { image: 'QUJD', mimeType: 'image/jpeg' } },
    ...overrides
  };
}

export function analyzeBody(overrides = {}) {
  return {
    goal: 'open settings',
    screenshot: { image: 'QUJD', mimeType: 'image/jpeg' },
    pageContext: { url: 'https://example.com/', title: 'Example' },
    ...overrides
  };
}

let sessionCounter = 0;
export function post(body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': `sess-${++sessionCounter}`, ...headers },
    body: raw
  });
}

/** True when the given secret is supplied to the upstream call anywhere (URL, header) — without caring where. */
export function keySuppliedTo(call, key) {
  return call.url.includes(key) || Object.values(call.headers).some((v) => String(v).includes(key));
}
