// Session Store — Unit Tests
// Run: node extension/tests/session-store.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

// ── chrome.storage.local mock ─────────────────────────────────────────────────

const _store = {};

global.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key))     return Object.fromEntries(key.map(k => [k, _store[k]]));
        return { ..._store };  // null / no-arg: return all
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

const {
  SessionStore,
  MAX_STEP_ATTEMPTS,
  MAX_PLANNER_CALLS,
  MAX_CONSECUTIVE_AMBIGUOUS,
  MAX_CONSECUTIVE_FINAL,
  MAX_AUTH_ATTEMPTS,
} = await import('../services/session-store.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStepRecord(overrides = {}) {
  return {
    description:         'Click Settings',
    intent:              'navigate_to_settings',
    completionCondition: 'url_change',
    urlBefore:           'https://example.com',
    urlAfter:            'https://example.com/settings',
    completedAt:         Date.now(),
    ...overrides,
  };
}

function makePendingStep(overrides = {}) {
  return {
    description:         'Click Settings',
    intent:              'navigate_to_settings',
    completionCondition: 'url_change',
    expectedUrlPattern:  '/settings',
    expectedUrlChanges:  true,
    urlBefore:           'https://example.com',
    stepStartedAt:       Date.now(),
    ...overrides,
  };
}

// ── 1. Create session ─────────────────────────────────────────────────────────

test('create — returns session with correct defaults', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Open Settings');

  assert.equal(session.tabId,                   42);
  assert.equal(session.goal,                    'Open Settings');
  assert.equal(session.schemaVersion,           '3');
  assert.equal(session.phase,                   'PLANNING');
  assert.equal(session.completedSteps.length,   0);
  assert.equal(session.planVersion,             0);
  assert.equal(session.plannerAttemptCount,     0);
  assert.equal(session.stepAttemptCount,        0);
  assert.equal(session.consecutiveFinalCount,   0);
  assert.equal(session.consecutiveAmbiguousCount, 0);
  assert.equal(session.goalDeniedCount,         0);
  assert.equal(session.authAttemptCount,        0);
  assert.equal(session.currentBlocker,          null);
  assert.equal(session.pageUrlAtLoad,           null);
  assert.equal(session.pendingStep,             null);
  assert.ok(session.sessionId,                  'sessionId must be set');
  assert.ok(session.expiresAt > Date.now(),     'expiresAt must be in the future');
  assert.ok(session.lastProgressAt > 0,         'lastProgressAt must be set');
});

test('create — persisted session matches returned session', async () => {
  clearStore();
  const created = await SessionStore.create(42, 'Test');
  const loaded  = await SessionStore.load(42);
  assert.equal(loaded.sessionId,  created.sessionId);
  assert.equal(loaded.goal,       created.goal);
  assert.equal(loaded.phase,      created.phase);
  assert.equal(loaded.planVersion, created.planVersion);
});

// ── 10. Load existing session ─────────────────────────────────────────────────

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

test('load — returns null for expired session and removes it', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');
  _store['sp_session_42'] = { ...session, expiresAt: Date.now() - 1 };
  const loaded = await SessionStore.load(42);
  assert.equal(loaded, null);
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
  assert.equal(await SessionStore.load(42), null);
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
  assert.ok(await SessionStore.load(2), 'tab 2 must be unaffected');
});

// ── 9. Cleanup expired ────────────────────────────────────────────────────────

test('cleanupExpired — returns 0 when nothing is expired', async () => {
  clearStore();
  await SessionStore.create(1, 'Active A');
  await SessionStore.create(2, 'Active B');
  const count = await SessionStore.cleanupExpired();
  assert.equal(count, 0);
  assert.ok(await SessionStore.load(1));
  assert.ok(await SessionStore.load(2));
});

test('cleanupExpired — removes all expired sessions and returns count', async () => {
  clearStore();
  await SessionStore.create(1, 'Active');
  await SessionStore.create(2, 'Expired A');
  await SessionStore.create(3, 'Expired B');
  _store['sp_session_2'] = { ..._store['sp_session_2'], expiresAt: Date.now() - 1 };
  _store['sp_session_3'] = { ..._store['sp_session_3'], expiresAt: Date.now() - 1 };

  const count = await SessionStore.cleanupExpired();
  assert.equal(count, 2);
  assert.ok(await SessionStore.load(1),        'active session must survive');
  assert.equal(await SessionStore.load(2), null, 'expired session 2 must be removed');
  assert.equal(await SessionStore.load(3), null, 'expired session 3 must be removed');
});

test('cleanupExpired — ignores unrelated storage keys', async () => {
  clearStore();
  _store['some_other_key'] = { expiresAt: Date.now() - 1 };
  await SessionStore.create(42, 'Test');
  const count = await SessionStore.cleanupExpired();
  assert.equal(count, 0, 'non-session keys must not be removed');
  assert.ok(_store['some_other_key'], 'unrelated key must be preserved');
});

// ── 8. Expiry refresh ─────────────────────────────────────────────────────────

test('refreshExpiry — extends expiresAt without changing other fields', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');
  const originalExpiresAt = session.expiresAt;
  await new Promise(r => setTimeout(r, 5));

  await SessionStore.refreshExpiry(42);
  const loaded = await SessionStore.load(42);

  assert.ok(loaded.expiresAt > originalExpiresAt, 'expiresAt must be extended');
  assert.equal(loaded.goal,                'Test');
  assert.equal(loaded.phase,               'PLANNING');
  assert.equal(loaded.plannerAttemptCount, 0);
  assert.equal(loaded.stepAttemptCount,    0);
});

test('refreshExpiry — no-op when session does not exist', async () => {
  clearStore();
  await assert.doesNotReject(() => SessionStore.refreshExpiry(99));
});

// ── 2. Mark pending step ──────────────────────────────────────────────────────

test('markPendingStep — writes pendingStep and sets phase to EXECUTING', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  const pending = makePendingStep();
  await SessionStore.markPendingStep(42, pending);
  const loaded = await SessionStore.load(42);
  assert.deepEqual(loaded.pendingStep, pending);
  assert.equal(loaded.phase,           'EXECUTING');
  assert.equal(loaded.goal,            'Test', 'goal must be unchanged');
  assert.equal(loaded.completedSteps.length, 0, 'completedSteps must be unchanged');
});

test('markPendingStep — overwrites a previously set pendingStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  const first  = makePendingStep({ intent: 'first_step' });
  const second = makePendingStep({ intent: 'second_step' });
  await SessionStore.markPendingStep(42, first);
  await SessionStore.markPendingStep(42, second);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.pendingStep.intent, 'second_step');
});

test('setPendingStep — backward-compat alias behaves identically to markPendingStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  const pending = makePendingStep({ intent: 'alias_test' });
  await SessionStore.setPendingStep(42, pending);
  const loaded = await SessionStore.load(42);
  assert.deepEqual(loaded.pendingStep, pending);
  assert.equal(loaded.phase, 'EXECUTING');
});

// ── 3. Complete step ──────────────────────────────────────────────────────────

test('completeStep — appends step and resets per-step counters', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.recordGoalReached(42);

  await SessionStore.completeStep(42, makeStepRecord({ intent: 'click_button' }));
  const loaded = await SessionStore.load(42);

  assert.equal(loaded.completedSteps.length,      1);
  assert.equal(loaded.completedSteps[0].intent,   'click_button');
  assert.equal(loaded.stepAttemptCount,            0,  'stepAttemptCount must reset');
  assert.equal(loaded.consecutiveAmbiguousCount,   0,  'consecutiveAmbiguousCount must reset');
  assert.equal(loaded.consecutiveFinalCount,       0,  'consecutiveFinalCount must reset');
  assert.equal(loaded.planVersion,                 1);
  assert.equal(loaded.phase,                       'PLANNING');
  assert.equal(loaded.pendingStep,                 null);
});

test('completeStep — preserves plannerAttemptCount and authAttemptCount', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttemptOnly(42);
  await SessionStore.incrementAuthAttempt(42);
  await SessionStore.completeStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 1, 'global planner count must not reset');
  assert.equal(loaded.authAttemptCount,    1, 'auth count must not reset');
});

test('completeStep — accumulates multiple steps in order', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.completeStep(42, makeStepRecord({ intent: 'step_1', urlAfter: 'https://a.com/1' }));
  await SessionStore.completeStep(42, makeStepRecord({ intent: 'step_2', urlAfter: 'https://a.com/2' }));
  await SessionStore.completeStep(42, makeStepRecord({ intent: 'step_3', urlAfter: 'https://a.com/3' }));
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.completedSteps.length,        3);
  assert.equal(loaded.completedSteps[0].intent,     'step_1');
  assert.equal(loaded.completedSteps[2].intent,     'step_3');
  assert.equal(loaded.planVersion,                  3);
});

test('appendCompletedStep — backward-compat alias behaves identically to completeStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.appendCompletedStep(42, makeStepRecord({ intent: 'via_alias' }));
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.completedSteps.length,    1);
  assert.equal(loaded.completedSteps[0].intent, 'via_alias');
  assert.equal(loaded.planVersion,              1);
  assert.equal(loaded.phase,                   'PLANNING');
  assert.equal(loaded.pendingStep,              null);
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
  assert.equal(loaded.plannerAttemptCount, 2, 'global count must not be reset');
  assert.equal(loaded.stepAttemptCount,    0, 'step count must be reset');
});

test('appendCompletedStep — sets phase to PLANNING and clears pendingStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setPendingStep(42, makePendingStep());
  await SessionStore.appendCompletedStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.phase,       'PLANNING');
  assert.equal(loaded.pendingStep, null);
});

// ── 4. Planner attempts ───────────────────────────────────────────────────────

test('incrementPlannerAttempt — increments both counters', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttempt(42);
  await SessionStore.incrementPlannerAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 2);
  assert.equal(loaded.stepAttemptCount,    2);
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

test('incrementPlannerAttemptOnly — increments plannerAttemptCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementPlannerAttemptOnly(42);
  await SessionStore.incrementPlannerAttemptOnly(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.plannerAttemptCount, 2);
  assert.equal(loaded.stepAttemptCount,    0, 'stepAttemptCount must not move');
});

test('incrementPlannerAttemptOnly — budget scales with completedSteps', async () => {
  // 5 completedSteps → budget = Math.min(10 + 10, 40) = 20
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < 5; i++) {
    await SessionStore.completeStep(42, makeStepRecord());
  }
  for (let i = 0; i < 19; i++) {
    const { isStuck } = await SessionStore.incrementPlannerAttemptOnly(42);
    assert.equal(isStuck, false, `should not be stuck before limit (attempt ${i + 1})`);
  }
  const { isStuck, reason } = await SessionStore.incrementPlannerAttemptOnly(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Global planner call limit'));
});

test('incrementStepAttempt — increments stepAttemptCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementStepAttempt(42);
  await SessionStore.incrementStepAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.stepAttemptCount,    2);
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

// ── 5. Ambiguous attempts ─────────────────────────────────────────────────────

test('incrementAmbiguousAttempt — increments consecutiveAmbiguousCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.incrementAmbiguousAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveAmbiguousCount, 2);
  assert.equal(loaded.plannerAttemptCount,        0, 'plannerAttemptCount must not move');
  assert.equal(loaded.stepAttemptCount,           0, 'stepAttemptCount must not move');
});

test('incrementAmbiguousAttempt — returns isStuck at MAX_CONSECUTIVE_AMBIGUOUS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_CONSECUTIVE_AMBIGUOUS - 1; i++) {
    const { isStuck } = await SessionStore.incrementAmbiguousAttempt(42);
    assert.equal(isStuck, false, `attempt ${i + 1} should not trigger guard`);
  }
  const { isStuck, reason } = await SessionStore.incrementAmbiguousAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('ambiguous'));
});

test('incrementAmbiguousAttempt — count resets to 0 after completeStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.completeStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveAmbiguousCount, 0);
});

// ── 6. Auth attempts ──────────────────────────────────────────────────────────

test('incrementAuthAttempt — increments authAttemptCount only', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementAuthAttempt(42);
  await SessionStore.incrementAuthAttempt(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.authAttemptCount,    2);
  assert.equal(loaded.plannerAttemptCount, 0, 'plannerAttemptCount must not move');
  assert.equal(loaded.stepAttemptCount,    0, 'stepAttemptCount must not move');
});

test('incrementAuthAttempt — returns isStuck at MAX_AUTH_ATTEMPTS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_AUTH_ATTEMPTS - 1; i++) {
    const { isStuck } = await SessionStore.incrementAuthAttempt(42);
    assert.equal(isStuck, false, `attempt ${i + 1} should not trigger guard`);
  }
  const { isStuck, reason } = await SessionStore.incrementAuthAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Auth recovery'));
});

test('incrementAuthAttempt — not reset by completeStep (cumulative)', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.incrementAuthAttempt(42);
  await SessionStore.completeStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.authAttemptCount, 1, 'auth count must survive step completion');
});

// ── 7. Goal reached ───────────────────────────────────────────────────────────

test('recordGoalReached — increments consecutiveFinalCount', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.recordGoalReached(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveFinalCount, 1);
  assert.equal(loaded.plannerAttemptCount,   0, 'plannerAttemptCount must not move');
  assert.equal(loaded.goalDeniedCount,       0, 'goalDeniedCount must not move');
});

test('recordGoalReached — returns isStuck at MAX_CONSECUTIVE_FINAL', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_CONSECUTIVE_FINAL - 1; i++) {
    const { isStuck } = await SessionStore.recordGoalReached(42);
    assert.equal(isStuck, false, `goal_reached ${i + 1} should not trigger guard`);
  }
  const { isStuck, reason } = await SessionStore.recordGoalReached(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Goal confirmation'));
});

test('recordGoalReached — user denial resets consecutive count and increments goalDeniedCount', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.recordGoalReached(42);
  await SessionStore.recordGoalReached(42);
  let loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveFinalCount, 2);

  await SessionStore.patchSession(42, {
    consecutiveFinalCount: 0,
    goalDeniedCount: loaded.goalDeniedCount + 1,
  });
  loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveFinalCount, 0, 'consecutive count must reset on denial');
  assert.equal(loaded.goalDeniedCount,       1, 'total denial count must increment');
});

test('recordGoalReached — count resets to 0 after completeStep', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.recordGoalReached(42);
  await SessionStore.recordGoalReached(42);
  await SessionStore.completeStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.consecutiveFinalCount, 0);
});

// ── setPhase ──────────────────────────────────────────────────────────────────

test('setPhase — updates phase without affecting other fields', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setPhase(42, 'RECOVERING');
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.phase,                 'RECOVERING');
  assert.equal(loaded.goal,                  'Test');
  assert.equal(loaded.completedSteps.length, 0);
});

// ── setBlocker / clearBlocker ─────────────────────────────────────────────────

test('setBlocker — writes currentBlocker without touching other fields', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setBlocker(42, 'Login required to access Settings');
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.currentBlocker,            'Login required to access Settings');
  assert.equal(loaded.goal,                      'Test',     'goal must not be clobbered');
  assert.equal(loaded.phase,                     'PLANNING', 'setBlocker must not change phase');
  assert.equal(loaded.completedSteps.length,     0,          'completedSteps must not be clobbered');
});

test('clearBlocker — resets currentBlocker to null', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  await SessionStore.setBlocker(42, 'Login required');
  await SessionStore.clearBlocker(42);
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.currentBlocker, null);
  assert.equal(loaded.goal,           'Test', 'goal must not be clobbered');
});

// ── patchSession ──────────────────────────────────────────────────────────────

test('patchSession — merges updates and preserves other fields', async () => {
  clearStore();
  const session = await SessionStore.create(42, 'Test');

  await SessionStore.patchSession(42, {
    pageUrlAtLoad:         'https://example.com/dashboard',
    consecutiveFinalCount: 3,
  });
  const loaded = await SessionStore.load(42);

  assert.equal(loaded.pageUrlAtLoad,         'https://example.com/dashboard');
  assert.equal(loaded.consecutiveFinalCount, 3);
  assert.equal(loaded.goal,                  'Test',            'goal must not be clobbered');
  assert.equal(loaded.sessionId,             session.sessionId, 'sessionId must not be clobbered');
  assert.equal(loaded.completedSteps.length, 0,                 'completedSteps must not be clobbered');
});

// ── 11. Restore after navigation ──────────────────────────────────────────────

test('session survives content script restart — full state preserved', async () => {
  clearStore();

  // First CS: goal submitted, one step completed, pending step written
  await SessionStore.create(42, 'Open account settings');
  await SessionStore.completeStep(42, makeStepRecord({
    intent:    'click_profile_menu',
    urlBefore: 'https://example.com',
    urlAfter:  'https://example.com/account',
  }));
  const pending = makePendingStep({
    description:         'Click Settings tab',
    intent:              'click_settings_tab',
    expectedUrlPattern:  '/account/settings',
    urlBefore:           'https://example.com/account',
  });
  await SessionStore.markPendingStep(42, pending);
  await SessionStore.incrementPlannerAttemptOnly(42);

  // New CS loads — simulated by calling load() fresh
  const restored = await SessionStore.load(42);

  assert.ok(restored, 'session must exist after simulated CS restart');
  assert.equal(restored.goal,                             'Open account settings');
  assert.equal(restored.completedSteps.length,            1);
  assert.equal(restored.completedSteps[0].intent,         'click_profile_menu');
  assert.equal(restored.phase,                            'EXECUTING');
  assert.deepEqual(restored.pendingStep,                  pending);
  assert.equal(restored.plannerAttemptCount,              1);
  assert.equal(restored.planVersion,                      1);
  assert.ok(restored.expiresAt > Date.now(),              'session must not be expired');
});

// ── 12. Loop guard thresholds ─────────────────────────────────────────────────

test('step loop guard — fires at exactly MAX_STEP_ATTEMPTS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_STEP_ATTEMPTS - 1; i++) {
    assert.equal((await SessionStore.incrementStepAttempt(42)).isStuck, false);
  }
  const { isStuck, reason } = await SessionStore.incrementStepAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Step attempt limit'));
  const loaded = await SessionStore.load(42);
  assert.equal(loaded.stepAttemptCount, MAX_STEP_ATTEMPTS);
});

test('planner loop guard — dynamic budget at 0 steps = 10', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < 9; i++) {
    assert.equal((await SessionStore.incrementPlannerAttemptOnly(42)).isStuck, false);
  }
  const { isStuck } = await SessionStore.incrementPlannerAttemptOnly(42);
  assert.equal(isStuck, true);
});

test('planner loop guard — dynamic budget at 10 steps = 30', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < 10; i++) {
    await SessionStore.completeStep(42, makeStepRecord());
  }
  // budget = min(10 + 20, 40) = 30 — exhaust 29, 30th triggers
  for (let i = 0; i < 29; i++) {
    assert.equal((await SessionStore.incrementPlannerAttemptOnly(42)).isStuck, false);
  }
  const { isStuck } = await SessionStore.incrementPlannerAttemptOnly(42);
  assert.equal(isStuck, true);
});

test('ambiguous loop guard — fires at exactly MAX_CONSECUTIVE_AMBIGUOUS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_CONSECUTIVE_AMBIGUOUS - 1; i++) {
    assert.equal((await SessionStore.incrementAmbiguousAttempt(42)).isStuck, false);
  }
  const { isStuck, reason } = await SessionStore.incrementAmbiguousAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('ambiguous'));
  assert.equal((await SessionStore.load(42)).consecutiveAmbiguousCount, MAX_CONSECUTIVE_AMBIGUOUS);
});

test('auth loop guard — fires at exactly MAX_AUTH_ATTEMPTS', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_AUTH_ATTEMPTS - 1; i++) {
    assert.equal((await SessionStore.incrementAuthAttempt(42)).isStuck, false);
  }
  const { isStuck, reason } = await SessionStore.incrementAuthAttempt(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Auth recovery'));
  assert.equal((await SessionStore.load(42)).authAttemptCount, MAX_AUTH_ATTEMPTS);
});

test('goal denial loop guard — fires at exactly MAX_CONSECUTIVE_FINAL', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');
  for (let i = 0; i < MAX_CONSECUTIVE_FINAL - 1; i++) {
    assert.equal((await SessionStore.recordGoalReached(42)).isStuck, false);
  }
  const { isStuck, reason } = await SessionStore.recordGoalReached(42);
  assert.equal(isStuck, true);
  assert.ok(reason.includes('Goal confirmation'));
  assert.equal((await SessionStore.load(42)).consecutiveFinalCount, MAX_CONSECUTIVE_FINAL);
});

test('completeStep resets consecutive guards but not cumulative guards', async () => {
  clearStore();
  await SessionStore.create(42, 'Test');

  // Build up consecutive counters
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.incrementAmbiguousAttempt(42);
  await SessionStore.recordGoalReached(42);
  await SessionStore.recordGoalReached(42);
  await SessionStore.incrementAuthAttempt(42);  // cumulative — must survive

  await SessionStore.completeStep(42, makeStepRecord());
  const loaded = await SessionStore.load(42);

  assert.equal(loaded.consecutiveAmbiguousCount, 0, 'ambiguous count must reset');
  assert.equal(loaded.consecutiveFinalCount,     0, 'final count must reset');
  assert.equal(loaded.authAttemptCount,          1, 'auth count must NOT reset (cumulative)');
  assert.equal(loaded.stepAttemptCount,          0, 'step count must reset');
});
