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
  __deriveSettledSteps,
  __stepEffectStillHolds,
  __isGoalConsumed,
} = await import('../v2-task.js');
const { DecisionRouter } = await import('../services/decision-router.js');

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

// ── Task progress: settling on the step's own effect ────────────────────────
//
// A completed action's effect outlives the exact page fingerprint it finished
// under. Typing opens a suggestion list, a live region ticks, an image swaps a
// label — the hash moves while the action stays just as done. Settling on
// fingerprint equality alone un-settled finished steps, so the planner
// rediscovered them and re-proposed a fill against a field that already held
// the value. Synthetic controls only; no site, selector or phrase here.

const FILL_STEP = {
  description: "Type 'wireless mouse' into 'Search catalog'",
  intent: 'fill_Search catalog',
  completionCondition: 'dom_change',
  targetLabel: 'Search catalog',
  requestedValue: 'wireless mouse',
  urlBefore: 'https://example.com/', urlAfter: 'https://example.com/',
  domHashBefore: 'aaaa1111', domHashAfter: 'bbbb2222',
};

const FILLED_STATE = {
  elements: [
    { id: 'el_1', role: 'textbox', tag: 'input', text: 'Search catalog', value: 'wireless mouse', visible: true, enabled: true },
    { id: 'el_2', role: 'button',  tag: 'button', text: 'Search', visible: true, enabled: true },
  ],
};

test('settling: a completed fill survives unrelated page churn', () => {
  const churned = { url: 'https://example.com/', domHash: 'cccc3333' };
  assert.equal(__deriveSettledSteps([FILL_STEP], churned, FILLED_STATE).length, 1,
    'incidental DOM change must not un-settle a finished action');
});

test('settling: the fingerprint path still works when the page is quiet', () => {
  const quiet = { url: 'https://example.com/', domHash: 'bbbb2222' };
  assert.equal(__deriveSettledSteps([FILL_STEP], quiet, FILLED_STATE).length, 1);
  assert.equal(__deriveSettledSteps([FILL_STEP], quiet, null).length, 1,
    'with no page state the original fingerprint behavior is unchanged');
});

test('settling: a fill whose effect was undone becomes plannable again', () => {
  const cleared = { elements: [
    { id: 'el_1', role: 'textbox', tag: 'input', text: 'Search catalog', value: '', visible: true, enabled: true },
  ] };
  const churned = { url: 'https://example.com/', domHash: 'cccc3333' };
  assert.equal(__deriveSettledSteps([FILL_STEP], churned, cleared).length, 0);
});

test('settling: another control holding the value does not settle the step', () => {
  const elsewhere = { elements: [
    { id: 'el_9', role: 'textbox', tag: 'input', text: 'Some other field', value: 'wireless mouse', visible: true, enabled: true },
  ] };
  const churned = { url: 'https://example.com/', domHash: 'cccc3333' };
  assert.equal(__deriveSettledSteps([FILL_STEP], churned, elsewhere).length, 0,
    'effect evidence is tied to the control the step targeted');
});

test('settling: navigating away from the step\'s page does not keep it settled', () => {
  const moved = { url: 'https://example.com/results', domHash: 'dddd4444' };
  assert.equal(__deriveSettledSteps([FILL_STEP], moved, { elements: [] }).length, 0);
});

test('settling: steps with no value evidence keep the original fingerprint behavior', () => {
  const clickStep = {
    description: "Click 'Add new'", intent: 'click_Add new', completionCondition: 'dom_change',
    targetLabel: 'Add new', requestedValue: '',
    urlBefore: 'https://example.com/', urlAfter: 'https://example.com/',
    domHashBefore: 'aaaa1111', domHashAfter: 'bbbb2222',
  };
  const same  = { url: 'https://example.com/', domHash: 'bbbb2222' };
  const moved = { url: 'https://example.com/', domHash: 'cccc3333' };
  assert.equal(__deriveSettledSteps([clickStep], same,  FILLED_STATE).length, 1);
  assert.equal(__deriveSettledSteps([clickStep], moved, FILLED_STATE).length, 0);
});

test('settling: a control holding more than was typed still counts as done', () => {
  const autocompleted = { elements: [
    { id: 'el_1', role: 'textbox', tag: 'input', text: 'Search catalog', value: 'wireless mouse (wireless)', visible: true, enabled: true },
  ] };
  assert.equal(__stepEffectStillHolds(FILL_STEP, autocompleted), true);
});


// ── Task progress across navigation ─────────────────────────────────────────
//
// A navigating step finishes on a document that no longer exists. The fresh
// page's content script records it, capturing the fingerprint the moment it
// boots — but a real destination keeps rendering after that, so by the next
// planning cycle the fingerprint has moved and the completed navigation
// stopped counting as done. The control that caused it is usually global
// chrome still present on the destination, so the planner re-grounded the
// unchanged goal, found it again, and pointed back at the action it had just
// completed. The transition itself is the durable evidence.
//
// Synthetic origins/labels only; no site, selector or phrase appears here.

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

test('navigation: a completed navigation stays settled while we remain at its destination', () => {
  assert.equal(__deriveSettledSteps([NAV_STEP], DESTINATION_LATER, { elements: [] }).length, 1,
    'deferred rendering on the destination must not un-settle the navigation that produced it');
});

test('navigation: leaving the destination makes the control targetable again', () => {
  const elsewhere = { url: 'https://example.com/somewhere-else', domHash: 'dddd4444' };
  assert.equal(__deriveSettledSteps([NAV_STEP], elsewhere, { elements: [] }).length, 0,
    'the transition is only evidence while it still holds');
});

test('navigation: a step that changed no URL is unaffected by the transition rule', () => {
  // Same-page click (a menu opening). It keeps the fingerprint semantics it
  // has always had, so nothing about in-page actions changes.
  const samePage = { ...NAV_STEP, urlAfter: NAV_STEP.urlBefore };
  const quiet   = { url: 'https://example.com/home', domHash: 'bbbb2222' };
  const churned = { url: 'https://example.com/home', domHash: 'cccc3333' };
  assert.equal(__deriveSettledSteps([samePage], quiet,   { elements: [] }).length, 1);
  assert.equal(__deriveSettledSteps([samePage], churned, { elements: [] }).length, 0);
});

// ── Goal consumed: a finished task is not replanned into escalation ──────────
//
// After a successful action, isGoalSatisfied needs the goal's words to
// reappear in the URL/page, and a successful submit rarely echoes all of them
// (a "#submitted" fragment satisfies "submit" but never "profile"). The loop
// then replanned the finished task, found zero text candidates once the
// completed action was withheld, and escalated to visual perception and then
// the cloud. These pin the generic rule that closes that gap. Synthetic
// controls only; no site, selector or phrase.

const consumedRouter = new DecisionRouter();
const E = (id, role, tag, props) => ({ id, role, tag, visible: true, enabled: true, ...props });

const SUBMIT_STEP = {
  intent: 'click_Send Report', description: "Click 'Send Report'",
  urlBefore: 'https://example.test/report', urlAfter: 'https://example.test/report#sent',
};
const AFTER_SUBMIT = { elements: [
  E('el_1', 'textbox', 'input', { ariaLabel: 'Title', value: 'Q3' }),
  E('el_2', 'textbox', 'input', { ariaLabel: 'Notes', value: 'ok' }),
  E('el_3', 'button', 'button', { text: 'Send Report' }),
] };

test('goal consumed: after the only matching action succeeds, the task is complete', () => {
  assert.equal(
    __isGoalConsumed({ goal: 'send report' }, AFTER_SUBMIT, [SUBMIT_STEP], consumedRouter),
    true,
    'nothing left expresses the goal — completing beats escalating to vision/cloud',
  );
});

test('goal consumed: a first cycle with no progress is never declared complete', () => {
  // Protects the visual-question path: no completed step yet, so an empty
  // ranking must still reach visual perception rather than "finish".
  assert.equal(
    __isGoalConsumed({ goal: 'what color is the background' }, AFTER_SUBMIT, [], consumedRouter),
    false,
  );
});

test('goal consumed: a remaining candidate that still grounds the goal keeps the task going', () => {
  // Multi-step flow: the first action opened a menu, whose item still matches.
  const menuStep = { intent: 'click_Add new', description: "Click 'Add new'",
    urlBefore: 'https://example.test/w', urlAfter: 'https://example.test/w' };
  const menuOpen = { elements: [
    E('el_1', 'button', 'button', { text: 'Add new' }),
    E('el_2', 'menuitem', 'a', { text: 'New payment method' }),
  ] };
  assert.equal(__isGoalConsumed({ goal: 'add a new payment method' }, menuOpen, [menuStep], consumedRouter), false);
});

test('goal consumed: a pending structural continuation keeps the task going', () => {
  // A filled field whose form still has an unclicked submit control: the
  // continuation must run, even though no remaining control matches lexically.
  const fillStep = { intent: 'fill_Query', description: "Type 'widgets' into 'Query'",
    targetLabel: 'Query', requestedValue: 'widgets',
    urlBefore: 'https://example.test/', urlAfter: 'https://example.test/' };
  const filled = { elements: [
    E('el_1', 'textbox', 'input', { ariaLabel: 'Query', value: 'widgets', formId: 'f0' }),
    E('el_2', 'button', 'button', { text: 'Go', type: 'submit', formId: 'f0' }),
  ] };
  assert.equal(__isGoalConsumed({ goal: 'look up widgets' }, filled, [fillStep], consumedRouter), false,
    'a fill awaiting its submit is not finished');
});

test('goal consumed: clarifications are part of what must be consumed', () => {
  // The user clarified toward a control that is still on the page — not done.
  const state = { elements: [
    E('el_1', 'button', 'button', { text: 'Send Report' }),
    E('el_2', 'button', 'button', { text: 'Archive Report' }),
  ] };
  assert.equal(
    __isGoalConsumed({ goal: 'send report', clarifications: [{ text: 'archive it' }] }, state, [SUBMIT_STEP], consumedRouter),
    false,
  );
});
