// ScreenPilot v3 — Decision Router: L3 Router (Moondream vs Qwen) Unit Tests
//
// decision-router.test.mjs already covers L1/L2/Qwen/cloud behavior in depth;
// this file is additive and focuses on the L3 router so that file (and its
// passing assertions) is left untouched.
//
// Architecture under test (P0 #2 — one local model per planning cycle):
// L3 picks EXACTLY ONE local provider per cycle, never both:
//   - ANY L2-ranked candidate at all (even below L2's 0.70 threshold) ->
//     Qwen (text reasoning) is used.
//   - ZERO L2-ranked candidates (the DOM/text representation genuinely has
//     nothing to offer) -> Moondream (visual perception) is used.
// Whichever one is chosen, on failure/unavailability the router falls
// straight through to Cloud — it does NOT then try the other local
// provider in the same cycle.
//
// A returned elementId from Moondream is only ever trusted after
// DecisionRouter validates it against the current page-state element list;
// the router (not the adapter) then wraps the resolved element into a plan
// via _buildPlanFromElement, the same helper L1/L2 already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRouter } from '../services/decision-router.js';

// Genuine (not floor-inflated) partial lexical overlap: with P0 #1's
// IDF-weighted coverage scoring, "Billing" covers part of the goal's
// vocabulary and "Update Profile Details" covers a different part — top
// score lands below L2's 0.70 threshold (L2 correctly misses) while
// ranked.length > 0 (some real signal exists) -> the router picks QWEN.
const HAS_TEXT_CANDIDATES_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Complex Page',
  elements: [
    { id: 'el_1', role: 'link', tag: 'a', text: 'Billing', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Update Profile Details', visible: true, enabled: true }
  ]
};

// No elements at all -> UIGroundingService.rankElements returns [] -> the
// router picks MOONDREAM (the DOM/text representation offers nothing).
const NO_TEXT_CANDIDATES_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Complex Page',
  elements: []
};

const LOW_CONFIDENCE_GOAL = 'Update my billing address details';

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
      result: 'OK', state: 'planned', confidence: 0.9,
      // Phase 6: Qwen's answer is only trusted if its elementId is one it was offered.
      plan: { steps: [{ targetElement: { text, elementId: 'el_1' } }] },
      providerMetadata: { provider: 'local-qwen' }
    })
  };
}

function succeedingVision(elementId = 'el_1') {
  return {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId, action: 'click', confidence: 0.9, reason: 'visual match' })
  };
}

// ── L1/L2 behavior is unaffected by the router ──────────────────────────────

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

// ── cloud mode never touches local vision or Qwen ───────────────────────────

test('executionMode="cloud" never touches local vision or Qwen', async () => {
  let visionCalled = false;
  let qwenCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };
  const router = new DecisionRouter({ cloudAdapter: mockCloud(), localVisionAdapter: mockVision, localQwenAdapter: mockQwen });

  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(visionCalled, false, 'default/cloud executionMode must never contact local vision');
  assert.equal(qwenCalled, false, 'default/cloud executionMode must never contact Qwen');
});

// ── router: exactly one local provider per cycle, chosen by candidate presence ──

test('router chooses Qwen when L2 found at least one candidate — Moondream is never touched', async () => {
  let visionCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, HAS_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'local_qwen');
  assert.equal(visionCalled, false, 'Moondream must never be invoked in the same cycle as Qwen');
});

test('router chooses Moondream when L2 found zero candidates — Qwen is never touched', async () => {
  // scoreElement() returns 0.0 (filtered out of `ranked`) for an invisible
  // element, but it still exists in `elements` for elementId validation —
  // this is how "zero text candidates, but a real element still exists for
  // a visual pick" arises honestly under the current (unchanged) L2 scoring.
  const pageState = {
    url: 'https://example.com', title: 'Complex Page',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Search', visible: false, enabled: true }]
  };
  let qwenCalled = false;
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };
  const mockVision = succeedingVision('el_1');

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision });
  const result = await router.route(LOW_CONFIDENCE_GOAL, pageState);

  assert.equal(result.layer, 'local_vision');
  assert.equal(qwenCalled, false, 'Qwen must never be invoked in the same cycle as Moondream');
});

// ── a valid existing elementId is accepted and wrapped via _buildPlanFromElement ──

test('a valid existing elementId is accepted and wrapped into the standard plan shape', async () => {
  const mockVision = succeedingVision('el_1');
  // NO_TEXT_CANDIDATES_PAGE_STATE has no elements to validate against — use a
  // page state with a real element but force the router into vision mode by
  // giving L2 nothing to rank (an element L2 would never score, e.g. hidden).
  const pageState = {
    url: 'https://example.com', title: 'Complex Page',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Search', visible: true, enabled: true }]
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision });

  // This page state DOES have a rankable candidate, so the router would
  // normally choose Qwen. To exercise vision's own elementId-validation path
  // directly, call the router's internal method with an empty ranked list —
  // this is exactly the shape route() passes when NO_TEXT_CANDIDATES applies,
  // just reusing a page state that has a resolvable element for validation.
  const result = await router._runLayer3(LOW_CONFIDENCE_GOAL, pageState, pageState.elements, {}, []);

  assert.equal(result.layer, 'local_vision');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(result.planResponse.plan.steps[0].targetElement.text, 'Search');
  assert.equal(result.planResponse.confidence, 0.9);
  assert.equal(result.planResponse.providerMetadata.provider, 'local_vision');
});

// ── an invented/nonexistent elementId is rejected — falls to CLOUD, not Qwen ──

test('an invented/nonexistent elementId is rejected and falls straight to Cloud (never to Qwen)', async () => {
  let qwenCalled = false;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: 'el_999_does_not_exist', action: 'click', confidence: 0.9, reason: 'hallucinated id' })
  };
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };
  const mockCloudAdapter = mockCloud();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloudAdapter });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud', 'an unresolvable elementId must never be executed, and must not trigger a same-cycle Qwen attempt');
  assert.equal(qwenCalled, false, 'Qwen must never be invoked in the same cycle vision was chosen for');
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});

test('a null elementId (no visual match) is also treated as unusable — falls to Cloud, not Qwen', async () => {
  let qwenCalled = false;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: null, action: 'click', confidence: 0.2, reason: 'nothing matches' })
  };
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(qwenCalled, false);
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});

// ── Moondream failure falls straight to Cloud (never to Qwen) ──────────────

test('falls to Cloud (not Qwen) when vision is unavailable', async () => {
  let qwenCalled = false;
  const mockVision = unavailableVision('moondream_not_pulled');
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(qwenCalled, false, 'Qwen must not be consulted just because vision was unavailable in a vision-routed cycle');
  assert.equal(result.visionFailureReason, 'moondream_not_pulled');
});

test('falls to Cloud (not Qwen) when vision resolves a FAILED result (real adapter contract, not a thrown exception)', async () => {
  let visionCalls = 0;
  let qwenCalled = false;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { visionCalls++; return { result: 'FAILED', error: 'Local vision model returned invalid JSON', errorCode: 'PARSE_ERROR' }; }
  };
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(visionCalls, 1, 'vision must be attempted exactly once, never retried');
  assert.equal(qwenCalled, false);
  assert.equal(result.layer, 'cloud');
  assert.equal(result.visionFailureReason, 'Local vision model returned invalid JSON');
});

test('falls to Cloud (not Qwen) when vision throws', async () => {
  let qwenCalled = false;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { throw new Error('vision_down'); }
  };
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(qwenCalled, false);
  assert.equal(result.visionFailureReason, 'vision_down');
});

// ── Qwen failure falls straight to Cloud (never to Moondream) ──────────────

test('falls to Cloud (not Moondream) when Qwen is unavailable', async () => {
  let visionCalled = false;
  const mockQwen = unavailableQwen();
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, HAS_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(visionCalled, false, 'Moondream must not be consulted just because Qwen was unavailable in a Qwen-routed cycle');
  assert.equal(result.qwenFailureReason, 'ollama_unavailable');
});

test('falls to Cloud (not Moondream) when Qwen resolves a FAILED result', async () => {
  let qwenCalls = 0;
  let visionCalled = false;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => { qwenCalls++; return { result: 'FAILED', error: 'Local Qwen inference timed out', errorCode: 'TIMEOUT' }; }
  };
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen, localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  const result = await router.route(LOW_CONFIDENCE_GOAL, HAS_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(qwenCalls, 1, 'Qwen must be attempted exactly once, never retried');
  assert.equal(visionCalled, false);
  assert.equal(result.layer, 'cloud');
  assert.equal(result.qwenFailureReason, 'Local Qwen inference timed out');
});

test('falls all the way through to Cloud exactly once when the routed provider (vision) fails and Qwen was never chosen', async () => {
  let cloudCalls = 0;
  const mockVision = unavailableVision();
  const mockCloudAdapter = { plan: async () => { cloudCalls++; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: mockVision,
    cloudAdapter: mockCloudAdapter
  });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE);

  assert.equal(result.layer, 'cloud');
  assert.equal(cloudCalls, 1);
});

// ── screenshot handling: sanitized screenshot reused, never captured twice, never bypassed ──

test('local vision (chosen because there are zero text candidates) receives the same lazily-fetched screenshot the cloud fallback would use, captured only once', async () => {
  let screenshotCalls = 0;
  const sanitizedShot = { image: 'SANITIZED_BASE64', mimeType: 'image/jpeg' };
  const getScreenshot = async () => { screenshotCalls++; return sanitizedShot; };

  let receivedScreenshot = null;
  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => {
      receivedScreenshot = req.page.screenshot;
      return { result: 'OK', elementId: null, action: 'click', confidence: 0.9 };
    }
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: mockVision, cloudAdapter: mockCloud() });
  await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(screenshotCalls, 1, 'screenshot must be captured at most once per planning cycle');
  assert.deepEqual(receivedScreenshot, sanitizedShot, 'local vision must receive the exact same (already-sanitized) screenshot object — never a second, raw capture');
});

test('when there are viable text candidates, Qwen is chosen and no screenshot is ever captured', async () => {
  let screenshotCalls = 0;
  const getScreenshot = async () => { screenshotCalls++; return { image: 'x', mimeType: 'image/jpeg' }; };
  const mockQwen = succeedingQwen();

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });
  await router.route(LOW_CONFIDENCE_GOAL, HAS_TEXT_CANDIDATES_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(screenshotCalls, 0, 'Qwen is text-only and Qwen succeeded — no screenshot should ever be captured');
});

test('when the routed Qwen attempt fails, cloud captures the screenshot exactly once (Moondream never touched, no double capture)', async () => {
  let screenshotCalls = 0;
  const sanitizedShot = { image: 'SANITIZED_BASE64', mimeType: 'image/jpeg' };
  const getScreenshot = async () => { screenshotCalls++; return sanitizedShot; };

  const mockQwen = unavailableQwen();
  let visionCalled = false;
  const mockVision = { checkAvailability: async () => { visionCalled = true; return { available: true }; } };
  let cloudScreenshot = null;
  const mockCloudAdapter = { plan: async (req) => { cloudScreenshot = req.page.screenshot; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: mockQwen,
    localVisionAdapter: mockVision,
    cloudAdapter: mockCloudAdapter
  });
  const result = await router.route(LOW_CONFIDENCE_GOAL, HAS_TEXT_CANDIDATES_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(result.layer, 'cloud');
  assert.equal(visionCalled, false);
  assert.equal(screenshotCalls, 1);
  assert.equal(cloudScreenshot.image, 'SANITIZED_BASE64');
});

test('when the routed vision attempt fails, cloud reuses the same already-fetched screenshot instead of capturing a second one', async () => {
  let screenshotCalls = 0;
  const sanitizedShot = { image: 'SANITIZED_BASE64', mimeType: 'image/jpeg' };
  const getScreenshot = async () => { screenshotCalls++; return sanitizedShot; };

  const mockVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'FAILED', error: 'vision_failed', errorCode: 'PARSE_ERROR' })
  };
  let cloudScreenshot = null;
  const mockCloudAdapter = { plan: async (req) => { cloudScreenshot = req.page.screenshot; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: mockVision,
    cloudAdapter: mockCloudAdapter
  });
  const result = await router.route(LOW_CONFIDENCE_GOAL, NO_TEXT_CANDIDATES_PAGE_STATE, { cloudContext: { getScreenshot } });

  assert.equal(result.layer, 'cloud');
  assert.equal(screenshotCalls, 1, 'screenshot must not be captured a second time for the cloud fallback');
  assert.equal(cloudScreenshot.image, 'SANITIZED_BASE64');
});

// ── Sole unlabeled interactive candidate: structural fallback after a ──────
// ── null/invalid Moondream elementId ────────────────────────────────────────
//
// When visual perception ran but named nothing usable (null, or an id that
// doesn't match anything in the current page state), and exactly ONE
// candidate is an "unlabeled interactive control" (an interactive role/tag
// with no text/ariaLabel/placeholder/value, but a valid id and a real bbox —
// the same generic shape a visually-only icon control has), the router
// resolves it deterministically instead of paying for Cloud. Two or more
// such candidates is genuine ambiguity and still falls through to Cloud,
// unchanged. Every fixture here is synthetic/generic — no site, selector, id
// naming, color, or icon knowledge is involved anywhere in this mechanism.

const nullElementIdVision = {
  checkAvailability: async () => ({ available: true }),
  plan: async () => ({ result: 'OK', elementId: null, action: 'click', confidence: 0.2, reason: 'nothing matches' }),
};

const UNLABELED_INTERACTIVE = (id) => ({
  id, role: 'button', tag: 'button', text: '', ariaLabel: '', placeholder: '', value: '',
  visible: true, enabled: true, bbox: { x: 10, y: 10, width: 40, height: 40 },
});

test('sole eligible unlabeled interactive candidate → resolved deterministically, no model/cloud call', async () => {
  let qwenCalled = false, cloudCalled = false;
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };
  const mockCloudAdapter = { plan: async () => { cloudCalled = true; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    localQwenAdapter: mockQwen,
    cloudAdapter: mockCloudAdapter,
  });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [UNLABELED_INTERACTIVE('el_7')],
  });

  assert.equal(result.layer, 'local_vision', 'resolved as a structural vision-tier pick, not escalated');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_7');
  assert.equal(qwenCalled, false, 'must not invoke a second local model');
  assert.equal(cloudCalled, false, 'must not fall through to cloud when unambiguous');
});

test('two equally eligible unlabeled interactive candidates → ambiguous, falls through to Cloud unchanged', async () => {
  let cloudCalled = false;
  const mockCloudAdapter = { plan: async () => { cloudCalled = true; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    cloudAdapter: mockCloudAdapter,
  });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [UNLABELED_INTERACTIVE('el_7'), UNLABELED_INTERACTIVE('el_8')],
  });

  assert.equal(result.layer, 'cloud', 'ambiguity between candidates must preserve the existing cloud fallback');
  assert.equal(cloudCalled, true);
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});

test('a candidate with text is not treated as unlabeled — does not trigger the structural fallback', async () => {
  let cloudCalled = false;
  const mockCloudAdapter = { plan: async () => { cloudCalled = true; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    cloudAdapter: mockCloudAdapter,
  });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [{ ...UNLABELED_INTERACTIVE('el_7'), text: 'Some Label' }],
  });

  assert.equal(result.layer, 'cloud', 'a labeled candidate is not eligible — no unlabeled candidate exists, so cloud fallback proceeds');
  assert.equal(cloudCalled, true);
});

test('a candidate with no bbox is not eligible for the structural fallback', async () => {
  let cloudCalled = false;
  const mockCloudAdapter = { plan: async () => { cloudCalled = true; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    cloudAdapter: mockCloudAdapter,
  });
  const { bbox, ...noBbox } = UNLABELED_INTERACTIVE('el_7');
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [noBbox],
  });

  assert.equal(result.layer, 'cloud', 'no bbox means no located evidence — must not resolve structurally');
  assert.equal(cloudCalled, true);
});

test('a candidate with an invalid/missing element id is not eligible for the structural fallback', async () => {
  let cloudCalled = false;
  const mockCloudAdapter = { plan: async () => { cloudCalled = true; return mockCloud().plan(); } };

  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    cloudAdapter: mockCloudAdapter,
  });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [{ ...UNLABELED_INTERACTIVE(''), id: '' }],
  });

  assert.equal(result.layer, 'cloud', 'no valid id means nothing safe to execute — must not resolve structurally');
  assert.equal(cloudCalled, true);
});

test('an existing Moondream success (valid elementId) path is entirely unaffected by the structural fallback', async () => {
  // Even with a sole unlabeled candidate ALSO present, a real, valid
  // perception result must still win outright — the fallback only ever
  // engages after perception itself named nothing usable.
  const validVision = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', elementId: 'el_7', action: 'click', confidence: 0.9, reason: 'visual match' }),
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localVisionAdapter: validVision });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [UNLABELED_INTERACTIVE('el_7')],
  });

  assert.equal(result.layer, 'local_vision');
  assert.equal(result.planResponse.confidence, 0.9, 'the real perception confidence must be used, not the structural-fallback constant');
});

test('ambiguous structural fallback still preserves the existing cloud-fallback contract (visionFailureReason, no Qwen)', async () => {
  let qwenCalled = false;
  const mockQwen = { checkAvailability: async () => { qwenCalled = true; return { available: true }; } };
  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localVisionAdapter: nullElementIdVision,
    localQwenAdapter: mockQwen,
    cloudAdapter: mockCloud(),
  });
  const result = await router.route('Click the icon-only control', {
    url: 'https://example.com', title: 'Test',
    elements: [UNLABELED_INTERACTIVE('el_7'), UNLABELED_INTERACTIVE('el_8')],
  });

  assert.equal(result.layer, 'cloud');
  assert.equal(qwenCalled, false, 'ambiguity must still never trigger a same-cycle Qwen attempt');
  assert.equal(result.visionFailureReason, 'invalid_element_id');
});
