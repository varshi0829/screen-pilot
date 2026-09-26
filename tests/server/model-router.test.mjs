import './_setup.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
const { selectPlannerChain, selectVisionProvider, runPlannerChain, DEFAULT_OPENROUTER_MODEL, DEFAULT_GEMINI_MODEL } = await import('../../src/server/model-router.ts');

const OR_KEY = 'or-key';
const GEM_KEY = 'gem-key';

// ── selection ─────────────────────────────────────────────────────────────────

test('selectPlannerChain: OpenRouter wins when both keys are present (matches pre-refactor priority)', () => {
  const chain = selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY, GEMINI_API_KEY: GEM_KEY });
  assert.deepEqual(chain, [{ provider: 'openrouter', model: DEFAULT_OPENROUTER_MODEL, key: OR_KEY }]);
});

test('selectPlannerChain: Gemini only when OpenRouter key is absent', () => {
  const chain = selectPlannerChain({ GEMINI_API_KEY: GEM_KEY });
  assert.deepEqual(chain, [{ provider: 'gemini', model: DEFAULT_GEMINI_MODEL, key: GEM_KEY }]);
});

test('selectPlannerChain: empty when neither key is set', () => {
  assert.deepEqual(selectPlannerChain({}), []);
});

test('selectPlannerChain: model names are overridable via env', () => {
  const chain = selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY, PLANNER_MODEL_OPENROUTER: 'custom/model' });
  assert.equal(chain[0].model, 'custom/model');
});

test('selectPlannerChain: FALLBACK_PROVIDER is opt-in and unused by default', () => {
  assert.equal(selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY }).length, 1);
  const withFallback = selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY, GEMINI_API_KEY: GEM_KEY, FALLBACK_PROVIDER: 'gemini' });
  assert.deepEqual(withFallback, [
    { provider: 'openrouter', model: DEFAULT_OPENROUTER_MODEL, key: OR_KEY },
    { provider: 'gemini', model: DEFAULT_GEMINI_MODEL, key: GEM_KEY }
  ]);
});

test('selectPlannerChain: a fallback naming the SAME provider as primary, or missing its key, is not added', () => {
  assert.equal(selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY, FALLBACK_PROVIDER: 'openrouter' }).length, 1);
  assert.equal(selectPlannerChain({ OPENROUTER_API_KEY: OR_KEY, FALLBACK_PROVIDER: 'gemini' }).length, 1, 'no GEMINI_API_KEY to fall back with');
});

test('selectVisionProvider: Gemini when its key is present, else null; OpenRouter is never selected for vision', () => {
  assert.deepEqual(selectVisionProvider({ GEMINI_API_KEY: GEM_KEY }), { provider: 'gemini', model: DEFAULT_GEMINI_MODEL, key: GEM_KEY });
  assert.equal(selectVisionProvider({ OPENROUTER_API_KEY: OR_KEY }), null);
  assert.equal(selectVisionProvider({}), null);
});

// ── runPlannerChain ───────────────────────────────────────────────────────────

function ctx(overrides = {}) {
  return { prompt: 'p', screenshot: { image: 'AAAA' }, outerSignal: new AbortController().signal, perAttemptMs: 5000, backoffMs: () => 1, ...overrides };
}

test('an empty chain fails immediately with no provider configured', async () => {
  const res = await runPlannerChain([], ctx());
  assert.equal(res.ok, false);
  assert.equal(res.selection, null);
  assert.match(res.message, /no provider configured/);
});

test('OpenRouter success on the first (only) attempt', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 }); };
  try {
    const res = await runPlannerChain([{ provider: 'openrouter', model: 'm', key: OR_KEY }], ctx());
    assert.equal(res.ok, true);
    assert.equal(res.selection.provider, 'openrouter');
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = orig; }
});

test('OpenRouter never retries internally, even on a retryable-looking failure', async () => {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: { message: 'x' } }), { status: 503 }); };
  try {
    const res = await runPlannerChain([{ provider: 'openrouter', model: 'm', key: OR_KEY }], ctx());
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(n, 1);
  } finally { globalThis.fetch = orig; }
});

test('Gemini retries once on a 5xx, then succeeds', async () => {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'blip' } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }), { status: 200 });
  };
  try {
    const res = await runPlannerChain([{ provider: 'gemini', model: 'm', key: GEM_KEY }], ctx());
    assert.equal(res.ok, true);
    assert.equal(n, 2);
  } finally { globalThis.fetch = orig; }
});

test('Gemini does not retry a 429 or a fatal 401 — moves straight to the next chain entry', async () => {
  const orig = globalThis.fetch;
  for (const status of [429, 401]) {
    let n = 0;
    globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: { message: 'x' } }), { status }); };
    const res = await runPlannerChain([{ provider: 'gemini', model: 'm', key: GEM_KEY }], ctx());
    assert.equal(res.ok, false, `status ${status}`);
    assert.equal(res.status, status);
    assert.equal(n, 1, `status ${status} must not be retried`);
  }
  globalThis.fetch = orig;
});

test('falls through to the second chain entry when the first is fully exhausted', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter')) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }), { status: 200 });
  };
  try {
    const chain = [{ provider: 'openrouter', model: 'm', key: OR_KEY }, { provider: 'gemini', model: 'm', key: GEM_KEY }];
    const res = await runPlannerChain(chain, ctx());
    assert.equal(res.ok, true);
    assert.equal(res.selection.provider, 'gemini');
  } finally { globalThis.fetch = orig; }
});

test('when every entry fails, the failure reflects the LAST attempt made', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify({ error: { message: String(url).includes('openrouter') ? 'or-down' : 'gem-down' } }),
    { status: String(url).includes('openrouter') ? 500 : 401 }
  );
  try {
    const chain = [{ provider: 'openrouter', model: 'm', key: OR_KEY }, { provider: 'gemini', model: 'm', key: GEM_KEY }];
    const res = await runPlannerChain(chain, ctx());
    assert.equal(res.ok, false);
    assert.equal(res.selection.provider, 'gemini');
    assert.equal(res.status, 401);
  } finally { globalThis.fetch = orig; }
});

test('onAttempt fires once per real attempt with no PII-bearing fields', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 503 });
  const events = [];
  try {
    await runPlannerChain([{ provider: 'gemini', model: 'm', key: GEM_KEY }], ctx({ onAttempt: (e) => events.push(e) }));
    assert.equal(events.length, 2);
    assert.deepEqual(Object.keys(events[0]).sort(), ['attempt', 'maxAttempts', 'model', 'ok', 'provider', 'status'].sort());
    assert.equal(JSON.stringify(events).includes(GEM_KEY), false, 'the event must not embed the raw key');
  } finally { globalThis.fetch = orig; }
});

test('respects outerSignal: an already-aborted signal fails immediately without calling fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  try {
    const res = await runPlannerChain([{ provider: 'gemini', model: 'm', key: GEM_KEY }], ctx({ outerSignal: controller.signal }));
    assert.equal(res.ok, false);
    assert.equal(res.message, 'timeout');
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
});
