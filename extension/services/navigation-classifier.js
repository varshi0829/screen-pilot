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

  // Case 4: unknown — manual navigation, auth redirect, or unrecognized destination
  return { classification: NavClassification.UNKNOWN, matchedStepIndex: null };
}
