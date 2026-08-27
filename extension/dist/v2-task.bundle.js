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
      if (++count >= 60) break;
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
    constructor({ domMatcher, highlighter, captureSnapshot = capturePageSnapshot } = {}) {
      if (!domMatcher) throw new TypeError("ExecutorEngine: domMatcher is required");
      if (!highlighter) throw new TypeError("ExecutorEngine: highlighter is required");
      this._domMatcher = domMatcher;
      this._highlighter = highlighter;
      this._captureSnapshot = captureSnapshot;
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
      const resolved = this._resolveElement(step);
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
     * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
     */
    async plan() {
      throw new Error(`${this.name} must implement plan(request)`);
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
     * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
     */
    async plan(request) {
      return this._post("/api/plan", request);
    }
    /**
     * Request a corrected step or full replan after execution diverged.
     * Calls POST /api/recover and returns a RecoverResponse.
     *
     * @param {import('../shared/types/index.js').RecoverRequest} request
     * @returns {Promise<import('../shared/types/index.js').RecoverResponse>}
     */
    async recover(request) {
      return this._post("/api/recover", request);
    }
    /**
     * Explain what is currently visible on screen.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, pageContext: object }} request
     * @returns {Promise<{ success: boolean, screenContext?: object, error?: string }>}
     */
    async explain({ screenshot, pageContext = {} }) {
      return this._post("/api/analyze", {
        screenshot,
        pageContext,
        goal: "Explain what is visible on this screen",
        mode: "explain"
      });
    }
    /**
     * Answer a question about the current screen.
     *
     * @param {{ screenshot: { image: string, mimeType: string }, question: string, pageContext: object }} request
     * @returns {Promise<{ success: boolean, answer?: string, confidence?: number, elementHint?: string, error?: string }>}
     */
    async ask({ screenshot, question, pageContext = {} }) {
      return this._post("/api/analyze", {
        screenshot,
        goal: question,
        pageContext,
        mode: "ask"
      });
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
     * @returns {Promise<object>}
     */
    async _post(path, body) {
      const headers = {
        "Content-Type": "application/json",
        "X-Session-ID": this._sessionId
      };
      if (this._apiKey) headers["X-OpenRouter-Key"] = this._apiKey;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3e4);
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
        const isTimeout = err instanceof Error && err.name === "AbortError";
        const message = isTimeout ? `Request to ${path} timed out after 30s` : err instanceof Error ? err.message : String(err);
        const errorCode = isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
        console.error(`[VercelBackendAdapter] ${isTimeout ? "Timeout" : "Network error"} on ${path}:`, message);
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

  // extension/services/goal-verifier.js
  function normalize(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
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
      const name = normalize(
        el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || ""
      );
      if (name.includes(needle)) return true;
    }
    for (const el of doc.querySelectorAll('a,button,[role="button"],[role="link"],h1,h2,h3,summary,li,td,strong,span')) {
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
  var GoalVerifier = {
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
          if (!criteria) return { complete: false, reason: "no_criteria", verdict: null };
          if (criteria.requiresEffect !== true) return { complete: false, reason: "no_effect_contract", verdict: null };
          const verdict = this.evaluate(criteria, env);
          if (!verdict.satisfied) return { complete: false, reason: "unsatisfied", verdict };
          if (typeof criteria.confidenceThreshold === "number" && verdict.totalSignals > 0 && verdict.matchedSignals / verdict.totalSignals < criteria.confidenceThreshold) {
            return { complete: false, reason: "below_confidence_threshold", verdict };
          }
          return { complete: true, reason: "signals_satisfied", verdict };
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
    return {
      description: pendingStep.description,
      intent: pendingStep.intent,
      completionCondition: pendingStep.completionCondition,
      urlBefore: pendingStep.urlBefore,
      domHashBefore: pendingStep.domHashBefore ?? null,
      // carry through for dedup guard
      urlAfter: window.location.href,
      completedAt: Date.now()
    };
  }
  function toExecutorStep(plannerStep) {
    return { ...plannerStep, expectedOutcome: plannerStep.expectedPageState };
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
  async function _runPlanLoop(tabId, myGen) {
    const storage = getStorageArea2();
    const { openRouterApiKey } = storage ? await storage.get("openRouterApiKey") : { openRouterApiKey: void 0 };
    const adapter = new VercelBackendAdapter({ apiKey: openRouterApiKey ?? void 0 });
    let planRetryCount = 0;
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
        const gate = GoalVerifier.shouldComplete(session.goalCompletionCriteria);
        if (gate.complete) {
          console.log("[SP:GoalCompletion]", {
            source: "verifier",
            satisfied: true,
            signalsMatched: `${gate.verdict.matchedSignals}/${gate.verdict.totalSignals}`
          });
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
      showStatus("ScreenPilot \xB7 Planning\u2026", "planning");
      let screenshot;
      try {
        screenshot = await captureScreenshot();
      } catch (err) {
        console.error("[SP:V2] Screenshot failed:", err);
        applyEvent(TaskEvent.PLAN_FAILED, { reason: "screenshot_failed" });
        showStatus(`ScreenPilot: Screenshot error \u2014 ${err.message}`, "error");
        await SessionStore.clear(tabId);
        return;
      }
      if (_generation !== myGen) return;
      const freshSession = await SessionStore.load(tabId);
      if (!freshSession) {
        hideStatus();
        return;
      }
      if (_generation !== myGen) return;
      const nClarifications = freshSession.clarifications?.length ?? 0;
      const pageControls = collectPageControls();
      console.log(`[SP:V2] [${ts()}] /api/plan  step=${freshSession.completedSteps.length + 1}  url=${window.location.href}  clarifications=${nClarifications}  pageControls=${pageControls.length}`);
      let planResp;
      try {
        planResp = await adapter.plan({
          schemaVersion: "1",
          requestId: crypto.randomUUID(),
          goal: freshSession.goal,
          page: {
            url: window.location.href,
            title: document.title,
            screenshot: { image: screenshot.image, mimeType: screenshot.mimeType }
          },
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
          ...nClarifications && {
            clarifications: freshSession.clarifications.map((c) => c.text)
          },
          ...pageControls.length && { pageControls }
        });
      } catch (err) {
        console.error("[SP:V2] /api/plan failed:", err);
        applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
        showStatus(`ScreenPilot: Network error \u2014 ${err.message}`, "error");
        await SessionStore.clear(tabId);
        return;
      }
      if (_generation !== myGen) return;
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
      applyEvent(TaskEvent.PLAN_RECEIVED, { intent: plannerStep.intent });
      {
        const latestCompleted = freshSession.completedSteps[freshSession.completedSteps.length - 1];
        if (latestCompleted && latestCompleted.intent === plannerStep.intent) {
          const currentSnap = capturePageSnapshot("");
          const urlSame = currentSnap.url === latestCompleted.urlBefore;
          let domHashSame;
          if (latestCompleted.domHashBefore != null) {
            domHashSame = currentSnap.domHash === latestCompleted.domHashBefore;
          } else if (freshSession.pendingStep?.domHashBefore != null) {
            domHashSame = currentSnap.domHash === freshSession.pendingStep.domHashBefore;
          } else {
            domHashSame = false;
          }
          console.log(`[SP:V2] Dedup check: intent="${plannerStep.intent}" urlSame=${urlSame} domHashSame=${domHashSame} currentDomHash=${currentSnap.domHash} baselineDomHash=${latestCompleted.domHashBefore ?? freshSession.pendingStep?.domHashBefore ?? "none"}`);
          if (urlSame && domHashSame) {
            console.warn(
              `[SP:V2] Dedup guard FIRED: planner returned same intent="${plannerStep.intent}" as last completed step with identical page state \u2014 page did not change after that action`
            );
            const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
            if (isStuck) {
              applyEvent(TaskEvent.PLAN_FAILED, { reason });
              showStatus(`ScreenPilot: ${reason}`, "error");
              await SessionStore.clear(tabId);
              return;
            }
            await new Promise((r) => setTimeout(r, 500));
            continue;
          } else {
            console.log(`[SP:V2] Dedup check PASSED: same intent but page state changed (urlSame=${urlSame} domHashSame=${domHashSame}) \u2014 allowing re-execution`);
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
          }, 800);
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
      const expectsNavigation = plannerStep.expectedPageState?.urlChanges === true;
      let resolved = false;
      function done(result) {
        if (resolved) return;
        resolved = true;
        if (_executor === executor) _executor = null;
        resolve(result);
      }
      executor.on("element:ready", async ({ step }) => {
        applyEvent(TaskEvent.ELEMENT_READY, { intent: plannerStep.intent });
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
        await new Promise((r) => setTimeout(r, 600));
        if (_generation !== myGen) {
          done("aborted");
          return;
        }
        const pre = executor.getPreActionSnapshot();
        const post = capturePageSnapshot("");
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
