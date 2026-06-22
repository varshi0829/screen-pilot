// ScreenPilot - Debug Overlay
// Plain IIFE injected as a content script via chrome.scripting.executeScript.
// Sets window.__SP_DEBUG__ = true so content.js begins emitting 'sp-debug' CustomEvents.
// Listens to those events and renders a floating debug panel.
//
// Injection: popup.js → chrome.scripting.executeScript({ files: ['debug-overlay.js'] })
// Removal:   chrome.scripting.executeScript({ code: '...' })  (see popup.js)
//
// The overlay positions itself bottom-left to avoid overlapping the ScreenPilot widget
// (which lives bottom-right). z-index 2147483640 keeps it above almost everything.

(function () {
  'use strict';

  if (document.getElementById('sp-debug-overlay')) return; // idempotent

  // ─── SIGNAL DEBUG MODE ──────────────────────────────────────────────────────
  // content.js checks this flag before dispatching CustomEvents so that
  // event dispatch overhead is zero when the overlay is not loaded.
  window.__SP_DEBUG__ = true;

  // ─── STATE ──────────────────────────────────────────────────────────────────
  let _state = {
    goal:           '',
    stepCurrent:    0,
    stepTotal:      0,
    domScore:       null,
    recoveryTier:   '—',   // Primary | Alternatives | Semantic | Failed | —
    memoryHit:      null,  // null = unknown, true = hit, false = miss
    memoryConf:     null,
    geminiCalls:    0,
    geminiLastMs:   null,
    enterpriseApp:  null,
    taskStatus:     'idle',  // idle | active | complete | failed
    expanded:       false,
  };

  // ─── STYLES ─────────────────────────────────────────────────────────────────
  const STYLE = `
  #sp-debug-overlay {
    position: fixed;
    bottom: 16px;
    left: 16px;
    z-index: 2147483640;
    font-family: 'SF Mono', 'Fira Mono', 'Consolas', monospace;
    font-size: 11px;
    line-height: 1.4;
    user-select: none;
    pointer-events: auto;
    max-width: 280px;
  }
  #sp-debug-overlay .sp-dov-box {
    background: rgba(17,17,27,0.93);
    color: #cdd6f4;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    overflow: hidden;
  }
  #sp-debug-overlay .sp-dov-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    cursor: pointer;
    background: rgba(255,255,255,0.05);
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  #sp-debug-overlay .sp-dov-logo {
    font-weight: 700;
    color: #89b4fa;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  #sp-debug-overlay .sp-dov-inline {
    flex: 1;
    color: #a6adc8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
  }
  #sp-debug-overlay .sp-dov-toggle {
    background: none;
    border: none;
    color: #585b70;
    font-size: 13px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
    flex-shrink: 0;
  }
  #sp-debug-overlay .sp-dov-toggle:hover { color: #cdd6f4; }
  #sp-debug-overlay .sp-dov-close {
    background: none;
    border: none;
    color: #585b70;
    font-size: 13px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
    flex-shrink: 0;
  }
  #sp-debug-overlay .sp-dov-close:hover { color: #f38ba8; }
  #sp-debug-overlay .sp-dov-body {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  #sp-debug-overlay .sp-dov-goal {
    color: #cba6f7;
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    margin-bottom: 2px;
  }
  #sp-debug-overlay .sp-dov-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #sp-debug-overlay .sp-dov-label {
    color: #6c7086;
    width: 74px;
    flex-shrink: 0;
    font-size: 10px;
  }
  #sp-debug-overlay .sp-dov-val {
    color: #cdd6f4;
    flex: 1;
    font-size: 11px;
  }
  #sp-debug-overlay .sp-dov-val.hit   { color: #a6e3a1; }
  #sp-debug-overlay .sp-dov-val.miss  { color: #f38ba8; }
  #sp-debug-overlay .sp-dov-val.warn  { color: #fab387; }
  #sp-debug-overlay .sp-dov-bar-wrap {
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    overflow: hidden;
    flex: 1;
  }
  #sp-debug-overlay .sp-dov-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.25s ease;
    background: #89b4fa;
  }
  #sp-debug-overlay .sp-dov-bar-fill.good { background: #a6e3a1; }
  #sp-debug-overlay .sp-dov-bar-fill.warn { background: #fab387; }
  #sp-debug-overlay .sp-dov-bar-fill.bad  { background: #f38ba8; }
  `;

  // ─── DOM ────────────────────────────────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = 'sp-debug-overlay';
  root.innerHTML = `
  <div class="sp-dov-box">
    <div class="sp-dov-header" id="sp-dov-hdr">
      <span class="sp-dov-logo">SP Debug</span>
      <span class="sp-dov-inline" id="sp-dov-inline">idle</span>
      <button class="sp-dov-toggle" id="sp-dov-toggle" title="Expand/collapse">▸</button>
      <button class="sp-dov-close" id="sp-dov-close" title="Remove overlay">✕</button>
    </div>
    <div class="sp-dov-body" id="sp-dov-body" style="display:none">
      <div class="sp-dov-goal" id="sp-dov-goal">—</div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">Step</span>
        <span class="sp-dov-val" id="sp-dov-step">—</span>
      </div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">DOM Score</span>
        <div class="sp-dov-bar-wrap"><div class="sp-dov-bar-fill" id="sp-dov-bar" style="width:0%"></div></div>
        <span class="sp-dov-val" id="sp-dov-score" style="width:30px;text-align:right">—</span>
      </div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">Recovery</span>
        <span class="sp-dov-val" id="sp-dov-recovery">—</span>
      </div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">Memory</span>
        <span class="sp-dov-val" id="sp-dov-memory">—</span>
      </div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">Gemini Calls</span>
        <span class="sp-dov-val" id="sp-dov-gemini">0</span>
      </div>
      <div class="sp-dov-row">
        <span class="sp-dov-label">Enterprise</span>
        <span class="sp-dov-val" id="sp-dov-enterprise">—</span>
      </div>
    </div>
  </div>
  `;
  document.documentElement.appendChild(root);

  // ─── ELEMENT REFS ────────────────────────────────────────────────────────────
  const elInline     = document.getElementById('sp-dov-inline');
  const elBody       = document.getElementById('sp-dov-body');
  const elToggle     = document.getElementById('sp-dov-toggle');
  const elGoal       = document.getElementById('sp-dov-goal');
  const elStep       = document.getElementById('sp-dov-step');
  const elBar        = document.getElementById('sp-dov-bar');
  const elScore      = document.getElementById('sp-dov-score');
  const elRecovery   = document.getElementById('sp-dov-recovery');
  const elMemory     = document.getElementById('sp-dov-memory');
  const elGemini     = document.getElementById('sp-dov-gemini');
  const elEnterprise = document.getElementById('sp-dov-enterprise');

  // ─── EXPAND / COLLAPSE ───────────────────────────────────────────────────────
  document.getElementById('sp-dov-hdr').addEventListener('click', (e) => {
    if (e.target.id === 'sp-dov-close') return; // handled separately
    _state.expanded = !_state.expanded;
    elBody.style.display   = _state.expanded ? 'flex' : 'none';
    elToggle.textContent   = _state.expanded ? '▾' : '▸';
  });

  document.getElementById('sp-dov-close').addEventListener('click', () => {
    _remove();
  });

  // ─── RENDER ─────────────────────────────────────────────────────────────────
  function _render() {
    const s = _state;
    // Header inline summary
    const stepStr = s.stepTotal > 0 ? `step ${s.stepCurrent}/${s.stepTotal}` : '';
    const gemStr  = s.geminiCalls > 0 ? `G:${s.geminiCalls}` : '';
    const tierStr = s.recoveryTier !== '—' ? s.recoveryTier : '';
    const parts   = [stepStr, gemStr, tierStr].filter(Boolean);
    elInline.textContent = parts.length ? parts.join(' · ') : s.taskStatus;

    // Body
    elGoal.textContent = s.goal || '—';
    elStep.textContent = s.stepTotal > 0 ? `${s.stepCurrent} / ${s.stepTotal}` : '—';

    // DOM score bar
    const score = s.domScore;
    if (score !== null) {
      const pct  = Math.min(100, Math.max(0, score));
      const cls  = score >= 70 ? 'good' : score >= 50 ? 'warn' : 'bad';
      elBar.style.width = pct + '%';
      elBar.className   = 'sp-dov-bar-fill ' + cls;
      elScore.textContent = score;
    } else {
      elBar.style.width = '0%';
      elScore.textContent = '—';
    }

    // Recovery tier
    const tierClass = s.recoveryTier === 'Failed' ? 'miss'
      : s.recoveryTier === 'Primary' ? 'hit'
      : s.recoveryTier !== '—' ? 'warn' : '';
    elRecovery.textContent  = s.recoveryTier;
    elRecovery.className    = 'sp-dov-val ' + tierClass;

    // Memory
    if (s.memoryHit === true) {
      elMemory.textContent = 'Hit' + (s.memoryConf ? ` (${Math.round(s.memoryConf * 100)}%)` : '');
      elMemory.className   = 'sp-dov-val hit';
    } else if (s.memoryHit === false) {
      elMemory.textContent = 'Miss';
      elMemory.className   = 'sp-dov-val miss';
    } else {
      elMemory.textContent = '—';
      elMemory.className   = 'sp-dov-val';
    }

    // Gemini
    elGemini.textContent = s.geminiCalls + (s.geminiLastMs ? ` (last: ${s.geminiLastMs}ms)` : '');
    elGemini.className   = 'sp-dov-val' + (s.geminiCalls >= 4 ? ' warn' : '');

    // Enterprise
    elEnterprise.textContent = s.enterpriseApp || '—';
  }

  // ─── EVENT HANDLER ───────────────────────────────────────────────────────────
  function _onDebugEvent(e) {
    const { type, ...data } = e.detail || {};
    switch (type) {
      case 'TASK_START':
        _state.goal         = data.goal || '';
        _state.stepCurrent  = 0;
        _state.stepTotal    = 0;
        _state.domScore     = null;
        _state.recoveryTier = '—';
        _state.memoryHit    = null;
        _state.memoryConf   = null;
        _state.geminiCalls  = 0;
        _state.geminiLastMs = null;
        _state.enterpriseApp = null;
        _state.taskStatus   = 'active';
        break;
      case 'GEMINI_CALL':
        _state.geminiCalls++;
        break;
      case 'GEMINI_RESPONSE':
        if (data.latencyMs) _state.geminiLastMs = data.latencyMs;
        if (data.stepCount) _state.stepTotal = data.stepCount;
        break;
      case 'MEMORY_HIT':
        _state.memoryHit  = true;
        _state.memoryConf = data.confidence ?? null;
        break;
      case 'MEMORY_MISS':
        _state.memoryHit = false;
        break;
      case 'CACHE_HIT':
        _state.memoryHit = true;
        break;
      case 'ENTERPRISE_CONTEXT':
        _state.enterpriseApp = data.application || null;
        break;
      case 'PLAN_STEP_PRIMARY':
        _state.stepCurrent  = (data.stepIndex ?? _state.stepCurrent) + 1;
        _state.domScore     = data.score ?? null;
        _state.recoveryTier = 'Primary';
        break;
      case 'PLAN_STEP_RECOVERY_1':
        _state.stepCurrent  = (data.stepIndex ?? _state.stepCurrent) + 1;
        _state.domScore     = data.score ?? null;
        _state.recoveryTier = 'Alternatives';
        break;
      case 'PLAN_STEP_RECOVERY_2':
        _state.stepCurrent  = (data.stepIndex ?? _state.stepCurrent) + 1;
        _state.domScore     = data.score ?? null;
        _state.recoveryTier = 'Semantic';
        break;
      case 'PLAN_STEP_FAILED':
        _state.domScore     = data.score ?? null;
        _state.recoveryTier = 'Failed';
        break;
      case 'TASK_END':
        _state.taskStatus = data.status || 'idle';
        break;
    }
    _render();
  }

  window.addEventListener('sp-debug', _onDebugEvent);

  // ─── CLEANUP ─────────────────────────────────────────────────────────────────
  function _remove() {
    window.__SP_DEBUG__ = false;
    window.removeEventListener('sp-debug', _onDebugEvent);
    styleEl.remove();
    root.remove();
  }

  // Expose for external removal via executeScript
  window.__SP_DEBUG_REMOVE__ = _remove;

  // Initial render
  _render();
})();
