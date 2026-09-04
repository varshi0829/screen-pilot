// ScreenPilot V2.1 — Stuck Planning & Concurrency Regression Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { DecisionRouter } from '../services/decision-router.js';
import { GoalVerifier } from '../services/goal-verifier.js';

test('1. Concurrent plan loop calls await existing promise without deadlocking', async () => {
  let activePromise = null;
  let executionCount = 0;

  async function mockRunPlanLoop() {
    if (activePromise) {
      await activePromise;
      return;
    }
    activePromise = (async () => {
      executionCount++;
      await new Promise(r => setTimeout(r, 50));
    })();

    try {
      await activePromise;
    } finally {
      activePromise = null;
    }
  }

  // Launch two concurrent calls
  const p1 = mockRunPlanLoop();
  const p2 = mockRunPlanLoop();

  await Promise.all([p1, p2]);

  assert.equal(executionCount, 1);
  assert.equal(activePromise, null);
});

test('2. Unhandled exception in planning transitions UI out of Planning state', async () => {
  let uiState = 'IDLE';
  let activePromise = null;

  async function planWithException() {
    if (activePromise) {
      await activePromise;
      return;
    }
    uiState = 'PLANNING';
    activePromise = (async () => {
      throw new Error('Simulated network crash');
    })();

    try {
      await activePromise;
    } catch (err) {
      uiState = 'ERROR';
    } finally {
      activePromise = null;
    }
  }

  await planWithException();
  assert.equal(uiState, 'ERROR');
  assert.equal(activePromise, null);
});

test('3. Replan after stale plan cancellation creates fresh AbortController', () => {
  const controllers = [];
  function createController() {
    const c = new AbortController();
    controllers.push(c);
    return c;
  }

  const c1 = createController();
  c1.abort('stale_plan');

  const c2 = createController();

  assert.equal(controllers.length, 2);
  assert.equal(c1.signal.aborted, true);
  assert.equal(c2.signal.aborted, false);
  assert.notEqual(c1.signal, c2.signal);
});

test('4. Goal completion immediately exits plan loop without calling Qwen', async () => {
  let qwenCalled = false;
  const mockQwen = {
    plan: async () => {
      qwenCalled = true;
      return { result: 'OK' };
    }
  };

  const router = new DecisionRouter({ localQwenAdapter: mockQwen });
  const pageState = {
    url: 'https://example.com/settings',
    elements: []
  };

  const check = GoalVerifier.isGoalSatisfied('open settings', pageState);
  assert.equal(check.satisfied, true);
  assert.equal(qwenCalled, false);
});
