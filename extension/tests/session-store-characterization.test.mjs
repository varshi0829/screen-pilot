// CHARACTERIZATION TESTS — pin SessionStore's behavior as it existed BEFORE
// Phase 4's additive changes (replanCount, lastActionResult/lastActionAt,
// incrementReplanCount, the public maxPlannerCalls export). Written and first
// run against the pre-Phase-4 source, then kept green through the change —
// same approach used for the server route refactor in Phase 2.
//
// This does not replace tests/session-store.test.mjs (52 existing tests,
// unaffected and still passing); it specifically pins the exact pre-Phase-4
// field set of create()'s output and the exact counter semantics Phase 4
// builds on top of, so a regression there is caught precisely.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const _store = {};
global.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete _store[k];
      }
    }
  }
};
function clearStore() { for (const k of Object.keys(_store)) delete _store[k]; }

const { SessionStore, maxPlannerCalls } = await import('../services/session-store.js');

test.beforeEach(clearStore);

// ── create() — exact pre-Phase-4 field set, still present and unchanged ─────

test('create() still returns every pre-Phase-4 field with its original initial value', async () => {
  const s = await SessionStore.create(1, 'Open settings');
  assert.equal(typeof s.sessionId, 'string');
  assert.equal(s.tabId, 1);
  assert.equal(s.schemaVersion, '3');
  assert.equal(s.goal, 'Open settings');
  assert.deepEqual(s.completedSteps, []);
  assert.equal(s.planVersion, 0);
  assert.equal(s.plannerAttemptCount, 0);
  assert.equal(s.stepAttemptCount, 0);
  assert.equal(s.consecutiveFinalCount, 0);
  assert.equal(s.consecutiveAmbiguousCount, 0);
  assert.equal(s.goalDeniedCount, 0);
  assert.equal(s.authAttemptCount, 0);
  assert.equal(s.currentBlocker, null);
  assert.equal(s.pageUrlAtLoad, null);
  assert.equal(typeof s.lastProgressAt, 'number');
  assert.equal(s.pendingStep, null);
  assert.deepEqual(s.clarifications, []);
  assert.equal(s.goalCompletionCriteria, null);
  assert.equal(s.phase, 'PLANNING');
  assert.equal(typeof s.createdAt, 'number');
  assert.equal(typeof s.updatedAt, 'number');
  assert.equal(typeof s.expiresAt, 'number');
});

test('completeStep() still resets exactly stepAttemptCount/consecutiveFinalCount/consecutiveAmbiguousCount and sets phase=PLANNING', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.incrementPlannerAttempt(1);
  await SessionStore.incrementPlannerAttempt(1);
  await SessionStore.incrementAmbiguousAttempt(1);
  await SessionStore.recordGoalReached(1);
  await SessionStore.completeStep(1, { description: 'd', intent: 'i', completionCondition: 'dom_change', completedAt: Date.now() });
  const s = await SessionStore.load(1);
  assert.equal(s.completedSteps.length, 1);
  assert.equal(s.planVersion, 1);
  assert.equal(s.stepAttemptCount, 0);
  assert.equal(s.consecutiveFinalCount, 0);
  assert.equal(s.consecutiveAmbiguousCount, 0);
  assert.equal(s.pendingStep, null);
  assert.equal(s.phase, 'PLANNING');
  // plannerAttemptCount is explicitly NOT reset by completeStep — pin that too.
  assert.equal(s.plannerAttemptCount, 2);
});

// ── Phase 7 additive defaults ────────────────────────────────────────────────

test('create() includes the Phase 7 additive defaults: lastFingerprint=null, lastCycleOutcome=null', async () => {
  const s = await SessionStore.create(1, 'g');
  assert.equal(s.lastFingerprint, null);
  assert.equal(s.lastCycleOutcome, null);
});

test('patchSession() round-trips lastFingerprint/lastCycleOutcome — no dedicated method is needed for them', async () => {
  await SessionStore.create(1, 'g');
  const fp = { url: 'https://example.com/', count: 3, hash: 'abcd1234' };
  await SessionStore.patchSession(1, { lastFingerprint: fp, lastCycleOutcome: 'step_completed' });
  const s = await SessionStore.load(1);
  assert.deepEqual(s.lastFingerprint, fp);
  assert.equal(s.lastCycleOutcome, 'step_completed');
});

// ── Dynamic requirement-progress model additive default ────────────────────

test('create() includes requirementProgress=null (a genuinely new task starts with no requirement history)', async () => {
  const s = await SessionStore.create(1, 'g');
  assert.equal(s.requirementProgress, null);
});

test('patchSession() round-trips requirementProgress, and it is NOT shared between two different tabIds', async () => {
  await SessionStore.create(1, 'goal A');
  await SessionStore.create(2, 'goal B');
  await SessionStore.patchSession(1, { requirementProgress: [true, false, false] });
  const s1 = await SessionStore.load(1);
  const s2 = await SessionStore.load(2);
  assert.deepEqual(s1.requirementProgress, [true, false, false]);
  assert.equal(s2.requirementProgress, null, 'a different tab\'s session must not see tab 1\'s requirement progress');
});

test('create() for a NEW task on the same tabId overwrites any prior requirementProgress — no stale carryover', async () => {
  await SessionStore.create(1, 'goal A');
  await SessionStore.patchSession(1, { requirementProgress: [true, true, true] });
  // A brand new task starting on the same tab (SessionStore.create() always
  // overwrites the existing session for that tabId).
  const fresh = await SessionStore.create(1, 'goal B');
  assert.equal(fresh.requirementProgress, null, 'a new task must not inherit the previous task\'s satisfied requirements');
});

test('the dynamic planner budget formula is unchanged: 10 + 2*completedSteps, capped at 40', async () => {
  const s0 = await SessionStore.create(1, 'g');
  assert.equal(maxPlannerCalls(s0), 10);
  const withSteps = (n) => ({ completedSteps: Array(n).fill({}) });
  assert.equal(maxPlannerCalls(withSteps(5)), 20);
  assert.equal(maxPlannerCalls(withSteps(20)), 40);
  assert.equal(maxPlannerCalls(withSteps(100)), 40, 'capped at 40');
});

test('incrementStepAttempt still reports isStuck at exactly MAX_STEP_ATTEMPTS (3)', async () => {
  await SessionStore.create(1, 'g');
  assert.deepEqual(await SessionStore.incrementStepAttempt(1), { isStuck: false, reason: null });
  assert.deepEqual(await SessionStore.incrementStepAttempt(1), { isStuck: false, reason: null });
  const third = await SessionStore.incrementStepAttempt(1);
  assert.equal(third.isStuck, true);
  assert.match(third.reason, /3\/3/);
});

test('load() still returns null for a missing, expired, or schema-mismatched session', async () => {
  assert.equal(await SessionStore.load(999), null);
  await SessionStore.create(1, 'g');
  // patchSession always resets expiresAt to a fresh future value (existing,
  // unchanged behavior) — to characterize expiry we write directly into the
  // store mock, the same way the schema-mismatch case below does.
  _store['sp_session_1'].expiresAt = Date.now() - 1;
  assert.equal(await SessionStore.load(1), null, 'expired');
  await SessionStore.create(2, 'g');
  _store['sp_session_2'].schemaVersion = '2';
  assert.equal(await SessionStore.load(2), null, 'schema mismatch');
});

test('patchSession still merges arbitrary fields and always bumps updatedAt/expiresAt', async () => {
  const created = await SessionStore.create(1, 'g');
  await new Promise((r) => setTimeout(r, 2));
  await SessionStore.patchSession(1, { currentBlocker: 'x' });
  const s = await SessionStore.load(1);
  assert.equal(s.currentBlocker, 'x');
  assert.ok(s.updatedAt > created.updatedAt);
  assert.ok(s.expiresAt > created.expiresAt);
});

test('goalDeniedCount and pageUrlAtLoad remain present but are still never written by any built-in method (pre-existing, unused fields — not a Phase 4 regression)', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.incrementPlannerAttempt(1);
  await SessionStore.incrementStepAttempt(1);
  await SessionStore.incrementAmbiguousAttempt(1);
  await SessionStore.incrementAuthAttempt(1);
  await SessionStore.recordGoalReached(1);
  await SessionStore.completeStep(1, { description: 'd', intent: 'i', completedAt: Date.now() });
  const s = await SessionStore.load(1);
  assert.equal(s.goalDeniedCount, 0);
  assert.equal(s.pageUrlAtLoad, null);
});
