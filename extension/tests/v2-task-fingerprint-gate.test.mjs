// ScreenPilot v2 — Phase 7 fingerprint-optimization gate regression tests.
//
// Same mocked-browser harness convention as state-progression.test.mjs
// (DecisionRouter.prototype.route monkey-patched, chrome.storage/document/
// window stubbed, _bootstrapSession driven directly) — reused here rather
// than inventing a second harness. window.DOMMatcher is null in this
// environment (same as state-progression.test.mjs), so any real plan that
// reaches _executeStep resolves "element_not_found" — which is exactly what
// scenario 4 below needs, and is why scenarios 1-3 seed the session's
// lastCycleOutcome/lastFingerprint directly (via SessionStore.create +
// patchSession) rather than trying to drive a full successful click-through,
// mirroring how the existing "Goal consumed"/"Dedup guard" tests in
// state-progression.test.mjs already seed a completed step directly instead
// of executing one.
//
// Covers exactly the six scenarios named in the Phase 7 implementation scope:
//   1. first skip
//   2. second unchanged cycle forces routing
//   3. meaningful change forces routing
//   4. failure prevents skip
//   5. Gap #1 regression (source-level — see its own comment)
//   6. Gap #2 regression (source-level — see its own comment)

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';
import fs                   from 'node:fs';
import path                 from 'node:path';
import { fileURLToPath }    from 'node:url';

// ── Browser globals (same shape as state-progression.test.mjs) ─────────────

const _store = {};
let _currentUrl = 'https://example.com';
let _fakeButtonTexts = ['star', 'fork', 'watch'];

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
  },
  runtime: {
    sendMessage: async (msg) => {
      if (msg?.type === 'GET_TAB_ID') return { tabId: null };
      return { success: false, error: 'test env' };
    },
    onMessage: { addListener: () => {} },
  },
};

function makeElStub() {
  return {
    style: { cssText: '', background: '', color: '' },
    textContent: '', innerHTML: '',
    remove: () => {}, appendChild: () => {}, addEventListener: () => {},
    querySelector: () => null, value: '',
  };
}

function makeFakeButton(text) {
  return {
    getAttribute: (attr) => attr === 'aria-label' ? text : null,
    innerText: text,
    offsetParent: {},
    getBoundingClientRect: () => ({ width: 20, height: 20, x: 0, y: 0 }),
    tagName: 'BUTTON',
    closest: () => null,
    disabled: false,
  };
}

global.document = {
  getElementById: () => makeElStub(),
  createElement:  () => makeElStub(),
  body: { appendChild: () => {} },
  title: 'Test page',
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: (sel) => {
    // Same convention as state-progression.test.mjs: only the selector
    // family both page-snapshot.js's domHash AND page-state-service.js's
    // extraction use (they both include 'button') is intercepted.
    if (typeof sel === 'string' && sel.includes('button')) return _fakeButtonTexts.map(makeFakeButton);
    return [];
  },
};

global.window = {
  get location() { return { href: _currentUrl }; },
  __SP_Highlighter: null,
  DOMMatcher: null, // absent on purpose — see the module doc comment above
  addEventListener: () => {},
  removeEventListener: () => {},
};

function setDomHash(texts) { _fakeButtonTexts = texts; }

// ── Import modules (page-snapshot first, to warm the ESM cache — same order
//    state-progression.test.mjs uses) ────────────────────────────────────────

const { computeRelevantStateFingerprint } = await import('../lib/page-snapshot.js');
const { PageStateService } = await import('../services/page-state-service.js');
const { _bootstrapSession, __resetState, __setTabId } = await import('../v2-task.js');
const { SessionStore } = await import('../services/session-store.js');
const { DecisionRouter } = await import('../services/decision-router.js');

const TAB = 91;

function clearStore() { for (const k of Object.keys(_store)) delete _store[k]; }
function setUrl(url) { _currentUrl = url; }

/** The fingerprint v2-task.js's own gate would compute right now, for the
 *  CURRENT _fakeButtonTexts — used to seed session.lastFingerprint so it
 *  matches exactly what the gate will (re-)compute on its own next cycle. */
function currentRelevantFingerprint() {
  return computeRelevantStateFingerprint(PageStateService.extractPageState());
}

// Stub SessionStore.load: first N calls return the real value, then null —
// the same bounded-iteration technique state-progression.test.mjs uses to
// stop the while(true) plan loop deterministically without a full DOM.
function stubLoad(keepAlive) {
  const orig = SessionStore.load.bind(SessionStore);
  let calls = 0;
  SessionStore.load = async (id) => {
    calls++;
    return calls > keepAlive ? null : orig(id);
  };
  return () => { SessionStore.load = orig; };
}

test.beforeEach(() => {
  clearStore();
  setUrl('https://example.com');
  __resetState();
  __setTabId(TAB);
  setDomHash(['star', 'fork', 'watch']);
});

// ── 1. First skip ────────────────────────────────────────────────────────────

// A minimal, FAST, deterministic route mock: increments a counter and
// immediately resolves a non-retryable FAILED response, which the existing
// (unmodified) "outcome === 'failed'" branch turns into a clean
// SessionStore.clear() + return — ending the plan loop in exactly one more
// step, with no dependency on stubLoad's iteration count and no real
// network/model call (unlike delegating to the real DecisionRouter.route(),
// which would need executionMode/fetch/Ollama and is not what these tests
// are about — they only care how many times route() is REACHED).
function countingFailFastRoute(counter) {
  return async function () {
    counter.calls++;
    return {
      layer: 'cloud', layer1Ms: 0, layer2Ms: 0, qwenMs: 0, cloudMs: 0, visionMs: 0,
      planResponse: { schemaVersion: '1', result: 'FAILED', error: 'test stub', errorCode: 'test_stub', confidence: 0 },
    };
  };
}

test('1. first skip: lastCycleOutcome=step_completed + matching fingerprint -> decisionRouter.route() is NOT called', async () => {
  const counter = { calls: 0 };
  const origRoute = DecisionRouter.prototype.route;
  DecisionRouter.prototype.route = countingFailFastRoute(counter);

  try {
    const fp = currentRelevantFingerprint();
    await SessionStore.create(TAB, 'do something on the page');
    await SessionStore.patchSession(TAB, { lastCycleOutcome: 'step_completed', lastFingerprint: fp });

    // Exactly ONE real session-load-based iteration: it must skip and
    // `continue`; the NEXT load then returns null (stubLoad(1)), ending the
    // loop cleanly BEFORE the consecutiveSkipCount<1 cap could ever force a
    // second, real cycle (that forced-second-cycle case is scenario 2, not
    // this one).
    const restore = stubLoad(1);
    await _bootstrapSession(TAB);
    restore();

    assert.equal(counter.calls, 0, 'an unchanged fingerprint right after a genuine success must skip routing entirely');
  } finally {
    DecisionRouter.prototype.route = origRoute;
  }
});

// ── 2. Second unchanged cycle forces routing (the consecutiveSkipCount<1 cap) ─

test('2. second unchanged cycle forces routing: the skip cap allows at most one skip in a row', async () => {
  const counter = { calls: 0 };
  const origRoute = DecisionRouter.prototype.route;
  DecisionRouter.prototype.route = countingFailFastRoute(counter);

  try {
    const fp = currentRelevantFingerprint();
    await SessionStore.create(TAB, 'do something on the page');
    await SessionStore.patchSession(TAB, { lastCycleOutcome: 'step_completed', lastFingerprint: fp });

    // consecutiveSkipCount is in-memory and local to ONE _runPlanLoopInternal
    // call, so both the first (skip) and second (forced-real) iterations must
    // happen within the SAME _bootstrapSession call. The forced-real cycle's
    // FAILED response ends the loop via SessionStore.clear()+return, so any
    // stubLoad budget of 2 or more is sufficient — it never gets used up.
    const restore = stubLoad(4);
    await _bootstrapSession(TAB);
    restore();

    assert.equal(counter.calls, 1, 'exactly one real route() call — the second unchanged cycle, forced by the cap');
  } finally {
    DecisionRouter.prototype.route = origRoute;
  }
});

// ── 3. Meaningful change forces routing ─────────────────────────────────────

test('3. meaningful change forces routing: a changed fingerprint is never skip-eligible, even right after step_completed', async () => {
  const counter = { calls: 0 };
  const origRoute = DecisionRouter.prototype.route;
  DecisionRouter.prototype.route = countingFailFastRoute(counter);

  try {
    // Seed lastFingerprint from a DIFFERENT element set than what the gate
    // will see this cycle.
    setDomHash(['star', 'fork']);
    const staleFp = currentRelevantFingerprint();
    setDomHash(['star', 'fork', 'watch', 'new-button']); // a real, additional visible control
    await SessionStore.create(TAB, 'do something on the page');
    await SessionStore.patchSession(TAB, { lastCycleOutcome: 'step_completed', lastFingerprint: staleFp });

    const restore = stubLoad(3);
    await _bootstrapSession(TAB);
    restore();

    assert.equal(counter.calls, 1, 'a genuinely different element set must never be skip-eligible');
  } finally {
    DecisionRouter.prototype.route = origRoute;
  }
});

// ── 4. Failure prevents skip ─────────────────────────────────────────────────

test('4. failure prevents skip: lastCycleOutcome=element_not_found + an otherwise-matching fingerprint still routes', async () => {
  const counter = { calls: 0 };
  const origRoute = DecisionRouter.prototype.route;
  DecisionRouter.prototype.route = countingFailFastRoute(counter);

  try {
    const fp = currentRelevantFingerprint();
    await SessionStore.create(TAB, 'do something on the page');
    // Same fingerprint as scenario 1 — the ONLY difference is lastCycleOutcome.
    await SessionStore.patchSession(TAB, { lastCycleOutcome: 'element_not_found', lastFingerprint: fp });

    const restore = stubLoad(3);
    await _bootstrapSession(TAB);
    restore();

    assert.equal(counter.calls, 1, 'a failed/unknown prior outcome must NEVER be suppressed by an unchanged fingerprint');
  } finally {
    DecisionRouter.prototype.route = origRoute;
  }
});

for (const outcome of ['dedup_repeat', 'stale_plan', 'retryable_error', 'ambiguous', 'blocked', null]) {
  test(`4b. failure prevents skip: lastCycleOutcome=${outcome} + matching fingerprint still routes`, async () => {
    const counter = { calls: 0 };
    const origRoute = DecisionRouter.prototype.route;
    DecisionRouter.prototype.route = countingFailFastRoute(counter);
    try {
      const fp = currentRelevantFingerprint();
      await SessionStore.create(TAB, 'do something on the page');
      await SessionStore.patchSession(TAB, { lastCycleOutcome: outcome, lastFingerprint: fp });
      const restore = stubLoad(3);
      await _bootstrapSession(TAB);
      restore();
      assert.equal(counter.calls, 1, `outcome=${outcome} must never be treated as skip-eligible`);
    } finally {
      DecisionRouter.prototype.route = origRoute;
    }
  });
}

// ── 5 & 6. Gap #1 / Gap #2 regressions — source-level, same convention as
//    v2-task-progress-wiring.test.mjs (a whole content-script module with
//    heavy browser dependencies; the exact FIX SHAPE is pinned in source
//    rather than driven end-to-end, matching that file's own established
//    approach for wiring it cannot otherwise exercise deterministically) ────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const v2TaskSrc = fs.readFileSync(path.join(ROOT, 'extension', 'v2-task.js'), 'utf8');

test('5. Gap #1 regression: the ordinary-progression fallthrough disambiguates step_completed from fill_verification_failed by comparing completedSteps counts, not by trusting result==="completed" alone', () => {
  assert.match(
    v2TaskSrc,
    /const completedStepsCountBeforeExecute = freshSession\.completedSteps\.length;/,
    'the count must be captured BEFORE _executeStep runs'
  );
  assert.match(
    v2TaskSrc,
    /const postExecuteSession = await SessionStore\.load\(tabId\);\s*\n\s*const stepGenuinelyCompleted = \(postExecuteSession\?\.completedSteps\?\.length \?\? completedStepsCountBeforeExecute\) > completedStepsCountBeforeExecute;/,
    'the fallthrough must re-check the actual count, not assume result==="completed" means success'
  );
  assert.match(
    v2TaskSrc,
    /recordCycleOutcome\(stepGenuinelyCompleted \? 'step_completed' : 'fill_verification_failed'/,
    'the two outcomes must be tagged differently based on the count comparison'
  );
});

test('6. Gap #2 regression: both previously-silent abort continue sites now write lastCycleOutcome=stale_plan before continuing', () => {
  // Site 1: the AbortController/AbortError exception path.
  assert.match(
    v2TaskSrc,
    /if \(planController\.signal\.aborted \|\| err\?\.name === 'AbortError'\) \{[\s\S]{0,600}?await recordCycleOutcome\('stale_plan'\);\s*\n\s*continue;/,
    'the exception-path abort must record stale_plan before continuing'
  );
  // Site 2: the server-acknowledged ABORTED errorCode path.
  assert.match(
    v2TaskSrc,
    /if \(planResp\?\.errorCode === 'ABORTED'\) \{[\s\S]{0,600}?await recordCycleOutcome\('stale_plan'\);\s*\n\s*continue;/,
    'the server-acknowledged-abort path must record stale_plan before continuing'
  );
});
