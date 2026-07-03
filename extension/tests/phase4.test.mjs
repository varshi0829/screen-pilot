// ScreenPilot v2 — Phase 4: Ambiguous + Blocked Recovery Tests
// Run: node extension/tests/phase4.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

// ── Browser globals ───────────────────────────────────────────────────────────

const _store = {};

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
    sendMessage: async (msg) => {
      if (msg?.type === 'GET_TAB_ID') return { tabId: null };
      return { success: false, error: 'test env' };
    },
    onMessage: { addListener: () => {} },
  },
};

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
    value:            '',
  };
}

global.document = {
  getElementById: (id) => makeElStub(id),
  createElement:  ()   => makeElStub(),
  body:  { appendChild: () => {} },
  title: 'Test page',
};

global.window = {
  location:            { href: 'https://example.com' },
  __SP_Highlighter:    null,
  DOMMatcher:          null,
  addEventListener:    () => {},
  removeEventListener: () => {},
};

// ── Import after globals ──────────────────────────────────────────────────────

const {
  _bootstrapSession,
  __getState,
  __getGeneration,
  __resetState,
  __setTabId,
  __handleResume,
  __handleClarification,
  __handleStop,
} = await import('../v2-task.js');

const {
  SessionStore,
  MAX_CONSECUTIVE_AMBIGUOUS,
  MAX_AUTH_ATTEMPTS,
} = await import('../services/session-store.js');

const { TaskState } = await import('../shared/state-machine/transitions.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAB = 42;

function clearStore() {
  for (const k of Object.keys(_store)) delete _store[k];
}

function setUrl(url) { global.window.location = { href: url }; }

// Stubs SessionStore.load (public method only — internal _read() is NOT intercepted).
// keepAlive=N: first N calls return the real session; subsequent calls return null.
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

// Wire the module's _tabId to TAB. The module-level bootstrap stub returns tabId=null,
// so we use __setTabId. Must run before any test that calls handler functions.
__setTabId(TAB);
__resetState();

// ── 1. Transition table: PLANNING + AMBIGUOUS_RECEIVED → PAUSED ───────────────

test('transitions — PLANNING + AMBIGUOUS_RECEIVED → PAUSED', async () => {
  const { TRANSITIONS, TaskState: TS, TaskEvent: TE } =
    await import('../shared/state-machine/transitions.js');
  assert.equal(
    TRANSITIONS[TS.PLANNING][TE.AMBIGUOUS_RECEIVED],
    TS.PAUSED
  );
});

// ── 2. Bootstrap PAUSED + pauseReason='ambiguous' → state PAUSED ─────────────

test('bootstrap — PAUSED/ambiguous: stays PAUSED, session preserved', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: 'Billing appears in two places',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);
  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must survive bootstrap');
  assert.equal(loaded.phase, 'PAUSED');
  assert.equal(loaded.pauseReason, 'ambiguous');
});

// ── 3. Bootstrap PAUSED + pauseReason='blocked' → state PAUSED ───────────────

test('bootstrap — PAUSED/blocked: stays PAUSED, blocker preserved', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'View account settings');
  await SessionStore.setBlocker(TAB, 'Login required');
  await SessionStore.patchSession(TAB, { pauseReason: 'blocked' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);
  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded);
  assert.equal(loaded.currentBlocker, 'Login required');
  assert.equal(loaded.pauseReason,    'blocked');
});

// ── 4. incrementAmbiguousAttempt: three calls → isStuck=true ─────────────────

test('incrementAmbiguousAttempt: MAX_CONSECUTIVE_AMBIGUOUS reached → isStuck', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Open billing');

  const r1 = await SessionStore.incrementAmbiguousAttempt(TAB);
  const r2 = await SessionStore.incrementAmbiguousAttempt(TAB);
  assert.equal(r1.isStuck, false);
  assert.equal(r2.isStuck, false);

  const r3 = await SessionStore.incrementAmbiguousAttempt(TAB);
  assert.equal(r3.isStuck, true);
  assert.ok(r3.reason?.includes('ambiguous'), `reason: ${r3.reason}`);

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.consecutiveAmbiguousCount, 3);
});

// ── 5. MAX_CONSECUTIVE_AMBIGUOUS is 3 ────────────────────────────────────────

test('MAX_CONSECUTIVE_AMBIGUOUS === 3', () => {
  assert.equal(MAX_CONSECUTIVE_AMBIGUOUS, 3);
});

// ── 6. _handleClarification: stores clarification + resets ambiguous counter ──
//
// External SessionStore.load calls:
//   1. _handleClarification itself → real session
//   2. _runPlanLoop first iteration → null → exits
// stubLoad(1): 1 real, then null.

test('_handleClarification: clarification stored, ambiguous count reset, pauseReason cleared', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, {
    consecutiveAmbiguousCount: 1,
    pauseReason:               'ambiguous',
    ambiguitySummary:          'Billing and Workspace Billing both match',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleClarification('Use the Billing menu, not Workspace Billing');
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,    1,                                             'one entry added');
  assert.equal(loaded?.clarifications?.[0]?.text, 'Use the Billing menu, not Workspace Billing', 'clarification text stored');
  assert.equal(loaded?.consecutiveAmbiguousCount, 0);
  assert.equal(loaded?.pauseReason,               null);
  assert.equal(loaded?.ambiguitySummary,          null);
});

// ── 7. _handleClarification: whitespace-only input → null ────────────────────

test('_handleClarification: whitespace-only input stored as null', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Some goal');
  await SessionStore.patchSession(TAB, {
    consecutiveAmbiguousCount: 1,
    pauseReason:               'ambiguous',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleClarification('   ');
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length ?? 0, 0, 'empty input must not add an entry');
  assert.equal(loaded?.consecutiveAmbiguousCount,   0);
});

// ── 8. clarification reset gives MAX_CONSECUTIVE_AMBIGUOUS fresh attempts ──────

test('resetting consecutiveAmbiguousCount=0 gives 3 more ambiguous attempts', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Open billing');

  await SessionStore.patchSession(TAB, { consecutiveAmbiguousCount: 2 });
  // Simulate user clarification — resets counter
  await SessionStore.patchSession(TAB, {
    clarifications:            [{ text: 'Use Billing', ambiguitySummary: null, addedAt: Date.now() }],
    consecutiveAmbiguousCount: 0,
    pauseReason:               null,
  });

  const r1 = await SessionStore.incrementAmbiguousAttempt(TAB);
  const r2 = await SessionStore.incrementAmbiguousAttempt(TAB);
  assert.equal(r1.isStuck, false);
  assert.equal(r2.isStuck, false);

  const r3 = await SessionStore.incrementAmbiguousAttempt(TAB);
  assert.equal(r3.isStuck, true, 'third attempt after reset must hit limit');
});

// ── 9. blocked resume: incrementAuthAttempt called, blocker cleared ───────────
//
// External SessionStore.load calls:
//   1. _handleResume load → real session (currentBlocker !== null → increment)
//   2. _runPlanLoop first iteration → null → exits
// stubLoad(1)

test('_handleResume from blocked: authAttemptCount incremented, blocker cleared', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'View settings');
  await SessionStore.setBlocker(TAB, 'Login required');
  await SessionStore.patchSession(TAB, { pauseReason: 'blocked' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleResume();
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.authAttemptCount, 1, 'authAttemptCount must increment on blocked resume');
  assert.equal(loaded?.currentBlocker,   null, 'blocker must be cleared');
  assert.equal(loaded?.pauseReason,      null, 'pauseReason must be cleared');
});

// ── 10. nav-interrupted resume: authAttemptCount NOT incremented ───────────────

test('_handleResume from nav-interrupted pause: authAttemptCount unchanged', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'View settings');
  await SessionStore.patchSession(TAB, { pauseReason: 'navigation', currentBlocker: null });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleResume();
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.authAttemptCount, 0, 'nav resume must not increment authAttemptCount');
});

// ── 11. auth limit: 3rd resume from blocked → IDLE, session cleared ───────────

test('blocked resume × MAX_AUTH_ATTEMPTS → IDLE, session cleared', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'View settings');
  await SessionStore.setBlocker(TAB, 'Login required');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'blocked',
    authAttemptCount: MAX_AUTH_ATTEMPTS - 1,
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // isStuck=true: plan loop never runs, only 1 external load (in _handleResume)
  const restore = stubLoad(1);
  await __handleResume();
  restore();

  assert.equal(__getState(),                  TaskState.IDLE);
  assert.equal(await SessionStore.load(TAB),  null, 'session cleared after auth exhaustion');
});

// ── 12. MAX_AUTH_ATTEMPTS is 3 ────────────────────────────────────────────────

test('MAX_AUTH_ATTEMPTS === 3', () => {
  assert.equal(MAX_AUTH_ATTEMPTS, 3);
});

// ── 13. stop from blocked banner → IDLE, session cleared ─────────────────────

test('_handleStop from blocked PAUSED: IDLE, session cleared', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'View settings');
  await SessionStore.setBlocker(TAB, 'Login required');
  await SessionStore.patchSession(TAB, { pauseReason: 'blocked' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // Bootstrap: load #1 → real session (PAUSED) → show banner → return
  // stubLoad(1) so bootstrap transitions to PAUSED, then stop doesn't need load
  const restore = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();
  assert.equal(__getState(), TaskState.PAUSED);

  await __handleStop();

  assert.equal(__getState(), TaskState.IDLE);
  assert.equal(await SessionStore.load(TAB), null, 'session cleared on stop');
});

// ── 14. stop from ambiguous banner → IDLE, session cleared ───────────────────

test('_handleStop from ambiguous PAUSED: IDLE, session cleared', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: 'Multiple billing options',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();
  assert.equal(__getState(), TaskState.PAUSED);

  await __handleStop();

  assert.equal(__getState(), TaskState.IDLE);
  assert.equal(await SessionStore.load(TAB), null, 'session cleared on stop');
});

// ── 15. failed outcome: session cleared immediately ───────────────────────────

test('failed outcome: session cleared (verifies fix for infinite re-bootstrap)', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Some goal');
  await SessionStore.clear(TAB);
  assert.equal(await SessionStore.load(TAB), null);
});

// ── 16. blocked: pauseReason and currentBlocker both written ─────────────────

test('blocked outcome: pauseReason=blocked and currentBlocker stored', async () => {
  clearStore();
  await SessionStore.create(TAB, 'View admin panel');

  const blocker = 'You must be an administrator';
  await SessionStore.setBlocker(TAB, blocker);
  await SessionStore.patchSession(TAB, { pauseReason: 'blocked' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.currentBlocker, blocker);
  assert.equal(loaded.pauseReason,    'blocked');
  assert.equal(loaded.phase,          'PAUSED');
});

// ── 17. ambiguous: pauseReason and ambiguitySummary written ──────────────────

test('ambiguous outcome: pauseReason=ambiguous and ambiguitySummary stored', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Open billing settings');

  const summary = 'Both Billing and Workspace Billing links match';
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: summary,
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.pauseReason,      'ambiguous');
  assert.equal(loaded.ambiguitySummary, summary);
  assert.equal(loaded.phase,            'PAUSED');
});

// ── 18. clarifications persist in session + sent separately from goal ─────────

test('clarifications stored in session; goal is unchanged; clarification texts mappable', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, {
    clarifications: [{ text: 'Use the Billing menu, not Workspace Billing', ambiguitySummary: null, addedAt: Date.now() }],
  });

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.clarifications.length,    1,                                             'one entry');
  assert.equal(loaded.clarifications[0].text,   'Use the Billing menu, not Workspace Billing', 'text preserved');
  // Goal is sent unchanged; clarifications go as a separate field
  assert.equal(loaded.goal, 'Open billing settings', 'goal must not be mutated');
  // Callers map clarifications to string[] for the /api/plan request
  const texts = loaded.clarifications.map(c => c.text);
  assert.deepEqual(texts, ['Use the Billing menu, not Workspace Billing']);
});

// ── 19. authAttemptCount cumulative: completeStep does not reset it ───────────

test('authAttemptCount: completeStep does not reset it', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Some goal');
  await SessionStore.patchSession(TAB, { authAttemptCount: 2 });

  await SessionStore.completeStep(TAB, {
    description:         'Click Login',
    intent:              'navigate_to_login',
    completionCondition: 'url_change',
    urlBefore:           'https://example.com',
    urlAfter:            'https://example.com/dashboard',
    completedAt:         Date.now(),
  });

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.authAttemptCount,          2, 'authAttemptCount must not reset');
  assert.equal(loaded.consecutiveAmbiguousCount, 0, 'consecutiveAmbiguousCount resets on step');
});

// ── 20. plannerAttemptCount budget exhaustion ─────────────────────────────────

test('plannerAttemptCount: budget exhaustion fires isStuck', async () => {
  clearStore();
  await SessionStore.create(TAB, 'Budget test');
  // Budget for 0 completed steps = min(10 + 2×0, 40) = 10; set to 9 so next hits limit
  await SessionStore.patchSession(TAB, { plannerAttemptCount: 9 });

  const { isStuck, reason } = await SessionStore.incrementPlannerAttemptOnly(TAB);
  assert.equal(isStuck, true);
  assert.ok(reason?.includes('Global planner'), `reason: ${reason}`);
});

// ── 21. BACK_BUTTON navigation: pauseReason=navigation ───────────────────────

test('bootstrap EXECUTING + BACK_BUTTON: pauseReason=navigation, state PAUSED', async () => {
  clearStore();
  setUrl('https://github.com');
  __resetState();

  await SessionStore.create(TAB, 'Navigate to issues');
  await SessionStore.completeStep(TAB, {
    description:         'Click link',
    intent:              'step_one',
    completionCondition: 'url_change',
    urlBefore:           'https://github.com/torvalds/linux',
    urlAfter:            'https://github.com',
    completedAt:         Date.now(),
  });
  await SessionStore.markPendingStep(TAB, {
    description:         'Click Issues tab',
    intent:              'navigate_to_issues',
    completionCondition: 'url_change',
    expectedUrlPattern:  '/torvalds/linux/issues',
    expectedUrlChanges:  true,
    urlBefore:           'https://github.com/torvalds/linux',
    stepStartedAt:       Date.now(),
  });

  await _bootstrapSession(TAB);

  assert.equal(__getState(), TaskState.PAUSED);
  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded);
  assert.equal(loaded.phase,       'PAUSED');
  assert.equal(loaded.pauseReason, 'navigation');
});

// ── 22. screenshot_failed: session cleared ────────────────────────────────────
//
// Before this fix, screenshot_failed left the session in PLANNING phase.
// On the next page load the CS would re-bootstrap, hit another screenshot
// failure, and loop indefinitely.
//
// External SessionStore.load calls before screenshot:
//   1. _bootstrapSession reads session (phase=PLANNING → enters plan loop)
//   2. _runPlanLoop top-of-loop reads session → proceeds past null-check
// (incrementPlannerAttemptOnly uses internal _read — not intercepted by stub)
// Screenshot then throws (CAPTURE_SCREENSHOT returns { success: false }).
// With the fix, session is cleared before return.
// stubLoad(2): calls 1–2 return real session; the screenshot throw exits
// before any further load is needed.

test('screenshot_failed: session cleared so CS does not re-bootstrap into same failure', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Screenshot failure test');
  // Default phase is PLANNING — bootstrap will enter the plan loop

  const restore = stubLoad(2);
  await _bootstrapSession(TAB);
  restore();

  assert.equal(
    await SessionStore.load(TAB),
    null,
    'session must be cleared after screenshot_failed'
  );
});

// ── 23. refreshExpiry on bootstrap PAUSED (blocked) ──────────────────────────
//
// A session written at T=0 might be bootstrapped at T=25min (5 min remaining).
// Before this fix, the banner would appear with only 5 minutes left; if the
// user takes longer to resolve the blocker, the session expires and clicking
// Resume shows "Session expired".
// The fix: _bootstrapSession calls refreshExpiry() before showing any PAUSED
// banner, extending the TTL to 30 minutes from the moment the banner appears.

test('bootstrap PAUSED/blocked: refreshExpiry extends TTL from banner-show moment', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'View settings');
  await SessionStore.setBlocker(TAB, 'Login required');
  await SessionStore.patchSession(TAB, { pauseReason: 'blocked' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // Artificially wind the expiry down to simulate a session that was
  // written 25 minutes ago and has only 5 minutes remaining.
  const nearExpiry = Date.now() + 5 * 60 * 1000;
  const session = await SessionStore.load(TAB);
  _store[`sp_session_${TAB}`] = { ...session, expiresAt: nearExpiry };

  await _bootstrapSession(TAB);

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must not have expired');
  assert.ok(
    loaded.expiresAt > nearExpiry,
    `expiresAt must be extended beyond the near-expiry value (got ${loaded.expiresAt}, expected > ${nearExpiry})`
  );
  assert.ok(
    loaded.expiresAt > Date.now() + 25 * 60 * 1000,
    'expiresAt must be at least 25 min from now after refresh'
  );
});

// ── 24. refreshExpiry on bootstrap PAUSED (ambiguous) ────────────────────────

test('bootstrap PAUSED/ambiguous: refreshExpiry extends TTL from banner-show moment', async () => {
  clearStore();
  setUrl('https://example.com');
  __resetState();

  await SessionStore.create(TAB, 'Open billing');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: 'Multiple paths exist',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const nearExpiry = Date.now() + 5 * 60 * 1000;
  const session = await SessionStore.load(TAB);
  _store[`sp_session_${TAB}`] = { ...session, expiresAt: nearExpiry };

  await _bootstrapSession(TAB);

  const loaded = await SessionStore.load(TAB);
  assert.ok(loaded, 'session must not have expired');
  assert.ok(
    loaded.expiresAt > nearExpiry,
    'expiresAt must be extended beyond near-expiry'
  );
});
