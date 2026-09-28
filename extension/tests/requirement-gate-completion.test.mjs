// Completion-gate audit fix — regression tests.
//
// The dynamic requirement-progress model (requirement-progress.test.mjs) was
// correct on its own, but 5 OTHER completion triggers in v2-task.js never
// consulted it at all: isGoalConsumed() (B1), the pre-L3 isGoalSatisfied()
// check (B2), and three separate isTerminalStep()/completionCondition==="final"
// branches (B3 in _executeStep, B4/B5 in _bootstrapSession). A real-browser
// reproduction hit B4 directly: DecisionRouter's structural-continuation
// heuristic synthesized a "final" step after only 1 of 4 explicit
// requirements was addressed, and _bootstrapSession declared the whole task
// COMPLETE on arrival without ever calling GoalVerifier.
//
// _requirementGateAllowsCompletion() is a pure VETO added in front of all 5
// triggers — it reasons ONLY from goalCompletionCriteria + the accumulated
// requirementProgress (see applyRequirementProgress in v2-task.js), never
// from action type, form shape, step count, or site text.
//
// Same minimal browser-global mock convention as requirement-progress.test.mjs
// / goal-completion-defer.test.mjs (import-time side effects only) and the
// persistent Map-backed chrome.storage.local convention from
// session-store-characterization.test.mjs (needed here because B4/B5 tests
// actually round-trip requirementProgress through SessionStore).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const _store = {};
function clearStore() { for (const k of Object.keys(_store)) delete _store[k]; }

global.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key == null) return { ..._store };
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        for (const k of (Array.isArray(key) ? key : [key])) delete _store[k];
      },
    },
  },
  runtime: {
    sendMessage: async (msg) => (msg?.type === 'GET_TAB_ID' ? { tabId: null } : { success: false }),
    onMessage: { addListener: () => {} },
  },
};

// Minimal fake DOM — enough for v2-task.js's UI helpers (banners/status) and
// capturePageSnapshot()/classifyNavigation() to run without throwing. No real
// element matching happens in these tests (the DecisionRouter/executor layer
// is not exercised) — only the completion-transition logic under test.
let _href = 'https://example.com/new';
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, remove: () => {} }),
  body: { appendChild: () => {} },
  title: 'Test page',
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: () => [],
};
global.window = {
  get location() { return { href: _href }; },
  __SP_Highlighter: null,
  DOMMatcher: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  devicePixelRatio: 1,
};

// Any /api/plan call during these tests must resolve fast and WITHOUT
// completing the task, so a rejected completion claim can fall through into
// _runPlanLoop()'s real (but harmless) retry machinery without incurring the
// production retry backoff (HTTP/network errors ARE retried with real
// setTimeout backoff — "blocked" is not, and returns immediately).
global.fetch = async () => ({
  ok: true,
  json: async () => ({ result: 'OK', state: 'blocked', blockers: ['stub — no real planner in this test'], confidence: 0 }),
});

const {
  __requirementGateAllowsCompletion: requirementGateAllowsCompletion,
  _bootstrapSession: bootstrapSession,
  __getState: getState,
  __resetState: resetState,
  __setTabId: setTabId,
} = await import('../v2-task.js');
const { SessionStore } = await import('../services/session-store.js');

test.beforeEach(() => {
  clearStore();
  resetState();
  setTabId(1);
  _href = 'https://example.com/new';
});

const criteria4 = {
  goalType: 'action', match: 'all', verificationStrategy: 'local_signals', requiresEffect: true,
  successSignals: [
    { type: 'url_matches', urlPattern: '/test' },
    { type: 'text_present', text: 'Public' },
    { type: 'text_present', text: 'Testing' },
    { type: 'text_present', text: 'README.md' },
  ],
};

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  return fn().finally(() => { console.log = orig; }).then(() => lines);
}

// ── A-D: gate unit tests ─────────────────────────────────────────────────────

test('A. no goalCompletionCriteria -> gate allows completion', async () => {
  const allowed = await requirementGateAllowsCompletion(1, { goalCompletionCriteria: null, requirementProgress: null });
  assert.equal(allowed, true);
});

test('B. criteria exists but requiresEffect=false -> gate allows completion', async () => {
  const allowed = await requirementGateAllowsCompletion(1, {
    goalCompletionCriteria: { ...criteria4, requiresEffect: false },
    requirementProgress: null,
  });
  assert.equal(allowed, true);
});

test('C. requiresEffect=true + incomplete requirementProgress -> gate rejects completion', async () => {
  const allowed = await requirementGateAllowsCompletion(1, {
    goalCompletionCriteria: criteria4,
    requirementProgress: [false, true, false, false],
  });
  assert.equal(allowed, false);
});

test('D. requiresEffect=true + all requirements historically satisfied -> gate allows completion', async () => {
  const allowed = await requirementGateAllowsCompletion(1, {
    goalCompletionCriteria: criteria4,
    requirementProgress: [true, true, true, true],
  });
  assert.equal(allowed, true);
});

// ── E/F: exact browser-reproduction shape, via the real _bootstrapSession ───

async function seedSession({ requirementProgress, pendingStep }) {
  await SessionStore.create(1, 'Create a new GitHub repository named test, give it a description, make it public, enable README, and create the repository.');
  await SessionStore.patchSession(1, {
    phase: 'EXECUTING',
    goalCompletionCriteria: criteria4,
    requirementProgress,
    pendingStep,
    completedSteps: [{ description: 'Type the repository name', intent: "enter 'test'", completionCondition: 'input_filled', completedAt: Date.now() }],
  });
}

test('E. WORKFLOW_NAVIGATION + terminal pendingStep + incomplete requirementProgress -> task must NOT complete', async () => {
  await seedSession({
    requirementProgress: [false, true, false, false],
    pendingStep: {
      description: "Click 'Create repository'", intent: 'click_Create repository',
      completionCondition: 'final', targetLabel: 'Create repository', requestedValue: '',
      expectedUrlPattern: '/test', expectedUrlChanges: true,
      urlBefore: 'https://example.com/new', domHashBefore: 'before-hash',
      stepStartedAt: Date.now(),
    },
  });
  _href = 'https://example.com/test?name=test&visibility=public'; // matches expectedUrlPattern -> WORKFLOW_NAVIGATION

  const logs = await captureLogs(() => bootstrapSession(1));

  assert.ok(!logs.some((l) => /event=PLAN_COMPLETE/.test(l)), 'PLAN_COMPLETE must never fire while requirements remain unsatisfied');
  assert.notEqual(getState(), 'COMPLETE');
});

test('F. REFRESH-with-DOM-change + terminal pendingStep + incomplete requirementProgress -> task must NOT complete', async () => {
  await seedSession({
    requirementProgress: [false, true, false, false],
    pendingStep: {
      description: "Click 'Create repository'", intent: 'click_Create repository',
      completionCondition: 'final', targetLabel: 'Create repository', requestedValue: '',
      expectedUrlPattern: null, expectedUrlChanges: false,
      // urlBefore === current URL -> REFRESH classification (see navigation-classifier.js)
      urlBefore: 'https://example.com/new', domHashBefore: 'a-hash-that-will-not-match-the-live-empty-dom',
      stepStartedAt: Date.now(),
    },
  });
  _href = 'https://example.com/new'; // unchanged -> REFRESH

  const logs = await captureLogs(() => bootstrapSession(1));

  assert.ok(!logs.some((l) => /event=PLAN_COMPLETE/.test(l)), 'PLAN_COMPLETE must never fire on a refresh-with-dom-change either');
  assert.notEqual(getState(), 'COMPLETE');
});

test('E2/F2 non-regression: same terminal-step shape but requirementProgress fully satisfied -> completes normally', async () => {
  await seedSession({
    requirementProgress: [true, true, true, true],
    pendingStep: {
      description: "Click 'Create repository'", intent: 'click_Create repository',
      completionCondition: 'final', targetLabel: 'Create repository', requestedValue: '',
      expectedUrlPattern: '/test', expectedUrlChanges: true,
      urlBefore: 'https://example.com/new', domHashBefore: 'before-hash',
      stepStartedAt: Date.now(),
    },
  });
  _href = 'https://example.com/test?name=test&visibility=public&description=Testing&readme=on';

  const logs = await captureLogs(() => bootstrapSession(1));

  assert.ok(logs.some((l) => /event=PLAN_COMPLETE/.test(l)), 'a genuinely fully-satisfied terminal step must still complete');
});

// ── I: non-regression — criteria-less tasks complete exactly as before ──────

test('I. no goalCompletionCriteria at all -> terminal-step navigation still completes immediately (unchanged behavior)', async () => {
  await SessionStore.create(1, 'Star this repository');
  await SessionStore.patchSession(1, {
    phase: 'EXECUTING',
    goalCompletionCriteria: null,
    requirementProgress: null,
    pendingStep: {
      description: "Click 'Star'", intent: 'click_Star',
      completionCondition: 'final', targetLabel: 'Star', requestedValue: '',
      expectedUrlPattern: '/star', expectedUrlChanges: true,
      urlBefore: 'https://example.com/repo', domHashBefore: 'before-hash',
      stepStartedAt: Date.now(),
    },
    completedSteps: [],
  });
  _href = 'https://example.com/repo/star';

  const logs = await captureLogs(() => bootstrapSession(1));

  assert.ok(logs.some((l) => /event=PLAN_COMPLETE/.test(l)), 'a criteria-less goal must complete exactly as before — the gate must never veto it');
});

// ── H: static wiring assertions for the sites too heavy to drive behaviorally
// in this suite (B1/B2 live inside _runPlanLoopInternal, and B3 inside
// _executeStep's executor event callback — neither is exported, and fully
// exercising them here would mean re-implementing the real-browser harness'
// network/DOM stack in Node). Each assertion pins the exact gate expression
// at its exact call site, so removing or bypassing it fails this test file
// immediately, the same static-pinning technique goal-completion-defer.test.mjs
// already uses for route.ts's prompt text. ────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'v2-task.js'),
  'utf8'
);

test('H1. isGoalConsumed() completion (B1) is gated by _requirementGateAllowsCompletion', () => {
  assert.match(
    SRC,
    /if \(isGoalConsumed\(session, pageState, settledSteps, decisionRouter\) &&\s*\n\s*await _requirementGateAllowsCompletion\(tabId, session\)\)/,
    'B1 (isGoalConsumed) must be ANDed with the requirement gate'
  );
});

test('H2. pre-L3 isGoalSatisfied() completion (B2) is gated by _requirementGateAllowsCompletion', () => {
  assert.match(
    SRC,
    /if \(preL3Check\.satisfied && await _requirementGateAllowsCompletion\(tabId, freshSession\)\)/,
    'B2 (pre-L3 goal satisfaction check) must be ANDed with the requirement gate'
  );
});

test('G. same-page terminal-step completion in _executeStep (B3) is gated by _requirementGateAllowsCompletion', () => {
  assert.match(
    SRC,
    /if \(isTerminalStep\(plannerStep\) &&\s*\n\s*await _requirementGateAllowsCompletion\(tabId, await SessionStore\.load\(tabId\)\)\)/,
    'B3 (_executeStep terminal-step branch) must be ANDed with the requirement gate'
  );
});

test('gate helper reasons only from goalCompletionCriteria + requirementProgress (no action-type/form/step-count/site logic)', () => {
  const start = SRC.indexOf('async function _requirementGateAllowsCompletion');
  const end = SRC.indexOf('\n}', start);
  const body = SRC.slice(start, end);
  for (const forbidden of ['isFillStep', 'fill_form', 'input_filled', 'plan.steps.length', 'completionCondition', 'targetElement', 'github', 'GitHub']) {
    assert.ok(!body.includes(forbidden), `_requirementGateAllowsCompletion must not reference "${forbidden}"`);
  }
});

// ── J: Phase 7 untouched — this file makes no claim about it beyond
// confirming the fingerprint/cycle-record identifiers still exist verbatim
// (the full Phase 7 suite is run separately and unchanged by this diff).
test('J. Phase 7 fingerprint/cycle-record identifiers are untouched by this diff', () => {
  for (const id of ['computeRelevantStateFingerprint', '_cycleRecords', 'lastFingerprint', 'lastCycleOutcome', 'consecutiveSkipCount']) {
    assert.ok(SRC.includes(id), `expected Phase 7 identifier "${id}" to still be present`);
  }
});
