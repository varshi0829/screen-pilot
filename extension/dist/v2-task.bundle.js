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
  function redactText(text, replacement = "[REDACTED]") {
    if (typeof text !== "string" || !text) return text;
    const spans = findPII(text);
    if (!spans.length) return text;
    let out = "";
    let last = 0;
    for (const s of spans) {
      out += text.slice(last, s.start) + replacement;
      last = s.end;
    }
    return out + text.slice(last);
  }
  function classifyElement(el) {
    if (!el) return null;
    return byInputType(el.type) || byAutocomplete(el.autocomplete) || byLabel(el.placeholder, el.ariaLabel, el.name, el.id, el.label) || detectType(el.value) || detectType(el.text) || null;
  }
  var SENSITIVE_PARAM_RE = /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|session|session[_-]?id|sessionid|sid|code|otp|signature|sig|jwt|bearer|ticket|email|e-?mail|phone|mobile|tel)$/i;
  var SENSITIVE_KEY_RE = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|bearer|jwt|private[_-]?key|client[_-]?secret)$/i;
  function isSensitiveParamName(name) {
    return SENSITIVE_PARAM_RE.test(String(name || ""));
  }
  function isSensitiveKeyName(name) {
    return SENSITIVE_KEY_RE.test(String(name || ""));
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
  var FINGERPRINT_LABEL_MAX_LEN = 60;
  function _fingerprintLabel(el) {
    const sensitiveType = PrivacySanitizer.getSensitiveType(el);
    if (sensitiveType) {
      const label = el.placeholder || el.ariaLabel || "";
      return label ? label.slice(0, FINGERPRINT_LABEL_MAX_LEN) : PrivacySanitizer.REDACTED;
    }
    const raw = el.text || el.placeholder || el.ariaLabel || "";
    return raw.slice(0, FINGERPRINT_LABEL_MAX_LEN);
  }
  function computeRelevantStateFingerprint(pageState) {
    const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
    const projected = [];
    for (const el of elements) {
      if (!el || el.visible === false || el.enabled === false) continue;
      projected.push({
        role: el.role || "",
        label: _fingerprintLabel(el),
        // The one "relevant structural relationship" already available without
        // extra cost — the native <form> association PageStateService already
        // resolves (resolveFormId), surfaced here as-is.
        formId: el.formId ?? null,
        // Boolean only — never the raw value, even for a non-sensitive field.
        valuePresent: !!(el.value && el.value.trim())
      });
    }
    projected.sort((a, b) => {
      const af = a.formId ?? "", bf = b.formId ?? "";
      if (af !== bf) return af < bf ? -1 : 1;
      if (a.role !== b.role) return a.role < b.role ? -1 : 1;
      if (a.label !== b.label) return a.label < b.label ? -1 : 1;
      if (a.valuePresent !== b.valuePresent) return a.valuePresent ? 1 : -1;
      return 0;
    });
    return {
      url: pageState?.url ?? "",
      count: projected.length,
      hash: _fnv32a(JSON.stringify(projected))
    };
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
    const MORPH_MIN_LEN = 4;
    const MORPH_CREDIT = 0.9;
    function morphRelated(a, b) {
      if (a === b) return false;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      return short.length >= MORPH_MIN_LEN && long.startsWith(short);
    }
    function matchStrength(token, tokenSet) {
      if (tokenSet.has(token)) return 1;
      for (const candidate of tokenSet) {
        if (morphRelated(token, candidate)) return MORPH_CREDIT;
      }
      return 0;
    }
    function elementLabelTokens(el) {
      const textTokens = tokenize(el.text || "");
      const placeTokens = tokenize(el.placeholder || "");
      const ariaTokens = tokenize(el.ariaLabel || "");
      const valTokens = tokenize(el.value || "");
      return /* @__PURE__ */ new Set([...textTokens, ...placeTokens, ...ariaTokens, ...valTokens]);
    }
    function computeIdf(elementTokenSets) {
      const df = /* @__PURE__ */ new Map();
      for (const tokens of elementTokenSets) {
        for (const t of tokens) {
          df.set(t, (df.get(t) || 0) + 1);
        }
      }
      const n = elementTokenSets.length;
      const idf = /* @__PURE__ */ new Map();
      for (const [t, d] of df) {
        idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
      }
      return { idf, df };
    }
    function scoreElement(intent, el, corpus = null) {
      if (!el || !el.visible || el.enabled === false) return 0;
      const intentTokens = tokenize(intent);
      if (!intentTokens.length) return 0;
      const elTokens = elementLabelTokens(el);
      if (!elTokens.size) return 0;
      const { idf, df } = corpus || computeIdf([elTokens]);
      const scorableTokens = [];
      for (const t of intentTokens) {
        if ((df.get(t) || 0) > 0) {
          scorableTokens.push({ token: t, weight: idf.get(t) || 1 });
          continue;
        }
        let best = null;
        for (const pageToken of df.keys()) {
          if (!morphRelated(t, pageToken)) continue;
          const w = idf.get(pageToken) || 1;
          if (!best || w > best.weight) best = { token: t, weight: w };
        }
        if (best) scorableTokens.push(best);
      }
      if (!scorableTokens.length) return 0;
      let totalWeight = 0;
      let matchedWeight = 0;
      for (const { token, weight } of scorableTokens) {
        totalWeight += weight;
        matchedWeight += weight * matchStrength(token, elTokens);
      }
      if (totalWeight <= 0) return 0;
      const coverage = matchedWeight / totalWeight;
      if (coverage <= 0) return 0;
      let bonus = 0;
      const normIntent = normalize2(intent);
      if (normIntent.includes("click") || normIntent.includes("open") || normIntent.includes("press")) {
        if (["button", "link", "combobox", "tab"].includes(el.role) || el.tag === "button" || el.tag === "a") bonus += 0.08;
      } else if (normIntent.includes("type") || normIntent.includes("fill") || normIntent.includes("search") || normIntent.includes("enter")) {
        if (["textbox", "combobox", "search"].includes(el.role) || ["input", "textarea"].includes(el.tag)) bonus += 0.08;
      }
      if (el.region === "top_navigation" || el.region === "side_navigation" || el.region === "modal") bonus += 0.04;
      const fullElText = normalize2(`${el.text || ""} ${el.placeholder || ""} ${el.ariaLabel || ""}`);
      if (normIntent && fullElText && (fullElText.includes(normIntent) || normIntent.includes(fullElText))) {
        bonus += 0.03;
      }
      const finalScore = Math.min(1, coverage * 0.85 + bonus);
      return Math.round(finalScore * 100) / 100;
    }
    function rankElements(intent, elements) {
      if (!Array.isArray(elements) || !elements.length) return [];
      const elementTokenSets = elements.map((el) => elementLabelTokens(el));
      const corpus = computeIdf(elementTokenSets);
      const scored = elements.map((el) => ({
        element: el,
        score: scoreElement(intent, el, corpus)
      }));
      return scored.filter((item) => item.score > 0.05).sort((a, b) => b.score - a.score);
    }
    function assessGrounding(intent, elements) {
      const ranked = rankElements(intent, elements);
      const list = Array.isArray(elements) ? elements : [];
      const { df } = computeIdf(list.map((el) => elementLabelTokens(el)));
      const unmatchedIntentTokens = tokenize(intent).filter((t) => {
        if ((df.get(t) || 0) > 0) return false;
        for (const pageToken of df.keys()) if (morphRelated(t, pageToken)) return false;
        return true;
      });
      const topScore = ranked[0]?.score ?? 0;
      const runnerUpScore = ranked[1]?.score ?? 0;
      const margin = topScore - runnerUpScore;
      return { ranked, topScore, runnerUpScore, margin, rivals: ranked.length, unmatchedIntentTokens };
    }
    return { scoreElement, rankElements, tokenize, assessGrounding };
  })();
  if (typeof globalThis !== "undefined" && globalThis.module) {
    globalThis.module.exports = UIGroundingService;
  }

  // extension/lib/compact-page-state.js
  var DEFAULT_MAX_ELEMENTS = 150;
  var MAX_NAME_LENGTH = 60;
  function truncate(s) {
    return s.length > MAX_NAME_LENGTH ? s.slice(0, MAX_NAME_LENGTH) : s;
  }
  function bestName(el, sensitiveType) {
    if (sensitiveType) {
      const label = el.placeholder || el.ariaLabel || "";
      return label ? truncate(label) : PrivacySanitizer.REDACTED;
    }
    return truncate(el.text || el.placeholder || el.ariaLabel || "");
  }
  function toCompactElement(el) {
    const sensitiveType = PrivacySanitizer.getSensitiveType(el);
    return {
      id: el.id,
      role: el.role,
      name: bestName(el, sensitiveType),
      type: el.tag,
      sensitive: sensitiveType !== null,
      sensitiveType
    };
  }
  function toCompactPageState(pageState, { maxElements = DEFAULT_MAX_ELEMENTS } = {}) {
    const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
    const visibleInteractiveElements = [];
    for (const el of elements) {
      if (!el || el.visible === false || el.enabled === false) continue;
      visibleInteractiveElements.push(toCompactElement(el));
      if (visibleInteractiveElements.length >= maxElements) break;
    }
    return {
      url: pageState?.url ?? "",
      title: pageState?.title ?? "",
      visibleInteractiveElements
    };
  }
  function estimatePayloadBytes(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
      return 0;
    }
  }
  function estimateCompactionSavings(pageState, options) {
    const compact = toCompactPageState(pageState, options);
    const rawBytes = estimatePayloadBytes(pageState?.elements ?? []);
    const compactBytes = estimatePayloadBytes(compact.visibleInteractiveElements);
    return {
      rawElementCount: Array.isArray(pageState?.elements) ? pageState.elements.length : 0,
      compactElementCount: compact.visibleInteractiveElements.length,
      rawBytes,
      compactBytes,
      reductionPct: rawBytes > 0 ? Math.round((1 - compactBytes / rawBytes) * 100) : 0
    };
  }

  // extension/providers/local-qwen-adapter.js
  var DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
  var DEFAULT_MODEL = "qwen2.5-coder:7b";
  var DEFAULT_KEEP_ALIVE = "5m";
  var DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1e3;
  var QWEN_GENERATE_TIMEOUT_MS = 45e3;
  var VALID_ACTIONS = /* @__PURE__ */ new Set(["click", "fill", "select", "navigate", "finish"]);
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
      this._warmUntilMs = 0;
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
      await this._warmModelIfNeeded(callerSignal, reqId);
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
              body: requestBody,
              timeoutMs: QWEN_GENERATE_TIMEOUT_MS
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
      this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS;
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
    /**
     * Preload this adapter's own model into Ollama's memory before the real
     * generate call, so that call itself doesn't pay the cold-load cost.
     * Reuses the exact same OLLAMA_GENERATE proxy path plan() uses — no second
     * client/architecture — but the request body carries no `prompt`, which is
     * Ollama's own documented mechanism for loading (and keep_alive-refreshing)
     * a model without running any generation: not a second inference task.
     *
     * No-ops entirely when we already believe the model is warm (bookkeeping
     * only — see _warmUntilMs), when the caller already aborted, or outside a
     * real chrome-extension context (the rare direct-fetch-fallback path just
     * skips warming and pays whatever cold-load cost the real call hits, same
     * as before this feature existed). Never throws — a failed/timed-out
     * preload just means the real call below proceeds exactly as it already
     * would have.
     */
    async _warmModelIfNeeded(callerSignal, reqId) {
      if (Date.now() < this._warmUntilMs) {
        console.log(`[SP:V2:DEBUG] LocalQwenAdapter model already warm reqId=${reqId} warmUntilMs=${this._warmUntilMs} \u2014 skipping preload`);
        return;
      }
      if (callerSignal?.aborted) return;
      const hasChromeRuntime = typeof chrome !== "undefined" && chrome?.runtime?.sendMessage;
      if (!hasChromeRuntime) return;
      const warmReqId = `${reqId}_warmup`;
      const targetUrl = `${this._ollamaUrl}/api/generate`;
      const warmBody = { model: this._model, keep_alive: this._keepAlive, stream: false };
      console.log(`[SP:V2:DEBUG] LocalQwenAdapter warming model=${this._model} reqId=${warmReqId}`);
      try {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: "OLLAMA_GENERATE",
            reqId: warmReqId,
            url: targetUrl,
            body: warmBody,
            timeoutMs: QWEN_GENERATE_TIMEOUT_MS
          }, (response) => {
            if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
            else resolve(response || { success: false, error: "No response from background script" });
          });
        });
        if (resp?.success) {
          this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS;
          console.log(`[SP:V2:DEBUG] LocalQwenAdapter model warm reqId=${warmReqId} warmUntilMs=${this._warmUntilMs}`);
        } else {
          console.log(`[SP:V2:DEBUG] LocalQwenAdapter warm-up failed reqId=${warmReqId} error=${resp?.error} \u2014 proceeding to real generate anyway`);
        }
      } catch (err) {
        console.log(`[SP:V2:DEBUG] LocalQwenAdapter warm-up threw reqId=${warmReqId} message=${err?.message} \u2014 proceeding to real generate anyway`);
      }
    }
    /**
     * Explicitly separates two different things Qwen must reason about:
     * - the TARGET element (an id from the given list — its own label/
     *   placeholder/text is metadata describing that control, not user input);
     * - the VALUE (the actual content the user wants entered, extracted from
     *   the goal's own meaning — never the target's own label, never the goal
     *   sentence itself, empty for any action that isn't "type").
     * This is a semantic-reasoning instruction for the LLM, not a sentence
     * template/regex — Qwen is the tier meant to do this kind of extraction
     * generically, for any phrasing or site.
     */
    _buildQwenPrompt(request) {
      const page = request.page ?? {};
      const history2 = request.executionHistory?.completedSteps ?? [];
      const elements = request.elements ?? [];
      const compactElements = elements.slice(0, 25).map((e) => {
        const c = toCompactElement(e);
        return c.sensitive ? { id: c.id, role: c.role, text: c.name, sensitive: true } : { id: c.id, role: c.role, text: e.text || e.ariaLabel || e.placeholder || "" };
      });
      return `Goal: "${request.goal}"
Page: ${page.title || ""} (${page.url || ""})
${history2.length ? `History: ${history2.map((h) => h.description).join(" -> ")}` : ""}

Elements:
${JSON.stringify(compactElements)}

Select the single next action.

Distinguish two different things:
- TARGET: which element (by id, from the list above) to act on. An
  element's own text/placeholder/label is metadata describing that control \u2014
  it is never something the user typed.
- VALUE: only when the action is "fill" \u2014 the actual content the user wants
  entered, understood from the goal's own meaning. It is never the target
  element's own label, and never the goal sentence itself. For any other
  action (click/select/navigate/finish), value must be null. Never give a
  value for an element marked "sensitive": true \u2014 use null.
- "elementId" MUST be copied exactly from the list above. Never invent one.

Return JSON ONLY:
{"action":"click"|"fill"|"select"|"navigate"|"finish","elementId":"el_1","value":null,"confidence":0.95}`;
    }
    _formatPlanResponse(request, qwenOutput, latencyMs) {
      const rawAction = qwenOutput.action ?? "click";
      const action = rawAction === "type" ? "fill" : rawAction;
      if (!VALID_ACTIONS.has(action)) {
        return this._networkFailure(`Local Qwen returned an invalid action "${String(rawAction).slice(0, 30)}"`, "INVALID_ACTION");
      }
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
      const resolvedElement = (request.elements || []).find((e) => e.id === elementId);
      const isSensitive = resolvedElement ? toCompactElement(resolvedElement).sensitive : false;
      const elementLabel = isSensitive ? resolvedElement.placeholder || resolvedElement.ariaLabel || elementId : resolvedElement?.text || resolvedElement?.ariaLabel || resolvedElement?.placeholder || elementId || "the target";
      const isFillAction = action === "fill";
      const value = isFillAction && !isSensitive && typeof qwenOutput.value === "string" ? qwenOutput.value.trim() : "";
      const description = value ? `Type '${value}' into '${elementLabel}'` : `${isFillAction ? "Fill" : "Click"} '${elementLabel}'`;
      const step = {
        id: 1,
        description,
        intent: description,
        phase: isFillAction ? "fill_form" : "navigate",
        completionCondition: "dom_change",
        targetElement: {
          text: elementLabel,
          type: isFillAction ? "input" : "button",
          intent: elementLabel,
          value,
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
        plannerSummary: `Action: ${action} on ${elementId ?? elementLabel}`,
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

  // extension/providers/local-vision-adapter.js
  var DEFAULT_OLLAMA_URL2 = "http://127.0.0.1:11434";
  var DEFAULT_MODEL2 = "moondream";
  var DEFAULT_KEEP_ALIVE2 = "5m";
  var DEFAULT_KEEP_ALIVE_MS2 = 5 * 60 * 1e3;
  var VISION_GENERATE_TIMEOUT_MS = 3e4;
  var VISION_AVAILABILITY_TIMEOUT_MS = 2500;
  var VISION_IMAGE_MAX_WIDTH = 512;
  var VISION_IMAGE_QUALITY = 0.7;
  function computeVisionResizeDimensions(sourceWidth, sourceHeight, targetWidth = VISION_IMAGE_MAX_WIDTH) {
    if (!sourceWidth || !sourceHeight) return { width: sourceWidth || 0, height: sourceHeight || 0 };
    const scale = Math.min(1, targetWidth / sourceWidth);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale))
    };
  }
  var BBOX_COORD_PRECISION = 1e3;
  function normalizeBboxForVision(bbox, viewportWidth, viewportHeight) {
    if (!bbox || !viewportWidth || !viewportHeight) return null;
    if (!(bbox.width > 0) || !(bbox.height > 0)) return null;
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const round = (n) => Math.round(n * BBOX_COORD_PRECISION) / BBOX_COORD_PRECISION;
    return {
      x: round(clamp01(bbox.x / viewportWidth)),
      y: round(clamp01(bbox.y / viewportHeight)),
      width: round(clamp01(bbox.width / viewportWidth)),
      height: round(clamp01(bbox.height / viewportHeight))
    };
  }
  function computeCandidateMarkerPositions(elements, canvasWidth, canvasHeight, viewportWidth, viewportHeight) {
    if (!Array.isArray(elements) || !canvasWidth || !canvasHeight) return [];
    const positions = [];
    for (const el of elements) {
      if (!el?.id) continue;
      const norm = normalizeBboxForVision(el.bbox, viewportWidth, viewportHeight);
      if (!norm) continue;
      positions.push({
        id: el.id,
        x: Math.round(norm.x * canvasWidth),
        y: Math.round(norm.y * canvasHeight)
      });
    }
    return positions;
  }
  var MARKER_RADIUS = 4;
  var MARKER_FONT = "bold 11px sans-serif";
  var MARKER_COLOR = "#ff00ff";
  var MARKER_TEXT_COLOR = "#000000";
  var MARKER_TEXT_BG = "#ffff00";
  function drawCandidateMarkers(ctx, positions) {
    for (const { id, x, y } of positions) {
      try {
        ctx.beginPath();
        ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = MARKER_COLOR;
        ctx.fill();
        const label = `[${id}]`;
        ctx.font = MARKER_FONT;
        const textWidth = typeof ctx.measureText === "function" ? ctx.measureText(label).width : label.length * 6;
        const labelX = x + MARKER_RADIUS + 2;
        const labelY = y - MARKER_RADIUS - 2;
        ctx.fillStyle = MARKER_TEXT_BG;
        ctx.fillRect(labelX - 1, labelY - 10, textWidth + 2, 12);
        ctx.fillStyle = MARKER_TEXT_COLOR;
        ctx.fillText(label, labelX, labelY);
      } catch {
      }
    }
  }
  async function resizeImageForVision(base64Image, elements = [], viewportWidth = 0, viewportHeight = 0) {
    try {
      const binary = atob(base64Image);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const { width, height } = computeVisionResizeDimensions(bitmap.width, bitmap.height, VISION_IMAGE_MAX_WIDTH);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (typeof bitmap.close === "function") bitmap.close();
      const positions = computeCandidateMarkerPositions(elements, width, height, viewportWidth, viewportHeight);
      if (positions.length) drawCandidateMarkers(ctx, positions);
      const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: VISION_IMAGE_QUALITY });
      const buffer = await outBlob.arrayBuffer();
      const outBytes = new Uint8Array(buffer);
      const CHUNK = 8192;
      let str = "";
      for (let i = 0; i < outBytes.length; i += CHUNK) {
        str += String.fromCharCode.apply(null, outBytes.subarray(i, Math.min(i + CHUNK, outBytes.length)));
      }
      return btoa(str);
    } catch (err) {
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter image resize failed, using original image: ${err?.message}`);
      return base64Image;
    }
  }
  var LocalVisionAdapter = class extends BackendAdapter {
    /**
     * @param {object} [options]
     * @param {string} [options.ollamaUrl] - Local Ollama server URL (defaults to http://127.0.0.1:11434)
     * @param {string} [options.model]     - Local vision model name (defaults to "moondream")
     * @param {string} [options.keepAlive] - Model warm duration (defaults to "5m")
     */
    constructor({ ollamaUrl = DEFAULT_OLLAMA_URL2, model = DEFAULT_MODEL2, keepAlive = DEFAULT_KEEP_ALIVE2 } = {}) {
      super();
      this._ollamaUrl = ollamaUrl.replace(/\/$/, "");
      this._model = model;
      this._keepAlive = keepAlive;
      this._warmUntilMs = 0;
    }
    get name() {
      return "LocalVisionAdapter";
    }
    /**
     * Identify which one existing element (if any) visually matches the next
     * step toward the goal. NOT a planner call — returns a minimal perception
     * result, never a full PlanResponse. The caller (DecisionRouter) is
     * responsible for validating the returned elementId against the current
     * page-state element list before trusting it.
     *
     * @param {{goal:string, page:{url?:string, title?:string, screenshot?:{image:string,mimeType?:string}}, elements?:object[]}} request
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{result:'OK', elementId:string|null, action:string|null, confidence:number, reason:string}|{result:'FAILED', error:string, errorCode:string}>}
     */
    async plan(request, options = {}) {
      const t0 = Date.now();
      const callerSignal = options?.signal;
      const reqId = request?.requestId || `req_vision_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter request start reqId=${reqId} model=${this._model}`);
      if (callerSignal?.aborted) {
        return this._networkFailure("Request aborted", "ABORTED");
      }
      const imageBase64 = request?.page?.screenshot?.image;
      if (!imageBase64) {
        return this._networkFailure("No screenshot provided for local vision reasoning", "NO_SCREENSHOT");
      }
      await this._warmModelIfNeeded(callerSignal, reqId);
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
      const candidateElements = (request?.elements ?? []).slice(0, 25);
      const visionImageBase64 = await resizeImageForVision(imageBase64, candidateElements, viewportWidth, viewportHeight);
      const prompt = this._buildVisionPrompt(request);
      const targetUrl = `${this._ollamaUrl}/api/generate`;
      const requestBody = {
        model: this._model,
        prompt,
        images: [visionImageBase64],
        format: "json",
        stream: false,
        keep_alive: this._keepAlive,
        options: {
          temperature: 0,
          num_predict: 128
        }
      };
      let data = null;
      let isSuccess = false;
      const hasChromeRuntime = typeof chrome !== "undefined" && chrome?.runtime?.sendMessage;
      if (hasChromeRuntime) {
        try {
          let abortHandler = null;
          if (callerSignal) {
            abortHandler = () => {
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
              body: requestBody,
              timeoutMs: VISION_GENERATE_TIMEOUT_MS
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
          if (!bgResp?.success) {
            console.error(`[SP:V2:DEBUG] Background Ollama proxy failed (vision) reqId=${reqId}: ${bgResp?.error}`);
            const errCode = bgResp?.errorCode || (callerSignal?.aborted ? "ABORTED" : "OLLAMA_UNAVAILABLE");
            return this._networkFailure(bgResp?.error || "Background Ollama proxy failed", errCode);
          }
          data = bgResp.data;
          isSuccess = true;
        } catch (proxyErr) {
          console.error(`[SP:V2:DEBUG] Background proxy error (vision) reqId=${reqId} message=${proxyErr?.message}`);
        }
      }
      if (!isSuccess) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort(`vision_timeout_${VISION_GENERATE_TIMEOUT_MS}ms`);
        }, VISION_GENERATE_TIMEOUT_MS);
        if (callerSignal) {
          callerSignal.addEventListener("abort", () => {
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
          const isCallerAborted = callerSignal?.aborted;
          const isTimeout = err instanceof Error && err.name === "AbortError" && !isCallerAborted;
          const message = isCallerAborted ? "Local vision request was aborted" : isTimeout ? "Local vision inference timed out" : err instanceof Error ? err.message : String(err);
          const errorCode = isCallerAborted ? "ABORTED" : isTimeout ? "TIMEOUT" : "OLLAMA_UNAVAILABLE";
          return this._networkFailure(message, errorCode);
        }
        if (!upstream.ok) {
          return this._networkFailure(`Ollama returned status ${upstream.status}`, "OLLAMA_ERROR");
        }
        data = await upstream.json().catch(() => null);
      }
      this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS2;
      const rawResponse = data?.response ?? "";
      const latencyMs = Date.now() - t0;
      console.log(`[SP:V2:PERF] visionLatencyMs=${latencyMs} model=${this._model}`);
      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        return this._networkFailure("Local vision model returned invalid JSON", "PARSE_ERROR");
      }
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter perception result reqId=${reqId} elementId=${parsed?.elementId ?? "null"} action=${parsed?.action ?? "n/a"}`);
      return this._formatPerceptionResult(parsed);
    }
    async recover(request, options = {}) {
      return this.plan(request, options);
    }
    async explain() {
      return { success: true, screenContext: { application: "Web App", pageType: "other" } };
    }
    async ask() {
      return { success: true, answer: "Local vision screen analysis complete." };
    }
    estimateCost() {
      return { inputTokens: 0, outputTokens: 0, estimatedUSD: 0 };
    }
    /**
     * Same proxy-with-direct-fetch-fallback pattern as LocalQwenAdapter.checkAvailability.
     */
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
            new Promise((resolve) => setTimeout(() => resolve({ __proxyTimeout: true }), VISION_AVAILABILITY_TIMEOUT_MS))
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
      const timeoutId = setTimeout(() => controller.abort("availability_timeout"), VISION_AVAILABILITY_TIMEOUT_MS);
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
    /**
     * Preload this adapter's own model into Ollama's memory before the real
     * generate call, so that call itself doesn't pay the cold-load cost.
     * Reuses the exact same OLLAMA_GENERATE proxy path plan() uses — no second
     * client/architecture — but the request body carries no `prompt`/`images`,
     * which is Ollama's own documented mechanism for loading (and
     * keep_alive-refreshing) a model without running any generation: not a
     * second inference task.
     *
     * No-ops entirely when we already believe the model is warm (bookkeeping
     * only — see _warmUntilMs), when the caller already aborted, or outside a
     * real chrome-extension context. Never throws — a failed/timed-out preload
     * just means the real call below proceeds exactly as it already would have.
     */
    async _warmModelIfNeeded(callerSignal, reqId) {
      if (Date.now() < this._warmUntilMs) {
        console.log(`[SP:V2:DEBUG] LocalVisionAdapter model already warm reqId=${reqId} warmUntilMs=${this._warmUntilMs} \u2014 skipping preload`);
        return;
      }
      if (callerSignal?.aborted) return;
      const hasChromeRuntime = typeof chrome !== "undefined" && chrome?.runtime?.sendMessage;
      if (!hasChromeRuntime) return;
      const warmReqId = `${reqId}_warmup`;
      const targetUrl = `${this._ollamaUrl}/api/generate`;
      const warmBody = { model: this._model, keep_alive: this._keepAlive, stream: false };
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter warming model=${this._model} reqId=${warmReqId}`);
      try {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: "OLLAMA_GENERATE",
            reqId: warmReqId,
            url: targetUrl,
            body: warmBody,
            timeoutMs: VISION_GENERATE_TIMEOUT_MS
          }, (response) => {
            if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
            else resolve(response || { success: false, error: "No response from background script" });
          });
        });
        if (resp?.success) {
          this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS2;
          console.log(`[SP:V2:DEBUG] LocalVisionAdapter model warm reqId=${warmReqId} warmUntilMs=${this._warmUntilMs}`);
        } else {
          console.log(`[SP:V2:DEBUG] LocalVisionAdapter warm-up failed reqId=${warmReqId} error=${resp?.error} \u2014 proceeding to real generate anyway`);
        }
      } catch (err) {
        console.log(`[SP:V2:DEBUG] LocalVisionAdapter warm-up threw reqId=${warmReqId} message=${err?.message} \u2014 proceeding to real generate anyway`);
      }
    }
    /**
     * P1 #2: a concise visual-PERCEPTION question, not a planning prompt.
     * Moondream is only ever reached when the L3 router found zero viable
     * text candidates (see decision-router.js) — its one job here is to look
     * at the screenshot and point at which known element (if any) is the
     * visual target. It is explicitly NOT asked to decide what kind of
     * interaction to perform (click/type/select/...) — decision-router.js
     * derives that itself from the resolved element's own role/tag via
     * _buildPlanFromElement, the same as L1/L2 already do, so asking the
     * model to also choose an action would be asking it to plan, not perceive.
     *
     * Context given is the minimum useful amount: the goal, and a compact
     * (already-sanitized, already-capped) list of interactive elements with
     * stable ids — not the full page state. The screenshot itself carries the
     * visual context; this text just gives the model the fixed vocabulary of
     * ids it is allowed to answer with.
     *
     * Each candidate also carries its own bbox WHEN one can be derived (see
     * normalizeBboxForVision) — normalized to a 0-1 fraction of the viewport,
     * not raw pixels, so it stays correct after the screenshot is resized for
     * this model. This exists because an element with no distinguishing text
     * (a purely visual/icon-only control) previously gave the model nothing
     * to connect what it sees to which known id that is; bbox is the same kind
     * of ground truth id/role/text already are — read from pageState, never
     * invented — it just happens to describe WHERE instead of WHAT.
     */
    _buildVisionPrompt(request) {
      const page = request.page ?? {};
      const elements = request.elements ?? [];
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
      const compactElements = elements.slice(0, 25).map((e) => {
        const c = toCompactElement(e);
        const entry2 = {
          id: c.id,
          role: c.role,
          text: c.sensitive ? c.name : e.text || e.ariaLabel || e.placeholder || ""
        };
        const bbox = normalizeBboxForVision(e.bbox, viewportWidth, viewportHeight);
        if (bbox) entry2.bbox = bbox;
        return entry2;
      });
      return `Goal: "${request.goal}"
Page: ${page.title || ""} (${page.url || ""})

You are a VISUAL PERCEPTION component, not a planner. You do not decide how
to interact with anything \u2014 only WHICH element is the visual target. Sensitive
fields in the screenshot are already blacked out locally; you will never see
real passwords, emails, or card numbers.

The screenshot contains TEMPORARY candidate markers \u2014 small colored dots, each
with a "[elementId]" label next to it (for example "[el_7]") \u2014 placed at the
known position of each element listed below. These markers are not part of
the real page; they exist only in this copy of the screenshot to help you
answer this question, and are the most direct way to identify a visually
distinctive but unlabeled element (e.g. an icon-only button with no visible
text): find the marker at the right visual spot, then read its label.

Known interactive elements already extracted from the page (id, role, text,
and bbox when available). bbox gives that same element's location in the
screenshot as {x, y, width, height} \u2014 each a fraction from 0 to 1 of the full
image (0,0 is the top-left corner, 1,1 is the bottom-right corner),
independent of the image's actual pixel size \u2014 matching where its marker is
drawn, for elements whose marker you cannot read clearly:
${JSON.stringify(compactElements)}

Question: looking at the screenshot and its candidate markers, which ONE
element from the list above is visually the target for this goal?

Rules:
- "elementId" MUST be copied exactly from the list above. Never invent,
  guess, or construct a new id.
- If none of the listed elements visually match, return elementId: null.

Return JSON ONLY:
{"elementId":"el_12","confidence":0.91,"reason":"short reason"}`;
    }
    /**
     * Deliberately minimal: this is a perception result, not a plan. It names
     * which known element (if any) looks right and how confident the model is
     * — it does NOT shape a step/PlanResponse. DecisionRouter validates
     * elementId against the live page state and, only then, builds the actual
     * executable step via the same _buildPlanFromElement helper L1/L2 use.
     */
    _formatPerceptionResult(visionOutput) {
      return {
        result: "OK",
        elementId: typeof visionOutput?.elementId === "string" ? visionOutput.elementId : null,
        action: typeof visionOutput?.action === "string" ? visionOutput.action : null,
        confidence: Number.isFinite(visionOutput?.confidence) ? Math.max(0, Math.min(1, visionOutput.confidence)) : 0,
        reason: typeof visionOutput?.reason === "string" ? visionOutput.reason : ""
      };
    }
    _networkFailure(error, errorCode) {
      return {
        schemaVersion: "1",
        result: "FAILED",
        blockers: [],
        confidence: 0,
        providerMetadata: { provider: "local-vision", model: this._model, latencyMs: 0 },
        error,
        errorCode
      };
    }
  };

  // extension/lib/sensitive-policy.js
  var Outbound = Object.freeze({
    PLACEHOLDER: "placeholder",
    REDACT: "redact"
  });
  function entry(outbound, noun) {
    return Object.freeze({ outbound, noun, guidance: "user_enters", autonomousFill: false });
  }
  var POLICY = Object.freeze({
    [SensitiveType.PASSWORD]: entry(Outbound.REDACT, "password"),
    [SensitiveType.OTP]: entry(Outbound.REDACT, "one-time code"),
    [SensitiveType.CREDIT_CARD]: entry(Outbound.REDACT, "card details"),
    [SensitiveType.SSN]: entry(Outbound.REDACT, "Social Security number"),
    [SensitiveType.BANK_ACCOUNT]: entry(Outbound.REDACT, "bank account details"),
    [SensitiveType.ADDRESS]: entry(Outbound.REDACT, "address"),
    [SensitiveType.DATE_OF_BIRTH]: entry(Outbound.REDACT, "date of birth"),
    [SensitiveType.JWT]: entry(Outbound.REDACT, "access token"),
    [SensitiveType.API_KEY]: entry(Outbound.REDACT, "API key"),
    [SensitiveType.SECRET]: entry(Outbound.REDACT, "secret value"),
    // Contact details are useful for the model to reason about ("send to
    // [EMAIL_1]"), so they get reversible placeholders instead of a hard redact.
    [SensitiveType.EMAIL]: entry(Outbound.PLACEHOLDER, "email address"),
    [SensitiveType.PHONE]: entry(Outbound.PLACEHOLDER, "phone number")
  });
  function outboundHandling(type) {
    return POLICY[type]?.outbound ?? Outbound.REDACT;
  }
  function fieldInstruction(type) {
    const p = POLICY[type];
    if (!p) return null;
    return `Enter your ${p.noun} in the highlighted field yourself \u2014 ScreenPilot never reads, stores, or types it.`;
  }
  var POLICY_TYPES = Object.freeze(Object.keys(POLICY));

  // extension/lib/pii-vault.js
  var TOKEN_LABEL = { [SensitiveType.EMAIL]: "EMAIL", [SensitiveType.PHONE]: "PHONE" };
  var TOKEN_RE = /\[(EMAIL|PHONE)_(\d+)\]/g;
  var SKIP_KEYS = /* @__PURE__ */ new Set(["image", "mimeType", "schemaVersion", "requestId", "sessionId", "planId"]);
  var MAX_DEPTH = 12;
  var TRUNCATED = "[TRUNCATED]";
  function normalizeForKey(type, value) {
    const v = String(value).trim();
    if (type === SensitiveType.EMAIL) return v.toLowerCase();
    if (type === SensitiveType.PHONE) return v.replace(/\D/g, "");
    return v;
  }
  var TokenVault = class {
    #byToken = /* @__PURE__ */ new Map();
    #byKey = /* @__PURE__ */ new Map();
    #counters = {};
    /** Register a value and return its stable placeholder (same value → same token). */
    register(type, value) {
      const label = TOKEN_LABEL[type];
      if (!label) throw new Error(`TokenVault: type "${type}" is not tokenizable`);
      const key = `${type}:${normalizeForKey(type, value)}`;
      const existing = this.#byKey.get(key);
      if (existing) return existing;
      const n = this.#counters[type] = (this.#counters[type] ?? 0) + 1;
      const token = `[${label}_${n}]`;
      this.#byKey.set(key, token);
      this.#byToken.set(token, String(value).trim());
      return token;
    }
    /** Replace any known placeholders in `text` with the real values. Unknown tokens are left as-is. */
    restore(text) {
      if (typeof text !== "string" || !text || !text.includes("[")) return text;
      return text.replace(TOKEN_RE, (token) => this.#byToken.get(token) ?? token);
    }
    get size() {
      return this.#byToken.size;
    }
    clear() {
      this.#byToken.clear();
      this.#byKey.clear();
      this.#counters = {};
    }
    // Defense in depth: even JSON.stringify(vault) can never expose a value.
    toJSON() {
      return { tokens: this.size };
    }
  };
  function tallyOne(tally, type) {
    if (tally) tally[type] = (tally[type] ?? 0) + 1;
  }
  function sanitizeText(text, vault, tally = null) {
    if (typeof text !== "string" || !text) return text;
    const spans = findPII(text);
    if (!spans.length) return text;
    let out = "";
    let last = 0;
    for (const s of spans) {
      out += text.slice(last, s.start);
      out += outboundHandling(s.type) === Outbound.PLACEHOLDER ? vault.register(s.type, text.slice(s.start, s.end)) : REDACTED;
      tallyOne(tally, s.type);
      last = s.end;
    }
    return out + text.slice(last);
  }
  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }
  function sanitizeParams(params, vault, tally) {
    return params.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return sanitizeText(pair, vault, tally);
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!value) return pair;
      if (isSensitiveParamName(safeDecode(name))) {
        tallyOne(tally, SensitiveType.SECRET);
        return `${name}=${REDACTED}`;
      }
      const decoded = safeDecode(value);
      const safe2 = sanitizeText(decoded, vault, tally);
      return safe2 === decoded ? pair : `${name}=${safe2}`;
    }).join("&");
  }
  function sanitizeUrl(url, vault, tally = null) {
    if (typeof url !== "string" || !url) return url;
    const hashIdx = url.indexOf("#");
    const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;
    const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    const qIdx = beforeHash.indexOf("?");
    const query = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : null;
    let base = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;
    if (/\/\/[^/@\s]+@/.test(base)) {
      base = base.replace(/\/\/[^/@\s]+@/, `//${REDACTED}@`);
      tallyOne(tally, SensitiveType.SECRET);
    }
    let out = sanitizeText(base, vault, tally);
    if (query !== null) out += `?${sanitizeParams(query, vault, tally)}`;
    if (fragment !== null) out += `#${sanitizeParams(fragment, vault, tally)}`;
    return out;
  }
  var URL_KEY_RE = /(?:url|urls|href)$/i;
  function sanitizeDeep(value, vault, tally = null, key = "", depth = 0) {
    if (depth > MAX_DEPTH) return TRUNCATED;
    if (typeof value === "string") {
      if (key && isSensitiveKeyName(key)) {
        tallyOne(tally, SensitiveType.SECRET);
        return REDACTED;
      }
      return URL_KEY_RE.test(key) ? sanitizeUrl(value, vault, tally) : sanitizeText(value, vault, tally);
    }
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeDeep(v, vault, tally, key, depth + 1));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SKIP_KEYS.has(k) ? v : sanitizeDeep(v, vault, tally, k, depth + 1);
      }
      return out;
    }
    return value;
  }
  function restoreDeep(value, vault, depth = 0) {
    if (typeof value === "string") return vault.restore(value);
    if (depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v, vault, depth + 1);
      return out;
    }
    return value;
  }

  // extension/providers/sanitizing-adapter.js
  function defaultOnEvent(evt) {
    console.log(`[SP:PII] ${JSON.stringify(evt)}`);
  }
  var SanitizingAdapter = class _SanitizingAdapter extends BackendAdapter {
    /**
     * @param {BackendAdapter} inner
     * @param {object} [options]
     * @param {TokenVault} [options.vault]   - per-task vault; a fresh in-memory one by default
     * @param {(evt: object) => void} [options.onEvent] - receives PII-free events ({event, method, types:{type:count}, placeholders})
     */
    constructor(inner, { vault = new TokenVault(), onEvent = defaultOnEvent } = {}) {
      super();
      if (!inner) throw new TypeError("SanitizingAdapter: inner adapter is required");
      this._inner = inner;
      this._vault = vault;
      this._onEvent = onEvent;
    }
    get name() {
      return `Sanitizing(${this._inner.name})`;
    }
    async plan(request, options = {}) {
      return this._call("plan", request, options);
    }
    async recover(request, options = {}) {
      return this._call("recover", request, options);
    }
    async explain(request, options = {}) {
      return this._call("explain", request, options);
    }
    async ask(request, options = {}) {
      return this._call("ask", request, options);
    }
    estimateCost(operation, request) {
      return this._inner.estimateCost(operation, request);
    }
    async checkAvailability() {
      return this._inner.checkAvailability();
    }
    async _call(method, request, options) {
      const tally = {};
      let safe2;
      try {
        safe2 = sanitizeDeep(request, this._vault, tally);
      } catch {
        this._emit({ event: "sanitize_failed", method });
        return _SanitizingAdapter._failure();
      }
      if (Object.keys(tally).length) {
        this._emit({ event: "pii_redacted", method, types: tally, placeholders: this._vault.size });
      }
      const response = await this._inner[method](safe2, options);
      return restoreDeep(response, this._vault);
    }
    _emit(evt) {
      try {
        this._onEvent(evt);
      } catch {
      }
    }
    static _failure() {
      return {
        schemaVersion: "1",
        result: "FAILED",
        blockers: [],
        confidence: 0,
        providerMetadata: { provider: "sanitizer", model: "none", plannerVersion: "unknown", latencyMs: 0 },
        error: "Privacy sanitization failed; the request was not sent.",
        errorCode: "SANITIZE_ERROR"
      };
    }
  };

  // extension/lib/sp-logger.js
  var PREFIX = "[SP:EVENT]";
  var MAX_DEPTH2 = 6;
  function redactValue(key, value, depth) {
    if (depth > MAX_DEPTH2) return "[TRUNCATED]";
    if (typeof value === "string") {
      return isSensitiveKeyName(key) ? "[REDACTED]" : redactText(value);
    }
    if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
      return out;
    }
    return value;
  }
  function write(sink, level, event, fields) {
    const safeFields = redactValue("", fields ?? {}, 0);
    sink(`${PREFIX} ${JSON.stringify({ event, level, ts: Date.now(), ...safeFields })}`);
  }
  function logEvent(event, fields = {}) {
    write((line) => console.log(line), "info", event, fields);
  }
  function logWarn(event, fields = {}) {
    write((line) => console.warn(line), "warn", event, fields);
  }
  function logError(event, fields = {}) {
    write((line) => console.error(line), "error", event, fields);
  }

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
          let genericCheck;
          if (goal) {
            genericCheck = this.isGoalSatisfied(goal, pageState, env);
            if (genericCheck.satisfied) {
              return { complete: true, reason: "goal_already_satisfied", verdict: { satisfied: true, reason: genericCheck.reason }, genericCheck };
            }
          }
          if (!criteria) return { complete: false, reason: "no_criteria", verdict: null, genericCheck };
          if (criteria.requiresEffect !== true) return { complete: false, reason: "no_effect_contract", verdict: null, genericCheck };
          return { complete: false, reason: "unsatisfied", verdict: null, genericCheck };
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
  var QWEN_CANDIDATE_LIMIT = 25;
  var QWEN_MIN_CONFIDENCE = 0.7;
  var AMBIGUITY_MARGIN = 0.05;
  var RIVAL_SHARE = 0.3;
  var DECISIVE_MARGIN = 0.15;
  var SOLE_UNLABELED_CANDIDATE_CONFIDENCE = 0.6;
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set(["button", "link", "menuitem", "tab", "textbox", "combobox"]);
  var INTERACTIVE_TAGS = /* @__PURE__ */ new Set(["button", "a", "input", "select", "textarea", "summary"]);
  var VALUE_TRAILS_MARKERS = ["for", "to", "with"];
  var VALUE_PRECEDES_MARKERS = ["into"];
  function extractRequestedValue(goal, targetLabel = "") {
    const words = String(goal ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return "";
    const bare = words.map((w) => w.toLowerCase().replace(/[.,!?;:]+$/, ""));
    let payload = "";
    const precedesAt = bare.findIndex((w) => VALUE_PRECEDES_MARKERS.includes(w));
    if (precedesAt > 1) {
      payload = words.slice(1, precedesAt).join(" ");
    } else {
      let trailsAt = -1;
      for (let i = 0; i < bare.length - 1; i++) {
        if (VALUE_TRAILS_MARKERS.includes(bare[i])) trailsAt = i;
      }
      if (trailsAt >= 0) payload = words.slice(trailsAt + 1).join(" ");
    }
    payload = payload.replace(/^(the|a|an)\s+/i, "").trim();
    if (!payload) return "";
    const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    if (norm(payload) === norm(targetLabel)) return "";
    return payload;
  }
  var DecisionRouter = class {
    /**
     * @param {object} [options]
     * @param {number} [options.deterministicThreshold]
     * @param {number} [options.mlGroundingThreshold]
     * @param {'cloud'|'local-qwen'} [options.executionMode] - L3 backend selection. Default 'cloud'.
     * @param {object} [options.localQwenAdapter]
     * @param {object} [options.localVisionAdapter]
     * @param {object} [options.cloudAdapter]
     */
    constructor({
      deterministicThreshold = DETERMINISTIC_THRESHOLD,
      mlGroundingThreshold = ML_GROUNDING_THRESHOLD,
      executionMode = "cloud",
      localQwenAdapter = null,
      localVisionAdapter = null,
      cloudAdapter = null
    } = {}) {
      this.deterministicThreshold = deterministicThreshold;
      this.mlGroundingThreshold = mlGroundingThreshold;
      this.executionMode = executionMode;
      const defaultVault = new TokenVault();
      this.localQwenAdapter = localQwenAdapter ?? new SanitizingAdapter(new LocalQwenAdapter(), { vault: defaultVault });
      this.localVisionAdapter = localVisionAdapter ?? new SanitizingAdapter(new LocalVisionAdapter(), { vault: defaultVault });
      this.cloudAdapter = cloudAdapter ?? new SanitizingAdapter(new VercelBackendAdapter(), { vault: defaultVault });
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
     * @param {object[]} [options.completedSteps] - This task's own completed-step
     *   history (session order, oldest first).
     * @param {object[]} [options.settledSteps] - The subset of completedSteps whose
     *   own post-action state IS the state being routed against right now (see
     *   the TASK PROGRESS note on the class above). Supplied by the caller, which
     *   owns the session and the page snapshot; derived fresh every cycle and
     *   never persisted, so it cannot go stale.
     * @param {object[]} [options.unsatisfiedRequirements] - The goal's own
     *   goalCompletionCriteria.successSignals entries not yet historically
     *   satisfied (per the caller's requirementProgress) — same shape as
     *   successSignals ({type, text} or {type, urlPattern}), computed entirely
     *   by the caller. Optional and additive: omitted, this router behaves
     *   exactly as before. Consulted only by structural continuation (see
     *   _resolveActionContinuation) to avoid treating a form's submit control
     *   as the next action while the goal itself still needs something else on
     *   the same page — see that method's own doc comment.
     * @returns {Promise<{ layer: 'deterministic'|'ml_grounding'|'local_qwen'|'cloud', planResponse: object, layer1Ms: number, layer2Ms: number, qwenMs: number, cloudMs: number, qwenFailureReason: string|null }>}
     */
    async route(goal, pageState, options = {}) {
      const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
      const completedSteps = Array.isArray(options.completedSteps) ? options.completedSteps : [];
      const settledSteps = Array.isArray(options.settledSteps) ? options.settledSteps : [];
      const clarifications = Array.isArray(options.cloudContext?.clarifications) ? options.cloudContext.clarifications.filter(Boolean) : [];
      const groundingIntent = clarifications.length ? `${goal} ${clarifications.join(" ")}` : goal;
      if (clarifications.length) {
        console.log(`[SP:DecisionRouter] Grounding with ${clarifications.length} clarification(s) folded into the intent`);
      }
      const candidates = settledSteps.length ? elements.filter((el) => !this._isSettledTarget(el, settledSteps)) : elements;
      if (settledSteps.length) {
        console.log(`[SP:DecisionRouter] Task progress: ${settledSteps.length} settled action(s) \u2014 ${elements.length - candidates.length} target(s) withheld, ${candidates.length} candidate(s) remain`);
      }
      const tL1Start = Date.now();
      const fastMatch = this._evalFastPath(groundingIntent, candidates);
      const layer1Ms = Date.now() - tL1Start;
      if (fastMatch && fastMatch.score >= this.deterministicThreshold) {
        const requiredGate = this._resolveRequiredFieldGate(goal, elements, fastMatch.element);
        if (requiredGate) {
          console.log(`[SP:DecisionRouter] Layer 1 target's form has an unmet required field \u2014 redirecting to elementId=${requiredGate.plan.steps[0].targetElement.elementId}`);
          return { layer: "ml_grounding", planResponse: requiredGate, layer1Ms, layer2Ms: 0, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
        }
        console.log(`[SP:DecisionRouter] Layer 1 FAST PATH matched (score=${fastMatch.score}):`, fastMatch.element.text || fastMatch.element.placeholder);
        console.log(`[SP:V2:DEBUG] layer=deterministic reason=exact_label_match candidateCount=${candidates.length} confidence=${fastMatch.score}`);
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
      const assessment = UIGroundingService.assessGrounding(groundingIntent, candidates);
      const ranked = assessment.ranked;
      const layer2Ms = Date.now() - tL2Start;
      const clearsThreshold = ranked.length > 0 && ranked[0].score >= this.mlGroundingThreshold;
      const insufficientEvidence = clearsThreshold ? this._assessAmbiguity(assessment) : null;
      if (clearsThreshold && !insufficientEvidence) {
        const top = ranked[0];
        const requiredGate = this._resolveRequiredFieldGate(goal, elements, top.element);
        if (requiredGate) {
          console.log(`[SP:DecisionRouter] Layer 2 target's form has an unmet required field \u2014 redirecting to elementId=${requiredGate.plan.steps[0].targetElement.elementId}`);
          return { layer: "ml_grounding", planResponse: requiredGate, layer1Ms, layer2Ms, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
        }
        console.log(`[SP:DecisionRouter] Layer 2 ML GROUNDING matched (score=${top.score}):`, top.element.text || top.element.placeholder);
        console.log(`[SP:V2:DEBUG] layer=ml_grounding reason=feature_vector_score candidateCount=${candidates.length} confidence=${top.score}`);
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
      const continuation = this._resolveActionContinuation(elements, settledSteps, options.unsatisfiedRequirements);
      if (continuation) {
        console.log(`[SP:DecisionRouter] Structural continuation of settled action -> elementId=${continuation.plan.steps[0].targetElement.elementId} (no model invoked)`);
        return { layer: "ml_grounding", planResponse: continuation, layer1Ms, layer2Ms, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
      }
      const l3Reason = insufficientEvidence ? `lexical_evidence_insufficient(${insufficientEvidence})` : "confidence_below_threshold";
      logEvent("layer3_invoked", { goal, executionMode: this.executionMode, reason: l3Reason, candidateCount: candidates.length });
      console.log(`[SP:V2:DEBUG] layer=L3 reason=${l3Reason} candidateCount=${candidates.length} topScore=${assessment.topScore} margin=${assessment.margin.toFixed(3)} executionMode=${this.executionMode}`);
      const l3 = await this._runLayer3(groundingIntent, pageState, candidates, options, ranked);
      if (insufficientEvidence && l3?.planResponse?.result !== "OK") {
        const options2 = ranked.slice(0, 5).map((r) => r.element.text || r.element.ariaLabel || r.element.placeholder || r.element.id).filter(Boolean);
        console.log(`[SP:DecisionRouter] Reasoning tier failed after an evidence escalation (${insufficientEvidence}) \u2014 reporting unresolved ambiguity rather than guessing among ${options2.length} candidate(s)`);
        return {
          layer: l3.layer,
          planResponse: {
            schemaVersion: "1",
            result: "NEEDS_USER",
            state: "ambiguous",
            confidence: 0,
            plannerSummary: options2.length ? `Several controls match this goal equally well: ${options2.join(", ")}. Which one did you mean?` : "Could not determine the next action from this page.",
            providerMetadata: { provider: l3.layer, model: "none", latencyMs: 0 }
          },
          layer1Ms,
          layer2Ms,
          qwenMs: l3.qwenMs ?? 0,
          cloudMs: l3.cloudMs ?? 0,
          qwenFailureReason: l3.qwenFailureReason ?? null
        };
      }
      return { ...l3, layer1Ms, layer2Ms };
    }
    /**
     * L3 router: picks exactly ONE local provider per cycle — Moondream and
     * Qwen are never both invoked in the same cycle. `ranked` (L2's own
     * scoring, already computed by the caller) decides which: any candidate
     * at all (even below L2's own threshold) means Qwen (text) is used; zero
     * candidates means the DOM/text representation has nothing to reason
     * over, so Moondream (visual perception) is used instead. Whichever one
     * is chosen, on failure/unavailability the router falls straight through
     * to Cloud — it does not then try the other local provider. Never retries
     * a provider.
     */
    async _runLayer3(goal, pageState, elements, options, ranked = []) {
      const { signal, cloudContext = {} } = options;
      let qwenMs = 0;
      let qwenFailureReason = null;
      let visionMs = 0;
      let visionFailureReason = null;
      let screenshot = null;
      const getScreenshotOnce = async () => {
        if (!screenshot) {
          screenshot = cloudContext.getScreenshot ? await cloudContext.getScreenshot() : null;
        }
        return screenshot;
      };
      const hasViableTextCandidates = ranked.length > 0;
      if (hasViableTextCandidates) {
        const topCandidates = ranked.slice(0, 5).map((r) => `${r.element.id}(${(r.element.text || r.element.ariaLabel || r.element.placeholder || "").slice(0, 40)}):${r.score.toFixed(3)}`).join(", ");
        console.log(`[SP:DecisionRouter] Layer 3 top candidates: ${topCandidates}`);
      }
      if (this.executionMode === "local-qwen" && !hasViableTextCandidates) {
        const tVisionAvailStart = Date.now();
        let visionAvail;
        try {
          visionAvail = await this.localVisionAdapter.checkAvailability();
        } catch (err) {
          visionAvail = { available: false, reason: err?.message || "availability_check_failed" };
        }
        console.log(`[SP:DecisionRouter] Layer 3 router=vision (no text candidates) Moondream availability=${visionAvail.available} (${Date.now() - tVisionAvailStart}ms)`);
        if (visionAvail.available) {
          const tVisionStart = Date.now();
          try {
            const shot = await getScreenshotOnce();
            const perception = await this.localVisionAdapter.plan({
              schemaVersion: "1",
              goal,
              page: { url: pageState.url, title: pageState.title, screenshot: shot },
              elements
            }, { signal });
            visionMs = Date.now() - tVisionStart;
            if (perception?.result === "FAILED") {
              visionFailureReason = perception.error || perception.errorCode || "vision_failed";
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION resolved FAILED (${visionFailureReason}, ${visionMs}ms) \u2014 falling back to cloud`);
            } else {
              const resolvedElement = elements.find((el) => el.id === perception.elementId);
              if (!resolvedElement) {
                visionFailureReason = "invalid_element_id";
                console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION named an unknown/missing elementId="${perception.elementId}" \u2014 rejected, checking for a sole unlabeled interactive candidate before falling back to cloud`);
                const soleCandidate = this._findSoleUnlabeledInteractiveCandidate(elements);
                if (soleCandidate) {
                  console.log(`[SP:DecisionRouter] Layer 3 sole unlabeled interactive candidate resolved structurally -> elementId=${soleCandidate.id} (no model invoked)`);
                  return {
                    layer: "local_vision",
                    planResponse: this._buildPlanFromElement(goal, soleCandidate, SOLE_UNLABELED_CANDIDATE_CONFIDENCE, "local_vision"),
                    qwenMs,
                    visionMs,
                    cloudMs: 0,
                    qwenFailureReason: null,
                    visionFailureReason: null
                  };
                }
              } else {
                console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION succeeded (${visionMs}ms) elementId=${perception.elementId}`);
                console.log(`SP LOCAL VISION \u2192 Moondream (${visionMs}ms) elementId=${perception.elementId} confidence=${perception.confidence ?? "n/a"}`);
                return {
                  layer: "local_vision",
                  planResponse: this._buildPlanFromElement(goal, resolvedElement, perception.confidence ?? 0.75, "local_vision"),
                  qwenMs,
                  visionMs,
                  cloudMs: 0,
                  qwenFailureReason: null,
                  visionFailureReason: null
                };
              }
            }
          } catch (err) {
            visionMs = Date.now() - tVisionStart;
            visionFailureReason = err?.message || "vision_error";
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION threw (${visionFailureReason}, ${visionMs}ms) \u2014 falling back to cloud`);
          }
        } else {
          visionFailureReason = visionAvail.reason || "moondream_unavailable";
          console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION unavailable (${visionFailureReason}) \u2014 falling back to cloud`);
        }
      } else if (this.executionMode === "local-qwen" && hasViableTextCandidates) {
        const tAvailStart = Date.now();
        let avail;
        try {
          avail = await this.localQwenAdapter.checkAvailability();
        } catch (err) {
          avail = { available: false, reason: err?.message || "availability_check_failed" };
        }
        console.log(`[SP:DecisionRouter] Layer 3 router=qwen (${ranked.length} text candidate(s)) Qwen availability=${avail.available} (${Date.now() - tAvailStart}ms)`);
        if (avail.available) {
          const tQwenStart = Date.now();
          try {
            const qwenElements = ranked.length ? ranked.slice(0, QWEN_CANDIDATE_LIMIT).map((r) => r.element) : elements;
            const planResponse2 = await this.localQwenAdapter.plan({
              schemaVersion: "1",
              goal,
              page: { url: pageState.url, title: pageState.title },
              elements: qwenElements,
              // What this task has already done. _buildQwenPrompt has always
              // rendered a History line from this field, but nothing ever
              // supplied it locally — so the one tier whose whole job is
              // semantic reasoning was reasoning about a multi-step task with
              // no idea which steps were already done, and could only re-derive
              // the same first action. Same structure the cloud tier receives.
              ...cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory }
            }, { signal });
            qwenMs = Date.now() - tQwenStart;
            if (planResponse2?.result === "FAILED") {
              qwenFailureReason = planResponse2.error || planResponse2.errorCode || "qwen_failed";
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN resolved FAILED (${qwenFailureReason}, ${qwenMs}ms) \u2014 falling back to cloud once`);
            } else if (qwenFailureReason = this._qwenUnusableReason(planResponse2, qwenElements)) {
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN result unusable (${qwenFailureReason}, ${qwenMs}ms) \u2014 falling back to cloud once`);
            } else {
              const step = planResponse2?.plan?.steps?.[0];
              const t = step?.targetElement || {};
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN succeeded (${qwenMs}ms) elementId=${t.elementId ?? "n/a"} phase=${step?.phase ?? "n/a"}`);
              logEvent("layer3_qwen_ok", { elementId: t.elementId ?? null, phase: step?.phase ?? null, hasValue: !!t.value });
              return { layer: "local_qwen", planResponse: planResponse2, qwenMs, visionMs, cloudMs: 0, qwenFailureReason: null, visionFailureReason };
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
      const shotForCloud = await getScreenshotOnce();
      const cloudRequest = {
        schemaVersion: "1",
        requestId: cloudContext.requestId,
        goal,
        page: {
          url: pageState.url,
          title: pageState.title,
          screenshot: { image: shotForCloud?.image, mimeType: shotForCloud?.mimeType }
        },
        ...cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory },
        ...cloudContext.clarifications?.length && { clarifications: cloudContext.clarifications },
        ...cloudContext.pageControls?.length && { pageControls: cloudContext.pageControls }
      };
      const planResponse = await this.cloudAdapter.plan(cloudRequest, { signal });
      const cloudMs = Date.now() - tCloudStart;
      console.log(`[SP:DecisionRouter] Layer 3 CLOUD resolved (${cloudMs}ms)`);
      return { layer: "cloud", planResponse, qwenMs, visionMs, cloudMs, qwenFailureReason, visionFailureReason };
    }
    // ── Helpers ─────────────────────────────────────────────────────────────────
    /**
     * Why a non-FAILED Qwen plan can't be trusted, or null when it can. Qwen may
     * only ever point at an element it was offered from the CURRENT page state, and
     * must be confident enough. (A "finish" answer names no element, so only its
     * confidence is checked.)
     *
     * @param {object} planResponse
     * @param {object[]} elements - the candidates Qwen was offered (a subset of the current page state)
     * @returns {'invalid_element_id'|'low_confidence'|null}
     */
    _qwenUnusableReason(planResponse, elements) {
      if (planResponse?.state !== "complete") {
        const elementId = planResponse?.plan?.steps?.[0]?.targetElement?.elementId;
        if (!elementId || !elements.some((el) => el.id === elementId)) return "invalid_element_id";
      }
      const confidence = planResponse?.confidence;
      if (typeof confidence === "number" && confidence < QWEN_MIN_CONFIDENCE) return "low_confidence";
      return null;
    }
    /**
     * Does this element correspond to the target of one of the given steps?
     *
     * Matches an element's own accessible label against the step's recorded
     * intent/description using the exact string-containment convention the
     * dedup guard in v2-task.js already uses, so "which element did that step
     * act on" means the same thing everywhere. Element ids are deliberately NOT
     * used: they are positional (`el_N`) and recomputed per extraction, so they
     * are not stable across cycles — the label is.
     *
     * @param {object} el
     * @param {object[]} steps
     * @returns {boolean}
     */
    /**
     * Is L2's ranking resting on evidence strong enough to ACT on?
     *
     * Returns a reason string when it is not (so the caller escalates to the
     * semantic tier), or null when L2 may commit. Both criteria come from
     * assessGrounding and are measured properties of the current candidate set,
     * never a site, phrase or synonym rule. A single viable candidate is never
     * treated as ambiguous — with no rival there is nothing to confuse it with.
     *
     * @param {{topScore:number, margin:number, rivals:number, unmatchedIntentTokens:string[]}} a
     * @returns {string|null}
     */
    _assessAmbiguity(a) {
      if (a.rivals <= 1) return null;
      if (a.margin < AMBIGUITY_MARGIN) {
        return `insufficient_margin:${a.margin.toFixed(3)}`;
      }
      const top = a.ranked?.[0]?.element;
      const receivesValue = !!top && (["textbox", "combobox", "searchbox", "search"].includes(top.role) || ["input", "textarea"].includes(top.tag));
      const contention = a.topScore > 0 ? a.runnerUpScore / a.topScore : 0;
      if (!receivesValue && a.unmatchedIntentTokens.length > 0 && contention >= RIVAL_SHARE && a.margin < DECISIVE_MARGIN) {
        return `unmatched_intent_vocabulary:${a.unmatchedIntentTokens.join(",")}@contention=${contention.toFixed(2)}`;
      }
      return null;
    }
    /**
     * Structural, single-candidate fallback for when visual perception ran but
     * named no usable element (null, or an id that doesn't match anything in
     * the current page state). Not a second perception attempt and not a
     * guess: it looks for exactly ONE candidate that is already, on its own
     * metadata, an "unlabeled interactive control" — the same generic shape a
     * visually-only icon button has — and only resolves when there is no
     * ambiguity about which one that is.
     *
     * "Unlabeled interactive candidate" is determined ENTIRELY from existing
     * pageState metadata, never from what the element is or looks like:
     *   - an interactive role/tag (the same set PageStateService's own
     *     extraction selector already recognizes as a control worth
     *     extracting at all — see INTERACTIVE_ROLES/INTERACTIVE_TAGS above)
     *   - no text, no ariaLabel, no placeholder, no value — nothing lexical
     *     for L1/L2 to have matched it on, which is exactly why grounding and
     *     visual perception both had nothing to name it with
     *   - a valid element id and an existing, non-zero-area bbox — the two
     *     concrete pieces of evidence that this is a real, located control on
     *     the current page, not a phantom
     *
     * Returns the sole eligible element, or null when there are zero or two-or-
     * more equally eligible candidates — ambiguity is left to the existing
     * cloud fallback, never resolved by guessing between them.
     *
     * @param {object[]} elements - This cycle's full pageState.elements.
     * @returns {object|null}
     */
    _findSoleUnlabeledInteractiveCandidate(elements) {
      const eligible = (elements || []).filter((el) => {
        if (!el || el.visible === false || el.enabled === false) return false;
        if (!(INTERACTIVE_ROLES.has(el.role) || INTERACTIVE_TAGS.has(el.tag))) return false;
        if ((el.text || "").trim() || (el.ariaLabel || "").trim() || (el.placeholder || "").trim() || (el.value || "").trim()) return false;
        if (typeof el.id !== "string" || !el.id) return false;
        if (!el.bbox || !(el.bbox.width > 0) || !(el.bbox.height > 0)) return false;
        return true;
      });
      return eligible.length === 1 ? eligible[0] : null;
    }
    _isSettledTarget(el, steps) {
      const label = (el.text || el.placeholder || el.ariaLabel || "").trim().toLowerCase();
      if (!label) return false;
      return (steps || []).some((step) => {
        const stepIntent = (step.intent || "").trim().toLowerCase();
        const stepDesc = (step.description || "").trim().toLowerCase();
        return stepDesc.includes(label) || stepIntent.includes(label);
      });
    }
    /**
     * Required-field gate: before treating a resolved CLICK target as the next
     * action, check whether its own form still has an empty required field.
     *
     * L1/L2 ground the goal's words against element labels — that is a lexical
     * match, not a check of whether the form is actually fillable yet. A
     * required field whose own label shares none of the goal's vocabulary
     * (measured: "Repository name" scores 0 against "create a new repo" — no
     * token in common at all, a limitation no threshold fixes) never becomes a
     * candidate on lexical grounds, so nothing here stopped a submit control
     * from winning even though the form it belongs to isn't ready to submit.
     *
     * The gate is structural, not lexical: the standard native `element.form`
     * association (`formId`) plus the standard `required` HTML attribute — the
     * same two signals a real browser already uses to refuse a premature submit.
     * No site knowledge, no synonym, no phrase table.
     *
     * When a gate fires, the redirect reuses _buildPlanFromElement exactly as
     * any other fill step: it extracts a value from the goal if one was stated,
     * or leaves it empty. The guide model does not type on the user's behalf
     * either way — an empty-value fill step highlights the field and waits for
     * the user, which is already how ScreenPilot asks for input. No new
     * clarification path is needed for this case.
     *
     * Only ever redirects TO the field, never invents a value FOR it, and only
     * applies when the resolved target is not itself the field being asked for
     * (an input target proceeds untouched — it IS the missing field).
     *
     * @param {string} goal
     * @param {object[]} elements - This cycle's full pageState.elements.
     * @param {object} candidate - L1/L2's own resolved target.
     * @returns {object|null} A ready plan response redirected to the missing
     *   field, or null when nothing gates the candidate.
     */
    _resolveRequiredFieldGate(goal, elements, candidate) {
      const candidateIsInput = ["textbox", "combobox"].includes(candidate.role) || ["input", "textarea"].includes(candidate.tag);
      if (candidateIsInput || !candidate.formId) return null;
      const missing = (elements || []).find(
        (el) => el.formId === candidate.formId && el.required && (["textbox", "combobox"].includes(el.role) || ["input", "textarea"].includes(el.tag)) && el.visible && el.enabled !== false && !(el.value || "").trim()
      );
      if (!missing) return null;
      return this._buildPlanFromElement(goal, missing, 0.9, "ml_grounding");
    }
    /**
     * Structural continuation of an interaction a settled action STARTED but
     * did not finish.
     *
     * Withholding settled targets (see route()) is enough whenever the next
     * action is itself findable by grounding the goal — a newly revealed
     * control usually shares the goal's own vocabulary. It is NOT enough when
     * the continuation control's wording is unrelated to what remains of the
     * goal: measured on a filled search form, the next control scored 0.450,
     * below L2's threshold, so the cycle would fall through to a reasoning
     * model for something the page structure already determines.
     *
     * HTML defines exactly one such relationship generically: a control that
     * submits the form its filled field belongs to, via the standard native
     * `element.form` association (surfaced as `formId` by
     * page-state-service.js). That is what this resolves — no selector, no
     * phrase, no site knowledge, and nothing specific to search.
     *
     * Requires BOTH:
     *   (a) the field's live value is currently non-empty, AND
     *   (b) a settled action of this task targeted that field
     * — (a) alone is deliberately not enough: a field that merely had unrelated
     * pre-existing content (a genuine "change the email to..." goal on a
     * pre-filled field) must stay re-fillable, not be redirected to a submit
     * control it was never asked to reach.
     *
     * @param {object[]} elements - This cycle's full pageState.elements.
     * @param {object[]} settledSteps - Steps whose effect is the current state.
     * @param {object[]} [unsatisfiedRequirements] - See route()'s own doc
     *   comment. Checked immediately before this method would otherwise commit
     *   to the submit control — see _resolveUnsatisfiedRequirementCandidate.
     * @returns {object|null} A ready plan response, or null to fall through.
     */
    _resolveActionContinuation(elements, settledSteps, unsatisfiedRequirements) {
      if (!settledSteps?.length) return null;
      const candidate = (elements || []).find((el) => {
        const isInput = ["textbox", "combobox"].includes(el.role) || ["input", "textarea"].includes(el.tag);
        return isInput && el.formId && (el.value || "").trim() && this._isSettledTarget(el, settledSteps);
      });
      if (!candidate) return null;
      const submitCandidates = elements.filter(
        (el) => el.formId === candidate.formId && el.id !== candidate.id && el.visible && el.enabled !== false && (el.type === "submit" || el.tag === "button" || el.role === "button")
      );
      if (!submitCandidates.length) return null;
      const target = submitCandidates.find((el) => el.type === "submit") || (submitCandidates.length === 1 ? submitCandidates[0] : null);
      if (!target) return null;
      const requirementRedirect = this._resolveUnsatisfiedRequirementCandidate(
        elements,
        settledSteps,
        target.id,
        unsatisfiedRequirements
      );
      if (requirementRedirect) return requirementRedirect;
      const candidateLabel = (candidate.text || candidate.placeholder || candidate.ariaLabel || "").trim();
      const plan = this._buildPlanFromElement(candidateLabel, target, 0.9, "ml_grounding");
      plan.plan.steps[0].completionCondition = "final";
      return plan;
    }
    /**
     * Before structural continuation trusts a settled field's own submit
     * control, check whether the GOAL ITSELF — via its own declared,
     * not-yet-historically-satisfied successSignals (see v2-task.js's
     * requirementProgress model) — still needs something ELSE on this same
     * page. Purely generic: ranks each unsatisfied signal's own `text` against
     * the currently unaddressed candidates using the exact same lexical
     * ranking L1/L2 already use (UIGroundingService.rankElements) — no form,
     * field-name, action-type, or site-specific vocabulary of any kind, and no
     * awareness of what "submit" or "final" mean. A `url_matches` signal
     * describes the URL, not any one control, so it has nothing to rank
     * against here and is skipped, not treated as satisfied or unsatisfied.
     *
     * Returns null (preserving the existing submit continuation byte-for-byte)
     * whenever unsatisfiedRequirements is empty/absent, or no unsatisfied
     * signal's text ranks above rankElements' own relevance floor against any
     * currently unaddressed candidate — including the common case where the
     * goal has exactly one requirement and submitting IS what satisfies it.
     *
     * @param {object[]} elements - This cycle's full pageState.elements.
     * @param {object[]} settledSteps - Steps whose effect is the current state.
     * @param {string} excludeElementId - The submit control continuation was
     *   about to choose; never itself offered as an "other" candidate.
     * @param {object[]} [unsatisfiedRequirements] - successSignal-shaped
     *   {type, text} | {type, urlPattern} entries, in the goal's own declared
     *   order.
     * @returns {object|null} A ready plan response targeting the first
     *   matching unaddressed candidate, or null to fall through unchanged.
     */
    _resolveUnsatisfiedRequirementCandidate(elements, settledSteps, excludeElementId, unsatisfiedRequirements) {
      if (!Array.isArray(unsatisfiedRequirements) || !unsatisfiedRequirements.length) return null;
      const unaddressed = (elements || []).filter(
        (el) => el.id !== excludeElementId && el.visible && el.enabled !== false && !this._isSettledTarget(el, settledSteps)
      );
      if (!unaddressed.length) return null;
      for (const signal of unsatisfiedRequirements) {
        if (!signal?.text) continue;
        const ranked = UIGroundingService.rankElements(signal.text, unaddressed);
        if (ranked.length) {
          console.log(`[SP:DecisionRouter] Structural continuation deferred \u2014 unsatisfied requirement "${signal.text}" matches unaddressed elementId=${ranked[0].element.id} (score=${ranked[0].score.toFixed(3)})`);
          return this._buildPlanFromElement(signal.text, ranked[0].element, ranked[0].score, "ml_grounding");
        }
      }
      return null;
    }
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
      const isInput = ["textbox", "combobox", "search"].includes(element.role) || ["input", "textarea"].includes(element.tag) && !["checkbox", "radio", "switch"].includes(element.role);
      const elementOwnLabel = element.text || element.placeholder || element.ariaLabel || "";
      const displayLabel = elementOwnLabel || goal;
      const value = isInput ? extractRequestedValue(goal, displayLabel) : "";
      const action = isInput ? "fill_form" : "navigate";
      const step = {
        id: 1,
        description: value ? `Type '${value}' into '${displayLabel}'` : `${isInput ? "Fill" : "Click"} '${displayLabel}'`,
        intent: `${isInput ? "fill" : "click"}_${displayLabel}`,
        phase: action,
        completionCondition: "dom_change",
        targetElement: {
          text: elementOwnLabel,
          type: isInput ? "input" : "button",
          intent: displayLabel,
          value,
          elementId: element.id,
          region: element.region ?? null,
          // Already produced by PageStateService (getBoundingClientRect) and
          // already used for vision candidate markers — forwarded here, not
          // recomputed, so the executor has the same known on-page position to
          // fall back to when targetElement.text is empty (see above).
          bbox: element.bbox ?? null
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
        plannerSummary: `[Layer: ${layer}] Resolved target element '${displayLabel}' with confidence ${confidence}`,
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
  function maxPlannerCalls(session) {
    return Math.min(10 + 2 * session.completedSteps.length, 40);
  }
  var _maxPlannerCalls = maxPlannerCalls;
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
        // Phase 4 (TaskProgress): additive, optional fields — same pattern as
        // goalCompletionCriteria above. NOT a schema bump; a pre-Phase-4 session
        // simply lacks them, and every reader treats their absence as "unknown"
        // rather than an error (see task-progress.js).
        replanCount: 0,
        lastActionResult: null,
        lastActionAt: null,
        // Phase 7 (fingerprint optimization): additive, optional fields — same
        // pattern as the Phase 4 fields above. NOT a schema bump. lastFingerprint
        // is a {url, count, hash} object from page-snapshot.js's
        // computeRelevantStateFingerprint(), or null before the first real
        // planning cycle. lastCycleOutcome is one of 'step_completed' |
        // 'element_not_found' | 'fill_verification_failed' | 'dedup_repeat' |
        // 'stale_plan' | 'retryable_error' | 'ambiguous' | 'blocked' | null —
        // see v2-task.js's plan loop for exactly where each is written. Both are
        // read-and-written only via the existing generic patchSession(); no new
        // SessionStore method is introduced for them.
        lastFingerprint: null,
        lastCycleOutcome: null,
        // Dynamic requirement-progress model (false-early-completion redesign):
        // additive, optional — same pattern as the fields above. null until the
        // first cycle that actually evaluates a goalCompletionCriteria with
        // successSignals; from then on, a boolean array parallel to
        // criteria.successSignals BY ARRAY POSITION (the criteria is set once
        // per task and never mutated, so position is already a stable
        // requirement identity — no separate requirement-ID field is needed).
        // Monotonic: once an entry is observed true on any cycle, it stays
        // true for the rest of the task, even if that signal's live-DOM
        // evidence is no longer visible on a later page — see
        // updateRequirementProgress() in v2-task.js. Read-and-written only via
        // the existing generic patchSession(); no new SessionStore method.
        requirementProgress: null,
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
     * Increment replanCount (Phase 4). Purely informational — no stuck-threshold
     * of its own; the existing plannerAttemptCount/stepAttemptCount budgets
     * (above) already bound how many times a session can actually replan. This
     * only gives TaskProgress a real number to report instead of inferring one.
     * Call alongside each genuine REPLAN_TRIGGERED transition (never on a
     * SESSION_RESUME/PAUSED-resume — those are not replans).
     *
     * @param {number} tabId
     * @returns {Promise<number>} the new count, or 0 if the session is gone
     */
    async incrementReplanCount(tabId) {
      const session = await _read(tabId);
      if (!session) return 0;
      const next = (session.replanCount ?? 0) + 1;
      const t = nowMs();
      await _write(tabId, { ...session, replanCount: next, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
      return next;
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

  // extension/lib/sensitive-guard.js
  function classifyDomElement(el) {
    try {
      if (!el || typeof el.getAttribute !== "function") return null;
      const tag = String(el.tagName || "").toLowerCase();
      const isField = tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
      if (!isField) return null;
      const attr = (name) => el.getAttribute(name) || "";
      return classifyElement({
        type: tag === "input" ? attr("type") || el.type || "" : "",
        autocomplete: attr("autocomplete"),
        placeholder: attr("placeholder"),
        ariaLabel: attr("aria-label") || attr("title"),
        name: attr("name"),
        id: attr("id"),
        label: el.labels?.[0]?.textContent || ""
      });
    } catch {
      return null;
    }
  }
  function guardHighlighter(highlighter, { classify = classifyDomElement } = {}) {
    return {
      show(element, text) {
        const type = classify(element);
        return highlighter.show(element, type && fieldInstruction(type) || text);
      },
      clear() {
        return highlighter.clear();
      }
    };
  }

  // extension/lib/task-progress.js
  var ProgressStatus = Object.freeze({
    IDLE: "idle",
    PLANNING: "planning",
    RUNNING: "running",
    PAUSED: "paused",
    COMPLETE: "complete",
    ERROR: "error",
    ABORTED: "aborted"
  });
  var TASKSTATE_TO_STATUS = Object.freeze({
    IDLE: ProgressStatus.IDLE,
    PLANNING: ProgressStatus.PLANNING,
    EXECUTING: ProgressStatus.RUNNING,
    AWAITING_USER: ProgressStatus.RUNNING,
    VALIDATING: ProgressStatus.RUNNING,
    RECOVERING: ProgressStatus.RUNNING,
    PAUSED: ProgressStatus.PAUSED,
    COMPLETE: ProgressStatus.COMPLETE,
    ERROR: ProgressStatus.ERROR
  });
  var PHASE_TO_STATUS = Object.freeze({
    PLANNING: ProgressStatus.PLANNING,
    EXECUTING: ProgressStatus.RUNNING,
    PAUSED: ProgressStatus.PAUSED
  });
  var TERMINAL_STATUSES = Object.freeze([ProgressStatus.COMPLETE, ProgressStatus.ERROR, ProgressStatus.ABORTED]);
  function safe(text) {
    return typeof text === "string" && text ? redactText(text) : text ?? null;
  }
  function summarizeStep(step) {
    if (!step) return null;
    return {
      description: safe(step.description),
      intent: safe(step.intent),
      completionCondition: step.completionCondition ?? null,
      completedAt: step.completedAt ?? null
    };
  }
  function deriveStatus(session, taskState, aborted) {
    if (aborted) return ProgressStatus.ABORTED;
    if (taskState && TASKSTATE_TO_STATUS[taskState]) return TASKSTATE_TO_STATUS[taskState];
    if (!session) return ProgressStatus.IDLE;
    return PHASE_TO_STATUS[session.phase] ?? ProgressStatus.RUNNING;
  }
  function deriveTaskProgress(session, { taskState, aborted = false } = {}) {
    const status = deriveStatus(session, taskState, aborted);
    if (!session) {
      return {
        goal: null,
        status,
        currentStep: null,
        completedSteps: { count: 0, steps: [] },
        remainingSteps: null,
        expectedState: null,
        attempts: null,
        replanCount: 0,
        lastAction: null,
        completion: { complete: status === ProgressStatus.COMPLETE, reason: null },
        failure: { failed: status === ProgressStatus.ERROR, reason: null },
        aborted: status === ProgressStatus.ABORTED,
        createdAt: null,
        updatedAt: null
      };
    }
    const completedSteps = Array.isArray(session.completedSteps) ? session.completedSteps : [];
    const budget = maxPlannerCalls({ completedSteps });
    return {
      goal: safe(session.goal),
      status,
      currentStep: summarizeStep(session.pendingStep),
      completedSteps: { count: completedSteps.length, steps: completedSteps.map(summarizeStep) },
      // Always null — see the module doc comment: genuinely not tracked by the
      // current single-step-per-cycle architecture, never fabricated here.
      remainingSteps: null,
      expectedState: session.pendingStep ? {
        urlPattern: session.pendingStep.expectedUrlPattern ?? null,
        urlChanges: session.pendingStep.expectedUrlChanges ?? false
      } : null,
      attempts: {
        step: session.stepAttemptCount ?? 0,
        stepMax: 3,
        // MAX_STEP_ATTEMPTS in session-store.js — not exported as a constant import to keep this module's only session-store dependency the pure budget formula; both are small, stable, already-tested constants.
        planner: session.plannerAttemptCount ?? 0,
        plannerMax: budget
      },
      replanCount: session.replanCount ?? 0,
      lastAction: session.lastActionResult ? { result: session.lastActionResult, at: session.lastActionAt ?? null } : null,
      completion: { complete: status === ProgressStatus.COMPLETE, reason: status === ProgressStatus.COMPLETE ? "goal_reached" : null },
      failure: { failed: status === ProgressStatus.ERROR, reason: status === ProgressStatus.ERROR ? session.currentBlocker ?? null : null },
      aborted: status === ProgressStatus.ABORTED,
      createdAt: session.createdAt ?? null,
      updatedAt: session.updatedAt ?? null
    };
  }

  // extension/lib/task-metrics.js
  var ROUTER_LAYER_TO_BUCKET = Object.freeze({
    deterministic: "deterministic",
    ml_grounding: "mlGrounding",
    local_qwen: "localQwen",
    local_vision: "localVision",
    cloud: "cloud"
  });
  var REPLAN_OUTCOME_TO_BUCKET = Object.freeze({
    element_not_found: "elementNotFound",
    fill_verification_failed: "fillVerificationFailed",
    dedup_repeat: "dedupRepeat",
    stale_plan: "stalePlan",
    retryable_error: "retryableError",
    step_completed: "ordinaryProgression"
  });
  var MODEL_LAYERS = /* @__PURE__ */ new Set(["local_qwen", "local_vision", "cloud"]);
  function emptyLatencyBucket() {
    return { totalMs: 0, avgMs: 0, count: 0 };
  }
  function latencyBucket(records, field) {
    const values = [];
    for (const r of records) {
      const v = r?.[field];
      if (typeof v === "number" && v > 0) values.push(v);
    }
    if (!values.length) return emptyLatencyBucket();
    const totalMs = values.reduce((a, b) => a + b, 0);
    return { totalMs, avgMs: Math.round(totalMs / values.length), count: values.length };
  }
  function deriveTaskMetrics(cycleRecords, sessionSnapshot, { outcome = null, outcomeReason = null } = {}) {
    const records = Array.isArray(cycleRecords) ? cycleRecords : [];
    const routedRecords = records.filter((r) => r && !r.skipped);
    const skippedRecords = records.filter((r) => r && r.skipped);
    const layerCounts = { deterministic: 0, mlGrounding: 0, localQwen: 0, localVision: 0, cloud: 0 };
    for (const r of routedRecords) {
      const bucket = ROUTER_LAYER_TO_BUCKET[r.layer];
      if (bucket) layerCounts[bucket] += 1;
    }
    const replansByOutcome = { elementNotFound: 0, fillVerificationFailed: 0, dedupRepeat: 0, stalePlan: 0, retryableError: 0, ordinaryProgression: 0 };
    for (const r of routedRecords) {
      const bucket = REPLAN_OUTCOME_TO_BUCKET[r.outcome];
      if (bucket) replansByOutcome[bucket] += 1;
    }
    const replansTotal = Object.values(replansByOutcome).reduce((a, b) => a + b, 0);
    const verificationOutcomes = { passed: 0, inconclusive: 0, fillNotSatisfied: 0 };
    for (const r of routedRecords) {
      if (r.verdict === "PASSED") verificationOutcomes.passed += 1;
      else if (r.verdict === "INCONCLUSIVE") verificationOutcomes.inconclusive += 1;
      if (r.outcome === "fill_verification_failed") verificationOutcomes.fillNotSatisfied += 1;
    }
    const completed = Array.isArray(sessionSnapshot?.completedSteps) ? sessionSnapshot.completedSteps.length : replansByOutcome.ordinaryProgression + (outcome === "complete" ? 1 : 0);
    let modelCallsAvoidedEstimate = 0;
    let lastRoutedLayer = null;
    for (const r of records) {
      if (!r) continue;
      if (r.skipped) {
        if (MODEL_LAYERS.has(lastRoutedLayer)) modelCallsAvoidedEstimate += 1;
      } else {
        lastRoutedLayer = r.layer ?? null;
      }
    }
    const startedAt = typeof sessionSnapshot?.createdAt === "number" ? sessionSnapshot.createdAt : null;
    const endedAt = Date.now();
    return {
      schemaVersion: "1",
      taskId: sessionSnapshot?.sessionId ?? null,
      startedAt,
      endedAt,
      totalLatencyMs: startedAt != null ? endedAt - startedAt : null,
      cycles: {
        total: records.length,
        routed: routedRecords.length,
        skipped: skippedRecords.length
      },
      layerCounts,
      layerLatencyMs: {
        stateExtraction: latencyBucket(records, "domMs"),
        l1: latencyBucket(routedRecords, "layer1Ms"),
        l2: latencyBucket(routedRecords, "layer2Ms"),
        localQwen: latencyBucket(routedRecords, "qwenMs"),
        localVision: latencyBucket(routedRecords, "visionMs"),
        cloud: latencyBucket(routedRecords, "cloudMs"),
        postActionVerify: latencyBucket(routedRecords, "verifyMs")
      },
      actions: {
        completed,
        verificationOutcomes
      },
      replans: {
        total: replansTotal,
        byOutcome: replansByOutcome
      },
      fingerprintOptimization: {
        skipsAttempted: skippedRecords.length,
        modelCallsAvoidedEstimate
      },
      outcome,
      outcomeReason
    };
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
  var _lastUserActedAtMs = null;
  var _lastUserActedIntent = null;
  var _cycleRecords = [];
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
  async function captureScreenshot(sensitiveRegions) {
    const resp = await chrome.runtime.sendMessage({
      type: "CAPTURE_SCREENSHOT",
      sensitiveRegions: sensitiveRegions || [],
      devicePixelRatio: window.devicePixelRatio || 1
    });
    if (!resp?.success) throw new Error(resp?.error || "Screenshot capture failed");
    return { image: resp.image, mimeType: resp.mimeType || "image/png" };
  }
  function sanitizeControlField(value) {
    if (!value) return value;
    return PrivacySanitizer.isSensitiveElement({ ariaLabel: value, text: value }) ? PrivacySanitizer.REDACTED : value;
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
      const text = sanitizeControlField((el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80));
      const ariaLabel = sanitizeControlField((el.getAttribute("aria-label") || "").trim().slice(0, 80));
      const title = sanitizeControlField((el.getAttribute("title") || "").trim().slice(0, 80));
      const imgAlt = sanitizeControlField(el.querySelector?.("img[alt]")?.getAttribute?.("alt")?.trim() ?? "");
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
      // What this step is supposed to ACHIEVE, kept alongside it so a later cycle
      // can re-check the effect itself rather than only whether the page as a
      // whole still looks identical. See deriveSettledSteps.
      targetLabel: (step.targetElement?.text || "").trim(),
      requestedValue: (step.targetElement?.value || "").trim(),
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
      targetLabel: pendingStep.targetLabel ?? "",
      requestedValue: pendingStep.requestedValue ?? "",
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
  function stepEffectStillHolds(step, pageState, currentSnap = null) {
    const want = (step.requestedValue || "").trim();
    const label = (step.targetLabel || "").trim().toLowerCase();
    if (want && label && Array.isArray(pageState?.elements)) {
      const satisfied = pageState.elements.some((el) => {
        const elLabel = (el.text || el.placeholder || el.ariaLabel || "").trim().toLowerCase();
        return elLabel === label && valueSatisfies(el.value || "", want);
      });
      if (satisfied) return true;
    }
    const from = step.urlBefore;
    const to = step.urlAfter;
    if (from && to && from !== to && currentSnap?.url === to) return true;
    return false;
  }
  function deriveSettledSteps(completedSteps, currentSnap, pageState = null) {
    if (!currentSnap) return [];
    return (completedSteps || []).slice(-3).filter((step) => {
      if (stepEffectStillHolds(step, pageState, currentSnap)) return true;
      const urlBaseline = step.urlAfter ?? step.urlBefore;
      if (urlBaseline != null && currentSnap.url !== urlBaseline) return false;
      if (step.domHashAfter != null) return currentSnap.domHash === step.domHashAfter;
      if (step.domHashBefore != null) return currentSnap.domHash === step.domHashBefore;
      return false;
    });
  }
  function isGoalConsumed(session, pageState, settledSteps, router) {
    if (!settledSteps?.length || !Array.isArray(pageState?.elements)) return false;
    const intent = [session?.goal, ...(session?.clarifications ?? []).map((c) => c.text)].filter(Boolean).join(" ");
    const unsettled = pageState.elements.filter((el) => !router._isSettledTarget(el, settledSteps));
    if (UIGroundingService.rankElements(intent, unsettled).length) return false;
    return !router._resolveActionContinuation(pageState.elements, settledSteps);
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
  function updateRequirementProgress(previousProgress, details) {
    const list = Array.isArray(details) ? details : [];
    const prev = Array.isArray(previousProgress) ? previousProgress : [];
    const length = Math.max(list.length, prev.length);
    const next = [];
    for (let i = 0; i < length; i++) {
      next.push(prev[i] === true || list[i]?.passed === true);
    }
    return next;
  }
  function remainingRequirementCount(progress) {
    return Array.isArray(progress) ? progress.filter((p) => p !== true).length : 0;
  }
  function isRequirementSetComplete(criteria, progress) {
    if (!criteria || criteria.requiresEffect !== true) return null;
    const totalSignals = Array.isArray(criteria.successSignals) ? criteria.successSignals.length : 0;
    if (totalSignals === 0) return false;
    if (!Array.isArray(progress) || progress.length < totalSignals) return false;
    const matched = progress.slice(0, totalSignals).filter((p) => p === true).length;
    const satisfiedByMatch = criteria.match === "any" ? matched >= 1 : matched === totalSignals;
    if (!satisfiedByMatch) return false;
    if (typeof criteria.confidenceThreshold === "number" && matched / totalSignals < criteria.confidenceThreshold) {
      return false;
    }
    return true;
  }
  async function applyRequirementProgress(tabId, criteria, previousProgress, gate) {
    const updated = updateRequirementProgress(previousProgress, gate.verdict?.details);
    if (gate.verdict?.details) {
      await SessionStore.patchSession(tabId, { requirementProgress: updated });
    }
    const requirementSetComplete = isRequirementSetComplete(criteria, updated);
    return {
      complete: requirementSetComplete === null ? gate.complete : requirementSetComplete,
      progress: updated,
      usedRequirementHistory: requirementSetComplete !== null
    };
  }
  async function _requirementGateAllowsCompletion(tabId, session) {
    const criteria = session?.goalCompletionCriteria;
    if (!criteria || criteria.requiresEffect !== true) return true;
    const gate = GoalVerifier.shouldComplete(criteria);
    const { complete } = await applyRequirementProgress(tabId, criteria, session.requirementProgress, gate);
    return complete;
  }
  function _emitTaskMetrics(session, { outcome, outcomeReason = null } = {}) {
    try {
      logEvent("task_metrics", deriveTaskMetrics(_cycleRecords, session, { outcome, outcomeReason }));
    } catch (err) {
      console.warn("[SP:V2] task_metrics emission failed (ignored):", err);
    }
  }
  async function _showGoalCompleteCard(tabId, goal) {
    const s = await SessionStore.load(tabId);
    showCompletionCard({
      goal,
      steps: s?.completedSteps.length ?? 0,
      startedAt: _taskStartedAt
    });
    _emitTaskMetrics(s, { outcome: "complete" });
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
    const { executionMode = "cloud" } = storage ? await storage.get(["executionMode"]) : { executionMode: "cloud" };
    const piiVault = new TokenVault();
    const cloudAdapter = new SanitizingAdapter(new VercelBackendAdapter(), { vault: piiVault });
    const localQwenAdapter = new SanitizingAdapter(new LocalQwenAdapter(), { vault: piiVault });
    const localVisionAdapter = new SanitizingAdapter(new LocalVisionAdapter(), { vault: piiVault });
    const decisionRouter = new DecisionRouter({ executionMode, localQwenAdapter, localVisionAdapter, cloudAdapter });
    let planRetryCount = 0;
    let localPageState = null;
    let consecutiveSkipCount = 0;
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
      logEvent("task_progress_snapshot", deriveTaskProgress(session, { taskState: _state }));
      if (_generation !== myGen) return;
      console.log(`[SP:V2:TRACE] state transition phase=${session.phase} goal="${redactText(session.goal)}"`);
      let settledSteps = [];
      let entrySnap = null;
      try {
        const lastStep = session.completedSteps[session.completedSteps.length - 1];
        const currentSnap = capturePageSnapshot("");
        entrySnap = currentSnap;
        settledSteps = deriveSettledSteps(session.completedSteps, currentSnap);
        console.log(`[SP:V2:DIAG] Plan loop entry \u2014 completedSteps=${session.completedSteps.length} stepAttemptCount=${session.stepAttemptCount} phase=${session.phase}`, {
          pendingStep: session.pendingStep ? { intent: session.pendingStep.intent, domHashBefore: session.pendingStep.domHashBefore } : null,
          lastCompletedStep: lastStep ? { intent: lastStep.intent, domHashBefore: lastStep.domHashBefore, urlBefore: lastStep.urlBefore } : null,
          currentUrl: currentSnap.url,
          currentDomHash: currentSnap.domHash
        });
      } catch {
      }
      let cyclePageState = null;
      let cycleExtractMs = 0;
      let cycleGenericCheck = null;
      {
        console.log("[SP:V2:TRACE] verify START");
        const tGoalStart = Date.now();
        const tExtractStart = Date.now();
        const pageState = PageStateService.extractPageState();
        cycleExtractMs = Date.now() - tExtractStart;
        cyclePageState = pageState;
        settledSteps = deriveSettledSteps(session.completedSteps, entrySnap, pageState);
        console.log(`[SP:V2:PERF] stage=task_progress settledActions=${settledSteps.length} of ${session.completedSteps.length} completed`);
        const gate = GoalVerifier.shouldComplete(session.goalCompletionCriteria, {}, session.goal, pageState);
        cycleGenericCheck = gate.genericCheck ?? null;
        const goalVerifyMs = Date.now() - tGoalStart;
        console.log(`[SP:V2:TRACE] verify END complete=${gate.complete} reason=${gate.reason}`);
        console.log(`[SP:V2:PERF] stage=verifier_gate extractMs=${cycleExtractMs} goalVerifyMs=${goalVerifyMs} elements=${pageState.elements.length}`);
        const {
          complete: verifierGateComplete,
          usedRequirementHistory: verifierGateUsedHistory
        } = await applyRequirementProgress(tabId, session.goalCompletionCriteria, session.requirementProgress, gate);
        if (verifierGateComplete) {
          console.log("[SP:GoalCompletion]", {
            source: "verifier",
            satisfied: true,
            reason: verifierGateUsedHistory ? "requirements_satisfied" : gate.reason
          });
          console.log(`[SP:V2:PERF] goalVerifyMs=${goalVerifyMs} totalPlanningMs=${goalVerifyMs} qwen=SKIPPED reason=goal_already_satisfied`);
          applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
          await _showGoalCompleteCard(tabId, session.goal);
          return;
        }
        {
          if (isGoalConsumed(session, pageState, settledSteps, decisionRouter) && await _requirementGateAllowsCompletion(tabId, session)) {
            console.log("[SP:GoalCompletion]", { source: "verifier", satisfied: true, reason: "goal_consumed", settledActions: settledSteps.length });
            console.log(`[SP:V2:PERF] goalVerifyMs=${goalVerifyMs} totalPlanningMs=${goalVerifyMs} qwen=SKIPPED reason=goal_consumed`);
            applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
            await _showGoalCompleteCard(tabId, session.goal);
            return;
          }
        }
      }
      const { isStuck: budgetExhausted, reason: budgetReason } = await SessionStore.incrementPlannerAttemptOnly(tabId);
      if (budgetExhausted) {
        applyEvent(TaskEvent.PLAN_FAILED, { reason: budgetReason });
        showStatus(`ScreenPilot: ${budgetReason}`, "error");
        _emitTaskMetrics(session, { outcome: "failed", outcomeReason: "PLANNER_BUDGET_EXCEEDED" });
        await SessionStore.clear(tabId);
        return;
      }
      const currentFingerprint = computeRelevantStateFingerprint(cyclePageState);
      const canSkipRouting = session.lastCycleOutcome === "step_completed" && !!session.lastFingerprint && session.lastFingerprint.url === currentFingerprint.url && session.lastFingerprint.hash === currentFingerprint.hash && consecutiveSkipCount < 1;
      async function recordCycleOutcome(outcome2, extra = {}) {
        _cycleRecords.push({
          skipped: false,
          domMs: cycleExtractMs,
          layer: null,
          layer1Ms: 0,
          layer2Ms: 0,
          qwenMs: 0,
          visionMs: 0,
          cloudMs: 0,
          verifyMs: null,
          verdict: null,
          outcome: outcome2,
          ...extra
        });
        await SessionStore.patchSession(tabId, { lastCycleOutcome: outcome2, lastFingerprint: currentFingerprint });
      }
      if (canSkipRouting) {
        _cycleRecords.push({
          skipped: true,
          domMs: cycleExtractMs,
          layer: null,
          layer1Ms: 0,
          layer2Ms: 0,
          qwenMs: 0,
          visionMs: 0,
          cloudMs: 0,
          verifyMs: null,
          verdict: null,
          outcome: "skipped"
        });
        consecutiveSkipCount += 1;
        console.log(`[SP:V2:PERF] stage=fingerprint_gate action=skip consecutiveSkipCount=${consecutiveSkipCount} url=${currentFingerprint.url} elementCount=${currentFingerprint.count}`);
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      consecutiveSkipCount = 0;
      const tCycleStart = Date.now();
      showStatus("ScreenPilot \xB7 Planning\u2026", "planning");
      const freshSession = session;
      if (!freshSession) {
        hideStatus();
        return;
      }
      if (_generation !== myGen) return;
      const nClarifications = freshSession.clarifications?.length ?? 0;
      const tPageControlsStart = Date.now();
      const pageControls = collectPageControls();
      const pageControlsMs = Date.now() - tPageControlsStart;
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
      let cycleRoutedLayer = null;
      let cycleLayer1Ms = 0, cycleLayer2Ms = 0, cycleQwenMs = 0, cycleCloudMs = 0, cycleVisionMs = 0;
      try {
        const tDomStart = Date.now();
        const pageState = cyclePageState ?? PageStateService.extractPageState();
        localPageState = pageState;
        const domMs = cyclePageState ? cycleExtractMs : Date.now() - tDomStart;
        logEvent("compact_state_built", { reqId, ...estimateCompactionSavings(pageState) });
        const preL3Check = cycleGenericCheck ?? GoalVerifier.isGoalSatisfied(freshSession.goal, pageState);
        if (preL3Check.satisfied && await _requirementGateAllowsCompletion(tabId, freshSession)) {
          window.removeEventListener("popstate", onNavCheck);
          console.log(`[SP:V2:TRACE] plan END reqId=${reqId} outcome=goal_already_satisfied`);
          console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=0 layer2Ms=0 qwenMs=0 cloudMs=0 postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${Date.now() - tReqStart} l3=SKIPPED reason=goal_already_satisfied`);
          applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
          await _showGoalCompleteCard(tabId, freshSession.goal);
          return;
        }
        const getScreenshot = async () => {
          const tSnap = Date.now();
          const shot = await captureScreenshot(pageState.sensitiveRegions);
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
        const unsatisfiedRequirements = freshSession.goalCompletionCriteria?.requiresEffect === true ? freshSession.goalCompletionCriteria.successSignals.filter(
          (_, i) => freshSession.requirementProgress?.[i] !== true
        ) : void 0;
        const routed = await decisionRouter.route(freshSession.goal, pageState, {
          signal: planController.signal,
          cloudContext,
          completedSteps: freshSession.completedSteps,
          settledSteps,
          unsatisfiedRequirements
        });
        planResp = routed.planResponse;
        const layer1Ms = routed.layer1Ms ?? 0;
        const layer2Ms = routed.layer2Ms ?? 0;
        const qwenMs = routed.qwenMs ?? 0;
        const cloudMs = routed.cloudMs ?? 0;
        const totalPlanningMs = Date.now() - tReqStart;
        cycleRoutedLayer = routed.layer;
        cycleLayer1Ms = layer1Ms;
        cycleLayer2Ms = layer2Ms;
        cycleQwenMs = qwenMs;
        cycleCloudMs = cloudMs;
        cycleVisionMs = routed.visionMs ?? 0;
        console.log(`[SP:V2:TRACE] layer result layer=${routed.layer} confidence=${planResp.confidence} qwenFailureReason=${routed.qwenFailureReason ?? "n/a"}`);
        console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=${layer1Ms} layer2Ms=${layer2Ms} qwenMs=${qwenMs} cloudMs=${cloudMs} screenshotMs=${screenshotMs} postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${totalPlanningMs} l3Layer=${routed.layer}`);
        console.log(`[SP:V2:PERF] stage=routing routeMs=${layer1Ms + layer2Ms + qwenMs + cloudMs} pageControlsMs=${pageControlsMs} domReused=${cyclePageState ? "yes" : "no"} goalCheckReused=${cycleGenericCheck ? "yes" : "no"}`);
        logEvent("routing_result", {
          reqId,
          layer: routed.layer,
          layer1Ms,
          layer2Ms,
          qwenMs,
          cloudMs,
          visionMs: routed.visionMs ?? 0,
          totalPlanningMs,
          confidence: planResp.confidence,
          qwenFailureReason: routed.qwenFailureReason ? redactText(routed.qwenFailureReason) : null,
          visionFailureReason: routed.visionFailureReason ? redactText(routed.visionFailureReason) : null
        });
        if (routed.qwenFailureReason || routed.visionFailureReason) {
          logWarn("provider_fallback", {
            reqId,
            resolvedBy: routed.layer,
            qwenFailureReason: routed.qwenFailureReason ? redactText(routed.qwenFailureReason) : null,
            visionFailureReason: routed.visionFailureReason ? redactText(routed.visionFailureReason) : null
          });
        }
      } catch (err) {
        window.removeEventListener("popstate", onNavCheck);
        console.log(`[SP:V2:TRACE] plan ERROR reqId=${reqId} name=${err?.name} message=${err?.message}`);
        console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${planController.signal.aborted} reason=${planController.signal.reason}`);
        if (planController.signal.aborted || err?.name === "AbortError") {
          console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_aborted_exception`);
          console.log("[SP:V2] Request aborted \u2014 replanning");
          await recordCycleOutcome("stale_plan");
          continue;
        }
        console.error("[SP:V2] Planning failed:", err);
        logError("plan_failed", { reqId, name: err?.name ?? null, message: redactText(err?.message ?? "") });
        applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
        showStatus(`ScreenPilot: Planning error \u2014 ${err.message}`, "error");
        _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: "NETWORK_ERROR" });
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
        await recordCycleOutcome("stale_plan");
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
          await recordCycleOutcome("stale_plan", {
            layer: cycleRoutedLayer,
            layer1Ms: cycleLayer1Ms,
            layer2Ms: cycleLayer2Ms,
            qwenMs: cycleQwenMs,
            cloudMs: cycleCloudMs,
            visionMs: cycleVisionMs
          });
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
          const {
            complete: gateComplete27,
            usedRequirementHistory: usedHistory27
          } = await applyRequirementProgress(tabId, criteria, freshSession.requirementProgress, gate);
          console.log("[SP:GoalCompletionGate]", {
            requiresEffect: criteria.requiresEffect,
            verifierComplete: gateComplete27,
            verifierReason: usedHistory27 ? gateComplete27 ? "requirements_satisfied" : "requirements_remaining" : gate.reason
          });
          if (!gateComplete27) {
            console.log("[SP:GoalCompletion]", {
              source: "planner",
              state: "complete",
              accepted: false,
              reason: usedHistory27 ? "requirements_remaining" : gate.reason
            });
            await recordCycleOutcome("stale_plan", {
              layer: cycleRoutedLayer,
              layer1Ms: cycleLayer1Ms,
              layer2Ms: cycleLayer2Ms,
              qwenMs: cycleQwenMs,
              cloudMs: cycleCloudMs,
              visionMs: cycleVisionMs
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
        _emitTaskMetrics(freshSession, { outcome: "complete" });
        await SessionStore.clear(tabId);
        return;
      }
      if (outcome === "blocked") {
        const blocker = planResp.blockers?.[0] ?? "A precondition is not met";
        await SessionStore.setBlocker(tabId, blocker);
        await SessionStore.patchSession(tabId, { pauseReason: "blocked" });
        await SessionStore.setPhase(tabId, "PAUSED");
        applyEvent(TaskEvent.WORKFLOW_PAUSED);
        await recordCycleOutcome("blocked", {
          layer: cycleRoutedLayer,
          layer1Ms: cycleLayer1Ms,
          layer2Ms: cycleLayer2Ms,
          qwenMs: cycleQwenMs,
          cloudMs: cycleCloudMs,
          visionMs: cycleVisionMs
        });
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
          _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: "AMBIGUOUS_LIMIT" });
          await SessionStore.clear(tabId);
          return;
        }
        await SessionStore.patchSession(tabId, {
          pauseReason: "ambiguous",
          ambiguitySummary: planResp.plannerSummary ?? "Multiple valid paths exist for this goal"
        });
        await SessionStore.setPhase(tabId, "PAUSED");
        applyEvent(TaskEvent.AMBIGUOUS_RECEIVED);
        await recordCycleOutcome("ambiguous", {
          layer: cycleRoutedLayer,
          layer1Ms: cycleLayer1Ms,
          layer2Ms: cycleLayer2Ms,
          qwenMs: cycleQwenMs,
          cloudMs: cycleCloudMs,
          visionMs: cycleVisionMs
        });
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
          await recordCycleOutcome("retryable_error", {
            layer: cycleRoutedLayer,
            layer1Ms: cycleLayer1Ms,
            layer2Ms: cycleLayer2Ms,
            qwenMs: cycleQwenMs,
            cloudMs: cycleCloudMs,
            visionMs: cycleVisionMs
          });
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        applyEvent(TaskEvent.PLAN_FAILED, { reason: errorCode });
        if (retryable) {
          showStatus(`ScreenPilot: ${planResp.error ?? "Connection problem \u2014 please try again"}`, "error");
          _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: errorCode === "NETWORK_ERROR" ? "NETWORK_ERROR" : errorCode === "REQUEST_TIMEOUT" ? "REQUEST_TIMEOUT" : "HTTP_ERROR" });
        } else {
          showStatus(`ScreenPilot: ${planResp.error ?? "Planning failed"}`, "error");
          _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: null });
          await SessionStore.clear(tabId);
        }
        return;
      }
      planRetryCount = 0;
      const plannerStep = planResp.plan.steps[0];
      if (!plannerStep) {
        console.warn("[SP:V2] state=planned but steps is empty \u2014 treating as ambiguous");
        await recordCycleOutcome("stale_plan", {
          layer: cycleRoutedLayer,
          layer1Ms: cycleLayer1Ms,
          layer2Ms: cycleLayer2Ms,
          qwenMs: cycleQwenMs,
          cloudMs: cycleCloudMs,
          visionMs: cycleVisionMs
        });
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
              _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: "STEP_ATTEMPTS_EXCEEDED" });
              await SessionStore.clear(tabId);
              return;
            }
            await recordCycleOutcome("dedup_repeat", {
              layer: cycleRoutedLayer,
              layer1Ms: cycleLayer1Ms,
              layer2Ms: cycleLayer2Ms,
              qwenMs: cycleQwenMs,
              cloudMs: cycleCloudMs,
              visionMs: cycleVisionMs
            });
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
      const completedStepsCountBeforeExecute = freshSession.completedSteps.length;
      const result = await _executeStep(tabId, plannerStep, freshSession.goal, myGen);
      await SessionStore.patchSession(tabId, { lastActionResult: result, lastActionAt: Date.now() });
      if (result === "navigated" || result === "aborted") {
        await recordCycleOutcome("stale_plan", {
          layer: cycleRoutedLayer,
          layer1Ms: cycleLayer1Ms,
          layer2Ms: cycleLayer2Ms,
          qwenMs: cycleQwenMs,
          cloudMs: cycleCloudMs,
          visionMs: cycleVisionMs
        });
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
          _emitTaskMetrics(freshSession, { outcome: "failed", outcomeReason: "STEP_ATTEMPTS_EXCEEDED" });
          await SessionStore.clear(tabId);
          return;
        }
        await SessionStore.setPhase(tabId, "PLANNING");
        applyEvent(TaskEvent.REPLAN_TRIGGERED, { reason: "element_not_found" });
        await SessionStore.incrementReplanCount(tabId);
        await recordCycleOutcome("element_not_found", {
          layer: cycleRoutedLayer,
          layer1Ms: cycleLayer1Ms,
          layer2Ms: cycleLayer2Ms,
          qwenMs: cycleQwenMs,
          cloudMs: cycleCloudMs,
          visionMs: cycleVisionMs
        });
        await _shadowGoalVerify(tabId, "REPLAN", false);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      await SessionStore.setPhase(tabId, "PLANNING");
      applyEvent(TaskEvent.REPLAN_TRIGGERED, { intent: plannerStep.intent });
      await SessionStore.incrementReplanCount(tabId);
      const postExecuteSession = await SessionStore.load(tabId);
      const stepGenuinelyCompleted = (postExecuteSession?.completedSteps?.length ?? completedStepsCountBeforeExecute) > completedStepsCountBeforeExecute;
      await recordCycleOutcome(stepGenuinelyCompleted ? "step_completed" : "fill_verification_failed", {
        layer: cycleRoutedLayer,
        layer1Ms: cycleLayer1Ms,
        layer2Ms: cycleLayer2Ms,
        qwenMs: cycleQwenMs,
        cloudMs: cycleCloudMs,
        visionMs: cycleVisionMs
      });
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
    const tExecuteStart = Date.now();
    return new Promise((resolve) => {
      if (_generation !== myGen) {
        resolve("aborted");
        return;
      }
      const highlighter = guardHighlighter(resolveHighlighter());
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
        if (_lastUserActedAtMs !== null) {
          console.log(`[SP:V2:PERF] stage=action_to_next_highlight fillToHighlightMs=${Date.now() - _lastUserActedAtMs} fromIntent="${_lastUserActedIntent ?? ""}" toIntent="${plannerStep.intent ?? ""}"`);
          _lastUserActedAtMs = null;
          _lastUserActedIntent = null;
        }
        logEvent("executor_result", { tabId, ok: true, phase: step.phase, completionCondition: step.completionCondition });
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
        const tMarkStart = Date.now();
        await SessionStore.markPendingStep(tabId, buildPendingStepContext(step));
        console.log(`[SP:V2:PERF] stage=executor executorMs=${Date.now() - tExecuteStart} markPendingStepMs=${Date.now() - tMarkStart} intent="${plannerStep.intent ?? ""}"`);
      });
      executor.on("element:not_found", ({ reason, isOptional }) => {
        if (isOptional) return;
        applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { reason });
        logEvent("executor_result", { tabId, ok: false, reason: redactText(reason) });
        done("element_not_found");
      });
      executor.on("user:acted", async ({ step, trigger, observedValue }) => {
        applyEvent(TaskEvent.USER_ACTED, { trigger });
        const isFillStep = plannerStep.phase === "fill_form" || plannerStep.completionCondition === "input_filled";
        const requestedValue = (plannerStep.targetElement?.value ?? "").trim();
        if (isFillStep && requestedValue && observedValue !== null && observedValue !== void 0 && !valueSatisfies(observedValue, requestedValue)) {
          console.warn(`[SP:V2] Fill verification FAILED \u2014 requested="${requestedValue}" observed="${observedValue ?? ""}" \u2014 step NOT settled, replanning`);
          console.log(`[SP:V2:PERF] stage=post_action_verify verdict=FAILED reason=requested_value_not_present`);
          const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
          if (isStuck) {
            applyEvent(TaskEvent.PLAN_FAILED, { reason });
            showStatus(`ScreenPilot: ${reason}`, "error");
            await SessionStore.clear(tabId);
            done("aborted");
            return;
          }
          applyEvent(TaskEvent.REPLAN_TRIGGERED, { reason: "fill_value_not_satisfied" });
          done("completed");
          return;
        }
        _lastUserActedAtMs = Date.now();
        _lastUserActedIntent = plannerStep.intent ?? null;
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
        const verifyMs = Date.now() - tVerifyStart;
        if (_generation !== myGen) {
          done("aborted");
          return;
        }
        post = capturePageSnapshot("");
        const verdict = validateStep(pre, post);
        console.log(`[SP:V2] user:acted verdict=${verdict} domHashBefore=${pre?.domHash} domHashAfter=${post.domHash} urlBefore=${pre?.url} urlAfter=${post.url}`);
        console.log(`[SP:V2:PERF] stage=post_action_verify postActionVerifyMs=${verifyMs} verdict=${verdict} trigger=${trigger}`);
        await SessionStore.completeStep(tabId, {
          description: step.description,
          intent: plannerStep.intent,
          completionCondition: step.completionCondition,
          targetLabel: (plannerStep.targetElement?.text || "").trim(),
          requestedValue: (plannerStep.targetElement?.value || "").trim(),
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
          const {
            complete: gate26Complete,
            progress: progress26,
            usedRequirementHistory: used26
          } = await applyRequirementProgress(tabId, s26?.goalCompletionCriteria, s26?.requirementProgress, gate);
          if (gate26Complete) {
            console.log("[SP:GoalCompletion]", {
              source: "verifier",
              satisfied: true,
              signalsMatched: used26 ? `${progress26.filter(Boolean).length}/${progress26.length}` : `${gate.verdict.matchedSignals}/${gate.verdict.totalSignals}`
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
        if (isTerminalStep(plannerStep) && await _requirementGateAllowsCompletion(tabId, await SessionStore.load(tabId))) {
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
      console.log(`[SP:V2] [${ts()}] Resuming: phase=${session.phase} pauseReason=${session.pauseReason ?? "null"} steps=${session.completedSteps.length} goal="${redactText(session.goal)}"`);
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
          if (isTerminalStep(session.pendingStep) && await _requirementGateAllowsCompletion(tabId, session)) {
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
              if (isTerminalStep(pendingStep) && await _requirementGateAllowsCompletion(tabId, session)) {
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
    logEvent("task_progress_snapshot", deriveTaskProgress(await SessionStore.load(_tabId), { aborted: true }));
    _emitTaskMetrics(await SessionStore.load(_tabId), { outcome: "aborted", outcomeReason: "USER_CANCELLED" });
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
    _cycleRecords = [];
    console.log("[SP:V2] \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    console.log(`[SP:V2] [${ts()}] New task: "${redactText(goal)}"`);
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
    if (_tabId) {
      const tabIdSnapshot = _tabId;
      SessionStore.load(tabIdSnapshot).then((s) => logEvent("task_progress_snapshot", deriveTaskProgress(s, { aborted: true }))).catch(() => {
      });
      SessionStore.load(tabIdSnapshot).then((s) => _emitTaskMetrics(s, { outcome: "aborted", outcomeReason: "USER_CANCELLED" })).catch(() => {
      });
      SessionStore.clear(tabIdSnapshot).catch(() => {
      });
    }
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
