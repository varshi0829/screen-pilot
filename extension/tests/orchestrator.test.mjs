// ScreenPilot v2 — Orchestrator Bootstrap Tests
// Run: node extension/tests/orchestrator.test.mjs
//
// Tests the _bootstrapSession decision logic: given a persisted session phase,
// verify the correct state transition and session mutation occurs.
//
// Plan-loop tests use SessionStore.load stubs to exit the loop before the
// screenshot call (which requires a real browser runtime).

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

// ── Browser globals required before any import ────────────────────────────────
//
// Must be set BEFORE v2-task.js is imported so the module-level code sees them.

const _store = {};

// chrome.storage.session — in-memory store
global.chrome = {
  storage: {
    session: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key))     return Object.fromEntries(key.map(k => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj)    { Object.assign(_store, obj); },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete _store[k];
      },
    },
  },
  runtime: {
    // Returns {tabId:null} → module-level bootstrap skips _bootstrapSession
    sendMessage: async (msg) => {
      if (msg?.type === 'GET_TAB_ID') return { tabId: null };
      // CAPTURE_SCREENSHOT — plan loop calls this; return failure so the loop
      // errors early. Tests that need the loop to exit gracefully stub SessionStore.load
      // to return null before the screenshot call.
      return { success: false, error: 'test env' };
    },
    onMessage: { addListener: () => {} },
  },
};

// DOM stubs — getElementById must return an element stub (never null) so that
// showPausedBanner and showStatus don't crash on .addEventListener / .remove.
function makeElStub(id = '') {
  return {
    id,
    style:            { cssText: '', background: '', color: '' },
    textContent:      '',
    innerHTML:        '',
    remove:           () => {},
    appendChild:      () => {},
    addEventListener: () => {},
    querySelector:    () => null,
  };
}

global.document = {
  getElementById: (id) => makeElStub(id),
  createElement:  ()   => makeElStub(),
  body:  { appendChild: () => {} },
  title: 'Test page',
};

global.window = {
  location:          { href: 'https://example.com' },
  __SP_Highlighter:  null,
  DOMMatcher:        null,
  addEventListener:  () => {},
  removeEventListener: () => {},
};

// crypto.randomUUID is available natively in Node ≥ 19; no override needed.

// ── Import orchestrator module (after globals are set) ────────────────────────

const {
  _bootstrapSession,
  __getState,
  __getGeneration,
  __resetState,
} = await import('../v2-task.js');

const { SessionStore } = await import('../services/session-store.js');
const { TaskState }    = await import('../shared/state-machine/transitions.js');

// ── Test helpers ──────────────────────────────────────────────────────────────

function clearStore() {
  for (const k of Object.keys(_store)) delete _store[k];
}

function setUrl(url) {
  global.window.location = { href: url };
}

// Short-circuit the plan loop: make SessionStore.load return null after
// `keepAlive` real calls. This prevents the loop from reaching the screenshot.
// Returns a restore function — always call it after _bootstrapSession resolves.
function stubLoad(keepAlive = 1) {
  const orig = SessionStore.load.bind(SessionStore);
  let calls = 0;
  SessionStore.load = async (id) => {
    calls++;
    if (calls > keepAlive) return null;
    return orig(id);
  };
  return () => { SessionStore.load = orig; };
}

function makePendingStep(overrides = {}) {
  return {
    description:         'Click Issues tab',
    intent:              'navigate_to_issues',
    completionCondition: 'url_change',
    expectedUrlPattern:  '/torvalds/linux/issues',
    expectedUrlChanges:  true,
    urlBefore:           'https://github.com/torvalds/linux',
    stepStartedAt:       Date.now(),
    ...overrides,
  };
}

function makeStepRecord(overrides = {}) {
  return {
    description:         'Click Issues tab',
    intent:              'navigate_to_issues',
    completionCondition: 'url_change',
    urlBefore:           'https://github.com/torvalds/linux',
    urlAfter:            'https://github.com/torvalds/linux/issues',
    completedAt:         Date.now(),
    ...overrides,
  };
}

const TAB = 42;

// ── 1. Bootstrap with no session ──────────────────────────────────────────────

test('bootstrap — no session: state remains IDLE', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  const genBefore = __getGeneration();
  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.IDLE);
  assert.equal(__getGeneration(), genBefore + 1, 'generation must increment');
});

// ── 2. Bootstrap with expired session ─────────────────────────────────────────

test('bootstrap — expired session: state remains IDLE', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  const session = await SessionStore.create(TAB, 'Test goal');
  _store[`sp_session_${TAB}`] = { ...session, expiresAt: Date.now() - 1 };

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.IDLE);
  assert.equal(await SessionStore.load(TAB), null, 'expired session must be removed');
});

// ── 3. Bootstrap with PAUSED session ─────────────────────────────────────────

test('bootstrap — PAUSED phase: transitions IDLE → PAUSED', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Navigate to settings');
  await SessionStore.setPhase(TAB, 'PAUSED');
  await SessionStore.setBlocker(TAB, 'Login required');

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive PAUSED bootstrap');
  assert.equal(loaded.phase, 'PAUSED');
  assert.equal(loaded.currentBlocker, 'Login required');
});

// ── 4. Bootstrap with PLANNING session ───────────────────────────────────────
//
// Plan loop exits as soon as its first SessionStore.load returns null (simulating
// a session cleared mid-flight by the abort path). Verifies IDLE → PLANNING.

test('bootstrap — PLANNING phase: transitions IDLE → PLANNING', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Click the button');
  // Default phase from create() is PLANNING

  // Load sequence: 1 = bootstrap reads session, 2 = plan loop reads → returns null
  const restore = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();

  assert.equal(__getState(), TaskState.PLANNING);
});

// ── 5. Bootstrap EXECUTING + WORKFLOW_NAVIGATION ──────────────────────────────
//
// CS was destroyed mid-navigation. New CS classifies WORKFLOW_NAVIGATION,
// calls completeStep, then enters the plan loop.
// completeStep internally loads the session (1 extra load vs REFRESH/PLANNING).

test('bootstrap — EXECUTING + WORKFLOW_NAVIGATION: completes step, transitions to PLANNING', async () => {
  clearStore();
  setUrl('https://github.com/torvalds/linux/issues');
  __resetState();

  await SessionStore.create(TAB, 'Go to issues');
  await SessionStore.markPendingStep(TAB, makePendingStep({
    expectedUrlPattern: '/torvalds/linux/issues',
    urlBefore:          'https://github.com/torvalds/linux',
  }));

  // Load sequence (external SessionStore.load calls only — completeStep uses _read internally):
  //   1 = bootstrap reads session
  //   2 = plan loop reads → returns null → exits
  const origLoad = SessionStore.load.bind(SessionStore);
  const restore  = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();

  assert.equal(__getState(), TaskState.PLANNING);

  const loaded = await origLoad(TAB);
  if (loaded) {
    assert.equal(loaded.completedSteps.length, 1, 'step must be appended');
    assert.equal(loaded.completedSteps[0].intent, 'navigate_to_issues');
    assert.equal(
      loaded.completedSteps[0].urlAfter,
      'https://github.com/torvalds/linux/issues'
    );
    assert.equal(loaded.pendingStep, null,       'pendingStep must be cleared');
    assert.equal(loaded.phase,       'PLANNING');
  }
});

// ── 6. Bootstrap EXECUTING + REFRESH ─────────────────────────────────────────
//
// Same URL as urlBefore — the page was refreshed. completeStep is NOT called;
// the orchestrator re-enters the plan loop to reattempt the same step.

test('bootstrap — EXECUTING + REFRESH: does NOT complete step, transitions to PLANNING', async () => {
  clearStore();
  // Same URL as urlBefore → REFRESH
  setUrl('https://github.com/torvalds/linux');
  __resetState();

  await SessionStore.create(TAB, 'Navigate somewhere');
  await SessionStore.markPendingStep(TAB, makePendingStep({
    expectedUrlPattern: '/torvalds/linux/issues',
    urlBefore:          'https://github.com/torvalds/linux',
  }));

  // Load sequence:
  //   1 = bootstrap reads session
  //   2 = plan loop reads → returns null → exits  (no completeStep load)
  const origLoad = SessionStore.load.bind(SessionStore);
  const restore  = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();

  assert.equal(__getState(), TaskState.PLANNING);

  const loaded = await origLoad(TAB);
  if (loaded) {
    assert.equal(loaded.completedSteps.length, 0, 'REFRESH must not complete the step');
    assert.ok(loaded.pendingStep, 'pendingStep must survive a REFRESH');
  }
});

// ── 7. Bootstrap EXECUTING + BACK_BUTTON ─────────────────────────────────────
//
// Current URL matches a previously-completed step's urlAfter — user went back.
// Session must be PAUSED; step must NOT be re-completed.

test('bootstrap — EXECUTING + BACK_BUTTON: transitions IDLE → PAUSED', async () => {
  clearStore();
  setUrl('https://github.com');
  __resetState();

  await SessionStore.create(TAB, 'Navigate to issues');
  // One completed step whose urlAfter matches current URL → BACK_BUTTON signal
  await SessionStore.completeStep(TAB, makeStepRecord({ urlAfter: 'https://github.com' }));
  await SessionStore.markPendingStep(TAB, makePendingStep({
    expectedUrlPattern: '/torvalds/linux/issues',
    urlBefore:          'https://github.com/torvalds/linux',
  }));

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive BACK_BUTTON bootstrap');
  assert.equal(loaded.phase,                 'PAUSED', 'phase must be PAUSED');
  assert.equal(loaded.completedSteps.length, 1,        'must not double-count back-navigated step');
});

// ── 8. Bootstrap EXECUTING + UNKNOWN ─────────────────────────────────────────
//
// URL matches neither expected pattern nor any completed step — completely foreign.
// Session must be PAUSED so user can decide to Resume or Stop.

test('bootstrap — EXECUTING + UNKNOWN: transitions IDLE → PAUSED', async () => {
  clearStore();
  setUrl('https://totally-different-site.com');
  __resetState();

  await SessionStore.create(TAB, 'Navigate to issues');
  await SessionStore.markPendingStep(TAB, makePendingStep({
    expectedUrlPattern: '/torvalds/linux/issues',
    urlBefore:          'https://github.com/torvalds/linux',
  }));

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive UNKNOWN bootstrap');
  assert.equal(loaded.phase, 'PAUSED');
});

// ── 9. Duplicate bootstrap protection ─────────────────────────────────────────
//
// Two concurrent _bootstrapSession calls for the same tab. The second one
// increments _generation before the first one checks it after its first await,
// so the first bootstrap exits early via the generation guard.
// Only one bootstrap completes; state machine must not double-transition.

test('bootstrap — concurrent calls: only the latest generation wins', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Duplicate test');
  await SessionStore.setPhase(TAB, 'PAUSED');

  await Promise.all([
    _bootstrapSession(TAB),
    _bootstrapSession(TAB),
  ]);

  const finalState = __getState();
  assert.ok(
    finalState === TaskState.PAUSED || finalState === TaskState.IDLE,
    `expected PAUSED or IDLE, got: ${finalState}`
  );

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive concurrent bootstrap');
});

// ── 10. Generation guard: stale loop exits when new bootstrap supersedes it ───

test('bootstrap — stale generation: loop exits without clearing session', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Old goal');

  // Force the plan loop to exit on its first load (simulates a new task starting
  // which would increment _generation and make the running loop stale).
  const restore = stubLoad(1);
  const genBefore = __getGeneration();
  await _bootstrapSession(TAB);
  restore();

  assert.ok(__getGeneration() > genBefore, 'generation must advance on each bootstrap');
  // Session still exists (not cleared by a stale loop)
  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive a stubbed-out plan loop');
});

// ── 11. goal_reached: session is cleared ─────────────────────────────────────

test('goal_reached: SessionStore.clear removes the session', async () => {
  clearStore();

  await SessionStore.create(TAB, 'Some goal');
  await SessionStore.clear(TAB);

  assert.equal(await SessionStore.load(TAB), null, 'session must be null after clear');
});

// ── 12. Full state preserved across CS boundary (WORKFLOW_NAVIGATION) ─────────
//
// Previous CS leaves: 1 completed step, pendingStep, plannerAttemptCount=3.
// New CS classifies WORKFLOW_NAVIGATION, calls completeStep, enters plan loop.
// Verifies that goal, history, and planner budget are all preserved.

test('WORKFLOW_NAVIGATION — goal, completedSteps, plannerAttemptCount preserved', async () => {
  clearStore();
  setUrl('https://example.com/step2');
  __resetState();

  await SessionStore.create(TAB, 'Multi-step goal');
  await SessionStore.completeStep(TAB, makeStepRecord({
    intent:   'step_one',
    urlAfter: 'https://example.com/step1',
  }));
  await SessionStore.patchSession(TAB, { plannerAttemptCount: 3 });
  await SessionStore.markPendingStep(TAB, {
    description:         'Click Step 2',
    intent:              'step_two',
    completionCondition: 'url_change',
    expectedUrlPattern:  '/step2',
    expectedUrlChanges:  true,
    urlBefore:           'https://example.com/step1',
    stepStartedAt:       Date.now(),
  });

  const origLoad = SessionStore.load.bind(SessionStore);
  // 1=bootstrap, 2=plan loop → null (completeStep uses internal _read, not the public load)
  const restore  = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();

  const loaded = await origLoad(TAB);
  if (loaded) {
    assert.equal(loaded.goal,                      'Multi-step goal');
    assert.equal(loaded.completedSteps.length,     2,       'both steps in history');
    assert.equal(loaded.completedSteps[1].intent,  'step_two');
    assert.equal(loaded.plannerAttemptCount,        3,       'planner budget preserved');
    assert.equal(loaded.pendingStep,                null,    'pendingStep cleared');
    assert.equal(loaded.phase,                      'PLANNING');
  }
});

// ── 13. State machine: PLAN_COMPLETE transition ───────────────────────────────

test('transitions — PLANNING + PLAN_COMPLETE → COMPLETE', async () => {
  const { TRANSITIONS, TaskState: TS, TaskEvent: TE } =
    await import('../shared/state-machine/transitions.js');
  assert.equal(
    TRANSITIONS[TS.PLANNING][TE.PLAN_COMPLETE],
    TS.COMPLETE,
    'PLAN_COMPLETE must transition PLANNING → COMPLETE'
  );
});

// ── 14. State machine: WORKFLOW_PAUSED from PLANNING ─────────────────────────

test('transitions — PLANNING + WORKFLOW_PAUSED → PAUSED', async () => {
  const { TRANSITIONS, TaskState: TS, TaskEvent: TE } =
    await import('../shared/state-machine/transitions.js');
  assert.equal(
    TRANSITIONS[TS.PLANNING][TE.WORKFLOW_PAUSED],
    TS.PAUSED,
    'WORKFLOW_PAUSED must transition PLANNING → PAUSED'
  );
});

// ── 15. State machine: SESSION_RESUME ────────────────────────────────────────

test('transitions — IDLE + SESSION_RESUME → PLANNING', async () => {
  const { TRANSITIONS, TaskState: TS, TaskEvent: TE } =
    await import('../shared/state-machine/transitions.js');
  assert.equal(
    TRANSITIONS[TS.IDLE][TE.SESSION_RESUME],
    TS.PLANNING
  );
});

// ── 16. Schema version ───────────────────────────────────────────────────────

test('session schemaVersion is 3', async () => {
  clearStore();
  const session = await SessionStore.create(TAB, 'Schema test');
  assert.equal(session.schemaVersion, '3');
});

// ── 17. Planner budget enforced before screenshot ─────────────────────────────
//
// Session with plannerAttemptCount=9 and budget=10 (0 completed steps).
// The plan loop's first call to incrementPlannerAttemptOnly hits the limit
// and fires PLAN_FAILED. Session is cleared before any screenshot attempt.

test('plan loop: budget exhaustion clears session without screenshot', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Budget test');
  // budget = 10 + 2*0 = 10; count=9 → next increment → 10 >= 10 → isStuck
  await SessionStore.patchSession(TAB, { plannerAttemptCount: 9, phase: 'PLANNING' });

  // No load stub — let the loop run: it will exit after incrementPlannerAttemptOnly
  // fires isStuck=true, before ever calling chrome.runtime.sendMessage for screenshot.
  await _bootstrapSession(TAB);

  assert.equal(
    await SessionStore.load(TAB),
    null,
    'session must be cleared after budget exhaustion'
  );
});
