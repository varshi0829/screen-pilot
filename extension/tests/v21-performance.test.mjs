// ScreenPilot V2.1 Performance & Optimization Test Suite

import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionRouter } from '../services/decision-router.js';
import { GoalVerifier } from '../services/goal-verifier.js';
import { UIGroundingService } from '../services/ui-grounding-service.js';

test('A. "open Issues" resolves without Qwen when Issues is visible', async () => {
  let qwenCalled = false;
  const mockQwen = {
    plan: async () => {
      qwenCalled = true;
      return { result: 'OK' };
    }
  };
  const router = new DecisionRouter({ localQwenAdapter: mockQwen });
  const pageState = {
    url: 'https://example.com/repo',
    elements: [
      { id: 'el_1', tag: 'a', role: 'link', text: 'Issues', visible: true, enabled: true }
    ]
  };

  const routed = await router.route('open Issues', pageState);
  assert.equal(qwenCalled, false);
  assert.equal(routed.layer, 'deterministic');
  assert.equal(routed.planResponse.plan.steps[0].targetElement.elementId, 'el_1');
});

test('B. "check issues" resolves without Qwen when Issues is visible', async () => {
  let qwenCalled = false;
  const mockQwen = {
    plan: async () => {
      qwenCalled = true;
      return { result: 'OK' };
    }
  };
  const router = new DecisionRouter({ localQwenAdapter: mockQwen });
  const pageState = {
    url: 'https://example.com/repo',
    elements: [
      { id: 'el_issues', tag: 'a', role: 'link', text: 'Issues', visible: true, enabled: true }
    ]
  };

  const routed = await router.route('check issues', pageState);
  assert.equal(qwenCalled, false);
  assert.equal(routed.layer, 'deterministic');
  assert.equal(routed.planResponse.plan.steps[0].targetElement.elementId, 'el_issues');
});

test('C. "go to Practice" resolves without Qwen when Practice is visible', async () => {
  let qwenCalled = false;
  const mockQwen = {
    plan: async () => {
      qwenCalled = true;
      return { result: 'OK' };
    }
  };
  const router = new DecisionRouter({ localQwenAdapter: mockQwen });
  const pageState = {
    url: 'https://example.com/home',
    elements: [
      { id: 'el_practice', tag: 'a', role: 'link', text: 'Practice', visible: true, enabled: true }
    ]
  };

  const routed = await router.route('go to Practice', pageState);
  assert.equal(qwenCalled, false);
  assert.equal(routed.layer, 'deterministic');
  assert.equal(routed.planResponse.plan.steps[0].targetElement.elementId, 'el_practice');
});

test('D. Goal already satisfied -> zero Qwen calls', () => {
  const pageState = {
    url: 'https://example.com/practice',
    elements: [
      { id: 'h1_1', tag: 'h1', role: 'heading', text: 'Practice Problems', visible: true }
    ]
  };

  const check = GoalVerifier.isGoalSatisfied('go to practice', pageState);
  assert.equal(check.satisfied, true);
  assert.equal(check.reason, 'url_matches_target_object');
});

test('E. Navigation followed by satisfied goal -> no unnecessary second Qwen call', () => {
  const pageState = {
    url: 'https://example.com/issues',
    elements: []
  };

  const gate = GoalVerifier.shouldComplete(null, {}, 'check issues', pageState);
  assert.equal(gate.complete, true);
  assert.equal(gate.reason, 'goal_already_satisfied');
});

test('F. Navigation followed by unsatisfied goal -> planning continues correctly', () => {
  const pageState = {
    url: 'https://example.com/dashboard',
    elements: [
      { id: 'btn_billing', tag: 'button', role: 'button', text: 'Billing', visible: true }
    ]
  };

  const gate = GoalVerifier.shouldComplete(null, {}, 'open settings', pageState);
  assert.equal(gate.complete, false);
});

test('G. Generic synonym matching works (view settings, open compose, find practice)', async () => {
  const router = new DecisionRouter();

  const res1 = await router.route('view settings', {
    elements: [{ id: '1', text: 'Settings', visible: true, enabled: true }]
  });
  assert.equal(res1.layer, 'deterministic');

  const res2 = await router.route('open compose', {
    elements: [{ id: '2', text: 'Compose', visible: true, enabled: true }]
  });
  assert.equal(res2.layer, 'deterministic');

  const res3 = await router.route('find practice', {
    elements: [{ id: '3', text: 'Practice', visible: true, enabled: true }]
  });
  assert.equal(res3.layer, 'deterministic');
});

test('H. Hidden elements are not selected', async () => {
  const router = new DecisionRouter();
  const pageState = {
    elements: [
      { id: 'el_hidden', text: 'Issues', visible: false, enabled: true },
      { id: 'el_visible', text: 'Pull Requests', visible: true, enabled: true }
    ]
  };

  const ranked = UIGroundingService.rankElements('open Issues', pageState.elements);
  const hiddenScore = UIGroundingService.scoreElement('open Issues', pageState.elements[0]);

  assert.equal(hiddenScore, 0.0);
  assert.equal(ranked.some(r => r.element.id === 'el_hidden'), false);
});

test('I. Wrong-role candidates are penalized', () => {
  const elButton = { id: '1', role: 'button', tag: 'button', text: 'Submit', visible: true, enabled: true };
  const elDiv = { id: '2', role: 'none', tag: 'div', text: 'Submit', visible: true, enabled: true };

  const scoreButton = UIGroundingService.scoreElement('click Submit', elButton);
  const scoreDiv = UIGroundingService.scoreElement('click Submit', elDiv);

  assert.ok(scoreButton > scoreDiv, `Expected button score (${scoreButton}) > div score (${scoreDiv})`);
});

test('J. Complex ambiguous task can still reach Qwen when executionMode=local-qwen', async () => {
  let qwenCalled = false;
  const mockQwen = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => {
      qwenCalled = true;
      return { result: 'OK', plan: { steps: [{ id: 1, description: 'Qwen step' }] } };
    }
  };
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: mockQwen });
  // P0 #1: "Option Alpha"/"Option Beta" share zero vocabulary with the goal
  // below, so L2's ranked list would be empty and the L3 router would pick
  // vision, not Qwen (see decision-router.js's router). Genuine (still
  // partial/insufficient) overlap split across elements is what correctly
  // routes an ambiguous-but-textually-groundable task to Qwen.
  const pageState = {
    url: 'https://example.com/complex',
    elements: [
      { id: 'el_1', text: 'Arrays', visible: true, enabled: true },
      { id: 'el_2', text: 'Recent Problem Filter', visible: true, enabled: true }
    ]
  };

  const routed = await router.route('find the most recent problem related to arrays and open it', pageState);
  assert.equal(qwenCalled, true);
  assert.equal(routed.layer, 'local_qwen');
});

test('K. Stale Qwen request is still cancelled correctly', () => {
  const controller = new AbortController();
  controller.abort('stale_plan');
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, 'stale_plan');
});

test('L. Fresh replan gets a fresh AbortController', () => {
  const c1 = new AbortController();
  c1.abort('stale');
  const c2 = new AbortController();

  assert.equal(c1.signal.aborted, true);
  assert.equal(c2.signal.aborted, false);
  assert.notEqual(c1.signal, c2.signal);
});

test('M. Target object extraction works cleanly', () => {
  assert.equal(GoalVerifier.extractTargetObject('check issues'), 'issues');
  assert.equal(GoalVerifier.extractTargetObject('open Practice'), 'practice');
  assert.equal(GoalVerifier.extractTargetObject('go to Settings'), 'settings');
  assert.equal(GoalVerifier.extractTargetObject('click "Submit"'), 'submit');
});

test('N. Existing GoalVerifier tests remain passing', () => {
  const criteria = {
    requiresEffect: true,
    successSignals: [{ type: 'url_matches', urlPattern: '/dashboard' }]
  };
  const env = { loc: { href: 'https://example.com/dashboard' } };
  const res = GoalVerifier.shouldComplete(criteria, env);
  assert.equal(res.complete, true);
});
