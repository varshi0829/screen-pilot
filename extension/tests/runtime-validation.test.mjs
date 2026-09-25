// ScreenPilot v2 — Real Runtime Validation Suite
// Runs 5 Obvious Fast-Path Tasks and 5 Ambiguous Qwen Fallback Tasks against live modules & Ollama

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateService } from '../services/page-state-service.js';
import { DecisionRouter } from '../services/decision-router.js';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { GoalVerifier } from '../services/goal-verifier.js';

// ── 5 Obvious Tasks (Must use Layer 1 / Layer 2, Qwen calls = 0) ────────────

test('Runtime Task 1 (Obvious): Click "Login" button', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://app.example.com/login',
    title: 'Sign In',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Username', visible: true, enabled: true },
      { id: 'el_2', role: 'textbox', tag: 'input', placeholder: 'Password', visible: true, enabled: true },
      { id: 'el_3', role: 'button', tag: 'button', text: 'Login', visible: true, enabled: true },
      { id: 'el_4', role: 'link', tag: 'a', text: 'Create an account', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Login', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Login" layer=${res.layer} confidence=${res.planResponse.confidence} qwenMs=0 totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'deterministic');
  assert.equal(res.planResponse.plan.steps[0].targetElement.text, 'Login');
  assert.ok(totalMs < 10, 'Fast path task execution must be under 10ms');
});

test('Runtime Task 2 (Obvious): Enter text into "Search products" input', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://store.example.org',
    title: 'Online Store',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search products', visible: true, enabled: true },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Search', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Search products', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Search products" layer=${res.layer} confidence=${res.planResponse.confidence} qwenMs=0 totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'deterministic');
  assert.equal(res.planResponse.plan.steps[0].targetElement.text, 'Search products');
  assert.ok(totalMs < 10, 'Fast path task execution must be under 10ms');
});

test('Runtime Task 3 (Obvious): Click "Submit Order" button', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://store.example.org/checkout',
    title: 'Checkout',
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Submit Order', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Submit Order" layer=${res.layer} confidence=${res.planResponse.confidence} qwenMs=0 totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'deterministic');
  assert.equal(res.planResponse.plan.steps[0].targetElement.text, 'Submit Order');
  assert.ok(totalMs < 10, 'Fast path task execution must be under 10ms');
});

test('Runtime Task 4 (Obvious): Click "Next Page" pagination link', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://blog.example.com/posts',
    title: 'Blog Posts',
    elements: [
      { id: 'el_1', role: 'link', tag: 'a', text: 'Next Page', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Next Page', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Next Page" layer=${res.layer} confidence=${res.planResponse.confidence} qwenMs=0 totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'deterministic');
  assert.equal(res.planResponse.plan.steps[0].targetElement.text, 'Next Page');
  assert.ok(totalMs < 10, 'Fast path task execution must be under 10ms');
});

test('Runtime Task 5 (Obvious Grounding): Fuzzy match "Find catalog items"', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://store.example.org/catalog',
    title: 'Catalog',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search item catalog', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('search item', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="search item" layer=${res.layer} confidence=${res.planResponse.confidence} qwenMs=0 totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'ml_grounding');
  assert.ok(res.planResponse.confidence >= 0.70);
  assert.ok(totalMs < 15, 'Grounding task execution must be under 15ms');
});

// ── 5 Ambiguous Tasks (Must invoke Layer 3 Local Qwen Fallback) ────────────
//
// Ollama unloads the model after 5m idle, and a cold load (~23s measured on
// CPU-only hardware) legitimately exceeds QWEN_GENERATE_TIMEOUT_MS by design
// (see local-qwen-adapter.js) — the first Qwen call of an idle session is
// expected to fall back to Cloud, same as in the real extension. Warm the
// model once up front so these tests measure steady-state (~11s) behavior,
// not that expected cold-start edge case.
test('Runtime Task 6 fixture: warm up the local Qwen model before Ambiguous Task assertions', async () => {
  const adapter = new LocalQwenAdapter();
  await adapter.plan({
    goal: 'warm up',
    page: { url: 'https://example.com', title: '' },
    elements: []
  }).catch(() => {});
});

test('Runtime Task 6 (Ambiguous Qwen): "Enable notifications preference"', async () => {
  const adapter = new LocalQwenAdapter();
  const router  = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: adapter });
  // P0 #1: genuine (not floor-inflated) partial lexical overlap, split across
  // two elements so neither alone fully covers the goal's page-relatable
  // vocabulary — top L2 score stays below 0.70 (correctly misses) while
  // ranked.length > 0 (correctly routes to Qwen, not vision, per the L3
  // router). See ui-grounding-service.js's scoreElement() doc comment.
  const pageState = {
    url: 'https://settings.example.com/notifications',
    title: 'User Settings',
    elements: [
      { id: 'el_1', role: 'generic', tag: 'div', text: 'System Preference Center', visible: true, enabled: true },
      { id: 'el_2', role: 'generic', tag: 'span', text: 'Receive Email Notifications Digest', visible: true, enabled: true },
      { id: 'el_3', role: 'button', tag: 'button', text: 'Toggle Alert Channel', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Enable notifications preference', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Enable notifications preference" layer=${res.layer} qwenMs=${res.planResponse.providerMetadata.latencyMs}ms totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'local_qwen');
  assert.equal(res.planResponse.result, 'OK');
  assert.equal(res.planResponse.providerMetadata.provider, 'local-qwen');
});

test('Runtime Task 7 (Ambiguous Qwen): "Configure complex workspace settings"', async () => {
  const adapter = new LocalQwenAdapter();
  const router  = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: adapter });
  // P0 #1: a single element sharing its only overlapping token would score
  // 1.0 coverage (resolved by L2 alone) — a second element splits the
  // goal's page-relatable vocabulary so neither fully covers it.
  const pageState = {
    url: 'https://workspace.example.org/admin',
    title: 'Admin Console',
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Advanced Settings', visible: true, enabled: true },
      { id: 'el_2', role: 'generic', tag: 'div', text: 'Complex Workflow Options', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Configure complex workspace settings', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Configure complex workspace settings" layer=${res.layer} qwenMs=${res.planResponse.providerMetadata.latencyMs}ms totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'local_qwen');
  assert.equal(res.planResponse.result, 'OK');
});

test('Runtime Task 8 (Ambiguous Qwen): "Select preferred payment strategy"', async () => {
  const adapter = new LocalQwenAdapter();
  const router  = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: adapter });
  // P0 #1: the original labels shared zero vocabulary with the goal at all
  // (ranked.length === 0 -> the L3 router would pick vision, not Qwen).
  // Adding "Payment"/"Strategy" gives each element one genuine, partial,
  // goal-relatable token — still ambiguous (neither is an exact match).
  const pageState = {
    url: 'https://checkout.example.com/payment',
    title: 'Payment Gateway',
    elements: [
      { id: 'el_1', role: 'generic', tag: 'div', text: 'Option A: Digital Wallet Payment', visible: true, enabled: true },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Proceed Option B Strategy', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Select preferred payment strategy', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Select preferred payment strategy" layer=${res.layer} qwenMs=${res.planResponse.providerMetadata.latencyMs}ms totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'local_qwen');
  assert.equal(res.planResponse.result, 'OK');
});

test('Runtime Task 9 (Ambiguous Qwen): "Authorize multi-factor authentication token"', async () => {
  const adapter = new LocalQwenAdapter();
  const router  = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: adapter });
  // P0 #1: "Verify Token" alone shares only "token" with the goal — a single
  // scorable token means full (1.0) coverage, resolved by L2 alone. Adding
  // "authentication" to the other field splits the overlap across elements.
  const pageState = {
    url: 'https://auth.example.com/mfa',
    title: 'Security Challenge',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: '6-digit authentication code', visible: true, enabled: true },
      { id: 'el_2', role: 'button', tag: 'button', text: 'Verify Token', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Authorize multi-factor authentication token', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Authorize multi-factor authentication token" layer=${res.layer} qwenMs=${res.planResponse.providerMetadata.latencyMs}ms totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'local_qwen');
  assert.equal(res.planResponse.result, 'OK');
});

test('Runtime Task 10 (Ambiguous Qwen): "Resolve merge conflicts across branches"', async () => {
  const adapter = new LocalQwenAdapter();
  const router  = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: adapter });
  // P0 #1: a single element covering both of its own overlapping tokens
  // ("resolve", "conflicts") would score 1.0 coverage (resolved by L2
  // alone) — a second element splits the goal's vocabulary ("merge",
  // "branches") so neither element fully covers it.
  const pageState = {
    url: 'https://dev.example.org/pull/42',
    title: 'Pull Request Review',
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Resolve Conflicts Editor', visible: true, enabled: true },
      { id: 'el_2', role: 'generic', tag: 'div', text: 'Merge Branches View', visible: true, enabled: true }
    ]
  };

  const t0 = Date.now();
  const res = await router.route('Resolve merge conflicts across branches', pageState);
  const totalMs = Date.now() - t0;

  console.log(`[SP:V2:PERF] task="Resolve merge conflicts across branches" layer=${res.layer} qwenMs=${res.planResponse.providerMetadata.latencyMs}ms totalMs=${totalMs}ms`);

  assert.equal(res.layer, 'local_qwen');
  assert.equal(res.planResponse.result, 'OK');
});
