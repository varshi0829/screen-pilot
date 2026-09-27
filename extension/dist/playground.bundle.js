"use strict";
(() => {
  // extension/lib/pii-detector.js
  var SensitiveType = Object.freeze({
    PASSWORD: "password",
    OTP: "otp",
    EMAIL: "email",
    PHONE: "phone",
    CREDIT_CARD: "credit_card",
    SSN: "ssn",
    BANK_ACCOUNT: "bank_account",
    ADDRESS: "address",
    DATE_OF_BIRTH: "date_of_birth",
    JWT: "jwt",
    API_KEY: "api_key",
    SECRET: "secret"
  });
  var T = SensitiveType;
  var INPUT_TYPE_MAP = {
    password: T.PASSWORD,
    email: T.EMAIL,
    tel: T.PHONE
  };
  var AUTOCOMPLETE_MAP = {
    "current-password": T.PASSWORD,
    "new-password": T.PASSWORD,
    "one-time-code": T.OTP,
    "cc-number": T.CREDIT_CARD,
    "cc-csc": T.CREDIT_CARD,
    "cc-exp": T.CREDIT_CARD,
    "cc-exp-month": T.CREDIT_CARD,
    "cc-exp-year": T.CREDIT_CARD,
    "cc-name": T.CREDIT_CARD,
    "email": T.EMAIL,
    "tel": T.PHONE,
    "tel-national": T.PHONE,
    "street-address": T.ADDRESS,
    "address-line1": T.ADDRESS,
    "address-line2": T.ADDRESS,
    "postal-code": T.ADDRESS,
    "bday": T.DATE_OF_BIRTH,
    "ssn": T.SSN
  };
  var LABEL_RULES = [
    [/\b(?:password|passcode)\b/i, T.PASSWORD],
    [/\b(?:otp|one[- ]time[- ]code)\b/i, T.OTP],
    [/\b(?:cvv|cvc|security\s*code|card\s*number|credit\s*card|debit\s*card)\b/i, T.CREDIT_CARD],
    [/\b(?:ssn|social\s*security)\b/i, T.SSN],
    [/\b(?:routing\s*number|account\s*number|iban)\b/i, T.BANK_ACCOUNT],
    [/\b(?:api\s*key|secret\s*key|private\s*key|client\s*secret)\b/i, T.API_KEY],
    [/\b(?:auth\s*token|access\s*token|pin\s*code)\b/i, T.SECRET]
  ];
  function byInputType(type) {
    return INPUT_TYPE_MAP[String(type || "").toLowerCase()] ?? null;
  }
  function byAutocomplete(autocomplete) {
    return AUTOCOMPLETE_MAP[String(autocomplete || "").toLowerCase()] ?? null;
  }
  function byLabel(...strings) {
    for (const raw of strings) {
      if (typeof raw !== "string" || !raw) continue;
      const s = raw.replace(/[_-]+/g, " ");
      for (const [re, type] of LABEL_RULES) {
        if (re.test(s)) return type;
      }
    }
    return null;
  }
  var JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
  var API_KEY_RES = [
    /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
    // OpenAI / OpenRouter / Anthropic style
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    // Google API key
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    // Slack
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    // AWS access key id
    /\bglpat-[A-Za-z0-9_-]{20,}/g,
    // GitLab
    /\bnpm_[A-Za-z0-9]{36}\b/g,
    // npm
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g
    // Authorization header value
  ];
  var PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
  var ASSIGNMENT_RE = /\b(pass(?:word|wd)?|pwd|secret|client[_-]?secret|api[_-]?key|(?:access|auth|refresh|id)[_-]?token|token)\b\s*[:=]\s*["']?([^\s"'&;,<>]{6,})/gid;
  var SPOKEN_PASSWORD_RE = /\b(password|passcode|passwd)\s+is\s+["']?([^\s"'&;,<>]{4,})/gid;
  var CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
  var SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
  var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var PHONE_RES = [
    /(?<![\w])(?:\+?\d{1,2}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
    /(?<![\w])\+\d[\d ()-]{7,15}\d(?!\d)/g
  ];
  function isLuhnValid(digits) {
    const s = String(digits).replace(/\D/g, "");
    if (s.length < 13 || s.length > 19) return false;
    let sum = 0;
    let dbl = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let n = s.charCodeAt(i) - 48;
      if (dbl) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  function assignmentType(keyName) {
    if (/pass|pwd/i.test(keyName)) return T.PASSWORD;
    if (/key/i.test(keyName)) return T.API_KEY;
    return T.SECRET;
  }
  function findPII(text) {
    if (typeof text !== "string" || !text) return [];
    const spans = [];
    const overlaps = (s, e) => spans.some((x) => s < x.end && e > x.start);
    const add = (type, start, end) => {
      if (end > start && !overlaps(start, end)) spans.push({ type, start, end });
    };
    const scan = (re, type, accept) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!accept || accept(m[0])) add(type, m.index, m.index + m[0].length);
        if (m[0].length === 0) re.lastIndex++;
      }
    };
    const scanAssignments = (re, typeOf) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const [start, end] = m.indices[2];
        add(typeOf(m[1]), start, end);
      }
    };
    scan(PRIVATE_KEY_RE, T.SECRET);
    scan(JWT_RE, T.JWT);
    API_KEY_RES.forEach((re) => scan(re, T.API_KEY));
    scanAssignments(ASSIGNMENT_RE, assignmentType);
    scanAssignments(SPOKEN_PASSWORD_RE, () => T.PASSWORD);
    scan(CARD_RE, T.CREDIT_CARD, isLuhnValid);
    scan(SSN_RE, T.SSN);
    scan(EMAIL_RE, T.EMAIL);
    PHONE_RES.forEach((re) => scan(re, T.PHONE));
    return spans.sort((a, b) => a.start - b.start);
  }
  function detectType(text) {
    const spans = findPII(text);
    return spans.length ? spans[0].type : null;
  }
  function classifyElement(el) {
    if (!el) return null;
    return byInputType(el.type) || byAutocomplete(el.autocomplete) || byLabel(el.placeholder, el.ariaLabel, el.name, el.id, el.label) || detectType(el.value) || detectType(el.text) || null;
  }

  // extension/lib/privacy-sanitizer.js
  var REDACTED = "[REDACTED]";
  function isSensitiveElement(el) {
    return classifyElement(el) !== null;
  }
  function sanitizeElement(el) {
    const sensitiveType = classifyElement(el);
    if (!sensitiveType) return el;
    return {
      ...el,
      text: el.text ? REDACTED : el.text,
      value: el.value ? REDACTED : el.value,
      sensitive: true,
      sensitiveType
    };
  }
  function sanitizeElements(elements) {
    if (!Array.isArray(elements)) return elements;
    return elements.map(sanitizeElement);
  }
  function getSensitiveRegions(elements) {
    if (!Array.isArray(elements)) return [];
    return elements.filter(isSensitiveElement).map((el) => el.bbox).filter((bbox) => bbox && bbox.width > 0 && bbox.height > 0);
  }
  var PrivacySanitizer = {
    REDACTED,
    isSensitiveElement,
    getSensitiveType: classifyElement,
    sanitizeElement,
    sanitizeElements,
    getSensitiveRegions
  };
  if (typeof globalThis !== "undefined" && globalThis.module) {
    globalThis.module.exports = PrivacySanitizer;
  }

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
  var FILL_IDLE_MS = 600;
  function valueSatisfies(actual, requested) {
    const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(requested);
    if (!want) return norm(actual).length > 0;
    return norm(actual).includes(want);
  }
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
      elementResolveMaxWaitMs = 2e3,
      // Quiet period before a fill with no requested value counts as finished —
      // injectable so tests need not wait out the real budget.
      fillIdleMs = FILL_IDLE_MS
    } = {}) {
      if (!domMatcher) throw new TypeError("ExecutorEngine: domMatcher is required");
      if (!highlighter) throw new TypeError("ExecutorEngine: highlighter is required");
      this._domMatcher = domMatcher;
      this._highlighter = highlighter;
      this._captureSnapshot = captureSnapshot;
      this._elementResolvePollIntervalMs = elementResolvePollIntervalMs;
      this._elementResolveMaxWaitMs = elementResolveMaxWaitMs;
      this._fillIdleMs = fillIdleMs;
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
        alternatives: step.targetElement?.alternatives,
        elementId: step.targetElement?.elementId,
        bbox: step.targetElement?.bbox
      });
      if (!step.targetElement.text?.trim() && step.targetElement.elementId && step.targetElement.bbox) {
        const positional = this._resolveElementByPosition(step.targetElement);
        if (positional) return positional;
      }
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
      if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
      let element;
      try {
        element = document.elementFromPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      } catch {
        return null;
      }
      if (!element) return null;
      if (this._domMatcher.isDisabled?.(element)) return null;
      if (typeof this._domMatcher.isVisible === "function" && !this._domMatcher.isVisible(element)) return null;
      console.log(`[SP:Exec] Resolved by position (no accessible text on target) elementId=${targetElement.elementId} bbox=${JSON.stringify(bbox)} <${element.tagName?.toLowerCase?.() ?? "?"}>`);
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
      const onUserAction = (trigger, observedValue = null) => {
        if (fired) return;
        fired = true;
        this._teardownListeners();
        this._highlighter.clear();
        this._activeElement = null;
        this._emit("user:acted", { step, trigger, observedValue, timestamp: Date.now() });
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
        let fillIdleTimer = null;
        const handleFieldEvent = (e, eventKind) => {
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
          const requested = (step.targetElement?.value ?? "").trim();
          const settle = (reason) => {
            clearTimeout(fillIdleTimer);
            console.log(`[SP:FILL] USER_ACTION_EMITTED reason=${reason} value="${fieldValue(field)}"`);
            onUserAction("input", fieldValue(field));
          };
          if (requested) {
            if (valueSatisfies(fieldValue(field), requested)) settle("requested_value_present");
            return;
          }
          if (eventKind === "change") {
            settle("change_committed");
            return;
          }
          clearTimeout(fillIdleTimer);
          fillIdleTimer = setTimeout(() => settle("typing_idle"), this._fillIdleMs);
        };
        const inputHandler = (e) => handleFieldEvent(e, "input");
        const changeHandler = (e) => handleFieldEvent(e, "change");
        document.addEventListener("input", inputHandler, { capture: true });
        document.addEventListener("change", changeHandler, { capture: true });
        this._cleanups.push(() => {
          clearTimeout(fillIdleTimer);
          document.removeEventListener("input", inputHandler, { capture: true });
          document.removeEventListener("change", changeHandler, { capture: true });
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
     * @param {string} [options.sessionId]  - Session identifier for rate limiting and telemetry
     */
    constructor({ baseUrl = DEFAULT_BASE_URL, sessionId } = {}) {
      super();
      this._baseUrl = baseUrl.replace(/\/$/, "");
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
    function resolveAriaLabelledBy(el, doc) {
      const idList = (el.getAttribute?.("aria-labelledby") || "").trim();
      if (!idList || typeof doc?.getElementById !== "function") return "";
      return idList.split(/\s+/).map((id) => {
        const ref = doc.getElementById(id);
        return ref ? ref.innerText || ref.textContent || "" : "";
      }).filter(Boolean).join(" ");
    }
    function buildLabelForMap(doc) {
      const map = /* @__PURE__ */ new Map();
      if (typeof doc?.querySelectorAll !== "function") return map;
      for (const label of doc.querySelectorAll("label[for]")) {
        const forId = label.getAttribute?.("for");
        if (!forId || map.has(forId)) continue;
        map.set(forId, label.innerText || label.textContent || "");
      }
      return map;
    }
    function resolveLabelFor(el, labelForMap) {
      const id = el.id || el.getAttribute?.("id") || "";
      if (!id || !labelForMap) return "";
      return labelForMap.get(id) || "";
    }
    function resolveAncestorLabel(el) {
      const label = typeof el.closest === "function" ? el.closest("label") : null;
      if (!label || label === el) return "";
      return label.innerText || label.textContent || "";
    }
    function resolveAccessibleName(el, doc, labelForMap = null) {
      const direct = clean(el.getAttribute?.("aria-label") || "");
      if (direct) return direct;
      const labelledBy = clean(resolveAriaLabelledBy(el, doc));
      if (labelledBy) return labelledBy;
      const labelFor = clean(resolveLabelFor(el, labelForMap ?? buildLabelForMap(doc)));
      if (labelFor) return labelFor;
      const ancestorLabel = clean(resolveAncestorLabel(el));
      if (ancestorLabel) return ancestorLabel;
      const title = clean(el.getAttribute?.("title") || "");
      if (title) return title;
      return clean(el.querySelector?.("img[alt]")?.getAttribute?.("alt") || "");
    }
    function resolveFormId(el, formMap) {
      const form = el.form ?? (typeof el.closest === "function" ? el.closest("form") : null);
      if (!form) return null;
      if (!formMap.map.has(form)) formMap.map.set(form, `form_${formMap.count++}`);
      return formMap.map.get(form);
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
      const SP_SEL = '[id^="sp-"],[id^="screenpilot-"],[class*="sp-"],[data-screenpilot]';
      const elements = [];
      let count = 0;
      const seen = /* @__PURE__ */ new Set();
      const formMap = { map: /* @__PURE__ */ new WeakMap(), count: 0 };
      const labelForMap = buildLabelForMap(doc);
      for (const el of rawEls) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.closest?.(SP_SEL)) continue;
        const visible = isVisible(el);
        if (!visible) continue;
        const tag = el.tagName ? el.tagName.toLowerCase() : "div";
        const role = getRole(el);
        const text = clean(el.innerText || el.textContent || "");
        const placeholder = clean(el.getAttribute?.("placeholder") || "");
        const ariaLabel = resolveAccessibleName(el, doc, labelForMap);
        const value = typeof el.value === "string" ? clean(el.value) : "";
        const href = clean(el.getAttribute?.("href") || "", 120);
        const enabled = !el.disabled;
        const region = getRegion(el);
        const type = tag === "input" ? clean(el.getAttribute?.("type") || el.type || "", 20) : "";
        const autocomplete = clean(el.getAttribute?.("autocomplete") || "", 30);
        const formId = resolveFormId(el, formMap);
        const required = Boolean(el.required) || el.getAttribute?.("required") != null;
        if (!text && !placeholder && !ariaLabel && !value && !href && role !== "textbox" && role !== "button") continue;
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
          bbox,
          type,
          autocomplete,
          formId,
          required
        });
        if (count >= 300) break;
      }
      const sanitizedElements = PrivacySanitizer.sanitizeElements(elements);
      const sensitiveRegions = PrivacySanitizer.getSensitiveRegions(elements);
      return {
        url,
        title,
        elements: sanitizedElements,
        sensitiveRegions,
        timestamp: Date.now()
      };
    }
    return { extractPageState, clean, getRole, resolveAccessibleName };
  })();
  if (typeof globalThis !== "undefined" && globalThis.module) {
    globalThis.module.exports = PageStateService;
  }

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

  // extension/playground/playground.js
  var C = {
    bg: "#1e1e1e",
    surface: "#252526",
    border: "#3e3e42",
    muted: "#858585",
    text: "#d4d4d4",
    label: "#9cdcfe",
    value: "#ce9178",
    green: "#4ec94e",
    red: "#f44747",
    yellow: "#dcdcaa",
    blue: "#569cd6",
    teal: "#4ec9b0",
    orange: "#ff8c00",
    purple: "#c586c0"
  };
  var STATE_COLOR = {
    [TaskState.IDLE]: "#5a5a5a",
    [TaskState.PLANNING]: C.blue,
    [TaskState.EXECUTING]: C.purple,
    [TaskState.AWAITING_USER]: C.orange,
    [TaskState.VALIDATING]: C.yellow,
    [TaskState.RECOVERING]: C.red,
    [TaskState.COMPLETE]: C.green,
    [TaskState.ERROR]: C.red
  };
  var S = {
    visible: false,
    taskState: TaskState.IDLE,
    goal: "",
    planResp: null,
    // last full PlanResponse
    plan: null,
    // current ExecutionPlan
    executor: null,
    // active ExecutorEngine
    timeline: [],
    // [{ tsShort, from, to, event, meta }]
    logs: [],
    // structured log records
    stepMode: false,
    advanceResolver: null,
    // set when waiting for manual advance in step mode
    currentStep: null,
    // active PlanStep
    currentStepIdx: -1,
    elementInfo: null,
    // { element, score, reason, tag }
    validatorInfo: null,
    // { verdict, preUrl, postUrl, preDom, postDom }
    snapshot: null,
    // latest PageSnapshot
    goldenResp: null,
    // loaded golden PlanResponse
    savedA: null,
    // saved plan for compare
    savedB: null,
    sections: { planner: true, plan: true, step: true, timeline: true, snapshot: false, tools: false }
  };
  function ts() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function tsShort() {
    const d = /* @__PURE__ */ new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function trunc(s, n = 60) {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n) + "\u2026" : str;
  }
  function addLog(entry) {
    S.logs.push({ ts: ts(), ...entry });
  }
  function applyEvent(event, meta = {}) {
    const from = S.taskState;
    const to = transition(S.taskState, event);
    if (!to) {
      addLog({ type: "invalid_transition", from, event });
      return false;
    }
    S.taskState = to;
    const entry = { tsShort: tsShort(), from, to, event, meta };
    S.timeline.push(entry);
    addLog({ type: "transition", ...entry });
    renderTimeline();
    renderStateBar();
    return true;
  }
  function downloadJSON(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  function injectStyles() {
    if (document.getElementById("sp-pg-styles")) return;
    const style = document.createElement("style");
    style.id = "sp-pg-styles";
    style.textContent = `
    #sp-pg-panel *{box-sizing:border-box;margin:0;padding:0}
    #sp-pg-panel{
      position:fixed;top:0;right:0;width:400px;height:100vh;
      background:${C.bg};color:${C.text};
      font-family:'Consolas','Courier New',ui-monospace,monospace;font-size:11.5px;
      overflow:hidden;display:flex;flex-direction:column;
      z-index:2147483646;box-shadow:-4px 0 24px rgba(0,0,0,.6);
      border-left:1px solid ${C.border};
    }
    #sp-pg-panel.sp-pg-hidden{display:none}
    .sp-pg-header{
      flex-shrink:0;background:${C.surface};padding:8px 12px;
      border-bottom:1px solid ${C.border};display:flex;align-items:center;gap:6px;
    }
    .sp-pg-title{color:${C.teal};font-weight:bold;font-size:12px;flex:1}
    .sp-pg-hbtn{
      background:none;border:1px solid ${C.border};color:${C.text};
      padding:2px 7px;border-radius:3px;cursor:pointer;font-size:11px;
    }
    .sp-pg-hbtn:hover{background:${C.border}}
    .sp-pg-state-bar{
      flex-shrink:0;padding:6px 12px;background:${C.surface};
      border-bottom:1px solid ${C.border};display:flex;align-items:center;gap:8px;
      font-size:11px;
    }
    .sp-pg-chip{
      padding:1px 7px;border-radius:10px;font-size:10.5px;font-weight:bold;
      color:#fff;letter-spacing:.4px;
    }
    .sp-pg-planid{color:${C.muted};font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
    .sp-pg-controls{
      flex-shrink:0;padding:8px 12px;background:${C.surface};
      border-bottom:1px solid ${C.border};display:flex;flex-direction:column;gap:6px;
    }
    .sp-pg-goal-row{display:flex;gap:6px}
    .sp-pg-goal-input{
      flex:1;background:#3c3c3c;border:1px solid ${C.border};color:${C.text};
      padding:4px 8px;border-radius:3px;font-family:inherit;font-size:11.5px;
    }
    .sp-pg-goal-input:focus{outline:1px solid ${C.blue};border-color:${C.blue}}
    .sp-pg-btn{
      background:#0e639c;border:none;color:#fff;
      padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px;
      white-space:nowrap;
    }
    .sp-pg-btn:hover{background:#1177bb}
    .sp-pg-btn:disabled{background:#3a3a3a;color:${C.muted};cursor:not-allowed}
    .sp-pg-btn-sm{
      background:none;border:1px solid ${C.border};color:${C.text};
      padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10.5px;
    }
    .sp-pg-btn-sm:hover{background:${C.border}}
    .sp-pg-btn-danger{background:#6b0000;border:none;color:#ff8080;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px}
    .sp-pg-btn-danger:hover{background:#8b0000}
    .sp-pg-btn-green{background:#0b4a0b;border:none;color:${C.green};padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px}
    .sp-pg-btn-green:hover{background:#0e6b0e}
    .sp-pg-ctrl-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .sp-pg-toggle{display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:${C.label}}
    .sp-pg-body{flex:1;overflow-y:auto;overflow-x:hidden}
    .sp-pg-body::-webkit-scrollbar{width:6px}
    .sp-pg-body::-webkit-scrollbar-track{background:#1e1e1e}
    .sp-pg-body::-webkit-scrollbar-thumb{background:#555;border-radius:3px}
    .sp-pg-section{border-bottom:1px solid ${C.border}}
    .sp-pg-sh{
      padding:7px 12px;cursor:pointer;background:${C.surface};
      display:flex;align-items:center;gap:6px;user-select:none;
    }
    .sp-pg-sh:hover{background:#2a2a2d}
    .sp-pg-sh-arrow{font-size:9px;color:${C.muted};transition:transform .15s;width:10px}
    .sp-pg-sh-arrow.open{transform:rotate(90deg)}
    .sp-pg-sh-title{color:${C.teal};font-size:10.5px;font-weight:bold;letter-spacing:.5px;flex:1}
    .sp-pg-sb{padding:10px 12px;display:flex;flex-direction:column;gap:7px}
    .sp-pg-sb.hidden{display:none}
    .sp-pg-row{display:flex;gap:6px;align-items:flex-start;min-height:16px}
    .sp-pg-lbl{color:${C.label};min-width:90px;flex-shrink:0;font-size:11px}
    .sp-pg-val{color:${C.value};word-break:break-all;line-height:1.4}
    .sp-pg-val.ok{color:${C.green}}
    .sp-pg-val.err{color:${C.red}}
    .sp-pg-val.warn{color:${C.yellow}}
    .sp-pg-summary{color:${C.text};font-style:italic;line-height:1.5;font-size:11px}
    .sp-pg-conf-bar{height:6px;background:#3c3c3c;border-radius:3px;overflow:hidden;width:100%;margin-top:2px}
    .sp-pg-conf-fill{height:100%;border-radius:3px;transition:width .3s}
    .sp-pg-steps{display:flex;flex-direction:column;gap:4px}
    .sp-pg-step{
      padding:5px 8px;border-radius:3px;border:1px solid transparent;
      display:flex;align-items:flex-start;gap:7px;cursor:default;
    }
    .sp-pg-step.active{border-color:${C.orange};background:rgba(255,140,0,.08)}
    .sp-pg-step.done{opacity:.55}
    .sp-pg-step.upcoming{opacity:.75}
    .sp-pg-step-num{color:${C.muted};min-width:20px;font-size:10.5px;flex-shrink:0;padding-top:1px}
    .sp-pg-step-body{flex:1;min-width:0}
    .sp-pg-step-desc{color:${C.text};line-height:1.4;word-break:break-word}
    .sp-pg-step-tgt{color:${C.muted};font-size:10.5px;margin-top:2px}
    .sp-pg-step-hl{
      background:none;border:1px solid ${C.border};color:${C.muted};
      padding:1px 5px;border-radius:2px;cursor:pointer;font-size:10px;flex-shrink:0;
    }
    .sp-pg-step-hl:hover{border-color:${C.teal};color:${C.teal}}
    .sp-pg-tag{
      display:inline-block;padding:0 6px;border-radius:3px;font-size:10px;
      background:#2a3a4a;color:${C.blue};margin-right:3px;margin-top:2px;
    }
    .sp-pg-divider{height:1px;background:${C.border};margin:4px 0}
    .sp-pg-tl{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
    .sp-pg-tl::-webkit-scrollbar{width:4px}
    .sp-pg-tl::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
    .sp-pg-tl-entry{
      padding:3px 6px;border-radius:2px;display:flex;gap:6px;align-items:flex-start;
      font-size:10.5px;border-left:2px solid transparent;
    }
    .sp-pg-tl-entry:hover{background:#2a2a2d}
    .sp-pg-tl-time{color:${C.muted};flex-shrink:0;min-width:84px}
    .sp-pg-tl-arrow{color:${C.border};flex-shrink:0}
    .sp-pg-tl-event{flex:1;word-break:break-word}
    .sp-pg-tl-meta{color:${C.muted};font-size:10px;margin-top:1px}
    .sp-pg-snapshot-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}
    .sp-pg-hash{font-size:10px;color:${C.value};font-family:monospace}
    .sp-pg-tools-grid{display:flex;flex-direction:column;gap:8px}
    .sp-pg-golden-area{
      width:100%;height:90px;background:#2a2a2d;border:1px solid ${C.border};
      color:${C.text};padding:6px;font-family:monospace;font-size:10px;resize:vertical;
      border-radius:3px;
    }
    .sp-pg-golden-area:focus{outline:1px solid ${C.blue}}
    .sp-pg-compare-panel{
      position:fixed;top:0;left:0;right:400px;bottom:0;
      background:${C.bg};z-index:2147483645;overflow:auto;
      padding:20px;border-right:2px solid ${C.teal};
    }
    .sp-pg-compare-col{width:50%;display:inline-block;vertical-align:top;padding-right:20px}
    .sp-pg-compare-col + .sp-pg-compare-col{padding-left:20px;padding-right:0;border-left:1px solid ${C.border}}
    .sp-pg-step-diff-add{color:${C.green}}
    .sp-pg-step-diff-rem{color:${C.red}}
    .sp-pg-step-diff-chg{color:${C.yellow}}
    .sp-pg-advance-btn{
      margin-top:6px;background:#4a2c00;border:1px solid ${C.orange};color:${C.orange};
      padding:5px 14px;border-radius:3px;cursor:pointer;font-size:11px;width:100%;
    }
    .sp-pg-advance-btn:hover{background:#6a3d00}
    .sp-pg-golden-badge{
      display:inline-block;padding:1px 6px;background:#0b3b0b;border:1px solid ${C.green};
      color:${C.green};border-radius:3px;font-size:10px;margin-left:6px;
    }
  `;
    document.head.appendChild(style);
  }
  function createPanel() {
    const div = document.createElement("div");
    div.id = "sp-pg-panel";
    div.className = "sp-pg-hidden";
    div.innerHTML = `
    <div class="sp-pg-header">
      <span class="sp-pg-title">\u{1F9EA} ScreenPilot Playground</span>
      <button class="sp-pg-hbtn" id="sp-pg-export-btn" title="Export logs as JSON">\u2193 Export</button>
      <button class="sp-pg-hbtn" id="sp-pg-close-btn" title="Close">\u2715</button>
    </div>
    <div class="sp-pg-state-bar" id="sp-pg-state-bar">
      <span class="sp-pg-chip" id="sp-pg-state-chip">IDLE</span>
      <span class="sp-pg-planid" id="sp-pg-planid-display">no plan</span>
    </div>
    <div class="sp-pg-controls">
      <div class="sp-pg-goal-row">
        <input class="sp-pg-goal-input" id="sp-pg-goal-input" placeholder='Goal: e.g. "Open GitHub Settings"' />
        <button class="sp-pg-btn" id="sp-pg-run-btn">\u25B6 Run</button>
      </div>
      <div class="sp-pg-ctrl-row">
        <button class="sp-pg-btn-sm" id="sp-pg-replay-btn" disabled>\u21BA Replay</button>
        <button class="sp-pg-btn-danger" id="sp-pg-stop-btn" disabled>\u25A0 Stop</button>
        <button class="sp-pg-btn-sm" id="sp-pg-capture-btn">\u2299 Snapshot</button>
        <label class="sp-pg-toggle">
          <input type="checkbox" id="sp-pg-step-mode-chk" />
          Step Mode
        </label>
      </div>
    </div>
    <div class="sp-pg-body" id="sp-pg-body">
      ${section("planner", "PLANNER", '<div id="sp-pg-planner-content"><span style="color:#858585">Run a goal to see planner output.</span></div>')}
      ${section("plan", "EXECUTION PLAN", '<div id="sp-pg-plan-content"><span style="color:#858585">No plan yet.</span></div>')}
      ${section("step", "CURRENT STEP", '<div id="sp-pg-step-content"><span style="color:#858585">No active step.</span></div>')}
      ${section("timeline", "EVENT TIMELINE", '<div class="sp-pg-tl" id="sp-pg-timeline-list"></div>')}
      ${section("snapshot", "DOM SNAPSHOT", '<div id="sp-pg-snapshot-content"><span style="color:#858585">No snapshot yet.</span></div>', false)}
      ${section("tools", "TOOLS", toolsHTML(), false)}
    </div>
  `;
    document.body.appendChild(div);
    bindEvents(div);
    return div;
  }
  function section(id, title, content, open2 = true) {
    return `
    <div class="sp-pg-section" id="sp-pg-sec-${id}">
      <div class="sp-pg-sh" data-section="${id}">
        <span class="sp-pg-sh-arrow ${open2 ? "open" : ""}">\u25B6</span>
        <span class="sp-pg-sh-title">${title}</span>
      </div>
      <div class="sp-pg-sb ${open2 ? "" : "hidden"}">${content}</div>
    </div>
  `;
  }
  function toolsHTML() {
    return `
    <div class="sp-pg-tools-grid">
      <div>
        <div style="color:${C.label};font-size:10.5px;margin-bottom:5px">Load Golden Response</div>
        <textarea class="sp-pg-golden-area" id="sp-pg-golden-input" placeholder='Paste a saved PlanResponse JSON here and click Load...'></textarea>
        <div style="display:flex;gap:6px;margin-top:5px">
          <button class="sp-pg-btn-sm" id="sp-pg-golden-load-btn">Load</button>
          <button class="sp-pg-btn-sm" id="sp-pg-golden-clear-btn">Clear</button>
          <span id="sp-pg-golden-badge" style="display:none" class="sp-pg-golden-badge">\u25CF Golden loaded</span>
        </div>
      </div>
      <div class="sp-pg-divider"></div>
      <div>
        <div style="color:${C.label};font-size:10.5px;margin-bottom:5px">Compare Plans</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="sp-pg-btn-sm" id="sp-pg-save-a-btn" disabled>Save as A</button>
          <button class="sp-pg-btn-sm" id="sp-pg-save-b-btn" disabled>Save as B</button>
          <button class="sp-pg-btn-sm" id="sp-pg-compare-btn" disabled>Compare A vs B</button>
        </div>
        <div id="sp-pg-compare-status" style="color:${C.muted};font-size:10px;margin-top:5px">No plans saved.</div>
      </div>
    </div>
  `;
  }
  function bindEvents(panel) {
    panel.querySelector("#sp-pg-close-btn").addEventListener("click", close);
    panel.querySelector("#sp-pg-export-btn").addEventListener("click", exportLogs);
    panel.querySelector("#sp-pg-run-btn").addEventListener("click", handleRun);
    panel.querySelector("#sp-pg-replay-btn").addEventListener("click", handleReplay);
    panel.querySelector("#sp-pg-stop-btn").addEventListener("click", handleStop);
    panel.querySelector("#sp-pg-capture-btn").addEventListener("click", handleSnapshot);
    panel.querySelector("#sp-pg-step-mode-chk").addEventListener("change", (e) => {
      S.stepMode = e.target.checked;
    });
    panel.querySelector("#sp-pg-goal-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleRun();
    });
    panel.querySelectorAll(".sp-pg-sh").forEach((sh) => {
      sh.addEventListener("click", () => {
        const id = sh.dataset.section;
        S.sections[id] = !S.sections[id];
        sh.querySelector(".sp-pg-sh-arrow").classList.toggle("open", S.sections[id]);
        sh.nextElementSibling.classList.toggle("hidden", !S.sections[id]);
      });
    });
    panel.querySelector("#sp-pg-golden-load-btn").addEventListener("click", loadGolden);
    panel.querySelector("#sp-pg-golden-clear-btn").addEventListener("click", clearGolden);
    panel.querySelector("#sp-pg-save-a-btn").addEventListener("click", () => saveCompare("A"));
    panel.querySelector("#sp-pg-save-b-btn").addEventListener("click", () => saveCompare("B"));
    panel.querySelector("#sp-pg-compare-btn").addEventListener("click", openCompare);
  }
  function renderStateBar() {
    const chip = document.getElementById("sp-pg-state-chip");
    const planidEl = document.getElementById("sp-pg-planid-display");
    if (!chip) return;
    chip.textContent = S.taskState;
    chip.style.background = STATE_COLOR[S.taskState] ?? C.muted;
    planidEl.textContent = S.plan?.planId ? `planId: ${S.plan.planId.slice(0, 13)}\u2026` : "no plan";
  }
  function renderPlanner() {
    const el = document.getElementById("sp-pg-planner-content");
    if (!el) return;
    const r = S.planResp;
    if (!r) {
      el.innerHTML = '<span style="color:#858585">Run a goal to see planner output.</span>';
      return;
    }
    const resultColor = r.result === "OK" ? C.green : r.result === "NEEDS_USER" ? C.yellow : C.red;
    const stateColor = r.state === "planned" ? C.green : r.state === "blocked" ? C.red : C.yellow;
    const conf = r.confidence ?? 0;
    const confColor = conf >= 0.8 ? C.green : conf >= 0.5 ? C.yellow : C.red;
    const latency = r.providerMetadata?.latencyMs;
    const tokens = r.providerMetadata?.inputTokens != null ? `${r.providerMetadata.inputTokens}in / ${r.providerMetadata.outputTokens ?? "?"}out` : "\u2014";
    const goldenNote = S.goldenResp ? '<span class="sp-pg-golden-badge">\u25CF golden</span>' : "";
    el.innerHTML = `
    <div class="sp-pg-row"><span class="sp-pg-lbl">result</span><span class="sp-pg-val" style="color:${resultColor}">${esc(r.result)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">state</span><span class="sp-pg-val" style="color:${stateColor}">${esc(r.state)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">confidence</span>
      <div style="flex:1">
        <div style="color:${confColor}">${conf.toFixed(2)}</div>
        <div class="sp-pg-conf-bar"><div class="sp-pg-conf-fill" style="width:${Math.round(conf * 100)}%;background:${confColor}"></div></div>
      </div>
    </div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">latency</span><span class="sp-pg-val">${latency != null ? latency + "ms" : "\u2014"} ${goldenNote}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">tokens</span><span class="sp-pg-val">${tokens}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">model</span><span class="sp-pg-val">${esc(r.providerMetadata?.model ?? "\u2014")}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">plannerVer</span><span class="sp-pg-val">${esc(r.providerMetadata?.plannerVersion ?? "\u2014")}</span></div>
    ${r.plannerSummary ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.muted};font-size:10px;margin-bottom:3px">PLANNER SUMMARY</div>
    <div class="sp-pg-summary">${esc(r.plannerSummary)}</div>
    ` : ""}
    ${r.blockers?.length ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.red};font-size:10.5px">Blockers: ${r.blockers.map((b) => esc(b)).join(", ")}</div>
    ` : ""}
    <div class="sp-pg-divider"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="sp-pg-btn-sm" id="sp-pg-save-a-btn2">Save as A</button>
      <button class="sp-pg-btn-sm" id="sp-pg-save-b-btn2">Save as B</button>
    </div>
  `;
    el.querySelector("#sp-pg-save-a-btn2")?.addEventListener("click", () => saveCompare("A"));
    el.querySelector("#sp-pg-save-b-btn2")?.addEventListener("click", () => saveCompare("B"));
  }
  function renderPlan() {
    const el = document.getElementById("sp-pg-plan-content");
    if (!el) return;
    const plan = S.plan;
    if (!plan) {
      el.innerHTML = '<span style="color:#858585">No plan yet.</span>';
      return;
    }
    const steps = plan.steps ?? [];
    const rows = steps.map((step, i) => {
      const isDone = i < S.currentStepIdx;
      const isActive = i === S.currentStepIdx;
      const cls = isDone ? "done" : isActive ? "active" : "upcoming";
      const icon = isDone ? `<span style="color:${C.green}">\u2713</span>` : isActive ? `<span style="color:${C.orange}">\u25B6</span>` : `<span style="color:${C.muted}">${i + 1}</span>`;
      const tgtText = step.targetElement?.text ? `"${esc(trunc(step.targetElement.text, 35))}"` : `<span style="color:${C.red}">(null)</span>`;
      return `
      <div class="sp-pg-step ${cls}">
        <span class="sp-pg-step-num">${icon}</span>
        <div class="sp-pg-step-body">
          <div class="sp-pg-step-desc">${esc(step.description)}</div>
          <div class="sp-pg-step-tgt">target: ${tgtText}
            <span class="sp-pg-tag">${esc(step.completionCondition)}</span>
          </div>
        </div>
        <button class="sp-pg-step-hl" data-step="${i}" title="Highlight this element">\u2299</button>
      </div>
    `;
    }).join("");
    el.innerHTML = `
    <div class="sp-pg-row">
      <span class="sp-pg-lbl">goal</span>
      <span class="sp-pg-val">${esc(trunc(plan.goal, 50))}</span>
    </div>
    <div class="sp-pg-row">
      <span class="sp-pg-lbl">planId</span>
      <span class="sp-pg-val" style="font-size:10px">${esc(plan.planId)}</span>
    </div>
    <div class="sp-pg-row">
      <span class="sp-pg-lbl">steps</span>
      <span class="sp-pg-val">${steps.length} \xB7 step ${S.currentStepIdx + 1}/${steps.length} active</span>
    </div>
    <div class="sp-pg-divider"></div>
    <div class="sp-pg-steps">${rows}</div>
  `;
    el.querySelectorAll(".sp-pg-step-hl").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.step);
        const step = plan.steps[i];
        if (step) highlightStepElement(step);
      });
    });
  }
  function renderCurrentStep() {
    const el = document.getElementById("sp-pg-step-content");
    if (!el) return;
    const step = S.currentStep;
    if (!step) {
      el.innerHTML = '<span style="color:#858585">No active step.</span>';
      return;
    }
    const tgt = step.targetElement ?? {};
    const info = S.elementInfo;
    const val = S.validatorInfo;
    const elHTML = info ? `
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.tag</span><span class="sp-pg-val">${esc(info.tag)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.score</span><span class="sp-pg-val" style="color:${info.score >= 80 ? C.green : info.score >= 60 ? C.yellow : C.red}">${info.score}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.match</span><span class="sp-pg-val">${esc(trunc(info.reason, 50))}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.html</span><span class="sp-pg-val" style="font-size:10px">${esc(trunc(info.outerHTML, 80))}</span></div>
  ` : `<div class="sp-pg-row"><span class="sp-pg-lbl">element</span><span class="sp-pg-val err">not resolved yet</span></div>`;
    const valHTML = val ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">VALIDATOR</div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">verdict</span><span class="sp-pg-val ${val.verdict === "PASSED" ? "ok" : "warn"}">${esc(val.verdict)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">url</span><span class="sp-pg-val" style="font-size:10px">${esc(trunc(val.preUrl, 28))} \u2192 ${esc(trunc(val.postUrl, 28))}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">domHash</span><span class="sp-pg-val sp-pg-hash">${esc(val.preDom)} \u2192 ${esc(val.postDom)}</span></div>
  ` : "";
    const advBtn = S.stepMode && S.advanceResolver ? `
    <button class="sp-pg-advance-btn" id="sp-pg-advance-btn">Advance to next step \u2192</button>
  ` : "";
    el.innerHTML = `
    <div class="sp-pg-row">
      <span class="sp-pg-lbl">step</span>
      <span class="sp-pg-val">${S.currentStepIdx + 1} / ${S.plan?.steps?.length ?? "?"} \u2014 ${esc(step.description)}</span>
    </div>
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">TARGET ELEMENT</div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">text</span><span class="sp-pg-val ${tgt.text ? "" : "err"}">${tgt.text ? `"${esc(tgt.text)}"` : "(null \u2014 will fail)"}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">type</span><span class="sp-pg-val">${esc(tgt.type ?? "\u2014")}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">region</span><span class="sp-pg-val">${esc(tgt.region ?? "\u2014")}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">intent</span><span class="sp-pg-val">${esc(tgt.intent ?? "\u2014")}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">alts</span><span class="sp-pg-val">${(tgt.alternatives ?? []).map((a) => `"${esc(a)}"`).join(", ") || "\u2014"}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">completion</span><span class="sp-pg-val">${esc(step.completionCondition)}</span></div>
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">RESOLVED ELEMENT</div>
    ${elHTML}
    ${valHTML}
    ${advBtn}
  `;
    if (S.stepMode && S.advanceResolver) {
      document.getElementById("sp-pg-advance-btn")?.addEventListener("click", () => {
        if (S.advanceResolver) {
          S.advanceResolver();
          S.advanceResolver = null;
          renderCurrentStep();
        }
      });
    }
  }
  function renderTimeline() {
    const el = document.getElementById("sp-pg-timeline-list");
    if (!el) return;
    const entries = S.timeline.slice(-60);
    el.innerHTML = entries.map((e) => {
      const color = STATE_COLOR[e.to] ?? C.muted;
      const meta = Object.entries(e.meta ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
      return `
      <div class="sp-pg-tl-entry" style="border-left-color:${color}">
        <span class="sp-pg-tl-time">${esc(e.tsShort)}</span>
        <span class="sp-pg-tl-arrow">\u2192</span>
        <div class="sp-pg-tl-event">
          <span style="color:${color}">${esc(e.to)}</span>
          <span style="color:${C.muted}"> (${esc(e.event)})</span>
          ${meta ? `<div class="sp-pg-tl-meta">${esc(meta)}</div>` : ""}
        </div>
      </div>
    `;
    }).join("");
    el.scrollTop = el.scrollHeight;
  }
  function renderSnapshot() {
    const el = document.getElementById("sp-pg-snapshot-content");
    if (!el) return;
    const snap = S.snapshot;
    if (!snap) {
      el.innerHTML = '<span style="color:#858585">No snapshot. Click "\u2299 Snapshot" to capture.</span>';
      return;
    }
    const interactiveCount = document.querySelectorAll(
      'button,a,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[aria-label]'
    ).length;
    el.innerHTML = `
    <div class="sp-pg-snapshot-grid">
      <div><div class="sp-pg-lbl">url</div><div class="sp-pg-val" style="font-size:10px;word-break:break-all">${esc(snap.url)}</div></div>
      <div><div class="sp-pg-lbl">title</div><div class="sp-pg-val" style="font-size:10px">${esc(trunc(snap.title, 40))}</div></div>
      <div><div class="sp-pg-lbl">domHash</div><div class="sp-pg-hash">0x${(snap.domHash >>> 0).toString(16).toUpperCase().padStart(8, "0")}</div></div>
      <div><div class="sp-pg-lbl">captured</div><div class="sp-pg-val">${new Date(snap.capturedAt).toLocaleTimeString()}</div></div>
      <div><div class="sp-pg-lbl">interactive</div><div class="sp-pg-val">${interactiveCount} elements</div></div>
    </div>
  `;
  }
  function renderControls(running) {
    const runBtn = document.getElementById("sp-pg-run-btn");
    const stopBtn = document.getElementById("sp-pg-stop-btn");
    const replayBtn = document.getElementById("sp-pg-replay-btn");
    const saveABtn = document.getElementById("sp-pg-save-a-btn");
    const saveBBtn = document.getElementById("sp-pg-save-b-btn");
    if (!runBtn) return;
    runBtn.disabled = running;
    stopBtn.disabled = !running;
    replayBtn.disabled = !S.goal;
    if (saveABtn) saveABtn.disabled = !S.planResp;
    if (saveBBtn) saveBBtn.disabled = !S.planResp;
  }
  function renderAll() {
    renderStateBar();
    renderPlanner();
    renderPlan();
    renderCurrentStep();
    renderTimeline();
    renderSnapshot();
  }
  async function handleRun() {
    const input = document.getElementById("sp-pg-goal-input");
    const goal = input?.value?.trim();
    if (!goal) {
      input?.focus();
      return;
    }
    await runWorkflow(goal);
  }
  async function handleReplay() {
    if (S.goal) await runWorkflow(S.goal);
  }
  function handleStop() {
    S.executor?.abort();
    S.executor = null;
    S.advanceResolver = null;
    S.taskState = TaskState.IDLE;
    addLog({ type: "stopped", ts: ts() });
    renderStateBar();
    renderControls(false);
  }
  async function handleSnapshot() {
    S.snapshot = capturePageSnapshot("");
    renderSnapshot();
    if (!S.sections.snapshot) {
      S.sections.snapshot = true;
      document.querySelector('[data-section="snapshot"]')?.nextElementSibling.classList.remove("hidden");
      document.querySelector('[data-section="snapshot"] .sp-pg-sh-arrow')?.classList.add("open");
    }
  }
  async function runWorkflow(goal) {
    if (S.executor) {
      S.executor.abort();
      S.executor = null;
    }
    S.goal = goal;
    S.taskState = TaskState.IDLE;
    S.plan = null;
    S.planResp = null;
    S.timeline = [];
    S.logs = [];
    S.currentStep = null;
    S.currentStepIdx = -1;
    S.elementInfo = null;
    S.validatorInfo = null;
    S.advanceResolver = null;
    renderControls(true);
    renderAll();
    applyEvent(TaskEvent.GOAL_SUBMITTED, { goal });
    let screenshotImage, screenshotMime;
    try {
      const { sensitiveRegions } = PageStateService.extractPageState();
      const resp = await chrome.runtime.sendMessage({
        type: "CAPTURE_SCREENSHOT",
        sensitiveRegions,
        devicePixelRatio: window.devicePixelRatio || 1
      });
      if (!resp?.success) throw new Error(resp?.error ?? "Screenshot capture failed");
      screenshotImage = resp.image;
      screenshotMime = resp.mimeType ?? "image/png";
      addLog({ type: "screenshot", imageLen: screenshotImage.length, mime: screenshotMime });
    } catch (err) {
      addLog({ type: "screenshot_error", error: err.message });
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "screenshot_failed" });
      renderControls(false);
      return;
    }
    let planResp;
    if (S.goldenResp) {
      planResp = S.goldenResp;
      addLog({ type: "golden_response_used", planId: planResp.plan?.planId });
    } else {
      const adapter = new VercelBackendAdapter();
      const t0 = Date.now();
      addLog({ type: "planner_request", goal, url: window.location.href });
      try {
        planResp = await adapter.plan({
          schemaVersion: "1",
          requestId: crypto.randomUUID(),
          goal,
          page: {
            url: window.location.href,
            title: document.title,
            screenshot: { image: screenshotImage, mimeType: screenshotMime }
          },
          preferences: { confirmDestructiveActions: false, maxSteps: 10 }
        });
        addLog({ type: "planner_response", latency: Date.now() - t0, result: planResp.result, state: planResp.state, planId: planResp.plan?.planId });
      } catch (err) {
        addLog({ type: "planner_error", error: err.message });
        applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
        renderControls(false);
        return;
      }
    }
    S.planResp = planResp;
    if (planResp.result !== "OK" || !planResp.plan) {
      applyEvent(TaskEvent.PLAN_FAILED, { result: planResp.result });
      renderControls(false);
      renderPlanner();
      return;
    }
    const plan = planResp.plan;
    S.plan = plan;
    S.currentStepIdx = 0;
    applyEvent(TaskEvent.PLAN_RECEIVED, { planId: plan.planId, steps: plan.steps.length });
    renderPlanner();
    renderPlan();
    if (!window.DOMMatcher) {
      addLog({ type: "error", message: "window.DOMMatcher missing \u2014 dom-matcher.js not loaded" });
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "no_dom_matcher" });
      renderControls(false);
      return;
    }
    const highlighter = window.__SP_Highlighter ?? makeFallbackHighlighter();
    const executor = new ExecutorEngine({
      domMatcher: window.DOMMatcher,
      highlighter,
      captureSnapshot: capturePageSnapshot
    });
    S.executor = executor;
    executor.on("element:ready", ({ step, element, snapshot }) => {
      const idx = plan.steps.indexOf(step);
      S.currentStepIdx = idx;
      S.currentStep = step;
      S.validatorInfo = null;
      S.elementInfo = {
        tag: element?.tagName?.toLowerCase() ?? "?",
        score: snapshot?.score ?? (S.plan && window.DOMMatcher ? resolveScore(step) : 0),
        reason: snapshot?.reason ?? "\u2014",
        outerHTML: element?.outerHTML?.slice(0, 120) ?? "\u2014"
      };
      const match = window.DOMMatcher.matchElement(step.targetElement);
      if (match) S.elementInfo = { tag: element?.tagName?.toLowerCase() ?? "?", score: match.score, reason: match.reason, outerHTML: element?.outerHTML?.slice(0, 120) ?? "\u2014" };
      applyEvent(TaskEvent.ELEMENT_READY, { step: `${idx + 1}/${plan.steps.length}`, target: step.targetElement?.text ?? "(null)" });
      addLog({ type: "element_ready", stepIdx: idx, target: step.targetElement, elementTag: S.elementInfo.tag, score: S.elementInfo.score });
      renderPlan();
      renderCurrentStep();
    });
    executor.on("element:not_found", ({ step, reason, isOptional }) => {
      const idx = plan.steps.indexOf(step);
      addLog({ type: "element_not_found", stepIdx: idx, reason, target: step.targetElement, isOptional });
      if (!isOptional) {
        applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { step: idx + 1, reason });
      }
      S.currentStepIdx = idx;
      S.currentStep = step;
      S.elementInfo = null;
      renderPlan();
      renderCurrentStep();
    });
    executor.on("user:acted", async ({ step, trigger }) => {
      const idx = plan.steps.indexOf(step);
      const isFinal = idx === plan.steps.length - 1;
      applyEvent(TaskEvent.USER_ACTED, { step: idx + 1, trigger });
      addLog({ type: "user_acted", stepIdx: idx, trigger });
      await new Promise((r) => setTimeout(r, 800));
      const pre = executor.getPreActionSnapshot();
      const post = capturePageSnapshot("");
      S.snapshot = post;
      const verdict = pre && post ? post.url !== pre.url || post.domHash !== pre.domHash ? "PASSED" : "INCONCLUSIVE" : "INCONCLUSIVE";
      S.validatorInfo = {
        verdict,
        preUrl: pre?.url ?? "\u2014",
        postUrl: post.url,
        preDom: (pre?.domHash >>> 0).toString(16).toUpperCase().padStart(8, "0"),
        postDom: (post.domHash >>> 0).toString(16).toUpperCase().padStart(8, "0")
      };
      addLog({ type: "validation", verdict, stepIdx: idx, isFinal });
      if (isFinal) {
        applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict });
      } else {
        applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
      }
      renderCurrentStep();
      renderSnapshot();
      if (S.stepMode) {
        await new Promise((resolve) => {
          S.advanceResolver = resolve;
        });
        renderCurrentStep();
      }
      executor.advance();
    });
    executor.on("step:skipped", ({ step }) => {
      const idx = plan.steps.indexOf(step);
      addLog({ type: "step_skipped", stepIdx: idx });
      S.currentStepIdx = idx;
      renderPlan();
    });
    executor.on("plan:complete", ({ plan: completedPlan, completedAt }) => {
      const elapsed = completedAt - plan.createdAt;
      addLog({ type: "plan_complete", planId: completedPlan.planId, elapsed, finalState: S.taskState });
      S.executor = null;
      renderPlan();
      renderControls(false);
      renderStateBar();
    });
    addLog({ type: "executor_start", planId: plan.planId });
    executor.start(plan);
  }
  function resolveScore(step) {
    const match = window.DOMMatcher?.matchElement(step.targetElement);
    return match?.score ?? 0;
  }
  function highlightStepElement(step) {
    const match = window.DOMMatcher?.matchElement(step.targetElement);
    if (!match?.element) {
      addLog({ type: "highlight_debug", target: step.targetElement, result: "not_found" });
      return;
    }
    const hl = window.__SP_Highlighter ?? makeFallbackHighlighter();
    hl.show(match.element, `[Playground] ${step.description}`);
    addLog({ type: "highlight_debug", target: step.targetElement, score: match.score, reason: match.reason });
  }
  function makeFallbackHighlighter() {
    let _el = null;
    return {
      async show(element) {
        if (_el) {
          _el.style.outline = "";
        }
        if (!element) return false;
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.style.outline = "3px solid #4ec9b0";
        _el = element;
        return true;
      },
      clear() {
        if (_el) {
          _el.style.outline = "";
          _el = null;
        }
      }
    };
  }
  function exportLogs() {
    const payload = {
      exportedAt: ts(),
      goal: S.goal,
      planId: S.plan?.planId ?? null,
      finalState: S.taskState,
      planResponse: S.planResp,
      timeline: S.timeline,
      logs: S.logs
    };
    downloadJSON(payload, `sp-playground-${Date.now()}.json`);
    addLog({ type: "export", ts: ts() });
  }
  function loadGolden() {
    const textarea = document.getElementById("sp-pg-golden-input");
    if (!textarea?.value?.trim()) return;
    try {
      const parsed = JSON.parse(textarea.value.trim());
      if (!parsed.plan || !parsed.result) throw new Error("Missing plan or result field");
      S.goldenResp = parsed;
      document.getElementById("sp-pg-golden-badge").style.display = "inline-block";
      addLog({ type: "golden_loaded", planId: parsed.plan?.planId });
    } catch (err) {
      alert(`Invalid PlanResponse JSON: ${err.message}`);
    }
  }
  function clearGolden() {
    S.goldenResp = null;
    document.getElementById("sp-pg-golden-input").value = "";
    document.getElementById("sp-pg-golden-badge").style.display = "none";
    addLog({ type: "golden_cleared" });
  }
  function saveCompare(slot) {
    if (!S.planResp) return;
    if (slot === "A") S.savedA = { resp: S.planResp, goal: S.goal };
    else S.savedB = { resp: S.planResp, goal: S.goal };
    const statusEl = document.getElementById("sp-pg-compare-status");
    const compareBtn = document.getElementById("sp-pg-compare-btn");
    if (statusEl) statusEl.textContent = `A: ${S.savedA?.goal ?? "\u2014"}   B: ${S.savedB?.goal ?? "\u2014"}`;
    if (compareBtn) compareBtn.disabled = !(S.savedA && S.savedB);
    addLog({ type: "compare_saved", slot, planId: S.planResp.plan?.planId });
  }
  function openCompare() {
    if (!S.savedA || !S.savedB) return;
    const existing = document.getElementById("sp-pg-compare-panel");
    if (existing) existing.remove();
    const panel = document.createElement("div");
    panel.id = "sp-pg-compare-panel";
    panel.className = "sp-pg-compare-panel";
    const stepsA = S.savedA.resp.plan?.steps ?? [];
    const stepsB = S.savedB.resp.plan?.steps ?? [];
    const maxLen = Math.max(stepsA.length, stepsB.length);
    const stepRows = Array.from({ length: maxLen }, (_, i) => {
      const sA = stepsA[i];
      const sB = stepsB[i];
      const diffClass = !sA ? "sp-pg-step-diff-add" : !sB ? "sp-pg-step-diff-rem" : sA.description === sB.description ? "" : "sp-pg-step-diff-chg";
      return `
      <div style="display:flex;gap:16px;margin-bottom:8px;border-bottom:1px solid #2d2d30;padding-bottom:8px">
        <div style="flex:1;color:${C.text}" class="${diffClass}">
          ${sA ? `<b style="color:${C.muted}">${i + 1}.</b> ${esc(sA.description)}<br><span style="color:${C.muted};font-size:10px">\u2192 "${esc(sA.targetElement?.text ?? "(null)")}"</span>` : '<span style="color:#858585">\u2014</span>'}
        </div>
        <div style="flex:1;color:${C.text}" class="${diffClass}">
          ${sB ? `<b style="color:${C.muted}">${i + 1}.</b> ${esc(sB.description)}<br><span style="color:${C.muted};font-size:10px">\u2192 "${esc(sB.targetElement?.text ?? "(null)")}"</span>` : '<span style="color:#858585">\u2014</span>'}
        </div>
      </div>
    `;
    }).join("");
    panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="color:${C.teal};font-size:14px;font-weight:bold">Plan Comparison</span>
      <button class="sp-pg-hbtn" id="sp-pg-compare-close">\u2715 Close</button>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:12px">
      <div style="flex:1">
        <div style="color:${C.label};font-size:11px;margin-bottom:4px">PLAN A</div>
        <div style="color:${C.text}">${esc(S.savedA.goal)}</div>
        <div style="color:${C.muted};font-size:10px">conf: ${S.savedA.resp.confidence?.toFixed(2)} \xB7 ${stepsA.length} steps \xB7 ${S.savedA.resp.providerMetadata?.latencyMs}ms</div>
        <div style="color:${C.text};font-style:italic;font-size:10.5px;margin-top:4px">${esc(S.savedA.resp.plannerSummary ?? "")}</div>
      </div>
      <div style="width:1px;background:${C.border}"></div>
      <div style="flex:1">
        <div style="color:${C.label};font-size:11px;margin-bottom:4px">PLAN B</div>
        <div style="color:${C.text}">${esc(S.savedB.goal)}</div>
        <div style="color:${C.muted};font-size:10px">conf: ${S.savedB.resp.confidence?.toFixed(2)} \xB7 ${stepsB.length} steps \xB7 ${S.savedB.resp.providerMetadata?.latencyMs}ms</div>
        <div style="color:${C.text};font-style:italic;font-size:10.5px;margin-top:4px">${esc(S.savedB.resp.plannerSummary ?? "")}</div>
      </div>
    </div>
    <div style="color:${C.label};font-size:11px;margin-bottom:8px;border-bottom:1px solid ${C.border};padding-bottom:4px">STEPS</div>
    <div style="display:flex;gap:8px;margin-bottom:4px">
      <div style="flex:1;color:${C.muted};font-size:10px">Plan A (${stepsA.length} steps)</div>
      <div style="flex:1;color:${C.muted};font-size:10px">Plan B (${stepsB.length} steps)</div>
    </div>
    ${stepRows}
    <div style="color:${C.muted};font-size:10px;margin-top:12px">
      <span style="color:${C.yellow}">\u25A0</span> changed &nbsp;
      <span style="color:${C.green}">\u25A0</span> added (B only) &nbsp;
      <span style="color:${C.red}">\u25A0</span> removed (A only)
    </div>
  `;
    document.body.appendChild(panel);
    document.getElementById("sp-pg-compare-close")?.addEventListener("click", () => panel.remove());
  }
  var _panel = null;
  function open() {
    injectStyles();
    if (!_panel) _panel = createPanel();
    _panel.classList.remove("sp-pg-hidden");
    S.visible = true;
    renderAll();
  }
  function close() {
    _panel?.classList.add("sp-pg-hidden");
    S.visible = false;
  }
  function toggle() {
    if (S.visible) close();
    else open();
  }
  var Playground = { open, close, toggle };
  window.__SP_PLAYGROUND = Playground;
  console.log("[SP:Playground] Ready \u2014 __SP_PLAYGROUND.open() to launch");
})();
