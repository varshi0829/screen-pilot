// ScreenPilot v2 — Local Qwen Adapter Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';

test('LocalQwenAdapter satisfies BackendAdapter interface', () => {
  const adapter = new LocalQwenAdapter();
  assert.equal(adapter.name, 'LocalQwenAdapter');
  assert.equal(typeof adapter.plan, 'function');
  assert.equal(typeof adapter.checkAvailability, 'function');
});

test('LocalQwenAdapter formats 1-action plan response correctly from Qwen JSON output', () => {
  const adapter = new LocalQwenAdapter();
  const qwenOutput = {
    action: 'click',
    elementId: 'el_2',
    text: 'Submit Search',
    confidence: 0.95,
    reason: 'Clicks search button'
  };

  const response = adapter._formatPlanResponse(
    { goal: 'Search for products' },
    qwenOutput,
    150
  );

  assert.equal(response.result, 'OK');
  assert.equal(response.state, 'planned');
  assert.equal(response.plan.steps.length, 1);
  assert.equal(response.plan.steps[0].targetElement.text, 'Submit Search');
  assert.equal(response.providerMetadata.provider, 'local-qwen');
});

test('LocalQwenAdapter handles finish action correctly', () => {
  const adapter = new LocalQwenAdapter();
  const qwenOutput = {
    action: 'finish',
    confidence: 0.99,
    reason: 'Goal is satisfied.'
  };

  const response = adapter._formatPlanResponse(
    { goal: 'Search for products' },
    qwenOutput,
    100
  );

  assert.equal(response.result, 'OK');
  assert.equal(response.state, 'complete');
  assert.equal(response.plan, undefined);
});

// ── checkAvailability(): must proxy through the background service worker ──
//
// Real-Chrome finding: a direct content-script fetch() to 127.0.0.1:11434
// works on a plain-http local page (no policy gate) but is silently blocked
// by Chrome's Private Network Access policy when the current tab is a real
// https:// site — virtually every real website — so it hangs until
// checkAvailability's own timeout fires, always reporting "unavailable"
// regardless of whether Ollama is actually running. The fix routes through
// chrome.runtime.sendMessage({type:'OLLAMA_CHECK'}) — background.js's
// existing OLLAMA_CHECK handler (services/ollama-proxy.js), which runs in a
// privileged extension context PNA doesn't gate — with a direct-fetch
// fallback for non-extension contexts (these tests included, which run with
// no chrome global at all in the two tests above and below this block).

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
    const adapter = new LocalQwenAdapter();
    const result = await adapter.checkAvailability();
    assert.equal(result.available, true, 'should report available via the proxy response');
    assert.equal(sentMessage.type, 'OLLAMA_CHECK', 'must send an OLLAMA_CHECK message');
    assert.equal(directFetchCalled, false, 'must not fall back to a direct fetch when the proxy succeeds');
  } finally {
    globalThis.fetch = originalFetch;
    delete global.chrome;
  }
});

test('checkAvailability: proxy reporting unavailable is trusted as-is (no direct-fetch double-check)', async () => {
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => callback({ available: false, error: 'connection refused' }),
    },
  };
  try {
    const adapter = new LocalQwenAdapter();
    const result = await adapter.checkAvailability();
    assert.equal(result.available, false);
    assert.equal(result.reason, 'connection refused');
  } finally {
    delete global.chrome;
  }
});

test('checkAvailability: falls back to direct fetch when chrome.runtime messaging itself fails', async () => {
  const originalFetch = globalThis.fetch;
  let directFetchCalled = false;
  globalThis.fetch = async () => { directFetchCalled = true; return { ok: true }; };

  global.chrome = {
    runtime: {
      lastError: { message: 'Extension context invalidated' },
      sendMessage: (message, callback) => callback(undefined),
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    const result = await adapter.checkAvailability();
    assert.equal(directFetchCalled, true, 'must fall back to direct fetch when messaging itself is broken');
    assert.equal(result.available, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete global.chrome;
  }
});
