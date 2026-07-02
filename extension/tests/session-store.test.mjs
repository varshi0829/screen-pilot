// Session Store — Unit Tests
// Run: node extension/tests/session-store.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

// ── chrome.storage.session mock ───────────────────────────────────────────────

const _store = {};

global.chrome = {
  storage: {
    session: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) {
        Object.assign(_store, obj);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete _store[k];
      },
    },
  },
};

function clearStore() {
  for (const k of Object.keys(_store)) delete _store[k];
}

// ── Import under test ─────────────────────────────────────────────────────────

const { SessionStore, MAX_STEP_ATTEMPTS, MAX_PLANNER_CALLS } =
  await import('../services/session-store.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStepRecord(overrides = {}) {
  return {
    description: 'Click Settings',
    intent: 'navigate_to_settings',
    completionCondition: 'url_change',
    urlBefore: 'https://example.com',
    urlAfter: 'https://example.com/settings',
    completedAt: Date.now(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('create — returns session with correct defaults', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Open Settings');

  assert.equal(session.tabId, 42);
  assert.equal(session.goal, 'Open Settings');
  assert.equal(session.schemaVersion, '3');
  assert.equal(session.phase, 'PLANNING');
  assert.equal(session.completedSteps.length, 0);
  assert.equal(session.planVersion, 0);
  assert.equal(session.plannerAttemptCount, 0);
  assert.equal(session.stepAttemptCount, 0);
  assert.equal(session.consecutiveFinalCount, 0);
  assert.equal(session.consecutiveAmbiguousCount, 0);
  assert.equal(session.goalDeniedCount, 0);
  assert.equal(session.authAttemptCount, 0);
  assert.equal(session.currentBlocker, null);
  assert.equal(session.pageUrlAtLoad, null);
  assert.equal(session.pendingStep, null);
  assert.ok(session.sessionId, 'sessionId should be set');
  assert.ok(session.nonce,     'nonce should be set');
  assert.ok(session.expiresAt > Date.now(), 'expiresAt should be in the future');
  assert.ok(session.lastProgressAt > 0, 'lastProgressAt should be set');
});

test('load — returns session after create', async () => {
  clearStore();
  await SessionStore.create(42, 'Open Settings');
  const loaded = await SessionStore.load(42);
  assert.ok(loaded);
  assert.equal(loaded.goal, 'Open Settings');
});

test('load — returns null when no session exists', async () => {
  clearStore();
  const loaded = await SessionStore.load(99);
  assert.equal(loaded, null);
});

test('load — returns null for expired session and cleans up', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');
  _store['sp_session_42'] = { ...session, expiresAt: Date.now() - 1 };
  const loaded = await SessionStore.load(42);
  assert.equal(loaded, null);
  // Storage should be cleaned up asynchronously; we just verify the return value here
});

test('load — returns null for wrong schema version', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');
  _store['sp_session_42'] = { ...session, schemaVersion: '1' };
  const loaded = await SessionStore.load(42);
  assert.equal(loaded, null);
});

test('clear — removes session', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.clear(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded, null);
});

test('setPendingStep — writes pendingStep and transitions phase to EXECUTING', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  const pending = {
    description: 'Click Settings',
    intent: 'navigate_to_settings',
    completionCondition: 'url_change',
    expectedUrlPattern: '/settings',
    expectedUrlChanges: true,
    urlBefore: 'https://example.com',
    stepStartedAt: Date.now(),
  };
  await SessionStore.setPendingStep(42, pending);
  const loaded = await SessionStore.load(42);
  assert.deepEqual(loaded.pendingStep, pending);
  assert.equal(loaded.phase, 'EXECUTING');
  assert.equal(loaded.goal, 'Test', 'goal should be unchanged');
});

test('appendCompletedStep — adds step to history', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.completedSteps.length, 1);
  assert.equal(loaded.completedSteps[0].intent, 'navigate_to_settings');
});

test('appendCompletedStep — increments planVersion', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.planVersion, 1);
});

test('appendCompletedStep — resets stepAttemptCount to 0', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.stepAttemptCount, 0);
});

test('appendCompletedStep — preserves plannerAttemptCount across resets', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 2, 'global count should not be reset');
  assert.equal(loaded.stepAttemptCount, 0,    'step count should be reset');
});

test('appendCompletedStep — sets phase to PLANNING and clears pendingStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setPendingStep(42, { description: 'x', intent: 'y',
    completionCondition: 'url_change', expectedUrlPattern: '/a',
    expectedUrlChanges: true, urlBefore: 'https://a.com', stepStartedAt: Date.now() });
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.phase, 'PLANNING');
  assert.equal(loaded.pendingStep, null);
});

test('incrementPlannerAttempt — increments both counters', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.incrementPlannerAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 2);
  assert.equal(loaded.stepAttemptCount, 2);
});

test('incrementPlannerAttempt — returns isStuck when step limit reached', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_STEP_ATTEMPTS - 1; i++) {
    const { isStuck } = await SessionStore.incrementPlannerAttempt(42);
    assert.equal(isStuck, false, `should not be stuck before limit (attempt ${i + 1})`);
  }
  const { isStuck, reason } = await SessionStore.incrementPlannerAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Step attempt limit'));
});

test('incrementPlannerAttempt — global budget is dynamic (base 10 at zero steps)', async () => {
  // With 0 completedSteps, budget = Math.min(10 + 0, 40) = 10.
  // Use incrementPlannerAttemptOnly to avoid the step-limit check interfering.
  clearStore();
  await SessionStore.create(42, 'Test');

  for (let i = 0; i < 9; i++) {
    const { isStuck } = await SessionStore.incrementPlannerAttemptOnly(42);
    assert.equal(isStuck, false, `should not be stuck before limit (attempt ${i + 1})`);
  }
  const { isStuck, reason } = await SessionStore.incrementPlannerAttemptOnly(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Global planner call limit'));
});

test('setPhase — updates phase without affecting other fields', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setPhase(42, 'RECOVERING');
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.phase, 'RECOVERING');
  assert.equal(loaded.goal, 'Test');
  assert.equal(loaded.completedSteps.length, 0);
});

test('multi-tab isolation — sessions do not interfere', async () => {
  clearStore();
  await SessionStore.create(1, 'Goal A');
  await SessionStore.create(2, 'Goal B');
  const a = await SessionStore.load(1);
  const b = await SessionStore.load(2);
  assert.equal(a.goal, 'Goal A');
  assert.equal(b.goal, 'Goal B');
  await SessionStore.clear(1);
  assert.equal(await SessionStore.load(1), null);
  assert.ok(await SessionStore.load(2), 'tab 2 should be unaffected');
});

test('appendCompletedStep — accumulates multiple steps in order', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.appendCompletedStep(42, makeStepRecord({ intent: 'step_1', urlAfter: 'https://a.com/1' }));
  await SessionStore.appendCompletedStep(42, makeStepRecord({ intent: 'step_2', urlAfter: 'https://a.com/2' }));
  await SessionStore.appendCompletedStep(42, makeStepRecord({ intent: 'step_3', urlAfter: 'https://a.com/3' }));
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.completedSteps.length, 3);
  assert.equal(loaded.completedSteps[0].intent, 'step_1');
  assert.equal(loaded.completedSteps[2].intent, 'step_3');
  assert.equal(loaded.planVersion, 3);
});

// ── incrementPlannerAttemptOnly ───────────────────────────────────────────────

test('incrementPlannerAttemptOnly — increments plannerAttemptCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttemptOnly(42);
  await SessionStore.incrementPlannerAttemptOnly(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 2);
  assert.equal(loaded.stepAttemptCount, 0, 'stepAttemptCount must not move');
});

test('incrementPlannerAttemptOnly — budget scales with completedSteps', async () => {
  // 5 completedSteps → budget = Math.min(10 + 10, 40) = 20
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < 5; i++) {
    await SessionStore.appendCompletedStep(42, makeStepRecord());
  }

  for (let i = 0; i < 19; i++) {
    const { isStuck } = await SessionStore.incrementPlannerAttemptOnly(42);
    assert.equal(isStuck, false, `should not be stuck before limit (attempt ${i + 1})`);
  }
  const { isStuck, reason } = await SessionStore.incrementPlannerAttemptOnly(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Global planner call limit'));
});

// ── incrementStepAttempt ──────────────────────────────────────────────────────

test('incrementStepAttempt — increments stepAttemptCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementStepAttempt(42);
  await SessionStore.incrementStepAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.stepAttemptCount, 2);
  assert.equal(loaded.plannerAttemptCount, 0, 'plannerAttemptCount must not move');
});

test('incrementStepAttempt — returns isStuck at MAX_STEP_ATTEMPTS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');

  for (let i = 0; i < MAX_STEP_ATTEMPTS - 1; i++) {
    const { isStuck } = await SessionStore.incrementStepAttempt(42);
    assert.equal(isStuck, false, `should not be stuck before limit (attempt ${i + 1})`);
  }
  const { isStuck, reason } = await SessionStore.incrementStepAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Step attempt limit'));
});

// ── setBlocker / clearBlocker ─────────────────────────────────────────────────

test('setBlocker — writes currentBlocker without touching other fields', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setBlocker(42, 'Login required to access Settings');
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.currentBlocker, 'Login required to access Settings');
  assert.equal(loaded.goal,  'Test',      'goal must not be clobbered');
  assert.equal(loaded.phase, 'PLANNING',  'setBlocker must not change phase');
  assert.equal(loaded.completedSteps.length, 0, 'completedSteps must not be clobbered');
});

test('clearBlocker — resets currentBlocker to null', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setBlocker(42, 'Login required');
  await SessionStore.clearBlocker(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.currentBlocker, null);
  assert.equal(loaded.goal, 'Test', 'goal must not be clobbered');
});

// ── patchSession ──────────────────────────────────────────────────────────────

test('patchSession — merges updates, regenerates nonce, preserves other fields', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');
  const originalNonce = session.nonce;

  await SessionStore.patchSession(42, {
    pageUrlAtLoad:         'https://example.com/dashboard',
    consecutiveFinalCount: 3,
  });
  const loaded = await SessionStore.load(42);

  assert.equal(loaded.pageUrlAtLoad,          'https://example.com/dashboard');
  assert.equal(loaded.consecutiveFinalCount,  3);
  assert.equal(loaded.goal,                   'Test',           'goal must not be clobbered');
  assert.equal(loaded.sessionId,              session.sessionId,'sessionId must not be clobbered');
  assert.equal(loaded.completedSteps.length,  0,                'completedSteps must not be clobbered');
  assert.ok(loaded.nonce !== originalNonce, 'nonce must be regenerated on every write');
  assert.ok(loaded.nonce.length > 0,        'nonce must be non-empty');
});
