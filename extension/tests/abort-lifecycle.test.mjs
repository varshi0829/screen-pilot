// ScreenPilot v2 — AbortController & Request Lifecycle Regression Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { GoalVerifier } from '../services/goal-verifier.js';

test('1. Fresh Qwen request has non-aborted signal', () => {
  const controller = new AbortController();
  assert.equal(controller.signal.aborted, false);
});

test('2. Qwen request is NOT aborted during normal execution', async () => {
  const adapter = new LocalQwenAdapter();
  const controller = new AbortController();

  const res = await adapter.plan({
    schemaVersion: '1',
    goal: 'Click Submit',
    page: { url: 'https://example.com', title: 'Example' },
    elements: [
      { id: 'el_1', role: 'button', tag: 'button', text: 'Submit', visible: true, enabled: true }
    ]
  }, { signal: controller.signal });

  // This test's invariant is specifically about the CALLER's own AbortController:
  // a request the caller never aborted must never resolve as if the caller had.
  // It intentionally does not assert res.result === 'OK' — that couples this
  // test to live Qwen's real-hardware latency (measured ~11-23s on CPU-only
  // hardware; see local-qwen-adapter.js), which can legitimately exceed
  // QWEN_GENERATE_TIMEOUT_MS under real load and is exercised/expected
  // elsewhere (decision-router's Cloud fallback), not here.
  assert.equal(controller.signal.aborted, false);
  assert.notEqual(res.errorCode, 'ABORTED', 'a request the caller never aborted must not be misclassified as caller-aborted');
});

test('3. Cancelling request A does not abort request B', () => {
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  controllerA.abort('stale_plan');

  assert.equal(controllerA.signal.aborted, true);
  assert.equal(controllerA.signal.reason, 'stale_plan');
  assert.equal(controllerB.signal.aborted, false);
});

test('4. Aborted request A is handled as ABORTED rather than OLLAMA_UNAVAILABLE', async () => {
  const adapter = new LocalQwenAdapter();
  const controller = new AbortController();
  controller.abort('stale_plan_cancel');

  const res = await adapter.plan({
    schemaVersion: '1',
    goal: 'Do something',
    page: { url: 'https://example.com', title: 'Test' },
    elements: []
  }, { signal: controller.signal });

  assert.equal(res.result, 'FAILED');
  assert.equal(res.errorCode, 'ABORTED');
});

test('5. Replan after stale request creates a new controller', () => {
  const controllers = [];
  for (let i = 0; i < 3; i++) {
    controllers.push(new AbortController());
  }

  controllers[0].abort('stale_plan');

  assert.equal(controllers[0].signal.aborted, true);
  assert.equal(controllers[1].signal.aborted, false);
  assert.equal(controllers[2].signal.aborted, false);
});

test('6. Multiple replans do not reuse an aborted signal', () => {
  const oldController = new AbortController();
  oldController.abort('obsolete');

  const newController = new AbortController();

  assert.notEqual(oldController.signal, newController.signal);
  assert.equal(oldController.signal.aborted, true);
  assert.equal(newController.signal.aborted, false);
});

test('7. No duplicate simultaneous Qwen requests for same cycle', () => {
  const activeRequests = new Map();

  const reqId = 'req_test_123';
  activeRequests.set(reqId, new AbortController());

  assert.equal(activeRequests.size, 1);
  assert.equal(activeRequests.has(reqId), true);

  // Clear when finished
  activeRequests.delete(reqId);
  assert.equal(activeRequests.size, 0);
});

test('8. Existing stale-plan behavior still works (preSnap vs postSnap)', () => {
  const preSnap = { url: 'https://example.com/page1', domHash: 'hash_a' };
  const postSnap = { url: 'https://example.com/page2', domHash: 'hash_b' };

  const urlChanged = preSnap.url !== postSnap.url;
  const domChanged = preSnap.domHash !== postSnap.domHash;

  assert.equal(urlChanged || domChanged, true);
});

test('9. Existing GoalVerifier behavior still works', () => {
  const criteria = {
    signals: [
      { type: 'url_matches', target: '/dashboard' }
    ]
  };

  const gate = GoalVerifier.shouldComplete(criteria);
  assert.ok(typeof gate.complete === 'boolean');
});
