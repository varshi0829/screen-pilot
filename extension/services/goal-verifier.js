// ScreenPilot v2 — Goal Verifier (Phase 23C, SHADOW MODE)
//
// Evaluates a plan-level GoalCompletionCriteria (Phase 23A/23B) against the live
// page and produces a verdict. This module is intentionally READ-ONLY and side
// effect-free: it inspects `document` / `location` and returns a plain object.
//
// SHADOW MODE CONTRACT: nothing here triggers completion, changes state, or alters
// runtime behavior. The orchestrator only logs the verdict for agreement telemetry.
//
// It uses dumb URL / text / accessible-name presence predicates only — it is NOT
// the DOMMatcher and performs no ranking or scoring.

/** Collapse whitespace + lowercase for case-insensitive text/label comparison. */
function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

function hrefIncludes(loc, pattern) {
  if (!pattern) return null;                 // nothing to test → unknown
  const href = (loc && loc.href) || '';
  return href.includes(pattern);
}

/** Visible page text contains `text` (case-insensitive). Uses innerText so hidden
 *  nodes are excluded the same way a user would perceive the page. */
function textPresent(doc, text) {
  const needle = normalize(text);
  if (!needle) return null;
  const body = doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
  return normalize(body).includes(needle);
}

/** An element with a matching accessible name (aria-label / title / img alt) OR a
 *  matching visible text label exists. Plain scan — no matcher, no scoring. */
function elementPresent(doc, text) {
  const needle = normalize(text);
  if (!needle) return null;
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  for (const el of doc.querySelectorAll('[aria-label],[title],img[alt]')) {
    const name = normalize(
      el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || ''
    );
    if (name.includes(needle)) return true;
  }
  for (const el of doc.querySelectorAll('a,button,[role="button"],[role="link"],h1,h2,h3,summary,li,td,strong,span')) {
    if (normalize(el.textContent || '').includes(needle)) return true;
  }
  return false;
}

/**
 * Evaluate a single SuccessSignal.
 * @returns {{ type: string, target: string, passed: boolean|null }}
 *   passed === null means "could not evaluate" (missing target, no DOM, or an
 *   unsupported signal type) → contributes to an "unknown" verdict.
 */
function evaluateSignal(signal, doc, loc) {
  const type   = signal && signal.type;
  const target = (signal && (signal.urlPattern ?? signal.text)) ?? '';
  let passed;
  switch (type) {
    case 'url_matches':     passed = loc ? hrefIncludes(loc, signal.urlPattern) : null; break;
    case 'url_leaves':      { const inc = loc ? hrefIncludes(loc, signal.urlPattern) : null; passed = inc === null ? null : !inc; break; }
    case 'text_present':    passed = textPresent(doc, signal.text); break;
    case 'element_present': passed = elementPresent(doc, signal.text); break;
    case 'element_absent':  { const pres = elementPresent(doc, signal.text); passed = pres === null ? null : !pres; break; }
    default:                passed = null; // unsupported type → unknown
  }
  return { type: type || 'unknown', target, passed };
}

export const GoalVerifier = {
  /**
   * Evaluate goalCompletionCriteria against the current page.
   *
   * @param {import('../shared/types/index.js').GoalCompletionCriteria} criteria
   * @param {{ doc?: Document, loc?: Location }} [env] - injectable for tests
   * @returns {{ satisfied: boolean, verdict: 'satisfied'|'unsatisfied'|'unknown',
   *             matchedSignals: number, totalSignals: number,
   *             details: Array<{type: string, target: string, passed: boolean|null}> }}
   */
  evaluate(criteria, env = {}) {
    const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
    const loc = env.loc ?? (typeof location !== 'undefined' ? location : null);

    const signals = Array.isArray(criteria && criteria.successSignals) ? criteria.successSignals : [];
    const totalSignals = signals.length;

    if (totalSignals === 0) {
      return { satisfied: false, verdict: 'unknown', matchedSignals: 0, totalSignals: 0, details: [] };
    }

    const details = signals.map((s) => evaluateSignal(s, doc, loc));
    const matchedSignals = details.filter((d) => d.passed === true).length;
    const anyUnknown     = details.some((d) => d.passed === null);

    // Match rule: 'any' → ≥1 signal passes; anything else defaults to 'all'.
    const match = criteria && criteria.match === 'any' ? 'any' : 'all';
    const satisfied = match === 'any' ? matchedSignals >= 1 : matchedSignals === totalSignals;

    let verdict;
    if (satisfied)            verdict = 'satisfied';
    else if (anyUnknown)      verdict = 'unknown';
    else                      verdict = 'unsatisfied';

    return { satisfied, verdict, matchedSignals, totalSignals, details };
  },

  /**
   * Phase 26 — completion gate. Decides whether the verifier may DRIVE completion
   * (as opposed to Phase 23C's log-only shadow mode). All safety rules live here:
   *   1. criteria must exist,
   *   2. requiresEffect must be explicitly true (navigation-only goals stay on the
   *      legacy planner-completion path),
   *   3. evaluate() must return satisfied (match rule already enforced there),
   *   4. optional confidenceThreshold must be met (matched/total ratio).
   * Returns { complete, reason, verdict } — never throws.
   *
   * @param {import('../shared/types/index.js').GoalCompletionCriteria|null} criteria
   * @param {{ doc?: Document, loc?: Location }} [env]
   */
  shouldComplete(criteria, env = {}) {
    const result = (() => {
      try {
        if (!criteria)                        return { complete: false, reason: 'no_criteria', verdict: null };
        if (criteria.requiresEffect !== true) return { complete: false, reason: 'no_effect_contract', verdict: null };
        const verdict = this.evaluate(criteria, env);
        if (!verdict.satisfied)               return { complete: false, reason: 'unsatisfied', verdict };
        if (typeof criteria.confidenceThreshold === 'number' && verdict.totalSignals > 0 &&
            verdict.matchedSignals / verdict.totalSignals < criteria.confidenceThreshold) {
          return { complete: false, reason: 'below_confidence_threshold', verdict };
        }
        return { complete: true, reason: 'signals_satisfied', verdict };
      } catch {
        return { complete: false, reason: 'evaluation_error', verdict: null };
      }
    })();
    // Diagnostic only — logs the exact decision this call produced, no behavior change.
    console.log("[SP:GoalVerifier]", {
      complete:       result.complete,
      reason:         result.reason,
      matchedSignals: result.verdict?.matchedSignals,
      totalSignals:   result.verdict?.totalSignals,
      details:        result.verdict?.details
    });
    return result;
  },
};
