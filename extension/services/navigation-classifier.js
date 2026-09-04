// ScreenPilot v2 — Navigation Classifier
//
// Pure function. No I/O, no async, no DOM access, no AI calls, no site-specific logic.
// Given a WorkflowSession and the current page URL, classifies the navigation event.
//
// Used by the resume logic in v2-task.js on every content script init when a session
// is found with phase === 'EXECUTING'. The classification determines the next action.
//
// Classifications:
//   WORKFLOW_NAVIGATION — URL matches pendingStep.expectedUrlPattern.
//                         The navigation was expected. Append step to history and re-plan.
//   REFRESH             — URL identical to where the step started.
//                         User refreshed before acting. Re-highlight same element.
//   BACK_BUTTON         — URL matches an earlier completed step's urlAfter.
//                         User pressed back. Show resume-from-earlier-step UI.
//   UNKNOWN             — No match. Manual navigation, auth redirect, or unrecognized.
//                         Show PAUSED banner.

export const NavClassification = Object.freeze({
  WORKFLOW_NAVIGATION: 'WORKFLOW_NAVIGATION',
  REFRESH:             'REFRESH',
  BACK_BUTTON:         'BACK_BUTTON',
  UNKNOWN:             'UNKNOWN',
});

/**
 * Returns true when the URL's pathname or hash includes the given pattern.
 *
 * Checking only pathname (not the full URL string) prevents false positives
 * from query-string parameters such as /login?next=/settings matching the
 * pattern /settings. Including hash supports hash-based SPA routing where
 * the pathname is always "/" and the route lives in the fragment (#/settings).
 *
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesUrlPattern(url, pattern) {
  try {
    const { pathname, hash } = new URL(url);
    return pathname.includes(pattern) || hash.includes(pattern);
  } catch {
    return false;
  }
}

/** True when both URLs share the same origin (protocol + host + port). A
 *  navigation to a different site is far more likely to be the user browsing
 *  away than evidence of this workflow's own action — used to bound the
 *  conservative fallback below. */
function sameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

// Bounded window within which a URL change is still plausibly the direct result
// of the workflow's own just-executed action, rather than an unrelated
// navigation the user made much later after resuming a stale session. Generous
// enough to cover a slow page load or a short redirect chain; short enough to
// exclude anything else.
const WORKFLOW_NAVIGATION_WINDOW_MS = 20000;

/**
 * Classify the current URL relative to the active session.
 *
 * The order of checks matters:
 *   1. expectedUrlPattern is checked first — explicit expectation wins
 *   2. urlBefore is checked second — refresh is only meaningful when nav was NOT expected
 *   3. completedSteps history is checked last — back-button detection
 *   4. UNKNOWN is the fallback
 *
 * @param {import('../shared/types/index.js').WorkflowSession} session
 * @param {string} currentUrl
 * @returns {{ classification: string, matchedStepIndex: number|null }}
 */
export function classifyNavigation(session, currentUrl) {
  const pending = session.pendingStep;

  // Case 1: expected workflow navigation
  if (
    pending?.expectedUrlChanges === true &&
    pending?.expectedUrlPattern &&
    matchesUrlPattern(currentUrl, pending.expectedUrlPattern)
  ) {
    return { classification: NavClassification.WORKFLOW_NAVIGATION, matchedStepIndex: null };
  }

  // Case 2: user refreshed before acting (URL unchanged from step start)
  if (pending?.urlBefore && currentUrl === pending.urlBefore) {
    return { classification: NavClassification.REFRESH, matchedStepIndex: null };
  }

  // Case 3: user pressed back (URL matches a prior completed step's destination)
  const history = session.completedSteps ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].urlAfter && currentUrl === history[i].urlAfter) {
      return { classification: NavClassification.BACK_BUTTON, matchedStepIndex: i };
    }
  }

  // Case 4: conservative fallback — a workflow step was pending, a real
  // navigation to a DIFFERENT same-origin URL occurred shortly after it
  // started, and we have no specific prediction it contradicts. Covers a
  // resolved click target that wasn't a plain <a href> (a button, a div, a
  // JS-routed control) whose real destination the planning tiers could not
  // ground-truth in advance. Real-Chrome finding (bbc.com, goal "Go to the
  // Technology section"): the resolved click target was a <div>,
  // expectedUrlChanges stayed false (L1's hardcoded guess), the click still
  // caused a real navigation, and this fell all the way through to UNKNOWN —
  // pausing the task after a single step instead of continuing it.
  //
  // Deliberately narrow, per two independent conditions:
  //   (a) SAME ORIGIN — a different site is far more likely to be the user
  //       browsing away on their own than evidence of this workflow's own
  //       action.
  //   (b) NO expectedUrlPattern was ever set — when a pattern WAS predicted,
  //       Case 1 above already tried and failed to match it; that mismatch is
  //       itself evidence the navigation went somewhere OTHER than expected
  //       (an auth wall, an error page, an unrelated redirect), so staying
  //       UNKNOWN there is the safer call. This is what keeps a genuine
  //       auth-redirect (e.g. /login?next=/settings, expectedUrlPattern
  //       '/settings' set but not matched) correctly UNKNOWN rather than
  //       silently treated as workflow progress.
  //   (c) within WORKFLOW_NAVIGATION_WINDOW_MS of the step actually starting —
  //       rules out a stale/resumed session where the user has since
  //       navigated elsewhere on their own, long after the step began.
  if (
    pending?.urlBefore &&
    currentUrl !== pending.urlBefore &&
    !pending.expectedUrlPattern &&
    sameOrigin(pending.urlBefore, currentUrl) &&
    typeof pending.stepStartedAt === 'number' &&
    (Date.now() - pending.stepStartedAt) <= WORKFLOW_NAVIGATION_WINDOW_MS
  ) {
    return { classification: NavClassification.WORKFLOW_NAVIGATION, matchedStepIndex: null };
  }

  // Case 5: unknown — manual navigation, auth redirect, or unrecognized destination
  return { classification: NavClassification.UNKNOWN, matchedStepIndex: null };
}
