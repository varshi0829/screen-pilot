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
import { LocalVisionAdapter, computeVisionResizeDimensions, normalizeBboxForVision, computeCandidateMarkerPositions } from '../providers/local-vision-adapter.js';

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

// ── P1 #2a: the prompt asks a visual-perception question, not for a plan ────

test('the prompt asks WHICH element is the visual target, not what action to perform', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ elementId: 'el_1', confidence: 0.9 }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter();
    await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    assert.match(sentBody.prompt.toLowerCase(), /visual perception/);
    assert.match(sentBody.prompt, /which/i);
    assert.ok(!sentBody.prompt.includes('"action"'), 'the requested JSON schema must not ask the model to choose an action — that is decision-router.js\'s job, not perception\'s');
    assert.ok(!sentBody.prompt.includes('"click"|"type"|"select"|"navigate"'), 'the old action-enum schema must be gone — the model is not asked to plan an interaction type');
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

// ── P0 #3: plan() must send its configured timeout to the background proxy ──
//
// The proxy previously used its own fixed 15s regardless of which adapter
// called it. plan()'s proxied path (chrome.runtime.sendMessage) now includes
// timeoutMs so the real production request path is actually governed by it.

test('plan() includes timeoutMs (matching VISION_GENERATE_TIMEOUT_MS) in the proxied OLLAMA_GENERATE message', async () => {
  let sentMessage = null;
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessage = message;
        callback({ success: true, data: { response: '{"action":"click","elementId":"el_1","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalVisionAdapter();
    await adapter.plan({
      goal: 'test goal',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });

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
// (OLLAMA_GENERATE with no `prompt`/`images` — Ollama's own load-only
// mechanism, not a second inference task) before the real generate request,
// but only once per warm window.

test('plan() on a cold adapter sends a preload (no prompt/images) OLLAMA_GENERATE before the real generate request', async () => {
  const sentMessages = [];
  global.chrome = {
    runtime: {
      sendMessage: (message, callback) => {
        sentMessages.push(message);
        callback({ success: true, data: { response: '{"action":"click","elementId":"el_1","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalVisionAdapter();
    assert.equal(adapter._warmUntilMs, 0, 'a freshly constructed adapter must not believe it is already warm');

    await adapter.plan({
      goal: 'test goal',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });

    assert.equal(sentMessages.length, 2, 'expected exactly one preload message plus one real generate message');
    const [warmMsg, realMsg] = sentMessages;

    assert.equal(warmMsg.type, 'OLLAMA_GENERATE');
    assert.equal(warmMsg.body.model, adapter._model);
    assert.equal(warmMsg.body.prompt, undefined, 'the preload body must carry no prompt');
    assert.equal(warmMsg.body.images, undefined, 'the preload body must carry no images either — it is load-only');
    assert.equal(warmMsg.body.keep_alive, adapter._keepAlive);

    assert.equal(realMsg.type, 'OLLAMA_GENERATE');
    assert.ok(realMsg.body.prompt, 'the real request must still carry the actual prompt');
    assert.deepEqual(realMsg.body.images, ['img'], 'the real request must still carry the actual screenshot');

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
        callback({ success: true, data: { response: '{"action":"click","elementId":"el_1","confidence":0.9}' } });
      },
    },
  };

  try {
    const adapter = new LocalVisionAdapter();
    const req = { goal: 'g', page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } }, elements: [] };
    await adapter.plan(req);
    assert.equal(sentMessages.length, 2, 'first call: preload + real generate');

    sentMessages.length = 0;
    await adapter.plan(req);

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
          callback({ success: false, error: 'Ollama unavailable' });
        } else {
          callback({ success: true, data: { response: '{"action":"click","elementId":"el_1","confidence":0.9}' } });
        }
      },
    },
  };

  try {
    const adapter = new LocalVisionAdapter();
    const result = await adapter.plan({
      goal: 'test goal',
      page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } },
      elements: []
    });

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
    const adapter = new LocalVisionAdapter();
    const controller = new AbortController();
    controller.abort('stale_plan');

    const result = await adapter.plan(
      { goal: 'test goal', page: { screenshot: { image: 'img', mimeType: 'image/jpeg' } }, elements: [] },
      { signal: controller.signal }
    );

    assert.equal(result.result, 'FAILED');
    assert.equal(result.errorCode, 'ABORTED');
    assert.equal(sendMessageCalled, false, 'an already-aborted signal must short-circuit before any Ollama call, including a preload');
  } finally {
    delete global.chrome;
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

// ── P1 #2b: image resize — ~512px wide, aspect-ratio preserved ──────────────

test('computeVisionResizeDimensions scales a 1024x768 image down to 512x384 (landscape, exact half)', () => {
  const { width, height } = computeVisionResizeDimensions(1024, 768, 512);
  assert.equal(width, 512);
  assert.equal(height, 384);
});

test('computeVisionResizeDimensions preserves aspect ratio for a portrait image', () => {
  // 600x1200 (1:2) at targetWidth=512 -> width=512, height=1024 (still 1:2)
  const { width, height } = computeVisionResizeDimensions(600, 1200, 512);
  assert.equal(width, 512);
  assert.equal(height, 1024);
  assert.equal(Math.round((height / width) * 100) / 100, Math.round((1200 / 600) * 100) / 100, 'aspect ratio must be preserved');
});

test('computeVisionResizeDimensions never upscales an image already narrower than the target', () => {
  const { width, height } = computeVisionResizeDimensions(400, 300, 512);
  assert.equal(width, 400);
  assert.equal(height, 300);
});

test('computeVisionResizeDimensions defaults to ~512px when no target is given', () => {
  const { width } = computeVisionResizeDimensions(1024, 768);
  assert.equal(width, 512);
});

// Stubs the browser-only image APIs (unavailable in Node) so the ACTUAL
// resize code path in local-vision-adapter.js can be exercised end-to-end,
// not just its pure dimension math above.
function stubVisionCanvasGlobals({ sourceWidth, sourceHeight, outputMarker = 'RESIZED_OUTPUT_BYTES' }) {
  const originalCreateImageBitmap = global.createImageBitmap;
  const originalOffscreenCanvas   = global.OffscreenCanvas;
  let drawnSize = null;
  let canvasSize = null;
  let bitmapSourceBlob = null;

  global.createImageBitmap = async (blob) => {
    bitmapSourceBlob = blob;
    return { width: sourceWidth, height: sourceHeight, close: () => {} };
  };
  global.OffscreenCanvas = class {
    constructor(width, height) {
      canvasSize = { width, height };
    }
    getContext() {
      return {
        drawImage: (_bitmap, _sx, _sy, w, h) => { drawnSize = { w, h }; },
      };
    }
    async convertToBlob() {
      const bytes = Uint8Array.from(Buffer.from(outputMarker, 'utf8'));
      return { arrayBuffer: async () => bytes.buffer };
    }
  };

  return {
    getDrawnSize: () => drawnSize,
    getCanvasSize: () => canvasSize,
    getBitmapSourceBlob: () => bitmapSourceBlob,
    restore: () => {
      global.createImageBitmap = originalCreateImageBitmap;
      global.OffscreenCanvas = originalOffscreenCanvas;
    },
  };
}

test('plan() actually resizes a 1024-wide screenshot to ~512px before sending it to Moondream', async () => {
  const stub = stubVisionCanvasGlobals({ sourceWidth: 1024, sourceHeight: 768 });
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ elementId: 'el_1', confidence: 0.9 }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter();
    const originalBase64 = Buffer.from('ORIGINAL_1024PX_REDACTED_IMAGE_BYTES', 'utf8').toString('base64');

    await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: originalBase64, mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    assert.deepEqual(stub.getDrawnSize(), { w: 512, h: 384 }, 'the canvas must be drawn at the resized (~512px-wide) dimensions');
    assert.deepEqual(stub.getCanvasSize(), { width: 512, height: 384 });

    // The image actually sent to Ollama must be the RESIZED output, not the
    // original 1024px bytes — proves the resize is genuinely wired into the
    // real request, not just computed and discarded.
    const sentImage = sentBody.images[0];
    assert.notEqual(sentImage, originalBase64, 'the sent image must be the resized copy, not the original');
    assert.equal(Buffer.from(sentImage, 'base64').toString('utf8'), 'RESIZED_OUTPUT_BYTES');
  } finally {
    stub.restore();
    globalThis.fetch = originalFetch;
  }
});

test('plan() resizing only reads the exact base64 image the caller supplied — no separate/raw image source', async () => {
  const stub = stubVisionCanvasGlobals({ sourceWidth: 1024, sourceHeight: 768 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ elementId: 'el_1', confidence: 0.9 }) }) });

  try {
    const adapter = new LocalVisionAdapter();
    // Simulates an already-redacted screenshot (privacy layer runs upstream,
    // in ScreenshotService, before this adapter ever sees the image — see
    // screenshot-sanitizer.test.mjs for that coverage). This proves resizing
    // operates only on that exact input, never a second/raw capture.
    const redactedBase64 = Buffer.from('ALREADY_REDACTED_SCREENSHOT_BYTES', 'utf8').toString('base64');

    await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: redactedBase64, mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    const blobBytes = await stub.getBitmapSourceBlob().arrayBuffer();
    assert.equal(Buffer.from(blobBytes).toString('utf8'), 'ALREADY_REDACTED_SCREENSHOT_BYTES');
  } finally {
    stub.restore();
    globalThis.fetch = originalFetch;
  }
});

test('a resize failure (missing browser APIs) falls back to sending the original image, never breaking the request', async () => {
  // No stubbing here — createImageBitmap/OffscreenCanvas are genuinely
  // absent in this Node environment, exercising the real fallback path.
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ response: JSON.stringify({ elementId: 'el_1', confidence: 0.9 }) }) };
  };

  try {
    const adapter = new LocalVisionAdapter();
    const originalBase64 = 'ORIGINAL_IMAGE_UNCHANGED';

    const result = await adapter.plan({
      goal: 'Click submit',
      page: { screenshot: { image: originalBase64, mimeType: 'image/jpeg' } },
      elements: [{ id: 'el_1', role: 'button', text: 'Submit' }]
    });

    assert.equal(result.result, 'OK', 'a resize failure must not break plan() — it must still complete successfully');
    assert.equal(sentBody.images[0], originalBase64, 'without a working resize, the original image must still be sent rather than nothing');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Candidate bbox: normalized spatial location, derived from pageState ────
//
// An element with no distinguishing text (a purely visual/icon-only control)
// previously gave the model nothing to connect what it sees in the screenshot
// to which known id that is — id/role/text alone. bbox closes that gap using
// data pageState already extracts (getBoundingClientRect), normalized to a
// 0-1 fraction of the viewport so it stays correct after the screenshot is
// resized for this model. Never invented: an element with no bbox, a
// zero-area bbox, or no known viewport simply omits the field.

test('normalizeBboxForVision: converts a viewport-relative CSS-pixel bbox to a 0-1 fraction', () => {
  const norm = normalizeBboxForVision({ x: 230, y: 620, width: 40, height: 40 }, 1280, 800);
  assert.deepEqual(norm, { x: 0.18, y: 0.775, width: 0.031, height: 0.05 });
});

test('normalizeBboxForVision: a bbox flush with the viewport edges normalizes to the 0-1 range exactly', () => {
  assert.deepEqual(normalizeBboxForVision({ x: 0, y: 0, width: 1280, height: 800 }, 1280, 800),
    { x: 0, y: 0, width: 1, height: 1 });
});

test('normalizeBboxForVision: clamps a bbox that runs past the viewport rather than exceeding 0-1', () => {
  const norm = normalizeBboxForVision({ x: 1200, y: 780, width: 200, height: 100 }, 1280, 800);
  assert.equal(norm.x <= 1 && norm.y <= 1 && norm.width <= 1 && norm.height <= 1, true);
});

test('normalizeBboxForVision: returns null (never a fabricated box) for missing/invalid input', () => {
  assert.equal(normalizeBboxForVision(null, 1280, 800), null, 'no bbox on the element');
  assert.equal(normalizeBboxForVision(undefined, 1280, 800), null, 'no bbox on the element');
  assert.equal(normalizeBboxForVision({ x: 1, y: 1, width: 10, height: 10 }, 0, 0), null, 'no known viewport size');
  assert.equal(normalizeBboxForVision({ x: 1, y: 1, width: 0, height: 10 }, 1280, 800), null, 'zero-area bbox');
  assert.equal(normalizeBboxForVision({ x: 1, y: 1, width: 10, height: 0 }, 1280, 800), null, 'zero-area bbox');
});

test('_buildVisionPrompt: includes normalized bbox for a candidate that has one, alongside its id/role/text', () => {
  global.window = { innerWidth: 1280, innerHeight: 800 };
  try {
    const adapter = new LocalVisionAdapter();
    const prompt = adapter._buildVisionPrompt({
      goal: 'Click the button with the warning icon',
      page: { title: 'Demo', url: 'file:///x' },
      elements: [
        { id: 'el_7', role: 'button', text: '', ariaLabel: '', bbox: { x: 230, y: 620, width: 40, height: 40 } },
      ],
    });
    const candidates = JSON.parse(prompt.match(/\[\{.*\}\]/s)[0]);
    assert.deepEqual(candidates, [
      { id: 'el_7', role: 'button', text: '', bbox: { x: 0.18, y: 0.775, width: 0.031, height: 0.05 } },
    ]);
  } finally {
    delete global.window;
  }
});

test('_buildVisionPrompt: an element with no bbox is handled safely — omitted, not faked', () => {
  global.window = { innerWidth: 1280, innerHeight: 800 };
  try {
    const adapter = new LocalVisionAdapter();
    const prompt = adapter._buildVisionPrompt({
      goal: 'Click submit',
      page: {},
      elements: [{ id: 'el_1', role: 'button', text: 'Submit Profile' }],
    });
    const candidates = JSON.parse(prompt.match(/\[\{.*\}\]/s)[0]);
    assert.deepEqual(candidates, [{ id: 'el_1', role: 'button', text: 'Submit Profile' }]);
    assert.equal('bbox' in candidates[0], false, 'no bbox field at all — never a guessed/default box');
  } finally {
    delete global.window;
  }
});

test('_buildVisionPrompt: with no window available (non-browser context), bbox is omitted for every candidate but id/role/text are unaffected', () => {
  // No global.window stubbed here — matches the real non-extension test
  // context this adapter is also exercised in elsewhere in this file.
  const adapter = new LocalVisionAdapter();
  const prompt = adapter._buildVisionPrompt({
    goal: 'Click the button with the warning icon',
    page: { title: 'Demo', url: 'file:///x' },
    elements: [
      { id: 'el_1', role: 'textbox', text: '', ariaLabel: 'Full Name', bbox: { x: 90, y: 200, width: 500, height: 38 } },
      { id: 'el_7', role: 'button', text: '', ariaLabel: '', bbox: { x: 230, y: 620, width: 40, height: 40 } },
    ],
  });
  const candidates = JSON.parse(prompt.match(/\[\{.*\}\]/s)[0]);
  assert.deepEqual(candidates, [
    { id: 'el_1', role: 'textbox', text: 'Full Name' },
    { id: 'el_7', role: 'button', text: '' },
  ]);
});

test('_buildVisionPrompt: existing candidate ids/roles/text are unchanged by the bbox addition', () => {
  global.window = { innerWidth: 1280, innerHeight: 800 };
  try {
    const adapter = new LocalVisionAdapter();
    const prompt = adapter._buildVisionPrompt({
      goal: 'Click the button with the warning icon',
      page: { title: 'Demo', url: 'file:///x' },
      elements: [
        { id: 'el_1', role: 'textbox', text: '', ariaLabel: 'Full Name', bbox: { x: 90, y: 200, width: 500, height: 38 } },
        { id: 'el_6', role: 'button', text: 'Submit Profile', ariaLabel: '', bbox: { x: 90, y: 620, width: 130, height: 42 } },
      ],
    });
    const candidates = JSON.parse(prompt.match(/\[\{.*\}\]/s)[0]);
    assert.equal(candidates[0].id, 'el_1');
    assert.equal(candidates[0].role, 'textbox');
    assert.equal(candidates[0].text, 'Full Name');
    assert.equal(candidates[1].id, 'el_6');
    assert.equal(candidates[1].role, 'button');
    assert.equal(candidates[1].text, 'Submit Profile');
  } finally {
    delete global.window;
  }
});

test('_buildVisionPrompt: still instructs the model that elementId must exactly match a supplied id', () => {
  const adapter = new LocalVisionAdapter();
  const prompt = adapter._buildVisionPrompt({ goal: 'Click submit', page: {}, elements: [{ id: 'el_1', role: 'button', text: 'Submit' }] });
  assert.match(prompt, /MUST be copied exactly from the list above/);
  assert.match(prompt, /Never invent,\s*\n\s*guess, or construct a new id/);
});

// ── Visual candidate markers: bridging pixels to elementIds on-screen ──────
//
// bbox alone (a number in a JSON list) still asked Moondream to mentally
// project an abstract fraction onto the image and infer which id that
// corresponds to. A marker drawn directly on the screenshot, labeled with the
// exact elementId, turns that into a direct read: find the marker, read the
// label. computeCandidateMarkerPositions is the pure geometry behind that —
// it decides WHERE each marker goes, using only each element's EXISTING
// pageState bbox (via normalizeBboxForVision), never inventing a position.

test('computeCandidateMarkerPositions: places a marker using the existing bbox, scaled to the canvas size', () => {
  const positions = computeCandidateMarkerPositions(
    [{ id: 'el_7', bbox: { x: 230, y: 620, width: 40, height: 40 } }],
    512, 320, 1280, 800,
  );
  assert.deepEqual(positions, [{ id: 'el_7', x: 92, y: 248 }]);
});

test('computeCandidateMarkerPositions: elementId is carried through generically, unrelated to what the element is', () => {
  // No site/element-specific logic: the id string is whatever pageState gave
  // it, verbatim — proven with an arbitrary, non-demo id.
  const positions = computeCandidateMarkerPositions(
    [{ id: 'candidate-42', bbox: { x: 0, y: 0, width: 100, height: 100 } }],
    500, 500, 1000, 1000,
  );
  assert.equal(positions[0].id, 'candidate-42');
});

test('computeCandidateMarkerPositions: multiple candidates each get their own independent marker position', () => {
  const positions = computeCandidateMarkerPositions(
    [
      { id: 'el_1', bbox: { x: 0,   y: 0,   width: 100, height: 20 } },
      { id: 'el_2', bbox: { x: 400, y: 300, width: 50,  height: 50 } },
    ],
    800, 600, 800, 600,
  );
  assert.equal(positions.length, 2);
  assert.notDeepEqual(positions[0], positions[1]);
});

test('computeCandidateMarkerPositions: a candidate with no bbox is omitted, not given a guessed position', () => {
  const positions = computeCandidateMarkerPositions(
    [
      { id: 'el_1', bbox: { x: 10, y: 10, width: 40, height: 40 } },
      { id: 'el_2', bbox: null },
      { id: 'el_3' }, // bbox entirely absent
    ],
    512, 320, 1280, 800,
  );
  assert.equal(positions.length, 1);
  assert.equal(positions[0].id, 'el_1');
});

test('computeCandidateMarkerPositions: a candidate with no id is skipped without crashing', () => {
  const positions = computeCandidateMarkerPositions(
    [{ bbox: { x: 10, y: 10, width: 40, height: 40 } }],
    512, 320, 1280, 800,
  );
  assert.deepEqual(positions, []);
});

test('computeCandidateMarkerPositions: an empty/missing candidate list or canvas size never throws', () => {
  assert.deepEqual(computeCandidateMarkerPositions([], 512, 320, 1280, 800), []);
  assert.deepEqual(computeCandidateMarkerPositions(null, 512, 320, 1280, 800), []);
  assert.deepEqual(computeCandidateMarkerPositions([{ id: 'el_1', bbox: { x: 1, y: 1, width: 1, height: 1 } }], 0, 0, 1280, 800), []);
});

test('plan(): the original screenshot object passed in is never mutated by annotation/resizing', async () => {
  // Guards requirement 6 — annotation must only ever touch the in-memory copy
  // sent to Moondream, never the caller's already-redacted screenshot object
  // (which the cloud fallback still needs, untouched, if vision fails).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ elementId: 'el_1', confidence: 0.9 }) }) });

  try {
    const adapter = new LocalVisionAdapter();
    const screenshot = { image: 'REDACTED_ORIGINAL_BASE64', mimeType: 'image/jpeg' };
    const screenshotSnapshotBefore = { ...screenshot };
    await adapter.plan({
      goal: 'Click the button with the warning icon',
      page: { screenshot },
      elements: [{ id: 'el_1', role: 'button', text: '', bbox: { x: 10, y: 10, width: 40, height: 40 } }],
    });
    assert.deepEqual(screenshot, screenshotSnapshotBefore, 'the caller\'s screenshot object must be untouched by annotation');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('_buildVisionPrompt: candidate id/role/text/bbox data is unchanged by the marker-wording update', () => {
  global.window = { innerWidth: 1280, innerHeight: 800 };
  try {
    const adapter = new LocalVisionAdapter();
    const prompt = adapter._buildVisionPrompt({
      goal: 'Click the button with the warning icon',
      page: { title: 'Demo', url: 'file:///x' },
      elements: [
        { id: 'el_1', role: 'textbox', text: '', ariaLabel: 'Full Name', bbox: { x: 90, y: 200, width: 500, height: 38 } },
        { id: 'el_7', role: 'button', text: '', ariaLabel: '', bbox: { x: 230, y: 620, width: 40, height: 40 } },
      ],
    });
    const candidates = JSON.parse(prompt.match(/\[\{.*\}\]/s)[0]);
    assert.deepEqual(candidates, [
      { id: 'el_1', role: 'textbox', text: 'Full Name', bbox: { x: 0.07, y: 0.25, width: 0.391, height: 0.048 } },
      { id: 'el_7', role: 'button', text: '', bbox: { x: 0.18, y: 0.775, width: 0.031, height: 0.05 } },
    ]);
  } finally {
    delete global.window;
  }
});

test('_buildVisionPrompt: mentions the temporary candidate markers and how to use them', () => {
  const adapter = new LocalVisionAdapter();
  const prompt = adapter._buildVisionPrompt({ goal: 'Click submit', page: {}, elements: [{ id: 'el_1', role: 'button', text: 'Submit' }] });
  assert.match(prompt, /TEMPORARY candidate markers/);
  assert.match(prompt, /not part of\s*\n\s*the real page/);
});

test('_buildVisionPrompt: strict elementId-match and null-allowed rules are unchanged', () => {
  const adapter = new LocalVisionAdapter();
  const prompt = adapter._buildVisionPrompt({ goal: 'Click submit', page: {}, elements: [{ id: 'el_1', role: 'button', text: 'Submit' }] });
  assert.match(prompt, /MUST be copied exactly from the list above/);
  assert.match(prompt, /Never invent,\s*\n\s*guess, or construct a new id/);
  assert.match(prompt, /If none of the listed elements visually match, return elementId: null/);
});
