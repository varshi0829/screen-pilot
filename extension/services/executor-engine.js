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

    const allCandidates = [resolved, ...(resolved.alternatives ?? [])];
    let lastFailureReason = `No element matched "${step.targetElement?.text ?? '(no text)'}"`;

    // ── 3–4. Try each ranked candidate in order ───────────────────────────
    // For each: run _selfCheck then highlighter.show(). The first candidate
    // that passes both becomes the active element. Failures silently advance
    // to the next candidate — no event is emitted until all are exhausted.
    for (let _ci = 0; _ci < allCandidates.length; _ci++) {
      const candidate = allCandidates[_ci];
      const { element, score } = candidate;

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
   * Try the primary descriptor, then alternatives in order.
   * Returns the first match that clears the score threshold AND the confidence threshold.
   * Confidence is only enforced on the PRIMARY path; alternatives use score only.
   *
   * @param {import('../shared/types/index.js').PlanStep} step
   * @returns {{ element: Element, score: number, confidence?: number } | null}
   */
  _resolveElement(step) {
    if (!step.targetElement) return null;

    const primary = this._domMatcher.matchElement(step.targetElement);

    if (primary?.score >= ElementResolutionThreshold.PRIMARY) {
      this._logCandidates(step.targetElement.text, primary.candidates);

      // Confidence is normalised score / divisor — not an independent signal.
      // CONFIDENCE=0.40 is equivalent to PRIMARY=60 at divisor=150. Raise only with data.
      // ?? 1: missing confidence field (test mocks, old matchElement builds) → always passes.
      const conf = primary.confidence ?? 1;
      if (conf >= ElementResolutionThreshold.CONFIDENCE) return primary;

      console.warn(
        `[ExecutorEngine] Low-confidence primary match (${conf.toFixed(2)}) for ` +
        `"${step.targetElement.text}" — score ${primary.score}, reason: ${primary.reason} — trying alternatives`
      );
    }

    for (const altText of (step.targetElement.alternatives ?? [])) {
      if (!altText?.trim()) continue;
      const alt = this._domMatcher.matchElement({ ...step.targetElement, text: altText });
      if (alt?.score >= ElementResolutionThreshold.RECOVERY) return alt;
    }

    return null;
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
      if (!this._activeElement || !this._activeElement.contains(e.target)) return;
      onUserAction('click');
    };
    document.addEventListener('click', clickHandler, { capture: true });
    this._cleanups.push(() =>
      document.removeEventListener('click', clickHandler, { capture: true })
    );

    // URL-change events cover SPA pushState and hash navigation.
    // For v3 steps that declare expectedOutcome, only fire when the URL moved
    // toward the expected destination. This prevents browser Back (popstate)
    // from being treated as a successful step completion, which would silently
    // corrupt session history.
    // v1 steps without expectedOutcome skip the guard and behave as before.
    const urlChangeHandler = () => {
      if (step.expectedOutcome !== undefined) {
        if (!step.expectedOutcome.urlChanges) return;
        const pattern = step.expectedOutcome.urlPattern;
        if (pattern) {
          try {
            const { pathname, hash } = new URL(window.location.href);
            if (!pathname.includes(pattern) && !hash.includes(pattern)) return;
          } catch {
            return;
          }
        }
      }
      onUserAction('url_change');
    };
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
