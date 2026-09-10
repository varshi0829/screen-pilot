// ScreenPilot v3 — Privacy-Safe End-to-End Integration Tests (Phase 3)
//
// Phase 1/2 guaranteed the V2 (v2-task.js → decision-router.js) screenshot
// path is redacted before any cloud/local-vision call. The Phase 3 audit
// found three OLDER call sites in background.js (ANALYZE_GOAL/REANALYZE,
// GET_SCREEN_EXPLANATION, ASK_QUESTION) that captured a screenshot with NO
// sensitive-region info at all, bypassing redaction entirely. This file
// proves the fix: each of those handlers now forwards message.sensitiveRegions
// /message.devicePixelRatio into ScreenshotService.captureVisibleTab(), the
// same contract v2-task.js's own capture path already relies on.
//
// Technique: ScreenshotService and VisionService are both plain exported
// objects (`export const X = {...}`), not frozen, and ES modules are cached
// singletons — so mutating their methods here affects the exact same
// instances background.js calls internally. No experimental module-mocking
// flag needed, no changes to background.js's structure.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { ScreenshotService } from '../services/screenshot-service.js';
import { VisionService } from '../services/vision-service.js';

// ── Minimal chrome/storage stubs (same style as orchestrator.test.mjs / phase4.test.mjs) ──

const _store = {};
let _capturedListener = null;

global.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) delete _store[k];
      },
    },
    session: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) delete _store[k];
      },
    },
  },
  runtime: {
    onMessage: {
      // Captures background.js's real listener so tests can invoke it directly,
      // exactly like a chrome.runtime.sendMessage call from content.js would.
      addListener: (fn) => { _capturedListener = fn; },
    },
    sendMessage: async () => ({ success: false, error: 'test env' }),
  },
  tabs: {
    // Real screenshot capture happens in ScreenshotService, mocked below —
    // this is only reached if a test forgets to mock it, so keep it inert.
    captureVisibleTab: async () => 'data:image/png;base64,x',
  },
  windows: {
    getCurrent: async () => ({ id: 1 }),
  },
};

// Import AFTER the chrome stub is in place — background.js registers its
// onMessage listener and calls ensureInitialized() at module load time.
await import('../background.js');

function sendMessage(message, sender = { tab: { windowId: 1, id: 1 } }) {
  return new Promise((resolve) => {
    _capturedListener(message, sender, resolve);
  });
}

// A 1000+ char string — ScreenshotService.validateScreenshot() requires
// image.length >= 1000 to consider a capture valid.
const FAKE_IMAGE = 'x'.repeat(1200);

function mockCapture() {
  const calls = [];
  ScreenshotService.captureVisibleTab = async (windowId, sensitiveRegions, devicePixelRatio) => {
    calls.push({ windowId, sensitiveRegions, devicePixelRatio });
    return { success: true, image: FAKE_IMAGE, mimeType: 'image/jpeg' };
  };
  return calls;
}

test.beforeEach(() => {
  for (const key of Object.keys(_store)) delete _store[key];
});

// ── ANALYZE_GOAL ──────────────────────────────────────────────────────────────

test('ANALYZE_GOAL forwards message.sensitiveRegions/devicePixelRatio into ScreenshotService.captureVisibleTab', async () => {
  const calls = mockCapture();
  const originalAnalyze = VisionService.analyzeScreenshot;
  VisionService.analyzeScreenshot = async () => ({ success: true, screenSummary: 'ok', instruction: 'Click X', confidence: 0.9 });

  try {
    const sensitiveRegions = [{ x: 1, y: 2, width: 3, height: 4 }];
    await sendMessage({
      type: 'ANALYZE_GOAL',
      goal: 'search for shoes',
      url: 'https://example.com',
      title: 'Example',
      sensitiveRegions,
      devicePixelRatio: 2,
    });

    assert.equal(calls.length, 1, 'ScreenshotService.captureVisibleTab must be called exactly once');
    assert.deepEqual(calls[0].sensitiveRegions, sensitiveRegions);
    assert.equal(calls[0].devicePixelRatio, 2);
  } finally {
    VisionService.analyzeScreenshot = originalAnalyze;
  }
});

// ── GET_SCREEN_EXPLANATION ────────────────────────────────────────────────────

test('GET_SCREEN_EXPLANATION forwards message.sensitiveRegions/devicePixelRatio into ScreenshotService.captureVisibleTab', async () => {
  const calls = mockCapture();
  const originalExplain = VisionService.explainScreen;
  VisionService.explainScreen = async () => ({ success: true, screenContext: { application: 'Test', pageType: 'other' } });

  try {
    const sensitiveRegions = [{ x: 5, y: 6, width: 7, height: 8 }];
    const result = await sendMessage({
      type: 'GET_SCREEN_EXPLANATION',
      url: 'https://example.com',
      title: 'Example',
      sensitiveRegions,
      devicePixelRatio: 1.5,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1, 'ScreenshotService.captureVisibleTab must be called exactly once');
    assert.deepEqual(calls[0].sensitiveRegions, sensitiveRegions);
    assert.equal(calls[0].devicePixelRatio, 1.5);
  } finally {
    VisionService.explainScreen = originalExplain;
  }
});

// ── ASK_QUESTION ──────────────────────────────────────────────────────────────

test('ASK_QUESTION forwards message.sensitiveRegions/devicePixelRatio into ScreenshotService.captureVisibleTab', async () => {
  const calls = mockCapture();
  const originalAsk = VisionService.askQuestion;
  VisionService.askQuestion = async () => ({ success: true, answer: '42', confidence: 0.5, elementHint: '' });

  try {
    const sensitiveRegions = [{ x: 9, y: 10, width: 11, height: 12 }];
    const result = await sendMessage({
      type: 'ASK_QUESTION',
      question: 'what is this page about?',
      url: 'https://example.com',
      title: 'Example',
      sensitiveRegions,
      devicePixelRatio: 3,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1, 'ScreenshotService.captureVisibleTab must be called exactly once');
    assert.deepEqual(calls[0].sensitiveRegions, sensitiveRegions);
    assert.equal(calls[0].devicePixelRatio, 3);
  } finally {
    VisionService.askQuestion = originalAsk;
  }
});

// ── absence is still safe (no regions computed / old caller) ────────────────

test('a caller that omits sensitiveRegions still reaches capture (existing behavior preserved, no crash)', async () => {
  const calls = mockCapture();
  const originalAsk = VisionService.askQuestion;
  VisionService.askQuestion = async () => ({ success: true, answer: 'ok', confidence: 0.5, elementHint: '' });

  try {
    const result = await sendMessage({ type: 'ASK_QUESTION', question: 'anything?', url: 'https://example.com', title: 'Example' });
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sensitiveRegions, undefined);
  } finally {
    VisionService.askQuestion = originalAsk;
  }
});
