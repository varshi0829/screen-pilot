// ScreenPilot v3 — Decision Router: Local Vision PERCEPTION Tier Unit Tests
// (privacy-vision Phase 2, corrected)
//
// decision-router.test.mjs already covers L1/L2/Qwen/cloud behavior in depth;
// this file is additive and focuses only on the local-vision tier so that
// file (and its passing assertions) is left untouched.
//
// Corrected architecture under test: Moondream visual PERCEPTION runs BEFORE
// Qwen (not after) — it is attempted even when Qwen would have succeeded.
// A returned elementId is only ever trusted after DecisionRouter validates it
// against the current page-state element list; the router (not the adapter)
// then wraps the resolved element into a plan via _buildPlanFromElement, the
// same helper L1/L2 already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRouter } from '../services/decision-router.js';

const LOW_CONFIDENCE_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Complex Page',
  elements: [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Search', visible: true, enabled: true },
    { id: 'el_2', role: 'generic', tag: 'div', text: 'Unrelated Content', visible: true, enabled: true }
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

function unavailableVision(reason = 'moondream_unavailable') {
  return { checkAvailability: async () => ({ available: false, reason }) };
}

function unavailableQwen(reason = 'ollama_unavailable') {
  return { checkAvailability: async () => ({ available: false, reason }) };
}

function succeedingQwen(text = 'Qwen Choice') {
  return {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({
      result: 'OK', state: 'planned',
      plan: { steps: [{ targetElement: { text } }] },
      providerMetadata: { provider: 'local-qwen' }
    })
  };
}

// ── L1/L2 behavior is unaffected by the new tier ─────────────────────────────

test('an L1 (deterministic) hit never touches local vision, Qwen, or cloud', async () => {
  let visionCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision });

  const result = await router.route('Submit Order', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }]
  });

  assert.equal(result.layer, 'deterministic');
  assert.equal(visionCalled, false, 'L1 hit must short-circuit before L3 is ever reached');
});

test('an L2 (ML grounding) hit never touches local vision, Qwen, or cloud', async () => {
  let visionCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision });

  const result = await router.route('search item', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }]
  });

  assert.equal(result.layer, 'ml_grounding');
  assert.equal(visionCalled, false, 'L2 hit must short-circuit before L3 is ever reached');
});

// ── cloud mode never touches local vision (mirrors existing Qwen behavior) ──

test('executionMode="cloud" never touches local vision', async () => {
  let visionCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  const router = new DecisionRouter({ cloudAdapter: mockCloud(), localVisionAdapter: mockVision });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(visionCalled, false, 'default/cloud executionMode must never contact local vision, same as Qwen');
});

// ── vision runs BEFORE Qwen, even when Qwen would succeed ───────────────────

test('Moondream is attempted after L1/L2 miss and BEFORE Qwen, even when Qwen would have succeeded', async () => {
  let qwenPlanCalled = false;
  const mockQwen = succeedingQwen();
  const originalPlan = mockQwen.plan;
  mockQwen.plan = async (...args) => { qwenPlanCalled = true; return originalPlan(...args); };

  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: 'el_1', action: 'click', confidence: 0.9, reason: 'visible search button' })
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_vision');
  assert.equal(qwenPlanCalled, false, 'Qwen must never be reached once vision already resolved the step');
});

// ── a valid existing elementId is accepted and wrapped via _buildPlanFromElement ──

test('a valid existing elementId is accepted and wrapped into the standard plan shape', async () => {
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: 'el_1', action: 'click', confidence: 0.91, reason: 'the visible search button matches' })
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision });

  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_vision');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(result.planResponse.plan.steps[0].targetElement.text, 'Search');
  assert.equal(result.planResponse.confidence, 0.91);
  assert.equal(result.planResponse.providerMetadata.provider, 'local_vision');
});

// ── an invented/nonexistent elementId is rejected ────────────────────────────

test('an invented/nonexistent elementId is rejected and falls through to Qwen', async () => {
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: 'el_999_does_not_exist', action: 'click', confidence: 0.9, reason: 'hallucinated id' })
  };
  const mockQwen = succeedingQwen('Qwen Fallback Choice');

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen', 'an unresolvable elementId must never be executed — it must be treated as a failed perception');
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});

test('a null elementId (no visual match) is also treated as unusable, not executed', async () => {
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: null, action: 'click', confidence: 0.2, reason: 'nothing matches' })
  };
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});

// ── Moondream failure safely falls back ──────────────────────────────────────

test('falls back to Qwen when vision is unavailable', async () => {
  const mockVision = unavailableVision('moondream_not_pulled');
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.visionFailureReason, 'moondream_not_pulled');
});

test('falls back to Qwen when vision resolves a FAILED result (real adapter contract, not a thrown exception)', async () => {
  let visionCalls = 0;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { visionCalls++; return { result: 'FAILED', error: 'Local vision model returned invalid JSON', errorCode: 'PARSE_ERROR' }; }
  };
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(visionCalls, 1, 'vision must be attempted exactly once, never retried');
  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.visionFailureReason, 'Local vision model returned invalid JSON');
});

test('falls back to Qwen when vision throws', async () => {
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { throw new Error('vision_down'); }
  };
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.visionFailureReason, 'vision_down');
});

test('falls all the way through to Cloud exactly once when vision and Qwen both fail', async () => {
  let cloudCalls = 0;
  const mockVision = unavailableVision();
  const mockQwen = unavailableQwen();
  const mockCloudAdapter = { plan: async () => { cloudCalls++; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: mockVision,
    localQwenAdapter: mockQwen,
    cloudAdapter: mockCloudAdapter
  });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(cloudCalls, 1);
});

// ── screenshot handling: sanitized screenshot reused, never captured twice, never bypassed ──

test('local vision receives the same lazily-fetched screenshot the cloud fallback would use, captured only once', async () => {
  let screenshotCalls = 0;
  const sanitizedShot = { image: 'SANITIZED_BASE64', mimeType: 'image/jpeg' };
  const getScreenshot = async () => { screenshotCalls++; return sanitizedShot; };

  let receivedScreenshot = null;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => {
      receivedScreenshot = req.page.screenshot;
      return { result: 'OK', elementId: 'el_1', action: 'click', confidence: 0.9 };
    }
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision });
  await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(screenshotCalls, 1, 'screenshot must be captured at most once per planning cycle');
  assert.deepEqual(receivedScreenshot, sanitizedShot, 'local vision must receive the exact same (already-sanitized) screenshot object — never a second, raw capture');
});

test('when vision is unavailable, no screenshot is captured just to check availability', async () => {
  let screenshotCalls = 0;
  const getScreenshot = async () => { screenshotCalls++; return { image: 'x', mimeType: 'image/jpeg' }; };
  const mockVision = unavailableVision();
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision, localQwenAdapter: mockQwen });
  await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(screenshotCalls, 0, 'no screenshot needed at all when vision is unavailable and Qwen (text-only) resolves the step');
});

test('when vision and Qwen both fail, cloud reuses the same already-fetched screenshot instead of capturing a second one', async () => {
  let screenshotCalls = 0;
  const sanitizedShot = { image: 'SANITIZED_BASE64', mimeType: 'image/jpeg' };
  const getScreenshot = async () => { screenshotCalls++; return sanitizedShot; };

  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'FAILED', error: 'vision_failed', errorCode: 'PARSE_ERROR' })
  };
  const mockQwen = unavailableQwen();
  let cloudScreenshot = null;
  const mockCloudAdapter = { plan: async (req) => { cloudScreenshot = req.page.screenshot; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: mockVision,
    localQwenAdapter: mockQwen,
    cloudAdapter: mockCloudAdapter
  });
  const result = await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(result.layer, 'cloud');
  assert.equal(screenshotCalls, 1, 'screenshot must not be captured a second time for the cloud fallback');
  assert.equal(cloudScreenshot.image, 'SANITIZED_BASE64');
});
