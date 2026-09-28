// ScreenPilot v2 — Task Orchestrator (Architecture B)
//
// Restored mechanically from committed bundle e9a3031 (v2-task section lines 1319–2044).
// Phase 2: BYOK (the earlier "single intentional deviation" this comment used
// to describe) was removed — provider keys are server-side only.

import { ExecutorEngine, valueSatisfies }         from './services/executor-engine.js';
import { VercelBackendAdapter }                   from './providers/vercel-backend-adapter.js';
import { PageStateService }                       from './services/page-state-service.js';
import { DecisionRouter }                          from './services/decision-router.js';
import { LocalQwenAdapter }                        from './providers/local-qwen-adapter.js';
import { LocalVisionAdapter }                      from './providers/local-vision-adapter.js';
import { TokenVault }                              from './lib/pii-vault.js';
import { capturePageSnapshot, computeRelevantStateFingerprint } from './lib/page-snapshot.js';
import { TaskState, TaskEvent, transition }       from './shared/state-machine/transitions.js';
import { SessionStore }                           from './services/session-store.js';
import { GoalVerifier }                           from './services/goal-verifier.js';
import { UIGroundingService }                     from './services/ui-grounding-service.js';
import { classifyNavigation, NavClassification }  from './services/navigation-classifier.js';
import { PrivacySanitizer }                       from './lib/privacy-sanitizer.js';
import { SanitizingAdapter }                      from './providers/sanitizing-adapter.js';
import { guardHighlighter }                       from './lib/sensitive-guard.js';
import { redactText }                             from './lib/pii-detector.js';
import { estimateCompactionSavings }              from './lib/compact-page-state.js';
import { logEvent, logWarn, logError }            from './lib/sp-logger.js';
import { deriveTaskProgress }                     from './lib/task-progress.js';
import { deriveTaskMetrics }                      from './lib/task-metrics.js';

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
// Perf markers for the user-perceived gap between acting on one step and the
// next step being pointed at (see the user:acted / element:ready handlers).
// Module-level because the two events belong to two different ExecutorEngine
// instances — one per step.
let _lastUserActedAtMs = null;
let _lastUserActedIntent = null;
// Phase 7: per-cycle metrics records for the CURRENT task, accumulated across
// planning-loop cycles within this content-script lifetime. Page-scoped, like
// _taskContext/_taskStartedAt above — reset only on a genuinely NEW task
// (_startNewTask), not on a resume/bootstrap, so a task_metrics summary
// emitted after a navigation/reload honestly covers only the cycles that ran
// in THIS lifetime (same class of scoping limitation _taskContext already
// has across navigation).
let _cycleRecords = [];
const MAX_CLARIFICATIONS = 5;
// B5: transient backend failures that are safe to retry without clearing the session.
// HTTP_ERROR is the adapter's fallback code for a non-OK HTTP response (5xx surface here);
// 4xx validation failures carry their own specific errorCodes and are NOT retried.
const RETRYABLE_PLAN_ERRORS = new Set(["NETWORK_ERROR", "REQUEST_TIMEOUT", "HTTP_ERROR"]);
const MAX_PLAN_RETRIES = 2; // attempt 1 immediate, then retries at 1s and 2s
const STATUS_ID = "sp-v2-status-banner";

function getStorageArea() {
  return chrome.storage?.local ?? chrome.storage?.session ?? null;
}

function showStatus(text, type = "info") {
  let el = document.getElementById(STATUS_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STATUS_ID;
    // Bottom-right, matching the task panel / completion card (Phase 19). The banner
    // used to sit top-left, where it visually obstructed highlighted targets and
    // tooltips during AWAITING_USER (the element:ready fallback keeps it on screen
    // for the whole step after a navigation resets _taskContext). Highlighted
    // elements are scrolled to viewport center, so the bottom-right corner never
    // covers the target, its tooltip, or the click area. (Phase 25)
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
  // Bottom-right so the progress panel never covers the element being instructed.
  // GitHub's create menu / avatar / notifications live in the top-right; a top-right
  // panel overlapped exactly the controls we point at (Phase 19, Issue 1).
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
const CONFETTI_ID = "sp-v2-confetti";
// Self-contained canvas confetti — no external assets (CSP-safe for content scripts).
// Fires a single burst that fades and removes its own canvas well before the
// completion card auto-dismisses.
function launchConfetti() {
  document.getElementById(CONFETTI_ID)?.remove();
  const canvas = document.createElement("canvas");
  canvas.id = CONFETTI_ID;
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return; }
  const colors = ["#cc2222", "#3a7d44", "#f0c000", "#ffffff", "#e07a2a"];
  const parts = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.3,
    r: 4 + Math.random() * 5,
    c: colors[(Math.random() * colors.length) | 0],
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
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.vr;
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
  // Bottom-right (matches the progress panel) so completion never covers page controls.
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
  card.innerHTML =
    `<div style="padding:14px 16px 8px;text-align:center">` +
    `<div style="font-size:22px;margin-bottom:4px">🎉</div>` +
    `<div style="font-size:12px;font-weight:700;color:#3a7d44;letter-spacing:0.08em;text-transform:uppercase">Task Complete</div>` +
    `</div>` +
    `<div style="padding:0 16px 16px">` +
    `<div style="font-size:11px;color:#777;margin-bottom:3px">Successfully completed:</div>` +
    `<div style="font-size:12px;color:#f0f0f0;line-height:1.4">${data.goal || "Goal completed"}</div>` +
    `</div>`;
  document.body.appendChild(card);
  launchConfetti();
  // Auto-dismiss after 4 seconds. Session clearing is handled by the caller.
  setTimeout(hideStatus, 4000);
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
async function captureScreenshot(sensitiveRegions) {
  // sensitiveRegions come from this cycle's own PageStateService.extractPageState()
  // (CSS-pixel bboxes of password/email/PII fields) — forwarded here so the
  // background service worker can black them out before returning the image,
  // ensuring an unredacted screenshot never exists past this same content-script cycle.
  const resp = await chrome.runtime.sendMessage({
    type: "CAPTURE_SCREENSHOT",
    sensitiveRegions: sensitiveRegions || [],
    devicePixelRatio: window.devicePixelRatio || 1
  });
  if (!resp?.success) throw new Error(resp?.error || "Screenshot capture failed");
  return { image: resp.image, mimeType: resp.mimeType || "image/png" };
}
// pageControls is sent to the CLOUD planner as-is (decision-router.js attaches
// it to cloudContext.pageControls verbatim) — unlike PageStateService.elements,
// it is built here from raw DOM reads and never passed through
// PrivacySanitizer upstream. Each field is checked independently and, only
// when actually sensitive, replaced with PrivacySanitizer.REDACTED — an
// ordinary control (e.g. "Search") is returned completely unchanged, and a
// control with only one sensitive field (e.g. a sign-out button whose text
// embeds an email) keeps its other fields/region/tag so it still contributes
// to grounding.
function sanitizeControlField(value) {
  if (!value) return value;
  return PrivacySanitizer.isSensitiveElement({ ariaLabel: value, text: value }) ? PrivacySanitizer.REDACTED : value;
}
function collectPageControls() {
  if (!window.DOMMatcher) return [];
  const selector = 'button, a[href], [role="button"], [role="menuitem"], '
                 + 'input[type="submit"], input[type="button"], summary';
  const seen    = new Set();
  const buckets = { top_navigation: [], side_navigation: [], other: [] };
  const LIMITS  = { top_navigation: 8, side_navigation: 8, other: 4 };
  const SP_SEL  = '[id^="sp-"],[id^="screenpilot-"],[class*="sp-"],[data-screenpilot]';

  for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el)) continue;
    if (!window.DOMMatcher.isVisible(el)) continue;
    if (el.closest?.(SP_SEL)) continue;
    seen.add(el);

    const text      = sanitizeControlField((el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80));
    const ariaLabel = sanitizeControlField((el.getAttribute('aria-label') || '').trim().slice(0, 80));
    const title     = sanitizeControlField((el.getAttribute('title')       || '').trim().slice(0, 80));
    const imgAlt    = sanitizeControlField(el.querySelector?.('img[alt]')?.getAttribute?.('alt')?.trim() ?? '');

    if (!text && !ariaLabel && !title && !imgAlt) continue;

    const region = window.DOMMatcher.detectRegion(el);
    const key    = buckets[region] !== undefined ? region : 'other';
    if (buckets[key].length >= LIMITS[key]) continue;
    buckets[key].push({ region, tag: el.tagName, text, ariaLabel, title, imgAlt });
  }

  return [...buckets.top_navigation, ...buckets.side_navigation, ...buckets.other];
}

function buildPendingStepContext(step) {
  // Capture domHashBefore so the bootstrap REFRESH path can detect whether the
  // action already produced a DOM change (menu opened, modal appeared, etc.)
  // even when the URL stayed the same.
  const snap = capturePageSnapshot('');
  return {
    description: step.description,
    intent: step.intent,
    completionCondition: step.completionCondition,
    // What this step is supposed to ACHIEVE, kept alongside it so a later cycle
    // can re-check the effect itself rather than only whether the page as a
    // whole still looks identical. See deriveSettledSteps.
    targetLabel: (step.targetElement?.text || '').trim(),
    requestedValue: (step.targetElement?.value || '').trim(),
    expectedUrlPattern: step.expectedPageState?.urlPattern ?? null,
    expectedUrlChanges: step.expectedPageState?.urlChanges ?? false,
    urlBefore: window.location.href,
    domHashBefore: snap.domHash,
    stepStartedAt: Date.now()
  };
}
function buildStepRecord(pendingStep) {
  // Captured now (the step is already confirmed complete on this code path) so the
  // dedup guard below can tell "still sitting in this step's own post-completion
  // state" apart from "something genuinely new happened since" — see its comment.
  // Degrade-safe: matches the existing capturePageSnapshot() try/catch convention
  // elsewhere in this file (mock/headless environments without a live DOM).
  let domHashAfter = null;
  try { domHashAfter = capturePageSnapshot('').domHash ?? null; } catch { /* mock/headless fallback */ }
  return {
    description: pendingStep.description,
    intent: pendingStep.intent,
    completionCondition: pendingStep.completionCondition,
    targetLabel: pendingStep.targetLabel ?? '',
    requestedValue: pendingStep.requestedValue ?? '',
    urlBefore: pendingStep.urlBefore,
    domHashBefore: pendingStep.domHashBefore ?? null,  // carry through for dedup guard
    urlAfter: window.location.href,
    domHashAfter,
    completedAt: Date.now()
  };
}
function toExecutorStep(plannerStep) {
  return { ...plannerStep, expectedOutcome: plannerStep.expectedPageState };
}
// Single source of truth for whether a resolved step actually navigates. All three
// decision-router/local-qwen-adapter tiers set expectedPageState.urlChanges from
// unreliable signals (a hardcoded false, or Qwen's own action verb) — this derives
// it from the resolved DOM element's real tag/href instead, since that's ground
// truth and already sitting unused in PageStateService's element list. Only <a href>
// is handled: JS-driven navigation and hash-only/query-only links can't be inferred
// generically without site-specific guessing, so those cases fall through unchanged.
function computeExpectedNavigationFromHref(href) {
  const trimmed = (href || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower === '#' || lower.startsWith('mailto:') || lower.startsWith('tel:')) {
    return { urlChanges: false };
  }
  let target;
  try { target = new URL(trimmed, window.location.href); } catch { return null; }
  if (target.origin === window.location.origin && target.pathname === window.location.pathname) {
    return null; // same-path (hash-only/query-only) — ambiguous, leave existing signal
  }
  return { urlChanges: true, urlPattern: target.pathname };
}
function computeExpectedNavigation(el) {
  if (!el || el.tag !== 'a') return null;
  return computeExpectedNavigationFromHref(el.href);
}
// Same ground truth as computeExpectedNavigation above, but resolved from the
// ACTUAL LIVE DOM element the executor is about to click (available at
// element:ready, before the user acts) rather than the pageState.elements
// descriptor snapshot enrichStepFromPageState reads. Covers a clickable wrapper
// (a <button>, a <div>, a <span role="button">) built around a real anchor,
// which the descriptor-based check above cannot see — that descriptor only
// records the PLANNER's own chosen element's own tag/href, never its ancestry.
// Real-Chrome finding (bbc.com, goal "Go to the Technology section"): the
// executor's resolved click target was a <div>, not an <a>, so the tag==='a'
// check never applied and expectedPageState was left at whatever L1/L2/L3
// guessed (here: urlChanges: false) even though the div very plausibly sits
// inside — or wraps — a real navigable <a href="/technology">.
function computeExpectedNavigationFromElement(element) {
  if (!element) return null;
  const tag = element.tagName?.toLowerCase?.();
  const anchor = tag === 'a' ? element
    : (typeof element.closest === 'function' ? element.closest('a[href]') : null);
  if (!anchor) return null;
  return computeExpectedNavigationFromHref(anchor.getAttribute?.('href') || anchor.href || '');
}
// Enrich a freshly-selected planner step with ground-truth navigation/region info
// looked up from the same PageStateService element list the tier resolved it
// against (all three tiers echo the element's `id` back as targetElement.elementId).
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
// Shared by the STALE_PLAN discard check and the deduplication guard below:
// does `proposedStep` match one of the most recently completed steps, and
// does `currentSnap` correspond to that step's own post-completion state?
// Returns null when there's no matching completed step at all (nothing for
// either caller to act on); otherwise { matchingCompleted, urlSame, domHashSame }
// — callers decide what "urlSame && domHashSame" means for their own purpose.
// See the dedup guard's own comment for why domHashAfter (not domHashBefore)
// is the correct baseline for a STICKY same-page effect.
function matchesCompletedStep(completedSteps, pendingStep, proposedStep, currentSnap) {
  if (!proposedStep) return null;
  const recentCompleted = (completedSteps || []).slice(-3);
  const targetText      = (proposedStep.targetElement?.text || '').trim().toLowerCase();
  const planIntent      = (proposedStep.intent || '').trim().toLowerCase();

  const matchingCompleted = recentCompleted.slice().reverse().find(step => {
    const stepIntent  = (step.intent || '').trim().toLowerCase();
    const stepDesc    = (step.description || '').trim().toLowerCase();
    const intentMatch = stepIntent && (stepIntent === planIntent || stepDesc.includes(planIntent) || planIntent.includes(stepIntent));
    const textMatch   = targetText && stepDesc.toLowerCase().includes(targetText);
    return intentMatch || textMatch;
  });
  if (!matchingCompleted) return null;

  // A completed step's own destination is urlAfter (where it left the page),
  // not urlBefore (where it started) — for a navigation-causing step these
  // differ, and comparing against urlBefore would wrongly treat "we're still
  // sitting on the page that step navigated TO" as "the URL changed". Falls
  // back to urlBefore for older records that predate urlAfter being stored.
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
// TASK PROGRESS projection: of this task's own completed steps, which ones'
// effects ARE the state we are about to plan against?
//
// Uses the same "is the page still in that step's own post-completion state"
// test the dedup guard applies (urlAfter/domHashAfter baseline, with the same
// fallbacks for older records) — the difference is only WHEN it is consulted.
// The dedup guard asks it after the planner has already chosen an action, so
// it can reject but not redirect; asking it BEFORE planning lets the router
// withhold those already-actioned targets and pick the next action instead.
//
// Derived fresh from the session and the live snapshot on every cycle and
// never persisted, so it cannot go stale: once the page moves on from a
// step's recorded after-state, that step stops being reported as settled and
// its target becomes an ordinary candidate again.
function stepEffectStillHolds(step, pageState, currentSnap = null) {
  // Action-appropriate evidence that the step's own effect survives, checked
  // against the CURRENT state rather than against a remembered page hash.
  // Each action type is asked the question that actually decides whether it is
  // still done; a step with no such evidence falls back to the fingerprint
  // test in deriveSettledSteps, exactly as before.

  // FILL — the control it targeted should still hold the value it entered.
  const want  = (step.requestedValue || '').trim();
  const label = (step.targetLabel || '').trim().toLowerCase();
  if (want && label && Array.isArray(pageState?.elements)) {
    const satisfied = pageState.elements.some((el) => {
      const elLabel = (el.text || el.placeholder || el.ariaLabel || '').trim().toLowerCase();
      return elLabel === label && valueSatisfies(el.value || '', want);
    });
    if (satisfied) return true;
  }

  // NAVIGATION — the step moved the page somewhere, and we are still there.
  //
  // A navigating step finishes on a document that no longer exists: the fresh
  // page's content script records it, capturing domHashAfter the moment it
  // boots. A real destination keeps rendering after that (deferred form
  // fields, async widgets), so by the next planning cycle the fingerprint has
  // already moved and the completed navigation stopped counting as done. The
  // control that caused it is typically global chrome still present on the new
  // page, so the planner re-grounded the unchanged goal, found it again, and
  // pointed back at the action it had just successfully completed.
  //
  // The transition itself is the durable evidence: this step took the page
  // from urlBefore to urlAfter, and that is still true for as long as we
  // remain at urlAfter. Nothing about any particular site is involved — only
  // the step's own recorded before/after location.
  const from = step.urlBefore;
  const to   = step.urlAfter;
  if (from && to && from !== to && currentSnap?.url === to) return true;

  return false;
}

function deriveSettledSteps(completedSteps, currentSnap, pageState = null) {
  if (!currentSnap) return [];
  return (completedSteps || []).slice(-3).filter((step) => {
    // A completed action's effect can outlive the exact page fingerprint it
    // finished under. Typing into a field opens an autocomplete list, a live
    // region ticks, an image swaps its label — any of that changes domHash
    // while the action itself remains just as done. Keying progress solely to
    // fingerprint equality therefore un-settled genuinely finished steps, and
    // the planner rediscovered them: the same fill was proposed again against
    // a field that already held the value, which is what "stuck on same step"
    // looked like from outside. Effect evidence is checked first because it is
    // the stronger statement — it asks whether the thing the step was for is
    // still true, not whether the page has been quiet since.
    if (stepEffectStillHolds(step, pageState, currentSnap)) return true;

    const urlBaseline = step.urlAfter ?? step.urlBefore;
    if (urlBaseline != null && currentSnap.url !== urlBaseline) return false;
    if (step.domHashAfter  != null) return currentSnap.domHash === step.domHashAfter;
    if (step.domHashBefore != null) return currentSnap.domHash === step.domHashBefore;
    return false;
  });
}
// See the "Goal consumed" comment at its call site in the verifier gate.
function isGoalConsumed(session, pageState, settledSteps, router) {
  if (!settledSteps?.length || !Array.isArray(pageState?.elements)) return false;
  const intent = [session?.goal, ...(session?.clarifications ?? []).map((c) => c.text)]
    .filter(Boolean).join(' ');
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
// A step whose completionCondition is "final" is the terminal step of the plan:
// the goal is achieved the moment it succeeds. Emitted by the planner (route.ts).
function isTerminalStep(step) {
  return step?.completionCondition === "final";
}

// ── Dynamic requirement-progress model (false-early-completion redesign) ────
//
// goalCompletionCriteria.successSignals is treated as the set of the goal's
// own distinct explicit requirements (see route.ts's prompt instructions).
// GoalVerifier.evaluate()/shouldComplete() are NOT modified — they already
// expose, on every call, which INDIVIDUAL signal passed THIS cycle
// (verdict.details: one {type,target,passed} entry per signal, in
// successSignals' own order — already computed today, just not consumed
// past matchedSignals/totalSignals). What was missing was memory:
// evaluate() is deliberately stateless, re-deriving `passed` fresh from the
// live page on every call, so a requirement whose evidence was only visible
// on an EARLIER page (a multi-page flow, not one atomic submit) would read
// false again once the page moved on, even though the real-world action
// genuinely happened.
//
// session.requirementProgress (session-store.js, additive) accumulates this
// across cycles, monotonically — once a signal is OBSERVED true on any
// cycle, it stays true for the rest of the task, mirroring the same
// "effect can outlive the exact snapshot" principle stepEffectStillHolds()/
// deriveSettledSteps() already use above for step-level tracking. None of
// this depends on action type, completionCondition, plan length, or which
// routing layer produced the current step — only on the criteria's own
// signals and the live page.

/**
 * Fold one cycle's per-signal evaluation into the session's cross-cycle
 * requirement history. Pure — never mutates either input, returns a new
 * array. Safe against length mismatches: the output is at least as long as
 * whichever input is longer, so a previously-recorded true is never
 * silently dropped.
 *
 * @param {Array<boolean>|null} previousProgress - session.requirementProgress,
 *   or null before any evaluation has happened.
 * @param {Array<{passed: boolean|null}>|undefined} details - this cycle's
 *   GoalVerifier verdict.details, or undefined when no criteria/signals
 *   were evaluated this cycle (criteria absent, or doesn't requiresEffect).
 * @returns {Array<boolean>}
 */
function updateRequirementProgress(previousProgress, details) {
  const list = Array.isArray(details) ? details : [];
  const prev = Array.isArray(previousProgress) ? previousProgress : [];
  const length = Math.max(list.length, prev.length);
  const next = [];
  for (let i = 0; i < length; i++) {
    // Monotonic: once true, always true — passed===false never reverts an
    // existing true. passed===null (could not be evaluated) never changes
    // anything either direction: uncertainty is neither progress nor loss.
    next.push(prev[i] === true || list[i]?.passed === true);
  }
  return next;
}

/**
 * Count of requirements not yet observed satisfied. Pure.
 *
 * @param {Array<boolean>|null} progress
 * @returns {number}
 */
function remainingRequirementCount(progress) {
  return Array.isArray(progress) ? progress.filter((p) => p !== true).length : 0;
}

/**
 * Whether the goal's requirement set is complete, using the ACCUMULATED
 * cross-cycle history rather than only this cycle's live-page snapshot —
 * this is what relaxes "every signal true SIMULTANEOUSLY on the same page"
 * into "every signal observed true at SOME point during this task." Mirrors
 * the SAME requiresEffect/match/confidenceThreshold semantics
 * GoalVerifier.shouldComplete() already enforces (every branch here
 * corresponds to one already in shouldComplete() — this does not invent new
 * completion semantics, it re-applies the existing ones against `progress`
 * instead of a single evaluate() call).
 *
 * Returns null when the requirement-history model does not apply at all (no
 * criteria, or a criteria that doesn't opt into requiresEffect) — callers
 * fall back to the existing, unmodified gate.complete for those cases,
 * preserving current behavior exactly.
 *
 * @param {object|null} criteria - session.goalCompletionCriteria
 * @param {Array<boolean>} progress - the just-updated requirementProgress
 * @returns {boolean|null}
 */
function isRequirementSetComplete(criteria, progress) {
  if (!criteria || criteria.requiresEffect !== true) return null;
  const totalSignals = Array.isArray(criteria.successSignals) ? criteria.successSignals.length : 0;
  if (totalSignals === 0) return false; // mirrors evaluate()'s own "0 signals -> unsatisfied"
  if (!Array.isArray(progress) || progress.length < totalSignals) return false;
  const matched = progress.slice(0, totalSignals).filter((p) => p === true).length;
  const satisfiedByMatch = criteria.match === 'any' ? matched >= 1 : matched === totalSignals;
  if (!satisfiedByMatch) return false;
  if (typeof criteria.confidenceThreshold === 'number' && (matched / totalSignals) < criteria.confidenceThreshold) {
    return false;
  }
  return true;
}

/**
 * Shared by all three GoalVerifier.shouldComplete() consultation sites below:
 * folds this cycle's evidence into the session's requirement history,
 * persists it (only when there was new evidence to fold — patchSession is
 * skipped entirely otherwise, so a cycle with no applicable criteria costs
 * nothing extra), and returns the accumulated completion decision, falling
 * back to gate.complete when the requirement-history model doesn't apply.
 * Not pure (performs the SessionStore write) — kept here only to avoid
 * repeating the fold+persist+decide sequence three times.
 *
 * @param {number} tabId
 * @param {object|null} criteria
 * @param {Array<boolean>|null} previousProgress
 * @param {object} gate - a GoalVerifier.shouldComplete() result
 * @returns {Promise<{ complete: boolean, progress: Array<boolean>, usedRequirementHistory: boolean }>}
 */
async function applyRequirementProgress(tabId, criteria, previousProgress, gate) {
  const updated = updateRequirementProgress(previousProgress, gate.verdict?.details);
  if (gate.verdict?.details) {
    await SessionStore.patchSession(tabId, { requirementProgress: updated });
  }
  const requirementSetComplete = isRequirementSetComplete(criteria, updated);
  return {
    complete: requirementSetComplete === null ? gate.complete : requirementSetComplete,
    progress: updated,
    usedRequirementHistory: requirementSetComplete !== null,
  };
}

/**
 * Veto gate for the OTHER, heuristic-driven completion triggers
 * (isGoalConsumed, the pre-L3 isGoalSatisfied check, and every
 * isTerminalStep()/completionCondition==="final" branch). Those heuristics
 * are legitimate signals that SOMETHING finished — they say nothing about
 * whether the task's OWN declared goalCompletionCriteria has actually been
 * met. This is deliberately NOT a new completion mechanism: it never
 * *grants* completion on its own (a criteria-less goal always passes
 * through unchanged), it only *vetoes* a heuristic's yes when a
 * requiresEffect contract exists and the accumulated requirementProgress
 * (see applyRequirementProgress above) says the goal's requirements are not
 * all historically satisfied yet. Reasons only from goalCompletionCriteria +
 * requirementProgress — no action type, form shape, step count, or site.
 *
 * @param {number} tabId
 * @param {object|null} session - the session whose criteria/progress to check
 * @returns {Promise<boolean>} true = the calling heuristic's completion claim may stand
 */
async function _requirementGateAllowsCompletion(tabId, session) {
  const criteria = session?.goalCompletionCriteria;
  if (!criteria || criteria.requiresEffect !== true) return true;
  const gate = GoalVerifier.shouldComplete(criteria);
  const { complete } = await applyRequirementProgress(tabId, criteria, session.requirementProgress, gate);
  return complete;
}
// Phase 7 — emit exactly one task_metrics event for this task, from whatever
// per-cycle records this content-script lifetime actually accumulated (see
// _cycleRecords above). PII-safe: deriveTaskMetrics() never reads goal text,
// URLs, or provider output — see its own doc comment.
function _emitTaskMetrics(session, { outcome, outcomeReason = null } = {}) {
  try {
    logEvent('task_metrics', deriveTaskMetrics(_cycleRecords, session, { outcome, outcomeReason }));
  } catch (err) {
    console.warn('[SP:V2] task_metrics emission failed (ignored):', err);
  }
}

// Present the completion card and clear the session. Reused by both terminal-step
// paths (local validation and navigation-resume). Loads the session BEFORE clearing
// so the card reports the true completed-step count.
async function _showGoalCompleteCard(tabId, goal) {
  const s = await SessionStore.load(tabId);
  showCompletionCard({
    goal,
    steps: s?.completedSteps.length ?? 0,
    startedAt: _taskStartedAt
  });
  _emitTaskMetrics(s, { outcome: 'complete' });
  await SessionStore.clear(tabId);
}
let _activePlanPromise = null;

async function _runPlanLoop(tabId, myGen) {
  if (_activePlanPromise) {
    console.log("[SP:V2:TRACE] _runPlanLoop call queued — awaiting active planning promise");
    try {
      await _activePlanPromise;
    } catch { /* ignore */ }
    const session = await SessionStore.load(tabId);
    if (session?.phase === 'PLANNING' && _generation === myGen) {
      console.log("[SP:V2:TRACE] Session still in PLANNING phase after active plan completed — re-executing plan loop");
      return _runPlanLoop(tabId, myGen);
    }
    return;
  }

  _activePlanPromise = _runPlanLoopInternal(tabId, myGen);
  try {
    await _activePlanPromise;
  } catch (err) {
    console.error("[SP:V2:TRACE] Unhandled plan loop error:", err);
    showStatus(`ScreenPilot: Planning error — ${err?.message || "Internal error"}`, "error");
    await SessionStore.clear(tabId);
  } finally {
    _activePlanPromise = null;
  }
}

async function _runPlanLoopInternal(tabId, myGen) {
  const storage = getStorageArea();
  const { executionMode = 'cloud' } = storage
    ? await storage.get(['executionMode'])
    : { executionMode: 'cloud' };
  // Every model call — the cloud planner AND the local Qwen / Moondream
  // adapters — passes through SanitizingAdapter (PII → placeholders/[REDACTED],
  // restored locally on the way back). All three share ONE in-memory token
  // vault per plan loop, so a placeholder means the same thing in every tier.
  const piiVault         = new TokenVault();
  const cloudAdapter     = new SanitizingAdapter(new VercelBackendAdapter(), { vault: piiVault });
  const localQwenAdapter = new SanitizingAdapter(new LocalQwenAdapter(), { vault: piiVault });
  const localVisionAdapter = new SanitizingAdapter(new LocalVisionAdapter(), { vault: piiVault });
  const decisionRouter = new DecisionRouter({ executionMode, localQwenAdapter, localVisionAdapter, cloudAdapter });
  // B5: consecutive retryable-failure counter, reset on every successful planner response.
  let planRetryCount = 0;
  // Set inside the local-mode branch each iteration; used after the try/catch below
  // to enrich the chosen step with ground-truth nav/region info (see Bug A fix).
  let localPageState = null;
  // Phase 7: bounds the fingerprint-skip optimization to at most ONE skip in a
  // row (see computeRelevantStateFingerprint's caller below) — reset to 0 the
  // instant any real decisionRouter.route() call happens. In-memory and local
  // to this one plan-loop invocation; never persisted, never a task-level
  // retry/stop limit — it cannot fail, stop, or bound the task itself.
  let consecutiveSkipCount = 0;
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
    // Phase 4 observability only — a pure read of state that already exists;
    // does not affect control flow or persist anything new by itself.
    logEvent('task_progress_snapshot', deriveTaskProgress(session, { taskState: _state }));
    if (_generation !== myGen) return;
    console.log(`[SP:V2:TRACE] state transition phase=${session.phase} goal="${redactText(session.goal)}"`);

    // This cycle's task-progress projection (see deriveSettledSteps). Computed
    // from the same snapshot the entry diagnostic logs, so the cycle costs no
    // extra DOM work for it.
    let settledSteps = [];
    let entrySnap = null;
    try {
      const lastStep = session.completedSteps[session.completedSteps.length - 1];
      const currentSnap = capturePageSnapshot('');
      entrySnap = currentSnap;
      settledSteps = deriveSettledSteps(session.completedSteps, currentSnap);
      console.log(`[SP:V2:DIAG] Plan loop entry — completedSteps=${session.completedSteps.length} stepAttemptCount=${session.stepAttemptCount} phase=${session.phase}`, {
        pendingStep:       session.pendingStep ? { intent: session.pendingStep.intent, domHashBefore: session.pendingStep.domHashBefore } : null,
        lastCompletedStep: lastStep ? { intent: lastStep.intent, domHashBefore: lastStep.domHashBefore, urlBefore: lastStep.urlBefore } : null,
        currentUrl:        currentSnap.url,
        currentDomHash:    currentSnap.domHash,
      });
    } catch { /* non-browser environment — skip diagnostic snapshot */ }
    
    // Verifier-driven early completion check (requiresEffect OR generic goal satisfaction).
    //
    // This cycle's ONE page-state extraction and ONE generic goal check happen
    // here and are reused by the planner below (cycleExtractMs/cyclePageState/
    // cycleGenericCheck) — extracting again a few milliseconds later re-walked
    // the whole DOM and re-ran the identical live-document scan for the same
    // answer. Deliberately scoped to this single cycle only: both are rebuilt
    // from scratch on every iteration, so there is no cross-cycle caching and
    // the stale-plan check below still compares real before/after snapshots.
    let cyclePageState    = null;
    let cycleExtractMs    = 0;
    let cycleGenericCheck = null;
    {
      console.log("[SP:V2:TRACE] verify START");
      const tGoalStart = Date.now();
      const tExtractStart = Date.now();
      const pageState  = PageStateService.extractPageState();
      cycleExtractMs   = Date.now() - tExtractStart;
      cyclePageState   = pageState;
      // Re-derived now that this cycle's page state exists, so a completed
      // step can be settled on its own surviving effect (see
      // stepEffectStillHolds) and not only on page-wide fingerprint equality.
      // Same snapshot, same cycle — no extra DOM work.
      settledSteps     = deriveSettledSteps(session.completedSteps, entrySnap, pageState);
      console.log(`[SP:V2:PERF] stage=task_progress settledActions=${settledSteps.length} of ${session.completedSteps.length} completed`);
      const gate       = GoalVerifier.shouldComplete(session.goalCompletionCriteria, {}, session.goal, pageState);
      cycleGenericCheck = gate.genericCheck ?? null;
      const goalVerifyMs = Date.now() - tGoalStart;
      console.log(`[SP:V2:TRACE] verify END complete=${gate.complete} reason=${gate.reason}`);
      console.log(`[SP:V2:PERF] stage=verifier_gate extractMs=${cycleExtractMs} goalVerifyMs=${goalVerifyMs} elements=${pageState.elements.length}`);

      // Dynamic requirement-progress model — see its own comment block above
      // for the full explanation. GoalVerifier itself is untouched; this
      // folds today's per-signal evidence into cross-cycle history before
      // deciding completion.
      const {
        complete: verifierGateComplete,
        usedRequirementHistory: verifierGateUsedHistory
      } = await applyRequirementProgress(tabId, session.goalCompletionCriteria, session.requirementProgress, gate);

      if (verifierGateComplete) {
        console.log("[SP:GoalCompletion]", {
          source: "verifier",
          satisfied: true,
          reason: verifierGateUsedHistory ? 'requirements_satisfied' : gate.reason
        });
        console.log(`[SP:V2:PERF] goalVerifyMs=${goalVerifyMs} totalPlanningMs=${goalVerifyMs} qwen=SKIPPED reason=goal_already_satisfied`);
        applyEvent(TaskEvent.PLAN_COMPLETE, { source: "verifier" });
        await _showGoalCompleteCard(tabId, session.goal);
        return;
      }

      // Goal consumed: the task has made verified progress, and once the
      // targets of those completed actions are withheld, nothing left on the
      // page expresses the goal at all — no candidate for L2 to rank and no
      // structural continuation. Every control that matched the goal has
      // already been successfully acted on and its effect still holds.
      //
      // isGoalSatisfied cannot see this on its own: it needs the goal's words
      // to reappear in the URL/page after the action, and a successful submit
      // rarely echoes all of them (measured: "#submitted" satisfies "submit"
      // but never "profile"). Without this, the loop replanned a finished task,
      // found zero text candidates, and escalated to visual perception and then
      // the cloud to rediscover an action it had already completed.
      //
      // Mirrors the router's own deterministic tiers exactly — the same
      // withholding (_isSettledTarget), the same L2 ranking, the same
      // continuation check, over the same intent (goal + clarifications) — so
      // this fires precisely when routing would have had nothing deterministic
      // left to offer. Requires at least one settled step, so a first cycle
      // (e.g. a purely visual question with no page target) is unaffected and
      // still reaches visual perception.
      {
        if (isGoalConsumed(session, pageState, settledSteps, decisionRouter) &&
            await _requirementGateAllowsCompletion(tabId, session)) {
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
      _emitTaskMetrics(session, { outcome: 'failed', outcomeReason: 'PLANNER_BUDGET_EXCEEDED' });
      await SessionStore.clear(tabId);
      return;
    }

    // ── Phase 7: relevant-state fingerprint optimization ──────────────────────
    // Strictly AFTER every correctness-critical check above (goal-verifier
    // completion, goal-consumed, planner-budget exhaustion — all of which can
    // already end the task and are completely unaffected by anything below).
    // Reuses THIS cycle's own PageStateService extraction (cyclePageState,
    // already computed above) — no second DOM walk. Decides only whether to
    // skip decisionRouter.route() this cycle.
    const currentFingerprint = computeRelevantStateFingerprint(cyclePageState);
    const canSkipRouting =
      session.lastCycleOutcome === 'step_completed' &&
      !!session.lastFingerprint &&
      session.lastFingerprint.url === currentFingerprint.url &&
      session.lastFingerprint.hash === currentFingerprint.hash &&
      consecutiveSkipCount < 1;

    // Records this cycle's outcome + fingerprint on the session (read fresh at
    // the top of every iteration, so this works uniformly across a plain
    // loop-restart, the _runPlanLoop recursive re-invocation, and a
    // bootstrap/resume) and pushes this cycle's metrics record. Called at
    // every real outcome site below — never on a skip, which deliberately
    // leaves session.lastFingerprint/lastCycleOutcome untouched (see the
    // audited design: nothing new was actually verified on a skip).
    async function recordCycleOutcome(outcome, extra = {}) {
      _cycleRecords.push({
        skipped: false,
        domMs: cycleExtractMs,
        layer: null,
        layer1Ms: 0, layer2Ms: 0, qwenMs: 0, visionMs: 0, cloudMs: 0,
        verifyMs: null,
        verdict: null,
        outcome,
        ...extra,
      });
      await SessionStore.patchSession(tabId, { lastCycleOutcome: outcome, lastFingerprint: currentFingerprint });
    }

    if (canSkipRouting) {
      _cycleRecords.push({
        skipped: true,
        domMs: cycleExtractMs,
        layer: null,
        layer1Ms: 0, layer2Ms: 0, qwenMs: 0, visionMs: 0, cloudMs: 0,
        verifyMs: null,
        verdict: null,
        outcome: 'skipped',
      });
      consecutiveSkipCount += 1;
      console.log(`[SP:V2:PERF] stage=fingerprint_gate action=skip consecutiveSkipCount=${consecutiveSkipCount} url=${currentFingerprint.url} elementCount=${currentFingerprint.count}`);
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    consecutiveSkipCount = 0; // a real route() call is about to happen this cycle

    const tCycleStart = Date.now();
    showStatus("ScreenPilot · Planning…", "planning");

    const freshSession = session;
    if (!freshSession) {
      hideStatus();
      return;
    }
    if (_generation !== myGen) return;
    const nClarifications = freshSession.clarifications?.length ?? 0;
    const tPageControlsStart = Date.now();
    const pageControls    = collectPageControls();
    const pageControlsMs  = Date.now() - tPageControlsStart;
    const reqId           = `req_v2_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const planController  = new AbortController();

    console.log(`[SP:V2:TRACE] plan START reqId=${reqId}`);
    console.log(`[SP:V2:DEBUG] controller_created reqId=${reqId} signalAborted=${planController.signal.aborted}`);
    console.log(`[SP:V2:DEBUG] controller_id reqId=${reqId}`);
    console.log(`[SP:V2:DEBUG] signal_before_request reqId=${reqId} aborted=${planController.signal.aborted}`);

    let preSnap = { url: window.location.href, domHash: '' };
    try {
      preSnap = capturePageSnapshot("");
    } catch { /* mock/headless fallback */ }

    // Dynamic stale-plan protection listener: abort controller if user navigates or page changes
    const onNavCheck = () => {
      if (window.location.href !== preSnap.url && !planController.signal.aborted) {
        console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=page_url_changed_during_planning`);
        planController.abort('page_url_changed_during_planning');
      }
    };
    window.addEventListener('popstate', onNavCheck, { once: true });

    const tReqStart = Date.now();
    console.log(`[SP:V2] [${ts()}] executionMode=${executionMode} step=${freshSession.completedSteps.length + 1} url=${window.location.href} clarifications=${nClarifications} pageControls=${pageControls.length} reqId=${reqId}`);
    let screenshotMs = 0;

    let planResp;
    // Phase 7: mirrors of this cycle's routing metrics, hoisted OUTSIDE the
    // try block below (whose own `const routed`/`layer1Ms`/etc. are block-
    // scoped and unavailable once it closes) so the outcome sites after it —
    // STALE_PLAN, ambiguous, blocked, the rejected-completion-claim retry —
    // can attach real per-cycle numbers to their metrics record instead of
    // only the always-known domMs. Read-only mirrors; nothing inside the try
    // block's own logic changes.
    let cycleRoutedLayer = null;
    let cycleLayer1Ms = 0, cycleLayer2Ms = 0, cycleQwenMs = 0, cycleCloudMs = 0, cycleVisionMs = 0;
    try {
      // This cycle's single extraction, taken moments ago by the verifier gate
      // above (see its comment). Falls back to extracting here if the gate
      // somehow produced none, so this path never depends on the gate running.
      const tDomStart = Date.now();
      const pageState = cyclePageState ?? PageStateService.extractPageState();
      localPageState  = pageState;
      const domMs     = cyclePageState ? cycleExtractMs : Date.now() - tDomStart;
      // Observability only (Phase 3) — measures the compaction opportunity;
      // does not alter pageState or anything derived from it below.
      logEvent('compact_state_built', { reqId, ...estimateCompactionSavings(pageState) });

      // Pre-L3 goal satisfaction check — applies regardless of executionMode,
      // so cloud users also skip a paid LLM call when the goal is already met.
      // Reuses the gate's own result when it computed one this cycle: same
      // goal, same page state, same live document, microseconds apart.
      const preL3Check = cycleGenericCheck ?? GoalVerifier.isGoalSatisfied(freshSession.goal, pageState);
      if (preL3Check.satisfied && await _requirementGateAllowsCompletion(tabId, freshSession)) {
        window.removeEventListener('popstate', onNavCheck);
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

      const routed = await decisionRouter.route(freshSession.goal, pageState, {
        signal: planController.signal,
        cloudContext,
        completedSteps: freshSession.completedSteps,
        settledSteps
      });

      planResp     = routed.planResponse;
      const layer1Ms    = routed.layer1Ms ?? 0;
      const layer2Ms    = routed.layer2Ms ?? 0;
      const qwenMs      = routed.qwenMs ?? 0;
      const cloudMs     = routed.cloudMs ?? 0;
      const totalPlanningMs = Date.now() - tReqStart;
      // Phase 7: mirror into the outer, non-block-scoped variables (see their
      // declaration above) — read-only copies, no change to anything below
      // that already used the block-scoped originals.
      cycleRoutedLayer = routed.layer;
      cycleLayer1Ms    = layer1Ms;
      cycleLayer2Ms    = layer2Ms;
      cycleQwenMs      = qwenMs;
      cycleCloudMs     = cloudMs;
      cycleVisionMs    = routed.visionMs ?? 0;

      console.log(`[SP:V2:TRACE] layer result layer=${routed.layer} confidence=${planResp.confidence} qwenFailureReason=${routed.qwenFailureReason ?? 'n/a'}`);
      console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=${layer1Ms} layer2Ms=${layer2Ms} qwenMs=${qwenMs} cloudMs=${cloudMs} screenshotMs=${screenshotMs} postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${totalPlanningMs} l3Layer=${routed.layer}`);
      console.log(`[SP:V2:PERF] stage=routing routeMs=${layer1Ms + layer2Ms + qwenMs + cloudMs} pageControlsMs=${pageControlsMs} domReused=${cyclePageState ? 'yes' : 'no'} goalCheckReused=${cycleGenericCheck ? 'yes' : 'no'}`);
      logEvent('routing_result', {
        reqId,
        layer: routed.layer,
        layer1Ms, layer2Ms, qwenMs, cloudMs,
        visionMs: routed.visionMs ?? 0,
        totalPlanningMs,
        confidence: planResp.confidence,
        qwenFailureReason: routed.qwenFailureReason ? redactText(routed.qwenFailureReason) : null,
        visionFailureReason: routed.visionFailureReason ? redactText(routed.visionFailureReason) : null
      });
      if (routed.qwenFailureReason || routed.visionFailureReason) {
        logWarn('provider_fallback', {
          reqId,
          resolvedBy: routed.layer,
          qwenFailureReason: routed.qwenFailureReason ? redactText(routed.qwenFailureReason) : null,
          visionFailureReason: routed.visionFailureReason ? redactText(routed.visionFailureReason) : null
        });
      }
    } catch (err) {
      window.removeEventListener('popstate', onNavCheck);
      console.log(`[SP:V2:TRACE] plan ERROR reqId=${reqId} name=${err?.name} message=${err?.message}`);
      console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${planController.signal.aborted} reason=${planController.signal.reason}`);
      if (planController.signal.aborted || err?.name === 'AbortError') {
        console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_aborted_exception`);
        console.log("[SP:V2] Request aborted — replanning");
        // Gap #2 (Phase 7 audit): the page changed enough mid-request to abort
        // it — tagged 'stale_plan' (not left unwritten) so the very next cycle
        // can never become skip-eligible on stale pre-abort provenance.
        await recordCycleOutcome('stale_plan');
        continue;
      }
      console.error("[SP:V2] Planning failed:", err);
      logError('plan_failed', { reqId, name: err?.name ?? null, message: redactText(err?.message ?? '') });
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
      showStatus(`ScreenPilot: Planning error — ${err.message}`, "error");
      _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: 'NETWORK_ERROR' });
      await SessionStore.clear(tabId);
      return;
    }
    console.log(`[SP:V2:TRACE] plan END reqId=${reqId}`);
    window.removeEventListener('popstate', onNavCheck);
    const reqMs = Date.now() - tReqStart;
    if (_generation !== myGen) return;

    if (planResp?.errorCode === 'ABORTED') {
      console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_stale_discard`);
      console.log("[SP:V2] Request aborted — replanning");
      // Gap #2 (Phase 7 audit): server-acknowledged abort — same reasoning as
      // the exception-path abort above.
      await recordCycleOutcome('stale_plan');
      continue;
    }

    const postSnap = capturePageSnapshot("");
    const urlChanged = preSnap.url !== postSnap.url;
    const domChanged = preSnap.domHash !== postSnap.domHash;
    if (urlChanged || domChanged) {
      // Before discarding outright: if the proposed step matches a step we've
      // already completed, AND the current page corresponds to that step's own
      // post-completion state, the snapshot drift isn't a fresh navigation/
      // action invalidating this plan — it's the SAME already-handled repeat
      // the dedup guard below exists to catch. Let it fall through instead of
      // silently discarding it here, so the guard's fast, cheap step-attempt
      // limit gets a chance to fire instead of burning through the whole
      // (larger, more expensive) planner-call budget on a repeat that was
      // never going to be acted on anyway — the STALE_PLAN check runs before
      // the dedup guard and previously had no way to tell the two apart.
      const dedupPreview = matchesCompletedStep(
        freshSession.completedSteps, freshSession.pendingStep, planResp.plan?.steps?.[0], postSnap
      );
      const isRepeatOfCompletedStep = !!dedupPreview && dedupPreview.urlSame && dedupPreview.domHashSame;
      if (!isRepeatOfCompletedStep) {
        console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_stale_snapshot_change`);
        console.log(`[SP:V2] STALE_PLAN discarded urlChanged=${urlChanged} domChanged=${domChanged} preUrl=${preSnap.url} postUrl=${postSnap.url} preDomHash=${preSnap.domHash} postDomHash=${postSnap.domHash} reqMs=${reqMs}ms`);
        await recordCycleOutcome('stale_plan', {
          layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
        });
        continue;
      }
      console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=stale_snapshot_matches_completed_step_deferred_to_dedup_guard`);
    }

    const cycleMs = Date.now() - tCycleStart;
    const modelUsed = planResp.providerMetadata?.model ?? "unknown";
    const inTokens  = planResp.providerMetadata?.inputTokens ?? "?";
    const outTokens = planResp.providerMetadata?.outputTokens ?? "?";
    console.log(`[SP:V2:PERF] cycleMs=${cycleMs}ms screenshotMs=${screenshotMs}ms reqMs=${reqMs}ms model=${modelUsed} inTokens=${inTokens} outTokens=${outTokens}`);
    console.log(`[SP:V2] [${ts()}] result=${planResp.result} state=${planResp.state} steps=${planResp.plan?.steps?.length ?? 0}  plannerSummary="${planResp.plannerSummary ?? ""}"`);
    // Diagnostic: log full planner response step details
    if (planResp.plan?.steps?.length) {
      const s0 = planResp.plan.steps[0];
      console.log(`[SP:V2:DIAG] Planner step[0]:`, {
        intent:         s0.intent,
        description:    s0.description,
        targetText:     s0.targetElement?.text,
        completionCondition: s0.completionCondition,
        urlChanges:     s0.expectedPageState?.urlChanges,
        urlPattern:     s0.expectedPageState?.urlPattern,
      });
    }
    const outcome = resolveOutcome(planResp);
    if (outcome === "goal_reached") {
      // Phase 27 — do NOT trust the planner's self-reported completion unconditionally
      // when an action-goal contract exists — verify it against the live page first.
      // Navigation-only goals (no criteria, or requiresEffect !== true) are UNCHANGED:
      // they still complete immediately on state="complete", exactly as before.
      const criteria = freshSession.goalCompletionCriteria;
      if (criteria?.requiresEffect === true) {
        const gate = GoalVerifier.shouldComplete(criteria);
        // Dynamic requirement-progress model (found during implementation —
        // this is a THIRD GoalVerifier.shouldComplete() consultation site,
        // distinct from the two named in the approved design; see the report
        // for why it must use the same mechanism: without it, a planner
        // claim that is genuinely correct — every requirement historically
        // satisfied, just not all simultaneously visible on THIS cycle's
        // page — would be wrongly rejected here and looped on forever
        // (bounded only by the existing planner-attempt budget).
        const {
          complete: gateComplete27,
          usedRequirementHistory: usedHistory27
        } = await applyRequirementProgress(tabId, criteria, freshSession.requirementProgress, gate);
        // Diagnostic only — logs the gate's inputs/outputs before the accept/reject
        // decision below is made. No control flow depends on this log.
        console.log("[SP:GoalCompletionGate]", {
          requiresEffect:  criteria.requiresEffect,
          verifierComplete: gateComplete27,
          verifierReason:   usedHistory27 ? (gateComplete27 ? 'requirements_satisfied' : 'requirements_remaining') : gate.reason
        });
        if (!gateComplete27) {
          console.log("[SP:GoalCompletion]", {
            source: "planner", state: "complete", accepted: false,
            reason: usedHistory27 ? 'requirements_remaining' : gate.reason
          });
          // Reject the claim and loop back for another planning pass. The existing
          // planner-attempt budget check (top of this same loop, above) already
          // bounds total retries for the whole task — no new counter is introduced.
          // Phase 7: the planner's own completion claim was rejected — this
          // cycle verified nothing trustworthy, so tag it 'stale_plan' rather
          // than leaving lastCycleOutcome unwritten (found during
          // implementation; same class of risk as the audited Gap #2 sites).
          await recordCycleOutcome('stale_plan', {
            layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
          });
          continue;
        }
      }
      // Phase 26: legacy completion path — unchanged behavior, now logged for parity
      // with the verifier path so completion source is always attributable.
      console.log("[SP:GoalCompletion]", { source: "planner", state: "complete" });
      applyEvent(TaskEvent.PLAN_COMPLETE);
      showCompletionCard({
        goal: freshSession.goal,
        steps: freshSession.completedSteps.length,
        startedAt: _taskStartedAt
      });
      _emitTaskMetrics(freshSession, { outcome: 'complete' });
      await SessionStore.clear(tabId);
      return;
    }
    if (outcome === "blocked") {
      const blocker = planResp.blockers?.[0] ?? "A precondition is not met";
      await SessionStore.setBlocker(tabId, blocker);
      await SessionStore.patchSession(tabId, { pauseReason: "blocked" });
      await SessionStore.setPhase(tabId, "PAUSED");
      applyEvent(TaskEvent.WORKFLOW_PAUSED);
      // Phase 7: a blocked outcome means the router still needs another
      // reasoning cycle — writing this now (rather than leaving
      // lastCycleOutcome at whatever it was before) prevents an immediate
      // false-skip on the very first cycle after the user resumes from PAUSED.
      await recordCycleOutcome('blocked', {
        layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
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
      showStatus(reason ? `ScreenPilot: Cannot determine next step — ${reason}` : "ScreenPilot: Cannot determine next step — goal is too ambiguous", "error");
      _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: 'AMBIGUOUS_LIMIT' });
      await SessionStore.clear(tabId);
      return;
    }
      await SessionStore.patchSession(tabId, {
        pauseReason: "ambiguous",
        ambiguitySummary: planResp.plannerSummary ?? "Multiple valid paths exist for this goal"
      });
      await SessionStore.setPhase(tabId, "PAUSED");
      applyEvent(TaskEvent.AMBIGUOUS_RECEIVED);
      // Phase 7: same reasoning as the 'blocked' write above.
      await recordCycleOutcome('ambiguous', {
        layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
      });
      await SessionStore.refreshExpiry(tabId);
      const paused = await SessionStore.load(tabId);
      if (paused) showAmbiguousBanner(paused);
      return;
    }
    if (outcome === "failed") {
      const errorCode = planResp.errorCode ?? "planner_failed";
      const retryable = RETRYABLE_PLAN_ERRORS.has(errorCode);
      // B5: retry transient backend failures with exponential backoff (1s, 2s) WITHOUT
      // clearing the session. Backoff = 1000 * 2^(retry-1): retry 1 → 1s, retry 2 → 2s.
      if (retryable && planRetryCount < MAX_PLAN_RETRIES) {
        planRetryCount++;
        const backoffMs = 1000 * Math.pow(2, planRetryCount - 1);
        console.warn(`[SP:V2] [${ts()}] Retryable plan failure (${errorCode}) — retry ${planRetryCount}/${MAX_PLAN_RETRIES} in ${backoffMs}ms (session preserved)`);
        showStatus("ScreenPilot · Reconnecting…", "planning");
        await recordCycleOutcome('retryable_error', {
          layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      applyEvent(TaskEvent.PLAN_FAILED, { reason: errorCode });
      if (retryable) {
        // B5: retries exhausted — surface the error but PRESERVE the session so the
        // user can resume once connectivity returns. Do NOT clear.
        showStatus(`ScreenPilot: ${planResp.error ?? "Connection problem — please try again"}`, "error");
        _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: errorCode === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : errorCode === 'REQUEST_TIMEOUT' ? 'REQUEST_TIMEOUT' : 'HTTP_ERROR' });
      } else {
        showStatus(`ScreenPilot: ${planResp.error ?? "Planning failed"}`, "error");
        _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: null });
        await SessionStore.clear(tabId);
      }
      return;
    }
    // B5: a usable planner response arrived — reset the retry counter for the next step.
    planRetryCount = 0;
    const plannerStep = planResp.plan.steps[0];
    if (!plannerStep) {
      console.warn("[SP:V2] state=planned but steps is empty — treating as ambiguous");
      // Phase 7: found during implementation (not one of the originally
      // audited sites) — another silent continue that left lastCycleOutcome
      // unwritten. Tagged 'stale_plan': nothing trustworthy resolved this
      // cycle, so the next cycle must not become skip-eligible on stale
      // pre-existing provenance, same reasoning as the audited Gap #2 sites.
      await recordCycleOutcome('stale_plan', {
        layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
      });
      continue;
    }
    // Correct expectedPageState.urlChanges/region from ground truth before anything
    // downstream (buildPendingStepContext, toExecutorStep, expectsNavigation) reads
    // it — see Bug A/D fix. No-op when localPageState is unset (cloud mode) or the
    // resolved element isn't a plain <a href>.
    enrichStepFromPageState(plannerStep, localPageState);
    applyEvent(TaskEvent.PLAN_RECEIVED, { intent: plannerStep.intent });

    // ── Deduplication guard ───────────────────────────────────────────────────
    // If the planner returned the same intent as the most recently completed step,
    // AND the current page state is identical to that step's OWN post-completion
    // state, the action did not advance the workflow any further — do NOT re-execute it.
    //
    // This catches the case where the planner ignores completedSteps and returns
    // the same step again (e.g. "open_create_menu" after the menu already opened).
    //
    // A re-execution IS allowed when:
    //   (a) the intent differs from the last completed step, OR
    //   (b) the URL has changed since that step ran, OR
    //   (c) the domHash has changed since that step FINISHED (something new happened)
    //
    // Critical: the fallback for domHash comparison must NOT be urlSame. GitHub's "+"
    // menu opens without a URL change, so urlSame=true even when the state DID change.
    //
    // Compare against domHashAfter (captured once the step was confirmed complete),
    // NOT domHashBefore (the pre-click baseline) — a STICKY effect like an opened menu
    // makes "current domHash != domHashBefore" true forever once the very first click
    // succeeds, which used to make this guard permanently think every later cycle was
    // "new" and wave through an endless re-click of the same already-open menu. Once
    // the step's own post-completion state (domHashAfter) is what we're comparing
    // against, a later cycle that's still sitting in that same state is correctly
    // recognized as a no-op repeat, while a cycle where something genuinely further
    // changed is correctly let through. domHashBefore (and pendingStep.domHashBefore)
    // remain as fallbacks only for older session records that predate domHashAfter.
    {
      const currentSnap = capturePageSnapshot('');
      const targetText  = (plannerStep.targetElement?.text || '').trim().toLowerCase();
      const dedup = matchesCompletedStep(freshSession.completedSteps, freshSession.pendingStep, plannerStep, currentSnap);

      if (dedup) {
        const { matchingCompleted, urlSame, domHashSame } = dedup;

        console.log(`[SP:V2] Dedup check: intent="${plannerStep.intent}" target="${targetText}" urlSame=${urlSame} domHashSame=${domHashSame} currentDomHash=${currentSnap.domHash} baselineDomHash=${matchingCompleted.domHashAfter ?? matchingCompleted.domHashBefore ?? freshSession.pendingStep?.domHashBefore ?? 'none'}`);

        if (urlSame && domHashSame) {
          console.warn(
            `[SP:V2] Dedup guard FIRED: planner returned step matching recent action ("${plannerStep.intent}" / "${targetText}")` +
            ` with identical page state — page did not change after that action`
          );
          const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
          if (isStuck) {
            applyEvent(TaskEvent.PLAN_FAILED, { reason });
            showStatus(`ScreenPilot: ${reason}`, "error");
            _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: 'STEP_ATTEMPTS_EXCEEDED' });
            await SessionStore.clear(tabId);
            return;
          }
          await recordCycleOutcome('dedup_repeat', {
            layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
          });
          await new Promise((r) => setTimeout(r, 200));
          continue;
        } else {
          console.log(`[SP:V2] Dedup check PASSED: page state changed (urlSame=${urlSame} domHashSame=${domHashSame}) — allowing execution`);
        }
      }
    }
    // Phase 23A — Goal Completion foundation (SCHEMA ONLY). Persist the plan-level
    // completion contract once so it survives navigation / reload / bootstrap resume,
    // and emit a single diagnostic log. This does NOT drive any runtime or completion
    // decision — GoalVerifier / shadow mode arrive in later phases.
    const goalCompletionCriteria = planResp.goalCompletionCriteria ?? planResp.plan.goalCompletionCriteria;
    if (goalCompletionCriteria && !freshSession.goalCompletionCriteria) {
      await SessionStore.patchSession(tabId, { goalCompletionCriteria });
      // Phase 23B shadow mode: log the FULL contract. Still NOT evaluated anywhere.
      console.log("[SP:GoalCompletionCriteria]", {
        goalType:             goalCompletionCriteria.goalType,
        match:                goalCompletionCriteria.match,
        verificationStrategy: goalCompletionCriteria.verificationStrategy,
        requiresEffect:       goalCompletionCriteria.requiresEffect,
        successSignals:       goalCompletionCriteria.successSignals
      });
    }
    // Phase 23C shadow trigger: PLAN_RECEIVED (legacy is never "complete" here).
    await _shadowGoalVerify(tabId, "PLAN_RECEIVED", false);
    // B2: hide the planning banner once a step is ready — it must not remain visible
    // during EXECUTING/AWAITING_USER. The instruction/highlight UI takes over on element:ready.
    hideStatus();
    await SessionStore.setPhase(tabId, "EXECUTING");
    // Gap #1 (Phase 7 audit): _executeStep() resolves to the SAME string
    // "completed" for both a genuine successful step (completeStep() ran) and
    // a fill-verification failure (completeStep() deliberately did NOT run).
    // Capturing the count here, before the call, lets the fallthrough below
    // tell the two apart by comparing against a fresh read afterwards —
    // without changing _executeStep()'s own return contract at all.
    const completedStepsCountBeforeExecute = freshSession.completedSteps.length;
    const result = await _executeStep(tabId, plannerStep, freshSession.goal, myGen);
    // Phase 4: record the last executor outcome so it survives navigation/
    // reload (a page-scoped `result` local otherwise vanishes). No-ops
    // harmlessly if the session was already cleared inside _executeStep
    // (the "goal_complete" path) — patchSession() already tolerates that.
    await SessionStore.patchSession(tabId, { lastActionResult: result, lastActionAt: Date.now() });
    if (result === "navigated" || result === "aborted") {
      // Phase 7: neither path has completeStep() run in THIS content-script
      // lifetime (a navigated step's completeStep() runs later, in the fresh
      // page's own _bootstrapSession; an aborted step ran no action at all) —
      // tag 'stale_plan' so a resumed/superseded session can never inherit a
      // stale 'step_completed' from before this cycle and become
      // false-skip-eligible. Cheap defense-in-depth: for "navigated" the URL
      // change alone would already block a skip via the fingerprint's own url
      // comparison, but this also covers "aborted", where the URL may not
      // have changed at all.
      await recordCycleOutcome('stale_plan', {
        layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
      });
      if (result === "navigated") {
        // Phase 26B — soft-navigation resume bridge. The progression contract used
        // to be "a navigated step destroys the document; the fresh content script
        // calls _bootstrapSession". Turbo/pjax sites (GitHub) swap the body without
        // an unload, so bootstrap never re-ran and the session froze on the stale
        // step (Phase 26A audit). If this document is still alive shortly after a
        // navigated step, resume via the exact same bootstrap path a fresh content
        // script would take: classification → completeStep → replan. On a real
        // unload this timer dies with the document and never fires, so hard-reload
        // behavior is unchanged. Generation safety is _bootstrapSession's own:
        // it increments _generation and self-guards, same as its init invocation.
        setTimeout(() => { _bootstrapSession(tabId); }, 200);
      }
      return;
    }
    if (result === "goal_complete") {
      // Terminal step already fired FINAL_STEP_COMPLETE, showed the completion card,
      // and cleared the session inside _executeStep. Stop — do NOT replan.
      return;
    }
    if (result === "element_not_found") {
      const { isStuck, reason } = await SessionStore.incrementStepAttempt(tabId);
      if (isStuck) {
        applyEvent(TaskEvent.PLAN_FAILED, { reason });
        showStatus(`ScreenPilot: ${reason}`, "error");
        _emitTaskMetrics(freshSession, { outcome: 'failed', outcomeReason: 'STEP_ATTEMPTS_EXCEEDED' });
        await SessionStore.clear(tabId);
        return;
      }
      await SessionStore.setPhase(tabId, "PLANNING");
      applyEvent(TaskEvent.REPLAN_TRIGGERED, { reason: "element_not_found" });
      await SessionStore.incrementReplanCount(tabId);
      await recordCycleOutcome('element_not_found', {
        layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
      });
      await _shadowGoalVerify(tabId, "REPLAN", false); // Phase 23C shadow trigger
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await SessionStore.setPhase(tabId, "PLANNING");
    applyEvent(TaskEvent.REPLAN_TRIGGERED, { intent: plannerStep.intent });
    await SessionStore.incrementReplanCount(tabId);
    // Gap #1 (Phase 7 audit): `result === "completed"` here is REACHED BOTH
    // by a genuine successful step (SessionStore.completeStep() ran inside
    // _executeStep's user:acted handler) AND by a fill-verification failure
    // (completeStep() deliberately did NOT run, but _executeStep still
    // resolves "completed" — see its own comment). Disambiguate with a fresh
    // read rather than trusting the shared result string: if completedSteps
    // genuinely grew, this was a real success; if not, it was the
    // fill-verification-failure path, and MUST NOT be tagged 'step_completed'
    // (doing so would make the very next cycle wrongly skip-eligible after a
    // failure — exactly the invariant the fingerprint gate must never violate).
    const postExecuteSession = await SessionStore.load(tabId);
    const stepGenuinelyCompleted = (postExecuteSession?.completedSteps?.length ?? completedStepsCountBeforeExecute) > completedStepsCountBeforeExecute;
    await recordCycleOutcome(stepGenuinelyCompleted ? 'step_completed' : 'fill_verification_failed', {
      layer: cycleRoutedLayer, layer1Ms: cycleLayer1Ms, layer2Ms: cycleLayer2Ms, qwenMs: cycleQwenMs, cloudMs: cycleCloudMs, visionMs: cycleVisionMs
    });
    await _shadowGoalVerify(tabId, "REPLAN", false); // Phase 23C shadow trigger
  }
}
// Phase 23C — SHADOW MODE goal verification. Read-only: evaluates the persisted
// goalCompletionCriteria against the live page and logs the verdict plus a
// legacy-vs-verifier agreement line. It NEVER triggers completion, changes state,
// or influences control flow — any error is swallowed so it cannot affect runtime.
async function _shadowGoalVerify(tabId, trigger, legacyComplete) {
  try {
    const session  = await SessionStore.load(tabId);
    const criteria = session?.goalCompletionCriteria;
    if (!criteria) return; // no contract to shadow (e.g. a pure navigation goal)
    const verdict = GoalVerifier.evaluate(criteria);
    console.log(`[SP:GoalVerifier] trigger=${trigger}`, {
      satisfied:      verdict.satisfied,
      matchedSignals: verdict.matchedSignals,
      totalSignals:   verdict.totalSignals,
      details:        verdict.details
    });
    console.log("[SP:GoalAgreement]", {
      trigger,
      legacyComplete:   !!legacyComplete,
      verifierComplete: verdict.satisfied
    });
  } catch (err) {
    console.warn("[SP:GoalVerifier] shadow evaluation error (ignored):", err);
  }
}
async function _executeStep(tabId, plannerStep, goal, myGen) {
  if (!window.DOMMatcher) {
    console.error("[SP:V2] DOMMatcher not available — cannot execute step");
    return "element_not_found";
  }
  // Covers element resolution + self-check + highlighter (including the
  // highlighter's own scroll wait, which is unchanged).
  const tExecuteStart = Date.now();
  return new Promise((resolve) => {
    if (_generation !== myGen) {
      resolve("aborted");
      return;
    }
    // guide-only: sensitive fields get a fixed "enter this yourself" instruction
    const highlighter = guardHighlighter(resolveHighlighter());
    const executor = new ExecutorEngine({
      domMatcher: window.DOMMatcher,
      highlighter,
      captureSnapshot: capturePageSnapshot
    });
    if (_executor) _executor.abort();
    _executor = executor;
    // Mutable — element:ready below may correct this once the real resolved
    // element is known (see computeExpectedNavigationFromElement).
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
      // Closes the user-perceived window opened in the PREVIOUS step's
      // user:acted: everything between acting and the next target being
      // pointed at — verification, replanning, resolution and highlighting.
      if (_lastUserActedAtMs !== null) {
        console.log(`[SP:V2:PERF] stage=action_to_next_highlight fillToHighlightMs=${Date.now() - _lastUserActedAtMs} fromIntent="${_lastUserActedIntent ?? ''}" toIntent="${plannerStep.intent ?? ''}"`);
        _lastUserActedAtMs = null;
        _lastUserActedIntent = null;
      }
      logEvent('executor_result', { tabId, ok: true, phase: step.phase, completionCondition: step.completionCondition });
      // Ground-truth correction from the ACTUAL resolved DOM element — see
      // computeExpectedNavigationFromElement. Runs here because the live node
      // is only known once the executor has resolved a candidate; only
      // overrides expectedPageState when a real anchor was actually found, so
      // a tier's correct guess is never clobbered by a null result.
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
      console.log(`[SP:V2:PERF] stage=executor executorMs=${Date.now() - tExecuteStart} markPendingStepMs=${Date.now() - tMarkStart} intent="${plannerStep.intent ?? ''}"`);
    });
    executor.on("element:not_found", ({ reason, isOptional }) => {
      if (isOptional) return;
      applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { reason });
      logEvent('executor_result', { tabId, ok: false, reason: redactText(reason) });
      done("element_not_found");
    });
    executor.on("user:acted", async ({ step, trigger, observedValue }) => {
      applyEvent(TaskEvent.USER_ACTED, { trigger });

      // ── Action-specific verification ───────────────────────────────────────
      // A DOM change means SOMETHING happened, not that what was asked for
      // happened. For a fill that distinction is the whole point: a partially
      // typed value changes the DOM exactly like a complete one, so settling
      // on "the page changed" recorded a half-entered value as done. When the
      // step names a value, the control must actually hold it. Clicks and
      // every other action keep the existing snapshot-based verification —
      // there is nothing requested to compare them against.
      // Only meaningful for a fill, and only when the field was actually
      // OBSERVED. `observedValue` is populated by the input path alone — the
      // click and url_change triggers carry null because they never read a
      // field. Treating that absence as a failed value check turned an
      // unobserved completion into a verification failure, burned the step
      // attempts, and reported "stuck on same step" while the control on
      // screen plainly held the requested value. Absence of an observation is
      // not evidence of a wrong value: those triggers fall through to the
      // existing snapshot verification below, exactly as before. The real
      // guard against a partial value lives in the executor, which will not
      // settle a valued fill until the control satisfies it.
      const isFillStep = plannerStep.phase === 'fill_form' || plannerStep.completionCondition === 'input_filled';
      const requestedValue = (plannerStep.targetElement?.value ?? '').trim();
      if (isFillStep && requestedValue && observedValue !== null && observedValue !== undefined
          && !valueSatisfies(observedValue, requestedValue)) {
        console.warn(`[SP:V2] Fill verification FAILED — requested="${requestedValue}" observed="${observedValue ?? ''}" — step NOT settled, replanning`);
        console.log(`[SP:V2:PERF] stage=post_action_verify verdict=FAILED reason=requested_value_not_present`);
        // Deliberately NOT recorded as a completed step: leaving it unsettled
        // is what lets the next cycle plan the same field again instead of
        // treating a partial value as progress. The attempt counter still
        // bounds this, so an unsatisfiable fill cannot loop forever.
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
      // Start of the window the user actually perceives: "I acted — when does
      // it point at the next thing?" — closed in element:ready.
      _lastUserActedAtMs = Date.now();
      _lastUserActedIntent = plannerStep.intent ?? null;
      if (expectsNavigation) {
        if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
        done("navigated");
        return;
      }
      showStatus("Verifying…", "validating");
      const pre = executor.getPreActionSnapshot();
      let post = capturePageSnapshot("");
      const tVerifyStart = Date.now();
      // Poll for a real change, up to the 150ms budget. The loop exits the
      // moment the DOM/URL actually changes; there is deliberately no pad back
      // up to the full budget afterwards — waiting out the remainder once the
      // change has already been observed (or once the loop has run its course)
      // adds latency without changing the verdict, which is computed from the
      // snapshots below exactly as before.
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
        targetLabel: (plannerStep.targetElement?.text || '').trim(),
        requestedValue: (plannerStep.targetElement?.value || '').trim(),
        urlBefore: pre?.url ?? window.location.href,
        domHashBefore: pre?.domHash ?? null,   // stored so dedup guard works post-completion
        urlAfter: post.url,
        // Captured post-action, before this step is (correctly) recorded complete — lets
        // the dedup guard tell "still in this step's own post-completion state" apart
        // from "something new happened since" (see the guard's comment for why this
        // matters for a STICKY effect like a menu that stays open across cycles).
        domHashAfter: post.domHash ?? null,
        completedAt: Date.now()
      });
      // Phase 23C shadow trigger: STEP_COMPLETED. legacyComplete reflects whether the
      // legacy path would declare the goal done at this step (i.e. it is the terminal
      // step). This is the key agreement datapoint.
      await _shadowGoalVerify(tabId, "STEP_COMPLETED", isTerminalStep(plannerStep));
      // Phase 26 — verifier-driven completion after a non-navigation step settles.
      // If the goal's effect is already observable (requiresEffect contract satisfied),
      // complete now — even when this step was NOT the planner-labeled terminal step.
      // State is VALIDATING here, so FINAL_STEP_COMPLETE → COMPLETE is a valid edge.
      {
        const s26 = await SessionStore.load(tabId);
        const gate = GoalVerifier.shouldComplete(s26?.goalCompletionCriteria);
        // Dynamic requirement-progress model — same mechanism as the
        // top-of-loop verifier gate; see its own comment block for the full
        // explanation.
        const {
          complete: gate26Complete,
          progress: progress26,
          usedRequirementHistory: used26
        } = await applyRequirementProgress(tabId, s26?.goalCompletionCriteria, s26?.requirementProgress, gate);
        if (gate26Complete) {
          console.log("[SP:GoalCompletion]", {
            source: "verifier",
            satisfied: true,
            signalsMatched: used26
              ? `${progress26.filter(Boolean).length}/${progress26.length}`
              : `${gate.verdict.matchedSignals}/${gate.verdict.totalSignals}`
          });
          applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict, source: "verifier" });
          if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
          await _showGoalCompleteCard(tabId, goal);
          done("goal_complete");
          return;
        }
      }
      if (isTerminalStep(plannerStep) &&
          await _requirementGateAllowsCompletion(tabId, await SessionStore.load(tabId))) {
        // Terminal step confirmed locally. Use the state machine's purpose-built
        // VALIDATING → COMPLETE transition (FINAL_STEP_COMPLETE) and finish now —
        // no replan, no waiting for a planner state=complete round-trip.
        console.log("[SP:GoalCompletion]", { source: "planner", state: "final_step" });
        applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict });
        if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
        await _showGoalCompleteCard(tabId, goal);
        done("goal_complete");
        return;
      }
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
        if (isTerminalStep(session.pendingStep) &&
            await _requirementGateAllowsCompletion(tabId, session)) {
          // The step that triggered this navigation was the terminal step — the goal
          // is complete on arrival. PLANNING → COMPLETE without a planner round-trip.
          applyEvent(TaskEvent.PLAN_COMPLETE);
          await _showGoalCompleteCard(tabId, session.goal);
          return;
        }
        await _runPlanLoop(tabId, myGen);
      } else if (classification === NavClassification.REFRESH) {
        // Standard refresh: user reloaded the page without acting. Re-show the same step.
        // BUT — for non-navigation steps (dom_change / menu-open) the executor fires
        // done("navigated") when expectsNavigation=true was incorrectly set by the planner,
        // which skips completeStep(). On bootstrap we can detect the action DID succeed
        // by comparing the current domHash against the pre-action domHash stored in
        // pendingStep.domHashBefore. If the DOM changed, the action completed — record
        // it and replan to the next step instead of replaying the same action.
        //
        // This is the primary fix for the "+" menu re-highlighting bug: the planner
        // labels the step urlChanges:true, user:acted fires done("navigated"), no
        // completeStep() runs, bootstrap sees REFRESH (URL unchanged), and without this
        // guard it replans with empty completedSteps, returning the same "+" step.
        const pendingStep = session.pendingStep;
        if (pendingStep?.domHashBefore != null) {
          const currentSnap = capturePageSnapshot('');
          const domChanged = currentSnap.domHash !== pendingStep.domHashBefore;
          console.log(`[SP:V2] REFRESH path: domHashBefore=${pendingStep.domHashBefore} domHashNow=${currentSnap.domHash} domChanged=${domChanged}`);
          if (domChanged) {
            // The action already produced a state change — treat as completed.
            console.log(`[SP:V2] REFRESH: DOM changed since step start — completing step and replanning`);
            await SessionStore.completeStep(tabId, buildStepRecord(pendingStep));
            if (_generation !== myGen) return;
            applyEvent(TaskEvent.SESSION_RESUME);
            if (isTerminalStep(pendingStep) &&
                await _requirementGateAllowsCompletion(tabId, session)) {
              applyEvent(TaskEvent.PLAN_COMPLETE);
              await _showGoalCompleteCard(tabId, session.goal);
              return;
            }
            await _runPlanLoop(tabId, myGen);
            return;
          }
        }
        // DOM unchanged — genuine refresh, re-execute the same step.
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
  // Phase 4: a final snapshot before the session disappears — otherwise
  // "this task was cancelled" leaves no trace at all (SessionStore.clear()
  // looks identical whether the task completed, failed, or was cancelled).
  logEvent('task_progress_snapshot', deriveTaskProgress(await SessionStore.load(_tabId), { aborted: true }));
  // Phase 7: a second, independent load — deliberately not sharing the read
  // above, which an existing characterization test
  // (v2-task-progress-wiring.test.mjs) pins to this exact literal shape.
  _emitTaskMetrics(await SessionStore.load(_tabId), { outcome: 'aborted', outcomeReason: 'USER_CANCELLED' });
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
  _cycleRecords = []; // Phase 7 — fresh metrics accumulation for the new task
  console.log("[SP:V2] ─────────────────────────────────────────");
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
    // Phase 4: same final-snapshot-before-clear as _handleStop, kept
    // fire-and-forget to match this function's existing sync contract
    // (window.__SP_V2_ABORT = _abortTask) and its existing clear().catch() style.
    SessionStore.load(tabIdSnapshot)
      .then((s) => logEvent('task_progress_snapshot', deriveTaskProgress(s, { aborted: true })))
      .catch(() => {});
    // Phase 7: a second, independent load — same reasoning as _handleStop's own.
    SessionStore.load(tabIdSnapshot)
      .then((s) => _emitTaskMetrics(s, { outcome: 'aborted', outcomeReason: 'USER_CANCELLED' }))
      .catch(() => {});
    SessionStore.clear(tabIdSnapshot).catch(() => {
    });
  }
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
export { computeExpectedNavigationFromElement as __computeExpectedNavigationFromElement };
export { deriveSettledSteps as __deriveSettledSteps, stepEffectStillHolds as __stepEffectStillHolds };
export { isGoalConsumed as __isGoalConsumed };
export {
  updateRequirementProgress as __updateRequirementProgress,
  remainingRequirementCount as __remainingRequirementCount,
  isRequirementSetComplete as __isRequirementSetComplete,
  _requirementGateAllowsCompletion as __requirementGateAllowsCompletion,
};
export {
  _handleClarification as __handleClarification,
  _handleResume as __handleResume,
  _handleStop as __handleStop,
};
console.log('[SP:V2] Ready — popup: "Open ScreenPilot"  console: __SP_V2_RUN("goal")');
