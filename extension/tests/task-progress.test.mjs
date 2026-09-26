// TaskProgress — unit tests. Exercises deriveTaskProgress() against the REAL
// SessionStore (with a chrome.storage.local mock), not just hand-built
// fixtures, so these prove the actual integration, not an idealized shape.

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

const { SessionStore } = await import('../services/session-store.js');
const { deriveTaskProgress, ProgressStatus, isTerminalStatus, TERMINAL_STATUSES } = await import('../lib/task-progress.js');

const EMAIL = 'jane@example.com';

test.beforeEach(clearStore);

// ── initialization ────────────────────────────────────────────────────────────

test('init: no session (never started / already cleared) -> idle, all-empty defaults', () => {
  const p = deriveTaskProgress(null);
  assert.equal(p.status, ProgressStatus.IDLE);
  assert.equal(p.goal, null);
  assert.equal(p.currentStep, null);
  assert.deepEqual(p.completedSteps, { count: 0, steps: [] });
  assert.equal(p.remainingSteps, null);
  assert.equal(p.expectedState, null);
  assert.equal(p.attempts, null);
  assert.equal(p.replanCount, 0);
  assert.equal(p.lastAction, null);
  assert.equal(p.completion.complete, false);
  assert.equal(p.failure.failed, false);
  assert.equal(p.aborted, false);
});

test('init: a freshly created session derives to status=planning with zeroed counters', async () => {
  const session = await SessionStore.create(1, 'Open settings');
  const p = deriveTaskProgress(session);
  assert.equal(p.status, ProgressStatus.PLANNING);
  assert.equal(p.goal, 'Open settings');
  assert.equal(p.currentStep, null);
  assert.deepEqual(p.completedSteps, { count: 0, steps: [] });
  assert.deepEqual(p.attempts, { step: 0, stepMax: 3, planner: 0, plannerMax: 10 });
  assert.equal(p.replanCount, 0);
  assert.equal(p.lastAction, null);
});

// ── step advancement / successful action ─────────────────────────────────────

test('step advancement: markPendingStep sets currentStep and expectedState', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.markPendingStep(1, {
    description: "Click 'New'", intent: 'open_create_menu', completionCondition: 'dom_change',
    expectedUrlPattern: '/new', expectedUrlChanges: true, urlBefore: 'https://x.com', domHashBefore: 'abc', stepStartedAt: Date.now()
  });
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.status, ProgressStatus.RUNNING); // phase -> EXECUTING -> running
  assert.equal(p.currentStep.description, "Click 'New'");
  assert.equal(p.currentStep.intent, 'open_create_menu');
  assert.deepEqual(p.expectedState, { urlPattern: '/new', urlChanges: true });
});

test('successful action: completeStep advances completedSteps and clears currentStep', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.markPendingStep(1, { description: 'Step 1', intent: 'i1', completionCondition: 'dom_change' });
  await SessionStore.completeStep(1, { description: 'Step 1', intent: 'i1', completionCondition: 'dom_change', completedAt: Date.now() });
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.completedSteps.count, 1);
  assert.equal(p.completedSteps.steps[0].description, 'Step 1');
  assert.equal(p.currentStep, null);
  assert.equal(p.status, ProgressStatus.PLANNING); // completeStep resets phase to PLANNING
});

// ── failed action / retry ─────────────────────────────────────────────────────

test('failed action: a failed resolution increments attempts.step, visible in TaskProgress', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.incrementStepAttempt(1);
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.attempts.step, 1);
  assert.equal(p.attempts.stepMax, 3);
});

test('retry: repeated failures climb toward stepMax; TaskProgress reflects each attempt', async () => {
  await SessionStore.create(1, 'g');
  for (let i = 1; i <= 3; i++) {
    const { isStuck } = await SessionStore.incrementStepAttempt(1);
    const p = deriveTaskProgress(await SessionStore.load(1));
    assert.equal(p.attempts.step, i);
    assert.equal(isStuck, i >= 3);
  }
});

// ── replan ────────────────────────────────────────────────────────────────────

test('replan: incrementReplanCount is reflected as replanCount, independent of attempt counters', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.incrementReplanCount(1);
  await SessionStore.incrementReplanCount(1);
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.replanCount, 2);
  assert.equal(p.attempts.step, 0, 'a replan alone must not touch the attempt counters');
});

test('a pre-Phase-4 session (missing replanCount entirely) derives replanCount=0, not undefined/NaN', async () => {
  await SessionStore.create(1, 'g');
  delete _store['sp_session_1'].replanCount;
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.replanCount, 0);
});

// ── manual/user action ────────────────────────────────────────────────────────

test('manual/user action: the last executor result is captured and reflected as lastAction', async () => {
  await SessionStore.create(1, 'g');
  const at = Date.now();
  await SessionStore.patchSession(1, { lastActionResult: 'navigated', lastActionAt: at });
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.deepEqual(p.lastAction, { result: 'navigated', at });
});

test('a pre-Phase-4 session (missing lastActionResult) derives lastAction=null', async () => {
  await SessionStore.create(1, 'g');
  delete _store['sp_session_1'].lastActionResult;
  delete _store['sp_session_1'].lastActionAt;
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.lastAction, null);
});

// ── completion ────────────────────────────────────────────────────────────────

test('completion: taskState=COMPLETE overrides session.phase and sets completion.complete', async () => {
  const session = await SessionStore.create(1, 'g');
  const p = deriveTaskProgress(session, { taskState: 'COMPLETE' });
  assert.equal(p.status, ProgressStatus.COMPLETE);
  assert.equal(p.completion.complete, true);
  assert.equal(isTerminalStatus(p.status), true);
});

test('completion: after SessionStore.clear() (existing behavior), session is null -> status is idle, NOT complete', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.clear(1);
  const p = deriveTaskProgress(await SessionStore.load(1));
  assert.equal(p.status, ProgressStatus.IDLE);
  assert.equal(p.completion.complete, false);
});

// ── abort ─────────────────────────────────────────────────────────────────────

test('abort: aborted=true always wins, even over a non-null session or a taskState', () => {
  assert.equal(deriveTaskProgress(null, { aborted: true }).status, ProgressStatus.ABORTED);
  assert.equal(deriveTaskProgress({ phase: 'EXECUTING' }, { aborted: true, taskState: 'EXECUTING' }).status, ProgressStatus.ABORTED);
});

test('abort status is terminal', () => {
  assert.equal(isTerminalStatus(ProgressStatus.ABORTED), true);
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['aborted', 'complete', 'error']);
});

// ── navigation / state reset ──────────────────────────────────────────────────

test('navigation/state reset: status is inferred from session.phase when no taskState is given (e.g. right after a fresh bootstrap, before applyEvent runs)', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.setPhase(1, 'PAUSED');
  const p = deriveTaskProgress(await SessionStore.load(1)); // no taskState param
  assert.equal(p.status, ProgressStatus.PAUSED);
});

test('navigation/state reset: taskState, when supplied, is authoritative over session.phase', async () => {
  await SessionStore.create(1, 'g');
  await SessionStore.setPhase(1, 'PLANNING');
  const p = deriveTaskProgress(await SessionStore.load(1), { taskState: 'AWAITING_USER' });
  assert.equal(p.status, ProgressStatus.RUNNING); // AWAITING_USER maps to running, overriding phase=PLANNING
});

// ── stale state ───────────────────────────────────────────────────────────────

test('stale state: an expired session is resolved to null by SessionStore.load() itself, and TaskProgress handles that gracefully', async () => {
  await SessionStore.create(1, 'g');
  _store['sp_session_1'].expiresAt = Date.now() - 1;
  const loaded = await SessionStore.load(1);
  assert.equal(loaded, null, 'SessionStore already purges this — TaskProgress does not reimplement expiry');
  const p = deriveTaskProgress(loaded);
  assert.equal(p.status, ProgressStatus.IDLE);
});

// ── persistence / restore ─────────────────────────────────────────────────────

test('persistence/restore: state survives a full store round-trip (simulating a navigation reload)', async () => {
  await SessionStore.create(1, 'Send an email');
  await SessionStore.markPendingStep(1, { description: 'Click Send', intent: 'submit', completionCondition: 'final' });
  await SessionStore.completeStep(1, { description: 'Fill recipient', intent: 'fill', completedAt: Date.now() });
  await SessionStore.incrementReplanCount(1);
  await SessionStore.patchSession(1, { lastActionResult: 'element_not_found', lastActionAt: Date.now() });

  // Genuinely reload — new object graph, not the same in-memory reference.
  const restored = await SessionStore.load(1);
  const p = deriveTaskProgress(restored);
  assert.equal(p.goal, 'Send an email');
  assert.equal(p.completedSteps.count, 1);
  assert.equal(p.replanCount, 1);
  assert.equal(p.lastAction.result, 'element_not_found');
});

// ── sensitive-data exclusion ──────────────────────────────────────────────────

test('sensitive-data exclusion: a PII-bearing goal and step text are redacted in the derived output', async () => {
  await SessionStore.create(1, `email this to ${EMAIL}`);
  await SessionStore.markPendingStep(1, { description: `Send to ${EMAIL}`, intent: `fill_${EMAIL}`, completionCondition: 'dom_change' });
  await SessionStore.completeStep(1, { description: `Sent to ${EMAIL}`, intent: 'send', completedAt: Date.now() });
  const p = deriveTaskProgress(await SessionStore.load(1));
  const dump = JSON.stringify(p);
  assert.equal(dump.includes(EMAIL), false, `TaskProgress must never contain the raw email: ${dump}`);
  assert.match(p.goal, /\[REDACTED\]/);
});

test('sensitive-data exclusion: TaskProgress never contains password/API-key/JWT-shaped text, screenshots, or raw model output — by construction (SessionStore never stores them)', async () => {
  const session = await SessionStore.create(1, 'g');
  assert.equal('screenshot' in session, false);
  assert.equal('rawModelOutput' in session, false);
  assert.equal('apiKey' in session, false);
  const p = deriveTaskProgress(session);
  assert.equal(JSON.stringify(p).length < 2000, true, 'no unbounded/raw payload smuggled in');
});

test('sensitive-data exclusion: logging a TaskProgress object through the Phase 3 logger never leaks the redacted-away value', async () => {
  const { logEvent } = await import('../lib/sp-logger.js');
  await SessionStore.create(1, `contact ${EMAIL}`);
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    logEvent('task_progress_snapshot', deriveTaskProgress(await SessionStore.load(1)));
  } finally {
    console.log = orig;
  }
  assert.equal(lines.some((l) => l.includes(EMAIL)), false);
});
