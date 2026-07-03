// ScreenPilot v2 — ExecutorEngine test suite
//
// Run: node extension/tests/executor-engine.test.mjs
//
// Zero dependencies beyond Node.js built-ins. All browser APIs are shimmed below.

import assert from 'assert/strict';
import { ExecutorEngine } from '../services/executor-engine.js';

// ── Browser API shims ─────────────────────────────────────────────────────────

class MockEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
  }

  removeEventListener(event, handler) {
    const list = this._listeners.get(event) ?? [];
    const idx  = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatch(event, eventObj = {}) {
    for (const h of (this._listeners.get(event) ?? [])) h(eventObj);
  }

  listenerCount(event) {
    return (this._listeners.get(event) ?? []).length;
  }
}

const mockDocument = new MockEventTarget();
const mockWindow   = new MockEventTarget();
globalThis.document = mockDocument;
globalThis.window   = mockWindow;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_ELEMENT = {
  getAttribute:  () => 'Submit',
  innerText:     'Submit',
  closest:       () => null,
  contains:      () => true,
};

const MOCK_SNAPSHOT = {
  url:                    'https://example.com',
  title:                  'Test Page',
  domHash:                'deadbeef',
  highlightedElementText: '',
  capturedAt:             1_000_000,
};

function makeMatcher({ found = true, score = 85, confidence = undefined } = {}) {
  return {
    matchElement: () => {
      if (!found) return null;
      const r = { element: MOCK_ELEMENT, score, reason: 'exact', matchType: 'EXACT' };
      if (confidence !== undefined) r.confidence = confidence;
      return r;
    },
  };
}

function makeHighlighter({ shown = true } = {}) {
  const calls = { show: [], clear: 0 };
  return {
    _calls: calls,
    show:   async (el, text) => { calls.show.push({ el, text }); return shown; },
    clear:  () => { calls.clear++; },
  };
}

function makeStep(overrides = {}) {
  return {
    id:                  1,
    description:         'Click the Submit button',
    intent:              'submit the form',
    phase:               'submit',
    optional:            false,
    timeout_ms:          3000,
    completionCondition: 'dom_change',
    targetElement:       { text: 'Submit', type: 'button', region: 'form', intent: 'submit', alternatives: [] },
    reversible:          true,
    ...overrides,
  };
}

function makePlan(steps, opts = {}) {
  return {
    planId:           'plan-test-1',
    goal:             'Submit the form',
    goalType:         'action',
    steps,
    currentStepIndex: opts.currentStepIndex ?? 0,
    planVersion:      1,
    confidence:       0.9,
    createdAt:        Date.now(),
  };
}

function makeExecutor(matcherOpts, highlighterOpts) {
  return new ExecutorEngine({
    domMatcher:      makeMatcher(matcherOpts),
    highlighter:     makeHighlighter(highlighterOpts),
    captureSnapshot: (text = '') => ({ ...MOCK_SNAPSHOT, highlightedElementText: text }),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wait for the next emission of `event`. Times out after 500 ms.
 *
 * IMPORTANT: register this BEFORE the action that triggers the event.
 * Some events (element:not_found on no-match, plan:complete on empty plan,
 * step:skipped) are emitted synchronously during start() — registering after
 * start() will miss them.
 */
function nextEvent(executor, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}" (500ms)`)),
      500
    );
    const unsub = executor.on(event, payload => {
      clearTimeout(timer);
      unsub();
      resolve(payload);
    });
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

let pass = 0, fail = 0;

async function test(name, fn) {
  mockDocument._listeners.clear();
  mockWindow._listeners.clear();
  mockWindow.location = undefined; // prevent URL from leaking into the next test's direction guard
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    fail++;
  }
}

// ── 1. Constructor ────────────────────────────────────────────────────────────

console.log('\nExecutorEngine\n');

await test('throws when domMatcher is missing', async () => {
  assert.throws(
    () => new ExecutorEngine({ highlighter: makeHighlighter() }),
    /domMatcher is required/
  );
});

await test('throws when highlighter is missing', async () => {
  assert.throws(
    () => new ExecutorEngine({ domMatcher: makeMatcher() }),
    /highlighter is required/
  );
});

await test('initial status is idle', async () => {
  const ex = makeExecutor();
  assert.equal(ex.getStatus(), 'idle');
  assert.equal(ex.getCurrentStep(), null);
  assert.equal(ex.getPreActionSnapshot(), null);
  assert.equal(ex.getPlan(), null);
});

// ── 2. start() — element found ────────────────────────────────────────────────

await test('start() emits element:ready when element is found', async () => {
  const ex = makeExecutor();
  // element:ready fires after await highlighter.show() — async, safe to
  // register listener either before or after start()
  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');

  assert.equal(payload.step.id, 1);
  assert.equal(payload.element, MOCK_ELEMENT);
  assert.ok(payload.snapshot);
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('start() sets getCurrentStep() and getPreActionSnapshot()', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  assert.deepEqual(ex.getCurrentStep(), makeStep());
  assert.ok(ex.getPreActionSnapshot());
  assert.equal(ex.getPreActionSnapshot().highlightedElementText, 'Submit');
});

await test('start() passes step.description to highlighter.show()', async () => {
  const hl = makeHighlighter();
  const ex = new ExecutorEngine({
    domMatcher:      makeMatcher(),
    highlighter:     hl,
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  ex.start(makePlan([makeStep({ description: 'Click the big red button' })]));
  await nextEvent(ex, 'element:ready');

  assert.equal(hl._calls.show.length, 1);
  assert.equal(hl._calls.show[0].text, 'Click the big red button');
});

await test('start() throws when called while already resolving or awaiting', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  // status is 'resolving' at this point
  assert.throws(() => ex.start(makePlan([makeStep()])), /abort\(\) first/);
});

// ── 3. start() — element not found ───────────────────────────────────────────
//
// element:not_found is emitted synchronously in the no-match path (no await
// before the emit). Subscribe BEFORE start().

await test('start() emits element:not_found when no match', async () => {
  const ex      = makeExecutor({ found: false });
  const promise = nextEvent(ex, 'element:not_found'); // register BEFORE start
  ex.start(makePlan([makeStep()]));
  const payload = await promise;

  assert.equal(payload.step.id, 1);
  assert.ok(payload.reason.includes('Submit'));
  assert.equal(payload.isOptional, false);
  assert.equal(ex.getStatus(), 'idle');
});

await test('start() emits element:not_found when score is below PRIMARY threshold', async () => {
  const ex      = makeExecutor({ found: true, score: 30 }); // below PRIMARY=60
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  await promise;
});

await test('start() emits element:not_found when highlighter.show() returns false', async () => {
  const ex      = makeExecutor({}, { shown: false });
  const promise = nextEvent(ex, 'element:not_found'); // register early to be safe
  ex.start(makePlan([makeStep()]));
  const payload = await promise;

  assert.ok(payload.reason.includes('highlighted'));
  assert.equal(ex.getStatus(), 'idle');
});

// ── 4. Optional steps ─────────────────────────────────────────────────────────

await test('optional step with no match emits step:skipped and auto-advances', async () => {
  const step1 = makeStep({ id: 1, optional: true,  targetElement: { text: 'Ghost', type: 'button', intent: 'ghost', alternatives: [] } });
  const step2 = makeStep({ id: 2, optional: false, description: 'Step 2' });

  let callCount = 0;
  const domMatcher = {
    matchElement: () => {
      callCount++;
      return callCount === 1 ? null : { element: MOCK_ELEMENT, score: 85 };
    },
  };
  const ex = new ExecutorEngine({ domMatcher, highlighter: makeHighlighter(), captureSnapshot: () => MOCK_SNAPSHOT });

  // Both events are emitted before the test can await them individually:
  // step:skipped fires synchronously, and element:ready fires in the microtask
  // that resolves show() — which runs before the test resumes from await skippedPromise.
  // Register both listeners before start().
  const skippedPromise = nextEvent(ex, 'step:skipped');
  const readyPromise   = nextEvent(ex, 'element:ready');
  ex.start(makePlan([step1, step2]));

  const skipped = await skippedPromise;
  assert.equal(skipped.step.id, 1);
  const ready = await readyPromise;
  assert.equal(ready.step.id, 2);
});

await test('plan with no steps emits plan:complete immediately', async () => {
  const ex      = makeExecutor();
  const promise = nextEvent(ex, 'plan:complete'); // plan:complete is synchronous here
  ex.start(makePlan([]));
  await promise;
  assert.equal(ex.getStatus(), 'complete');
});

// ── 5. User action detection ──────────────────────────────────────────────────
//
// user:acted fires synchronously inside the mock dispatch() call.
// Always register the nextEvent listener BEFORE dispatching.

await test('click on page emits user:acted with trigger=click', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted'); // register BEFORE dispatch
  mockDocument.dispatch('click', { target: { closest: () => null } });
  const payload = await acted;

  assert.equal(payload.trigger, 'click');
  assert.equal(payload.step.id, 1);
  assert.ok(payload.timestamp > 0);
});

await test('URL change (popstate) emits user:acted with trigger=url_change', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockWindow.dispatch('popstate');
  assert.equal((await acted).trigger, 'url_change');
});

await test('hashchange emits user:acted with trigger=url_change', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockWindow.dispatch('hashchange');
  assert.equal((await acted).trigger, 'url_change');
});

await test('click inside #screenpilot-widget is ignored', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  mockDocument.dispatch('click', { target: { closest: (sel) => sel === '#screenpilot-widget' ? {} : null } });

  const result = await Promise.race([
    nextEvent(ex, 'user:acted').then(() => 'fired'),
    new Promise(r => setTimeout(() => r('silent'), 100)),
  ]);
  assert.equal(result, 'silent', 'widget click should not emit user:acted');
});

await test('click on an off-target element does not advance the step', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  // Simulate MOCK_ELEMENT.contains() returning false (click landed elsewhere)
  const saved = MOCK_ELEMENT.contains;
  MOCK_ELEMENT.contains = () => false;
  mockDocument.dispatch('click', { target: { closest: () => null } });
  MOCK_ELEMENT.contains = saved;

  const result = await Promise.race([
    nextEvent(ex, 'user:acted').then(() => 'fired'),
    new Promise(r => setTimeout(() => r('silent'), 100)),
  ]);
  assert.equal(result, 'silent', 'off-target click should not emit user:acted');
  ex.abort();
});

// ── Direction-aware popstate guard (v3 steps with expectedOutcome) ────────────
//
// For v3 steps that declare expectedOutcome.urlPattern, popstate/hashchange
// must only fire user:acted when the URL moved toward the expected destination.
// Browser Back in a SPA fires popstate but moves AWAY from the target — it must
// not be treated as a successful step completion.
//
// v1 steps without expectedOutcome skip the guard entirely (backward compatible).

await test('popstate does NOT fire user:acted when URL moved away from expected destination', async () => {
  // Simulate browser Back: URL is the repo root, but step expects /pulls.
  mockWindow.location = { href: 'https://github.com/torvalds/linux' };

  const ex   = makeExecutor();
  const step = makeStep({ expectedOutcome: { urlChanges: true, urlPattern: '/pulls' } });
  ex.start(makePlan([step]));
  await nextEvent(ex, 'element:ready');

  // Register BEFORE dispatch — _emit is synchronous. If the guard fires user:acted,
  // it happens inside dispatch() before the next line, and a late-registered nextEvent
  // would miss it, turning this into a trivial no-op test that always passes.
  const acted = nextEvent(ex, 'user:acted');
  mockWindow.dispatch('popstate');
  const result = await Promise.race([
    acted.then(() => 'fired'),
    new Promise(r => setTimeout(() => r('silent'), 100)),
  ]);
  assert.equal(result, 'silent', 'backward popstate must not emit user:acted');
  ex.abort();
});

await test('popstate DOES fire user:acted when URL matches expectedOutcome.urlPattern', async () => {
  // Simulate forward SPA navigation: URL now contains the expected pattern.
  mockWindow.location = { href: 'https://github.com/torvalds/linux/pulls' };

  const ex   = makeExecutor();
  const step = makeStep({ expectedOutcome: { urlChanges: true, urlPattern: '/pulls' } });
  ex.start(makePlan([step]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockWindow.dispatch('popstate');
  const payload = await acted;

  assert.equal(payload.trigger, 'url_change');
});

await test('popstate fires user:acted for v1 step without expectedOutcome (backward compat)', async () => {
  // v1 step has no expectedOutcome — the direction guard is skipped entirely.
  // This preserves identical behavior for all existing Architecture A flows.
  const ex   = makeExecutor();
  const step = makeStep(); // no expectedOutcome
  ex.start(makePlan([step]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockWindow.dispatch('popstate');
  const payload = await acted;

  assert.equal(payload.trigger, 'url_change');
});

await test('double-trigger emits user:acted exactly once', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  let count = 0;
  ex.on('user:acted', () => count++);

  mockDocument.dispatch('click', { target: { closest: () => null } });
  mockWindow.dispatch('popstate');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(count, 1);
});

await test('listeners are torn down after user:acted', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockDocument.dispatch('click', { target: { closest: () => null } });
  await acted;

  assert.equal(mockDocument.listenerCount('click'),   0, 'click listener should be removed');
  assert.equal(mockWindow.listenerCount('popstate'),   0, 'popstate listener should be removed');
  assert.equal(mockWindow.listenerCount('hashchange'), 0, 'hashchange listener should be removed');
});

await test('highlighter.clear() is called after user:acted', async () => {
  const hl = makeHighlighter();
  const ex = new ExecutorEngine({ domMatcher: makeMatcher(), highlighter: hl, captureSnapshot: () => MOCK_SNAPSHOT });

  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockDocument.dispatch('click', { target: { closest: () => null } });
  await acted;

  assert.equal(hl._calls.clear, 1);
});

// ── 6. advance() ─────────────────────────────────────────────────────────────

await test('advance() after last step emits plan:complete', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockDocument.dispatch('click', { target: { closest: () => null } });
  await acted;

  // plan:complete fires synchronously inside advance() — register before calling it
  const complete = nextEvent(ex, 'plan:complete');
  ex.advance();
  await complete;
  assert.equal(ex.getStatus(), 'complete');
});

await test('advance() on a 2-step plan executes step 2', async () => {
  const step1 = makeStep({ id: 1, description: 'Step 1' });
  const step2 = makeStep({ id: 2, description: 'Step 2', targetElement: { text: 'Next', type: 'button', intent: 'next', alternatives: [] } });

  const ex = makeExecutor();
  ex.start(makePlan([step1, step2]));
  await nextEvent(ex, 'element:ready');

  const acted = nextEvent(ex, 'user:acted');
  mockDocument.dispatch('click', { target: { closest: () => null } });
  await acted;

  ex.advance();
  const ready2 = await nextEvent(ex, 'element:ready');
  assert.equal(ready2.step.id, 2);
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('advance() is ignored when status is not awaiting', async () => {
  const ex = makeExecutor();
  assert.doesNotThrow(() => ex.advance());
  assert.equal(ex.getStatus(), 'idle');
});

// ── 7. abort() ───────────────────────────────────────────────────────────────

await test('abort() resets status, clears plan, and clears highlight', async () => {
  const hl = makeHighlighter();
  const ex = new ExecutorEngine({ domMatcher: makeMatcher(), highlighter: hl, captureSnapshot: () => MOCK_SNAPSHOT });

  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');
  ex.abort();

  assert.equal(ex.getStatus(), 'aborted');
  assert.equal(ex.getPlan(), null);
  assert.equal(ex.getCurrentStep(), null);
  assert.equal(ex.getPreActionSnapshot(), null);
  assert.ok(hl._calls.clear >= 1);
});

await test('abort() removes all page listeners', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');
  ex.abort();

  assert.equal(mockDocument.listenerCount('click'),   0);
  assert.equal(mockWindow.listenerCount('popstate'),   0);
  assert.equal(mockWindow.listenerCount('hashchange'), 0);
});

await test('abort() during async highlight gap is handled gracefully', async () => {
  let resolveShow;
  const hl = {
    _calls: { show: [], clear: 0 },
    show:   async () => new Promise(r => { resolveShow = r; }),
    clear:  () => { hl._calls.clear++; },
  };
  const ex = new ExecutorEngine({ domMatcher: makeMatcher(), highlighter: hl, captureSnapshot: () => MOCK_SNAPSHOT });

  ex.start(makePlan([makeStep()]));
  ex.abort();
  assert.equal(ex.getStatus(), 'aborted');

  resolveShow(true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ex.getStatus(), 'aborted', 'abort status must survive async show() resolution');
});

await test('abort() on idle executor is a no-op (status becomes aborted)', async () => {
  const ex = makeExecutor();
  assert.doesNotThrow(() => ex.abort());
  assert.equal(ex.getStatus(), 'aborted');
});

await test('start() after abort() works correctly', async () => {
  const ex = makeExecutor();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');
  ex.abort();

  ex.start(makePlan([makeStep({ description: 'Step after restart' })]));
  const payload = await nextEvent(ex, 'element:ready');
  assert.equal(payload.step.description, 'Step after restart');
});

// ── 8. Event subscription ─────────────────────────────────────────────────────

await test('on() returns an unsubscribe function that stops future calls', async () => {
  const ex    = makeExecutor();
  let   count = 0;
  const unsub = ex.on('element:ready', () => count++);

  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready'); // first fire — counter incremented
  unsub();

  ex.abort();
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready'); // second fire — unsub'd handler should not run
  assert.equal(count, 1);
});

await test('handler error does not prevent other handlers from running', async () => {
  const ex     = makeExecutor();
  let   second = false;

  ex.on('element:ready', () => { throw new Error('bad handler'); });
  ex.on('element:ready', () => { second = true; });

  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');

  assert.ok(second, 'second handler should still run despite first handler throwing');
});

// ── 9. Alternative resolution ─────────────────────────────────────────────────

await test('falls back to first alternative when primary score is below threshold', async () => {
  let callCount = 0;
  const domMatcher = {
    matchElement: (desc) => {
      callCount++;
      if (desc.text === 'Submit') return { element: MOCK_ELEMENT, score: 30 }; // below PRIMARY=60
      if (desc.text === 'Send')   return { element: MOCK_ELEMENT, score: 55 }; // above RECOVERY=50
      return null;
    },
  };
  const ex   = new ExecutorEngine({ domMatcher, highlighter: makeHighlighter(), captureSnapshot: () => MOCK_SNAPSHOT });
  const step = makeStep({ targetElement: { text: 'Submit', type: 'button', intent: 'submit', alternatives: ['Send', 'Go'] } });

  ex.start(makePlan([step]));
  await nextEvent(ex, 'element:ready');
  assert.equal(callCount, 2, 'should try primary then first passing alternative');
});

await test('emits element:not_found when all alternatives also fail', async () => {
  const domMatcher = { matchElement: () => ({ element: MOCK_ELEMENT, score: 10 }) }; // always too low
  const ex   = new ExecutorEngine({ domMatcher, highlighter: makeHighlighter(), captureSnapshot: () => MOCK_SNAPSHOT });
  const step = makeStep({ targetElement: { text: 'Submit', type: 'button', intent: 'submit', alternatives: ['Send', 'Go'] } });

  const promise = nextEvent(ex, 'element:not_found'); // synchronous — register before start
  ex.start(makePlan([step]));
  await promise;
});

// ── 10. plan.currentStepIndex ─────────────────────────────────────────────────

await test('start() begins at plan.currentStepIndex when nonzero', async () => {
  const step1 = makeStep({ id: 1, description: 'Already done' });
  const step2 = makeStep({ id: 2, description: 'Resume here' });

  const ex = makeExecutor();
  ex.start(makePlan([step1, step2], { currentStepIndex: 1 }));
  const payload = await nextEvent(ex, 'element:ready');
  assert.equal(payload.step.id, 2);
});

// ── 11. _selfCheck ───────────────────────────────────────────────────────────
//
// _selfCheck runs synchronously AFTER _resolveElement returns a match and BEFORE
// await highlighter.show(). Failures emit element:not_found synchronously during
// start() — subscribe BEFORE start().

await test('_selfCheck: isConnected=false emits element:not_found with detach reason', async () => {
  const el  = { ...MOCK_ELEMENT, isConnected: false };
  const ex  = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  const payload = await promise;
  assert.ok(payload.reason.toLowerCase().includes('self-check'),
    `reason should mention self-check, got: "${payload.reason}"`);
  assert.ok(payload.reason.toLowerCase().includes('detach') ||
            payload.reason.toLowerCase().includes('detached'),
    `reason should mention detach, got: "${payload.reason}"`);
  assert.equal(ex.getStatus(), 'idle');
});

await test('_selfCheck: disabled=true emits element:not_found', async () => {
  const el = { ...MOCK_ELEMENT, disabled: true };
  const ex = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  const payload = await promise;
  assert.ok(payload.reason.toLowerCase().includes('disabled'),
    `reason should mention disabled, got: "${payload.reason}"`);
  assert.equal(ex.getStatus(), 'idle');
});

await test('_selfCheck: aria-disabled="true" emits element:not_found', async () => {
  const el = {
    ...MOCK_ELEMENT,
    getAttribute: (attr) => attr === 'aria-disabled' ? 'true' : null,
  };
  const ex = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  const payload = await promise;
  assert.ok(payload.reason.toLowerCase().includes('disabled'),
    `reason should mention disabled, got: "${payload.reason}"`);
  assert.equal(ex.getStatus(), 'idle');
});

await test('_selfCheck: zero-rect element emits element:not_found', async () => {
  const el = {
    ...MOCK_ELEMENT,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
  const ex = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  const payload = await promise;
  assert.ok(payload.reason.toLowerCase().includes('zero size') ||
            payload.reason.toLowerCase().includes('hidden'),
    `reason should mention zero size or hidden, got: "${payload.reason}"`);
  assert.equal(ex.getStatus(), 'idle');
});

await test('_selfCheck: healthy element passes all checks and highlight proceeds', async () => {
  const el = { ...MOCK_ELEMENT, isConnected: true };
  const ex = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  // element:ready fires after await highlighter.show() — register before OR after start()
  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');
  assert.equal(payload.element, el);
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('_selfCheck: isConnected=undefined passes (=== false strict check, not !isConnected)', async () => {
  // MOCK_ELEMENT has no isConnected property; element.isConnected === false → undefined===false → false → passes
  const el = { ...MOCK_ELEMENT, isConnected: undefined };
  const ex = new ExecutorEngine({
    domMatcher:      { matchElement: () => ({ element: el, score: 85, reason: 'exact', matchType: 'EXACT' }) },
    highlighter:     makeHighlighter(),
    captureSnapshot: () => MOCK_SNAPSHOT,
  });
  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');
  assert.equal(payload.element, el, 'element with isConnected=undefined must not be rejected');
});

// ── 12. Confidence gate ───────────────────────────────────────────────────────
//
// Confidence is enforced only on the PRIMARY path. Alternatives use score only.
// CONFIDENCE=0.40 at divisor=150 is equivalent to PRIMARY=60 (no new behavioural gate).
// element:not_found from confidence rejection fires synchronously — subscribe before start().

await test('confidence: 0.467 (contains-match level) passes at CONFIDENCE=0.40 threshold', async () => {
  // Validates the MODIFY: at old threshold 0.50, 0.467 would have been rejected.
  // At 0.40, it passes. Regression test for the confidence fix.
  const ex = makeExecutor({ confidence: 0.467 });
  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');
  assert.equal(payload.step.id, 1, 'contains-match confidence must not be rejected at 0.40');
});

await test('confidence: exactly 0.40 (minimum passing value) is accepted', async () => {
  const ex = makeExecutor({ confidence: 0.40 });
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');
});

await test('confidence: undefined (missing field) passes via ?? 1 backward-compat guard', async () => {
  // All test mocks and pre-Phase-6 matchElement builds omit the confidence field.
  // The ?? 1 guard must prevent regression by treating missing confidence as 1.0.
  const ex = makeExecutor(); // no confidence in makeMatcher result
  ex.start(makePlan([makeStep()]));
  await nextEvent(ex, 'element:ready');
});

await test('confidence: 0.39 (below 0.40) rejected; element:not_found when no alternatives', async () => {
  const ex      = makeExecutor({ confidence: 0.39 }); // score=85 passes PRIMARY; confidence fails gate
  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()])); // makeStep alternatives=[]
  const payload = await promise;
  assert.equal(ex.getStatus(), 'idle');
  assert.ok(payload.reason.includes('Submit'), `reason should name the target, got: "${payload.reason}"`);
});

await test('confidence: alternatives path uses score only (no confidence gate on RECOVERY)', async () => {
  let callCount = 0;
  const domMatcher = {
    matchElement: (desc) => {
      callCount++;
      if (desc.text === 'Submit')
        return { element: MOCK_ELEMENT, score: 85, confidence: 0.39, reason: 'exact', matchType: 'EXACT' };
      if (desc.text === 'Send')
        return { element: MOCK_ELEMENT, score: 55, reason: 'exact', matchType: 'EXACT' }; // no confidence
      return null;
    },
  };
  const ex   = new ExecutorEngine({ domMatcher, highlighter: makeHighlighter(), captureSnapshot: () => MOCK_SNAPSHOT });
  const step = makeStep({ targetElement: { text: 'Submit', type: 'button', intent: 'submit', alternatives: ['Send'] } });

  ex.start(makePlan([step]));
  await nextEvent(ex, 'element:ready'); // alternative was accepted
  assert.equal(callCount, 2, 'primary tried then one alternative');
});

// ── 13. Ranked-candidate fallback (BUG-003) ──────────────────────────────────
//
// When resolved.alternatives is populated, ExecutorEngine tries each candidate
// in rank order before emitting element:not_found.
// Self-check failures and highlight failures silently advance to the next candidate.

const EL_PRIMARY  = { ...MOCK_ELEMENT, _id: 'primary'  };
const EL_FALLBACK = { ...MOCK_ELEMENT, _id: 'fallback' };

function makeMatcherWithAlternatives(primary, alts) {
  return {
    matchElement: () => ({
      element:      primary,
      score:        76,
      confidence:   0.507,
      reason:       'text contains match',
      matchType:    'fuzzy',
      alternatives: alts.map(el => ({ element: el, score: 76, reason: 'text contains match', matchType: 'fuzzy' })),
    }),
  };
}

await test('BUG-003: candidate #1 off-screen (highlight=false), candidate #2 succeeds', async () => {
  const hlCalls = [];
  const hl = {
    show:  async (el) => { hlCalls.push(el); return el === EL_FALLBACK; },
    clear: () => {},
  };
  const ex = new ExecutorEngine({
    domMatcher:      makeMatcherWithAlternatives(EL_PRIMARY, [EL_FALLBACK]),
    highlighter:     hl,
    captureSnapshot: () => MOCK_SNAPSHOT,
  });

  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');

  assert.equal(payload.element, EL_FALLBACK, 'must fall back to candidate #2');
  assert.equal(hlCalls.length, 2,        'highlighter called once per candidate');
  assert.equal(hlCalls[0], EL_PRIMARY,   'first call: primary');
  assert.equal(hlCalls[1], EL_FALLBACK,  'second call: fallback');
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('BUG-003: candidate #1 disabled (self-check fails), candidate #2 succeeds', async () => {
  const disabledEl = { ...MOCK_ELEMENT, disabled: true };
  const hlCalls = [];
  const hl = {
    show:  async (el) => { hlCalls.push(el); return true; },
    clear: () => {},
  };
  const ex = new ExecutorEngine({
    domMatcher:      makeMatcherWithAlternatives(disabledEl, [EL_FALLBACK]),
    highlighter:     hl,
    captureSnapshot: () => MOCK_SNAPSHOT,
  });

  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');

  assert.equal(payload.element, EL_FALLBACK, 'must skip disabled element and use fallback');
  assert.equal(hlCalls.length, 1,       'highlighter not called for disabled element');
  assert.equal(hlCalls[0], EL_FALLBACK, 'only fallback was highlighted');
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('BUG-003: candidate #1 detached (self-check fails), candidate #2 succeeds', async () => {
  const detachedEl = { ...MOCK_ELEMENT, isConnected: false };
  const hlCalls = [];
  const hl = {
    show:  async (el) => { hlCalls.push(el); return true; },
    clear: () => {},
  };
  const ex = new ExecutorEngine({
    domMatcher:      makeMatcherWithAlternatives(detachedEl, [EL_FALLBACK]),
    highlighter:     hl,
    captureSnapshot: () => MOCK_SNAPSHOT,
  });

  ex.start(makePlan([makeStep()]));
  const payload = await nextEvent(ex, 'element:ready');

  assert.equal(payload.element, EL_FALLBACK, 'must skip detached element and use fallback');
  assert.equal(hlCalls.length, 1,       'highlighter not called for detached element');
  assert.equal(hlCalls[0], EL_FALLBACK, 'only fallback was highlighted');
  assert.equal(ex.getStatus(), 'awaiting');
});

await test('BUG-003: all candidates fail highlight → element:not_found', async () => {
  const hlCalls = [];
  const hl = {
    show:  async (el) => { hlCalls.push(el); return false; },
    clear: () => {},
  };
  const ex = new ExecutorEngine({
    domMatcher:      makeMatcherWithAlternatives(EL_PRIMARY, [EL_FALLBACK]),
    highlighter:     hl,
    captureSnapshot: () => MOCK_SNAPSHOT,
  });

  const promise = nextEvent(ex, 'element:not_found');
  ex.start(makePlan([makeStep()]));
  const payload = await promise;

  assert.equal(ex.getStatus(), 'idle');
  assert.equal(hlCalls.length, 2, 'both candidates were attempted');
  assert.ok(
    payload.reason.toLowerCase().includes('highlight'),
    `reason should reference highlight failure, got: "${payload.reason}"`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
