// Dynamic requirement-based completion model — regression tests.
//
// Targets updateRequirementProgress() / isRequirementSetComplete() /
// remainingRequirementCount() directly — small, pure, exported functions
// (same convention as v2-task-fingerprint-gate.test.mjs / __-prefixed test
// hooks). GoalVerifier itself is not modified and is not re-tested here —
// these tests only exercise the NEW cross-cycle accumulation layer on top
// of it, using generic synthetic verifier `details` (never action type,
// step count, or any site-specific text — see test H).
//
// Same minimal browser-global mock convention as
// v2-task-fingerprint-gate.test.mjs / goal-completion-defer.test.mjs
// (import-time side effects only; no DOM interaction needed for these
// pure-function tests).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

global.chrome = {
  storage: { local: {
    async get() { return {}; },
    async set() {},
    async remove() {},
  }},
  runtime: {
    sendMessage: async (msg) => (msg?.type === 'GET_TAB_ID' ? { tabId: null } : { success: false }),
    onMessage: { addListener: () => {} },
  },
};
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
  body: { appendChild: () => {} },
  title: 'Test page',
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: () => [],
};
global.window = {
  location: { href: 'https://example.com/' },
  __SP_Highlighter: null,
  DOMMatcher: null,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const {
  __updateRequirementProgress: updateRequirementProgress,
  __remainingRequirementCount: remainingRequirementCount,
  __isRequirementSetComplete: isRequirementSetComplete,
} = await import('../v2-task.js');

// Generic synthetic verifier details — deliberately abstract (type:'x'),
// never a real signal type/site, matching test H's requirement.
const d = (passed) => ({ type: 'x', target: '', passed });
const criteria = (n, overrides = {}) => ({
  goalType: 'action', match: 'all', verificationStrategy: 'local_signals',
  requiresEffect: true,
  successSignals: Array.from({ length: n }, () => ({ type: 'x', target: '' })),
  ...overrides,
});

// ── A. Pure progress initialization ─────────────────────────────────────────

test('A. null previousProgress + N all-unsatisfied details -> [false, false, ...]', () => {
  const details = [d(false), d(false), d(false)];
  assert.deepEqual(updateRequirementProgress(null, details), [false, false, false]);
});

test('A2. null previousProgress + N details containing null (unknown) -> still all false', () => {
  const details = [d(null), d(false), d(null)];
  assert.deepEqual(updateRequirementProgress(null, details), [false, false, false]);
});

// ── B. Single requirement ───────────────────────────────────────────────────

test('B. [false] + passed=true -> [true]; completion remains possible', () => {
  const progress = updateRequirementProgress([false], [d(true)]);
  assert.deepEqual(progress, [true]);
  assert.equal(isRequirementSetComplete(criteria(1), progress), true);
});

// ── C. Multi-requirement partial progress ───────────────────────────────────

test('C. [false,false,false,false] + [true,false,false,false] -> [true,false,false,false] -> NOT complete', () => {
  const progress = updateRequirementProgress(
    [false, false, false, false],
    [d(true), d(false), d(false), d(false)]
  );
  assert.deepEqual(progress, [true, false, false, false]);
  assert.equal(isRequirementSetComplete(criteria(4), progress), false);
  assert.equal(remainingRequirementCount(progress), 3);
});

// ── D. Multi-cycle accumulation ──────────────────────────────────────────────

test('D. three cycles, each satisfying a different requirement, accumulate to all-true -> complete', () => {
  let progress = null;
  progress = updateRequirementProgress(progress, [d(true), d(false), d(false)]);   // cycle 1
  assert.deepEqual(progress, [true, false, false]);
  progress = updateRequirementProgress(progress, [d(false), d(true), d(false)]);   // cycle 2
  assert.deepEqual(progress, [true, true, false]);
  progress = updateRequirementProgress(progress, [d(false), d(false), d(true)]);   // cycle 3
  assert.deepEqual(progress, [true, true, true]);
  assert.equal(isRequirementSetComplete(criteria(3), progress), true);
  assert.equal(remainingRequirementCount(progress), 0);
});

// ── E. Historical evidence outlives the page it was observed on ────────────

test('E. a requirement true on "page A" and false on "page B" remains true in requirementProgress', () => {
  let progress = updateRequirementProgress(null, [d(true), d(false)]); // page A: requirement 0 visible
  assert.deepEqual(progress, [true, false]);
  // page B: requirement 0's evidence is no longer visible (e.g. navigated away)
  progress = updateRequirementProgress(progress, [d(false), d(false)]);
  assert.deepEqual(progress, [true, false], 'requirement 0 must stay true even though this cycle reads false');
});

// ── F. passed:null must not satisfy a requirement ───────────────────────────

test('F. passed:null never marks a requirement satisfied, and never changes an existing false', () => {
  const progress = updateRequirementProgress([false, false], [d(null), d(null)]);
  assert.deepEqual(progress, [false, false]);
});

test('F2. passed:null after an existing true does not revert or otherwise change it', () => {
  const progress = updateRequirementProgress([true, false], [d(null), d(null)]);
  assert.deepEqual(progress, [true, false]);
});

// ── G. Already-satisfied requirements never revert ──────────────────────────

test('G. an existing true is never turned back to false by a later passed:false', () => {
  const progress = updateRequirementProgress([true, true], [d(false), d(false)]);
  assert.deepEqual(progress, [true, true], 'monotonic — once true, always true for the rest of the task');
});

// ── H. Action-type independence ─────────────────────────────────────────────

test('H. completion depends ONLY on synthetic signal outcomes — no action type, step count, or site is referenced anywhere in this file\'s inputs', () => {
  // Every fixture in this file uses generic {type:'x'} signals and plain
  // booleans/null — there is no isFillStep, fill_form, input_filled,
  // plan.steps.length, or site-specific text anywhere in the functions
  // under test or in how these tests drive them.
  const progress = updateRequirementProgress(null, [d(true), d(true)]);
  assert.equal(isRequirementSetComplete(criteria(2), progress), true);
});

// ── I. Single-action goal regression ────────────────────────────────────────

test('I. a single-successSignal goal can still complete as soon as that one signal is satisfied', () => {
  const progress = updateRequirementProgress(null, [d(true)]);
  assert.equal(isRequirementSetComplete(criteria(1), progress), true);
});

// ── J. Exact reproduced bug — four generic requirements ─────────────────────

test('J. four generic requirements: satisfying only requirement 1 must not complete the task', () => {
  const c = criteria(4);
  let progress = updateRequirementProgress(null, [d(true), d(false), d(false), d(false)]);
  assert.deepEqual(progress, [true, false, false, false]);
  assert.equal(isRequirementSetComplete(c, progress), false, 'task must NOT be complete after only requirement 1');
  assert.equal(remainingRequirementCount(progress), 3);

  // Subsequent cycles satisfy the remaining requirements one at a time —
  // requirement 1's evidence is no longer visible on these later "pages",
  // exactly like the reported bug's multi-step form.
  progress = updateRequirementProgress(progress, [d(false), d(true), d(false), d(false)]);
  assert.equal(isRequirementSetComplete(c, progress), false, 'still 2/4');

  progress = updateRequirementProgress(progress, [d(false), d(false), d(true), d(false)]);
  assert.equal(isRequirementSetComplete(c, progress), false, 'still 3/4');

  progress = updateRequirementProgress(progress, [d(false), d(false), d(false), d(true)]);
  assert.deepEqual(progress, [true, true, true, true]);
  assert.equal(isRequirementSetComplete(c, progress), true, 'complete only once all four have EVER been observed satisfied');
});

// ── isRequirementSetComplete: fallback / structural-precondition behavior ──

test('isRequirementSetComplete returns null (not applicable) when criteria is absent', () => {
  assert.equal(isRequirementSetComplete(null, [true]), null);
});

test('isRequirementSetComplete returns null when criteria does not opt into requiresEffect', () => {
  assert.equal(isRequirementSetComplete({ successSignals: [{}], requiresEffect: false }, [true]), null);
});

test('isRequirementSetComplete returns false for a criteria with zero successSignals (mirrors evaluate()\'s own "0 signals -> unsatisfied")', () => {
  assert.equal(isRequirementSetComplete(criteria(0), []), false);
});

test('isRequirementSetComplete respects match:"any" — at least one satisfied requirement is enough', () => {
  const c = criteria(3, { match: 'any' });
  assert.equal(isRequirementSetComplete(c, [false, true, false]), true);
  assert.equal(isRequirementSetComplete(c, [false, false, false]), false);
});

test('isRequirementSetComplete respects confidenceThreshold against the ACCUMULATED ratio', () => {
  const c = criteria(4, { match: 'any', confidenceThreshold: 0.5 });
  assert.equal(isRequirementSetComplete(c, [true, false, false, false]), false, '1/4 = 0.25 < 0.5');
  assert.equal(isRequirementSetComplete(c, [true, true, false, false]), true, '2/4 = 0.5 >= 0.5');
});

// ── Purity / robustness ─────────────────────────────────────────────────────

test('updateRequirementProgress never mutates its inputs', () => {
  const prev = [true, false];
  const details = [d(false), d(true)];
  const prevCopy = JSON.stringify(prev);
  const detailsCopy = JSON.stringify(details);
  updateRequirementProgress(prev, details);
  assert.equal(JSON.stringify(prev), prevCopy);
  assert.equal(JSON.stringify(details), detailsCopy);
});

test('updateRequirementProgress handles a details array shorter than previousProgress without dropping earlier trues', () => {
  const progress = updateRequirementProgress([true, true, false], [d(false)]);
  assert.deepEqual(progress, [true, true, false], 'shorter details this cycle must not silently drop known-true requirements');
});

test('updateRequirementProgress handles undefined/malformed details gracefully', () => {
  assert.deepEqual(updateRequirementProgress([true, false], undefined), [true, false]);
  assert.deepEqual(updateRequirementProgress(null, undefined), []);
});

test('remainingRequirementCount handles null/malformed progress gracefully', () => {
  assert.equal(remainingRequirementCount(null), 0);
  assert.equal(remainingRequirementCount(undefined), 0);
});
