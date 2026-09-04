// ScreenPilot v2 — Decision Router Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRouter } from '../services/decision-router.js';

test('DecisionRouter defaults executionMode to "cloud" for a fresh installation (no stored preference)', () => {
  // v2-task.js destructures { executionMode = 'cloud' } from chrome.storage.local.get(),
  // which resolves to {} on a fresh install. DecisionRouter's own constructor default
  // must agree, since it is the single source of truth for L3 backend selection.
  const router = new DecisionRouter();
  assert.equal(router.executionMode, 'cloud');
});

test('DecisionRouter routes to Layer 1 (Deterministic Fast Path) on exact text match', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com',
    title: 'Test',
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }
    ]
  };

  const result = await router.route('Submit Order', pageState);

  assert.equal(result.layer, 'deterministic');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.planResponse.plan.steps[0].targetElement.text, 'Submit Order');
  assert.ok(result.planResponse.confidence >= 0.85);
});

test('DecisionRouter routes to Layer 2 (Small ML Grounding Model) on fuzzy match >= 0.70', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com',
    title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }
    ]
  };

  const result = await router.route('search item', pageState);

  assert.equal(result.layer, 'ml_grounding');
  assert.equal(result.planResponse.result, 'OK');
  assert.ok(result.planResponse.confidence >= 0.70);
});

const LOW_CONFIDENCE_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Complex Page',
  elements: [
    { id: 'el_1', role: 'generic', tag: 'div', text: 'Unrelated Content', visible: true, enabled: true }
  ]
};
const LOW_CONFIDENCE_GOAL = 'Perform complex multi-step workflow';

function mockCloud(planResponse) {
  return { plan: async () => planResponse ?? {
    result: 'OK',
    state: 'planned',
    plan: { steps: [{ targetElement: { text: 'Cloud Choice' } }] },
    providerMetadata: { provider: 'cloud' }
  } };
}

test('DecisionRouter L3 defaults to Cloud and never touches Qwen when executionMode is unset', async () => {
  let qwenCalled = false;
  const mockQwen = {
    checkAvailability: async () => { qwenCalled = true; return { available: true }; },
    plan: async () => { qwenCalled = true; throw new Error('Qwen should not be called in cloud mode'); }
  };
  const router = new DecisionRouter({ localQwenAdapter: mockQwen, cloudAdapter: mockCloud() });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(result.planResponse.providerMetadata.provider, 'cloud');
  assert.equal(qwenCalled, false, 'default executionMode must never contact Ollama');
});

test('DecisionRouter routes to Layer 3 Local Qwen when executionMode=local-qwen and Ollama is available', async () => {
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({
      result: 'OK',
      state: 'planned',
      plan: { steps: [{ targetElement: { text: 'Complex Choice' } }] },
      providerMetadata: { provider: 'local-qwen' }
    })
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.planResponse.providerMetadata.provider, 'local-qwen');
  assert.equal(result.qwenFailureReason, null);
});

test('DecisionRouter falls back to Cloud exactly once when Qwen is enabled but unavailable', async () => {
  let cloudCalls = 0;
  const mockQwen = { checkAvailability: async () => ({ available: false, reason: 'Ollama server not reachable' }) };
  const mockCloudAdapter = { plan: async () => { cloudCalls++; return mockCloud().plan(); } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, cloudAdapter: mockCloudAdapter });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(cloudCalls, 1);
  assert.equal(result.qwenFailureReason, 'Ollama server not reachable');
});

test('DecisionRouter falls back to Cloud exactly once when Qwen is available but its plan() call fails', async () => {
  let qwenCalls = 0;
  let cloudCalls = 0;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { qwenCalls++; throw new Error('qwen_timeout_10000ms'); }
  };
  const mockCloudAdapter = { plan: async () => { cloudCalls++; return (await mockCloud().plan()); } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, cloudAdapter: mockCloudAdapter });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(qwenCalls, 1, 'Qwen must be attempted exactly once, never retried');
  assert.equal(cloudCalls, 1, 'Cloud must be attempted exactly once as fallback');
  assert.equal(result.qwenFailureReason, 'qwen_timeout_10000ms');
});

// LocalQwenAdapter.plan() never throws on failure — every failure path (timeout,
// Ollama unreachable, bad JSON, HTTP error) resolves a { result: 'FAILED',
// errorCode, error } object (see local-qwen-adapter.js's _networkFailure). These
// two tests use that exact real-world shape instead of a throwing mock, since a
// throw-based mock does not exercise the code path the real adapter takes.
test('DecisionRouter falls back to Cloud exactly once when Qwen resolves a FAILED result (real adapter contract, not a thrown exception)', async () => {
  let qwenCalls = 0;
  let cloudCalls = 0;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => {
      qwenCalls++;
      return { schemaVersion: '1', result: 'FAILED', blockers: [], confidence: 0,
        providerMetadata: { provider: 'local-qwen' }, error: 'Local Qwen inference timed out', errorCode: 'TIMEOUT' };
    }
  };
  const mockCloudAdapter = { plan: async () => { cloudCalls++; return (await mockCloud().plan()); } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, cloudAdapter: mockCloudAdapter });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(qwenCalls, 1, 'Qwen must be attempted exactly once, never retried');
  assert.equal(cloudCalls, 1, 'a resolved FAILED result must still trigger the one-time cloud fallback');
  assert.equal(result.layer, 'cloud');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.qwenFailureReason, 'Local Qwen inference timed out');
});

test('DecisionRouter resolves (does not throw) a terminal FAILED result when both Qwen and Cloud resolve FAILED (real adapter contract)', async () => {
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'FAILED', blockers: [], confidence: 0, error: 'Ollama returned status 500', errorCode: 'OLLAMA_ERROR' })
  };
  const mockCloudAdapter = {
    plan: async () => ({ schemaVersion: '1', result: 'FAILED', blockers: [], confidence: 0,
      providerMetadata: { provider: 'gemini' }, error: 'Request to /api/plan timed out after 30s', errorCode: 'REQUEST_TIMEOUT' })
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, cloudAdapter: mockCloudAdapter });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  // v2-task.js's resolveOutcome() turns this into PLAN_FAILED via the normal
  // (non-exception) path — route() must resolve, not reject, for that to work.
  assert.equal(result.layer, 'cloud');
  assert.equal(result.planResponse.result, 'FAILED');
  assert.equal(result.planResponse.errorCode, 'REQUEST_TIMEOUT');
  assert.equal(result.qwenFailureReason, 'Ollama returned status 500');
});

test('DecisionRouter surfaces a terminal failure (no retry loop) when both Qwen and Cloud fail', async () => {
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { throw new Error('qwen_down'); }
  };
  const mockCloudAdapter = { plan: async () => { throw new Error('cloud_down'); } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, cloudAdapter: mockCloudAdapter });

  await assert.rejects(
    () => router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE),
    /cloud_down/
  );
});

test('DecisionRouter Layer 3 cloud call lazily fetches the screenshot only when cloud is actually invoked', async () => {
  let screenshotCalls = 0;
  const getScreenshot = async () => { screenshotCalls++; return { image: 'abc', mimeType: 'image/png' }; };
  const mockCloudAdapter = { plan: async (req) => {
    assert.equal(req.page.screenshot.image, 'abc');
    return mockCloud().plan();
  } };

  const router = new DecisionRouter({ cloudAdapter: mockCloudAdapter });

  // L1 hit — screenshot must never be requested.
  const hitResult = await router.route('Submit Order', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }]
  }, { cloudContext: { getScreenshot } });
  assert.equal(hitResult.layer, 'deterministic');
  assert.equal(screenshotCalls, 0);

  // L1/L2 miss — cloud is invoked, screenshot must be requested exactly once.
  const missResult = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE, { cloudContext: { getScreenshot } });
  assert.equal(missResult.layer, 'cloud');
  assert.equal(screenshotCalls, 1);
});
