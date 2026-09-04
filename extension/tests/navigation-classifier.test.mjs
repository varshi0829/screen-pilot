// Navigation Classifier — Unit Tests
// Run: node extension/tests/navigation-classifier.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';
import { classifyNavigation, NavClassification } from '../services/navigation-classifier.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    completedSteps: [],
    pendingStep:    null,
    ...overrides,
  };
}

function makePending(overrides = {}) {
  return {
    description:         'Click Pull requests',
    intent:              'navigate_to_pull_requests',
    completionCondition: 'url_change',
    expectedUrlPattern:  '/pulls',
    expectedUrlChanges:  true,
    urlBefore:           'https://github.com/torvalds/linux',
    stepStartedAt:       Date.now(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('WORKFLOW_NAVIGATION — URL includes expectedUrlPattern', () => {
  const session = makeSession({ pendingStep: makePending() });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION);
});

test('WORKFLOW_NAVIGATION — pattern matches within a longer URL with query string', () => {
  const session = makeSession({ pendingStep: makePending({ expectedUrlPattern: '/issues' }) });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/issues?q=bug&state=open'
  );
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION);
});

test('WORKFLOW_NAVIGATION — matchedStepIndex is null (history is not involved)', () => {
  const session = makeSession({ pendingStep: makePending() });
  const { matchedStepIndex } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(matchedStepIndex, null);
});

test('REFRESH — current URL identical to urlBefore', () => {
  const session = makeSession({ pendingStep: makePending() });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux'
  );
  assert.equal(classification, NavClassification.REFRESH);
});

test('REFRESH — takes priority over BACK_BUTTON when urlBefore matches history entry', () => {
  // If urlBefore also matches a completed step's urlAfter, REFRESH wins because
  // the user refreshed the current page rather than navigating back.
  const session = makeSession({
    completedSteps: [{ urlAfter: 'https://github.com/torvalds/linux' }],
    pendingStep:    makePending({ urlBefore: 'https://github.com/torvalds/linux' }),
  });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux'
  );
  // expectedUrlChanges is true and pattern does NOT match, so WORKFLOW_NAVIGATION is skipped.
  // urlBefore matches → REFRESH is returned before history is checked.
  assert.equal(classification, NavClassification.REFRESH);
});

test('BACK_BUTTON — URL matches most recent completed step urlAfter', () => {
  // User is on /pulls/new (filling a new issue form) and presses back to /pulls.
  // urlBefore is /pulls/new, not /pulls, so REFRESH is not triggered.
  const session = makeSession({
    completedSteps: [
      { urlAfter: 'https://github.com/torvalds/linux/pulls' },
    ],
    pendingStep: makePending({
      urlBefore:          'https://github.com/torvalds/linux/pulls/new',
      expectedUrlPattern: '/pull/123',
    }),
  });
  const { classification, matchedStepIndex } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(classification, NavClassification.BACK_BUTTON);
  assert.equal(matchedStepIndex, 0);
});

test('BACK_BUTTON — matches step N-2 when user navigated back multiple steps', () => {
  const session = makeSession({
    completedSteps: [
      { urlAfter: 'https://example.com/a' },
      { urlAfter: 'https://example.com/b' },
      { urlAfter: 'https://example.com/c' },
    ],
    pendingStep: makePending({
      urlBefore:          'https://example.com/c',
      expectedUrlPattern: '/d',
    }),
  });
  const { classification, matchedStepIndex } = classifyNavigation(
    session, 'https://example.com/a'
  );
  assert.equal(classification, NavClassification.BACK_BUTTON);
  assert.equal(matchedStepIndex, 0);
});

test('BACK_BUTTON — returns most recent matching step when history has duplicates', () => {
  // User is on /settings/advanced and presses back to /settings (which appears
  // at both index 0 and index 2 in history). Should match the most recent (index 2).
  const session = makeSession({
    completedSteps: [
      { urlAfter: 'https://example.com/settings' },
      { urlAfter: 'https://example.com/other' },
      { urlAfter: 'https://example.com/settings' }, // visited again
    ],
    pendingStep: makePending({
      urlBefore:          'https://example.com/settings/advanced',
      expectedUrlPattern: '/confirm',
    }),
  });
  const { matchedStepIndex } = classifyNavigation(
    session, 'https://example.com/settings'
  );
  assert.equal(matchedStepIndex, 2, 'should match the most recent occurrence');
});

test('UNKNOWN — URL matches nothing in session', () => {
  const session = makeSession({ pendingStep: makePending() });
  const { classification } = classifyNavigation(
    session, 'https://totally-different-site.com/page'
  );
  assert.equal(classification, NavClassification.UNKNOWN);
});

// Updated by the multi-step navigation-continuation fix: this exact shape
// (same-origin URL change, no expectedUrlPattern ever predicted, fresh
// stepStartedAt) is precisely the real-world bug this fix addresses — a
// button/div-resolved step whose real navigation the planning tiers could not
// ground-truth in advance. It must now resolve as WORKFLOW_NAVIGATION (Case 4
// in navigation-classifier.js), not UNKNOWN. See the dedicated Case 4 tests
// below for full coverage of the conservative guards.
test('WORKFLOW_NAVIGATION (conservative fallback) — expectedUrlChanges is false; same-origin URL changed shortly after step start', () => {
  const session = makeSession({
    pendingStep: makePending({ expectedUrlChanges: false, expectedUrlPattern: null }),
  });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION);
});

test('WORKFLOW_NAVIGATION (conservative fallback) — expectedUrlPattern is null even when expectedUrlChanges is true', () => {
  const session = makeSession({
    pendingStep: makePending({ expectedUrlPattern: null, expectedUrlChanges: true }),
  });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION);
});

test('UNKNOWN — pendingStep is null (should never happen in practice; guard)', () => {
  const session = makeSession({ pendingStep: null });
  const { classification } = classifyNavigation(
    session, 'https://github.com/torvalds/linux/pulls'
  );
  assert.equal(classification, NavClassification.UNKNOWN);
});

test('UNKNOWN — empty completedSteps and no match', () => {
  const session = makeSession({
    completedSteps: [],
    pendingStep:    makePending({ expectedUrlPattern: '/pulls' }),
  });
  const { classification } = classifyNavigation(
    session, 'https://completely-unrelated.com'
  );
  assert.equal(classification, NavClassification.UNKNOWN);
});

// ── Regression: auth-redirect false positive ──────────────────────────────────
// Before the fix, currentUrl.includes('/settings') matched the query string in
// /login?next=/settings, incorrectly returning WORKFLOW_NAVIGATION and appending
// the step as complete on the login page.

test('UNKNOWN — auth redirect: pattern in query string is not treated as WORKFLOW_NAVIGATION', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlPattern: '/settings',
      expectedUrlChanges: true,
      urlBefore: 'https://app.com/dashboard',
    }),
  });
  const { classification } = classifyNavigation(
    session,
    'https://app.com/login?next=/settings'
  );
  assert.equal(classification, NavClassification.UNKNOWN);
});

// ── Hash-based SPA routing ────────────────────────────────────────────────────
// Angular default mode, older React Router deployments, and any SPA without
// server-side URL rewriting use hash routing. The pathname is always '/'; the
// route lives in the hash fragment. The classifier must match on hash so these
// navigations are not misclassified as UNKNOWN.

// ── Multi-step navigation continuation — Case 4 conservative fallback ─────────
// Covers a resolved click target that was not a plain <a href> (a button, a
// div, a JS-routed control) whose real destination the planning tiers could
// not ground-truth in advance — real-Chrome finding, bbc.com goal "Go to the
// Technology section": resolved target was a <div>, expectedUrlChanges stayed
// false, the click still navigated, and the task paused after one step.

test('Case 4 — Scenario A: non-anchor control (button/div) causes real same-origin navigation → WORKFLOW_NAVIGATION', () => {
  const session = makeSession({
    pendingStep: makePending({
      description:         'Click Technology',
      intent:              'click_technology',
      expectedUrlChanges:  false,     // L1's hardcoded guess — the button was never a plain <a href>
      expectedUrlPattern:  null,      // no ground truth was ever available for this target
      urlBefore:           'https://www.bbc.com/',
      stepStartedAt:       Date.now(),
    }),
  });
  const { classification } = classifyNavigation(session, 'https://www.bbc.com/technology');
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION,
    'a real same-origin navigation right after a non-anchor step must continue the workflow, not pause it');
});

test('Case 4 — Scenario C: cross-origin navigation is NOT treated as workflow-caused', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlChanges: false,
      expectedUrlPattern: null,
      urlBefore:           'https://app.example.com/dashboard',
      stepStartedAt:        Date.now(),
    }),
  });
  const { classification } = classifyNavigation(session, 'https://totally-unrelated-site.com/');
  assert.equal(classification, NavClassification.UNKNOWN,
    'a different origin is far more likely to be the user browsing away than this workflow\'s own action');
});

test('Case 4 — Scenario C: an expected pattern that did NOT match stays UNKNOWN (auth-redirect style), not a blind fallback', () => {
  // A specific prediction existed (expectedUrlPattern) and Case 1 already tried
  // and failed to match it — that mismatch is itself evidence something other
  // than the workflow's own action occurred (auth wall, error page, unrelated
  // redirect). Case 4 must not paper over that with a blind same-origin match.
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlChanges:  true,
      expectedUrlPattern:  '/settings',
      urlBefore:           'https://app.example.com/dashboard',
      stepStartedAt:        Date.now(),
    }),
  });
  const { classification } = classifyNavigation(session, 'https://app.example.com/login?next=/settings');
  assert.equal(classification, NavClassification.UNKNOWN);
});

test('Case 4 — Scenario C: stale session (stepStartedAt long ago) does NOT trigger the fallback', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlChanges: false,
      expectedUrlPattern: null,
      urlBefore:           'https://www.bbc.com/',
      stepStartedAt:        Date.now() - 60_000, // 60s ago — well outside the window
    }),
  });
  const { classification } = classifyNavigation(session, 'https://www.bbc.com/technology');
  assert.equal(classification, NavClassification.UNKNOWN,
    'a navigation long after the step started is not reliably caused by that step');
});

test('Case 4 — missing stepStartedAt does NOT trigger the fallback (conservative default)', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlChanges: false,
      expectedUrlPattern: null,
      urlBefore:           'https://www.bbc.com/',
      stepStartedAt:        undefined,
    }),
  });
  const { classification } = classifyNavigation(session, 'https://www.bbc.com/technology');
  assert.equal(classification, NavClassification.UNKNOWN);
});

test('Case 4 — REFRESH still wins precedence when URL is unchanged, even with no pattern', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlChanges: false,
      expectedUrlPattern: null,
      urlBefore:           'https://www.bbc.com/',
      stepStartedAt:        Date.now(),
    }),
  });
  const { classification } = classifyNavigation(session, 'https://www.bbc.com/');
  assert.equal(classification, NavClassification.REFRESH);
});

test('Case 4 — BACK_BUTTON still wins precedence over the fallback', () => {
  const session = makeSession({
    completedSteps: [{ urlAfter: 'https://www.bbc.com/sport' }],
    pendingStep: makePending({
      expectedUrlChanges: false,
      expectedUrlPattern: null,
      urlBefore:           'https://www.bbc.com/technology',
      stepStartedAt:        Date.now(),
    }),
  });
  const { classification, matchedStepIndex } = classifyNavigation(session, 'https://www.bbc.com/sport');
  assert.equal(classification, NavClassification.BACK_BUTTON);
  assert.equal(matchedStepIndex, 0);
});

test('WORKFLOW_NAVIGATION — hash-routed SPA: pattern in hash fragment matches', () => {
  const session = makeSession({
    pendingStep: makePending({
      expectedUrlPattern: '/settings',
      expectedUrlChanges: true,
    }),
  });
  // new URL('https://app.com/#/settings').pathname === '/'  → no pathname match
  // new URL('https://app.com/#/settings').hash    === '#/settings' → hash match
  const { classification } = classifyNavigation(
    session,
    'https://app.com/#/settings'
  );
  assert.equal(classification, NavClassification.WORKFLOW_NAVIGATION);
});
