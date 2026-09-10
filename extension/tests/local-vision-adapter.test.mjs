// ScreenPilot v3 — Local Vision PERCEPTION Adapter Unit Tests (privacy-vision Phase 2, corrected)
//
// LocalVisionAdapter is a visual PERCEPTION component: plan() returns a
// minimal { result, elementId, action, confidence, reason } perception
// result, never a full PlanResponse/step — turning a validated pick into an
// executable step is DecisionRouter's job (see decision-router-vision.test.mjs).
// No real Ollama server is required — every network path (chrome.runtime
// proxy and the direct-fetch fallback) is stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVisionAdapter } from '../providers/local-vision-adapter.js';

test('LocalVisionAdapter satisfies BackendAdapter interface', () => {
  const adapter = new LocalVisionAdapter();
  assert.equal(adapter.name, 'LocalVisionAdapter');
  assert.equal(typeof adapter.plan, 'function');
  assert.equal(typeof adapter.checkAvailability, 'function');
});

test('LocalVisionAdapter defaults to the "moondream" model', () => {
  const adapter = new LocalVisionAdapter();
  assert.equal(adapter._model, 'moondream');
});

test('LocalVisionAdapter model is configurable via constructor options', () => {
  const adapter = new LocalVisionAdapter({ model: 'qwen2.5vl:3b' });
  assert.equal(adapter._model, 'qwen2.5vl:3b');
});

// ── request shape: model + images field, sanitized screenshot passed through ──

test('plan() sends a request containing the configured model and an images array with the screenshot', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;

  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: 'el_1', confidence: 0.9, reason: 'looks right' }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter({ model: 'moondream' });
    const sanitizedImage = 'BASE64_SANITIZED_SCREENSHOT_DATA';

    await adapter.plan({
      goal: 'Click submit',
      page: { url: 'https://example.com', title: 'Example', screenshot: { image: sanitizedImage, mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    assert.equal(sentBody.model, 'moondream');
    assert.ok(Array.isArray(sentBody.images), 'request body must carry an images array');
    assert.deepEqual(sentBody.images, [sanitizedImage], 'the exact (already-sanitized) screenshot must be forwarded, unmodified');
    assert.equal(sentBody.stream, false);
    assert.equal(sentBody.format, 'json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan() includes the goal and the known element ids in the prompt, not the full page state', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;

  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: 'el_0', confidence: 0.9 }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter();
    const manyElements = Array.from({ length: 60 }, (_, i) => ({ id: `el_${i}`, role: 'button', text: `Button ${i}` }));

    await adapter.plan({
      goal: 'Do the thing',
      page: { url: 'https://example.com', title: 'Example', screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: manyElements
    });

    assert.ok(sentBody.prompt.includes('Do the thing'), 'prompt must include the goal');
    assert.ok(sentBody.prompt.includes('el_0'), 'prompt must include the known element ids (the fixed vocabulary the model may answer with)');
    // Only a compact, capped slice of elements should be embedded in the prompt text —
    // the screenshot itself (not a dump of the full page state) carries the visual context.
    assert.ok(!sentBody.prompt.includes('Button 59'), 'prompt must not embed the full element list');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the prompt instructs the model to never invent an elementId', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: 'el_1', confidence: 0.9 }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter();
    await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    assert.match(sentBody.prompt.toLowerCase(), /never invent/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan() fails safely (does not throw) when no screenshot is provided', async () => {
  const adapter = new LocalVisionAdapter();
  const result = await adapter.plan({
    goal: 'Click submit',
    page: { url: 'https://example.com', title: 'Example' }, // no screenshot
    elements: []
  });

  assert.equal(result.result, 'FAILED');
  assert.equal(result.errorCode, 'NO_SCREENSHOT');
});

// ── malformed/failed Ollama responses fall back safely (never throw) ─────────

test('plan() resolves a FAILED result (does not throw) when Ollama returns invalid JSON', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: 'not valid json' }) });

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });
    assert.equal(result.result, 'FAILED');
    assert.equal(result.errorCode, 'PARSE_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan() resolves a FAILED result when Ollama returns a non-OK HTTP status', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });
    assert.equal(result.result, 'FAILED');
    assert.equal(result.errorCode, 'OLLAMA_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plan() resolves a FAILED result (not a throw) when the fetch itself rejects', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });
    assert.equal(result.result, 'FAILED');
    assert.equal(result.errorCode, 'OLLAMA_UNAVAILABLE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── plan() returns a minimal PERCEPTION result, not a plan/step ─────────────

test('a successful response is a minimal perception result: elementId/action/confidence/reason, no plan/steps', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: 'el_2', confidence: 0.95, reason: 'visible search button' }) }) });

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Search for products',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });

    assert.equal(result.result, 'OK');
    assert.equal(result.elementId, 'el_2');
    assert.equal(result.action, 'click');
    assert.equal(result.confidence, 0.95);
    assert.equal(result.reason, 'visible search button');
    assert.equal(result.plan, undefined, 'LocalVisionAdapter must not shape a plan/step itself — that is the router\'s job');
    assert.equal(result.state, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a null elementId (model found no visual match) is passed through verbatim, not defaulted or guessed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: null, confidence: 0.2, reason: 'nothing matches' }) }) });

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Search for products',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });

    assert.equal(result.result, 'OK');
    assert.equal(result.elementId, null, 'a missing match must surface as null, not as an invented id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('confidence is clamped to [0,1] and defaults to 0 when missing/non-numeric', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ action: 'click', elementId: 'el_1' }) }) });

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'Search for products',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });
    assert.equal(result.confidence, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── checkAvailability(): proxies through the background service worker ──────

test('checkAvailability: uses chrome.runtime proxy when available, not a direct fetch', async () => {
  const originalFetch = globalThis.fetch;
  let directFetchCalled = false;
  globalThis.fetch = async () => { directFetchCalled = true; throw new Error('direct fetch must not be used when chrome.runtime is available'); };

  let sentMessage = null;
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessage = message;
        callback({ available: true });
      },
    },
  };

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.checkAvailability();
    assert.equal(result.available, true);
    assert.equal(sentMessage.type, 'OLLAMA_CHECK');
    assert.equal(directFetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete global.chrome;
  }
});

test('checkAvailability: reports unavailable when Ollama is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.checkAvailability();
    assert.equal(result.available, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
