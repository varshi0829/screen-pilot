// ScreenPilot v2 — Decision Router Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRouter, extractRequestedValue } from '../services/decision-router.js';
import { UIGroundingService } from '../services/ui-grounding-service.js';

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

// Deliberately a GENUINE partial-lexical-overlap fixture, not a zero-overlap
// one: "Billing" partially covers the goal's vocabulary (via IDF-weighted
// coverage against this page's own candidates — see ui-grounding-service.js)
// but the top score still lands below L2's 0.70 threshold, so L2 correctly
// misses and L3 is reached with ranked.length > 0 (i.e. Qwen is the L3
// router's choice — see decision-router.js's router comment). A fixture with
// literally zero lexical overlap would instead make the router choose
// Moondream, which is NOT what these Qwen/cloud-focused tests are about.
const LOW_CONFIDENCE_PAGE_STATE = {
  url: 'https://example.com',
  title: 'Complex Page',
  elements: [
    { id: 'el_1', role: 'link', tag: 'a', text: 'Billing', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Update Profile Details', visible: true, enabled: true }
  ]
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
      confidence: 0.9,
      plan: { steps: [{ targetElement: { text: 'Search', elementId: 'el_1' } }] },
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

// ── target-label vs user-value: schema consistency across L1/L2 too ────────
//
// L1/L2 are lexical/structural matchers with no way to extract a semantic
// value from the goal — value must stay empty, never silently populated
// from the goal or the element's own label (that would be the exact bug
// this generalizes away from).

test('an L1 (deterministic) resolution carries an explicit, empty value — never the goal or the label', async () => {
  const router = new DecisionRouter();
  const result = await router.route('Submit Order', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }]
  });

  assert.equal(result.planResponse.plan.steps[0].targetElement.value, '');
});

test('an L2 (ML grounding) resolution carries an explicit, empty value — never the goal or the label', async () => {
  const router = new DecisionRouter();
  const result = await router.route('search item', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }]
  });

  assert.equal(result.planResponse.plan.steps[0].targetElement.value, '');
});

// ── Qwen receives L2-RANKED candidates, not a raw DOM-order slice ──────────
//
// Regression for the real-browser failure: a naive elements.slice(0, 25) in
// DOM order can exclude the actually-relevant element entirely on a page
// with many candidates ahead of it (e.g. a link grid before the real search
// box), forcing Qwen to choose among irrelevant leftovers. This proves the
// relevant element now reaches Qwen even when it would have been excluded
// by position alone — using entirely synthetic, non-site-specific labels.

test('Qwen receives the relevant element even when it would be excluded by a raw 25-element DOM-order slice', async () => {
  // Two elements each carry PART of the goal's page-relatable vocabulary
  // (a genuine, non-floor-inflated partial match — same technique as
  // LOW_CONFIDENCE_PAGE_STATE above), so L2's top score stays below 0.70
  // and L3/Qwen is correctly reached. 30 zero-relevance distractors are
  // placed BEFORE both of them in DOM order — with the old raw
  // elements.slice(0, 25), the correct element (at DOM position 31) would
  // have been silently excluded from what Qwen ever saw.
  const distractors = Array.from({ length: 30 }, (_, i) => ({
    id: `el_distractor_${i}`, role: 'link', tag: 'a', text: `Distractor Link ${i}`, visible: true, enabled: true
  }));
  const otherCandidate    = { id: 'el_other',    role: 'link', tag: 'a',     text: 'Update Profile Details', visible: true, enabled: true };
  const relevantElement   = { id: 'el_relevant', role: 'searchbox', tag: 'input', ariaLabel: 'Billing', visible: true, enabled: true };
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [...distractors, otherCandidate, relevantElement]   // relevant element sits at DOM position 31
  };
  const goal = 'Update my billing address details';

  let receivedElementIds = null;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => {
      receivedElementIds = req.elements.map((e) => e.id);
      return {
        result: 'OK', state: 'planned',
        plan: { steps: [{ targetElement: { text: 'Billing', value: '', elementId: 'el_relevant' } }] },
        providerMetadata: { provider: 'local-qwen' }
      };
    }
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });
  const result = await router.route(goal, pageState);

  assert.equal(result.layer, 'local_qwen', 'L1/L2 must miss so L3 is reached');
  assert.ok(receivedElementIds, 'Qwen must have been called');
  assert.ok(receivedElementIds.includes('el_relevant'), 'the relevant element (DOM position 31) must be present in what Qwen was given — a raw DOM-order slice(0,25) would have excluded it');
  assert.ok(!receivedElementIds.includes('el_distractor_0'), 'irrelevant, zero-scoring distractors must not crowd out real candidates');
});

// ── Fill -> submit progression ──────────────────────────────────────────────
//
// Regression for the real-browser failure reported AFTER the accessibility
// fix: "Search Wikipedia for artificial intelligence" now correctly resolves
// and fills the search input on the FIRST cycle, but the goal text never
// changes across a replan — L2 kept re-deriving the SAME already-filled
// input forever (blocked only by the dedup guard, which correctly refuses
// to re-execute it but never proposes anything else), so the task got stuck
// after 3 identical rejected replans instead of progressing to the form's
// submit control. These tests use entirely generic, synthetic labels/sites
// (never "Wikipedia", "search", or any site-specific selector) to prove the
// fix generalizes: it is driven purely by (a) this task's own completed-step
// history and (b) the standard native `element.form` relationship exposed as
// `formId` by PageStateService — never by goal phrasing.

test('DecisionRouter: once a filled input\'s own form has a submit control, a replan advances to it instead of re-proposing the same fill', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Find a product', ariaLabel: '', value: 'wireless mouse', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Go', type: 'submit', visible: true, enabled: true, formId: 'form_0' }
    ]
  };
  const completedSteps = [
    { intent: 'fill_Find a product', description: "Fill 'Find a product'", completionCondition: 'dom_change' }
  ];

  const result = await router.route('Find a product wireless mouse', pageState, { completedSteps, settledSteps: completedSteps });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_2', 'must advance to the submit button, not re-select the already-filled input');
  assert.equal(result.planResponse.plan.steps[0].completionCondition, 'final', 'submitting the just-filled form is this goal\'s natural terminal action');
});

test('DecisionRouter: a field with pre-existing, unrelated content (never filled by this task) is still offered as a normal fill target, not redirected to submit', async () => {
  const router = new DecisionRouter();
  // Value is non-empty, but completedSteps is EMPTY — this task never
  // touched this field, so a non-empty value alone must NOT be treated as
  // "already filled by us" (it could be a genuine pre-existing default the
  // goal wants changed).
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Promo code', ariaLabel: '', value: 'OLDCODE10', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Apply', type: 'submit', visible: true, enabled: true, formId: 'form_0' }
    ]
  };

  const result = await router.route('Promo code', pageState, { completedSteps: [] });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1', 'must still target the field itself when this task never filled it');
});

test('DecisionRouter: ambiguous same-form buttons with no explicit submit type do not trigger progression', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Coupon field', ariaLabel: '', value: 'SAVE20', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Apply', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_3', role: 'button', tag: 'button', text: 'Clear', visible: true, enabled: true, formId: 'form_0' }
    ]
  };
  const completedSteps = [
    { intent: 'fill_Coupon field', description: "Fill 'Coupon field'", completionCondition: 'dom_change' }
  ];

  const result = await router.route('Coupon field', pageState, {
    completedSteps, settledSteps: completedSteps, cloudContext: {}
  });

  // Two same-form buttons with no explicit submit type is not a safe enough
  // signal to choose between them, so no structural continuation is produced.
  // The settled field must NOT be re-proposed as the fallback either — that
  // is the repeat this architecture exists to prevent. Escalating is correct.
  assert.notEqual(result.planResponse.plan?.steps?.[0]?.targetElement?.elementId, 'el_1',
    'the already-actioned field must never be re-proposed as the next action');
  assert.ok(['local_qwen', 'cloud'].includes(result.layer),
    `with no unambiguous continuation the cycle must escalate, got layer=${result.layer}`);
});

test('DecisionRouter: a filled field with no form association falls through unchanged (documented limitation, not a crash)', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Quick filter', ariaLabel: '', value: 'blue widgets', visible: true, enabled: true, formId: null },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Go', type: 'submit', visible: true, enabled: true, formId: null }
    ]
  };
  const completedSteps = [
    { intent: 'fill_Quick filter', description: "Fill 'Quick filter'", completionCondition: 'dom_change' }
  ];

  const result = await router.route('Quick filter', pageState, {
    completedSteps, settledSteps: completedSteps, cloudContext: {}
  });

  // No formId means no standard structural relationship to derive a
  // continuation from, so none is produced — but the settled field is still
  // withheld, so the cycle escalates rather than repeating itself.
  assert.notEqual(result.planResponse.plan?.steps?.[0]?.targetElement?.elementId, 'el_1',
    'the already-actioned field must never be re-proposed as the next action');
  assert.ok(['local_qwen', 'cloud'].includes(result.layer),
    `without a derivable continuation the cycle must escalate, got layer=${result.layer}`);
});

test('DecisionRouter: fill -> submit progression also applies to an L1 (deterministic) exact-match resolution', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com', title: 'Test',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', text: 'newsletter email', value: 'me@example.com', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Subscribe', type: 'submit', visible: true, enabled: true, formId: 'form_0' }
    ]
  };
  const completedSteps = [
    { intent: 'fill_newsletter email', description: "Fill 'newsletter email'", completionCondition: 'dom_change' }
  ];

  const result = await router.route('newsletter email', pageState, { completedSteps, settledSteps: completedSteps });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_2');
  assert.equal(result.planResponse.plan.steps[0].completionCondition, 'final');
});

// ── Generic multi-step task progression ─────────────────────────────────────
//
// The architectural requirement: goal -> action A -> successful state
// transition -> NEW state -> action B, on an arbitrary site, with no
// site-specific rule anywhere. These fixtures use invented product vocabulary
// on example.com precisely so that passing them cannot depend on knowing any
// real site. GitHub and Wikipedia are validation cases, not implementation
// targets, and neither appears here.
//
// The mechanism under test is the task-progress projection: an action whose
// effect IS the current state is withheld from the candidate set, so grounding
// the (unchanged) goal returns the NEXT action instead of the same one.

const STEP_A = {
  intent: 'click_Add new...',
  description: "Click 'Add new...'",
  completionCondition: 'dom_change',
};

// State after action A: the menu A opened is now on screen alongside A itself.
const STATE_AFTER_A = {
  url: 'https://example.com/workspace',
  title: 'Workspace',
  elements: [
    { id: 'el_1', role: 'button',   tag: 'button', text: 'Add new...',           visible: true, enabled: true },
    { id: 'el_2', role: 'menuitem', tag: 'a',      text: 'New payment method',   visible: true, enabled: true },
    { id: 'el_3', role: 'menuitem', tag: 'a',      text: 'New shipping address', visible: true, enabled: true },
    { id: 'el_4', role: 'menuitem', tag: 'a',      text: 'New contact',          visible: true, enabled: true },
    { id: 'el_5', role: 'link',     tag: 'a',      text: 'Account overview',     visible: true, enabled: true },
  ],
};
const MULTI_STEP_GOAL = 'add a new payment method';

test('multi-step: with no progress recorded, the goal grounds to the first action (unchanged behavior)', async () => {
  const router = new DecisionRouter();
  // Phrased so the opening control wins outright (measured 0.880), isolating
  // the baseline: with nothing settled, no candidate is withheld and the
  // first action is chosen exactly as before.
  const result = await router.route('add new', STATE_AFTER_A, {});

  assert.equal(result.layer, 'ml_grounding');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1',
    'with no progress recorded the opening action must still be chosen');
});

test('multi-step: after action A settles, the SAME goal produces action B, not A again', async () => {
  const router = new DecisionRouter();

  const result = await router.route(MULTI_STEP_GOAL, STATE_AFTER_A, {
    completedSteps: [STEP_A],
    settledSteps:   [STEP_A],   // A's effect IS this state
  });

  const chosen = result.planResponse.plan.steps[0].targetElement.elementId;
  assert.notEqual(chosen, 'el_1', 'the already-completed action must not be re-proposed');
  assert.equal(chosen, 'el_2', 'the next action must come from the state A produced');
  assert.equal(result.layer, 'ml_grounding', 'progression must stay deterministic — no model needed');
});

test('multi-step: progression is driven by state, not by a remembered sequence', async () => {
  // Same completed step, but the page has since moved on (its recorded
  // after-state no longer matches), so nothing is settled. The control must
  // become an ordinary candidate again rather than staying suppressed — the
  // projection is a view of the CURRENT state, never a stored sequence.
  const router = new DecisionRouter();

  const result = await router.route('add new', STATE_AFTER_A, {
    completedSteps: [STEP_A],
    settledSteps:   [],          // caller found the state no longer matches A's after-state
  });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1',
    'a control whose effect has been superseded must be targetable again');
});

test('multi-step: a third cycle progresses again from the state action B produced', async () => {
  const router = new DecisionRouter();
  const STEP_B = { intent: 'click_New payment method', description: "Click 'New payment method'", completionCondition: 'dom_change' };

  // State after B: a form has replaced the menu.
  const stateAfterB = {
    url: 'https://example.com/workspace/payment/new',
    title: 'New payment method',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input',  ariaLabel: 'Card number',        value: '', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_2', role: 'button',  tag: 'button', text: 'Save payment method', type: 'submit', visible: true, enabled: true, formId: 'form_0' },
      { id: 'el_3', role: 'link',    tag: 'a',      text: 'Cancel',                             visible: true, enabled: true },
    ],
  };

  const result = await router.route(MULTI_STEP_GOAL, stateAfterB, {
    completedSteps: [STEP_A, STEP_B],
    settledSteps:   [STEP_B],
  });

  assert.notEqual(result.planResponse.plan.steps[0].targetElement.elementId, undefined);
  assert.equal(result.layer, 'ml_grounding', 'a third deterministic step, still with no model invoked');
});

test('multi-step: the progress projection never consults the site, only the task history', async () => {
  // Identical structure and identical goal, described with entirely different
  // vocabulary on a different origin. If any site/phrase knowledge had crept
  // in, this would not behave the same way.
  const router = new DecisionRouter();
  const step = { intent: 'click_Compose', description: "Click 'Compose'", completionCondition: 'dom_change' };
  const state = {
    url: 'https://mail.example.org/u/0',
    title: 'Mailbox',
    elements: [
      { id: 'el_1', role: 'button',   tag: 'button', text: 'Compose',          visible: true, enabled: true },
      { id: 'el_2', role: 'menuitem', tag: 'a',      text: 'Compose message',  visible: true, enabled: true },
      { id: 'el_3', role: 'menuitem', tag: 'a',      text: 'Compose event',    visible: true, enabled: true },
      { id: 'el_4', role: 'link',     tag: 'a',      text: 'Archive',          visible: true, enabled: true },
    ],
  };

  const result = await router.route('compose a message', state, {
    completedSteps: [step], settledSteps: [step],
  });

  assert.notEqual(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_2');
});

test('Qwen receives the execution history of this task so it can reason about progress', async () => {
  // _buildQwenPrompt has always rendered a History line from executionHistory;
  // nothing supplied it locally, so the semantic tier reasoned about
  // multi-step tasks with no idea what had already been done.
  let received = null;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => {
      received = req;
      return { result: 'OK', state: 'planned',
        plan: { steps: [{ targetElement: { text: 'Billing', value: '', elementId: 'el_1' } }] },
        providerMetadata: { provider: 'local-qwen' } };
    },
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });
  const executionHistory = { completedSteps: [{ description: "Click 'Billing'", intent: 'click_Billing' }] };

  await router.route(LOW_CONFIDENCE_GOAL, LOW_CONFIDENCE_PAGE_STATE, { cloudContext: { executionHistory } });

  assert.ok(received, 'Qwen must have been invoked');
  assert.deepEqual(received.executionHistory, executionHistory,
    'the semantic tier must receive the same progress history the cloud tier gets');
});

// ── Lexical confidence is not semantic evidence ─────────────────────────────
//
// Clearing the score threshold says the winner matched the goal's words well.
// It does not say the winner is the thing meant. Two measured ways that goes
// wrong, both properties of the candidate set rather than of any site:
//
//   - a word of the goal appears on NO candidate, so scoring proceeds on the
//     words that remain, which can be pure filler — the wrong element then
//     wins by a WIDE margin (measured 0.850 vs 0.290), so no margin test can
//     catch it;
//   - several candidates cover the same words equally and sort order decides.
//
// All fixtures below are synthetic. No site name, selector, phrase or synonym
// appears in them or in the code they exercise.

const semanticQwen = (pickId) => ({
  checkAvailability: async () => ({ available: true }),
  plan: async () => ({
    result: 'OK', state: 'planned',
    plan: { steps: [{ targetElement: { text: 'semantic choice', value: '', elementId: pickId } }] },
    providerMetadata: { provider: 'local-qwen' },
  }),
});

const C = (id, text, role = 'menuitem', tag = 'a') => ({ id, role, tag, text, visible: true, enabled: true });

test('ambiguity: a decoy that matches the goal\'s filler words does not get committed lexically', async () => {
  // "kind" never appears on any candidate, so the winner is decided purely on
  // the generic verb both share. The element a person means scores far lower.
  let qwenCalled = false;
  const qwen = semanticQwen('el_2');
  const wrapped = { checkAvailability: qwen.checkAvailability, plan: async (r) => { qwenCalled = true; return qwen.plan(r); } };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: wrapped });

  const result = await router.route('create a new kind', {
    url: 'https://example.com/w', title: 'W',
    elements: [C('el_1', 'Create new release'), C('el_2', 'New kindling'), C('el_3', 'New codespace')],
  }, { cloudContext: {} });

  assert.equal(qwenCalled, true, 'the semantic tier must decide when the goal is not expressed by the page');
  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_2');
});

test('ambiguity: near-tied candidates are not committed on sort order', async () => {
  let qwenCalled = false;
  const qwen = semanticQwen('el_3');
  const wrapped = { checkAvailability: qwen.checkAvailability, plan: async (r) => { qwenCalled = true; return qwen.plan(r); } };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: wrapped });

  const result = await router.route('open settings', {
    url: 'https://example.com/s', title: 'S',
    elements: [C('el_1', 'Account settings'), C('el_2', 'Privacy settings'), C('el_3', 'Notification settings')],
  }, { cloudContext: {} });

  assert.equal(qwenCalled, true, 'equally-scoring siblings must not be resolved by sort order');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_3');
});

test('ambiguity: a clear winner stays deterministic and never reaches a model', async () => {
  let qwenCalled = false;
  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: { checkAvailability: async () => { qwenCalled = true; return { available: true }; },
                        plan: async () => { qwenCalled = true; throw new Error('must not be called'); } },
  });

  const result = await router.route('add a new payment method', {
    url: 'https://example.com/w', title: 'W',
    elements: [C('el_1', 'New payment method'), C('el_2', 'New shipping address'), C('el_3', 'New contact')],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'ml_grounding', 'an unrivalled winner must stay deterministic');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(qwenCalled, false, 'no model may be invoked when grounding is clear');
});

test('ambiguity: a single viable candidate is never treated as ambiguous', async () => {
  let qwenCalled = false;
  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: { checkAvailability: async () => { qwenCalled = true; return { available: true }; },
                        plan: async () => { qwenCalled = true; throw new Error('must not be called'); } },
  });

  const result = await router.route('search item', {
    url: 'https://example.com', title: 'T',
    elements: [{ id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'ml_grounding');
  assert.equal(qwenCalled, false, 'with nothing to confuse it with, there is no ambiguity to resolve');
});

test('ambiguity: an exact deterministic match is unaffected by the evidence check', async () => {
  const router = new DecisionRouter();
  const result = await router.route('Submit Order', {
    url: 'https://example.com', title: 'T',
    elements: [C('el_1', 'Submit Order', 'button', 'button'), C('el_2', 'Cancel', 'button', 'button')],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'deterministic', 'L1 exact matching is untouched by the L2 evidence check');
});

test('a goal carrying a value to type must not escalate when the winner is a field that receives it', async () => {
  // Words of the goal that name the VALUE cannot appear on the page — they are
  // what the user is about to type, not a label. Counting that expected
  // absence as missing evidence sent a strongly grounded, clearly actionable
  // field (0.960) through the semantic tier and its timeout instead of simply
  // acting on it. Synthetic field/labels only; no site, phrase or synonym.
  let modelTouched = false;
  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: {
      checkAvailability: async () => { modelTouched = true; return { available: true }; },
      plan: async () => { modelTouched = true; throw new Error('must not be called'); },
    },
  });

  const result = await router.route('search catalog for wireless mouse', {
    url: 'https://example.com', title: 'Catalog',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Search catalog', value: '', visible: true, enabled: true, formId: 'f0' },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Search', type: 'submit', visible: true, enabled: true, formId: 'f0' },
      { id: 'el_3', role: 'link',   tag: 'a',      text: 'Browse all categories', visible: true, enabled: true },
    ],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'ml_grounding', 'a clearly actionable field must execute immediately');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(modelTouched, false, 'no model may be invoked for a strongly grounded field');
});

test('unmatched goal vocabulary still escalates when the winner is acted ON, not typed into', async () => {
  // The same criterion must keep working for non-input winners — that is the
  // case where absent goal vocabulary really does mean the evidence is short.
  let qwenCalled = false;
  const router = new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: {
      checkAvailability: async () => ({ available: true }),
      plan: async () => {
        qwenCalled = true;
        return { result: 'OK', state: 'planned',
          plan: { steps: [{ targetElement: { text: 'semantic choice', value: '', elementId: 'el_2' } }] },
          providerMetadata: { provider: 'local-qwen' } };
      },
    },
  });

  const result = await router.route('create a new kind', {
    url: 'https://example.com/w', title: 'W',
    elements: [
      { id: 'el_1', role: 'menuitem', tag: 'a', text: 'Create new release', visible: true, enabled: true },
      { id: 'el_2', role: 'menuitem', tag: 'a', text: 'New kindling',       visible: true, enabled: true },
      { id: 'el_3', role: 'menuitem', tag: 'a', text: 'New codespace',      visible: true, enabled: true },
    ],
  }, { cloudContext: {} });

  assert.equal(qwenCalled, true, 'an acted-on winner with absent goal vocabulary must still escalate');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_2');
});

// ── Generic value extraction ────────────────────────────────────────────────
//
// A fill step must distinguish the control it targets from the value meant to
// go into it. Building the step with an unconditionally empty value left the
// control's own name standing where the payload belongs ("Fill 'Search X'"),
// which reads as an instruction to type the label.
//
// Extraction is structural: it reads where the goal's own function words put
// the payload, never what the payload means. No site, selector, synonym or
// phrase table is involved, and a goal that states no value yields none.

test('value extraction: payload trailing a marker, across unrelated phrasings', () => {
  assert.equal(extractRequestedValue('search wikipedia for artificial intelligence', 'Search Wikipedia'), 'artificial intelligence');
  assert.equal(extractRequestedValue('search for machine learning', 'Search'), 'machine learning');
  assert.equal(extractRequestedValue('search for restaurants near me', 'Search'), 'restaurants near me');
});

test('value extraction: "find flights to Delhi" yields the destination only', () => {
  assert.equal(extractRequestedValue('find flights to Delhi', 'Search flights'), 'Delhi');
});

test('value extraction: "enter X into <field>" takes the value before the marker', () => {
  assert.equal(extractRequestedValue('enter Alice into the name field', 'Name'), 'Alice');
});

test('value extraction: "fill <field> with X" takes the value after the marker', () => {
  assert.equal(extractRequestedValue('fill the email field with alice@example.com', 'Email'), 'alice@example.com');
});

test('value extraction: a goal stating no value must NOT invent one', () => {
  // The workflow is free to stop at the form and ask for what is missing —
  // guessing here would put fabricated content into a real control.
  assert.equal(extractRequestedValue('create a new repo', 'Repository name'), '');
  assert.equal(extractRequestedValue('search item', 'Search item catalog'), '');
  assert.equal(extractRequestedValue('Submit Order', ''), '');
  assert.equal(extractRequestedValue('', 'Anything'), '');
});

test('value extraction: a payload identical to the control\'s own name is rejected', () => {
  // That is the label/value conflation being fixed, not a value the user asked
  // for, so it must not be echoed back into the field.
  assert.equal(extractRequestedValue('search for Search Wikipedia', 'Search Wikipedia'), '');
});

test('a fill step carries the extracted value and names it in the instruction', async () => {
  const router = new DecisionRouter();
  const result = await router.route('search catalog for wireless mouse', {
    url: 'https://example.com', title: 'Catalog',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Search catalog', value: '', visible: true, enabled: true, formId: 'f0' },
      { id: 'el_2', role: 'button',  tag: 'button', text: 'Search', type: 'submit', visible: true, enabled: true, formId: 'f0' },
    ],
  }, { cloudContext: {} });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.elementId, 'el_1');
  assert.equal(step.targetElement.value, 'wireless mouse', 'the payload, not the control name');
  assert.equal(step.targetElement.text, 'Search catalog', 'the control name stays the target');
  assert.match(step.description, /wireless mouse/, 'the instruction must state the value to type');
});

test('a click target never takes a value, even when the goal trails a marker', async () => {
  // "go to settings" trails a marker too. Gating extraction on a
  // value-receiving target is what keeps ordinary navigation unaffected.
  const router = new DecisionRouter();
  const result = await router.route('go to settings', {
    url: 'https://example.com', title: 'App',
    elements: [
      { id: 'el_1', role: 'link', tag: 'a', text: 'Settings', visible: true, enabled: true },
      { id: 'el_2', role: 'link', tag: 'a', text: 'Profile',  visible: true, enabled: true },
    ],
  }, { cloudContext: {} });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.value, '', 'a navigation target must never receive a payload');
  assert.match(step.description, /^Click /);
});

// ── A failed second opinion must not destroy a deterministic answer ─────────
//
// Escalating because L2's evidence was judged insufficient asks for a second
// opinion; it does not mean L2 had no answer. When the reasoning tier then
// fails, abandoning the task presents the user with a provider error while a
// perfectly grounded control sits on screen. Synthetic labels only.

test('a failed reasoning tier after an evidence escalation reports ambiguity, never a guess', async () => {
  const failing = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ schemaVersion: '1', result: 'FAILED', blockers: [], confidence: 0,
      providerMetadata: { provider: 'local-qwen' }, error: 'Local Qwen inference timed out', errorCode: 'TIMEOUT' }),
  };
  const failingCloud = { plan: async () => ({ schemaVersion: '1', result: 'FAILED', confidence: 0,
    providerMetadata: { provider: 'cloud' }, error: 'provider error', errorCode: 'PROVIDER_ERROR' }) };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: failing, cloudAdapter: failingCloud });

  // Equal-coverage siblings: L2 is above threshold but cannot distinguish them,
  // so this escalates on evidence — then both providers fail.
  const result = await router.route('open settings', {
    url: 'https://example.com/s', title: 'S',
    elements: [
      { id: 'el_1', role: 'menuitem', tag: 'a', text: 'Account settings',      visible: true, enabled: true },
      { id: 'el_2', role: 'menuitem', tag: 'a', text: 'Privacy settings',      visible: true, enabled: true },
      { id: 'el_3', role: 'menuitem', tag: 'a', text: 'Notification settings', visible: true, enabled: true },
    ],
  }, { cloudContext: {} });

  // L2 tied these three; the reasoning tier was asked precisely because there
  // was no basis to choose, and it failed. Choosing the highest-sorted one
  // anyway would be a coin flip presented as a decision.
  assert.equal(result.planResponse.result, 'NEEDS_USER');
  assert.equal(result.planResponse.state, 'ambiguous');
  assert.equal(result.planResponse.plan, undefined, 'no action may be produced from unresolved ambiguity');
  assert.match(result.planResponse.plannerSummary, /settings/, 'the tied options must be named so the user can choose');
});

test('a reasoning tier that SUCCEEDS still wins over L2 after an evidence escalation', async () => {
  const qwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'OK', state: 'planned',
      plan: { steps: [{ targetElement: { text: 'semantic choice', value: '', elementId: 'el_3' } }] },
      providerMetadata: { provider: 'local-qwen' } }),
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwen });

  const result = await router.route('open settings', {
    url: 'https://example.com/s', title: 'S',
    elements: [
      { id: 'el_1', role: 'menuitem', tag: 'a', text: 'Account settings',      visible: true, enabled: true },
      { id: 'el_2', role: 'menuitem', tag: 'a', text: 'Privacy settings',      visible: true, enabled: true },
      { id: 'el_3', role: 'menuitem', tag: 'a', text: 'Notification settings', visible: true, enabled: true },
    ],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'local_qwen', 'the fallback must not pre-empt a working second opinion');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_3');
});

// ── A completed fill must settle and not be re-planned ──────────────────────

test('a satisfied fill settles and the next cycle plans a DIFFERENT action', async () => {
  const router = new DecisionRouter();

  // The state after the fill: the control holds the requested value, and the
  // step that produced it is settled (its recorded after-state is this state).
  const settled = [{ intent: "fill_Search catalog",
                     description: "Type 'wireless mouse' into 'Search catalog'",
                     completionCondition: 'dom_change' }];
  const elements = [
    { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Search catalog', value: 'wireless mouse', visible: true, enabled: true, formId: 'f0' },
    { id: 'el_2', role: 'button',  tag: 'button', text: 'Search', type: 'submit', visible: true, enabled: true, formId: 'f0' },
  ];

  const result = await router.route('search catalog for wireless mouse', {
    url: 'https://example.com', title: 'Catalog', elements,
  }, { completedSteps: settled, settledSteps: settled, cloudContext: {} });

  const step = result.planResponse.plan.steps[0];
  assert.notEqual(step.targetElement.elementId, 'el_1', 'the completed fill must not be planned again');
  assert.equal(step.targetElement.elementId, 'el_2', 'the next action must follow from the new state');
  assert.equal(result.qwenMs ?? 0, 0, 'progression after a fill must not need a model');
});

// ── Task progress across navigation (router level) ─────────────────────────
// A completed navigation must keep its target out of the next cycle's
// candidates while we remain at the destination it produced, so planning
// continues from the new state instead of re-proposing the finished action.
// Synthetic origins/labels only.

const NAV_STEP = {
  description: "Click 'Open workspace menu'",
  intent: 'click_Open workspace menu',
  completionCondition: 'dom_change',
  targetLabel: 'Open workspace menu',
  requestedValue: '',
  urlBefore: 'https://example.com/home',
  urlAfter:  'https://example.com/workspace/new',
  domHashBefore: 'aaaa1111',
  domHashAfter:  'bbbb2222',   // captured at bootstrap, before deferred content renders
};

// The destination as it looks a moment later: more has rendered, so the
// fingerprint no longer matches what bootstrap recorded.
const DESTINATION_LATER = { url: 'https://example.com/workspace/new', domHash: 'cccc3333' };

test('navigation: the control that caused it is withheld from the next cycle', async () => {
  // The control is global chrome, still present on the destination. Without
  // the transition evidence the planner re-selects it and the task loops.
  const router = new DecisionRouter();
  const settled = [NAV_STEP];
  const result = await router.route('create a new workspace', {
    url: 'https://example.com/workspace/new', title: 'New workspace',
    elements: [
      { id: 'el_1', role: 'button',  tag: 'button', text: 'Open workspace menu', visible: true, enabled: true },
      { id: 'el_2', role: 'textbox', tag: 'input',  ariaLabel: 'Workspace name', value: '', visible: true, enabled: true },
    ],
  }, { completedSteps: settled, settledSteps: settled, cloudContext: {} });

  const chosen = result.planResponse.plan?.steps?.[0]?.targetElement?.elementId;
  assert.notEqual(chosen, 'el_1', 'the already-completed navigation must not be proposed again');
  assert.equal(chosen, 'el_2', 'planning must continue from the state the navigation produced');
});

test('navigation: a required value the user never supplied is not invented', async () => {
  // On the destination the goal names no value, so the step targets the field
  // and asks for input rather than fabricating content for a real control.
  const router = new DecisionRouter();
  const settled = [NAV_STEP];
  const result = await router.route('create a new workspace', {
    url: 'https://example.com/workspace/new', title: 'New workspace',
    elements: [
      { id: 'el_1', role: 'button',  tag: 'button', text: 'Open workspace menu', visible: true, enabled: true },
      { id: 'el_2', role: 'textbox', tag: 'input',  ariaLabel: 'Workspace name', value: '', visible: true, enabled: true },
    ],
  }, { completedSteps: settled, settledSteps: settled, cloudContext: {} });

  const step = result.planResponse.plan?.steps?.[0];
  assert.equal(step?.targetElement?.value, '', 'no value may be invented when the goal states none');
});

// ── Required-field gate: don't submit a form with an unmet required field ──
//
// L1/L2 ground the goal's words against element labels. A required field
// whose own label shares no vocabulary with the goal (e.g. "Repository name"
// vs. "create a new repo" — no token in common, a limitation no threshold
// fixes) never becomes a lexical candidate, so nothing stopped a submit
// control from winning even though its own form was not ready to submit.
//
// The gate is structural: the standard native `element.form` association
// (`formId`) plus the standard HTML `required` attribute — the same two
// signals a real browser already uses to refuse a premature submit. No site
// name, selector, phrase or synonym appears in any of these fixtures.

function formEls(nameValue = '') {
  return [
    { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Repository name', value: nameValue, visible: true, enabled: true, formId: 'f0', required: true },
    { id: 'el_2', role: 'textbox', tag: 'textarea', ariaLabel: 'Description', value: '', visible: true, enabled: true, formId: 'f0' },
    { id: 'el_6', role: 'button', tag: 'button', text: 'Create repository', type: 'submit', visible: true, enabled: true, formId: 'f0' },
  ];
}

test('required-field gate: an empty required field redirects a resolved submit target to itself', async () => {
  const router = new DecisionRouter();
  const result = await router.route('create a new repo', {
    url: 'https://example.com/new', title: 'Create', elements: formEls(''),
  }, { cloudContext: {} });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.elementId, 'el_1', 'the empty required field, not the submit control, must be targeted');
  assert.equal(step.targetElement.value, '', 'no value may be invented for a goal that states none');
  assert.equal(result.qwenMs ?? 0, 0, 'the gate is structural — no model call');
});

test('required-field gate: a value stated in the goal is extracted onto the missing field', () => {
  const router = new DecisionRouter();
  const submitCandidate = formEls()[2];
  const gate = router._resolveRequiredFieldGate('fill the repository name field with my-project', formEls(''), submitCandidate);

  assert.ok(gate, 'a stated value must still route through the missing field');
  assert.equal(gate.plan.steps[0].targetElement.elementId, 'el_1');
  assert.equal(gate.plan.steps[0].targetElement.value, 'my-project');
});

test('required-field gate: once the field is filled, the submit control proceeds normally', async () => {
  const router = new DecisionRouter();
  const result = await router.route('create a new repo', {
    url: 'https://example.com/new', title: 'Create', elements: formEls('my-project'),
  }, { cloudContext: {} });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.elementId, 'el_6', 'a satisfied required field must not keep gating the submit action');
});

test('required-field gate: does not fire without a form association', () => {
  const router = new DecisionRouter();
  const noForm = [{ id: 'x1', role: 'button', tag: 'button', text: 'Sign in', visible: true, enabled: true }];
  assert.equal(router._resolveRequiredFieldGate('Sign in', noForm, noForm[0]), null,
    'an ordinary click with no form structure must be unaffected');
});

test('required-field gate: does not redirect when the candidate already IS the required field', () => {
  const router = new DecisionRouter();
  const els = formEls('');
  assert.equal(router._resolveRequiredFieldGate('create a new repo', els, els[0]), null,
    'a target that already resolved to the missing field needs no redirect');
});

test('required-field gate: ordinary non-form goals are completely unaffected', async () => {
  const router = new DecisionRouter();
  const result = await router.route('search item', {
    url: 'https://example.com', title: 'Catalog',
    elements: [{ id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }],
  }, { cloudContext: {} });

  assert.equal(result.layer, 'ml_grounding');
  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
});

// ── Abbreviated goal words, and clarification as continuation ───────────────
//
// Two separate causes of the same user-visible symptom — a long wait followed
// by a question the page could already answer:
//
//  1. A goal word the page only spells out in full ("repo" vs "repository")
//     was a different token entirely, so every sibling control tied at exactly
//     the same score and the tie escalated to a reasoning model whose
//     round-trip is the delay the user feels. Related by a runtime string
//     relation, not a vocabulary list: nothing here is listed anywhere, and
//     the same rule resolves any abbreviation against any longer form.
//  2. A clarification answer only ever reached the cloud tier, so locally the
//     unchanged goal re-derived the same tie and the answer changed nothing.
//
// No site name, selector, phrase or synonym appears in these fixtures, and the
// non-GitHub cases below exercise the identical mechanism.

const menuItem = (id, text) => ({ id, role: 'menuitem', tag: 'a', text, visible: true, enabled: true });

const countingQwen = (state) => ({
  checkAvailability: async () => { state.calls++; return { available: true }; },
  plan: async () => { state.calls++; throw new Error('must not be needed'); },
});

test('abbreviated goal word resolves deterministically against the spelled-out control', async () => {
  const state = { calls: 0 };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: countingQwen(state) });

  const result = await router.route('create new repo', {
    url: 'https://example.com/w', title: 'W',
    elements: [
      menuItem('m1', 'New repository'), menuItem('m2', 'Import repository'),
      menuItem('m3', 'New codespace'),  menuItem('m4', 'New gist'),
      menuItem('m5', 'New organization'), menuItem('m6', 'New issue'),
    ],
  }, { cloudContext: {} });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'm1');
  assert.equal(result.layer, 'ml_grounding');
  assert.equal(state.calls, 0, 'an obvious target must not cost a model round-trip');
});

test('the same mechanism works on unrelated vocabulary and a different site', async () => {
  const state = { calls: 0 };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: countingQwen(state) });

  const result = await router.route('open admin panel', {
    url: 'https://intranet.example.org', title: 'Intranet',
    elements: [menuItem('a', 'Administrator panel'), menuItem('b', 'User panel'), menuItem('c', 'Help panel')],
  }, { cloudContext: {} });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'a');
  assert.equal(state.calls, 0);
});

test('a short goal word is NOT treated as an abbreviation', () => {
  // "new" prefixes "newsletter" and "car" prefixes "card". Anything under the
  // minimum length must still require an exact match, or the relation would
  // start inventing meanings.
  const ranked = UIGroundingService.rankElements('new item', [
    menuItem('a', 'Newsletter signup'), menuItem('b', 'New item'),
  ]);
  assert.equal(ranked[0].element.id, 'b', 'a genuine exact match must win over a short-prefix coincidence');
});

test('an exact match still outranks a merely abbreviated one', () => {
  const ranked = UIGroundingService.rankElements('open repository settings', [
    menuItem('a', 'Repository settings'), menuItem('b', 'Repo settings'),
  ]);
  assert.equal(ranked[0].element.id, 'a', 'the control that actually uses the word must win');
});

test('a genuinely ambiguous goal still asks rather than guessing', async () => {
  const failing = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({ result: 'FAILED', errorCode: 'TIMEOUT', error: 'timed out', providerMetadata: { provider: 'local-qwen' } }),
  };
  const failingCloud = { plan: async () => ({ result: 'FAILED', errorCode: 'PROVIDER_ERROR', providerMetadata: { provider: 'cloud' } }) };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: failing, cloudAdapter: failingCloud });

  const result = await router.route('create something new', {
    url: 'https://example.com/w', title: 'W',
    elements: [
      menuItem('m1', 'New repository'), menuItem('m2', 'New codespace'),
      menuItem('m3', 'New gist'), menuItem('m4', 'New organization'),
    ],
  }, { cloudContext: {} });

  assert.equal(result.planResponse.result, 'NEEDS_USER', 'nothing distinguishes these — asking is correct');
  assert.equal(result.planResponse.plan, undefined);
});

test('a clarification answer resolves the task locally and continues it', async () => {
  // The answer is the user stating their intent directly. Grounding it must
  // settle the same tie that produced the question, in the same cycle, without
  // a model and without making the user re-open anything.
  const state = { calls: 0 };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: countingQwen(state) });
  const elements = [
    menuItem('m1', 'New repository'), menuItem('m2', 'New codespace'),
    menuItem('m3', 'New gist'), menuItem('m4', 'New organization'),
  ];

  const result = await router.route('create something new', {
    url: 'https://example.com/w', title: 'W', elements,
  }, { cloudContext: { clarifications: ['new repository'] } });

  assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'm1');
  assert.equal(result.layer, 'ml_grounding');
  assert.equal(state.calls, 0, 'the answer must be usable without a model round-trip');
});

test('a clarification refines the target without becoming a typed value', async () => {
  // Clarifications steer WHICH control; only the original goal states a value.
  const router = new DecisionRouter();
  const result = await router.route('search the catalog', {
    url: 'https://example.com', title: 'Catalog',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Search catalog', value: '', visible: true, enabled: true },
    ],
  }, { cloudContext: { clarifications: ['use the catalog search box'] } });

  assert.equal(result.planResponse.plan.steps[0].targetElement.value, '',
    'a clarification naming a control must never be typed into it');
});

// ── targetElement.text vs. displayLabel: an unlabeled element must never be ──
// ── matched by a fabricated (goal-derived) label ────────────────────────────
//
// _buildPlanFromElement previously fell back to the GOAL when an element had
// no text/placeholder/ariaLabel, and put that fabricated label into
// targetElement.text — the exact field the executor's DOMMatcher searches the
// live DOM by. No real page element's text is ever equal to the full goal
// sentence, so the step could never be executed. text and the human-readable
// label are now kept separate; bbox is forwarded so the executor has a
// generic, non-textual way to still resolve the target (see
// executor-engine.js's _resolveElementByPosition).

test('a resolved LABELED element behaves exactly as before: text/intent/description carry its own real label', async () => {
  const router = new DecisionRouter();
  const result = await router.route('Submit Order', {
    url: 'https://example.com', title: 'Test',
    elements: [{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }]
  });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.text, 'Submit Order', 'a labeled element\'s own text must still be the DOM search key');
  assert.equal(step.targetElement.intent, 'Submit Order');
  assert.equal(step.description, "Click 'Submit Order'");
  assert.equal(step.intent, 'click_Submit Order');
});

test('a resolved UNLABELED element preserves its elementId and bbox through the plan, with an empty targetElement.text', () => {
  // Unit-level, direct: an unlabeled element (zero lexical signal) can never
  // be reached via L1/L2 grounding in the first place — in the real
  // pipeline this shape only ever reaches _buildPlanFromElement via the
  // sole-unlabeled-interactive-candidate structural fallback in
  // _runLayer3, after visual perception named nothing usable. Calling it
  // directly isolates exactly what's under test: the step SHAPE it builds.
  const router = new DecisionRouter();
  const bbox = { x: 230, y: 620, width: 40, height: 40 };
  const element = { id: 'el_7', role: 'button', tag: 'button', text: '', ariaLabel: '', placeholder: '', value: '', bbox };

  const planResponse = router._buildPlanFromElement('Click the button with the icon', element, 0.6, 'local_vision');
  const step = planResponse.plan.steps[0];

  assert.equal(step.targetElement.elementId, 'el_7', 'elementId must be preserved through the plan');
  assert.deepEqual(step.targetElement.bbox, bbox, 'the element\'s own already-known bbox must be forwarded, not recomputed or dropped');
  assert.equal(step.targetElement.text, '', 'an unlabeled element must never receive a fabricated (goal-derived) DOM search key');
  // The human-readable side still falls back to the goal — a step must never
  // be displayed with a blank name.
  assert.equal(step.targetElement.intent, 'Click the button with the icon');
  assert.equal(step.description, "Click 'Click the button with the icon'");
});

// ── Unsatisfied-requirement gate on structural continuation ─────────────────
//
// Routing-quality fix: structural continuation (above) is correct about WHAT
// DOM action is locally plausible (a filled field's own form submit) but has
// no way to know whether that action is APPROPRIATE for the goal's own
// declared requirements. options.unsatisfiedRequirements carries the goal's
// own not-yet-historically-satisfied successSignals (computed by the caller
// in v2-task.js from goalCompletionCriteria + requirementProgress — this
// file never reads either). The gate ranks each unsatisfied signal's own
// `text` against the currently unaddressed candidates using the exact same
// UIGroundingService.rankElements L1/L2 already use — no form, field-name,
// action-type, or site vocabulary of any kind. Fixtures here are
// deliberately generic (Widget A/B/C, not any real site or form) to prove
// the mechanism generalizes.

function widgetFormEls() {
  return [
    { id: 'el_1', role: 'textbox', tag: 'input', ariaLabel: 'Widget name', value: 'demo', visible: true, enabled: true, formId: 'wf0' },
    { id: 'el_2', role: 'radio',   tag: 'input', ariaLabel: 'Widget Color Alpha', value: '', visible: true, enabled: true, formId: 'wf0' },
    { id: 'el_3', role: 'textbox', tag: 'textarea', ariaLabel: 'Widget Notes', value: '', visible: true, enabled: true, formId: 'wf0' },
    { id: 'el_9', role: 'button', tag: 'button', text: 'Submit', type: 'submit', visible: true, enabled: true, formId: 'wf0' },
  ];
}
const widgetSettled = [
  { intent: "fill_Widget name", description: "Fill 'Widget name'", completionCondition: 'dom_change' },
];

test('unsatisfied-requirement gate: empty unsatisfiedRequirements leaves continuation unchanged (byte-for-byte)', async () => {
  const router = new DecisionRouter();
  const withoutMeta = await router.route('Widget name demo', { url: 'https://example.com', title: 'Test', elements: widgetFormEls() },
    { completedSteps: widgetSettled, settledSteps: widgetSettled, cloudContext: {} });
  const withEmptyMeta = await router.route('Widget name demo', { url: 'https://example.com', title: 'Test', elements: widgetFormEls() },
    { completedSteps: widgetSettled, settledSteps: widgetSettled, cloudContext: {}, unsatisfiedRequirements: [] });
  const withUndefinedMeta = await router.route('Widget name demo', { url: 'https://example.com', title: 'Test', elements: widgetFormEls() },
    { completedSteps: widgetSettled, settledSteps: widgetSettled, cloudContext: {}, unsatisfiedRequirements: undefined });

  for (const result of [withoutMeta, withEmptyMeta, withUndefinedMeta]) {
    assert.equal(result.planResponse.plan.steps[0].targetElement.elementId, 'el_9', 'must still advance to the submit control');
    assert.equal(result.planResponse.plan.steps[0].completionCondition, 'final', 'a genuinely final continuation is unaffected');
  }
});

test('unsatisfied-requirement gate: a matching unaddressed candidate is chosen instead of submit', async () => {
  const router = new DecisionRouter();
  const result = await router.route('Widget name demo', { url: 'https://example.com', title: 'Test', elements: widgetFormEls() }, {
    completedSteps: widgetSettled, settledSteps: widgetSettled, cloudContext: {},
    unsatisfiedRequirements: [
      { type: 'text_present', text: 'Widget Color Alpha' },
      { type: 'text_present', text: 'Widget Notes' },
    ],
  });

  const step = result.planResponse.plan.steps[0];
  assert.notEqual(step.targetElement.elementId, 'el_9', 'must NOT submit while an unsatisfied requirement matches an unaddressed candidate');
  assert.ok(['el_2', 'el_3'].includes(step.targetElement.elementId), `must redirect to the matching unaddressed candidate, got ${step.targetElement.elementId}`);
  assert.notEqual(step.completionCondition, 'final', 'a redirected step is not the terminal action');
});

test('unsatisfied-requirement gate: no matching candidate still lets submit continuation happen', async () => {
  const router = new DecisionRouter();
  const result = await router.route('Widget name demo', { url: 'https://example.com', title: 'Test', elements: widgetFormEls() }, {
    completedSteps: widgetSettled, settledSteps: widgetSettled, cloudContext: {},
    // Describes evidence with no vocabulary overlap with anything left unaddressed
    // on this page (e.g. a post-submission URL/text check) — nothing here for
    // the generic ranker to redirect to, so the existing behavior must stand.
    unsatisfiedRequirements: [{ type: 'url_matches', urlPattern: '/done' }],
  });

  const step = result.planResponse.plan.steps[0];
  assert.equal(step.targetElement.elementId, 'el_9', 'with no matching candidate, submit continuation must still happen');
  assert.equal(step.completionCondition, 'final');
});

test('unsatisfied-requirement gate: a url_matches-only requirement (no .text) never blocks continuation on its own', async () => {
  const router = new DecisionRouter();
  const redirect = router._resolveUnsatisfiedRequirementCandidate(
    widgetFormEls(), widgetSettled, 'el_9', [{ type: 'url_matches', urlPattern: '/done' }]
  );
  assert.equal(redirect, null, 'a signal with no .text has nothing generic to rank against and must be skipped, not treated as a block');
});

test('unsatisfied-requirement gate: the excluded (submit) element itself is never offered back as its own redirect target', async () => {
  const router = new DecisionRouter();
  const redirect = router._resolveUnsatisfiedRequirementCandidate(
    widgetFormEls(), widgetSettled, 'el_9', [{ type: 'text_present', text: 'Submit' }]
  );
  assert.ok(!redirect || redirect.plan.steps[0].targetElement.elementId !== 'el_9');
});

test('unsatisfied-requirement gate: an already-settled candidate is not offered as a redirect target', async () => {
  const router = new DecisionRouter();
  // el_1 (Widget name) is settled — even if a signal's text happened to
  // overlap with it, it must not be re-offered.
  const redirect = router._resolveUnsatisfiedRequirementCandidate(
    widgetFormEls(), widgetSettled, 'el_9', [{ type: 'text_present', text: 'Widget name' }]
  );
  assert.ok(!redirect || redirect.plan.steps[0].targetElement.elementId !== 'el_1');
});

// ── _buildPlanFromElement: role-aware fill classification ───────────────────
//
// Root-cause fix for a dead zone found via real-browser testing: a native
// <input> tag alone was treated as evidence of a TEXT-ENTRY field, so a
// checkbox/radio/switch (also tag 'input', but a distinct, already-computed
// role) was tagged phase:'fill_form' — which executor-engine.js's fill
// detection explicitly excludes by design (checkboxes complete via a click,
// never typed input), while ALSO disabling its own click-detection path for
// any fill_form-phase step. Net effect: such a step could never be recognized
// as complete. The fix consults the element's own `role` (already generic,
// already computed by page-state-service.js) before falling back to the tag.
// Fixtures here are deliberately generic (Widget/Toggle/Field, never a real
// form, site, or field name) to prove the classification is role-driven, not
// tied to any one control's label.

function classify(router, role, tag = 'input') {
  const element = { id: 'el_x', role, tag, text: '', placeholder: '', ariaLabel: '', value: '' };
  return router._buildPlanFromElement('Interact with Widget', element, 0.9, 'ml_grounding').plan.steps[0];
}

test('classification: role=textbox -> fill_form', () => {
  const step = classify(new DecisionRouter(), 'textbox');
  assert.equal(step.phase, 'fill_form');
});

test('classification: tag=textarea -> fill_form', () => {
  const step = classify(new DecisionRouter(), '', 'textarea');
  assert.equal(step.phase, 'fill_form');
});

test('classification: role=combobox -> fill_form', () => {
  const step = classify(new DecisionRouter(), 'combobox');
  assert.equal(step.phase, 'fill_form');
});

test('classification: role=search -> fill_form', () => {
  const step = classify(new DecisionRouter(), 'search');
  assert.equal(step.phase, 'fill_form');
});

test('classification: role=checkbox -> NOT fill_form (navigate)', () => {
  const step = classify(new DecisionRouter(), 'checkbox');
  assert.equal(step.phase, 'navigate');
  assert.equal(step.completionCondition, 'dom_change', 'a checkbox step must not carry input_filled-style completion');
});

test('classification: role=radio -> NOT fill_form (navigate)', () => {
  const step = classify(new DecisionRouter(), 'radio');
  assert.equal(step.phase, 'navigate');
});

test('classification: role=switch -> NOT fill_form (navigate)', () => {
  const step = classify(new DecisionRouter(), 'switch');
  assert.equal(step.phase, 'navigate');
});

test('classification: a generic <input> with no semantic role preserves existing behavior (fill_form)', () => {
  // A role-less native input (e.g. type="text" with no ARIA role assigned)
  // must still be treated as fillable, exactly as before this fix — only
  // checkbox/radio/switch are newly excluded, nothing else regresses.
  const step = classify(new DecisionRouter(), '');
  assert.equal(step.phase, 'fill_form');
});
