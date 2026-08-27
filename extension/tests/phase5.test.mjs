// ScreenPilot v2 — Phase 5: Clarification-Aware Planning Tests
// Run: node extension/tests/phase5.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

// ── Browser globals ───────────────────────────────────────────────────────────

const _store = {};

global.chrome = {
  storage: {
    local: {
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
  __resetState,
  __setTabId,
  __handleClarification,
} = await import('../v2-task.js');

const { SessionStore } = await import('../services/session-store.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAB = 99;

function clearStore() {
  for (const k of Object.keys(_store)) delete _store[k];
}

// Stubs SessionStore.load (public method only). keepAlive=N: first N calls real.
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

// Wire module's _tabId before any test
__setTabId(TAB);
__resetState();

// ── 1. Single clarification stored as first entry ─────────────────────────────

test('single clarification stored as first entry in clarifications array', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: 'Multiple billing paths exist',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // load #1: _handleClarification reads session; load #2: plan loop → null → exits
  const restore = stubLoad(1);
  await __handleClarification('Use the main Billing menu');
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,    1,                         'one entry added');
  assert.equal(loaded?.clarifications?.[0]?.text, 'Use the main Billing menu', 'text stored');
  assert.equal(loaded?.clarifications?.[0]?.ambiguitySummary, 'Multiple billing paths exist', 'ambiguitySummary captured');
  assert.ok(loaded?.clarifications?.[0]?.addedAt > 0, 'addedAt set');
});

// ── 2. Second clarification appends (does not overwrite) ──────────────────────

test('second clarification appends; array grows to length 2', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'First question' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // First clarification
  const r1 = stubLoad(1);
  await __handleClarification('Use the Billing tab');
  r1();

  // Manually re-set PAUSED so the second _handleClarification can load the session
  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'Second question' });
  await SessionStore.setPhase(TAB, 'PAUSED');
  __resetState();

  const r2 = stubLoad(1);
  await __handleClarification('Choose the monthly option');
  r2();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,    2,                    'two entries accumulated');
  assert.equal(loaded?.clarifications?.[0]?.text, 'Use the Billing tab',  'first entry preserved');
  assert.equal(loaded?.clarifications?.[1]?.text, 'Choose the monthly option', 'second entry appended');
});

// ── 3. Duplicate clarification text: moved to end, no duplicate entry ─────────

test('submitting same text again moves entry to end (dedup)', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'Q1' });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const r1 = stubLoad(1);
  await __handleClarification('Use the Billing tab');
  r1();

  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'Q2' });
  await SessionStore.setPhase(TAB, 'PAUSED');
  __resetState();

  // Submit different text first so there are 2 entries, then re-submit the first
  const r2 = stubLoad(1);
  await __handleClarification('Different clarification');
  r2();

  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'Q3' });
  await SessionStore.setPhase(TAB, 'PAUSED');
  __resetState();

  const r3 = stubLoad(1);
  await __handleClarification('Use the Billing tab');  // exact duplicate of first
  r3();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,        2,                       'still 2 entries after dedup');
  assert.equal(loaded?.clarifications?.[0]?.text,     'Different clarification', 'first entry unchanged');
  assert.equal(loaded?.clarifications?.[1]?.text,     'Use the Billing tab',     'dedup moved to end');
});

// ── 4. Cap at MAX_CLARIFICATIONS (5): oldest dropped on overflow ──────────────

test('cap at 5: oldest entry dropped when 6th clarification submitted', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Submit a report');

  const texts = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

  // Seed 5 clarifications directly (bypass _handleClarification to keep test fast)
  await SessionStore.patchSession(TAB, {
    clarifications: texts.map((t, i) => ({ text: t, ambiguitySummary: null, addedAt: Date.now() + i })),
  });

  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: 'Sixth question' });
  await SessionStore.setPhase(TAB, 'PAUSED');
  __resetState();

  const restore = stubLoad(1);
  await __handleClarification('Zeta');  // 6th entry — should evict 'Alpha'
  restore();

  const loaded = await SessionStore.load(TAB);
  const storedTexts = loaded?.clarifications?.map(c => c.text) ?? [];
  assert.equal(storedTexts.length, 5,                     'still capped at 5');
  assert.ok(!storedTexts.includes('Alpha'),               'oldest entry evicted');
  assert.equal(storedTexts[storedTexts.length - 1], 'Zeta', 'newest entry at end');
});

// ── 5. Empty / whitespace-only input: no entry added ─────────────────────────

test('whitespace-only clarification does not add an entry', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing settings');
  await SessionStore.patchSession(TAB, { pauseReason: 'ambiguous', ambiguitySummary: null });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleClarification('   ');
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length ?? 0, 0, 'no entry for empty input');
  assert.equal(loaded?.consecutiveAmbiguousCount,   0, 'counter still reset');
  assert.equal(loaded?.pauseReason,                 null, 'pauseReason cleared');
});

// ── 6. ambiguitySummary from session is captured in the entry ─────────────────

test('ambiguitySummary attached to clarification entry', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Navigate to settings');
  await SessionStore.patchSession(TAB, {
    pauseReason:      'ambiguous',
    ambiguitySummary: 'Settings appears in the sidebar and the header dropdown',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  const restore = stubLoad(1);
  await __handleClarification('Use the sidebar');
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(
    loaded?.clarifications?.[0]?.ambiguitySummary,
    'Settings appears in the sidebar and the header dropdown',
    'ambiguitySummary from session captured in entry',
  );
});

// ── 7. Clarifications persist after completeStep (step completion resets only counter) ──

test('clarifications persist after completeStep (not reset by step completion)', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Submit a form');
  await SessionStore.patchSession(TAB, {
    clarifications: [{ text: 'Use the primary Submit', ambiguitySummary: null, addedAt: Date.now() }],
  });

  await SessionStore.completeStep(TAB, {
    description:         'Click Submit',
    intent:              'submit_form',
    completionCondition: 'url_change',
    urlBefore:           'https://example.com/form',
    urlAfter:            'https://example.com/done',
    completedAt:         Date.now(),
  });

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,    1,                    'clarification survives step completion');
  assert.equal(loaded?.clarifications?.[0]?.text, 'Use the primary Submit', 'text intact');
  assert.equal(loaded?.consecutiveAmbiguousCount, 0,                    'ambiguous counter reset by completeStep');
});

// ── 8. Clarifications present from session on bootstrap (survive page reload) ──

test('clarifications survive bootstrap (simulate page reload from PAUSED session)', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Open billing');
  await SessionStore.patchSession(TAB, {
    clarifications: [{ text: 'Use the top Billing link', ambiguitySummary: null, addedAt: Date.now() }],
    pauseReason:    'ambiguous',
    ambiguitySummary: 'Multiple billing options',
  });
  await SessionStore.setPhase(TAB, 'PAUSED');

  // Bootstrap reads and preserves the session — clarifications must survive
  const restore = stubLoad(1);
  await _bootstrapSession(TAB);
  restore();

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded?.clarifications?.length,    1,                       'clarification survives bootstrap');
  assert.equal(loaded?.clarifications?.[0]?.text, 'Use the top Billing link', 'text intact after reload');
});

// ── 9. New session created by create() starts with empty clarifications ────────

test('SessionStore.create() initializes clarifications as empty array', async () => {
  clearStore();
  const session = await SessionStore.create(TAB, 'Fresh goal');
  assert.ok(Array.isArray(session.clarifications), 'clarifications must be an array');
  assert.equal(session.clarifications.length, 0,   'clarifications must be empty on create');
});

// ── 10. Goal is not mutated: clarifications sent separately ───────────────────

test('session.goal unchanged after clarification; clarifications map to string[]', async () => {
  clearStore();
  __resetState();

  await SessionStore.create(TAB, 'Find account settings');
  await SessionStore.patchSession(TAB, {
    clarifications: [
      { text: 'Go to Profile Settings', ambiguitySummary: null, addedAt: Date.now() },
      { text: 'Not Account Preferences', ambiguitySummary: null, addedAt: Date.now() + 1 },
    ],
  });

  const loaded = await SessionStore.load(TAB);
  assert.equal(loaded.goal, 'Find account settings', 'goal must not include clarification text');

  const texts = loaded.clarifications.map(c => c.text);
  assert.deepEqual(texts, ['Go to Profile Settings', 'Not Account Preferences'],
    'clarification texts map cleanly to string[]');
});
