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
  constructor({ domMatcher, highlighter, captureSnapshot = capturePageSnapshot } = {}) {
    if (!domMatcher)  throw new TypeError('ExecutorEngine: domMatcher is required');
    if (!highlighter) throw new TypeError('ExecutorEngine: highlighter is required');

    this._domMatcher      = domMatcher;
    this._highlighter     = highlighter;
    this._captureSnapshot = captureSnapshot;

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
    const resolved = this._resolveElement(step);

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

    const { element, score } = resolved;
    this._activeElement = element;

    // ── 3. Highlight the element ──────────────────────────────────────────
    const shown = await this._highlighter.show(element, step.description);

    // Guard: abort() or a second start() may have changed status during the await.
    if (this._status === 'aborted') return;

    if (!shown) {
      // Element resolved but became off-screen or detached before rendering.
      this._activeElement = null;
      this._status        = 'idle';
      this._emit('element:not_found', {
        step,
        reason:     `Element resolved (score=${score}) but could not be highlighted — may be off-screen or detached`,
        isOptional: step.optional ?? false,
      });
      return;
    }

    // ── 4. Refresh snapshot with highlighted element in context ───────────
    const elementText = this._elementAccessibleText(element);
    this._preActionSnapshot = this._captureSnapshot(elementText);

    // ── 5. Wait for user interaction ──────────────────────────────────────
    this._status = 'awaiting';
    this._watchForUserAction(step);
    this._emit('element:ready', { step, element, snapshot: this._preActionSnapshot });
  }

  // ── Private — element resolution ──────────────────────────────────────────

  /**
   * Try the primary descriptor, then alternatives in order.
   * Returns the first match that clears the minimum score threshold.
   *
   * @param {import('../shared/types/index.js').PlanStep} step
   * @returns {{ element: Element, score: number } | null}
   */
  _resolveElement(step) {
    if (!step.targetElement) return null;

    const primary = this._domMatcher.matchElement(step.targetElement);
    if (primary?.score >= ElementResolutionThreshold.PRIMARY) return primary;

    for (const altText of (step.targetElement.alternatives ?? [])) {
      if (!altText?.trim()) continue;
      const alt = this._domMatcher.matchElement({ ...step.targetElement, text: altText });
      if (alt?.score >= ElementResolutionThreshold.RECOVERY) return alt;
    }

    return null;
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

    const onUserAction = (trigger) => {
      if (fired) return;  // prevent double-emission if both click and url_change race
      fired = true;
      this._teardownListeners();
      this._highlighter.clear();
      this._activeElement = null;
      // Status stays 'awaiting' — the orchestrator transitions it after Validation.
      this._emit('user:acted', { step, trigger, timestamp: Date.now() });
    };

    // Document-level click in capture phase: fires before the element's own handlers,
    // so we detect the action even if the element stops propagation or navigates away.
    const clickHandler = (e) => {
      if (e.target?.closest?.('#screenpilot-widget')) return; // ignore our own UI
      onUserAction('click');
    };
    document.addEventListener('click', clickHandler, { capture: true });
    this._cleanups.push(() =>
      document.removeEventListener('click', clickHandler, { capture: true })
    );

    // URL-change events cover SPA pushState, back/forward, and hash navigation.
    const urlChangeHandler = () => onUserAction('url_change');
    window.addEventListener('popstate',   urlChangeHandler);
    window.addEventListener('hashchange', urlChangeHandler);
    this._cleanups.push(() => {
      window.removeEventListener('popstate',   urlChangeHandler);
      window.removeEventListener('hashchange', urlChangeHandler);
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
