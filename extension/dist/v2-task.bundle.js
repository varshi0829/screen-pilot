"use strict";
(() => {
  // extension/lib/page-snapshot.js
  function capturePageSnapshot(highlightedElementText = "") {
    return {
      url: window.location.href,
      title: document.title,
      domHash: _computeDomHash(),
      highlightedElementText: String(highlightedElementText),
      capturedAt: Date.now()
    };
  }
  function _computeDomHash() {
    const els = document.querySelectorAll(
      'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
    );
    let fingerprint = "";
    let count = 0;
    for (const el of els) {
      if (!_isVisible(el)) continue;
      const text = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || "").trim().slice(0, 20);
      fingerprint += `${text}|`;
      if (++count >= 200) break;
    }
    return _fnv32a(fingerprint);
  }
  function _isVisible(el) {
    if (el.offsetParent === null && el.tagName !== "BODY") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function _fnv32a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = hash * 16777619 >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  // extension/shared/types/index.js
  var ElementType = Object.freeze({
    BUTTON: "button",
    LINK: "link",
    INPUT: "input",
    MENU: "menu",
    ANY: "any"
  });
  var GoalType = Object.freeze({
    NAVIGATION: "navigation",
    ACTION: "action",
    MIXED: "mixed"
  });
  var CompletionCondition = Object.freeze({
    URL_CHANGE: "url_change",
    DOM_CHANGE: "dom_change",
    INPUT_FILLED: "input_filled",
    ELEMENT_DISAPPEARS: "element_disappears",
    FINAL: "final"
  });
  var SuccessSignalType = Object.freeze({
    URL_MATCHES: "url_matches",
    // location matches urlPattern (post-action)
    URL_LEAVES: "url_leaves",
    // location no longer matches urlPattern (left the form)
    TEXT_PRESENT: "text_present",
    // visible page text contains `text` (e.g. "New key added")
    ELEMENT_PRESENT: "element_present",
    // a control/label with accessible `text` exists (e.g. key row)
    ELEMENT_ABSENT: "element_absent"
    // element_disappears (e.g. creation form closed)
  });
  var VerificationStrategy = Object.freeze({
    LOCAL_SIGNALS: "local_signals",
    // signals alone decide (navigation goals)
    HYBRID: "hybrid",
    // local first; if ambiguous, one AI-confirm turn
    AI_CONFIRM: "ai_confirm"
    // always confirm via a post-action planner turn
  });
  var StepStatus = Object.freeze({
    PENDING: "pending",
    EXECUTING: "executing",
    COMPLETE: "complete",
    SKIPPED: "skipped",
    FAILED: "failed"
  });
  var ValidationRecommendation = Object.freeze({
    ADVANCE: "ADVANCE",
    WAIT: "WAIT",
    RECOVER: "RECOVER"
  });
  var ValidationThreshold = Object.freeze({
    ADVANCE: 0.55,
    WAIT: 0.25,
    WINDOW_MS: 2500
  });
  var SignalWeight = Object.freeze({
    URL_CHANGED: 0.35,
    URL_MATCHES_EXPECTED: 0.3,
    URL_WRONG_DESTINATION: -0.15,
    TARGET_ELEMENT_GONE: 0.2,
    DOM_SIGNATURE_CHANGED: 0.12,
    TITLE_CHANGED: 0.08,
    COMPLETION_CONDITION_MET: 0.25,
    INPUT_FILLED: 0.3
  });
  var RecoveryTrigger = Object.freeze({
    ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
    LOW_VALIDATION: "LOW_VALIDATION",
    UNEXPECTED_NAVIGATION: "UNEXPECTED_NAVIGATION",
    USER_REQUESTED: "USER_REQUESTED",
    TIMEOUT: "TIMEOUT",
    QUOTA_ERROR: "QUOTA_ERROR",
    PRECONDITION_FAILED: "PRECONDITION_FAILED"
  });
  var RecoveryStrategy = Object.freeze({
    STEP_CORRECT: "STEP_CORRECT",
    REPLAN: "REPLAN",
    CONFIRM_COMPLETE: "CONFIRM_COMPLETE",
    WAIT_AND_RETRY: "WAIT_AND_RETRY",
    SKIP_STEP: "SKIP_STEP",
    ABORT: "ABORT"
  });
  var ElementResolutionThreshold = Object.freeze({
    PRIMARY: 60,
    RECOVERY: 50,
    REGION: 50,
    CONFIDENCE: 0.4
    // normalized 0–1; only enforced on PRIMARY path (≡ score≥60 at divisor=150)
  });

  // extension/services/executor-engine.js
  var ExecutorEngine = class {
    /**
     * @param {object} deps
     * @param {{ matchElement(descriptor: object): object | null }} deps.domMatcher
     * @param {{ show(element: Element, text: string): Promise<boolean>, clear(): void }} deps.highlighter
     * @param {() => object} [deps.captureSnapshot]
     */
    constructor({
      domMatcher,
      highlighter,
      captureSnapshot = capturePageSnapshot,
      // Bounded wait-and-retry budget for _resolveElementWithWait (see its own
      // doc comment) — configurable so tests can use a short budget instead of
      // the real 2s one. Defaults mirror the existing post-click URL-poll
      // precedent elsewhere in this file (100ms interval, 2s budget).
      elementResolvePollIntervalMs = 100,
      elementResolveMaxWaitMs = 2e3
    } = {}) {
      if (!domMatcher) throw new TypeError("ExecutorEngine: domMatcher is required");
      if (!highlighter) throw new TypeError("ExecutorEngine: highlighter is required");
      this._domMatcher = domMatcher;
      this._highlighter = highlighter;
      this._captureSnapshot = captureSnapshot;
      this._elementResolvePollIntervalMs = elementResolvePollIntervalMs;
      this._elementResolveMaxWaitMs = elementResolveMaxWaitMs;
      this._plan = null;
      this._stepIndex = 0;
      this._status = "idle";
      this._preActionSnapshot = null;
      this._activeElement = null;
      this._cleanups = [];
      this._handlers = /* @__PURE__ */ new Map();
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
      if (this._status === "resolving" || this._status === "awaiting") {
        throw new Error(
          `ExecutorEngine.start() called while status is "${this._status}". Call abort() first to stop the current plan.`
        );
      }
      if (!plan?.steps?.length) {
        this._plan = plan ?? null;
        this._status = "complete";
        this._emit("plan:complete", { plan: plan ?? { steps: [] }, completedAt: Date.now() });
        return;
      }
      this._plan = plan;
      this._stepIndex = plan.currentStepIndex ?? 0;
      this._status = "resolving";
      this._executeStep().catch((err) => {
        console.error("[ExecutorEngine] Unhandled error in _executeStep:", err);
      });
    }
    /**
     * Advance to the next step.
     * Called by the orchestrator after VALIDATION_PASSED.
     * Ignored (with a warning) if status is not 'awaiting'.
     */
    advance() {
      if (this._status !== "awaiting") {
        console.warn(`[ExecutorEngine] advance() called in status "${this._status}" \u2014 ignoring`);
        return;
      }
      this._stepIndex++;
      if (this._stepIndex >= this._plan.steps.length) {
        this._status = "complete";
        this._emit("plan:complete", { plan: this._plan, completedAt: Date.now() });
        return;
      }
      this._status = "resolving";
      this._executeStep().catch((err) => {
        console.error("[ExecutorEngine] Unhandled error in _executeStep (advance):", err);
      });
    }
    /**
     * Skip the current optional step and advance to the next one.
     * Should only be called when element:not_found fired and step.optional is true.
     */
    skipCurrentStep() {
      const step = this._currentStep();
      if (!step) {
        console.warn("[ExecutorEngine] skipCurrentStep() called with no active step");
        return;
      }
      this._emit("step:skipped", { step, reason: "optional step \u2014 element not found" });
      this._stepIndex++;
      if (this._stepIndex >= this._plan.steps.length) {
        this._status = "complete";
        this._emit("plan:complete", { plan: this._plan, completedAt: Date.now() });
        return;
      }
      this._status = "resolving";
      this._executeStep().catch((err) => {
        console.error("[ExecutorEngine] Unhandled error in _executeStep (skipCurrentStep):", err);
      });
    }
    /**
     * Stop all activity immediately. Tears down listeners, clears highlight.
     * Safe to call in any status, including 'idle'. Idempotent.
     */
    abort() {
      this._teardownListeners();
      this._highlighter.clear();
      this._plan = null;
      this._activeElement = null;
      this._preActionSnapshot = null;
      this._status = "aborted";
    }
    // ── Query API (read by Validator after user:acted) ────────────────────────
    /** @returns {import('../shared/types/index.js').PlanStep | null} */
    getCurrentStep() {
      return this._currentStep() ?? null;
    }
    /** @returns {import('../shared/types/index.js').PageSnapshot | null} */
    getPreActionSnapshot() {
      return this._preActionSnapshot;
    }
    /** @returns {import('../shared/types/index.js').ExecutionPlan | null} */
    getPlan() {
      return this._plan;
    }
    /** @returns {'idle'|'resolving'|'awaiting'|'complete'|'aborted'} */
    getStatus() {
      return this._status;
    }
    /**
     * Subscribe to an executor event.
     * @param {string} event
     * @param {(payload: object) => void} handler
     * @returns {() => void} Unsubscribe function
     */
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, /* @__PURE__ */ new Set());
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
        this._status = "complete";
        this._emit("plan:complete", { plan: this._plan, completedAt: Date.now() });
        return;
      }
      this._preActionSnapshot = this._captureSnapshot("");
      const resolved = await this._resolveElementWithWait(step);
      if (this._status === "aborted") return;
      if (!resolved) {
        const reason = `No element matched "${step.targetElement?.text ?? "(no text)"}"`;
        if (step.optional) {
          this._emit("step:skipped", { step, reason });
          this._stepIndex++;
          if (this._stepIndex >= this._plan.steps.length) {
            this._status = "complete";
            this._emit("plan:complete", { plan: this._plan, completedAt: Date.now() });
          } else {
            return this._executeStep();
          }
        } else {
          this._status = "idle";
          this._emit("element:not_found", { step, reason, isOptional: false });
        }
        return;
      }
      const allCandidates = [resolved, ...resolved.alternatives ?? []];
      let lastFailureReason = `No element matched "${step.targetElement?.text ?? "(no text)"}"`;
      for (let _ci = 0; _ci < allCandidates.length; _ci++) {
        const candidate = allCandidates[_ci];
        const { element, score } = candidate;
        if (_ci > 0 && score < ElementResolutionThreshold.RECOVERY) {
          lastFailureReason = `Candidate score ${score} below RECOVERY threshold \u2014 skipped as noise`;
          continue;
        }
        {
          const tag = element.tagName?.toLowerCase() ?? "?";
          const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
          const ariaLabel = element.getAttribute?.("aria-label") ?? "";
          const id = element.id ?? "";
          const cls = (typeof element.className === "string" ? element.className : "").slice(0, 60);
          console.log(
            `[SP:Exec] Candidate ${_ci + 1}/${allCandidates.length} score=${score} <${tag}> id="${id}" class="${cls}" text="${text}" aria-label="${ariaLabel}"`
          );
        }
        const check = this._selfCheck(element);
        console.log(`[SP:Exec] _selfCheck \u2192 ok=${check.ok}${check.ok ? "" : ' reason="' + check.reason + '"'}`);
        if (!check.ok) {
          lastFailureReason = `Self-check failed before highlight: ${check.reason}`;
          continue;
        }
        {
          let rect = null;
          try {
            rect = element.getBoundingClientRect?.();
          } catch {
          }
          console.log(
            `[SP:Exec] pre-show state: connected=${element.isConnected} disabled=${element.disabled ?? element.getAttribute?.("disabled")} aria-disabled="${element.getAttribute?.("aria-disabled") ?? ""}"` + (rect ? ` rect={t:${rect.top.toFixed(0)},l:${rect.left.toFixed(0)},b:${rect.bottom.toFixed(0)},r:${rect.right.toFixed(0)},w:${rect.width.toFixed(0)},h:${rect.height.toFixed(0)}}` : " rect=unavailable")
          );
        }
        this._activeElement = element;
        const shown = await this._highlighter.show(element, step.description);
        console.log(`[SP:Exec] highlighter.show() \u2192 ${shown}`);
        if (this._status === "aborted") return;
        if (!shown) {
          this._activeElement = null;
          lastFailureReason = `Element resolved (score=${score}) but could not be highlighted \u2014 may be off-screen or detached`;
          continue;
        }
        const elementText = this._elementAccessibleText(element);
        this._preActionSnapshot = this._captureSnapshot(elementText);
        this._status = "awaiting";
        this._watchForUserAction(step);
        this._emit("element:ready", { step, element, snapshot: this._preActionSnapshot });
        return;
      }
      this._status = "idle";
      this._emit("element:not_found", {
        step,
        reason: lastFailureReason,
        isOptional: step.optional ?? false
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
      const maxWaitMs = this._elementResolveMaxWaitMs;
      let elapsed = 0;
      while (elapsed < maxWaitMs) {
        if (this._status === "aborted") return null;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        elapsed += pollIntervalMs;
        if (this._status === "aborted") return null;
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
      console.log("[SP:Target]", {
        text: step.targetElement?.text,
        type: step.targetElement?.type,
        region: step.targetElement?.region,
        alternatives: step.targetElement?.alternatives
      });
      const primary = this._domMatcher.matchElement(step.targetElement);
      if (primary?.score >= ElementResolutionThreshold.PRIMARY) {
        this._logCandidates(step.targetElement.text, primary.candidates);
        return primary;
      }
      let best = null;
      for (const altText of step.targetElement.alternatives ?? []) {
        if (!altText?.trim()) continue;
        const alt = this._domMatcher.matchElement({ ...step.targetElement, text: altText });
        if (alt?.score >= ElementResolutionThreshold.RECOVERY && (!best || alt.score > best.score)) {
          best = alt;
        }
      }
      return best;
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
      if (element.isConnected === false) {
        return { ok: false, reason: "Element detached from DOM after resolution" };
      }
      if (element.disabled === true || element.getAttribute?.("aria-disabled") === "true") {
        return { ok: false, reason: "Element became disabled after resolution" };
      }
      try {
        const rect = element.getBoundingClientRect?.();
        if (rect && rect.width === 0 && rect.height === 0) {
          return { ok: false, reason: "Element has zero size \u2014 hidden after resolution" };
        }
      } catch {
      }
      return { ok: true, reason: "" };
    }
    /**
     * Log top-N candidates for debugging when more than one candidate was found.
     *
     * @param {string} targetText
     * @param {Array<{score: number, reason: string, matchType: string}>} candidates
     */
    _logCandidates(targetText, candidates) {
      if (!candidates?.length || candidates.length === 1) return;
      const lines = candidates.map(
        (c, i) => `  [${i + 1}] score=${c.score} type=${c.matchType} \u2014 ${c.reason}`
      );
      console.log(`[ExecutorEngine] ${candidates.length} candidates for "${targetText}":
${lines.join("\n")}`);
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
        if (fired) return;
        fired = true;
        this._teardownListeners();
        this._highlighter.clear();
        this._activeElement = null;
        this._emit("user:acted", { step, trigger, timestamp: Date.now() });
      };
      const isFillStep = step.phase === "fill_form" || step.completionCondition === "input_filled";
      const clickHandler = (e) => {
        if (isFillStep) return;
        if (e.target?.closest?.("#screenpilot-widget")) return;
        if (!this._activeElement || !this._activeElement.contains(e.target)) return;
        onUserAction("click");
      };
      document.addEventListener("click", clickHandler, { capture: true });
      this._cleanups.push(
        () => document.removeEventListener("click", clickHandler, { capture: true })
      );
      if (isFillStep) {
        const TEXT_INPUT_TYPES = /* @__PURE__ */ new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);
        const isTextLikeField = (el) => {
          if (!el || typeof el.tagName !== "string") return false;
          const tag = el.tagName.toLowerCase();
          if (tag === "textarea") return true;
          if (el.isContentEditable === true) return true;
          if (tag === "input") {
            const type = (el.getAttribute?.("type") ?? "text").toLowerCase();
            return TEXT_INPUT_TYPES.has(type);
          }
          return false;
        };
        const fieldValue = (el) => el.isContentEditable === true ? el.textContent ?? "" : el.value ?? "";
        const inputHandler = (e) => {
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
          if (!this._activeElement.contains(field)) return;
          if (!isTextLikeField(field)) return;
          if (fieldValue(field).trim().length === 0) return;
          console.log("[SP:FILL] USER_ACTION_EMITTED");
          onUserAction("input");
        };
        document.addEventListener("input", inputHandler, { capture: true });
        document.addEventListener("change", inputHandler, { capture: true });
        this._cleanups.push(() => {
          document.removeEventListener("input", inputHandler, { capture: true });
          document.removeEventListener("change", inputHandler, { capture: true });
        });
      }
      const getHref = () => {
        try {
          return window.location?.href ?? "";
        } catch {
          return "";
        }
      };
      const urlBeforeAction = getHref();
      const urlChangeHandler = (newUrl) => {
        if (step.expectedOutcome !== void 0) {
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
        } else if (step.expectedPageState !== void 0) {
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
        onUserAction("url_change");
      };
      let originalPushState = null;
      let originalReplaceState = null;
      if (typeof history !== "undefined" && history?.pushState) {
        originalPushState = history.pushState.bind(history);
        originalReplaceState = history.replaceState.bind(history);
        history.pushState = function(...args) {
          originalPushState(...args);
          const nextUrl = args[2] ? String(args[2]) : getHref();
          urlChangeHandler(nextUrl);
        };
        history.replaceState = function(...args) {
          originalReplaceState(...args);
          const nextUrl = args[2] ? String(args[2]) : getHref();
          urlChangeHandler(nextUrl);
        };
      }
      this._cleanups.push(() => {
        if (originalPushState) history.pushState = originalPushState;
        if (originalReplaceState) history.replaceState = originalReplaceState;
      });
      const legacyUrlChangeHandler = () => urlChangeHandler(getHref());
      window.addEventListener("popstate", legacyUrlChangeHandler);
      window.addEventListener("hashchange", legacyUrlChangeHandler);
      this._cleanups.push(() => {
        window.removeEventListener("popstate", legacyUrlChangeHandler);
        window.removeEventListener("hashchange", legacyUrlChangeHandler);
      });
      let pollInterval = null;
      const startUrlPoll = () => {
        if (pollInterval) return;
        let elapsed = 0;
        pollInterval = setInterval(() => {
          elapsed += 100;
          const currentHref = getHref();
          if (currentHref && currentHref !== urlBeforeAction) {
            urlChangeHandler(currentHref);
          }
          if (fired || elapsed >= 2e3) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        }, 100);
      };
      const clickForPollHandler = (e) => {
        if (e.target?.closest?.("#screenpilot-widget")) return;
        if (!this._activeElement || !this._activeElement.contains(e.target)) return;
        startUrlPoll();
      };
      document.addEventListener("click", clickForPollHandler, { capture: true });
      this._cleanups.push(() => {
        document.removeEventListener("click", clickForPollHandler, { capture: true });
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      });
    }
    // ── Private — utilities ───────────────────────────────────────────────────
    _teardownListeners() {
      for (const cleanup of this._cleanups) {
        try {
          cleanup();
        } catch {
        }
      }
      this._cleanups = [];
    }
    _elementAccessibleText(el) {
      return el.getAttribute?.("aria-label") || el.innerText?.trim() || el.getAttribute?.("placeholder") || el.getAttribute?.("title") || "";
    }
    _emit(event, payload) {
      const handlers = this._handlers.get(event);
      if (!handlers?.size) return;
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[ExecutorEngine] Uncaught error in "${event}" handler:`, err);
        }
      }
    }
  };

  // extension/providers/interface.js
  var BackendAdapter = class {
    /**
     * Unique identifier for this adapter (used in telemetry and logs).
     * @returns {string}
     */
    get name() {
      return "BackendAdapter";
    }
    /**
     * Plan a full workflow from a goal and current page context.
     * Makes a POST /api/plan request to the backend.
     *
     * The backend runs Gemini (or another configured provider) to produce a
     * conditional linear ExecutionPlan with all steps upfront.
     *
     * @param {import('../shared/types/index.js').PlanRequest} request
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] - Optional signal to abort the request
     * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
     */
    async plan(request, options = {}) {
      throw new Error(`${this.name} must implement plan(request, options)`);
    }
    /**
     * Request a corrected step or full replan after execution diverged.
     * Makes a POST /api/recover request to the backend.
     *
     * @param {import('../shared/types/index.js').RecoverRequest} request
     * @returns {Promise<import('../shared/types/index.js').RecoverResponse>}
     */
    async recover() {
      throw new Error(`${this.name} must implement recover(request)`);
    }
    /**
     * Explain what is currently visible on screen.
     * Used for the "Explain" widget button; does not affect plan execution.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, pageContext: object }} request
     * @returns {Promise<{ success: boolean, screenContext?: object, error?: string }>}
     */
    async explain() {
      throw new Error(`${this.name} must implement explain(request)`);
    }
    /**
     * Answer a question about the current screen.
     * Used for the "Ask" widget button; does not affect plan execution.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, question: string, pageContext: object }} request
     * @returns {Promise<{ success: boolean, answer?: string, confidence?: number, elementHint?: string, error?: string }>}
     */
    async ask() {
      throw new Error(`${this.name} must implement ask(request)`);
    }
    /**
     * Estimate the cost of a request before sending it.
     * Used for budget enforcement and telemetry.
     * Must be synchronous — called before the async request is issued.
     *
     * @param {'plan'|'recover'|'explain'|'ask'} operation
     * @param {object} request
     * @returns {{ inputTokens: number, outputTokens: number, estimatedUSD: number }}
     */
    estimateCost() {
      throw new Error(`${this.name} must implement estimateCost(operation, request)`);
    }
    /**
     * Returns true when the adapter can currently accept requests.
     * Implementations should check quota, key validity, and network status.
     *
     * @returns {Promise<{ available: boolean, reason?: string }>}
     */
    async checkAvailability() {
      throw new Error(`${this.name} must implement checkAvailability()`);
    }
  };

  // extension/providers/vercel-backend-adapter.js
  var DEFAULT_BASE_URL = "https://screen-pilot-j1az.vercel.app";
  var USD_PER_INPUT_TOKEN = 25e-8;
  var USD_PER_OUTPUT_TOKEN = 75e-8;
  var VercelBackendAdapter = class extends BackendAdapter {
    /**
     * @param {object} [options]
     * @param {string} [options.baseUrl]    - Backend base URL (defaults to Vercel deployment)
     * @param {string} [options.apiKey]     - User-supplied Gemini key (BYOK); omit to use shared key
     * @param {string} [options.sessionId]  - Session identifier for rate limiting and telemetry
     */
    constructor({ baseUrl = DEFAULT_BASE_URL, apiKey, sessionId } = {}) {
      super();
      this._baseUrl = baseUrl.replace(/\/$/, "");
      this._apiKey = apiKey ?? null;
      this._sessionId = sessionId ?? crypto.randomUUID().slice(0, 16);
    }
    get name() {
      return "VercelBackendAdapter";
    }
    /**
     * Plan a full workflow from a goal and current page context.
     * Calls POST /api/plan and returns a PlanResponse.
     *
     * @param {import('../shared/types/index.js').PlanRequest} request
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
     */
    async plan(request, options = {}) {
      return this._post("/api/plan", request, options);
    }
    /**
     * Request a corrected step or full replan after execution diverged.
     * Calls POST /api/recover and returns a RecoverResponse.
     *
     * @param {import('../shared/types/index.js').RecoverRequest} request
     * @param {object} [options]
     * @returns {Promise<import('../shared/types/index.js').RecoverResponse>}
     */
    async recover(request, options = {}) {
      return this._post("/api/recover", request, options);
    }
    /**
     * Explain what is currently visible on screen.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, pageContext: object }} request
     * @param {object} [options]
     * @returns {Promise<{ success: boolean, screenContext?: object, error?: string }>}
     */
    async explain({ screenshot, pageContext = {} }, options = {}) {
      return this._post("/api/analyze", {
        screenshot,
        pageContext,
        goal: "Explain what is visible on this screen",
        mode: "explain"
      }, options);
    }
    /**
     * Answer a question about the current screen.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, question: string, pageContext: object }} request
     * @param {object} [options]
     * @returns {Promise<{ success: boolean, answer?: string, confidence?: number, elementHint?: string, error?: string }>}
     */
    async ask({ screenshot, question, pageContext = {} }, options = {}) {
      return this._post("/api/analyze", {
        screenshot,
        goal: question,
        pageContext,
        mode: "ask"
      }, options);
    }
    /**
     * Estimate the token cost of a request before sending it.
     * Synchronous — called before the async request is issued.
     *
     * @param {'plan'|'recover'|'explain'|'ask'} operation
     * @param {object} request
     * @returns {{ inputTokens: number, outputTokens: number, estimatedUSD: number }}
     */
    estimateCost(operation, request) {
      const imageBytes = request?.page?.screenshot?.image?.length ?? request?.screenshot?.image?.length ?? 0;
      const imageTokens = Math.ceil(imageBytes / 4);
      const promptTokens = 800;
      const outputTokens = operation === "plan" ? 1500 : 512;
      const inputTokens = imageTokens + promptTokens;
      return {
        inputTokens,
        outputTokens,
        estimatedUSD: inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN
      };
    }
    /**
     * Returns whether this adapter can currently accept requests.
     * A full implementation would ping a /health endpoint or check quota state.
     *
     * @returns {Promise<{ available: boolean, reason?: string }>}
     */
    async checkAvailability() {
      return { available: true };
    }
    // ── Private ─────────────────────────────────────────────────────────────────
    /**
     * Send a POST request to the backend and return the parsed JSON response.
     * Network and HTTP errors are caught and returned as FAILED PlanResponse shapes
     * so callers never need to handle thrown exceptions.
     *
     * @param {string} path
     * @param {object} body
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<object>}
     */
    async _post(path, body, options = {}) {
      const headers = {
        "Content-Type": "application/json",
        "X-Session-ID": this._sessionId
      };
      if (this._apiKey) headers["X-OpenRouter-Key"] = this._apiKey;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3e4);
      const callerSignal = options?.signal;
      if (callerSignal) {
        if (callerSignal.aborted) {
          controller.abort(callerSignal.reason);
        } else {
          callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
        }
      }
      let response;
      try {
        response = await fetch(`${this._baseUrl}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (err) {
        clearTimeout(timeoutId);
        const isCallerAborted = callerSignal?.aborted;
        const isTimeout = err instanceof Error && err.name === "AbortError" && !isCallerAborted;
        const message = isCallerAborted ? `Request to ${path} was aborted` : isTimeout ? `Request to ${path} timed out after 30s` : err instanceof Error ? err.message : String(err);
        const errorCode = isCallerAborted ? "ABORTED" : isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
        console.error(`[VercelBackendAdapter] ${isCallerAborted ? "Aborted" : isTimeout ? "Timeout" : "Network error"} on ${path}:`, message);
        return this._networkFailure(message, errorCode);
      }
      let data;
      try {
        data = await response.json();
      } catch {
        console.error(`[VercelBackendAdapter] Non-JSON response from ${path} (status ${response.status})`);
        return this._networkFailure(`Non-JSON response from ${path}`, "PARSE_ERROR");
      }
      if (!response.ok) {
        const error = data?.error ?? `HTTP ${response.status}`;
        const errorCode = data?.errorCode ?? "HTTP_ERROR";
        console.error(`[VercelBackendAdapter] ${path} \u2192 ${response.status}:`, error);
        return { blockers: [], confidence: 0, ...data, result: "FAILED", error, errorCode };
      }
      return data;
    }
    /**
     * Synthesize a minimal FAILED PlanResponse for network-layer errors.
     * Keeps the shape consistent with what /api/plan returns for provider failures.
     *
     * @param {string} error
     * @param {string} errorCode
     * @returns {object}
     */
    _networkFailure(error, errorCode) {
      return {
        schemaVersion: "1",
        result: "FAILED",
        blockers: [],
        confidence: 0,
        providerMetadata: { provider: "gemini", model: "unknown", plannerVersion: "unknown", latencyMs: 0 },
        error,
        errorCode
      };
    }
  };

  // extension/services/page-state-service.js
  var PageStateService = (() => {
    "use strict";
    function clean(str, maxLen = 80) {
      if (typeof str !== "string") return "";
      return str.replace(/\s+/g, " ").trim().slice(0, maxLen);
    }
    function getRole(el) {
      const ariaRole = el.getAttribute?.("role");
      if (ariaRole) return clean(ariaRole, 30);
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (tag === "button" || tag === "input" && ["button", "submit", "reset"].includes(el.type)) return "button";
      if (tag === "a") return "link";
      if (tag === "input" && ["text", "search", "email", "password", "url", "number", "tel"].includes(el.type || "text")) return "textbox";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) return el.type;
      return tag || "generic";
    }
    function isVisible(el) {
      if (!el) return false;
      if (el.offsetParent === null && el.tagName !== "BODY") return false;
      if (typeof el.getBoundingClientRect === "function") {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      return true;
    }
    function getRegion(el) {
      if (!el || typeof el.closest !== "function") return "main_content";
      if (el.closest('nav, header, [role="banner"], [role="navigation"]')) return "top_navigation";
      if (el.closest('aside, [role="complementary"], [role="navigation"].sidebar, .sidebar')) return "side_navigation";
      if (el.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog')) return "modal";
      if (el.closest('footer, [role="contentinfo"]')) return "footer";
      return "main_content";
    }
    function extractPageState(env = {}) {
      const doc = env.doc ?? (typeof document !== "undefined" ? document : null);
      const loc = env.loc ?? (typeof location !== "undefined" ? location : null);
      const url = loc?.href ?? "";
      const title = doc?.title ?? "";
      const selector = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="textbox"], summary';
      const rawEls = doc && typeof doc.querySelectorAll === "function" ? Array.from(doc.querySelectorAll(selector)) : [];
      const elements = [];
      let count = 0;
      const seen = /* @__PURE__ */ new Set();
      for (const el of rawEls) {
        if (seen.has(el)) continue;
        seen.add(el);
        const visible = isVisible(el);
        if (!visible) continue;
        const tag = el.tagName ? el.tagName.toLowerCase() : "div";
        const role = getRole(el);
        const text = clean(el.innerText || el.textContent || "");
        const placeholder = clean(el.getAttribute?.("placeholder") || "");
        const ariaLabel = clean(el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.querySelector?.("img[alt]")?.getAttribute?.("alt") || "");
        const value = typeof el.value === "string" ? clean(el.value) : "";
        const href = clean(el.getAttribute?.("href") || "", 120);
        const enabled = !el.disabled;
        const region = getRegion(el);
        if (!text && !placeholder && !ariaLabel && !value && !href && role !== "textbox") continue;
        let bbox = null;
        if (typeof el.getBoundingClientRect === "function") {
          const r = el.getBoundingClientRect();
          bbox = { x: Math.round(r.x || r.left || 0), y: Math.round(r.y || r.top || 0), width: Math.round(r.width || 0), height: Math.round(r.height || 0) };
        }
        count += 1;
        const id = `el_${count}`;
        elements.push({
          id,
          role,
          tag,
          text,
          placeholder,
          ariaLabel,
          value,
          href,
          visible,
          enabled,
          region,
          bbox
        });
        if (count >= 300) break;
      }
      return {
        url,
        title,
        elements,
        timestamp: Date.now()
      };
    }
    return { extractPageState, clean, getRole };
  })();
  if (typeof globalThis !== "undefined" && globalThis.module) {
    globalThis.module.exports = PageStateService;
  }

  // extension/services/ui-grounding-service.js
  var UIGroundingService = (() => {
    "use strict";
    function normalize2(str) {
      return typeof str === "string" ? str.replace(/\s+/g, " ").trim().toLowerCase() : "";
    }
    function tokenize(str) {
      const stopWords = /* @__PURE__ */ new Set(["a", "an", "the", "to", "for", "in", "on", "at", "by", "with", "from", "is", "it", "and", "or"]);
      return normalize2(str).replace(/[^\w\s]/g, "").split(/\s+/).filter((t) => t.length > 1 && !stopWords.has(t));
    }
    function scoreElement(intent, el) {
      if (!el || !el.visible || el.enabled === false) return 0;
      const intentTokens = tokenize(intent);
      if (!intentTokens.length) return 0;
      const textTokens = tokenize(el.text || "");
      const placeTokens = tokenize(el.placeholder || "");
      const ariaTokens = tokenize(el.ariaLabel || "");
      const valTokens = tokenize(el.value || "");
      const allElTokens = /* @__PURE__ */ new Set([...textTokens, ...placeTokens, ...ariaTokens, ...valTokens]);
      if (!allElTokens.size) return 0;
      const textMatches = intentTokens.filter((t) => allElTokens.has(t)).length;
      const textScore = textMatches / intentTokens.length;
      const ariaMatches = intentTokens.filter((t) => ariaTokens.includes(t)).length;
      const ariaScore = ariaTokens.length ? ariaMatches / intentTokens.length : textScore;
      let roleScore = 0.5;
      const normIntent = normalize2(intent);
      if (normIntent.includes("click") || normIntent.includes("open") || normIntent.includes("press")) {
        if (["button", "link", "combobox", "tab"].includes(el.role) || el.tag === "button" || el.tag === "a") roleScore = 1;
      } else if (normIntent.includes("type") || normIntent.includes("fill") || normIntent.includes("search") || normIntent.includes("enter")) {
        if (["textbox", "combobox", "search"].includes(el.role) || ["input", "textarea"].includes(el.tag)) roleScore = 1;
      }
      let regionScore = 0.6;
      if (el.region === "top_navigation" || el.region === "side_navigation" || el.region === "modal") regionScore = 1;
      let boost = 0;
      const fullElText = normalize2(`${el.text} ${el.placeholder} ${el.ariaLabel}`);
      if (normIntent && fullElText && (fullElText.includes(normIntent) || normIntent.includes(fullElText))) {
        boost = 1;
      }
      const finalScore = 0.35 * textScore + 0.3 * ariaScore + 0.15 * roleScore + 0.1 * regionScore + 0.1 * boost;
      return Math.min(1, Math.round(finalScore * 100) / 100);
    }
    function rankElements(intent, elements) {
      if (!Array.isArray(elements) || !elements.length) return [];
      const scored = elements.map((el) => ({
        element: el,
        score: scoreElement(intent, el)
      }));
      return scored.filter((item) => item.score > 0.05).sort((a, b) => b.score - a.score);
    }
    return { scoreElement, rankElements, tokenize };
  })();
  if (typeof globalThis !== "undefined" && globalThis.module) {
    globalThis.module.exports = UIGroundingService;
  }

  // extension/providers/local-qwen-adapter.js
  var DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
  var DEFAULT_MODEL = "qwen2.5-coder:7b";
  var DEFAULT_KEEP_ALIVE = "5m";
  var QWEN_GENERATE_TIMEOUT_MS = 15e3;
  var QWEN_AVAILABILITY_TIMEOUT_MS = 2500;
  var LocalQwenAdapter = class extends BackendAdapter {
    /**
     * @param {object} [options]
     * @param {string} [options.ollamaUrl] - Local Ollama server URL (defaults to http://127.0.0.1:11434)
     * @param {string} [options.model]     - Local model name (defaults to qwen2.5-coder:7b)
     * @param {string} [options.keepAlive] - Model warm duration (defaults to "5m")
     */
    constructor({ ollamaUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_MODEL, keepAlive = DEFAULT_KEEP_ALIVE } = {}) {
      super();
      this._ollamaUrl = ollamaUrl.replace(/\/$/, "");
      this._model = model;
      this._keepAlive = keepAlive;
    }
    get name() {
      return "LocalQwenAdapter";
    }
    /**
     * Plan 1 action at a time from a goal and current page state.
     *
     * @param {import('../shared/types/index.js').PlanRequest} request
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
     */
    async plan(request, options = {}) {
      const t0 = Date.now();
      const callerSignal = options?.signal;
      const reqId = request?.requestId || `req_qwen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      console.log(`[SP:V2:DEBUG] controller_id reqId=${reqId}`);
      console.log(`[SP:V2:DEBUG] signal_before_request reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);
      if (callerSignal?.aborted) {
        console.log(`[SP:V2:DEBUG] LocalQwenAdapter callerSignal already aborted reqId=${reqId} reason=${callerSignal.reason}`);
        return this._networkFailure("Request aborted", "ABORTED");
      }
      const prompt = this._buildQwenPrompt(request);
      const targetUrl = `${this._ollamaUrl}/api/generate`;
      const requestBody = {
        model: this._model,
        prompt,
        format: "json",
        stream: false,
        keep_alive: this._keepAlive,
        options: {
          temperature: 0,
          num_predict: 128
        }
      };
      console.log(`[SP:V2:DEBUG] LocalQwenAdapter request start reqId=${reqId} url=${targetUrl} method=POST startMs=${t0} callerAborted=${callerSignal?.aborted ?? false}`);
      console.log(`[SP:V2:DEBUG] signal_start reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);
      console.log(`[SP:V2:DEBUG] request_lifecycle status=start reqId=${reqId}`);
      let data = null;
      let isSuccess = false;
      const hasChromeRuntime = typeof chrome !== "undefined" && chrome?.runtime?.sendMessage;
      if (hasChromeRuntime) {
        try {
          console.log(`[SP:V2:DEBUG] Proxying Ollama request via chrome.runtime.sendMessage(OLLAMA_GENERATE) reqId=${reqId}`);
          let abortHandler = null;
          if (callerSignal) {
            abortHandler = () => {
              console.log(`[SP:V2:DEBUG] callerSignal aborted during proxy call reqId=${reqId} reason=${callerSignal.reason}`);
              try {
                chrome.runtime.sendMessage({ type: "OLLAMA_CANCEL", reqId });
              } catch {
              }
            };
            callerSignal.addEventListener("abort", abortHandler, { once: true });
          }
          const bgResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: "OLLAMA_GENERATE",
              reqId,
              url: targetUrl,
              body: requestBody
            }, (response) => {
              if (callerSignal && abortHandler) {
                callerSignal.removeEventListener("abort", abortHandler);
              }
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(response || { success: false, error: "No response from background script" });
              }
            });
          });
          console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);
          console.log(`[SP:V2:DEBUG] request_lifecycle status=end reqId=${reqId} latencyMs=${Date.now() - t0}`);
          if (!bgResp?.success) {
            console.error(`[SP:V2:DEBUG] Background Ollama proxy failed reqId=${reqId}: ${bgResp?.error}`);
            const errCode = bgResp?.errorCode || (callerSignal?.aborted ? "ABORTED" : "OLLAMA_UNAVAILABLE");
            return this._networkFailure(bgResp?.error || "Background Ollama proxy failed", errCode);
          }
          data = bgResp.data;
          isSuccess = true;
        } catch (proxyErr) {
          console.error(`[SP:V2:DEBUG] Background proxy error reqId=${reqId} name=${proxyErr?.name} message=${proxyErr?.message}`);
        }
      }
      if (!isSuccess) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=qwen_timeout_${QWEN_GENERATE_TIMEOUT_MS}ms`);
          controller.abort(`qwen_timeout_${QWEN_GENERATE_TIMEOUT_MS}ms`);
        }, QWEN_GENERATE_TIMEOUT_MS);
        if (callerSignal) {
          callerSignal.addEventListener("abort", () => {
            console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=${callerSignal.reason}`);
            controller.abort(callerSignal.reason || "caller_aborted");
          }, { once: true });
        }
        let upstream;
        try {
          upstream = await fetch(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
        } catch (err) {
          clearTimeout(timeoutId);
          const elapsedMs = Date.now() - t0;
          const isCallerAborted = callerSignal?.aborted;
          const isTimeout = err instanceof Error && err.name === "AbortError" && !isCallerAborted;
          console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${controller.signal.aborted} reason=${controller.signal.reason}`);
          console.log(`[SP:V2:DEBUG] request_lifecycle status=end reqId=${reqId} elapsedMs=${elapsedMs}`);
          console.error(`[SP:V2:DEBUG] LocalQwenAdapter direct fetch exception reqId=${reqId} url=${targetUrl} name=${err?.name} message=${err?.message} stack=${err?.stack}`);
          const message = isCallerAborted ? "Local Qwen request was aborted" : isTimeout ? "Local Qwen inference timed out" : err instanceof Error ? err.message : String(err);
          const errorCode = isCallerAborted ? "ABORTED" : isTimeout ? "TIMEOUT" : "OLLAMA_UNAVAILABLE";
          return this._networkFailure(message, errorCode);
        }
        if (!upstream.ok) {
          console.error(`[SP:V2:DEBUG] Ollama HTTP status error status=${upstream.status}`);
          return this._networkFailure(`Ollama returned status ${upstream.status}`, "OLLAMA_ERROR");
        }
        data = await upstream.json().catch(() => null);
      }
      const rawResponse = data?.response ?? "";
      const latencyMs = Date.now() - t0;
      console.log(`[SP:V2:PERF] qwenLatencyMs=${latencyMs} model=${this._model} keep_alive=${this._keepAlive}`);
      console.log(`[SP:V2:DEBUG] Ollama response received rawLen=${rawResponse.length} latencyMs=${latencyMs}`);
      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        return this._networkFailure("Local Qwen returned invalid JSON", "PARSE_ERROR");
      }
      return this._formatPlanResponse(request, parsed, latencyMs);
    }
    async recover(request, options = {}) {
      return this.plan(request, options);
    }
    async explain() {
      return { success: true, screenContext: { application: "Web App", pageType: "other" } };
    }
    async ask() {
      return { success: true, answer: "Local Qwen screen analysis complete." };
    }
    estimateCost() {
      return { inputTokens: 0, outputTokens: 0, estimatedUSD: 0 };
    }
    async checkAvailability() {
      const hasChromeRuntime = typeof chrome !== "undefined" && chrome?.runtime?.sendMessage;
      if (hasChromeRuntime) {
        try {
          const proxied = await Promise.race([
            new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: "OLLAMA_CHECK", url: `${this._ollamaUrl}/api/tags` }, (response) => {
                if (chrome.runtime.lastError) resolve({ __proxyFailed: true });
                else resolve(response || { __proxyFailed: true });
              });
            }),
            new Promise((resolve) => setTimeout(() => resolve({ __proxyTimeout: true }), QWEN_AVAILABILITY_TIMEOUT_MS))
          ]);
          if (!proxied.__proxyFailed && !proxied.__proxyTimeout) {
            return proxied.available ? { available: true } : { available: false, reason: proxied.error || "Ollama server not reachable at " + this._ollamaUrl };
          }
          if (proxied.__proxyTimeout) {
            return { available: false, reason: "Ollama availability check timed out at " + this._ollamaUrl };
          }
        } catch {
        }
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort("availability_timeout"), QWEN_AVAILABILITY_TIMEOUT_MS);
      try {
        const res = await fetch(`${this._ollamaUrl}/api/tags`, { method: "GET", signal: controller.signal });
        return { available: res.ok };
      } catch {
        return { available: false, reason: "Ollama server not reachable at " + this._ollamaUrl };
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // ── Helpers ─────────────────────────────────────────────────────────────────
    _buildQwenPrompt(request) {
      const page = request.page ?? {};
      const history2 = request.executionHistory?.completedSteps ?? [];
      const elements = request.elements ?? [];
      const compactElements = elements.slice(0, 25).map((e) => ({
        id: e.id,
        role: e.role,
        text: e.text || e.ariaLabel || e.placeholder || ""
      }));
      return `Goal: "${request.goal}"
Page: ${page.title || ""} (${page.url || ""})
${history2.length ? `History: ${history2.map((h) => h.description).join(" -> ")}` : ""}

Elements:
${JSON.stringify(compactElements)}

Select single action.
Return JSON ONLY:
{"action":"click"|"type"|"select"|"navigate"|"finish","elementId":"el_1","text":"label","confidence":0.95}`;
    }
    _formatPlanResponse(request, qwenOutput, latencyMs) {
      const action = qwenOutput.action ?? "click";
      const text = qwenOutput.text || request.goal;
      const isFinish = action === "finish";
      const elementId = qwenOutput.elementId;
      if (isFinish) {
        return {
          schemaVersion: "1",
          result: "OK",
          state: "complete",
          blockers: [],
          plannerSummary: qwenOutput.reason || "Goal completed.",
          confidence: qwenOutput.confidence ?? 0.9,
          providerMetadata: { provider: "local-qwen", model: this._model, latencyMs, inputTokens: 0, outputTokens: 0 }
        };
      }
      const step = {
        id: 1,
        description: text,
        intent: text,
        phase: action === "type" ? "fill_form" : "navigate",
        completionCondition: "dom_change",
        targetElement: {
          text,
          type: action === "type" ? "input" : "button",
          intent: qwenOutput.value ?? text,
          elementId
        },
        // Provisional — Qwen's own action verb is an unreliable signal for whether a
        // click actually navigates (it often labels a link click "click", not
        // "navigate"). v2-task.js's plan-loop enrichment step overrides this from the
        // resolved element's real tag/href when it can; this stays as the fallback.
        expectedPageState: { urlChanges: action === "navigate" }
      };
      return {
        schemaVersion: "1",
        result: "OK",
        state: "planned",
        plannerSummary: `Action: ${action} on ${elementId ?? text}`,
        confidence: qwenOutput.confidence ?? 0.85,
        plan: {
          goalType: "action",
          confidence: qwenOutput.confidence ?? 0.85,
          steps: [step]
        },
        providerMetadata: { provider: "local-qwen", model: this._model, latencyMs, inputTokens: 0, outputTokens: 0 }
      };
    }
    _networkFailure(error, errorCode) {
      return {
        schemaVersion: "1",
        result: "FAILED",
        blockers: [],
        confidence: 0,
        providerMetadata: { provider: "local-qwen", model: this._model, latencyMs: 0 },
        error,
        errorCode
      };
    }
  };

  // extension/services/goal-verifier.js
  function normalize(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
  }
  var GENERIC_QUALIFIER_WORDS = /* @__PURE__ */ new Set([
    "preferences",
    "preference",
    "settings",
    "setting",
    "options",
    "option",
    "configuration",
    "config",
    "information",
    "info",
    "details",
    "management",
    "page"
  ]);
  function tokenOverlapMatches(targetTokens, candidateTokens) {
    if (!targetTokens.length || !candidateTokens?.length) return false;
    const contentTokens = targetTokens.filter((t) => !GENERIC_QUALIFIER_WORDS.has(t));
    const required = contentTokens.length ? contentTokens : targetTokens;
    return required.every((t) => candidateTokens.some((ct) => ct.includes(t) || t.includes(ct)));
  }
  function accessibleName(el, doc) {
    const aria = el.getAttribute?.("aria-label");
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      return Array.from(el.labels).map((l) => l.innerText || l.textContent || "").join(" ");
    }
    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy && doc) {
      return labelledBy.split(/\s+/).filter(Boolean).map((id) => doc.getElementById(id)?.textContent || "").join(" ");
    }
    return el.textContent || el.getAttribute?.("title") || "";
  }
  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) return false;
    }
    if (typeof el.offsetParent !== "undefined" && el.offsetParent === null && el.tagName !== "BODY") return false;
    return true;
  }
  var INTERACTIVE_CONTROL_SELECTOR = 'a[href],button,[role="button"],[tabindex="0"]';
  function hasInteractiveAncestor(el) {
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest(INTERACTIVE_CONTROL_SELECTOR);
  }
  function isFragmentOnlyLink(el) {
    if (el.tagName?.toLowerCase?.() !== "a") return false;
    const href = el.getAttribute?.("href") || "";
    return href.startsWith("#");
  }
  function isStructurallyNear(headingEl, candidate, maxHops = 6) {
    if (typeof candidate.parentElement === "undefined") return true;
    let node = candidate.parentElement;
    for (let hops = 0; node && hops < maxHops; hops++, node = node.parentElement) {
      if (typeof node.contains === "function" && node.contains(headingEl)) return true;
    }
    return false;
  }
  function hasAvailableInteractiveCounterpart(doc, targetObject, targetTokens, headingEl) {
    if (!doc || typeof doc.querySelectorAll !== "function") return false;
    for (const el of doc.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR)) {
      if (!isElementVisible(el)) continue;
      if (isFragmentOnlyLink(el)) continue;
      const text = normalize(el.textContent || el.getAttribute?.("aria-label") || "");
      if (!text) continue;
      const matches = text === targetObject || isSameTargetPhrase(targetTokens, UIGroundingService.tokenize(text));
      if (matches && isStructurallyNear(headingEl, el)) return true;
    }
    return false;
  }
  function isCloseTokenMatch(token, other) {
    if (token === other) return true;
    const shorter = token.length <= other.length ? token : other;
    const longer = token.length <= other.length ? other : token;
    return longer.includes(shorter) && longer.length - shorter.length <= 2;
  }
  function isSameTargetPhrase(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return false;
    const isCoveredBy = (token, otherTokens) => otherTokens.some((o) => isCloseTokenMatch(token, o));
    return tokensA.every((t) => isCoveredBy(t, tokensB)) && tokensB.every((t) => isCoveredBy(t, tokensA));
  }
  function includesWholeWord(haystack, needle) {
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
  }
  function urlPathSegmentIncludes(normUrl, targetObject) {
    const escaped = targetObject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`/${escaped}([^a-z0-9]|$)`, "i").test(normUrl);
  }
  function hrefIncludes(loc, pattern) {
    if (!pattern) return null;
    const href = loc && loc.href || "";
    return href.includes(pattern);
  }
  function textPresent(doc, text) {
    const needle = normalize(text);
    if (!needle) return null;
    const body = doc && doc.body ? doc.body.innerText || doc.body.textContent || "" : "";
    return normalize(body).includes(needle);
  }
  function elementPresent(doc, text) {
    const needle = normalize(text);
    if (!needle) return null;
    if (!doc || typeof doc.querySelectorAll !== "function") return null;
    for (const el of doc.querySelectorAll("[aria-label],[title],img[alt]")) {
      if (!isElementVisible(el)) continue;
      const name = normalize(
        el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || ""
      );
      if (name.includes(needle)) return true;
    }
    for (const el of doc.querySelectorAll('a,button,[role="button"],[role="link"],h1,h2,h3,summary,li,td,strong,span')) {
      if (!isElementVisible(el)) continue;
      if (normalize(el.textContent || "").includes(needle)) return true;
    }
    return false;
  }
  function evaluateSignal(signal, doc, loc) {
    const type = signal && signal.type;
    const target = (signal && (signal.urlPattern ?? signal.text)) ?? "";
    let passed;
    switch (type) {
      case "url_matches":
        passed = loc ? hrefIncludes(loc, signal.urlPattern) : null;
        break;
      case "url_leaves": {
        const inc = loc ? hrefIncludes(loc, signal.urlPattern) : null;
        passed = inc === null ? null : !inc;
        break;
      }
      case "text_present":
        passed = textPresent(doc, signal.text);
        break;
      case "element_present":
        passed = elementPresent(doc, signal.text);
        break;
      case "element_absent": {
        const pres = elementPresent(doc, signal.text);
        passed = pres === null ? null : !pres;
        break;
      }
      default:
        passed = null;
    }
    return { type: type || "unknown", target, passed };
  }
  var ACTION_PREFIXES = [
    "navigate to",
    "head to",
    "go to",
    "visit",
    "check",
    "open",
    "view",
    "see",
    "find",
    "enter",
    "select",
    "show",
    "click on",
    "click",
    "fill",
    "search for",
    "search",
    "type",
    "look at",
    // Toggle/checkbox-goal verbs — stripped for the same reason as the navigation
    // verbs above: the destination control's own accessible name says what it IS
    // ("Two-factor authentication"), not the imperative the user asked for
    // ("enable two-factor authentication") — leaving the verb in would make it a
    // mandatory (and never-matching) content token in the DOM-mutation signal.
    "turn on",
    "turn off",
    "switch on",
    "switch off",
    "enable",
    "disable",
    "activate",
    "deactivate",
    "toggle"
  ];
  function extractTargetObject(goal) {
    let norm = normalize(goal);
    for (const prefix of ACTION_PREFIXES) {
      if (norm.startsWith(prefix + " ")) {
        norm = norm.slice(prefix.length + 1).trim();
        break;
      }
    }
    return norm.replace(/^['"]|['"]$/g, "").trim();
  }
  var GoalVerifier = {
    extractTargetObject,
    /**
     * Determine whether a natural language goal is ALREADY satisfied by generic page state.
     */
    isGoalSatisfied(goal, pageState = null, env = {}) {
      const t0 = Date.now();
      const doc = env.doc ?? (typeof document !== "undefined" ? document : null);
      const loc = env.loc ?? (typeof location !== "undefined" ? location : null);
      const url = pageState?.url || loc && loc.href || "";
      if (!goal) return { satisfied: false, reason: "no_goal", latencyMs: Date.now() - t0 };
      const targetObject = extractTargetObject(goal);
      if (!targetObject || targetObject.length < 2) {
        return { satisfied: false, reason: "unclear_target_object", latencyMs: Date.now() - t0 };
      }
      const targetTokens = UIGroundingService.tokenize(targetObject);
      const isMultiWord = targetTokens.length >= 2;
      if (url) {
        const normUrl = url.toLowerCase();
        const urlSegments = normUrl.split(/[/\-?#&=._]/).filter((s) => s.length > 2);
        if (urlSegments.includes(targetObject) || urlPathSegmentIncludes(normUrl, targetObject)) {
          return { satisfied: true, reason: "url_matches_target_object", targetObject, latencyMs: Date.now() - t0 };
        }
        if (isMultiWord && tokenOverlapMatches(targetTokens, urlSegments)) {
          return { satisfied: true, reason: "url_token_overlap_match", targetObject, latencyMs: Date.now() - t0 };
        }
      }
      if (doc && typeof doc.querySelectorAll === "function") {
        for (const el of doc.querySelectorAll('[aria-current="page"],[aria-selected="true"],.active,.selected,[data-active="true"]')) {
          if (!isElementVisible(el)) continue;
          if (hasInteractiveAncestor(el)) continue;
          const text = normalize(el.textContent || el.getAttribute("aria-label") || "");
          if (text === targetObject || text && text.length <= 120 && includesWholeWord(text, targetObject)) {
            return { satisfied: true, reason: "active_nav_matches_target_object", targetObject, latencyMs: Date.now() - t0 };
          }
        }
        for (const el of doc.querySelectorAll('h1, h2, h3, legend, [role="heading"]')) {
          if (!isElementVisible(el)) continue;
          if (hasInteractiveAncestor(el)) continue;
          const headingText = normalize(el.textContent || "");
          if (!headingText) continue;
          const wholePhraseMatch = headingText === targetObject || includesWholeWord(headingText, targetObject);
          const tokenOverlapMatch = !wholePhraseMatch && isMultiWord && tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(headingText));
          if (wholePhraseMatch || tokenOverlapMatch) {
            if (hasAvailableInteractiveCounterpart(doc, targetObject, targetTokens, el)) continue;
            return {
              satisfied: true,
              reason: wholePhraseMatch ? "heading_matches_target_object" : "heading_token_overlap_match",
              targetObject,
              latencyMs: Date.now() - t0
            };
          }
        }
        for (const el of doc.querySelectorAll('[aria-checked="true"],[aria-pressed="true"],input:checked')) {
          if (!isElementVisible(el)) continue;
          const name = normalize(accessibleName(el, doc));
          if (!name) continue;
          if (tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(name))) {
            return { satisfied: true, reason: "toggle_state_matches_target", targetObject, latencyMs: Date.now() - t0 };
          }
        }
      } else if (Array.isArray(pageState?.elements)) {
        for (const el of pageState.elements) {
          if (!el.visible) continue;
          const text = normalize(el.text || el.ariaLabel || "");
          if (!text) continue;
          if ((el.tag === "h1" || el.tag === "h2" || el.tag === "h3" || el.tag === "legend" || el.role === "heading") && text.includes(targetObject)) {
            return { satisfied: true, reason: "page_state_heading_matches", targetObject, latencyMs: Date.now() - t0 };
          }
          if (isMultiWord && (el.tag === "h1" || el.tag === "h2" || el.tag === "h3" || el.tag === "legend" || el.role === "heading") && tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(text))) {
            return { satisfied: true, reason: "page_state_heading_token_overlap_match", targetObject, latencyMs: Date.now() - t0 };
          }
        }
      }
      return { satisfied: false, reason: "not_yet_satisfied", targetObject, latencyMs: Date.now() - t0 };
    },
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
      const doc = env.doc ?? (typeof document !== "undefined" ? document : null);
      const loc = env.loc ?? (typeof location !== "undefined" ? location : null);
      const signals = Array.isArray(criteria && criteria.successSignals) ? criteria.successSignals : [];
      const totalSignals = signals.length;
      if (totalSignals === 0) {
        return { satisfied: false, verdict: "unknown", matchedSignals: 0, totalSignals: 0, details: [] };
      }
      const details = signals.map((s) => evaluateSignal(s, doc, loc));
      const matchedSignals = details.filter((d) => d.passed === true).length;
      const anyUnknown = details.some((d) => d.passed === null);
      const match = criteria && criteria.match === "any" ? "any" : "all";
      const satisfied = match === "any" ? matchedSignals >= 1 : matchedSignals === totalSignals;
      let verdict;
      if (satisfied) verdict = "satisfied";
      else if (anyUnknown) verdict = "unknown";
      else verdict = "unsatisfied";
      return { satisfied, verdict, matchedSignals, totalSignals, details };
    },
    /**
     * Phase 26 — completion gate. Decides whether the verifier may DRIVE completion.
     *
     * @param {import('../shared/types/index.js').GoalCompletionCriteria|null} criteria
     * @param {{ doc?: Document, loc?: Location }} [env]
     * @param {string} [goal]
     * @param {object} [pageState]
     */
    shouldComplete(criteria, env = {}, goal = null, pageState = null) {
      const result = (() => {
        try {
          if (criteria && criteria.requiresEffect === true) {
            const verdict = this.evaluate(criteria, env);
            if (!verdict.satisfied) {
              return { complete: false, reason: "unsatisfied", verdict };
            }
            if (typeof criteria.confidenceThreshold === "number" && verdict.totalSignals > 0 && verdict.matchedSignals / verdict.totalSignals < criteria.confidenceThreshold) {
              return { complete: false, reason: "below_confidence_threshold", verdict };
            }
            return { complete: true, reason: "signals_satisfied", verdict };
          }
          if (goal) {
            const genericCheck = this.isGoalSatisfied(goal, pageState, env);
            if (genericCheck.satisfied) {
              return { complete: true, reason: "goal_already_satisfied", verdict: { satisfied: true, reason: genericCheck.reason } };
            }
          }
          if (!criteria) return { complete: false, reason: "no_criteria", verdict: null };
          if (criteria.requiresEffect !== true) return { complete: false, reason: "no_effect_contract", verdict: null };
          return { complete: false, reason: "unsatisfied", verdict: null };
        } catch {
          return { complete: false, reason: "evaluation_error", verdict: null };
        }
      })();
      console.log("[SP:GoalVerifier]", {
        complete: result.complete,
        reason: result.reason,
        matchedSignals: result.verdict?.matchedSignals,
        totalSignals: result.verdict?.totalSignals,
        details: result.verdict?.details
      });
      return result;
    }
  };

  // extension/services/decision-router.js
  var DETERMINISTIC_THRESHOLD = 0.85;
  var ML_GROUNDING_THRESHOLD = 0.7;
  var DecisionRouter = class {
    /**
     * @param {object} [options]
     * @param {number} [options.deterministicThreshold]
     * @param {number} [options.mlGroundingThreshold]
     * @param {'cloud'|'local-qwen'} [options.executionMode] - L3 backend selection. Default 'cloud'.
     * @param {object} [options.localQwenAdapter]
     * @param {object} [options.cloudAdapter]
     */
    constructor({
      deterministicThreshold = DETERMINISTIC_THRESHOLD,
      mlGroundingThreshold = ML_GROUNDING_THRESHOLD,
      executionMode = "cloud",
      localQwenAdapter = null,
      cloudAdapter = null
    } = {}) {
      this.deterministicThreshold = deterministicThreshold;
      this.mlGroundingThreshold = mlGroundingThreshold;
      this.executionMode = executionMode;
      this.localQwenAdapter = localQwenAdapter ?? new LocalQwenAdapter();
      this.cloudAdapter = cloudAdapter ?? new VercelBackendAdapter();
    }
    /**
     * Route a task goal through the 3-tier local hierarchy.
     *
     * @param {string} goal
     * @param {import('../shared/types/index.js').NormalizedPageState} pageState
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @param {object} [options.cloudContext] - Lazily-used context for an L3 cloud call.
     * @param {() => Promise<{image:string,mimeType:string}>} [options.cloudContext.getScreenshot] - Only invoked if cloud is actually called.
     * @param {object} [options.cloudContext.executionHistory]
     * @param {string[]} [options.cloudContext.clarifications]
     * @param {object[]} [options.cloudContext.pageControls]
     * @param {string} [options.cloudContext.requestId]
     * @returns {Promise<{ layer: 'deterministic'|'ml_grounding'|'local_qwen'|'cloud', planResponse: object, layer1Ms: number, layer2Ms: number, qwenMs: number, cloudMs: number, qwenFailureReason: string|null }>}
     */
    async route(goal, pageState, options = {}) {
      const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
      const tL1Start = Date.now();
      const fastMatch = this._evalFastPath(goal, elements);
      const layer1Ms = Date.now() - tL1Start;
      if (fastMatch && fastMatch.score >= this.deterministicThreshold) {
        console.log(`[SP:DecisionRouter] Layer 1 FAST PATH matched (score=${fastMatch.score}):`, fastMatch.element.text || fastMatch.element.placeholder);
        console.log(`[SP:V2:DEBUG] layer=deterministic reason=exact_label_match candidateCount=${elements.length} confidence=${fastMatch.score}`);
        return {
          layer: "deterministic",
          planResponse: this._buildPlanFromElement(goal, fastMatch.element, fastMatch.score, "deterministic"),
          layer1Ms,
          layer2Ms: 0,
          qwenMs: 0,
          cloudMs: 0,
          qwenFailureReason: null
        };
      }
      const tL2Start = Date.now();
      const ranked = UIGroundingService.rankElements(goal, elements);
      const layer2Ms = Date.now() - tL2Start;
      if (ranked.length > 0 && ranked[0].score >= this.mlGroundingThreshold) {
        const top = ranked[0];
        console.log(`[SP:DecisionRouter] Layer 2 ML GROUNDING matched (score=${top.score}):`, top.element.text || top.element.placeholder);
        console.log(`[SP:V2:DEBUG] layer=ml_grounding reason=feature_vector_score candidateCount=${elements.length} confidence=${top.score}`);
        return {
          layer: "ml_grounding",
          planResponse: this._buildPlanFromElement(goal, top.element, top.score, "ml_grounding"),
          layer1Ms,
          layer2Ms,
          qwenMs: 0,
          cloudMs: 0,
          qwenFailureReason: null
        };
      }
      console.log(`[SP:DecisionRouter] Layer 3 invoked for goal: "${goal}" executionMode=${this.executionMode}`);
      console.log(`[SP:V2:DEBUG] layer=L3 reason=confidence_below_threshold candidateCount=${elements.length} executionMode=${this.executionMode}`);
      const l3 = await this._runLayer3(goal, pageState, elements, options);
      return { ...l3, layer1Ms, layer2Ms };
    }
    /**
     * L3: exactly one Qwen attempt (only when executionMode === 'local-qwen' and
     * Ollama reports available), then exactly one Cloud attempt as fallback/default.
     * Never retries a provider and never bounces back and forth between them.
     */
    async _runLayer3(goal, pageState, elements, options) {
      const { signal, cloudContext = {} } = options;
      let qwenMs = 0;
      let qwenFailureReason = null;
      if (this.executionMode === "local-qwen") {
        const tAvailStart = Date.now();
        let avail;
        try {
          avail = await this.localQwenAdapter.checkAvailability();
        } catch (err) {
          avail = { available: false, reason: err?.message || "availability_check_failed" };
        }
        console.log(`[SP:DecisionRouter] Layer 3 Qwen availability=${avail.available} (${Date.now() - tAvailStart}ms)`);
        if (avail.available) {
          const tQwenStart = Date.now();
          try {
            const planResponse2 = await this.localQwenAdapter.plan({
              schemaVersion: "1",
              goal,
              page: { url: pageState.url, title: pageState.title },
              elements
            }, { signal });
            qwenMs = Date.now() - tQwenStart;
            if (planResponse2?.result === "FAILED") {
              qwenFailureReason = planResponse2.error || planResponse2.errorCode || "qwen_failed";
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN resolved FAILED (${qwenFailureReason}, ${qwenMs}ms) \u2014 falling back to cloud once`);
            } else {
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN succeeded (${qwenMs}ms)`);
              return { layer: "local_qwen", planResponse: planResponse2, qwenMs, cloudMs: 0, qwenFailureReason: null };
            }
          } catch (err) {
            qwenMs = Date.now() - tQwenStart;
            qwenFailureReason = err?.message || "qwen_error";
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN threw (${qwenFailureReason}, ${qwenMs}ms) \u2014 falling back to cloud once`);
          }
        } else {
          qwenFailureReason = avail.reason || "ollama_unavailable";
          console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN unavailable (${qwenFailureReason}) \u2014 using cloud`);
        }
      }
      const tCloudStart = Date.now();
      const screenshot = cloudContext.getScreenshot ? await cloudContext.getScreenshot() : null;
      const cloudRequest = {
        schemaVersion: "1",
        requestId: cloudContext.requestId,
        goal,
        page: {
          url: pageState.url,
          title: pageState.title,
          screenshot: { image: screenshot?.image, mimeType: screenshot?.mimeType }
        },
        ...cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory },
        ...cloudContext.clarifications?.length && { clarifications: cloudContext.clarifications },
        ...cloudContext.pageControls?.length && { pageControls: cloudContext.pageControls }
      };
      const planResponse = await this.cloudAdapter.plan(cloudRequest, { signal });
      const cloudMs = Date.now() - tCloudStart;
      console.log(`[SP:DecisionRouter] Layer 3 CLOUD resolved (${cloudMs}ms)`);
      return { layer: "cloud", planResponse, qwenMs, cloudMs, qwenFailureReason };
    }
    // ── Helpers ─────────────────────────────────────────────────────────────────
    _evalFastPath(goal, elements) {
      const normGoal = goal.trim().toLowerCase();
      if (!normGoal || !elements.length) return null;
      const targetObject = GoalVerifier.extractTargetObject(goal);
      for (const el of elements) {
        if (!el.visible || el.enabled === false) continue;
        const normText = (el.text || "").trim().toLowerCase();
        const normPlace = (el.placeholder || "").trim().toLowerCase();
        const normAria = (el.ariaLabel || "").trim().toLowerCase();
        if (normText && (normText === normGoal || normGoal === `click ${normText}` || normGoal === `click '${normText}'`)) {
          return { element: el, score: 0.98 };
        }
        if (targetObject && targetObject.length >= 2) {
          if (normText === targetObject || normPlace === targetObject || normAria === targetObject) {
            return { element: el, score: 0.95 };
          }
        }
        if (normPlace && (normPlace === normGoal || normGoal === `fill ${normPlace}` || normGoal === `search ${normPlace}`)) {
          return { element: el, score: 0.95 };
        }
        if (normAria && (normAria === normGoal || normGoal === `click ${normAria}`)) {
          return { element: el, score: 0.92 };
        }
      }
      return null;
    }
    _buildPlanFromElement(goal, element, confidence, layer) {
      const isInput = ["textbox", "combobox", "search"].includes(element.role) || ["input", "textarea"].includes(element.tag);
      const label = element.text || element.placeholder || element.ariaLabel || goal;
      const action = isInput ? "fill_form" : "navigate";
      const step = {
        id: 1,
        description: `${isInput ? "Fill" : "Click"} '${label}'`,
        intent: `${isInput ? "fill" : "click"}_${label}`,
        phase: action,
        completionCondition: "dom_change",
        targetElement: {
          text: label,
          type: isInput ? "input" : "button",
          intent: label,
          elementId: element.id,
          region: element.region ?? null
        },
        // Provisional default — corrected centrally in v2-task.js's plan-loop enrichment
        // step, which looks the resolved element back up in PageStateService's element
        // list (by elementId) and derives urlChanges from its actual tag/href. Do NOT
        // add href-sniffing logic here too; that would duplicate the one true source.
        expectedPageState: { urlChanges: false }
      };
      return {
        schemaVersion: "1",
        result: "OK",
        state: "planned",
        plannerSummary: `[Layer: ${layer}] Resolved target element '${label}' with confidence ${confidence}`,
        confidence,
        plan: {
          goalType: "action",
          confidence,
          steps: [step]
        },
        providerMetadata: { provider: layer, model: "local-heuristic", latencyMs: 2 }
      };
    }
  };

  // extension/shared/state-machine/transitions.js
  var TaskState = Object.freeze({
    /** No active task. Widget shows goal input. */
    IDLE: "IDLE",
    /** Waiting for the backend to return an ExecutionPlan. */
    PLANNING: "PLANNING",
    /** Plan received. Executor is resolving the current step's target element. */
    EXECUTING: "EXECUTING",
    /** Element found and highlighted. Waiting for the user to take action. */
    AWAITING_USER: "AWAITING_USER",
    /**
     * User acted. Collecting and scoring validation signals within the
     * step's timeout_ms window. Transitions immediately if confidence is
     * decisive before the window closes.
     */
    VALIDATING: "VALIDATING",
    /**
     * Execution diverged from the plan. Recovery engine is classifying the
     * failure and selecting a strategy. May result in a provider call.
     */
    RECOVERING: "RECOVERING",
    /**
     * Workflow interrupted by unexpected navigation, a back-button event,
     * or an auth redirect. Waiting for the user to choose Resume or Stop.
     * The session is preserved; re-planning happens if the user resumes.
     */
    PAUSED: "PAUSED",
    /** Goal successfully completed. */
    COMPLETE: "COMPLETE",
    /** Unrecoverable failure or recovery attempts exhausted. */
    ERROR: "ERROR"
  });
  var TaskEvent = Object.freeze({
    // User-initiated
    GOAL_SUBMITTED: "GOAL_SUBMITTED",
    STUCK_REQUESTED: "STUCK_REQUESTED",
    CANCEL_CLICKED: "CANCEL_CLICKED",
    RESET_CLICKED: "RESET_CLICKED",
    DONE_CLICKED: "DONE_CLICKED",
    // PlannerEngine outputs
    PLAN_RECEIVED: "PLAN_RECEIVED",
    PLAN_FAILED: "PLAN_FAILED",
    // ExecutorEngine outputs
    ELEMENT_READY: "ELEMENT_READY",
    ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
    // Page signals (URL change, click on highlighted element, form submit)
    USER_ACTED: "USER_ACTED",
    // ValidatorEngine outputs
    VALIDATION_PASSED: "VALIDATION_PASSED",
    VALIDATION_INCONCLUSIVE: "VALIDATION_INCONCLUSIVE",
    VALIDATION_FAILED: "VALIDATION_FAILED",
    // CompletionEngine outputs (emitted on the final step only)
    FINAL_STEP_COMPLETE: "FINAL_STEP_COMPLETE",
    FINAL_STEP_UNCERTAIN: "FINAL_STEP_UNCERTAIN",
    // RecoveryEngine outputs
    STEP_CORRECTED: "STEP_CORRECTED",
    REPLAN_RECEIVED: "REPLAN_RECEIVED",
    RECOVERY_FAILED: "RECOVERY_FAILED",
    // Architecture B — session resume and progressive planning
    //
    // SESSION_RESUME:   A valid session was found on content script init. Skip the
    //                   goal overlay and go directly to PLANNING on the current page.
    //
    // REPLAN_TRIGGERED: The current plan is exhausted on the same page (no navigation
    //                   occurred). The orchestrator calls /api/plan again immediately.
    //                   This is the key Architecture B loop-back transition.
    //
    // WORKFLOW_PAUSED:  Navigation classification returned UNKNOWN or BACK_BUTTON,
    //                   or the planner returned state=blocked.
    //                   The session is preserved; the user must decide to Resume or Stop.
    //
    // USER_RESUMED:     User clicked "Resume" from the PAUSED banner.
    //                   The orchestrator calls /api/plan on the current page with full history.
    //
    // PLAN_COMPLETE:    The planner returned state=complete — goal already achieved.
    //                   Transitions directly from PLANNING to COMPLETE without executing
    //                   any step. Architecture B only.
    SESSION_RESUME: "SESSION_RESUME",
    REPLAN_TRIGGERED: "REPLAN_TRIGGERED",
    WORKFLOW_PAUSED: "WORKFLOW_PAUSED",
    USER_RESUMED: "USER_RESUMED",
    PLAN_COMPLETE: "PLAN_COMPLETE",
    // AMBIGUOUS_RECEIVED: Planner returned state=ambiguous while in PLANNING.
    //   Multiple valid execution paths exist and cannot be disambiguated from the
    //   screenshot alone. Session is paused (pauseReason='ambiguous') so the user
    //   can provide a clarification. Clears when the user submits clarification and
    //   USER_RESUMED fires to re-enter the plan loop.
    AMBIGUOUS_RECEIVED: "AMBIGUOUS_RECEIVED"
  });
  var TRANSITIONS = Object.freeze({
    [TaskState.IDLE]: {
      [TaskEvent.GOAL_SUBMITTED]: TaskState.PLANNING,
      // Architecture B: valid session found on page load — resume without showing overlay
      [TaskEvent.SESSION_RESUME]: TaskState.PLANNING,
      // Architecture B: URL classification returned UNKNOWN/BACK_BUTTON before any step ran
      [TaskEvent.WORKFLOW_PAUSED]: TaskState.PAUSED
    },
    [TaskState.PLANNING]: {
      [TaskEvent.PLAN_RECEIVED]: TaskState.EXECUTING,
      [TaskEvent.PLAN_FAILED]: TaskState.ERROR,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE,
      // Architecture B: planner confirmed goal already achieved — no step required
      [TaskEvent.PLAN_COMPLETE]: TaskState.COMPLETE,
      // Architecture B: planner returned blocked; session paused for user to resolve precondition
      [TaskEvent.WORKFLOW_PAUSED]: TaskState.PAUSED,
      // Architecture B: planner returned ambiguous; session paused for user clarification
      [TaskEvent.AMBIGUOUS_RECEIVED]: TaskState.PAUSED
    },
    [TaskState.EXECUTING]: {
      [TaskEvent.ELEMENT_READY]: TaskState.AWAITING_USER,
      [TaskEvent.ELEMENT_NOT_FOUND]: TaskState.RECOVERING,
      // Architecture B: plan exhausted after a non-navigation step; re-plan on same page
      [TaskEvent.REPLAN_TRIGGERED]: TaskState.PLANNING,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    },
    [TaskState.AWAITING_USER]: {
      [TaskEvent.USER_ACTED]: TaskState.VALIDATING,
      [TaskEvent.STUCK_REQUESTED]: TaskState.RECOVERING,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    },
    [TaskState.VALIDATING]: {
      // Non-final step: confidence crossed ADVANCE threshold
      [TaskEvent.VALIDATION_PASSED]: TaskState.EXECUTING,
      // Final step: local signals confirm completion
      [TaskEvent.FINAL_STEP_COMPLETE]: TaskState.COMPLETE,
      // Final step: signals too ambiguous for local determination
      [TaskEvent.FINAL_STEP_UNCERTAIN]: TaskState.RECOVERING,
      // Signals still arriving within the timeout_ms window; re-evaluate
      [TaskEvent.VALIDATION_INCONCLUSIVE]: TaskState.VALIDATING,
      // Confidence below WAIT threshold after window closed
      [TaskEvent.VALIDATION_FAILED]: TaskState.RECOVERING,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    },
    [TaskState.RECOVERING]: {
      // Architecture B: element:not_found recovery — replan from current state
      [TaskEvent.REPLAN_TRIGGERED]: TaskState.PLANNING,
      // Architecture B: step-attempt budget exhausted while recovering
      [TaskEvent.PLAN_FAILED]: TaskState.ERROR,
      // Provider returned a corrected single step
      [TaskEvent.STEP_CORRECTED]: TaskState.EXECUTING,
      // Provider returned a new full plan from current state
      [TaskEvent.REPLAN_RECEIVED]: TaskState.EXECUTING,
      // Attempts exhausted, quota error, or provider failure
      [TaskEvent.RECOVERY_FAILED]: TaskState.ERROR,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    },
    // Architecture B: workflow interrupted; waiting for user decision
    [TaskState.PAUSED]: {
      [TaskEvent.USER_RESUMED]: TaskState.PLANNING,
      // re-plan from current page with full history
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    },
    [TaskState.COMPLETE]: {
      [TaskEvent.DONE_CLICKED]: TaskState.IDLE
    },
    [TaskState.ERROR]: {
      [TaskEvent.RESET_CLICKED]: TaskState.IDLE,
      [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE
    }
  });
  function transition(currentState, event) {
    return TRANSITIONS[currentState]?.[event] ?? null;
  }

  // extension/services/session-store.js
  var SESSION_TTL_MS = 30 * 60 * 1e3;
  var SCHEMA_VERSION = "3";
  var KEY_PREFIX = "sp_session_";
  var MAX_STEP_ATTEMPTS = 3;
  var MAX_CONSECUTIVE_AMBIGUOUS = 3;
  var MAX_CONSECUTIVE_FINAL = 3;
  var MAX_AUTH_ATTEMPTS = 3;
  function _maxPlannerCalls(session) {
    return Math.min(10 + 2 * session.completedSteps.length, 40);
  }
  function sessionKey(tabId) {
    return KEY_PREFIX + tabId;
  }
  function nowMs() {
    return Date.now();
  }
  function getStorageArea() {
    return chrome.storage?.local ?? chrome.storage?.session ?? null;
  }
  async function _read(tabId) {
    const key = sessionKey(tabId);
    const storage = getStorageArea();
    if (!storage) throw new Error("chrome.storage.local/session is unavailable");
    const result = await storage.get(key);
    return result[key] ?? null;
  }
  async function _write(tabId, session) {
    const storage = getStorageArea();
    if (!storage) throw new Error("chrome.storage.local/session is unavailable");
    await storage.set({ [sessionKey(tabId)]: session });
  }
  var SessionStore = {
    /**
     * Create and persist a new session. Overwrites any existing session for this tabId.
     *
     * @param {number} tabId
     * @param {string} goal
     * @returns {Promise<object>} the persisted session
     */
    async create(tabId, goal) {
      const t = nowMs();
      const session = {
        sessionId: crypto.randomUUID(),
        tabId,
        schemaVersion: SCHEMA_VERSION,
        goal,
        completedSteps: [],
        planVersion: 0,
        plannerAttemptCount: 0,
        stepAttemptCount: 0,
        consecutiveFinalCount: 0,
        consecutiveAmbiguousCount: 0,
        goalDeniedCount: 0,
        authAttemptCount: 0,
        currentBlocker: null,
        pageUrlAtLoad: null,
        lastProgressAt: t,
        pendingStep: null,
        clarifications: [],
        // Phase 23A: plan-level goal-completion contract, persisted so it survives
        // navigation / reload / bootstrap resume. Additive and optional — set later
        // via patchSession when a plan carrying it is accepted. NOT a schema bump, so
        // existing sessions (which lack this field) still load unchanged.
        goalCompletionCriteria: null,
        phase: "PLANNING",
        createdAt: t,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      };
      await _write(tabId, session);
      return session;
    },
    /**
     * Load the session for the given tabId.
     * Returns null when absent, expired, or schema version mismatches.
     *
     * @param {number} tabId
     * @returns {Promise<object|null>}
     */
    async load(tabId) {
      const session = await _read(tabId);
      if (!session) return null;
      if (session.schemaVersion !== SCHEMA_VERSION) {
        await getStorageArea()?.remove(sessionKey(tabId));
        return null;
      }
      if (nowMs() > session.expiresAt) {
        await getStorageArea()?.remove(sessionKey(tabId));
        return null;
      }
      return session;
    },
    /**
     * Remove the session for the given tabId.
     *
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    async clear(tabId) {
      await getStorageArea()?.remove(sessionKey(tabId));
    },
    /**
     * Scan all stored sessions and remove those that have expired.
     * Safe to call on any content script init for housekeeping.
     *
     * @returns {Promise<number>} count of sessions removed
     */
    async cleanupExpired() {
      const storage = getStorageArea();
      if (!storage) return 0;
      const all = await storage.get(null);
      const now = nowMs();
      const keys = Object.keys(all).filter(
        (k) => k.startsWith(KEY_PREFIX) && now > (all[k]?.expiresAt ?? 0)
      );
      if (keys.length) await storage.remove(keys);
      return keys.length;
    },
    /**
     * Extend expiresAt without changing any other field.
     * Use during PAUSED state to keep the session alive while the user resolves a blocker.
     *
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    async refreshExpiry(tabId) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, { ...session, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
    },
    /**
     * Persist the pending step context and set phase to EXECUTING.
     * Must be called at element:ready — before any possible navigation —
     * so the context survives if the page unloads before user:acted fires.
     *
     * @param {number} tabId
     * @param {object} pendingStep
     * @returns {Promise<void>}
     */
    async markPendingStep(tabId, pendingStep) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        pendingStep,
        phase: "EXECUTING",
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
    },
    /**
     * Append a confirmed step to history.
     * Resets stepAttemptCount, consecutiveFinalCount, and consecutiveAmbiguousCount.
     * Sets phase to PLANNING so the next content script re-plans.
     *
     * @param {number} tabId
     * @param {object} stepRecord
     * @returns {Promise<void>}
     */
    async completeStep(tabId, stepRecord) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        completedSteps: [...session.completedSteps, stepRecord],
        planVersion: session.planVersion + 1,
        stepAttemptCount: 0,
        consecutiveFinalCount: 0,
        consecutiveAmbiguousCount: 0,
        lastProgressAt: t,
        pendingStep: null,
        phase: "PLANNING",
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
    },
    /**
     * Update the session phase without touching any other field.
     *
     * @param {number} tabId
     * @param {string} phase
     * @returns {Promise<void>}
     */
    async setPhase(tabId, phase) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, { ...session, phase, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
    },
    /**
     * Increment both planner attempt counters.
     * Use when the step genuinely failed (element-not-found, validation-failed).
     * Returns isStuck=true if either limit is reached.
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async incrementPlannerAttempt(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const nextPlannerCount = session.plannerAttemptCount + 1;
      const nextStepCount = session.stepAttemptCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        plannerAttemptCount: nextPlannerCount,
        stepAttemptCount: nextStepCount,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      if (nextStepCount >= MAX_STEP_ATTEMPTS) {
        return {
          isStuck: true,
          reason: `Step attempt limit reached (${nextStepCount}/${MAX_STEP_ATTEMPTS}) \u2014 stuck on same step`
        };
      }
      const budget = _maxPlannerCalls(session);
      if (nextPlannerCount >= budget) {
        return {
          isStuck: true,
          reason: `Global planner call limit reached (${nextPlannerCount}/${budget})`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Increment plannerAttemptCount only (not stepAttemptCount).
     * Use for NAV_REFRESH and PAUSED resume — step was never attempted.
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async incrementPlannerAttemptOnly(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const nextPlannerCount = session.plannerAttemptCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        plannerAttemptCount: nextPlannerCount,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      const budget = _maxPlannerCalls(session);
      if (nextPlannerCount >= budget) {
        return {
          isStuck: true,
          reason: `Global planner call limit reached (${nextPlannerCount}/${budget})`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Increment stepAttemptCount only (not plannerAttemptCount).
     * Use when retrying the same step without consuming global budget.
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async incrementStepAttempt(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const nextStepCount = session.stepAttemptCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        stepAttemptCount: nextStepCount,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      if (nextStepCount >= MAX_STEP_ATTEMPTS) {
        return {
          isStuck: true,
          reason: `Step attempt limit reached (${nextStepCount}/${MAX_STEP_ATTEMPTS}) \u2014 stuck on same step`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Increment consecutiveAmbiguousCount.
     * Call when outcome === 'ambiguous'. Triggers guard at MAX_CONSECUTIVE_AMBIGUOUS.
     * Reset by completeStep() or patchSession(tabId, { consecutiveAmbiguousCount: 0 }).
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async incrementAmbiguousAttempt(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const next = session.consecutiveAmbiguousCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        consecutiveAmbiguousCount: next,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      if (next >= MAX_CONSECUTIVE_AMBIGUOUS) {
        return {
          isStuck: true,
          reason: `Consecutive ambiguous limit reached (${next}/${MAX_CONSECUTIVE_AMBIGUOUS}) \u2014 cannot resolve path`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Increment authAttemptCount (never resets).
     * Call when entering auth recovery. Triggers guard at MAX_AUTH_ATTEMPTS.
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async incrementAuthAttempt(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const next = session.authAttemptCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        authAttemptCount: next,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      if (next >= MAX_AUTH_ATTEMPTS) {
        return {
          isStuck: true,
          reason: `Auth recovery limit reached (${next}/${MAX_AUTH_ATTEMPTS}) \u2014 cannot authenticate`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Increment consecutiveFinalCount.
     * Call when outcome === 'goal_reached'. Triggers guard at MAX_CONSECUTIVE_FINAL.
     * When the user denies: patchSession(tabId, { consecutiveFinalCount: 0, goalDeniedCount: n+1 }).
     *
     * @param {number} tabId
     * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
     */
    async recordGoalReached(tabId) {
      const session = await _read(tabId);
      if (!session) return { isStuck: false, reason: null };
      const next = session.consecutiveFinalCount + 1;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        consecutiveFinalCount: next,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
      if (next >= MAX_CONSECUTIVE_FINAL) {
        return {
          isStuck: true,
          reason: `Goal confirmation repeatedly rejected (${next}/${MAX_CONSECUTIVE_FINAL}) \u2014 planner and user disagree`
        };
      }
      return { isStuck: false, reason: null };
    },
    /**
     * Persist the blocker description from a blocked plan outcome.
     * Does not change phase — caller must call setPhase('PAUSED') separately.
     *
     * @param {number} tabId
     * @param {string} blockerText
     * @returns {Promise<void>}
     */
    async setBlocker(tabId, blockerText) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        currentBlocker: blockerText,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
    },
    /**
     * Clear the persisted blocker when the user resumes from PAUSED.
     * Does not change phase — caller must call setPhase() separately.
     *
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    async clearBlocker(tabId) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        currentBlocker: null,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
    },
    /**
     * Merge arbitrary updates into the session.
     * Use for counter resets and field patches that have no dedicated method.
     * Example: patchSession(tabId, { consecutiveFinalCount: 0, goalDeniedCount: n+1 })
     *
     * @param {number} tabId
     * @param {object} updates
     * @returns {Promise<void>}
     */
    async patchSession(tabId, updates) {
      const session = await _read(tabId);
      if (!session) return;
      const t = nowMs();
      await _write(tabId, {
        ...session,
        ...updates,
        updatedAt: t,
        expiresAt: t + SESSION_TTL_MS
      });
    }
  };
  SessionStore.setPendingStep = SessionStore.markPendingStep;
  SessionStore.appendCompletedStep = SessionStore.completeStep;

  // extension/services/navigation-classifier.js
  var NavClassification = Object.freeze({
    WORKFLOW_NAVIGATION: "WORKFLOW_NAVIGATION",
    REFRESH: "REFRESH",
    BACK_BUTTON: "BACK_BUTTON",
    UNKNOWN: "UNKNOWN"
  });
  function matchesUrlPattern(url, pattern) {
    try {
      const { pathname, hash } = new URL(url);
      return pathname.includes(pattern) || hash.includes(pattern);
    } catch {
      return false;
    }
  }
  function sameOrigin(urlA, urlB) {
    try {
      return new URL(urlA).origin === new URL(urlB).origin;
    } catch {
      return false;
    }
  }
  var WORKFLOW_NAVIGATION_WINDOW_MS = 2e4;
  function classifyNavigation(session, currentUrl) {
    const pending = session.pendingStep;
    if (pending?.expectedUrlChanges === true && pending?.expectedUrlPattern && matchesUrlPattern(currentUrl, pending.expectedUrlPattern)) {
      return { classification: NavClassification.WORKFLOW_NAVIGATION, matchedStepIndex: null };
    }
    if (pending?.urlBefore && currentUrl === pending.urlBefore) {
      return { classification: NavClassification.REFRESH, matchedStepIndex: null };
    }
    const history2 = session.completedSteps ?? [];
    for (let i = history2.length - 1; i >= 0; i--) {
      if (history2[i].urlAfter && currentUrl === history2[i].urlAfter) {
        return { classification: NavClassification.BACK_BUTTON, matchedStepIndex: i };
      }
    }
    if (pending?.urlBefore && currentUrl !== pending.urlBefore && !pending.expectedUrlPattern && sameOrigin(pending.urlBefore, currentUrl) && typeof pending.stepStartedAt === "number" && Date.now() - pending.stepStartedAt <= WORKFLOW_NAVIGATION_WINDOW_MS) {
      return { classification: NavClassification.WORKFLOW_NAVIGATION, matchedStepIndex: null };
    }
    return { classification: NavClassification.UNKNOWN, matchedStepIndex: null };
  }

  // extension/v2-task.js
  var _state = TaskState.IDLE;
  function ts() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function applyEvent(event, meta = {}) {
    const from = _state;
    const to = transition(_state, event);
    if (!to) {
      console.warn(`[SP:V2] [${ts()}] INVALID_TRANSITION state=${from} event=${event} (no-op)`);
      return false;
    }
    _state = to;
    const detail = Object.entries(meta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
    console.log(`[SP:V2] [${ts()}] STATE ${from} \u2192 ${to}  event=${event}${detail ? "  " + detail : ""}`);
    return true;
  }
  var _tabId = null;
  var _generation = 0;
  var _executor = null;
  var _taskContext = null;
  var _taskStartedAt = null;
  var MAX_CLARIFICATIONS = 5;
  var RETRYABLE_PLAN_ERRORS = /* @__PURE__ */ new Set(["NETWORK_ERROR", "REQUEST_TIMEOUT", "HTTP_ERROR"]);
  var MAX_PLAN_RETRIES = 2;
  var STATUS_ID = "sp-v2-status-banner";
  function getStorageArea2() {
    return chrome.storage?.local ?? chrome.storage?.session ?? null;
  }
  function showStatus(text, type = "info") {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = STATUS_ID;
      el.style.cssText = [
        "position:fixed",
        "bottom:16px",
        "right:16px",
        "z-index:2147483647",
        "padding:10px 18px",
        "border-radius:10px",
        "font-family:system-ui,-apple-system,sans-serif",
        "font-size:13px",
        "line-height:1.45",
        "max-width:340px",
        "pointer-events:none",
        "box-shadow:0 4px 24px rgba(0,0,0,0.35)",
        "transition:background 0.2s"
      ].join(";");
      document.body.appendChild(el);
    }
    const bg = {
      planning: "#cc2222",
      info: "#0d0d0d",
      success: "#0a6b0a",
      error: "#b02020",
      validating: "#7a5500",
      paused: "#5a3a00"
    };
    el.style.background = bg[type] || bg.info;
    el.style.color = "#fff";
    el.textContent = text;
  }
  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
  }
  function showTaskPanel(ctx) {
    if (!ctx) return;
    document.getElementById(STATUS_ID)?.remove();
    const el = document.createElement("div");
    el.id = STATUS_ID;
    el.style.cssText = [
      "position:fixed",
      "bottom:16px",
      "right:16px",
      "z-index:2147483647",
      "width:272px",
      "background:#0d0d0d",
      "border-radius:10px",
      "font-family:system-ui,-apple-system,sans-serif",
      "box-shadow:0 4px 24px rgba(0,0,0,0.6)",
      "border:1px solid rgba(255,255,255,0.08)",
      "overflow:hidden",
      "pointer-events:none"
    ].join(";");
    const recent = (ctx.steps || []).slice(-5);
    const stepsHtml = recent.map(
      (s) => `<div style="display:flex;align-items:flex-start;gap:7px;padding:1px 0;font-size:11px"><span style="flex-shrink:0;color:#3a7d44">\u2713</span><span style="color:#555">${s.description}</span></div>`
    ).join("");
    const currentHtml = ctx.currentStep ? `<div style="display:flex;align-items:flex-start;gap:7px;padding:2px 0;font-size:11px"><span style="flex-shrink:0;color:#cc2222;font-weight:700">\u2192</span><span style="color:#f0f0f0;font-weight:600">${ctx.currentStep}</span></div>` : "";
    const n = (ctx.steps || []).length;
    const progress = n === 0 ? "Starting\u2026" : `${n} step${n !== 1 ? "s" : ""} completed`;
    el.innerHTML = `<div style="padding:8px 12px 6px;border-bottom:1px solid rgba(255,255,255,0.05)"><div style="font-size:10px;font-weight:700;color:#cc2222;letter-spacing:0.1em;text-transform:uppercase">ScreenPilot</div><div style="font-size:11px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ctx.goal || ""}</div></div>` + (stepsHtml || currentHtml ? `<div style="padding:6px 12px">${stepsHtml}${currentHtml}</div>` : "") + `<div style="padding:3px 12px 7px;font-size:10px;color:#333">${progress}</div>`;
    document.body.appendChild(el);
  }
  var CONFETTI_ID = "sp-v2-confetti";
  function launchConfetti() {
    document.getElementById(CONFETTI_ID)?.remove();
    const canvas = document.createElement("canvas");
    canvas.id = CONFETTI_ID;
    canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      return;
    }
    const colors = ["#cc2222", "#3a7d44", "#f0c000", "#ffffff", "#e07a2a"];
    const parts = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.3,
      r: 4 + Math.random() * 5,
      c: colors[Math.random() * colors.length | 0],
      vx: -2 + Math.random() * 4,
      vy: 2 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: -0.2 + Math.random() * 0.4
    }));
    const start = performance.now();
    const DURATION = 3500;
    function frame(now) {
      if (!canvas.isConnected) return;
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
        ctx.restore();
      }
      if (elapsed < DURATION) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }
  function showCompletionCard(data) {
    hideStatus();
    const card = document.createElement("div");
    card.id = STATUS_ID;
    card.style.cssText = [
      "position:fixed",
      "bottom:16px",
      "right:16px",
      "z-index:2147483647",
      "width:272px",
      "background:#0d0d0d",
      "border-radius:10px",
      "font-family:system-ui,-apple-system,sans-serif",
      "box-shadow:0 4px 24px rgba(0,0,0,0.6)",
      "border:1px solid rgba(255,255,255,0.08)",
      "overflow:hidden"
    ].join(";");
    card.innerHTML = `<div style="padding:14px 16px 8px;text-align:center"><div style="font-size:22px;margin-bottom:4px">\u{1F389}</div><div style="font-size:12px;font-weight:700;color:#3a7d44;letter-spacing:0.08em;text-transform:uppercase">Task Complete</div></div><div style="padding:0 16px 16px"><div style="font-size:11px;color:#777;margin-bottom:3px">Successfully completed:</div><div style="font-size:12px;color:#f0f0f0;line-height:1.4">${data.goal || "Goal completed"}</div></div>`;
    document.body.appendChild(card);
    launchConfetti();
    setTimeout(hideStatus, 4e3);
  }
  var PAUSED_ID = "sp-v2-paused-banner";
  function showPausedBanner(session) {
    document.getElementById(PAUSED_ID)?.remove();
    const banner = document.createElement("div");
    banner.id = PAUSED_ID;
    banner.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:2147483647",
      "width:300px",
      "background:#0d0d0d",
      "border-radius:14px",
      "box-shadow:0 8px 40px rgba(0,0,0,0.5)",
      "font-family:system-ui,-apple-system,sans-serif",
      "overflow:hidden",
      "border:1px solid rgba(255,255,255,0.08)"
    ].join(";");
    const isBlocked = session.pauseReason === "blocked";
    const blockerHtml = session.currentBlocker ? `<div style="font-size:11px;color:#ffcc44;margin-top:6px;line-height:1.4">${session.currentBlocker}</div>` : "";
    const instructionHtml = isBlocked ? `<div style="font-size:11px;color:#aaa;margin-top:4px;line-height:1.4">
       Resolve this in the page, then click Resume.
     </div>` : "";
    banner.innerHTML = `
  <div style="padding:14px 16px">
    <div style="font-size:12px;font-weight:600;color:#888;letter-spacing:0.06em;text-transform:uppercase">
      ${isBlocked ? "Action required" : "Workflow paused"}
    </div>
    <div style="font-size:13px;color:#fff;margin-top:4px;line-height:1.4">
      ${session.goal}
    </div>
    ${blockerHtml}
    ${instructionHtml}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="sp-v2-resume-btn"
        style="flex:1;padding:8px;background:#cc2222;color:#fff;border:none;
               border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
        Resume
      </button>
      <button id="sp-v2-stop-btn"
        style="flex:1;padding:8px;background:rgba(255,255,255,0.08);color:#fff;border:none;
               border-radius:8px;font-size:13px;cursor:pointer">
        Stop
      </button>
    </div>
  </div>`;
    document.body.appendChild(banner);
    document.getElementById("sp-v2-resume-btn").addEventListener("click", _handleResume);
    document.getElementById("sp-v2-stop-btn").addEventListener("click", _handleStop);
  }
  function hidePausedBanner() {
    document.getElementById(PAUSED_ID)?.remove();
  }
  var AMBIGUOUS_ID = "sp-v2-ambiguous-banner";
  function showAmbiguousBanner(session) {
    document.getElementById(AMBIGUOUS_ID)?.remove();
    const banner = document.createElement("div");
    banner.id = AMBIGUOUS_ID;
    banner.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:2147483647",
      "width:320px",
      "background:#0d0d0d",
      "border-radius:14px",
      "box-shadow:0 8px 40px rgba(0,0,0,0.5)",
      "font-family:system-ui,-apple-system,sans-serif",
      "overflow:hidden",
      "border:1px solid rgba(255,255,255,0.08)"
    ].join(";");
    const summaryHtml = session.ambiguitySummary ? `<div style="font-size:11px;color:#ffcc44;margin-top:6px;line-height:1.4;font-style:italic">${session.ambiguitySummary}</div>` : "";
    banner.innerHTML = `
  <div style="padding:14px 16px">
    <div style="font-size:12px;font-weight:600;color:#888;letter-spacing:0.06em;text-transform:uppercase">
      Need your input
    </div>
    <div style="font-size:13px;color:#fff;margin-top:4px;line-height:1.4">
      ${session.goal}
    </div>
    ${summaryHtml}
    <div style="font-size:11px;color:#ccc;margin-top:8px;line-height:1.4">
      Describe which option to take, or click Continue to try again:
    </div>
    <textarea id="sp-v2-clarification-input"
      placeholder="e.g. Use the Billing menu, not Workspace Billing"
      rows="2"
      style="width:100%;box-sizing:border-box;margin-top:6px;background:#161616;
             border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#fff;font-size:12px;
             padding:8px 10px;resize:none;outline:none;font-family:inherit;line-height:1.5">
    </textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button id="sp-v2-clarify-btn"
        style="flex:1;padding:8px;background:#cc2222;color:#fff;border:none;
               border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
        Continue
      </button>
      <button id="sp-v2-ambig-stop-btn"
        style="flex:1;padding:8px;background:rgba(255,255,255,0.08);color:#fff;border:none;
               border-radius:8px;font-size:13px;cursor:pointer">
        Stop
      </button>
    </div>
  </div>`;
    document.body.appendChild(banner);
    document.getElementById("sp-v2-clarify-btn").addEventListener("click", () => {
      const text = document.getElementById("sp-v2-clarification-input")?.value ?? "";
      _handleClarification(text);
    });
    document.getElementById("sp-v2-ambig-stop-btn").addEventListener("click", _handleStop);
  }
  function hideAmbiguousBanner() {
    document.getElementById(AMBIGUOUS_ID)?.remove();
  }
  function validateStep(pre, post) {
    if (!pre || !post) return "INCONCLUSIVE";
    if (post.url !== pre.url) return "PASSED";
    if (post.domHash !== pre.domHash) return "PASSED";
    return "INCONCLUSIVE";
  }
  function resolveHighlighter() {
    if (window.__SP_Highlighter) {
      console.log("[SP:V2] resolveHighlighter: using window.__SP_Highlighter (content.js Highlighter)");
      return window.__SP_Highlighter;
    }
    console.warn("[SP:V2] window.__SP_Highlighter not found \u2014 using fallback outline highlighter");
    let _el = null, _bubble = null;
    return {
      async show(element, text) {
        this.clear();
        if (!element) return false;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.style.outline = "3px solid #e03030";
        element.style.outlineOffset = "3px";
        element.style.borderRadius = "4px";
        _el = element;
        const b = document.createElement("div");
        b.style.cssText = "position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:#0d0d0d;color:#fff;padding:10px 18px;border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;z-index:2147483646;max-width:380px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.45)";
        b.textContent = text;
        document.body.appendChild(b);
        _bubble = b;
        return true;
      },
      clear() {
        if (_el) {
          _el.style.outline = "";
          _el.style.outlineOffset = "";
          _el.style.borderRadius = "";
          _el = null;
        }
        _bubble?.remove();
        _bubble = null;
      }
    };
  }
  async function captureScreenshot() {
    const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
    if (!resp?.success) throw new Error(resp?.error || "Screenshot capture failed");
    return { image: resp.image, mimeType: resp.mimeType || "image/png" };
  }
  function collectPageControls() {
    if (!window.DOMMatcher) return [];
    const selector = 'button, a[href], [role="button"], [role="menuitem"], input[type="submit"], input[type="button"], summary';
    const seen = /* @__PURE__ */ new Set();
    const buckets = { top_navigation: [], side_navigation: [], other: [] };
    const LIMITS = { top_navigation: 8, side_navigation: 8, other: 4 };
    const SP_SEL = '[id^="sp-"],[id^="screenpilot-"],[class*="sp-"],[data-screenpilot]';
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el)) continue;
      if (!window.DOMMatcher.isVisible(el)) continue;
      if (el.closest?.(SP_SEL)) continue;
      seen.add(el);
      const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const ariaLabel = (el.getAttribute("aria-label") || "").trim().slice(0, 80);
      const title = (el.getAttribute("title") || "").trim().slice(0, 80);
      const imgAlt = el.querySelector?.("img[alt]")?.getAttribute?.("alt")?.trim() ?? "";
      if (!text && !ariaLabel && !title && !imgAlt) continue;
      const region = window.DOMMatcher.detectRegion(el);
      const key = buckets[region] !== void 0 ? region : "other";
      if (buckets[key].length >= LIMITS[key]) continue;
      buckets[key].push({ region, tag: el.tagName, text, ariaLabel, title, imgAlt });
    }
    return [...buckets.top_navigation, ...buckets.side_navigation, ...buckets.other];
  }
  function buildPendingStepContext(step) {
    const snap = capturePageSnapshot("");
    return {
      description: step.description,
      intent: step.intent,
      completionCondition: step.completionCondition,
      expectedUrlPattern: step.expectedPageState?.urlPattern ?? null,
      expectedUrlChanges: step.expectedPageState?.urlChanges ?? false,
      urlBefore: window.location.href,
      domHashBefore: snap.domHash,
      stepStartedAt: Date.now()
    };
  }
  function buildStepRecord(pendingStep) {
    let domHashAfter = null;
    try {
      domHashAfter = capturePageSnapshot("").domHash ?? null;
    } catch {
    }
    return {
      description: pendingStep.description,
      intent: pendingStep.intent,
      completionCondition: pendingStep.completionCondition,
      urlBefore: pendingStep.urlBefore,
      domHashBefore: pendingStep.domHashBefore ?? null,
      // carry through for dedup guard
      urlAfter: window.location.href,
      domHashAfter,
      completedAt: Date.now()
    };
  }
  function toExecutorStep(plannerStep) {
    return { ...plannerStep, expectedOutcome: plannerStep.expectedPageState };
  }
  function computeExpectedNavigationFromHref(href) {
    const trimmed = (href || "").trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("javascript:") || lower === "#" || lower.startsWith("mailto:") || lower.startsWith("tel:")) {
      return { urlChanges: false };
    }
    let target;
    try {
      target = new URL(trimmed, window.location.href);
    } catch {
      return null;
    }
    if (target.origin === window.location.origin && target.pathname === window.location.pathname) {
      return null;
    }
    return { urlChanges: true, urlPattern: target.pathname };
  }
  function computeExpectedNavigation(el) {
    if (!el || el.tag !== "a") return null;
    return computeExpectedNavigationFromHref(el.href);
  }
  function computeExpectedNavigationFromElement(element) {
    if (!element) return null;
    const tag = element.tagName?.toLowerCase?.();
    const anchor = tag === "a" ? element : typeof element.closest === "function" ? element.closest("a[href]") : null;
    if (!anchor) return null;
    return computeExpectedNavigationFromHref(anchor.getAttribute?.("href") || anchor.href || "");
  }
  function enrichStepFromPageState(plannerStep, pageState) {
    const elementId = plannerStep?.targetElement?.elementId;
    if (!pageState?.elements || !elementId) return;
    const resolvedEl = pageState.elements.find((e) => e.id === elementId);
    if (!resolvedEl) return;
    const nav = computeExpectedNavigation(resolvedEl);
    if (nav) {
      plannerStep.expectedPageState = { ...plannerStep.expectedPageState, ...nav };
    }
    if (plannerStep.targetElement.region == null && resolvedEl.region) {
      plannerStep.targetElement.region = resolvedEl.region;
    }
  }
  function matchesCompletedStep(completedSteps, pendingStep, proposedStep, currentSnap) {
    if (!proposedStep) return null;
    const recentCompleted = (completedSteps || []).slice(-3);
    const targetText = (proposedStep.targetElement?.text || "").trim().toLowerCase();
    const planIntent = (proposedStep.intent || "").trim().toLowerCase();
    const matchingCompleted = recentCompleted.slice().reverse().find((step) => {
      const stepIntent = (step.intent || "").trim().toLowerCase();
      const stepDesc = (step.description || "").trim().toLowerCase();
      const intentMatch = stepIntent && (stepIntent === planIntent || stepDesc.includes(planIntent) || planIntent.includes(stepIntent));
      const textMatch = targetText && stepDesc.toLowerCase().includes(targetText);
      return intentMatch || textMatch;
    });
    if (!matchingCompleted) return null;
    const urlBaseline = matchingCompleted.urlAfter ?? matchingCompleted.urlBefore;
    const urlSame = currentSnap.url === urlBaseline;
    let domHashSame;
    if (matchingCompleted.domHashAfter != null) {
      domHashSame = currentSnap.domHash === matchingCompleted.domHashAfter;
    } else if (matchingCompleted.domHashBefore != null) {
      domHashSame = currentSnap.domHash === matchingCompleted.domHashBefore;
    } else if (pendingStep?.domHashBefore != null) {
      domHashSame = currentSnap.domHash === pendingStep.domHashBefore;
    } else {
      domHashSame = false;
    }
    return { matchingCompleted, urlSame, domHashSame };
  }
  function makeSingleStepPlan(step, goal) {
    return {
      planId: crypto.randomUUID(),
      goal,
      goalType: "mixed",
      steps: [toExecutorStep(step)],
      currentStepIndex: 0,
      planVersion: 1,
      confidence: 1,
      createdAt: Date.now()
    };
  }
  function resolveOutcome(planResp) {
    if (planResp.result === "FAILED") return "failed";
    if (planResp.state === "complete") return "goal_reached";
    if (planResp.state === "blocked") return "blocked";
    if (planResp.result === "NEEDS_USER" || planResp.state === "ambiguous") return "ambiguous";
    if (planResp.state === "planned" && planResp.plan?.steps?.length) return "step_ready";
    return "ambiguous";
  }
  function isTerminalStep(step) {
    return step?.completionCondition === "final";
  }
  async function _showGoalCompleteCard(tabId, goal) {
    const s = await SessionStore.load(tabId);
    showCompletionCard({
      goal,
      steps: s?.completedSteps.length ?? 0,
      startedAt: _taskStartedAt
    });
    await SessionStore.clear(tabId);
  }
  var _activePlanPromise = null;
  async function _runPlanLoop(tabId, myGen) {
    if (_activePlanPromise) {
      console.log("[SP:V2:TRACE] _runPlanLoop call queued \u2014 awaiting active planning promise");
      try {
        await _activePlanPromise;
      } catch {
      }
      const session = await SessionStore.load(tabId);
      if (session?.phase === "PLANNING" && _generation === myGen) {
        console.log("[SP:V2:TRACE] Session still in PLANNING phase after active plan completed \u2014 re-executing plan loop");
        return _runPlanLoop(tabId, myGen);
      }
      return;
    }
    _activePlanPromise = _runPlanLoopInternal(tabId, myGen);
    try {
      await _activePlanPromise;
    } catch (err) {
      console.error("[SP:V2:TRACE] Unhandled plan loop error:", err);
      showStatus(`ScreenPilot: Planning error \u2014 ${err?.message || "Internal error"}`, "error");
      await SessionStore.clear(tabId);
    } finally {
      _activePlanPromise = null;
    }
  }
  async function _runPlanLoopInternal(tabId, myGen) {
    const storage = getStorageArea2();
    const { executionMode = "cloud", openRouterApiKey } = storage ? await storage.get(["executionMode", "openRouterApiKey"]) : { executionMode: "cloud", openRouterApiKey: void 0 };
    const cloudAdapter = new VercelBackendAdapter({ apiKey: openRouterApiKey ?? void 0 });
    const decisionRouter = new DecisionRouter({ executionMode, localQwenAdapter: new LocalQwenAdapter(), cloudAdapter });
    let planRetryCount = 0;
    let localPageState = null;
    while (true) {
      if (_generation !== myGen) {
        console.log(`[SP:V2] Plan loop gen=${myGen} superseded by gen=${_generation} \u2014 exiting`);
        return;
      }
      const session = await SessionStore.load(tabId);
      if (!session) {
        console.warn("[SP:V2] Session expired or cleared \u2014 stopping plan loop");
        hideStatus();
        return;
      }
      if (_generation !== myGen) return;
      console.log(`[SP:V2:TRACE] state transition phase=${session.phase} goal="${session.goal}"`);
      try {
        const lastStep = session.completedSteps[session.completedSteps.length - 1];
        const currentSnap = capturePageSnapshot("");
        console.log(`[SP:V2:DIAG] Plan loop entry \u2014 completedSteps=${session.completedSteps.length} stepAttemptCount=${session.stepAttemptCount} phase=${session.phase}`, {
          pendingStep: session.pendingStep ? { intent: session.pendingStep.intent, domHashBefore: session.pendingStep.domHashBefore } : null,
          lastCompletedStep: lastStep ? { intent: lastStep.intent, domHashBefore: lastStep.domHashBefore, urlBefore: lastStep.urlBefore } : null,
          currentUrl: currentSnap.url,
          currentDomHash: currentSnap.domHash
        });
      } catch {
      }
      {
        console.log("[SP:V2:TRACE] verify START");
        const tGoalStart = Date.now();
        const pageState = PageStateService.extractPageState();
        const gate = GoalVerifier.shouldComplete(session.goalCompletionCriteria, {}, session.goal, pageState);
        const goalVerifyMs = Date.now() - tGoalStart;
        console.log(`[SP:V2:TRACE] verify END complete=${gate.complete} reason=${gate.reason}`);
        if (gate.complete) {
          console.log("[SP:GoalCompletion]", {
            source: "verifier",
            satisfied: true,
            reason: gate.reason
          });
          console.log(`[SP:V2:PERF] goalVerifyMs=${goalVerifyMs} totalPlanningMs=${goalVerifyMs} qwen=SKIPPED reason=goal_already_satisfied`);
          applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
          await _showGoalCompleteCard(tabId, session.goal);
          return;
        }
      }
      const { isStuck: budgetExhausted, reason: budgetReason } = await SessionStore.incrementPlannerAttemptOnly(tabId);
      if (budgetExhausted) {
        applyEvent(TaskEvent.PLAN_FAILED, { reason: budgetReason });
        showStatus(`ScreenPilot: ${budgetReason}`, "error");
        await SessionStore.clear(tabId);
        return;
      }
      const tCycleStart = Date.now();
      showStatus("ScreenPilot \xB7 Planning\u2026", "planning");
      const freshSession = session;
      if (!freshSession) {
        hideStatus();
        return;
      }
      if (_generation !== myGen) return;
      const nClarifications = freshSession.clarifications?.length ?? 0;
      const pageControls = collectPageControls();
      const reqId = `req_v2_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const planController = new AbortController();
      console.log(`[SP:V2:TRACE] plan START reqId=${reqId}`);
      console.log(`[SP:V2:DEBUG] controller_created reqId=${reqId} signalAborted=${planController.signal.aborted}`);
      console.log(`[SP:V2:DEBUG] controller_id reqId=${reqId}`);
      console.log(`[SP:V2:DEBUG] signal_before_request reqId=${reqId} aborted=${planController.signal.aborted}`);
      let preSnap = { url: window.location.href, domHash: "" };
      try {
        preSnap = capturePageSnapshot("");
      } catch {
      }
      const onNavCheck = () => {
        if (window.location.href !== preSnap.url && !planController.signal.aborted) {
          console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=page_url_changed_during_planning`);
          planController.abort("page_url_changed_during_planning");
        }
      };
      window.addEventListener("popstate", onNavCheck, { once: true });
      const tReqStart = Date.now();
      console.log(`[SP:V2] [${ts()}] executionMode=${executionMode} step=${freshSession.completedSteps.length + 1} url=${window.location.href} clarifications=${nClarifications} pageControls=${pageControls.length} reqId=${reqId}`);
      let screenshotMs = 0;
      let planResp;
      try {
        const tDomStart = Date.now();
        const pageState = PageStateService.extractPageState();
        localPageState = pageState;
        const domMs = Date.now() - tDomStart;
        const preL3Check = GoalVerifier.isGoalSatisfied(freshSession.goal, pageState);
        if (preL3Check.satisfied) {
          window.removeEventListener("popstate", onNavCheck);
          console.log(`[SP:V2:TRACE] plan END reqId=${reqId} outcome=goal_already_satisfied`);
          console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=0 layer2Ms=0 qwenMs=0 cloudMs=0 postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${Date.now() - tReqStart} l3=SKIPPED reason=goal_already_satisfied`);
          applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
          await _showGoalCompleteCard(tabId, freshSession.goal);
          return;
        }
        const getScreenshot = async () => {
          const tSnap = Date.now();
          const shot = await captureScreenshot();
          screenshotMs = Date.now() - tSnap;
          return shot;
        };
        const cloudContext = {
          requestId: reqId,
          getScreenshot,
          ...freshSession.completedSteps.length && {
            executionHistory: {
              completedSteps: freshSession.completedSteps.map((s) => ({
                description: s.description,
                intent: s.intent,
                completedAt: s.completedAt
              })),
              planVersion: freshSession.planVersion,
              attemptCount: freshSession.plannerAttemptCount
            }
          },
          ...nClarifications && { clarifications: freshSession.clarifications.map((c) => c.text) },
          ...pageControls.length && { pageControls }
        };
        const routed = await decisionRouter.route(freshSession.goal, pageState, { signal: planController.signal, cloudContext });
        planResp = routed.planResponse;
        const layer1Ms = routed.layer1Ms ?? 0;
        const layer2Ms = routed.layer2Ms ?? 0;
        const qwenMs = routed.qwenMs ?? 0;
        const cloudMs = routed.cloudMs ?? 0;
        const totalPlanningMs = Date.now() - tReqStart;
        console.log(`[SP:V2:TRACE] layer result layer=${routed.layer} confidence=${planResp.confidence} qwenFailureReason=${routed.qwenFailureReason ?? "n/a"}`);
        console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=${layer1Ms} layer2Ms=${layer2Ms} qwenMs=${qwenMs} cloudMs=${cloudMs} screenshotMs=${screenshotMs} postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${totalPlanningMs} l3Layer=${routed.layer}`);
      } catch (err) {
        window.removeEventListener("popstate", onNavCheck);
        console.log(`[SP:V2:TRACE] plan ERROR reqId=${reqId} name=${err?.name} message=${err?.message}`);
        console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${planController.signal.aborted} reason=${planController.signal.reason}`);
        if (planController.signal.aborted || err?.name === "AbortError") {
          console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_aborted_exception`);
          console.log("[SP:V2] Request aborted \u2014 replanning");
          continue;
        }
        console.error("[SP:V2] Planning failed:", err);
        applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
        showStatus(`ScreenPilot: Planning error \u2014 ${err.message}`, "error");
        await SessionStore.clear(tabId);
        return;
      }
      console.log(`[SP:V2:TRACE] plan END reqId=${reqId}`);
      window.removeEventListener("popstate", onNavCheck);
      const reqMs = Date.now() - tReqStart;
      if (_generation !== myGen) return;
      if (planResp?.errorCode === "ABORTED") {
        console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_stale_discard`);
        console.log("[SP:V2] Request aborted \u2014 replanning");
        continue;
      }
      const postSnap = capturePageSnapshot("");
      const urlChanged = preSnap.url !== postSnap.url;
      const domChanged = preSnap.domHash !== postSnap.domHash;
      if (urlChanged || domChanged) {
        const dedupPreview = matchesCompletedStep(
          freshSession.completedSteps,
          freshSession.pendingStep,
          planResp.plan?.steps?.[0],
          postSnap
        );
        const isRepeatOfCompletedStep = !!dedupPreview && dedupPreview.urlSame && dedupPreview.domHashSame;
        if (!isRepeatOfCompletedStep) {
          console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_stale_snapshot_change`);
          console.log(`[SP:V2] STALE_PLAN discarded urlChanged=${urlChanged} domChanged=${domChanged} preUrl=${preSnap.url} postUrl=${postSnap.url} preDomHash=${preSnap.domHash} postDomHash=${postSnap.domHash} reqMs=${reqMs}ms`);
          continue;
        }
        console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=stale_snapshot_matches_completed_step_deferred_to_dedup_guard`);
      }
      const cycleMs = Date.now() - tCycleStart;
      const modelUsed = planResp.providerMetadata?.model ?? "unknown";
      const inTokens = planResp.providerMetadata?.inputTokens ?? "?";
      const outTokens = planResp.providerMetadata?.outputTokens ?? "?";
      console.log(`[SP:V2:PERF] cycleMs=${cycleMs}ms screenshotMs=${screenshotMs}ms reqMs=${reqMs}ms model=${modelUsed} inTokens=${inTokens} outTokens=${outTokens}`);
      console.log(`[SP:V2] [${ts()}] result=${planResp.result} state=${planResp.state} steps=${planResp.plan?.steps?.length ?? 0}  plannerSummary="${planResp.plannerSummary ?? ""}"`);
      if (planResp.plan?.steps?.length) {
        const s0 = planResp.plan.steps[0];
        console.log(`[SP:V2:DIAG] Planner step[0]:`, {
          intent: s0.intent,
          description: s0.description,
          targetText: s0.targetElement?.text,
          completionCondition: s0.completionCondition,
          urlChanges: s0.expectedPageState?.urlChanges,
          urlPattern: s0.expectedPageState?.urlPattern
        });
      }
      const outcome = resolveOutcome(planResp);
      if (outcome === "goal_reached") {
        const criteria = freshSession.goalCompletionCriteria;
        if (criteria?.requiresEffect === true) {
          const gate = GoalVerifier.shouldComplete(criteria);
          console.log("[SP:GoalCompletionGate]", {
            requiresEffect: criteria.requiresEffect,
            verifierComplete: gate.complete,
            verifierReason: gate.reason
          });
          if (!gate.complete) {
            console.log("[SP:GoalCompletion]", {
              source: "planner",
              state: "complete",
              accepted: false,
              reason: gate.reason
            });
            continue;
          }
        }
        console.log("[SP:GoalCompletion]", { source: "planner", state: "complete" });
        applyEvent(TaskEvent.PLAN_COMPLETE);
        showCompletionCard({
          goal: freshSession.goal,
          steps: freshSession.completedSteps.length,
          startedAt: _taskStartedAt
        });
        await SessionStore.clear(tabId);
        return;
      }
      if (outcome === "blocked") {
        const blocker = planResp.blockers?.[0] ?? "A precondition is not met";
        await SessionStore.setBlocker(tabId, blocker);
        await SessionStore.patchSession(tabId, { pauseReason: "blocked" });
        await SessionStore.setPhase(tabId, "PAUSED");
        applyEvent(TaskEvent.WORKFLOW_PAUSED);
        await SessionStore.refreshExpiry(tabId);
        const paused = await SessionStore.load(tabId);
        if (paused) showPausedBanner(paused);
        return;
      }
      if (outcome === "ambiguous") {
        const { isStuck, reason } = await SessionStore.incrementAmbiguousAttempt(tabId);
        if (isStuck) {
          applyEvent(TaskEvent.PLAN_FAILED, { reason: "ambiguous_limit_reached" });
          showStatus(reason ? `ScreenPilot: Cannot determine next step \u2014 ${reason}` : "ScreenPilot: Cannot determine next step \u2014 goal is too ambiguous", "error");
          await SessionStore.clear(tabId);
          return;
        }
        await SessionStore.patchSession(tabId, {
          pauseReason: "ambiguous",
          ambiguitySummary: planResp.plannerSummary ?? "Multiple valid paths exist for this goal"
        });
        await SessionStore.setPhase(tabId, "PAUSED");
        applyEvent(TaskEvent.AMBIGUOUS_RECEIVED);
        await SessionStore.refreshExpiry(tabId);
        const paused = await SessionStore.load(tabId);
        if (paused) showAmbiguousBanner(paused);
        return;
      }
      if (outcome === "failed") {
        const errorCode = planResp.errorCode ?? "planner_failed";
        const retryable = RETRYABLE_PLAN_ERRORS.has(errorCode);
        if (retryable && planRetryCount < MAX_PLAN_RETRIES) {
          planRetryCount++;
          const backoffMs = 1e3 * Math.pow(2, planRetryCount - 1);
          console.warn(`[SP:V2] [${ts()}] Retryable plan failure (${errorCode}) \u2014 retry ${planRetryCount}/${MAX_PLAN_RETRIES} in ${backoffMs}ms (session preserved)`);
          showStatus("ScreenPilot \xB7 Reconnecting\u2026", "planning");
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        applyEvent(TaskEvent.PLAN_FAILED, { reason: errorCode });
        if (retryable) {
          showStatus(`ScreenPilot: ${planResp.error ?? "Connection problem \u2014 please try again"}`, "error");
        } else {
          showStatus(`ScreenPilot: ${planResp.error ?? "Planning failed"}`, "error");
          await SessionStore.clear(tabId);
        }
        return;
      }
      planRetryCount = 0;
      const plannerStep = planResp.plan.steps[0];
      if (!plannerStep) {
        console.warn("[SP:V2] state=planned but steps is empty \u2014 treating as ambiguous");
        continue;
      }
      enrichStepFromPageState(plannerStep, localPageState);
      applyEvent(TaskEvent.PLAN_RECEIVED, { intent: plannerStep.intent });
      {
        const currentSnap = capturePageSnapshot("");
        const targetText = (plannerStep.targetElement?.text || "").trim().toLowerCase();
        const dedup = matchesCompletedStep(freshSession.completedSteps, freshSession.pendingStep, plannerStep, currentSnap);
        if (dedup) {
          const { matchingCompleted, urlSame, domHashSame } = dedup;
          console.log(`[SP:V2] Dedup check: intent="${plannerStep.intent}" target="${targetText}" urlSame=${urlSame} domHashSame=${domHashSame} currentDomHash=${currentSnap.domHash} baselineDomHash=${matchingCompleted.domHashAfter ?? matchingCompleted.domHashBefore ?? freshSession.pendingStep?.domHashBefore ?? "none"}`);
          if (urlSame && domHashSame) {
            console.warn(
              `[SP:V2] Dedup guard FIRED: planner returned step matching recent action ("${plannerStep.intent}" / "${targetText}") with identical page state \u2014 page did not change after that action`
            );
            const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
            if (isStuck) {
              applyEvent(TaskEvent.PLAN_FAILED, { reason });
              showStatus(`ScreenPilot: ${reason}`, "error");
              await SessionStore.clear(tabId);
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
            continue;
          } else {
            console.log(`[SP:V2] Dedup check PASSED: page state changed (urlSame=${urlSame} domHashSame=${domHashSame}) \u2014 allowing execution`);
          }
        }
      }
      const goalCompletionCriteria = planResp.goalCompletionCriteria ?? planResp.plan.goalCompletionCriteria;
      if (goalCompletionCriteria && !freshSession.goalCompletionCriteria) {
        await SessionStore.patchSession(tabId, { goalCompletionCriteria });
        console.log("[SP:GoalCompletionCriteria]", {
          goalType: goalCompletionCriteria.goalType,
          match: goalCompletionCriteria.match,
          verificationStrategy: goalCompletionCriteria.verificationStrategy,
          requiresEffect: goalCompletionCriteria.requiresEffect,
          successSignals: goalCompletionCriteria.successSignals
        });
      }
      await _shadowGoalVerify(tabId, "PLAN_RECEIVED", false);
      hideStatus();
      await SessionStore.setPhase(tabId, "EXECUTING");
      const result = await _executeStep(tabId, plannerStep, freshSession.goal, myGen);
      if (result === "navigated" || result === "aborted") {
        if (result === "navigated") {
          setTimeout(() => {
            _bootstrapSession(tabId);
          }, 200);
        }
        return;
      }
      if (result === "goal_complete") {
        return;
      }
      if (result === "element_not_found") {
        const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
        if (isStuck) {
          applyEvent(TaskEvent.PLAN_FAILED, { reason });
          showStatus(`ScreenPilot: ${reason}`, "error");
          await SessionStore.clear(tabId);
          return;
        }
        await SessionStore.setPhase(tabId, "PLANNING");
        applyEvent(TaskEvent.REPLAN_TRIGGERED, { reason: "element_not_found" });
        await _shadowGoalVerify(tabId, "REPLAN", false);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      await SessionStore.setPhase(tabId, "PLANNING");
      applyEvent(TaskEvent.REPLAN_TRIGGERED, { intent: plannerStep.intent });
      await _shadowGoalVerify(tabId, "REPLAN", false);
    }
  }
  async function _shadowGoalVerify(tabId, trigger, legacyComplete) {
    try {
      const session = await SessionStore.load(tabId);
      const criteria = session?.goalCompletionCriteria;
      if (!criteria) return;
      const verdict = GoalVerifier.evaluate(criteria);
      console.log(`[SP:GoalVerifier] trigger=${trigger}`, {
        satisfied: verdict.satisfied,
        matchedSignals: verdict.matchedSignals,
        totalSignals: verdict.totalSignals,
        details: verdict.details
      });
      console.log("[SP:GoalAgreement]", {
        trigger,
        legacyComplete: !!legacyComplete,
        verifierComplete: verdict.satisfied
      });
    } catch (err) {
      console.warn("[SP:GoalVerifier] shadow evaluation error (ignored):", err);
    }
  }
  async function _executeStep(tabId, plannerStep, goal, myGen) {
    if (!window.DOMMatcher) {
      console.error("[SP:V2] DOMMatcher not available \u2014 cannot execute step");
      return "element_not_found";
    }
    return new Promise((resolve) => {
      if (_generation !== myGen) {
        resolve("aborted");
        return;
      }
      const highlighter = resolveHighlighter();
      const executor = new ExecutorEngine({
        domMatcher: window.DOMMatcher,
        highlighter,
        captureSnapshot: capturePageSnapshot
      });
      if (_executor) _executor.abort();
      _executor = executor;
      let expectsNavigation = plannerStep.expectedPageState?.urlChanges === true;
      let resolved = false;
      function done(result) {
        if (resolved) return;
        resolved = true;
        if (_executor === executor) _executor = null;
        resolve(result);
      }
      executor.on("element:ready", async ({ step, element }) => {
        applyEvent(TaskEvent.ELEMENT_READY, { intent: plannerStep.intent });
        const elementNav = computeExpectedNavigationFromElement(element);
        if (elementNav) {
          step.expectedPageState = { ...step.expectedPageState, ...elementNav };
          expectsNavigation = step.expectedPageState.urlChanges === true;
        }
        if (_taskContext) {
          _taskContext.currentStep = step.description;
          showTaskPanel(_taskContext);
        } else {
          showStatus(step.description, "info");
        }
        await SessionStore.markPendingStep(tabId, buildPendingStepContext(step));
      });
      executor.on("element:not_found", ({ reason, isOptional }) => {
        if (isOptional) return;
        applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { reason });
        done("element_not_found");
      });
      executor.on("user:acted", async ({ step, trigger }) => {
        applyEvent(TaskEvent.USER_ACTED, { trigger });
        if (expectsNavigation) {
          if (_taskContext) {
            _taskContext.steps.push({ description: step.description });
            _taskContext.currentStep = null;
          }
          done("navigated");
          return;
        }
        showStatus("Verifying\u2026", "validating");
        const pre = executor.getPreActionSnapshot();
        let post = capturePageSnapshot("");
        const tVerifyStart = Date.now();
        while (Date.now() - tVerifyStart < 150 && pre?.domHash === post.domHash && pre?.url === post.url) {
          await new Promise((r) => setTimeout(r, 25));
          post = capturePageSnapshot("");
        }
        if (Date.now() - tVerifyStart < 150) {
          const rem = 150 - (Date.now() - tVerifyStart);
          if (rem > 0) await new Promise((r) => setTimeout(r, rem));
        }
        if (_generation !== myGen) {
          done("aborted");
          return;
        }
        post = capturePageSnapshot("");
        const verdict = validateStep(pre, post);
        console.log(`[SP:V2] user:acted verdict=${verdict} domHashBefore=${pre?.domHash} domHashAfter=${post.domHash} urlBefore=${pre?.url} urlAfter=${post.url}`);
        await SessionStore.completeStep(tabId, {
          description: step.description,
          intent: plannerStep.intent,
          completionCondition: step.completionCondition,
          urlBefore: pre?.url ?? window.location.href,
          domHashBefore: pre?.domHash ?? null,
          // stored so dedup guard works post-completion
          urlAfter: post.url,
          // Captured post-action, before this step is (correctly) recorded complete — lets
          // the dedup guard tell "still in this step's own post-completion state" apart
          // from "something new happened since" (see the guard's comment for why this
          // matters for a STICKY effect like a menu that stays open across cycles).
          domHashAfter: post.domHash ?? null,
          completedAt: Date.now()
        });
        await _shadowGoalVerify(tabId, "STEP_COMPLETED", isTerminalStep(plannerStep));
        {
          const s26 = await SessionStore.load(tabId);
          const gate = GoalVerifier.shouldComplete(s26?.goalCompletionCriteria);
          if (gate.complete) {
            console.log("[SP:GoalCompletion]", {
              source: "verifier",
              satisfied: true,
              signalsMatched: `${gate.verdict.matchedSignals}/${gate.verdict.totalSignals}`
            });
            applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict, source: "verifier" });
            if (_taskContext) {
              _taskContext.steps.push({ description: step.description });
              _taskContext.currentStep = null;
            }
            await _showGoalCompleteCard(tabId, goal);
            done("goal_complete");
            return;
          }
        }
        if (isTerminalStep(plannerStep)) {
          console.log("[SP:GoalCompletion]", { source: "planner", state: "final_step" });
          applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict });
          if (_taskContext) {
            _taskContext.steps.push({ description: step.description });
            _taskContext.currentStep = null;
          }
          await _showGoalCompleteCard(tabId, goal);
          done("goal_complete");
          return;
        }
        applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
        if (_taskContext) {
          _taskContext.steps.push({ description: step.description });
          _taskContext.currentStep = null;
        }
        executor.advance();
      });
      executor.on("plan:complete", () => {
        if (!expectsNavigation) done("completed");
      });
      executor.start(makeSingleStepPlan(plannerStep, goal));
    });
  }
  async function _bootstrapSession(tabId) {
    const myGen = ++_generation;
    try {
      const session = await SessionStore.load(tabId);
      if (!session) {
        console.log("[SP:V2] No active session \u2014 waiting for user input");
        return;
      }
      if (_generation !== myGen) return;
      console.log(`[SP:V2] [${ts()}] Resuming: phase=${session.phase} pauseReason=${session.pauseReason ?? "null"} steps=${session.completedSteps.length} goal="${session.goal}"`);
      if (session.phase === "PAUSED") {
        applyEvent(TaskEvent.WORKFLOW_PAUSED);
        await SessionStore.refreshExpiry(tabId);
        if (session.pauseReason === "ambiguous") {
          showAmbiguousBanner(session);
        } else {
          showPausedBanner(session);
        }
        return;
      }
      if (session.phase === "PLANNING") {
        applyEvent(TaskEvent.SESSION_RESUME);
        await _runPlanLoop(tabId, myGen);
        return;
      }
      if (session.phase === "EXECUTING" && session.pendingStep) {
        const currentUrl = window.location.href;
        const { classification } = classifyNavigation(session, currentUrl);
        console.log(`[SP:V2] [${ts()}] Classification: ${classification}  url=${currentUrl}`);
        if (classification === NavClassification.WORKFLOW_NAVIGATION) {
          await SessionStore.completeStep(tabId, buildStepRecord(session.pendingStep));
          if (_generation !== myGen) return;
          applyEvent(TaskEvent.SESSION_RESUME);
          if (isTerminalStep(session.pendingStep)) {
            applyEvent(TaskEvent.PLAN_COMPLETE);
            await _showGoalCompleteCard(tabId, session.goal);
            return;
          }
          await _runPlanLoop(tabId, myGen);
        } else if (classification === NavClassification.REFRESH) {
          const pendingStep = session.pendingStep;
          if (pendingStep?.domHashBefore != null) {
            const currentSnap = capturePageSnapshot("");
            const domChanged = currentSnap.domHash !== pendingStep.domHashBefore;
            console.log(`[SP:V2] REFRESH path: domHashBefore=${pendingStep.domHashBefore} domHashNow=${currentSnap.domHash} domChanged=${domChanged}`);
            if (domChanged) {
              console.log(`[SP:V2] REFRESH: DOM changed since step start \u2014 completing step and replanning`);
              await SessionStore.completeStep(tabId, buildStepRecord(pendingStep));
              if (_generation !== myGen) return;
              applyEvent(TaskEvent.SESSION_RESUME);
              if (isTerminalStep(pendingStep)) {
                applyEvent(TaskEvent.PLAN_COMPLETE);
                await _showGoalCompleteCard(tabId, session.goal);
                return;
              }
              await _runPlanLoop(tabId, myGen);
              return;
            }
          }
          applyEvent(TaskEvent.SESSION_RESUME);
          await _runPlanLoop(tabId, myGen);
        } else {
          await SessionStore.patchSession(tabId, { pauseReason: "navigation" });
          await SessionStore.setPhase(tabId, "PAUSED");
          applyEvent(TaskEvent.WORKFLOW_PAUSED);
          const paused = await SessionStore.load(tabId);
          if (paused) showPausedBanner(paused);
        }
        return;
      }
      if (session.phase === "EXECUTING") {
        console.warn("[SP:V2] EXECUTING with no pendingStep \u2014 recovering to PLANNING");
        await SessionStore.setPhase(tabId, "PLANNING");
        if (_generation !== myGen) return;
        applyEvent(TaskEvent.SESSION_RESUME);
        await _runPlanLoop(tabId, myGen);
      }
    } catch (err) {
      console.error("[SP:V2] Bootstrap error:", err);
    }
  }
  async function _handleClarification(text) {
    if (!_tabId) return;
    hideAmbiguousBanner();
    const session = await SessionStore.load(_tabId);
    if (!session) {
      showStatus("ScreenPilot: Session expired \u2014 please start a new task", "error");
      return;
    }
    const trimmed = text.trim();
    const existing = session.clarifications ?? [];
    const normalizedNew = trimmed.toLowerCase();
    const deduped = existing.filter((c) => c.text.trim().toLowerCase() !== normalizedNew);
    if (trimmed) {
      deduped.push({
        text: trimmed,
        ambiguitySummary: session.ambiguitySummary ?? null,
        addedAt: Date.now()
      });
    }
    const capped = deduped.slice(-MAX_CLARIFICATIONS);
    await SessionStore.patchSession(_tabId, {
      clarifications: capped,
      // Reset consecutive ambiguous counter so the user gets MAX_CONSECUTIVE_AMBIGUOUS
      // fresh attempts with the new clarification context.
      consecutiveAmbiguousCount: 0,
      pauseReason: null,
      ambiguitySummary: null
    });
    await SessionStore.setPhase(_tabId, "PLANNING");
    _state = TaskState.PAUSED;
    applyEvent(TaskEvent.USER_RESUMED);
    const myGen = ++_generation;
    await _runPlanLoop(_tabId, myGen);
  }
  async function _handleResume() {
    if (!_tabId) return;
    hidePausedBanner();
    const session = await SessionStore.load(_tabId);
    if (!session) {
      showStatus("ScreenPilot: Session expired \u2014 please start a new task", "error");
      return;
    }
    if (session.currentBlocker !== null) {
      const { isStuck, reason } = await SessionStore.incrementAuthAttempt(_tabId);
      if (isStuck) {
        _state = TaskState.PAUSED;
        applyEvent(TaskEvent.CANCEL_CLICKED);
        showStatus(`ScreenPilot: Cannot complete \u2014 ${reason}`, "error");
        await SessionStore.clear(_tabId);
        return;
      }
    }
    await SessionStore.clearBlocker(_tabId);
    await SessionStore.patchSession(_tabId, { pauseReason: null });
    await SessionStore.setPhase(_tabId, "PLANNING");
    _state = TaskState.PAUSED;
    applyEvent(TaskEvent.USER_RESUMED);
    const myGen = ++_generation;
    await _runPlanLoop(_tabId, myGen);
  }
  async function _handleStop() {
    if (!_tabId) return;
    hidePausedBanner();
    hideAmbiguousBanner();
    hideStatus();
    _executor?.abort();
    _executor = null;
    ++_generation;
    await SessionStore.clear(_tabId);
    _state = TaskState.PAUSED;
    applyEvent(TaskEvent.CANCEL_CLICKED);
  }
  async function _startNewTask(goal) {
    if (!_tabId) {
      console.error("[SP:V2] Tab ID not resolved \u2014 cannot start task");
      return;
    }
    _executor?.abort();
    _executor = null;
    const myGen = ++_generation;
    hidePausedBanner();
    hideAmbiguousBanner();
    hideStatus();
    _state = TaskState.IDLE;
    _taskContext = { goal, steps: [], startedAt: Date.now() };
    _taskStartedAt = Date.now();
    console.log("[SP:V2] \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    console.log(`[SP:V2] [${ts()}] New task: "${goal}"`);
    console.log(`[SP:V2] [${ts()}] Page: ${window.location.href}`);
    applyEvent(TaskEvent.GOAL_SUBMITTED, { goal });
    await SessionStore.create(_tabId, goal);
    if (_generation !== myGen) return;
    await _runPlanLoop(_tabId, myGen);
  }
  function _abortTask() {
    if (_generation === 0 && _state === TaskState.IDLE) {
      console.log("[SP:V2] No active task");
      return;
    }
    _executor?.abort();
    _executor = null;
    ++_generation;
    hideStatus();
    hidePausedBanner();
    hideAmbiguousBanner();
    if (_tabId) SessionStore.clear(_tabId).catch(() => {
    });
    _state = TaskState.IDLE;
    console.log("[SP:V2] Task aborted");
  }
  var OVERLAY_ID = "sp-v2-overlay";
  function openV2Overlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:2147483646",
      "width:320px",
      "background:#0d0d0d",
      "border-radius:14px",
      "box-shadow:0 8px 40px rgba(0,0,0,0.5)",
      "font-family:system-ui,-apple-system,sans-serif",
      "overflow:hidden"
    ].join(";");
    overlay.innerHTML = `
  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0">
    <span style="font-size:13px;font-weight:600;color:#fff;letter-spacing:0.02em">ScreenPilot</span>
    <button id="sp-v2-close-btn" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;padding:2px 4px">\xD7</button>
  </div>
  <div style="padding:12px 16px 16px">
    <textarea id="sp-v2-goal-input" placeholder="What do you want to do?" rows="3"
      style="width:100%;box-sizing:border-box;background:#161616;border:1px solid rgba(255,255,255,0.1);border-radius:8px;
             color:#fff;font-size:13px;padding:10px 12px;resize:none;outline:none;
             font-family:inherit;line-height:1.5"></textarea>
    <button id="sp-v2-start-btn"
      style="margin-top:8px;width:100%;padding:10px;background:#cc2222;color:#fff;border:none;
             border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Start \u2192</button>
  </div>`;
    document.body.appendChild(overlay);
    document.getElementById("sp-v2-close-btn").addEventListener("click", closeV2Overlay);
    const goalInput = document.getElementById("sp-v2-goal-input");
    const startBtn = document.getElementById("sp-v2-start-btn");
    goalInput.focus();
    function submitGoal() {
      const goal = goalInput.value.trim();
      if (!goal) return;
      closeV2Overlay();
      _startNewTask(goal);
    }
    startBtn.addEventListener("click", submitGoal);
    goalInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitGoal();
    });
  }
  function closeV2Overlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "START_V2_TASK") return false;
    openV2Overlay();
    sendResponse({ success: true });
    return false;
  });
  chrome.runtime.sendMessage({ type: "GET_TAB_ID" }).then((resp) => {
    if (!resp?.tabId) {
      console.warn("[SP:V2] Could not resolve tab ID \u2014 cross-page resume disabled");
      return;
    }
    _tabId = resp.tabId;
    console.log(`[SP:V2] Tab ID: ${_tabId}`);
    return _bootstrapSession(_tabId);
  }).catch((err) => {
    console.warn("[SP:V2] Bootstrap failed:", err);
  });
  window.__SP_V2_RUN = (goal) => _startNewTask(goal);
  window.__SP_V2_ABORT = _abortTask;
  function __getState() {
    return _state;
  }
  function __getGeneration() {
    return _generation;
  }
  function __resetState() {
    _state = TaskState.IDLE;
    _generation = 0;
  }
  function __setTabId(id) {
    _tabId = id;
  }
  console.log('[SP:V2] Ready \u2014 popup: "Open ScreenPilot"  console: __SP_V2_RUN("goal")');
})();
