// ScreenPilot v2 — Vertical Slice Orchestrator
//
// This is the PoC wiring layer. It does the minimum to prove the v2 architecture
// end-to-end: Goal → Planner → ExecutionPlan → Executor → Highlight → User
// clicks → Validator → Next step → Complete.
//
// USAGE (browser console on any page):
//   __SP_V2_RUN('Open GitHub Settings')
//   __SP_V2_RUN('Open Google Account Picture settings')
//   __SP_V2_ABORT()    — stop the active task
//
// This script is a module-type content script. It has access to the same
// isolated world as content.js and lib/dom-matcher.js.
//
// Architecture probe — watch the console for:
//   [SP:V2] friction points, unexpected behaviors, missing data

import { ExecutorEngine }      from './services/executor-engine.js';
import { VercelBackendAdapter } from './providers/vercel-backend-adapter.js';
import { capturePageSnapshot } from './lib/page-snapshot.js';
import { TaskState, TaskEvent, transition } from './shared/state-machine/transitions.js';

// ── State machine ─────────────────────────────────────────────────────────────
// Single source of truth for the current task lifecycle state.
// applyEvent() is the only place _state is mutated.

let _state = TaskState.IDLE;

function ts() {
  return new Date().toISOString();
}

function applyEvent(event, meta = {}) {
  const from = _state;
  const to   = transition(_state, event);
  if (!to) {
    console.warn(`[SP:V2] [${ts()}] INVALID_TRANSITION state=${from} event=${event} (no-op)`);
    return false;
  }
  _state = to;
  const detail = Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[SP:V2] [${ts()}] STATE ${from} → ${to}  event=${event}${detail ? '  ' + detail : ''}`);
  return true;
}

// ── Minimal Validator ─────────────────────────────────────────────────────────
//
// Compares a pre-action and post-action PageSnapshot to determine whether the
// user's action caused the expected page change.
//
// In this PoC, INCONCLUSIVE is treated as PASSED — the executor advances
// regardless. Log the verdict so friction points become visible.

function validateStep(pre, post) {
  if (!pre || !post) return 'INCONCLUSIVE';
  if (post.url !== pre.url)         return 'PASSED';    // URL navigation happened
  if (post.domHash !== pre.domHash) return 'PASSED';    // DOM changed (popup/modal/etc.)
  return 'INCONCLUSIVE';                                // page looks the same
}

// ── Status overlay ────────────────────────────────────────────────────────────
// Minimal fixed-position banner so the user can see what the executor is
// doing without opening DevTools.

const STATUS_ID = 'sp-v2-status-banner';

function showStatus(text, type = 'info') {
  let el = document.getElementById(STATUS_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = STATUS_ID;
    el.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'padding:10px 18px', 'border-radius:10px',
      'font-family:system-ui,-apple-system,sans-serif', 'font-size:13px',
      'line-height:1.45', 'max-width:340px', 'pointer-events:none',
      'box-shadow:0 4px 24px rgba(0,0,0,0.35)', 'transition:background 0.2s',
    ].join(';');
    document.body.appendChild(el);
  }
  const bg = { planning: '#1a55d6', info: '#1a1a2e', success: '#0a6b0a', error: '#b02020', validating: '#7a5500' };
  el.style.background = bg[type] || bg.info;
  el.style.color       = '#fff';
  el.textContent       = text;
}

function hideStatus() {
  document.getElementById(STATUS_ID)?.remove();
}

// ── Highlighter resolution ────────────────────────────────────────────────────
// Use the full Highlighter from content.js when available (exposed on window
// via window.__SP_Highlighter). Fall back to a CSS-outline highlight so the
// PoC still works even if content.js load order is wrong.

function resolveHighlighter() {
  if (window.__SP_Highlighter) {
    console.log('[SP:V2] Using window.__SP_Highlighter from content.js');
    return window.__SP_Highlighter;
  }

  // ── Friction point: content.js loaded after v2-task.js ──────────────────
  // If this message appears, content script load order needs investigation.
  console.warn('[SP:V2] window.__SP_Highlighter not found — using fallback outline highlighter');

  let _el = null, _bubble = null;
  return {
    async show(element, text) {
      this.clear();
      if (!element) return false;
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.style.outline      = '3px solid #e03030';
      element.style.outlineOffset = '3px';
      element.style.borderRadius  = '4px';
      _el = element;

      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:10px 18px;border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;z-index:2147483646;max-width:380px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.45)';
      b.textContent = text;
      document.body.appendChild(b);
      _bubble = b;
      return true;
    },
    clear() {
      if (_el) { _el.style.outline = ''; _el.style.outlineOffset = ''; _el.style.borderRadius = ''; _el = null; }
      _bubble?.remove(); _bubble = null;
    },
  };
}

// ── V2 Task Runner ────────────────────────────────────────────────────────────

let _active = null;

async function runV2Task(goal) {
  // Abort any running task before starting a new one
  if (_active) {
    console.log('[SP:V2] Aborting previous task');
    _active.executor?.abort();
    hideStatus();
    _active = null;
  }

  const session = {};
  _active = session;
  _state  = TaskState.IDLE;  // reset for re-runs

  console.log('[SP:V2] ─────────────────────────────────────────');
  console.log(`[SP:V2] [${ts()}] Goal: "${goal}"`);
  console.log(`[SP:V2] [${ts()}] Page: ${window.location.href}`);
  console.log('[SP:V2] ─────────────────────────────────────────');
  applyEvent(TaskEvent.GOAL_SUBMITTED, { goal: JSON.stringify(goal) });
  showStatus('ScreenPilot v2 · Planning…', 'planning');

  // ── 1. Screenshot via background.js ────────────────────────────────────
  // Content scripts can't call chrome.tabs.captureVisibleTab directly.
  let screenshotImage, screenshotMime;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
    if (!resp?.success) throw new Error(resp?.error || 'Screenshot capture failed');
    screenshotImage = resp.image;
    screenshotMime  = resp.mimeType || 'image/png';
    console.log(`[SP:V2] Screenshot: ${screenshotImage?.length ?? 0} chars base64`);
  } catch (err) {
    console.error('[SP:V2] Screenshot failed:', err);
    showStatus(`Screenshot failed: ${err.message}`, 'error');
    _active = null;
    return;
  }

  // ── 2. Plan via VercelBackendAdapter ────────────────────────────────────
  console.log('[SP:V2] Calling /api/plan…');
  const adapter  = new VercelBackendAdapter();
  const planResp = await adapter.plan({
    schemaVersion: '1',
    requestId:     crypto.randomUUID(),
    goal,
    page: {
      url:        window.location.href,
      title:      document.title,
      screenshot: { image: screenshotImage, mimeType: screenshotMime },
    },
    preferences: { confirmDestructiveActions: false, maxSteps: 10 },
  });

  console.log(`[SP:V2] [${ts()}] Plan response → result=${planResp.result} state=${planResp.state}`);
  console.log(`[SP:V2] [${ts()}] plannerSummary: ${planResp.plannerSummary}`);
  console.log(`[SP:V2] [${ts()}] planId: ${planResp.plan?.planId ?? '(no plan)'}`);

  // ── Friction probe: check for unexpected result/state combinations ─────
  if (planResp.result === 'NEEDS_USER') {
    console.warn(`[SP:V2] [${ts()}] Planner returned NEEDS_USER — blockers:`, planResp.blockers);
    applyEvent(TaskEvent.PLAN_FAILED, { reason: 'NEEDS_USER' });
    showStatus(`Planner needs clarification: ${planResp.blockers?.[0] || '(no detail)'}`, 'error');
    _active = null;
    return;
  }

  if (planResp.result !== 'OK' || !planResp.plan) {
    const reason = planResp.plannerSummary || planResp.error || `result=${planResp.result}`;
    console.error(`[SP:V2] [${ts()}] Planning failed:`, reason);
    applyEvent(TaskEvent.PLAN_FAILED, { reason: planResp.result });
    showStatus(`Planning failed: ${reason}`, 'error');
    _active = null;
    return;
  }

  const plan = planResp.plan;
  applyEvent(TaskEvent.PLAN_RECEIVED, { planId: plan.planId, steps: plan.steps.length });
  console.log(`[SP:V2] [${ts()}] Plan steps:`);
  plan.steps.forEach((s, i) =>
    console.log(`  [${i+1}/${plan.steps.length}] ${s.description} → target="${s.targetElement?.text ?? '(null)'}"`)
  );

  // ── 3. Executor setup ───────────────────────────────────────────────────
  // Friction probe: DOMMatcher must be present as a global (loaded by
  // lib/dom-matcher.js content script). Log if missing.
  if (!window.DOMMatcher) {
    console.error('[SP:V2] FRICTION: window.DOMMatcher is undefined — dom-matcher.js not loaded');
    showStatus('Internal error: DOMMatcher not available', 'error');
    _active = null;
    return;
  }

  const highlighter = resolveHighlighter();

  session.executor = new ExecutorEngine({
    domMatcher:      window.DOMMatcher,
    highlighter,
    captureSnapshot: capturePageSnapshot,
  });

  const executor = session.executor;

  // ── 4. Event wiring ─────────────────────────────────────────────────────

  executor.on('element:ready', ({ step, element, snapshot }) => {
    const idx   = plan.steps.indexOf(step) + 1;
    const total = plan.steps.length;
    applyEvent(TaskEvent.ELEMENT_READY, { step: `${idx}/${total}` });
    console.log(`[SP:V2] [${ts()}] ▶ Step ${idx}/${total} ready`);
    console.log(`   instruction : ${step.description}`);
    console.log(`   target text : "${step.targetElement?.text ?? '(none)'}"`);
    console.log(`   element tag : ${element?.tagName?.toLowerCase()}`);
    console.log(`   snapshot url: ${snapshot?.url}`);
    showStatus(`Step ${idx}/${total}: ${step.description}`, 'info');
  });

  executor.on('element:not_found', ({ step, reason, isOptional }) => {
    const idx = plan.steps.indexOf(step) + 1;
    if (!isOptional) {
      applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { step: `${idx}`, reason: reason.replace(/\s+/g, '_') });
    }
    console.warn(`[SP:V2] [${ts()}] ✗ Element not found (step ${idx}/${plan.steps.length})`);
    console.warn(`   reason   : ${reason}`);
    console.warn(`   target   : ${JSON.stringify(step.targetElement)}`);
    console.warn(`   optional : ${isOptional}`);
    if (!isOptional) {
      // Friction probe: the planner's targetElement.text did not match any DOM element.
      // Check step.targetElement vs the actual DOM — text null, wrong region, or no-match.
      showStatus(`Can't find: "${step.targetElement?.text || reason}"`, 'error');
    }
  });

  executor.on('user:acted', async ({ step, trigger, timestamp }) => {
    const idx        = plan.steps.indexOf(step) + 1;
    const total      = plan.steps.length;
    const isFinalStep = idx === total;
    applyEvent(TaskEvent.USER_ACTED, { step: `${idx}/${total}`, trigger });
    console.log(`[SP:V2] [${ts()}] ✓ User acted on step ${idx}/${total} — trigger=${trigger}`);
    showStatus('Verifying…', 'validating');

    // Wait for page to settle (SPA updates, DOM mutations, network responses)
    await new Promise(r => setTimeout(r, 800));

    const pre     = executor.getPreActionSnapshot();
    const post    = capturePageSnapshot('');
    const verdict = validateStep(pre, post);

    console.log(`[SP:V2] [${ts()}] Validation: ${verdict}  isFinalStep=${isFinalStep}`);
    console.log(`   url : ${pre?.url} → ${post.url}`);
    console.log(`   dom : ${pre?.domHash} → ${post.domHash}`);

    if (isFinalStep) {
      applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict });
    } else if (verdict === 'INCONCLUSIVE') {
      // Page didn't change — could be: click on wrong element, CSS-only update,
      // or SPA update outside top-60 hash window. Advancing in PoC mode.
      console.warn(`[SP:V2] [${ts()}] INCONCLUSIVE — advancing anyway (PoC mode)`);
      applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
    } else {
      applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
    }

    executor.advance();
  });

  executor.on('step:skipped', ({ step, reason }) => {
    const idx = plan.steps.indexOf(step) + 1;
    console.log(`[SP:V2] [${ts()}] ↷ Step ${idx} skipped (optional): ${step.description} — ${reason}`);
  });

  executor.on('plan:complete', ({ plan: completedPlan, completedAt }) => {
    const elapsed = completedAt - plan.createdAt;
    console.log(`[SP:V2] [${ts()}] ✓ Workflow complete`);
    console.log(`   finalState    : ${_state}`);
    console.log(`   planId        : ${completedPlan.planId}`);
    console.log(`   stepsCompleted: ${plan.steps.length}`);
    console.log(`   elapsedMs     : ${elapsed}`);
    if (_state !== TaskState.COMPLETE) {
      console.warn(`[SP:V2] [${ts()}] State is ${_state} at plan:complete — expected COMPLETE`);
    }
    showStatus('✓ Goal achieved!', 'success');
    setTimeout(hideStatus, 4000);
    _active = null;
  });

  // ── 5. Start ────────────────────────────────────────────────────────────
  console.log(`[SP:V2] [${ts()}] Starting executor (planId=${plan.planId})…`);
  showStatus(`Starting: ${plan.steps[0]?.description ?? goal}`, 'info');
  executor.start(plan);
}

function abortV2Task() {
  if (!_active) { console.log('[SP:V2] No active task'); return; }
  _active.executor?.abort();
  hideStatus();
  _active = null;
  console.log('[SP:V2] Task aborted');
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.__SP_V2_RUN   = runV2Task;
window.__SP_V2_ABORT = abortV2Task;

console.log('[SP:V2] Ready — run: __SP_V2_RUN("your goal here")');
