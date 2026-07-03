// ScreenPilot v2 — Task Orchestrator (Architecture B)
//
// Restored mechanically from committed bundle e9a3031 (v2-task section lines 1319–2044).
// Single intentional deviation: BYOK apiKey pass-through in _runPlanLoop().

import { ExecutorEngine }                         from './services/executor-engine.js';
import { VercelBackendAdapter }                   from './providers/vercel-backend-adapter.js';
import { capturePageSnapshot }                    from './lib/page-snapshot.js';
import { TaskState, TaskEvent, transition }       from './shared/state-machine/transitions.js';
import { SessionStore }                           from './services/session-store.js';
import { classifyNavigation, NavClassification }  from './services/navigation-classifier.js';

let _state = TaskState.IDLE;
function ts() {
  return (new Date()).toISOString();
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
  console.log(`[SP:V2] [${ts()}] STATE ${from} → ${to}  event=${event}${detail ? "  " + detail : ""}`);
  return true;
}
let _tabId = null;
let _generation = 0;
let _executor = null;
let _taskContext = null;
let _taskStartedAt = null;
const MAX_CLARIFICATIONS = 5;
const STATUS_ID = "sp-v2-status-banner";
function showStatus(text, type = "info") {
  let el = document.getElementById(STATUS_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STATUS_ID;
    el.style.cssText = [
      "position:fixed",
      "top:16px",
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
    "top:16px",
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
  const stepsHtml = recent.map((s) =>
    `<div style="display:flex;align-items:flex-start;gap:7px;padding:1px 0;font-size:11px">` +
    `<span style="flex-shrink:0;color:#3a7d44">✓</span>` +
    `<span style="color:#555">${s.description}</span></div>`
  ).join("");
  const currentHtml = ctx.currentStep
    ? `<div style="display:flex;align-items:flex-start;gap:7px;padding:2px 0;font-size:11px">` +
      `<span style="flex-shrink:0;color:#cc2222;font-weight:700">→</span>` +
      `<span style="color:#f0f0f0;font-weight:600">${ctx.currentStep}</span></div>`
    : "";
  const n = (ctx.steps || []).length;
  const progress = n === 0 ? "Starting…" : `${n} step${n !== 1 ? "s" : ""} completed`;
  el.innerHTML =
    `<div style="padding:8px 12px 6px;border-bottom:1px solid rgba(255,255,255,0.05)">` +
    `<div style="font-size:10px;font-weight:700;color:#cc2222;letter-spacing:0.1em;text-transform:uppercase">ScreenPilot</div>` +
    `<div style="font-size:11px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ctx.goal || ""}</div>` +
    `</div>` +
    ((stepsHtml || currentHtml)
      ? `<div style="padding:6px 12px">${stepsHtml}${currentHtml}</div>`
      : "") +
    `<div style="padding:3px 12px 7px;font-size:10px;color:#333">${progress}</div>`;
  document.body.appendChild(el);
}
function showCompletionCard(data) {
  hideStatus();
  const card = document.createElement("div");
  card.id = STATUS_ID;
  card.style.cssText = [
    "position:fixed",
    "top:16px",
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
  const elapsed = data.startedAt ? Math.round((Date.now() - data.startedAt) / 1000) : null;
  const timeText = elapsed != null
    ? (elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`)
    : "";
  card.innerHTML =
    `<div style="padding:12px 14px 10px;border-bottom:1px solid rgba(255,255,255,0.05);text-align:center">` +
    `<div style="font-size:18px;color:#3a7d44;margin-bottom:3px">✓</div>` +
    `<div style="font-size:11px;font-weight:700;color:#3a7d44;letter-spacing:0.08em;text-transform:uppercase">Task Completed</div>` +
    `</div>` +
    `<div style="padding:10px 14px 8px">` +
    `<div style="font-size:11px;color:#999;line-height:1.4">${data.goal || "Goal completed"}</div>` +
    `<div style="display:flex;gap:12px;margin-top:6px">` +
    `<span style="font-size:10px;color:#555">Steps: <span style="color:#777">${data.steps}</span></span>` +
    (timeText ? `<span style="font-size:10px;color:#555">Time: <span style="color:#777">${timeText}</span></span>` : "") +
    `</div></div>` +
    `<div style="padding:0 14px 12px">` +
    `<button id="sp-v2-newtask-btn" style="width:100%;padding:7px;background:#cc2222;color:#fff;` +
    `border:none;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:0.03em">` +
    `Start New Task</button></div>`;
  document.body.appendChild(card);
  document.getElementById("sp-v2-newtask-btn").addEventListener("click", () => {
    hideStatus();
    openV2Overlay();
  });
  setTimeout(hideStatus, 10000);
}
const PAUSED_ID = "sp-v2-paused-banner";
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
const AMBIGUOUS_ID = "sp-v2-ambiguous-banner";
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
  console.warn("[SP:V2] window.__SP_Highlighter not found — using fallback outline highlighter");
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
function buildPendingStepContext(step) {
  return {
    description: step.description,
    intent: step.intent,
    completionCondition: step.completionCondition,
    expectedUrlPattern: step.expectedPageState?.urlPattern ?? null,
    expectedUrlChanges: step.expectedPageState?.urlChanges ?? false,
    urlBefore: window.location.href,
    stepStartedAt: Date.now()
  };
}
function buildStepRecord(pendingStep) {
  return {
    description: pendingStep.description,
    intent: pendingStep.intent,
    completionCondition: pendingStep.completionCondition,
    urlBefore: pendingStep.urlBefore,
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
async function _runPlanLoop(tabId, myGen) {
  const { openRouterApiKey } = await chrome.storage.local.get('openRouterApiKey');
  const adapter = new VercelBackendAdapter({ apiKey: openRouterApiKey ?? undefined });
  while (true) {
    if (_generation !== myGen) {
      console.log(`[SP:V2] Plan loop gen=${myGen} superseded by gen=${_generation} — exiting`);
      return;
    }
    const session = await SessionStore.load(tabId);
    if (!session) {
      console.warn("[SP:V2] Session expired or cleared — stopping plan loop");
      hideStatus();
      return;
    }
    if (_generation !== myGen) return;
    const { isStuck: budgetExhausted, reason: budgetReason } = await SessionStore.incrementPlannerAttemptOnly(tabId);
    if (budgetExhausted) {
      applyEvent(TaskEvent.PLAN_FAILED, { reason: budgetReason });
      showStatus(`ScreenPilot: ${budgetReason}`, "error");
      await SessionStore.clear(tabId);
      return;
    }
    showStatus("ScreenPilot · Planning…", "planning");
    let screenshot;
    try {
      screenshot = await captureScreenshot();
    } catch (err) {
      console.error("[SP:V2] Screenshot failed:", err);
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "screenshot_failed" });
      showStatus(`ScreenPilot: Screenshot error — ${err.message}`, "error");
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
    console.log(`[SP:V2] [${ts()}] /api/plan  step=${freshSession.completedSteps.length + 1}  url=${window.location.href}  clarifications=${nClarifications}`);
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
        }
      });
    } catch (err) {
      console.error("[SP:V2] /api/plan failed:", err);
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
      showStatus(`ScreenPilot: Network error — ${err.message}`, "error");
      await SessionStore.clear(tabId);
      return;
    }
    if (_generation !== myGen) return;
    console.log(`[SP:V2] [${ts()}] result=${planResp.result} state=${planResp.state} steps=${planResp.plan?.steps?.length ?? 0}  plannerSummary="${planResp.plannerSummary ?? ""}"`);
    const outcome = resolveOutcome(planResp);
    if (outcome === "goal_reached") {
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
        showStatus("ScreenPilot: Cannot determine next step — goal is too ambiguous", "error");
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
      applyEvent(TaskEvent.PLAN_FAILED, { reason: planResp.errorCode ?? "planner_failed" });
      showStatus(`ScreenPilot: ${planResp.error ?? "Planning failed"}`, "error");
      await SessionStore.clear(tabId);
      return;
    }
    const plannerStep = planResp.plan.steps[0];
    if (!plannerStep) {
      console.warn("[SP:V2] state=planned but steps is empty — treating as ambiguous");
      continue;
    }
    applyEvent(TaskEvent.PLAN_RECEIVED, { intent: plannerStep.intent });
    await SessionStore.setPhase(tabId, "EXECUTING");
    const result = await _executeStep(tabId, plannerStep, freshSession.goal, myGen);
    if (result === "navigated" || result === "aborted") {
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
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await SessionStore.setPhase(tabId, "PLANNING");
    applyEvent(TaskEvent.REPLAN_TRIGGERED, { intent: plannerStep.intent });
  }
}
async function _executeStep(tabId, plannerStep, goal, myGen) {
  if (!window.DOMMatcher) {
    console.error("[SP:V2] DOMMatcher not available — cannot execute step");
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
        if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
        done("navigated");
        return;
      }
      showStatus("Verifying…", "validating");
      await new Promise((r) => setTimeout(r, 600));
      if (_generation !== myGen) {
        done("aborted");
        return;
      }
      const pre = executor.getPreActionSnapshot();
      const post = capturePageSnapshot("");
      const verdict = validateStep(pre, post);
      await SessionStore.completeStep(tabId, {
        description: step.description,
        intent: plannerStep.intent,
        completionCondition: step.completionCondition,
        urlBefore: pre?.url ?? window.location.href,
        urlAfter: post.url,
        completedAt: Date.now()
      });
      applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
      if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
      executor.advance();
    });
    executor.on("plan:complete", () => {
      if (!expectsNavigation) done("completed");
    });
    executor.start(makeSingleStepPlan(plannerStep, goal));
  });
}
export async function _bootstrapSession(tabId) {
  const myGen = ++_generation;
  try {
    const session = await SessionStore.load(tabId);
    if (!session) {
      console.log("[SP:V2] No active session — waiting for user input");
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
        await _runPlanLoop(tabId, myGen);
      } else if (classification === NavClassification.REFRESH) {
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
      console.warn("[SP:V2] EXECUTING with no pendingStep — recovering to PLANNING");
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
    showStatus("ScreenPilot: Session expired — please start a new task", "error");
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
    showStatus("ScreenPilot: Session expired — please start a new task", "error");
    return;
  }
  if (session.currentBlocker !== null) {
    const { isStuck, reason } = await SessionStore.incrementAuthAttempt(_tabId);
    if (isStuck) {
      _state = TaskState.PAUSED;
      applyEvent(TaskEvent.CANCEL_CLICKED);
      showStatus(`ScreenPilot: Cannot complete — ${reason}`, "error");
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
    console.error("[SP:V2] Tab ID not resolved — cannot start task");
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
  console.log("[SP:V2] ─────────────────────────────────────────");
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
const OVERLAY_ID = "sp-v2-overlay";
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
    <button id="sp-v2-close-btn" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;padding:2px 4px">×</button>
  </div>
  <div style="padding:12px 16px 16px">
    <textarea id="sp-v2-goal-input" placeholder="What do you want to do?" rows="3"
      style="width:100%;box-sizing:border-box;background:#161616;border:1px solid rgba(255,255,255,0.1);border-radius:8px;
             color:#fff;font-size:13px;padding:10px 12px;resize:none;outline:none;
             font-family:inherit;line-height:1.5"></textarea>
    <button id="sp-v2-start-btn"
      style="margin-top:8px;width:100%;padding:10px;background:#cc2222;color:#fff;border:none;
             border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">Start →</button>
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
    console.warn("[SP:V2] Could not resolve tab ID — cross-page resume disabled");
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
export function __getState() {
  return _state;
}
export function __getGeneration() {
  return _generation;
}
export function __resetState() {
  _state = TaskState.IDLE;
  _generation = 0;
}
export function __setTabId(id) {
  _tabId = id;
}
console.log('[SP:V2] Ready — popup: "Open ScreenPilot"  console: __SP_V2_RUN("goal")');
