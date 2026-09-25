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
    value: '',
    confidence: 0.95,
    reason: 'Clicks search button'
  };

  // targetElement.text must come from the ACTUAL resolved element's own
  // label (request.elements lookup), never from qwenOutput directly — this
  // is what DOMMatcher uses to relocate the element, so it must be real
  // element metadata, not anything Qwen wrote in prose.
  const response = adapter._formatPlanResponse(
    { goal: 'Search for products', elements: [{ id: 'el_2', text: 'Submit Search', role: 'button' }] },
    qwenOutput,
    150
  );

  assert.equal(response.result, 'OK');
  assert.equal(response.state, 'planned');
  assert.equal(response.plan.steps.length, 1);
  assert.equal(response.plan.steps[0].targetElement.text, 'Submit Search');
  assert.equal(response.plan.steps[0].targetElement.value, '', 'a click action must carry no value');
  assert.equal(response.providerMetadata.provider, 'local-qwen');
});

// ── Generic target/value separation ──────────────────────────────────────────
//
// These tests prove the ADAPTER correctly threads whatever semantic
// extraction Qwen performed into distinct fields — they do NOT encode any
// sentence template, website name, or phrase pattern of their own. The
// "qwenOutput.value" in each case stands in for whatever value a real Qwen
// call would have extracted for that (unseen-by-this-test) natural-language
// goal; the assertions only check that the adapter never substitutes the
// goal string or the target's own label for it, and vice versa.

const GENERIC_FILL_CASES = [
  { elementId: 'el_a', elementLabel: 'Search this site',    value: 'artificial intelligence' },
  { elementId: 'el_b', elementLabel: 'Find on this page',   value: 'JavaScript promises' },
  { elementId: 'el_c', elementLabel: 'Look up a topic',     value: 'machine learning' },
  { elementId: 'el_d', elementLabel: 'Enter your query',    value: 'Python tutorials' },
];

for (const { elementId, elementLabel, value } of GENERIC_FILL_CASES) {
  test(`a "type" action keeps the extracted value ("${value}") fully separate from the target's own label ("${elementLabel}")`, () => {
    const adapter = new LocalQwenAdapter();
    const qwenOutput = { action: 'type', elementId, value, confidence: 0.9 };
    const response = adapter._formatPlanResponse(
      { goal: 'irrelevant to this assertion', elements: [{ id: elementId, text: elementLabel, role: 'textbox', tag: 'input' }] },
      qwenOutput,
      100
    );

    const step = response.plan.steps[0];
    assert.equal(step.targetElement.text, elementLabel, 'targetElement.text (used for DOM matching) must be the element\'s real label, never the value');
    assert.equal(step.targetElement.value, value, 'targetElement.value must be exactly the extracted payload');
    assert.notEqual(step.targetElement.text, value, 'the label and the value must never collapse into the same string');
    assert.ok(step.description.includes(value), 'the user-facing description must mention the actual value');
    assert.ok(step.description.includes(elementLabel), 'the user-facing description must also identify the target by its real label');
  });
}

test('value never falls back to the goal string when Qwen omits it', () => {
  const adapter = new LocalQwenAdapter();
  const qwenOutput = { action: 'type', elementId: 'el_1', confidence: 0.9 }; // no value field at all
  const response = adapter._formatPlanResponse(
    { goal: 'Search Wikipedia for artificial intelligence', elements: [{ id: 'el_1', text: 'Search Wikipedia', role: 'searchbox' }] },
    qwenOutput,
    100
  );

  const step = response.plan.steps[0];
  assert.equal(step.targetElement.value, '', 'a missing value must stay empty, never default to the goal sentence');
  assert.ok(!step.description.includes('Search Wikipedia for artificial intelligence'), 'the raw goal sentence must never appear as the instruction');
});

test('value is ignored (forced empty) for non-"type" actions even if the model mistakenly supplies one', () => {
  const adapter = new LocalQwenAdapter();
  const qwenOutput = { action: 'click', elementId: 'el_1', value: 'should be ignored', confidence: 0.9 };
  const response = adapter._formatPlanResponse(
    { goal: 'irrelevant', elements: [{ id: 'el_1', text: 'Some Button', role: 'button' }] },
    qwenOutput,
    100
  );

  assert.equal(response.plan.steps[0].targetElement.value, '', 'value must only ever be populated for a "type" action');
});

test('targetElement.text falls back to the elementId (never the goal) when the id does not resolve against the given elements', () => {
  const adapter = new LocalQwenAdapter();
  const qwenOutput = { action: 'type', elementId: 'el_unknown', value: 'some value', confidence: 0.9 };
  const response = adapter._formatPlanResponse(
    { goal: 'Search Wikipedia for artificial intelligence', elements: [{ id: 'el_1', text: 'Unrelated Element' }] },
    qwenOutput,
    100
  );

  const step = response.plan.steps[0];
  assert.notEqual(step.targetElement.text, 'Search Wikipedia for artificial intelligence', 'must never fall back to the raw goal sentence');
  assert.equal(step.targetElement.text, 'el_unknown');
});

test('_buildQwenPrompt asks Qwen to distinguish TARGET from VALUE generically, with no site/phrase-specific instructions', () => {
  const adapter = new LocalQwenAdapter();
  const prompt = adapter._buildQwenPrompt({
    goal: 'irrelevant',
    page: { url: '', title: '' },
    elements: [{ id: 'el_1', role: 'textbox', text: 'Some Field' }]
  });

  assert.match(prompt, /TARGET/);
  assert.match(prompt, /VALUE/);
  assert.match(prompt, /"value"/);
  // The schema must no longer contain the old overloaded "text" output field.
  assert.ok(!prompt.includes('"text":"label"'), 'the old ambiguous text/label schema field must be gone');
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

// ── P0 #3: plan() must send its configured timeout to the background proxy ──
//
// The proxy previously used its own fixed 15s regardless of which adapter
// called it. plan()'s proxied path (chrome.runtime.sendMessage) now includes
// timeoutMs so the real production request path is actually governed by it.

test('plan() includes timeoutMs (matching QWEN_GENERATE_TIMEOUT_MS) in the proxied OLLAMA_GENERATE message', async () => {
  let sentMessage = null;
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessage = message;
        callback({ success: true, data: { response: '{"action":"finish","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    await adapter.plan({ goal: 'test goal', page: { url: '', title: '' }, elements: [] });

    assert.equal(sentMessage.type, 'OLLAMA_GENERATE');
    assert.equal(typeof sentMessage.timeoutMs, 'number', 'timeoutMs must be a real number, not omitted');
    assert.ok(sentMessage.timeoutMs > 0);
  } finally {
    delete global.chrome;
  }
});

// ── P1 #1: warm the selected model before its first real generation ────────
//
// A cold adapter's plan() call must issue a lightweight preload
// (OLLAMA_GENERATE with no `prompt` — Ollama's own load-only mechanism, not a
// second inference task) before the real generate request, but only once per
// warm window — a subsequent plan() call while still "warm" must not repeat it.

test('plan() on a cold adapter sends a preload (no prompt) OLLAMA_GENERATE before the real generate request', async () => {
  const sentMessages = [];
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessages.push(message);
        callback({ success: true, data: { response: '{"action":"finish","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    assert.equal(adapter._warmUntilMs, 0, 'a freshly constructed adapter must not believe it is already warm');

    await adapter.plan({ goal: 'test goal', page: { url: '', title: '' }, elements: [] });

    assert.equal(sentMessages.length, 2, 'expected exactly one preload message plus one real generate message');
    const [warmMsg, realMsg] = sentMessages;

    assert.equal(warmMsg.type, 'OLLAMA_GENERATE');
    assert.equal(warmMsg.body.model, adapter._model);
    assert.equal(warmMsg.body.prompt, undefined, 'the preload body must carry no prompt — this is what makes it a load-only call, not a second inference task');
    assert.equal(warmMsg.body.keep_alive, adapter._keepAlive);

    assert.equal(realMsg.type, 'OLLAMA_GENERATE');
    assert.ok(realMsg.body.prompt, 'the real request must still carry the actual prompt');

    assert.ok(adapter._warmUntilMs > Date.now(), 'a successful preload must mark the model as warm for a future window');
  } finally {
    delete global.chrome;
  }
});

test('a second plan() call while still warm sends only the real generate request — no duplicate preload', async () => {
  const sentMessages = [];
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessages.push(message);
        callback({ success: true, data: { response: '{"action":"finish","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    await adapter.plan({ goal: 'first call', page: { url: '', title: '' }, elements: [] });
    assert.equal(sentMessages.length, 2, 'first call: preload + real generate');

    sentMessages.length = 0;
    await adapter.plan({ goal: 'second call', page: { url: '', title: '' }, elements: [] });

    assert.equal(sentMessages.length, 1, 'second call while still warm must send only the real generate request, no repeated preload');
    assert.ok(sentMessages[0].body.prompt, 'the single message sent must be the real request, not another preload');
  } finally {
    delete global.chrome;
  }
});

test('a preload failure does not prevent the real generate call or the plan() result', async () => {
  let callCount = 0;
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        callCount++;
        if (callCount === 1) {
          // Preload fails.
          callback({ success: false, error: 'Ollama unavailable' });
        } else {
          callback({ success: true, data: { response: '{"action":"finish","confidence":0.9}' } });
        }
      },
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    const result = await adapter.plan({ goal: 'test goal', page: { url: '', title: '' }, elements: [] });

    assert.equal(callCount, 2, 'the real generate call must still be attempted after a failed preload');
    assert.equal(result.result, 'OK', 'plan() must still succeed via the real call despite the preload failing');
    assert.equal(adapter._warmUntilMs > Date.now(), true, 'the real call succeeding must still mark the model warm, even though the preload itself failed');
  } finally {
    delete global.chrome;
  }
});

test('an already-aborted caller signal skips the preload entirely (no chrome.runtime call at all)', async () => {
  let sendMessageCalled = false;
  global.chrome = {
    runtime: {
      sendMessage: () => { sendMessageCalled = true; },
    },
  };

  try {
    const adapter = new LocalQwenAdapter();
    const controller = new AbortController();
    controller.abort('stale_plan');

    const result = await adapter.plan({ goal: 'test goal', page: { url: '', title: '' }, elements: [] }, { signal: controller.signal });

    assert.equal(result.result, 'FAILED');
    assert.equal(result.errorCode, 'ABORTED');
    assert.equal(sendMessageCalled, false, 'an already-aborted signal must short-circuit before any Ollama call, including a preload');
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
