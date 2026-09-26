// ScreenPilot v2 — End-to-End Hierarchical Integration Test Suite

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateService } from '../services/page-state-service.js';
import { UIGroundingService } from '../services/ui-grounding-service.js';
import { DecisionRouter } from '../services/decision-router.js';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { GoalVerifier } from '../services/goal-verifier.js';

test('V2 Integration A: PageStateService extracts normalized generic page state', () => {
  const mockDoc = {
    title: 'Generic E-Commerce Store',
    querySelectorAll: () => [
      {
        tagName: 'INPUT',
        getAttribute: (k) => k === 'placeholder' ? 'Search items' : null,
        innerText: '',
        textContent: '',
        offsetParent: {},
        getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 30 }),
        closest: () => null
      },
      {
        tagName: 'BUTTON',
        getAttribute: (k) => k === 'aria-label' ? 'Search' : null,
        innerText: 'Search',
        textContent: 'Search',
        offsetParent: {},
        getBoundingClientRect: () => ({ x: 220, y: 10, width: 60, height: 30 }),
        closest: () => null
      }
    ]
  };
  const mockLoc = { href: 'https://store.example.com/catalog' };

  const state = PageStateService.extractPageState({ doc: mockDoc, loc: mockLoc });
  assert.equal(state.url, 'https://store.example.com/catalog');
  assert.equal(state.elements.length, 2);
  assert.equal(state.elements[0].role, 'textbox');
  assert.equal(state.elements[1].role, 'button');
});

test('V2 Integration B: DecisionRouter routes to Fast Local Path for exact button label', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com/login',
    title: 'Login Page',
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Sign In', visible: true, enabled: true }
    ]
  };

  const result = await router.route('Sign In', pageState);
  assert.equal(result.layer, 'deterministic');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.planResponse.plan.steps[0].targetElement.text, 'Sign In');
});

test('V2 Integration C: DecisionRouter routes to Small ML Grounding Model for fuzzy match', async () => {
  const router = new DecisionRouter();
  const pageState = {
    url: 'https://example.com/dashboard',
    title: 'Dashboard',
    elements: [
      { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Find documents and files', visible: true, enabled: true }
    ]
  };

  const result = await router.route('find documents', pageState);
  assert.equal(result.layer, 'ml_grounding');
  assert.equal(result.planResponse.result, 'OK');
  assert.ok(result.planResponse.confidence >= 0.70);
});

test('V2 Integration D: LocalQwenAdapter formats 1-action prompt and parses structured response', async () => {
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => ({
      result: 'OK',
      state: 'planned',
      plannerSummary: 'Action: click on Checkout',
      confidence: 0.9,
      plan: {
        goalType: 'action',
        confidence: 0.9,
        steps: [{
          id: 1,
          description: 'Click Checkout',
          intent: 'click_checkout',
          targetElement: { text: 'Checkout', type: 'button', elementId: 'el_1' }
        }]
      },
      providerMetadata: { provider: 'local-qwen', model: 'qwen2.5-coder:7b' }
    })
  };

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });
  // P0 #1: genuine (not floor-inflated) partial lexical overlap, split
  // across two elements so neither alone fully covers the goal's
  // page-relatable vocabulary — L2 correctly misses (ranked.length > 0 but
  // top score < 0.70), and the L3 router picks Qwen, not vision.
  const pageState = {
    url: 'https://store.example.com/cart',
    title: 'Shopping Cart',
    elements: [
      { id: 'el_1', role: 'generic', tag: 'div', text: 'Cart Items Checkout', visible: true, enabled: true },
      { id: 'el_2', role: 'generic', tag: 'div', text: 'Proceed Section', visible: true, enabled: true }
    ]
  };

  const result = await router.route('Proceed to checkout', pageState);
  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.planResponse.result, 'OK');
  assert.equal(result.planResponse.plan.steps[0].targetElement.text, 'Checkout');
});

test('V2 Integration E: Malformed Local Qwen response is safely handled as error', async () => {
  const adapter = new LocalQwenAdapter({ ollamaUrl: 'http://127.0.0.1:9999' }); // unreachable port
  const response = await adapter.plan({ goal: 'test' });
  assert.equal(response.result, 'FAILED');
  assert.equal(response.errorCode, 'OLLAMA_UNAVAILABLE');
});

test('V2 Integration F: GoalVerifier evaluates success signals and triggers early exit', () => {
  const criteria = {
    goalType: 'action',
    match: 'all',
    requiresEffect: true,
    successSignals: [{ type: 'url_matches', urlPattern: '/success' }]
  };
  const loc = { href: 'https://example.com/checkout/success' };
  const verdict = GoalVerifier.shouldComplete(criteria, { loc });
  assert.equal(verdict.complete, true);
});
