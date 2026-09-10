// ScreenPilot v2 — Task Orchestrator (Architecture B)
//
// Restored mechanically from committed bundle e9a3031 (v2-task section lines 1319–2044).
// Single intentional deviation: BYOK apiKey pass-through in _runPlanLoop().

import { ExecutorEngine }                         from './services/executor-engine.js';
import { VercelBackendAdapter }                   from './providers/vercel-backend-adapter.js';
import { PageStateService }                       from './services/page-state-service.js';
import { DecisionRouter }                          from './services/decision-router.js';
import { LocalQwenAdapter }                        from './providers/local-qwen-adapter.js';
import { capturePageSnapshot }                    from './lib/page-snapshot.js';
import { TaskState, TaskEvent, transition }       from './shared/state-machine/transitions.js';
import { SessionStore }                           from './services/session-store.js';
import { GoalVerifier }                           from './services/goal-verifier.js';
import { classifyNavigation, NavClassification }  from './services/navigation-classifier.js';
import { PrivacySanitizer }                       from './lib/privacy-sanitizer.js';

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
  const { executionMode = 'cloud', openRouterApiKey } = storage
    ? await storage.get(['executionMode', 'openRouterApiKey'])
    : { executionMode: 'cloud', openRouterApiKey: undefined };
  const cloudAdapter   = new VercelBackendAdapter({ apiKey: openRouterApiKey ?? undefined });
  const decisionRouter = new DecisionRouter({ executionMode, localQwenAdapter: new LocalQwenAdapter(), cloudAdapter });
  // B5: consecutive retryable-failure counter, reset on every successful planner response.
  let planRetryCount = 0;
  // Set inside the local-mode branch each iteration; used after the try/catch below
  // to enrich the chosen step with ground-truth nav/region info (see Bug A fix).
  let localPageState = null;
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
    console.log(`[SP:V2:TRACE] state transition phase=${session.phase} goal="${session.goal}"`);

    // Diagnostic: log full session state at each plan loop entry
    try {
      const lastStep = session.completedSteps[session.completedSteps.length - 1];
      const currentSnap = capturePageSnapshot('');
      console.log(`[SP:V2:DIAG] Plan loop entry — completedSteps=${session.completedSteps.length} stepAttemptCount=${session.stepAttemptCount} phase=${session.phase}`, {
        pendingStep:       session.pendingStep ? { intent: session.pendingStep.intent, domHashBefore: session.pendingStep.domHashBefore } : null,
        lastCompletedStep: lastStep ? { intent: lastStep.intent, domHashBefore: lastStep.domHashBefore, urlBefore: lastStep.urlBefore } : null,
        currentUrl:        currentSnap.url,
        currentDomHash:    currentSnap.domHash,
      });
    } catch { /* non-browser environment — skip diagnostic snapshot */ }
    
    // Verifier-driven early completion check (requiresEffect OR generic goal satisfaction)
    {
      console.log("[SP:V2:TRACE] verify START");
      const tGoalStart = Date.now();
      const pageState  = PageStateService.extractPageState();
      const gate       = GoalVerifier.shouldComplete(session.goalCompletionCriteria, {}, session.goal, pageState);
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
    showStatus("ScreenPilot · Planning…", "planning");

    const freshSession = session;
    if (!freshSession) {
      hideStatus();
      return;
    }
    if (_generation !== myGen) return;
    const nClarifications = freshSession.clarifications?.length ?? 0;
    const pageControls    = collectPageControls();
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
    try {
      const tDomStart = Date.now();
      const pageState = PageStateService.extractPageState();
      localPageState  = pageState;
      const domMs     = Date.now() - tDomStart;

      // Pre-L3 goal satisfaction check — applies regardless of executionMode,
      // so cloud users also skip a paid LLM call when the goal is already met.
      const preL3Check = GoalVerifier.isGoalSatisfied(freshSession.goal, pageState);
      if (preL3Check.satisfied) {
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

      const routed = await decisionRouter.route(freshSession.goal, pageState, { signal: planController.signal, cloudContext });

      planResp     = routed.planResponse;
      const layer1Ms    = routed.layer1Ms ?? 0;
      const layer2Ms    = routed.layer2Ms ?? 0;
      const qwenMs      = routed.qwenMs ?? 0;
      const cloudMs     = routed.cloudMs ?? 0;
      const totalPlanningMs = Date.now() - tReqStart;

      console.log(`[SP:V2:TRACE] layer result layer=${routed.layer} confidence=${planResp.confidence} qwenFailureReason=${routed.qwenFailureReason ?? 'n/a'}`);
      console.log(`[SP:V2:PERF] domMs=${domMs} goalVerifyMs=${preL3Check.latencyMs} layer1Ms=${layer1Ms} layer2Ms=${layer2Ms} qwenMs=${qwenMs} cloudMs=${cloudMs} screenshotMs=${screenshotMs} postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=${totalPlanningMs} l3Layer=${routed.layer}`);
    } catch (err) {
      window.removeEventListener('popstate', onNavCheck);
      console.log(`[SP:V2:TRACE] plan ERROR reqId=${reqId} name=${err?.name} message=${err?.message}`);
      console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${planController.signal.aborted} reason=${planController.signal.reason}`);
      if (planController.signal.aborted || err?.name === 'AbortError') {
        console.log(`[SP:V2:DEBUG] replan_lifecycle reqId=${reqId} action=replan_aborted_exception`);
        console.log("[SP:V2] Request aborted — replanning");
        continue;
      }
      console.error("[SP:V2] Planning failed:", err);
      applyEvent(TaskEvent.PLAN_FAILED, { reason: "network_error" });
      showStatus(`ScreenPilot: Planning error — ${err.message}`, "error");
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
        // Diagnostic only — logs the gate's inputs/outputs before the accept/reject
        // decision below is made. No control flow depends on this log.
        console.log("[SP:GoalCompletionGate]", {
          requiresEffect:  criteria.requiresEffect,
          verifierComplete: gate.complete,
          verifierReason:   gate.reason
        });
        if (!gate.complete) {
          console.log("[SP:GoalCompletion]", {
            source: "planner", state: "complete", accepted: false, reason: gate.reason
          });
          // Reject the claim and loop back for another planning pass. The existing
          // planner-attempt budget check (top of this same loop, above) already
          // bounds total retries for the whole task — no new counter is introduced.
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
      showStatus(reason ? `ScreenPilot: Cannot determine next step — ${reason}` : "ScreenPilot: Cannot determine next step — goal is too ambiguous", "error");
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
      // B5: retry transient backend failures with exponential backoff (1s, 2s) WITHOUT
      // clearing the session. Backoff = 1000 * 2^(retry-1): retry 1 → 1s, retry 2 → 2s.
      if (retryable && planRetryCount < MAX_PLAN_RETRIES) {
        planRetryCount++;
        const backoffMs = 1000 * Math.pow(2, planRetryCount - 1);
        console.warn(`[SP:V2] [${ts()}] Retryable plan failure (${errorCode}) — retry ${planRetryCount}/${MAX_PLAN_RETRIES} in ${backoffMs}ms (session preserved)`);
        showStatus("ScreenPilot · Reconnecting…", "planning");
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      applyEvent(TaskEvent.PLAN_FAILED, { reason: errorCode });
      if (retryable) {
        // B5: retries exhausted — surface the error but PRESERVE the session so the
        // user can resume once connectivity returns. Do NOT clear.
        showStatus(`ScreenPilot: ${planResp.error ?? "Connection problem — please try again"}`, "error");
      } else {
        showStatus(`ScreenPilot: ${planResp.error ?? "Planning failed"}`, "error");
        await SessionStore.clear(tabId);
      }
      return;
    }
    // B5: a usable planner response arrived — reset the retry counter for the next step.
    planRetryCount = 0;
    const plannerStep = planResp.plan.steps[0];
    if (!plannerStep) {
      console.warn("[SP:V2] state=planned but steps is empty — treating as ambiguous");
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
            await SessionStore.clear(tabId);
            return;
          }
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
    const result = await _executeStep(tabId, plannerStep, freshSession.goal, myGen);
    if (result === "navigated" || result === "aborted") {
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
        await SessionStore.clear(tabId);
        return;
      }
      await SessionStore.setPhase(tabId, "PLANNING");
      applyEvent(TaskEvent.REPLAN_TRIGGERED, { reason: "element_not_found" });
      await _shadowGoalVerify(tabId, "REPLAN", false); // Phase 23C shadow trigger
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await SessionStore.setPhase(tabId, "PLANNING");
    applyEvent(TaskEvent.REPLAN_TRIGGERED, { intent: plannerStep.intent });
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
        if (gate.complete) {
          console.log("[SP:GoalCompletion]", {
            source: "verifier",
            satisfied: true,
            signalsMatched: `${gate.verdict.matchedSignals}/${gate.verdict.totalSignals}`
          });
          applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict, source: "verifier" });
          if (_taskContext) { _taskContext.steps.push({ description: step.description }); _taskContext.currentStep = null; }
          await _showGoalCompleteCard(tabId, goal);
          done("goal_complete");
          return;
        }
      }
      if (isTerminalStep(plannerStep)) {
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
            if (isTerminalStep(pendingStep)) {
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
export { computeExpectedNavigationFromElement as __computeExpectedNavigationFromElement };
export {
  _handleClarification as __handleClarification,
  _handleResume as __handleResume,
  _handleStop as __handleStop,
};
console.log('[SP:V2] Ready — popup: "Open ScreenPilot"  console: __SP_V2_RUN("goal")');
