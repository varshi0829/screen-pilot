// ScreenPilot v2 — Executor Engine
//
// Takes a frozen ExecutionPlan and drives it step-by-step.
// Resolves DOM elements, highlights them, detects user interaction,
// and exposes the pre-action baseline that the Validator reads.
//
// The Executor knows nothing about providers, backends, or Gemini.
// It only consumes an ExecutionPlan and emits structured events.
//
// Dependencies — all constructor-injected (no globals required):
//   domMatcher      { matchElement(descriptor) → MatchResult | null }
//   highlighter     { show(element, text) → Promise<boolean>, clear() → void }
//   captureSnapshot () → PageSnapshot   [default: capturePageSnapshot]
//
// Events emitted (subscribe with executor.on(name, handler)):
//   'element:ready'      { step, element, snapshot }
//   'element:not_found'  { step, reason, isOptional }
//   'user:acted'         { step, trigger, timestamp }
//   'step:skipped'       { step, reason }
//   'plan:complete'      { plan, completedAt }
//
// State machine mapping (for the Phase 4 orchestrator):
//   element:ready      → TaskEvent.ELEMENT_READY
//   element:not_found  → TaskEvent.ELEMENT_NOT_FOUND
//   user:acted         → TaskEvent.USER_ACTED
//   plan:complete      → TaskEvent.FINAL_STEP_COMPLETE

import { capturePageSnapshot }      from '../lib/page-snapshot.js';
import { ElementResolutionThreshold } from '../shared/types/index.js';

// How long typing must be quiet before a fill with no explicitly requested
// value is treated as finished. Only reached when the step carries no value to
// check against — with one, the value itself is the completion signal.
export const FILL_IDLE_MS = 600;

/**
 * Does a control's current content satisfy the value the step asked for?
 *
 * Deliberately generous rather than exact: `includes` after normalizing case
 * and whitespace. A control legitimately holds more than what was typed —
 * autocomplete completes a query, a formatter reshapes a number, a combobox
 * echoes the selected item — and those are successes. What it rejects is the
 * case that matters: content that does not yet contain the requested value at
 * all, i.e. a partially entered value.
 *
 * Works on anything exposing text content, so plain inputs, search fields,
 * textareas and contenteditable are all handled the same way, with no
 * knowledge of the site or the control.
 *
 * @param {string} actual
 * @param {string} requested
 * @returns {boolean}
 */
export function valueSatisfies(actual, requested) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(requested);
  if (!want) return norm(actual).length > 0;
  return norm(actual).includes(want);
}

// ── ExecutorStatus values (string union) ──────────────────────────────────────
// 'idle'      — no plan active; safe to call start()
// 'resolving' — actively matching a DOM element
// 'awaiting'  — element highlighted; waiting for user action
// 'complete'  — all steps executed; plan finished
// 'aborted'   — stopped by abort(); safe to call start() again

export class ExecutorEngine {
  /**
   * @param {object} deps
   * @param {{ matchElement(descriptor: object): object | null }} deps.domMatcher
   * @param {{ show(element: Element, text: string): Promise<boolean>, clear(): void }} deps.highlighter
   * @param {() => object} [deps.captureSnapshot]
   */
  constructor({
    domMatcher, highlighter, captureSnapshot = capturePageSnapshot,
    // Bounded wait-and-retry budget for _resolveElementWithWait (see its own
    // doc comment) — configurable so tests can use a short budget instead of
    // the real 2s one. Defaults mirror the existing post-click URL-poll
    // precedent elsewhere in this file (100ms interval, 2s budget).
    elementResolvePollIntervalMs = 100,
    elementResolveMaxWaitMs      = 2000,
    // Quiet period before a fill with no requested value counts as finished —
    // injectable so tests need not wait out the real budget.
    fillIdleMs                   = FILL_IDLE_MS,
  } = {}) {
    if (!domMatcher)  throw new TypeError('ExecutorEngine: domMatcher is required');
    if (!highlighter) throw new TypeError('ExecutorEngine: highlighter is required');

    this._domMatcher      = domMatcher;
    this._highlighter     = highlighter;
    this._captureSnapshot = captureSnapshot;
    this._elementResolvePollIntervalMs = elementResolvePollIntervalMs;
    this._elementResolveMaxWaitMs      = elementResolveMaxWaitMs;
    this._fillIdleMs                   = fillIdleMs;

    this._plan              = null;
    this._stepIndex         = 0;
    this._status            = 'idle';
    this._preActionSnapshot = null;
    this._activeElement     = null;
    this._cleanups          = [];
    this._handlers          = new Map();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Begin executing a plan starting at plan.currentStepIndex.
   * Throws if the Executor is already running (status 'resolving' or 'awaiting').
   * Call abort() first to stop an in-progress plan.
   *
   * @param {import('../shared/types/index.js').ExecutionPlan} plan
   */
  start(plan) {
    if (this._status === 'resolving' || this._status === 'awaiting') {
      throw new Error(
        `ExecutorEngine.start() called while status is "${this._status}". ` +
        'Call abort() first to stop the current plan.'
      );
    }

    if (!plan?.steps?.length) {
      // A plan with no steps is valid when the planner determined the goal is already
      // achieved. Emit plan:complete immediately without touching the DOM.
      this._plan   = plan ?? null;
      this._status = 'complete';
      this._emit('plan:complete', { plan: plan ?? { steps: [] }, completedAt: Date.now() });
      return;
    }

    this._plan      = plan;
    this._stepIndex = plan.currentStepIndex ?? 0;
    this._status    = 'resolving';

    // Fire-and-forget: events are emitted asynchronously.
    // Callers subscribe with on() before calling start().
    this._executeStep().catch(err => {
      console.error('[ExecutorEngine] Unhandled error in _executeStep:', err);
    });
  }

  /**
   * Advance to the next step.
   * Called by the orchestrator after VALIDATION_PASSED.
   * Ignored (with a warning) if status is not 'awaiting'.
   */
  advance() {
    if (this._status !== 'awaiting') {
      console.warn(`[ExecutorEngine] advance() called in status "${this._status}" — ignoring`);
      return;
    }

    this._stepIndex++;
    if (this._stepIndex >= this._plan.steps.length) {
      this._status = 'complete';
      this._emit('plan:complete', { plan: this._plan, completedAt: Date.now() });
      return;
    }

    this._status = 'resolving';
    this._executeStep().catch(err => {
      console.error('[ExecutorEngine] Unhandled error in _executeStep (advance):', err);
    });
  }

  /**
   * Skip the current optional step and advance to the next one.
   * Should only be called when element:not_found fired and step.optional is true.
   */
  skipCurrentStep() {
    const step = this._currentStep();
    if (!step) {
      console.warn('[ExecutorEngine] skipCurrentStep() called with no active step');
      return;
    }
    this._emit('step:skipped', { step, reason: 'optional step — element not found' });
    this._stepIndex++;
    if (this._stepIndex >= this._plan.steps.length) {
      this._status = 'complete';
      this._emit('plan:complete', { plan: this._plan, completedAt: Date.now() });
      return;
    }
    this._status = 'resolving';
    this._executeStep().catch(err => {
      console.error('[ExecutorEngine] Unhandled error in _executeStep (skipCurrentStep):', err);
    });
  }

  /**
   * Stop all activity immediately. Tears down listeners, clears highlight.
   * Safe to call in any status, including 'idle'. Idempotent.
   */
  abort() {
    this._teardownListeners();
    this._highlighter.clear();
    this._plan              = null;
    this._activeElement     = null;
    this._preActionSnapshot = null;
    this._status            = 'aborted';
  }

  // ── Query API (read by Validator after user:acted) ────────────────────────

  /** @returns {import('../shared/types/index.js').PlanStep | null} */
  getCurrentStep() { return this._currentStep() ?? null; }

  /** @returns {import('../shared/types/index.js').PageSnapshot | null} */
  getPreActionSnapshot() { return this._preActionSnapshot; }

  /** @returns {import('../shared/types/index.js').ExecutionPlan | null} */
  getPlan() { return this._plan; }

  /** @returns {'idle'|'resolving'|'awaiting'|'complete'|'aborted'} */
  getStatus() { return this._status; }

  /**
   * Subscribe to an executor event.
   * @param {string} event
   * @param {(payload: object) => void} handler
   * @returns {() => void} Unsubscribe function
   */
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
    return () => this._handlers.get(event)?.delete(handler);
  }

  // ── Private — step lifecycle ──────────────────────────────────────────────

  /** @returns {import('../shared/types/index.js').PlanStep | null} */
  _currentStep() {
    if (!this._plan) return null;
    return this._plan.steps[this._stepIndex] ?? null;
  }

  async _executeStep() {
    const step = this._currentStep();
    if (!step) {
      // _stepIndex ran past the end — shouldn't happen via normal flow but guard it.
      this._status = 'complete';
      this._emit('plan:complete', { plan: this._plan, completedAt: Date.now() });
      return;
    }

    // ── 1. Capture pre-action baseline before touching the DOM ────────────
    this._preActionSnapshot = this._captureSnapshot('');

    // ── 2. Resolve target element ─────────────────────────────────────────
    const resolved = await this._resolveElementWithWait(step);

    // abort() may have run while the wait loop was polling — its own null
    // return in that case must not be re-interpreted as a genuine
    // element:not_found, which would overwrite the 'aborted' status/emit a
    // stale event. Mirrors the identical guard already used below, after
    // awaiting highlighter.show().
    if (this._status === 'aborted') return;

    if (!resolved) {
      const reason = `No element matched "${step.targetElement?.text ?? '(no text)'}"`;
      if (step.optional) {
        // Auto-advance optional steps silently
        this._emit('step:skipped', { step, reason });
        this._stepIndex++;
        if (this._stepIndex >= this._plan.steps.length) {
          this._status = 'complete';
          this._emit('plan:complete', { plan: this._plan, completedAt: Date.now() });
        } else {
          return this._executeStep();
        }
      } else {
        this._status = 'idle';
        this._emit('element:not_found', { step, reason, isOptional: false });
      }
      return;
    }

    const allCandidates = [resolved, ...(resolved.alternatives ?? [])];
    let lastFailureReason = `No element matched "${step.targetElement?.text ?? '(no text)'}"`;

    // ── 3–4. Try each ranked candidate in order ───────────────────────────
    // For each: run _selfCheck then highlighter.show(). The first candidate
    // that passes both becomes the active element. Failures silently advance
    // to the next candidate — no event is emitted until all are exhausted.
    for (let _ci = 0; _ci < allCandidates.length; _ci++) {
      const candidate = allCandidates[_ci];
      const { element, score } = candidate;

      // Real-Chrome finding (linear.app, goal "Open Inbox"): `resolved` (the
      // primary) can clear PRIMARY via a candidate that then fails self-check
      // — e.g. an SVG icon-sprite <symbol id="Inbox"> swept in by the generic
      // [id] selector, an exact id match, but zero-size and never rendered.
      // `resolved.alternatives` is DOMMatcher's own ranked list for the SAME
      // target, with no score floor applied here — so the fallback loop could
      // previously walk all the way down to a near-noise score (7, a giant
      // wrapper div whose specificity-decayed text happened to contain
      // "Inbox" among several other sibling labels) and accept it just
      // because it was visible, while the real, correctly-labelled "Inbox"
      // button (score 112) simply hadn't finished rendering yet — a genuine
      // render race that ElementResolutionThreshold.RECOVERY plus the
      // existing _resolveElementWithWait retry exists to handle, but never
      // got the chance to because a low-score-but-visible candidate absorbed
      // the attempt first. Skip candidates below RECOVERY the same as a
      // self-check failure, so a page still finishing its render falls
      // through to a genuine not_found/retry instead of a low-confidence
      // guess.
      if (_ci > 0 && score < ElementResolutionThreshold.RECOVERY) {
        lastFailureReason = `Candidate score ${score} below RECOVERY threshold — skipped as noise`;
        continue;
      }

      // ── [DIAG] Candidate identity ──────────────────────────────────────
      {
        const tag       = element.tagName?.toLowerCase() ?? '?';
        const text      = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50);
        const ariaLabel = element.getAttribute?.('aria-label') ?? '';
        const id        = element.id ?? '';
        const cls       = (typeof element.className === 'string' ? element.className : '').slice(0, 60);
        console.log(
          `[SP:Exec] Candidate ${_ci + 1}/${allCandidates.length} score=${score}` +
          ` <${tag}> id="${id}" class="${cls}"` +
          ` text="${text}" aria-label="${ariaLabel}"`
        );
      }

      // ── 3. Pre-highlight self-check ────────────────────────────────────
      // Element may have been detached, disabled, or hidden by a React/Vue
      // re-render in the microtask(s) between resolution and this check.
      const check = this._selfCheck(element);
      // ── [DIAG] Self-check result ───────────────────────────────────────
      console.log(`[SP:Exec] _selfCheck → ok=${check.ok}${check.ok ? '' : ' reason="' + check.reason + '"'}`);
      if (!check.ok) {
        lastFailureReason = `Self-check failed before highlight: ${check.reason}`;
        continue;
      }

      // ── [DIAG] Pre-show element state ─────────────────────────────────
      {
        let rect = null;
        try { rect = element.getBoundingClientRect?.(); } catch { /* ignore */ }
        console.log(
          `[SP:Exec] pre-show state:` +
          ` connected=${element.isConnected}` +
          ` disabled=${element.disabled ?? element.getAttribute?.('disabled')}` +
          ` aria-disabled="${element.getAttribute?.('aria-disabled') ?? ''}"` +
          (rect ? ` rect={t:${rect.top.toFixed(0)},l:${rect.left.toFixed(0)},b:${rect.bottom.toFixed(0)},r:${rect.right.toFixed(0)},w:${rect.width.toFixed(0)},h:${rect.height.toFixed(0)}}` : ' rect=unavailable')
        );
      }

      this._activeElement = element;

      // ── 4. Highlight the element ───────────────────────────────────────
      const shown = await this._highlighter.show(element, step.description);
      // ── [DIAG] Show result ────────────────────────────────────────────
      console.log(`[SP:Exec] highlighter.show() → ${shown}`);

      // Guard: abort() or a second start() may have changed status during the await.
      if (this._status === 'aborted') return;

      if (!shown) {
        // This candidate is off-screen or detached — try the next one.
        this._activeElement = null;
        lastFailureReason   = `Element resolved (score=${score}) but could not be highlighted — may be off-screen or detached`;
        continue;
      }

      // ── 5. Refresh snapshot with highlighted element in context ────────
      const elementText = this._elementAccessibleText(element);
      this._preActionSnapshot = this._captureSnapshot(elementText);

      // ── 6. Wait for user interaction ───────────────────────────────────
      this._status = 'awaiting';
      this._watchForUserAction(step);
      this._emit('element:ready', { step, element, snapshot: this._preActionSnapshot });
      return;
    }

    // All candidates exhausted — report the last failure reason.
    this._status = 'idle';
    this._emit('element:not_found', {
      step,
      reason:     lastFailureReason,
      isOptional: step.optional ?? false,
    });
  }

  // ── Private — element resolution ──────────────────────────────────────────

  /**
   * Wraps _resolveElement() with a short, bounded wait-and-retry for the case
   * where the target genuinely doesn't exist in the DOM YET — a rendering-
   * timing race, not a matching/scoring problem. Real-Chrome finding
   * (vscode.dev, goal "Get started"): the FIRST resolution attempt ran
   * ~200ms into the task, while the page's own dynamic content (a heavy
   * client-rendered SPA) didn't finish rendering the target until ~2.8s
   * after navigation — a generic "we searched before the page caught up"
   * race that any sufficiently slow-rendering dynamic page can hit, not
   * something specific to vscode.dev's markup or DOMMatcher's scoring.
   * Mirrors the existing post-click URL-poll precedent elsewhere in this
   * file (100ms interval, 2s budget) for the same class of "give a real SPA
   * a moment to catch up" problem, reusing its exact timing rather than
   * inventing a new constant.
   *
   * Only retries when the FIRST attempt found literally nothing — an
   * immediate successful resolution (the overwhelmingly common case) costs
   * nothing extra. A step still unresolved after the full budget reports
   * element:not_found exactly as before. This is one bounded wait inside a
   * single _executeStep() call, not a retry loop across attempts/replans.
   *
   * @param {import('../shared/types/index.js').PlanStep} step
   * @returns {Promise<{ element: Element, score: number, confidence?: number } | null>}
   */
  async _resolveElementWithWait(step) {
    const resolved = this._resolveElement(step);
    if (resolved) return resolved;

    const pollIntervalMs = this._elementResolvePollIntervalMs;
    const maxWaitMs      = this._elementResolveMaxWaitMs;
    let elapsed = 0;
    while (elapsed < maxWaitMs) {
      if (this._status === 'aborted') return null;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      elapsed += pollIntervalMs;
      if (this._status === 'aborted') return null;
      const retry = this._resolveElement(step);
      if (retry) return retry;
    }
    return null;
  }

  /**
   * Try the primary descriptor, then alternatives in order.
   * Returns the first match that clears the score threshold AND the confidence threshold.
   * Confidence is only enforced on the PRIMARY path; alternatives use score only.
   *
   * @param {import('../shared/types/index.js').PlanStep} step
   * @returns {{ element: Element, score: number, confidence?: number } | null}
   */
  _resolveElement(step) {
    if (!step.targetElement) return null;

    console.log('[SP:Target]', {
      text: step.targetElement?.text,
      type: step.targetElement?.type,
      region: step.targetElement?.region,
      alternatives: step.targetElement?.alternatives,
      elementId: step.targetElement?.elementId,
      bbox: step.targetElement?.bbox
    });

    // A resolved element with no accessible name at all (see
    // decision-router.js's _buildPlanFromElement) has an intentionally EMPTY
    // targetElement.text — DOMMatcher's own text-based scoring below can
    // never succeed for it, since no real page element's text will ever
    // equal a blank string (matchElement itself bails out immediately on
    // empty text). When that's the case, resolve directly by the element's
    // own already-known on-page position instead of attempting a text
    // search that cannot succeed. Narrowly scoped to exactly this case — a
    // labeled element (the ordinary/existing case) always has non-empty
    // text and is completely unaffected; this never runs for it.
    if (!step.targetElement.text?.trim() && step.targetElement.elementId && step.targetElement.bbox) {
      const positional = this._resolveElementByPosition(step.targetElement);
      if (positional) return positional;
      // No live element found at that position (e.g. the page changed) —
      // fall through to the normal path below, which will also fail
      // (matchElement bails out on empty text) and surface the existing
      // "No element matched" failure exactly as it already does.
    }

    const primary = this._domMatcher.matchElement(step.targetElement);

    if (primary?.score >= ElementResolutionThreshold.PRIMARY) {
      this._logCandidates(step.targetElement.text, primary.candidates);

      // Confidence is a normalised view of score (score / CONFIDENCE_DIVISOR) — it is
      // NOT an independent signal.  CONFIDENCE=0.40 is equivalent to PRIMARY=60 at the
      // divisor of 150 used in dom-matcher.js.  When score >= PRIMARY (≥60) the confidence
      // threshold is therefore always satisfied by definition — they test the same thing
      // from different angles.  Dropping the primary here and falling to the alternatives
      // loop with a *lower* threshold (RECOVERY=50) was actively counterproductive: it
      // could select a 52-scoring unrelated element over a 60-scoring correct one.
      //
      // Always return the primary when score >= PRIMARY.  The confidence field is kept for
      // observability and future telemetry-driven tuning only.
      return primary;
    }

    // Evaluate ALL alternatives and keep the highest-scoring match above RECOVERY.
    // First-past-the-post here was a real ranking bug: the loop used to return the
    // first alternative to clear the (lower) RECOVERY bar, so an early weak-but-valid
    // alternative could win over a later alternative that resolves the intended
    // element far more strongly. Scoring every alternative and returning the best
    // removes that ordering dependency.
    let best = null;
    for (const altText of (step.targetElement.alternatives ?? [])) {
      if (!altText?.trim()) continue;
      const alt = this._domMatcher.matchElement({ ...step.targetElement, text: altText });
      if (alt?.score >= ElementResolutionThreshold.RECOVERY && (!best || alt.score > best.score)) {
        best = alt;
      }
    }

    return best;
  }

  /**
   * Resolve a target directly by its already-known on-page position, for a
   * step whose element has no accessible name to search the live DOM by
   * (see the caller in _resolveElement). Uses `elementFromPoint` — a
   * standard DOM API, not a new targeting system — at the center of the
   * element's own `bbox`, exactly as PageStateService already captured it
   * via getBoundingClientRect() (the same bbox already used for vision
   * candidate markers). Entirely generic: this has no knowledge of what the
   * element is, what site it's on, or what the goal was — only where it is.
   *
   * `elementId` is not itself used to look anything up here — pageState ids
   * are per-extraction-cycle labels with no live DOM binding of their own —
   * its presence just confirms the step really does carry a page-state-
   * resolved target before this bypasses text matching at all.
   *
   * Returns null (never throws, never guesses) whenever there's nothing
   * live at that position, that position is disabled, or the runtime
   * doesn't support `elementFromPoint` (e.g. these unit tests) — every one
   * of those cases falls back to the caller's existing failure path.
   *
   * @param {object} targetElement
   * @returns {{element:Element, score:number, alternatives:object[], candidates:object[]}|null}
   */
  _resolveElementByPosition(targetElement) {
    const bbox = targetElement?.bbox;
    if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return null;
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;

    let element;
    try {
      element = document.elementFromPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    } catch {
      return null;
    }
    if (!element) return null;
    if (this._domMatcher.isDisabled?.(element)) return null;
    if (typeof this._domMatcher.isVisible === 'function' && !this._domMatcher.isVisible(element)) return null;

    console.log(`[SP:Exec] Resolved by position (no accessible text on target) elementId=${targetElement.elementId} bbox=${JSON.stringify(bbox)} <${element.tagName?.toLowerCase?.() ?? '?'}>`);

    // Synthetic PRIMARY-tier match, same shape _domMatcher.matchElement()
    // returns — score is fixed (this isn't a lexical/structural score, there
    // is nothing to score), set comfortably above ElementResolutionThreshold
    // .PRIMARY so downstream candidate handling treats it as confident.
    return { element, score: 100, alternatives: [], candidates: [] };
  }

  /**
   * Verify the element is still safe to highlight.
   * Called after resolution but before highlighter.show() to catch elements that
   * became detached or disabled between matching and highlighting (React/Vue re-renders).
   *
   * @param {Element} element
   * @returns {{ ok: boolean, reason: string }}
   */
  _selfCheck(element) {
    // isConnected is undefined in test mocks — treat undefined as connected
    if (element.isConnected === false) {
      return { ok: false, reason: 'Element detached from DOM after resolution' };
    }

    if (element.disabled === true || element.getAttribute?.('aria-disabled') === 'true') {
      return { ok: false, reason: 'Element became disabled after resolution' };
    }

    try {
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) {
        return { ok: false, reason: 'Element has zero size — hidden after resolution' };
      }
    } catch { /* non-browser environment — skip size check */ }

    return { ok: true, reason: '' };
  }

  /**
   * Log top-N candidates for debugging when more than one candidate was found.
   *
   * @param {string} targetText
   * @param {Array<{score: number, reason: string, matchType: string}>} candidates
   */
  _logCandidates(targetText, candidates) {
    if (!candidates?.length || candidates.length === 1) return;
    const lines = candidates.map((c, i) =>
      `  [${i + 1}] score=${c.score} type=${c.matchType} — ${c.reason}`
    );
    console.log(`[ExecutorEngine] ${candidates.length} candidates for "${targetText}":\n${lines.join('\n')}`);
  }

  // ── Private — user action detection ──────────────────────────────────────

  /**
   * Register lightweight page-action watchers.
   * All watchers share a single teardown path so only the first trigger fires.
   *
   * @param {import('../shared/types/index.js').PlanStep} step
   */
  _watchForUserAction(step) {
    let fired = false;

    const onUserAction = (trigger, observedValue = null) => {
      if (fired) return;  // prevent double-emission if both click and url_change race
      fired = true;
      this._teardownListeners();
      this._highlighter.clear();
      this._activeElement = null;
      // Status stays 'awaiting' — the orchestrator transitions it after Validation.
      // observedValue carries what the control actually held at completion, so
      // the orchestrator can verify a fill against what was requested rather
      // than inferring success from a DOM change.
      this._emit('user:acted', { step, trigger, observedValue, timestamp: Date.now() });
    };

    // A "fill" step is completed by typing, not by a click. Detect it from either
    // the planner phase or the completion condition.
    const isFillStep = step.phase === 'fill_form' || step.completionCondition === 'input_filled';

    // Document-level click in capture phase: fires before the element's own handlers,
    // so we detect the action even if the element stops propagation or navigates away.
    // For fill steps we IGNORE clicks — clicking into the field just focuses it, and
    // advancing there would skip the step before the user has typed anything. Fill
    // steps advance only on meaningful input/change (below).
    const clickHandler = (e) => {
      if (isFillStep) return;
      if (e.target?.closest?.('#screenpilot-widget')) return; // ignore our own UI
      if (!this._activeElement || !this._activeElement.contains(e.target)) return;
      onUserAction('click');
    };
    document.addEventListener('click', clickHandler, { capture: true });
    this._cleanups.push(() =>
      document.removeEventListener('click', clickHandler, { capture: true })
    );

    // ── fill_form auto-advance ───────────────────────────────────────────
    // Advance the moment a text-like field within the target receives non-empty
    // input — no blur, no Enter, no navigation required. Safety: only text entry
    // (input[type=text|search|email|url|tel|password|number], textarea, or
    // contenteditable) triggers this. Checkboxes, radios, switches/toggles and
    // <select> dropdowns are explicitly excluded so they never auto-complete.
    if (isFillStep) {
      const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
      const isTextLikeField = (el) => {
        if (!el || typeof el.tagName !== 'string') return false;
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea') return true;
        if (el.isContentEditable === true) return true;
        if (tag === 'input') {
          const type = (el.getAttribute?.('type') ?? 'text').toLowerCase();
          return TEXT_INPUT_TYPES.has(type);
        }
        return false;
      };
      const fieldValue = (el) => (el.isContentEditable === true ? (el.textContent ?? '') : (el.value ?? ''));
      let fillIdleTimer = null;

      const handleFieldEvent = (e, eventKind) => {
        // [SP:FILL] diagnostic instrumentation — debug-only, no logic change.
        // Logged unconditionally, before any guard below, so every guard's inputs
        // are visible on every input/change dispatch regardless of which guard
        // (if any) rejects the event.
        console.log("[SP:FILL] activeElement", {
          tag: this._activeElement?.tagName,
          id: this._activeElement?.id,
          className: this._activeElement?.className
        });
        console.log("[SP:FILL] target", {
          tag: e.target?.tagName,
          id: e.target?.id,
          className: e.target?.className
        });
        console.log("[SP:FILL] contains", {
          result: this._activeElement?.contains?.(e.target)
        });
        console.log("[SP:FILL] isTextLikeField", {
          result: isTextLikeField(e.target)
        });
        console.log("[SP:FILL] value", {
          value: fieldValue(e.target)
        });

        if (!this._activeElement) return;
        const field = e.target;
        // The event must originate at (or inside) the highlighted target, and land
        // on a text-like field with meaningful content.
        if (!this._activeElement.contains(field)) return;
        if (!isTextLikeField(field)) return;
        if (fieldValue(field).trim().length === 0) return;

        // A fill is NOT complete just because the field stopped being empty.
        // Firing on the first keystroke captured a partial value ("arti" of
        // "artificial intelligence") and reported the step done, because every
        // later keystroke arrived after the step had already been settled.
        //
        // Two generic completion signals, no site or field knowledge:
        //   - if the step carries a requested value, the field must actually
        //     satisfy it (see valueSatisfies);
        //   - otherwise typing must have come to rest — a 'change' event
        //     (commit/blur) settles immediately, and a plain 'input' waits out
        //     a short quiet period that each further keystroke restarts.
        const requested = (step.targetElement?.value ?? '').trim();
        const settle = (reason) => {
          clearTimeout(fillIdleTimer);
          console.log(`[SP:FILL] USER_ACTION_EMITTED reason=${reason} value="${fieldValue(field)}"`);
          onUserAction('input', fieldValue(field));
        };

        if (requested) {
          if (valueSatisfies(fieldValue(field), requested)) settle('requested_value_present');
          // Otherwise keep waiting: the user is still typing it.
          return;
        }

        if (eventKind === 'change') { settle('change_committed'); return; }
        clearTimeout(fillIdleTimer);
        fillIdleTimer = setTimeout(() => settle('typing_idle'), this._fillIdleMs);
      };
      const inputHandler  = (e) => handleFieldEvent(e, 'input');
      const changeHandler = (e) => handleFieldEvent(e, 'change');
      document.addEventListener('input',  inputHandler,  { capture: true });
      document.addEventListener('change', changeHandler, { capture: true });
      this._cleanups.push(() => {
        clearTimeout(fillIdleTimer);
        document.removeEventListener('input',  inputHandler,  { capture: true });
        document.removeEventListener('change', changeHandler, { capture: true });
      });
    }

    // ── SPA navigation detection ─────────────────────────────────────────
    // Modern SPAs (React Router, Vue Router, Next.js, etc.) navigate via
    // history.pushState / history.replaceState.  Neither fires 'popstate'.
    // We patch both methods for the lifetime of this watcher and restore them
    // on teardown.  The patch is scoped to the watcher — not a permanent global
    // override — so concurrent ScreenPilot instances (rare but possible during
    // testing) don't stack patches on each other.

    // Safe accessor: window.location is undefined in Node.js test environments.
    const getHref = () => {
      try { return window.location?.href ?? ''; } catch { return ''; }
    };

    const urlBeforeAction = getHref();

    const urlChangeHandler = (newUrl) => {
      // Apply the same guard as the legacy popstate/hashchange path.
      if (step.expectedOutcome !== undefined) {
        if (!step.expectedOutcome.urlChanges) return;
        const pattern = step.expectedOutcome.urlPattern;
        if (pattern) {
          try {
            const { pathname, hash } = new URL(newUrl);
            if (!pathname.includes(pattern) && !hash.includes(pattern)) return;
          } catch {
            return;
          }
        }
      } else if (step.expectedPageState !== undefined) {
        // v2 steps use expectedPageState instead of expectedOutcome
        if (!step.expectedPageState.urlChanges) return;
        const pattern = step.expectedPageState.urlPattern;
        if (pattern) {
          try {
            const { pathname, hash } = new URL(newUrl);
            if (!pathname.includes(pattern) && !hash.includes(pattern)) return;
          } catch {
            return;
          }
        }
      }
      onUserAction('url_change');
    };

    // Wrap pushState / replaceState only when the browser history API is available.
    // In Node.js test environments, 'history' is not defined — guard it so tests
    // don't crash.  The actual watcher still works in browsers.
    let originalPushState    = null;
    let originalReplaceState = null;

    if (typeof history !== 'undefined' && history?.pushState) {
      originalPushState    = history.pushState.bind(history);
      originalReplaceState = history.replaceState.bind(history);

      history.pushState = function (...args) {
        originalPushState(...args);
        // args[2] is the new URL; fall back to current href if absent/null
        const nextUrl = args[2] ? String(args[2]) : getHref();
        urlChangeHandler(nextUrl);
      };
      history.replaceState = function (...args) {
        originalReplaceState(...args);
        const nextUrl = args[2] ? String(args[2]) : getHref();
        urlChangeHandler(nextUrl);
      };
    }

    this._cleanups.push(() => {
      if (originalPushState)    history.pushState    = originalPushState;
      if (originalReplaceState) history.replaceState = originalReplaceState;
    });

    // Legacy hash / popstate listeners — still needed for sites that use them
    const legacyUrlChangeHandler = () => urlChangeHandler(getHref());
    window.addEventListener('popstate',   legacyUrlChangeHandler);
    window.addEventListener('hashchange', legacyUrlChangeHandler);
    this._cleanups.push(() => {
      window.removeEventListener('popstate',   legacyUrlChangeHandler);
      window.removeEventListener('hashchange', legacyUrlChangeHandler);
    });

    // Post-click URL poll — safety net for SPAs that defer navigation via
    // setTimeout / microtask after the click handler returns (e.g. form submit
    // handlers that call router.push inside a Promise chain).  Only runs after
    // a click on the target element has been detected, polls for up to 2 s.
    let pollInterval = null;
    const startUrlPoll = () => {
      if (pollInterval) return; // already polling
      let elapsed = 0;
      pollInterval = setInterval(() => {
        elapsed += 100;
        const currentHref = getHref();
        if (currentHref && currentHref !== urlBeforeAction) {
          urlChangeHandler(currentHref);
        }
        if (fired || elapsed >= 2000) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      }, 100);
    };

    const clickForPollHandler = (e) => {
      if (e.target?.closest?.('#screenpilot-widget')) return;
      if (!this._activeElement || !this._activeElement.contains(e.target)) return;
      startUrlPoll();
    };
    document.addEventListener('click', clickForPollHandler, { capture: true });
    this._cleanups.push(() => {
      document.removeEventListener('click', clickForPollHandler, { capture: true });
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    });
  }

  // ── Private — utilities ───────────────────────────────────────────────────

  _teardownListeners() {
    for (const cleanup of this._cleanups) {
      try { cleanup(); } catch { /* listener already removed — ignore */ }
    }
    this._cleanups = [];
  }

  _elementAccessibleText(el) {
    return (
      el.getAttribute?.('aria-label')  ||
      el.innerText?.trim()              ||
      el.getAttribute?.('placeholder') ||
      el.getAttribute?.('title')        ||
      ''
    );
  }

  _emit(event, payload) {
    const handlers = this._handlers.get(event);
    if (!handlers?.size) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        // Isolate handler errors — one bad subscriber must not break others.
        console.error(`[ExecutorEngine] Uncaught error in "${event}" handler:`, err);
      }
    }
  }
}
