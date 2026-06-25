// extension/playground/playground.js
// ScreenPilot Developer Playground — internal tool only
//
// In-page debug panel for the full v2 execution pipeline.
// Runs its own independent Executor + Planner instances per session.
// Does NOT share state with v2-task.js.
//
// Usage:
//   __SP_PLAYGROUND.open()    — show the panel
//   __SP_PLAYGROUND.close()   — close the panel
//   __SP_PLAYGROUND.toggle()  — toggle visibility

import { ExecutorEngine }       from '../services/executor-engine.js';
import { VercelBackendAdapter } from '../providers/vercel-backend-adapter.js';
import { capturePageSnapshot }  from '../lib/page-snapshot.js';
import { TaskState, TaskEvent, transition } from '../shared/state-machine/transitions.js';

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  bg:         '#1e1e1e',
  surface:    '#252526',
  border:     '#3e3e42',
  muted:      '#858585',
  text:       '#d4d4d4',
  label:      '#9cdcfe',
  value:      '#ce9178',
  green:      '#4ec94e',
  red:        '#f44747',
  yellow:     '#dcdcaa',
  blue:       '#569cd6',
  teal:       '#4ec9b0',
  orange:     '#ff8c00',
  purple:     '#c586c0',
};

const STATE_COLOR = {
  [TaskState.IDLE]:          '#5a5a5a',
  [TaskState.PLANNING]:      C.blue,
  [TaskState.EXECUTING]:     C.purple,
  [TaskState.AWAITING_USER]: C.orange,
  [TaskState.VALIDATING]:    C.yellow,
  [TaskState.RECOVERING]:    C.red,
  [TaskState.COMPLETE]:      C.green,
  [TaskState.ERROR]:         C.red,
};

// ── Module state ──────────────────────────────────────────────────────────────

const S = {
  visible:        false,
  taskState:      TaskState.IDLE,
  goal:           '',
  planResp:       null,    // last full PlanResponse
  plan:           null,    // current ExecutionPlan
  executor:       null,    // active ExecutorEngine
  timeline:       [],      // [{ tsShort, from, to, event, meta }]
  logs:           [],      // structured log records
  stepMode:       false,
  advanceResolver: null,   // set when waiting for manual advance in step mode
  currentStep:    null,    // active PlanStep
  currentStepIdx: -1,
  elementInfo:    null,    // { element, score, reason, tag }
  validatorInfo:  null,    // { verdict, preUrl, postUrl, preDom, postDom }
  snapshot:       null,    // latest PageSnapshot
  goldenResp:     null,    // loaded golden PlanResponse
  savedA:         null,    // saved plan for compare
  savedB:         null,
  sections:       { planner: true, plan: true, step: true, timeline: true, snapshot: false, tools: false },
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function ts()      { return new Date().toISOString(); }
function tsShort() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function esc(s)    { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function trunc(s, n = 60) { const str = String(s ?? ''); return str.length > n ? str.slice(0, n) + '…' : str; }

function addLog(entry) { S.logs.push({ ts: ts(), ...entry }); }

function applyEvent(event, meta = {}) {
  const from = S.taskState;
  const to   = transition(S.taskState, event);
  if (!to) {
    addLog({ type: 'invalid_transition', from, event });
    return false;
  }
  S.taskState = to;
  const entry = { tsShort: tsShort(), from, to, event, meta };
  S.timeline.push(entry);
  addLog({ type: 'transition', ...entry });
  renderTimeline();
  renderStateBar();
  return true;
}

function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Style injection ───────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('sp-pg-styles')) return;
  const style = document.createElement('style');
  style.id    = 'sp-pg-styles';
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

// ── Panel HTML ────────────────────────────────────────────────────────────────

function createPanel() {
  const div       = document.createElement('div');
  div.id          = 'sp-pg-panel';
  div.className   = 'sp-pg-hidden';
  div.innerHTML   = `
    <div class="sp-pg-header">
      <span class="sp-pg-title">🧪 ScreenPilot Playground</span>
      <button class="sp-pg-hbtn" id="sp-pg-export-btn" title="Export logs as JSON">↓ Export</button>
      <button class="sp-pg-hbtn" id="sp-pg-close-btn" title="Close">✕</button>
    </div>
    <div class="sp-pg-state-bar" id="sp-pg-state-bar">
      <span class="sp-pg-chip" id="sp-pg-state-chip">IDLE</span>
      <span class="sp-pg-planid" id="sp-pg-planid-display">no plan</span>
    </div>
    <div class="sp-pg-controls">
      <div class="sp-pg-goal-row">
        <input class="sp-pg-goal-input" id="sp-pg-goal-input" placeholder='Goal: e.g. "Open GitHub Settings"' />
        <button class="sp-pg-btn" id="sp-pg-run-btn">▶ Run</button>
      </div>
      <div class="sp-pg-ctrl-row">
        <button class="sp-pg-btn-sm" id="sp-pg-replay-btn" disabled>↺ Replay</button>
        <button class="sp-pg-btn-danger" id="sp-pg-stop-btn" disabled>■ Stop</button>
        <button class="sp-pg-btn-sm" id="sp-pg-capture-btn">⊙ Snapshot</button>
        <label class="sp-pg-toggle">
          <input type="checkbox" id="sp-pg-step-mode-chk" />
          Step Mode
        </label>
      </div>
    </div>
    <div class="sp-pg-body" id="sp-pg-body">
      ${section('planner',  'PLANNER',        '<div id="sp-pg-planner-content"><span style="color:#858585">Run a goal to see planner output.</span></div>')}
      ${section('plan',     'EXECUTION PLAN',  '<div id="sp-pg-plan-content"><span style="color:#858585">No plan yet.</span></div>')}
      ${section('step',     'CURRENT STEP',    '<div id="sp-pg-step-content"><span style="color:#858585">No active step.</span></div>')}
      ${section('timeline', 'EVENT TIMELINE',  '<div class="sp-pg-tl" id="sp-pg-timeline-list"></div>')}
      ${section('snapshot', 'DOM SNAPSHOT',    '<div id="sp-pg-snapshot-content"><span style="color:#858585">No snapshot yet.</span></div>', false)}
      ${section('tools',    'TOOLS',           toolsHTML(), false)}
    </div>
  `;
  document.body.appendChild(div);
  bindEvents(div);
  return div;
}

function section(id, title, content, open = true) {
  return `
    <div class="sp-pg-section" id="sp-pg-sec-${id}">
      <div class="sp-pg-sh" data-section="${id}">
        <span class="sp-pg-sh-arrow ${open ? 'open' : ''}">▶</span>
        <span class="sp-pg-sh-title">${title}</span>
      </div>
      <div class="sp-pg-sb ${open ? '' : 'hidden'}">${content}</div>
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
          <span id="sp-pg-golden-badge" style="display:none" class="sp-pg-golden-badge">● Golden loaded</span>
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

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents(panel) {
  // Header
  panel.querySelector('#sp-pg-close-btn').addEventListener('click', close);
  panel.querySelector('#sp-pg-export-btn').addEventListener('click', exportLogs);

  // Controls
  panel.querySelector('#sp-pg-run-btn').addEventListener('click', handleRun);
  panel.querySelector('#sp-pg-replay-btn').addEventListener('click', handleReplay);
  panel.querySelector('#sp-pg-stop-btn').addEventListener('click', handleStop);
  panel.querySelector('#sp-pg-capture-btn').addEventListener('click', handleSnapshot);
  panel.querySelector('#sp-pg-step-mode-chk').addEventListener('change', e => {
    S.stepMode = e.target.checked;
  });
  panel.querySelector('#sp-pg-goal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRun();
  });

  // Section collapse
  panel.querySelectorAll('.sp-pg-sh').forEach(sh => {
    sh.addEventListener('click', () => {
      const id    = sh.dataset.section;
      S.sections[id] = !S.sections[id];
      sh.querySelector('.sp-pg-sh-arrow').classList.toggle('open', S.sections[id]);
      sh.nextElementSibling.classList.toggle('hidden', !S.sections[id]);
    });
  });

  // Tools
  panel.querySelector('#sp-pg-golden-load-btn').addEventListener('click', loadGolden);
  panel.querySelector('#sp-pg-golden-clear-btn').addEventListener('click', clearGolden);
  panel.querySelector('#sp-pg-save-a-btn').addEventListener('click', () => saveCompare('A'));
  panel.querySelector('#sp-pg-save-b-btn').addEventListener('click', () => saveCompare('B'));
  panel.querySelector('#sp-pg-compare-btn').addEventListener('click', openCompare);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderStateBar() {
  const chip    = document.getElementById('sp-pg-state-chip');
  const planidEl = document.getElementById('sp-pg-planid-display');
  if (!chip) return;
  chip.textContent   = S.taskState;
  chip.style.background = STATE_COLOR[S.taskState] ?? C.muted;
  planidEl.textContent  = S.plan?.planId ? `planId: ${S.plan.planId.slice(0, 13)}…` : 'no plan';
}

function renderPlanner() {
  const el = document.getElementById('sp-pg-planner-content');
  if (!el) return;
  const r = S.planResp;
  if (!r) { el.innerHTML = '<span style="color:#858585">Run a goal to see planner output.</span>'; return; }

  const resultColor = r.result === 'OK' ? C.green : r.result === 'NEEDS_USER' ? C.yellow : C.red;
  const stateColor  = r.state === 'planned' ? C.green : r.state === 'blocked' ? C.red : C.yellow;
  const conf        = r.confidence ?? 0;
  const confColor   = conf >= 0.8 ? C.green : conf >= 0.5 ? C.yellow : C.red;
  const latency     = r.providerMetadata?.latencyMs;
  const tokens      = r.providerMetadata?.inputTokens != null
    ? `${r.providerMetadata.inputTokens}in / ${r.providerMetadata.outputTokens ?? '?'}out`
    : '—';
  const goldenNote  = S.goldenResp ? '<span class="sp-pg-golden-badge">● golden</span>' : '';

  el.innerHTML = `
    <div class="sp-pg-row"><span class="sp-pg-lbl">result</span><span class="sp-pg-val" style="color:${resultColor}">${esc(r.result)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">state</span><span class="sp-pg-val" style="color:${stateColor}">${esc(r.state)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">confidence</span>
      <div style="flex:1">
        <div style="color:${confColor}">${conf.toFixed(2)}</div>
        <div class="sp-pg-conf-bar"><div class="sp-pg-conf-fill" style="width:${Math.round(conf*100)}%;background:${confColor}"></div></div>
      </div>
    </div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">latency</span><span class="sp-pg-val">${latency != null ? latency + 'ms' : '—'} ${goldenNote}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">tokens</span><span class="sp-pg-val">${tokens}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">model</span><span class="sp-pg-val">${esc(r.providerMetadata?.model ?? '—')}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">plannerVer</span><span class="sp-pg-val">${esc(r.providerMetadata?.plannerVersion ?? '—')}</span></div>
    ${r.plannerSummary ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.muted};font-size:10px;margin-bottom:3px">PLANNER SUMMARY</div>
    <div class="sp-pg-summary">${esc(r.plannerSummary)}</div>
    ` : ''}
    ${r.blockers?.length ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.red};font-size:10.5px">Blockers: ${r.blockers.map(b => esc(b)).join(', ')}</div>
    ` : ''}
    <div class="sp-pg-divider"></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="sp-pg-btn-sm" id="sp-pg-save-a-btn2">Save as A</button>
      <button class="sp-pg-btn-sm" id="sp-pg-save-b-btn2">Save as B</button>
    </div>
  `;

  // Re-bind compare buttons in planner section
  el.querySelector('#sp-pg-save-a-btn2')?.addEventListener('click', () => saveCompare('A'));
  el.querySelector('#sp-pg-save-b-btn2')?.addEventListener('click', () => saveCompare('B'));
}

function renderPlan() {
  const el = document.getElementById('sp-pg-plan-content');
  if (!el) return;
  const plan = S.plan;
  if (!plan) { el.innerHTML = '<span style="color:#858585">No plan yet.</span>'; return; }

  const steps = plan.steps ?? [];
  const rows  = steps.map((step, i) => {
    const isDone   = i < S.currentStepIdx;
    const isActive = i === S.currentStepIdx;
    const cls      = isDone ? 'done' : isActive ? 'active' : 'upcoming';
    const icon     = isDone ? `<span style="color:${C.green}">✓</span>`
                   : isActive ? `<span style="color:${C.orange}">▶</span>`
                   : `<span style="color:${C.muted}">${i + 1}</span>`;
    const tgtText  = step.targetElement?.text ? `"${esc(trunc(step.targetElement.text, 35))}"` : `<span style="color:${C.red}">(null)</span>`;
    return `
      <div class="sp-pg-step ${cls}">
        <span class="sp-pg-step-num">${icon}</span>
        <div class="sp-pg-step-body">
          <div class="sp-pg-step-desc">${esc(step.description)}</div>
          <div class="sp-pg-step-tgt">target: ${tgtText}
            <span class="sp-pg-tag">${esc(step.completionCondition)}</span>
          </div>
        </div>
        <button class="sp-pg-step-hl" data-step="${i}" title="Highlight this element">⊙</button>
      </div>
    `;
  }).join('');

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
      <span class="sp-pg-val">${steps.length} · step ${S.currentStepIdx + 1}/${steps.length} active</span>
    </div>
    <div class="sp-pg-divider"></div>
    <div class="sp-pg-steps">${rows}</div>
  `;

  // Bind highlight buttons
  el.querySelectorAll('.sp-pg-step-hl').forEach(btn => {
    btn.addEventListener('click', () => {
      const i    = parseInt(btn.dataset.step);
      const step = plan.steps[i];
      if (step) highlightStepElement(step);
    });
  });
}

function renderCurrentStep() {
  const el = document.getElementById('sp-pg-step-content');
  if (!el) return;

  const step = S.currentStep;
  if (!step) { el.innerHTML = '<span style="color:#858585">No active step.</span>'; return; }

  const tgt  = step.targetElement ?? {};
  const info = S.elementInfo;
  const val  = S.validatorInfo;

  const elHTML = info ? `
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.tag</span><span class="sp-pg-val">${esc(info.tag)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.score</span><span class="sp-pg-val" style="color:${info.score >= 80 ? C.green : info.score >= 60 ? C.yellow : C.red}">${info.score}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.match</span><span class="sp-pg-val">${esc(trunc(info.reason, 50))}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">el.html</span><span class="sp-pg-val" style="font-size:10px">${esc(trunc(info.outerHTML, 80))}</span></div>
  ` : `<div class="sp-pg-row"><span class="sp-pg-lbl">element</span><span class="sp-pg-val err">not resolved yet</span></div>`;

  const valHTML = val ? `
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">VALIDATOR</div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">verdict</span><span class="sp-pg-val ${val.verdict === 'PASSED' ? 'ok' : 'warn'}">${esc(val.verdict)}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">url</span><span class="sp-pg-val" style="font-size:10px">${esc(trunc(val.preUrl,28))} → ${esc(trunc(val.postUrl,28))}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">domHash</span><span class="sp-pg-val sp-pg-hash">${esc(val.preDom)} → ${esc(val.postDom)}</span></div>
  ` : '';

  const advBtn = (S.stepMode && S.advanceResolver) ? `
    <button class="sp-pg-advance-btn" id="sp-pg-advance-btn">Advance to next step →</button>
  ` : '';

  el.innerHTML = `
    <div class="sp-pg-row">
      <span class="sp-pg-lbl">step</span>
      <span class="sp-pg-val">${S.currentStepIdx + 1} / ${S.plan?.steps?.length ?? '?'} — ${esc(step.description)}</span>
    </div>
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">TARGET ELEMENT</div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">text</span><span class="sp-pg-val ${tgt.text ? '' : 'err'}">${tgt.text ? `"${esc(tgt.text)}"` : '(null — will fail)'}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">type</span><span class="sp-pg-val">${esc(tgt.type ?? '—')}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">region</span><span class="sp-pg-val">${esc(tgt.region ?? '—')}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">intent</span><span class="sp-pg-val">${esc(tgt.intent ?? '—')}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">alts</span><span class="sp-pg-val">${(tgt.alternatives ?? []).map(a => `"${esc(a)}"`).join(', ') || '—'}</span></div>
    <div class="sp-pg-row"><span class="sp-pg-lbl">completion</span><span class="sp-pg-val">${esc(step.completionCondition)}</span></div>
    <div class="sp-pg-divider"></div>
    <div style="color:${C.label};font-size:10.5px;margin-bottom:4px">RESOLVED ELEMENT</div>
    ${elHTML}
    ${valHTML}
    ${advBtn}
  `;

  if (S.stepMode && S.advanceResolver) {
    document.getElementById('sp-pg-advance-btn')?.addEventListener('click', () => {
      if (S.advanceResolver) { S.advanceResolver(); S.advanceResolver = null; renderCurrentStep(); }
    });
  }
}

function renderTimeline() {
  const el = document.getElementById('sp-pg-timeline-list');
  if (!el) return;
  const entries = S.timeline.slice(-60);  // keep last 60 entries visible
  el.innerHTML  = entries.map(e => {
    const color = STATE_COLOR[e.to] ?? C.muted;
    const meta  = Object.entries(e.meta ?? {}).map(([k,v]) => `${k}=${v}`).join(' ');
    return `
      <div class="sp-pg-tl-entry" style="border-left-color:${color}">
        <span class="sp-pg-tl-time">${esc(e.tsShort)}</span>
        <span class="sp-pg-tl-arrow">→</span>
        <div class="sp-pg-tl-event">
          <span style="color:${color}">${esc(e.to)}</span>
          <span style="color:${C.muted}"> (${esc(e.event)})</span>
          ${meta ? `<div class="sp-pg-tl-meta">${esc(meta)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderSnapshot() {
  const el = document.getElementById('sp-pg-snapshot-content');
  if (!el) return;
  const snap = S.snapshot;
  if (!snap) { el.innerHTML = '<span style="color:#858585">No snapshot. Click "⊙ Snapshot" to capture.</span>'; return; }

  const interactiveCount = document.querySelectorAll(
    'button,a,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[aria-label]'
  ).length;

  el.innerHTML = `
    <div class="sp-pg-snapshot-grid">
      <div><div class="sp-pg-lbl">url</div><div class="sp-pg-val" style="font-size:10px;word-break:break-all">${esc(snap.url)}</div></div>
      <div><div class="sp-pg-lbl">title</div><div class="sp-pg-val" style="font-size:10px">${esc(trunc(snap.title, 40))}</div></div>
      <div><div class="sp-pg-lbl">domHash</div><div class="sp-pg-hash">0x${(snap.domHash >>> 0).toString(16).toUpperCase().padStart(8, '0')}</div></div>
      <div><div class="sp-pg-lbl">captured</div><div class="sp-pg-val">${new Date(snap.capturedAt).toLocaleTimeString()}</div></div>
      <div><div class="sp-pg-lbl">interactive</div><div class="sp-pg-val">${interactiveCount} elements</div></div>
    </div>
  `;
}

function renderControls(running) {
  const runBtn    = document.getElementById('sp-pg-run-btn');
  const stopBtn   = document.getElementById('sp-pg-stop-btn');
  const replayBtn = document.getElementById('sp-pg-replay-btn');
  const saveABtn  = document.getElementById('sp-pg-save-a-btn');
  const saveBBtn  = document.getElementById('sp-pg-save-b-btn');
  if (!runBtn) return;
  runBtn.disabled    = running;
  stopBtn.disabled   = !running;
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

// ── Execution pipeline ────────────────────────────────────────────────────────

async function handleRun() {
  const input = document.getElementById('sp-pg-goal-input');
  const goal  = input?.value?.trim();
  if (!goal) { input?.focus(); return; }
  await runWorkflow(goal);
}

async function handleReplay() {
  if (S.goal) await runWorkflow(S.goal);
}

function handleStop() {
  S.executor?.abort();
  S.executor        = null;
  S.advanceResolver = null;
  S.taskState       = TaskState.IDLE;
  addLog({ type: 'stopped', ts: ts() });
  renderStateBar();
  renderControls(false);
}

async function handleSnapshot() {
  S.snapshot = capturePageSnapshot('');
  renderSnapshot();
  if (!S.sections.snapshot) {
    S.sections.snapshot = true;
    document.querySelector('[data-section="snapshot"]')?.nextElementSibling.classList.remove('hidden');
    document.querySelector('[data-section="snapshot"] .sp-pg-sh-arrow')?.classList.add('open');
  }
}

async function runWorkflow(goal) {
  if (S.executor) { S.executor.abort(); S.executor = null; }

  S.goal           = goal;
  S.taskState      = TaskState.IDLE;
  S.plan           = null;
  S.planResp       = null;
  S.timeline       = [];
  S.logs           = [];
  S.currentStep    = null;
  S.currentStepIdx = -1;
  S.elementInfo    = null;
  S.validatorInfo  = null;
  S.advanceResolver = null;

  renderControls(true);
  renderAll();
  applyEvent(TaskEvent.GOAL_SUBMITTED, { goal });

  // ── 1. Screenshot ──────────────────────────────────────────────────────────
  let screenshotImage, screenshotMime;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
    if (!resp?.success) throw new Error(resp?.error ?? 'Screenshot capture failed');
    screenshotImage = resp.image;
    screenshotMime  = resp.mimeType ?? 'image/png';
    addLog({ type: 'screenshot', imageLen: screenshotImage.length, mime: screenshotMime });
  } catch (err) {
    addLog({ type: 'screenshot_error', error: err.message });
    applyEvent(TaskEvent.PLAN_FAILED, { reason: 'screenshot_failed' });
    renderControls(false);
    return;
  }

  // ── 2. Plan ────────────────────────────────────────────────────────────────
  let planResp;
  if (S.goldenResp) {
    planResp = S.goldenResp;
    addLog({ type: 'golden_response_used', planId: planResp.plan?.planId });
  } else {
    const adapter = new VercelBackendAdapter();
    const t0      = Date.now();
    addLog({ type: 'planner_request', goal, url: window.location.href });
    try {
      planResp = await adapter.plan({
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
      addLog({ type: 'planner_response', latency: Date.now() - t0, result: planResp.result, state: planResp.state, planId: planResp.plan?.planId });
    } catch (err) {
      addLog({ type: 'planner_error', error: err.message });
      applyEvent(TaskEvent.PLAN_FAILED, { reason: 'network_error' });
      renderControls(false);
      return;
    }
  }

  S.planResp = planResp;

  if (planResp.result !== 'OK' || !planResp.plan) {
    applyEvent(TaskEvent.PLAN_FAILED, { result: planResp.result });
    renderControls(false);
    renderPlanner();
    return;
  }

  const plan = planResp.plan;
  S.plan           = plan;
  S.currentStepIdx = 0;
  applyEvent(TaskEvent.PLAN_RECEIVED, { planId: plan.planId, steps: plan.steps.length });
  renderPlanner();
  renderPlan();

  // ── 3. Executor ────────────────────────────────────────────────────────────
  if (!window.DOMMatcher) {
    addLog({ type: 'error', message: 'window.DOMMatcher missing — dom-matcher.js not loaded' });
    applyEvent(TaskEvent.PLAN_FAILED, { reason: 'no_dom_matcher' });
    renderControls(false);
    return;
  }

  const highlighter = window.__SP_Highlighter ?? makeFallbackHighlighter();
  const executor    = new ExecutorEngine({
    domMatcher:      window.DOMMatcher,
    highlighter,
    captureSnapshot: capturePageSnapshot,
  });
  S.executor = executor;

  // ── 4. Events ──────────────────────────────────────────────────────────────

  executor.on('element:ready', ({ step, element, snapshot }) => {
    const idx        = plan.steps.indexOf(step);
    S.currentStepIdx = idx;
    S.currentStep    = step;
    S.validatorInfo  = null;
    S.elementInfo    = {
      tag:       element?.tagName?.toLowerCase() ?? '?',
      score:     snapshot?.score ?? (S.plan && window.DOMMatcher ? resolveScore(step) : 0),
      reason:    snapshot?.reason ?? '—',
      outerHTML: element?.outerHTML?.slice(0, 120) ?? '—',
    };
    // Re-resolve score more accurately
    const match = window.DOMMatcher.matchElement(step.targetElement);
    if (match) S.elementInfo = { tag: element?.tagName?.toLowerCase() ?? '?', score: match.score, reason: match.reason, outerHTML: element?.outerHTML?.slice(0, 120) ?? '—' };

    applyEvent(TaskEvent.ELEMENT_READY, { step: `${idx + 1}/${plan.steps.length}`, target: step.targetElement?.text ?? '(null)' });
    addLog({ type: 'element_ready', stepIdx: idx, target: step.targetElement, elementTag: S.elementInfo.tag, score: S.elementInfo.score });
    renderPlan();
    renderCurrentStep();
  });

  executor.on('element:not_found', ({ step, reason, isOptional }) => {
    const idx = plan.steps.indexOf(step);
    addLog({ type: 'element_not_found', stepIdx: idx, reason, target: step.targetElement, isOptional });
    if (!isOptional) {
      applyEvent(TaskEvent.ELEMENT_NOT_FOUND, { step: idx + 1, reason });
    }
    S.currentStepIdx = idx;
    S.currentStep    = step;
    S.elementInfo    = null;
    renderPlan();
    renderCurrentStep();
  });

  executor.on('user:acted', async ({ step, trigger }) => {
    const idx        = plan.steps.indexOf(step);
    const isFinal    = idx === plan.steps.length - 1;
    applyEvent(TaskEvent.USER_ACTED, { step: idx + 1, trigger });
    addLog({ type: 'user_acted', stepIdx: idx, trigger });

    await new Promise(r => setTimeout(r, 800));

    const pre     = executor.getPreActionSnapshot();
    const post    = capturePageSnapshot('');
    S.snapshot    = post;
    const verdict = pre && post
      ? (post.url !== pre.url || post.domHash !== pre.domHash ? 'PASSED' : 'INCONCLUSIVE')
      : 'INCONCLUSIVE';

    S.validatorInfo = {
      verdict,
      preUrl:  pre?.url ?? '—',
      postUrl: post.url,
      preDom:  (pre?.domHash >>> 0).toString(16).toUpperCase().padStart(8,'0'),
      postDom: (post.domHash >>> 0).toString(16).toUpperCase().padStart(8,'0'),
    };
    addLog({ type: 'validation', verdict, stepIdx: idx, isFinal });

    if (isFinal) {
      applyEvent(TaskEvent.FINAL_STEP_COMPLETE, { verdict });
    } else {
      applyEvent(TaskEvent.VALIDATION_PASSED, { verdict });
    }
    renderCurrentStep();
    renderSnapshot();

    if (S.stepMode) {
      await new Promise(resolve => { S.advanceResolver = resolve; });
      renderCurrentStep();
    }

    executor.advance();
  });

  executor.on('step:skipped', ({ step }) => {
    const idx = plan.steps.indexOf(step);
    addLog({ type: 'step_skipped', stepIdx: idx });
    S.currentStepIdx = idx;
    renderPlan();
  });

  executor.on('plan:complete', ({ plan: completedPlan, completedAt }) => {
    const elapsed = completedAt - plan.createdAt;
    addLog({ type: 'plan_complete', planId: completedPlan.planId, elapsed, finalState: S.taskState });
    S.executor = null;
    renderPlan();
    renderControls(false);
    renderStateBar();
  });

  // ── 5. Start ───────────────────────────────────────────────────────────────
  addLog({ type: 'executor_start', planId: plan.planId });
  executor.start(plan);
}

function resolveScore(step) {
  const match = window.DOMMatcher?.matchElement(step.targetElement);
  return match?.score ?? 0;
}

function highlightStepElement(step) {
  const match = window.DOMMatcher?.matchElement(step.targetElement);
  if (!match?.element) {
    addLog({ type: 'highlight_debug', target: step.targetElement, result: 'not_found' });
    return;
  }
  const hl = window.__SP_Highlighter ?? makeFallbackHighlighter();
  hl.show(match.element, `[Playground] ${step.description}`);
  addLog({ type: 'highlight_debug', target: step.targetElement, score: match.score, reason: match.reason });
}

function makeFallbackHighlighter() {
  let _el = null;
  return {
    async show(element, text) {
      if (_el) { _el.style.outline = ''; }
      if (!element) return false;
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.style.outline = '3px solid #4ec9b0';
      _el = element;
      return true;
    },
    clear() { if (_el) { _el.style.outline = ''; _el = null; } },
  };
}

// ── Features ──────────────────────────────────────────────────────────────────

function exportLogs() {
  const payload = {
    exportedAt:   ts(),
    goal:         S.goal,
    planId:       S.plan?.planId ?? null,
    finalState:   S.taskState,
    planResponse: S.planResp,
    timeline:     S.timeline,
    logs:         S.logs,
  };
  downloadJSON(payload, `sp-playground-${Date.now()}.json`);
  addLog({ type: 'export', ts: ts() });
}

function loadGolden() {
  const textarea = document.getElementById('sp-pg-golden-input');
  if (!textarea?.value?.trim()) return;
  try {
    const parsed = JSON.parse(textarea.value.trim());
    if (!parsed.plan || !parsed.result) throw new Error('Missing plan or result field');
    S.goldenResp = parsed;
    document.getElementById('sp-pg-golden-badge').style.display = 'inline-block';
    addLog({ type: 'golden_loaded', planId: parsed.plan?.planId });
  } catch (err) {
    alert(`Invalid PlanResponse JSON: ${err.message}`);
  }
}

function clearGolden() {
  S.goldenResp = null;
  document.getElementById('sp-pg-golden-input').value = '';
  document.getElementById('sp-pg-golden-badge').style.display = 'none';
  addLog({ type: 'golden_cleared' });
}

function saveCompare(slot) {
  if (!S.planResp) return;
  if (slot === 'A') S.savedA = { resp: S.planResp, goal: S.goal };
  else              S.savedB = { resp: S.planResp, goal: S.goal };

  const statusEl   = document.getElementById('sp-pg-compare-status');
  const compareBtn = document.getElementById('sp-pg-compare-btn');
  if (statusEl) statusEl.textContent = `A: ${S.savedA?.goal ?? '—'}   B: ${S.savedB?.goal ?? '—'}`;
  if (compareBtn) compareBtn.disabled = !(S.savedA && S.savedB);
  addLog({ type: 'compare_saved', slot, planId: S.planResp.plan?.planId });
}

function openCompare() {
  if (!S.savedA || !S.savedB) return;
  const existing = document.getElementById('sp-pg-compare-panel');
  if (existing) existing.remove();

  const panel     = document.createElement('div');
  panel.id        = 'sp-pg-compare-panel';
  panel.className = 'sp-pg-compare-panel';

  const stepsA = S.savedA.resp.plan?.steps ?? [];
  const stepsB = S.savedB.resp.plan?.steps ?? [];
  const maxLen = Math.max(stepsA.length, stepsB.length);

  const stepRows = Array.from({ length: maxLen }, (_, i) => {
    const sA = stepsA[i];
    const sB = stepsB[i];
    const diffClass = !sA ? 'sp-pg-step-diff-add' : !sB ? 'sp-pg-step-diff-rem'
      : sA.description === sB.description ? '' : 'sp-pg-step-diff-chg';
    return `
      <div style="display:flex;gap:16px;margin-bottom:8px;border-bottom:1px solid #2d2d30;padding-bottom:8px">
        <div style="flex:1;color:${C.text}" class="${diffClass}">
          ${sA ? `<b style="color:${C.muted}">${i+1}.</b> ${esc(sA.description)}<br><span style="color:${C.muted};font-size:10px">→ "${esc(sA.targetElement?.text ?? '(null)')}"</span>` : '<span style="color:#858585">—</span>'}
        </div>
        <div style="flex:1;color:${C.text}" class="${diffClass}">
          ${sB ? `<b style="color:${C.muted}">${i+1}.</b> ${esc(sB.description)}<br><span style="color:${C.muted};font-size:10px">→ "${esc(sB.targetElement?.text ?? '(null)')}"</span>` : '<span style="color:#858585">—</span>'}
        </div>
      </div>
    `;
  }).join('');

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="color:${C.teal};font-size:14px;font-weight:bold">Plan Comparison</span>
      <button class="sp-pg-hbtn" id="sp-pg-compare-close">✕ Close</button>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:12px">
      <div style="flex:1">
        <div style="color:${C.label};font-size:11px;margin-bottom:4px">PLAN A</div>
        <div style="color:${C.text}">${esc(S.savedA.goal)}</div>
        <div style="color:${C.muted};font-size:10px">conf: ${S.savedA.resp.confidence?.toFixed(2)} · ${stepsA.length} steps · ${S.savedA.resp.providerMetadata?.latencyMs}ms</div>
        <div style="color:${C.text};font-style:italic;font-size:10.5px;margin-top:4px">${esc(S.savedA.resp.plannerSummary ?? '')}</div>
      </div>
      <div style="width:1px;background:${C.border}"></div>
      <div style="flex:1">
        <div style="color:${C.label};font-size:11px;margin-bottom:4px">PLAN B</div>
        <div style="color:${C.text}">${esc(S.savedB.goal)}</div>
        <div style="color:${C.muted};font-size:10px">conf: ${S.savedB.resp.confidence?.toFixed(2)} · ${stepsB.length} steps · ${S.savedB.resp.providerMetadata?.latencyMs}ms</div>
        <div style="color:${C.text};font-style:italic;font-size:10.5px;margin-top:4px">${esc(S.savedB.resp.plannerSummary ?? '')}</div>
      </div>
    </div>
    <div style="color:${C.label};font-size:11px;margin-bottom:8px;border-bottom:1px solid ${C.border};padding-bottom:4px">STEPS</div>
    <div style="display:flex;gap:8px;margin-bottom:4px">
      <div style="flex:1;color:${C.muted};font-size:10px">Plan A (${stepsA.length} steps)</div>
      <div style="flex:1;color:${C.muted};font-size:10px">Plan B (${stepsB.length} steps)</div>
    </div>
    ${stepRows}
    <div style="color:${C.muted};font-size:10px;margin-top:12px">
      <span style="color:${C.yellow}">■</span> changed &nbsp;
      <span style="color:${C.green}">■</span> added (B only) &nbsp;
      <span style="color:${C.red}">■</span> removed (A only)
    </div>
  `;

  document.body.appendChild(panel);
  document.getElementById('sp-pg-compare-close')?.addEventListener('click', () => panel.remove());
}

// ── Panel show/hide ───────────────────────────────────────────────────────────

let _panel = null;

function open() {
  injectStyles();
  if (!_panel) _panel = createPanel();
  _panel.classList.remove('sp-pg-hidden');
  S.visible = true;
  renderAll();
}

function close() {
  _panel?.classList.add('sp-pg-hidden');
  S.visible = false;
}

function toggle() {
  S.visible ? close() : open();
}

// ── Init ─────────────────────────────────────────────────────────────────────

const Playground = { open, close, toggle };
window.__SP_PLAYGROUND = Playground;

console.log('[SP:Playground] Ready — __SP_PLAYGROUND.open() to launch');
