// ScreenPilot - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  // ── Tab switching ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.sp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.sp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
      document.querySelectorAll('.sp-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${target}`));
      if (target === 'analytics')  loadAnalytics();
      if (target === 'validation') loadValidation();
      if (target === 'settings')   loadSettings();
    });
  });

  // ── Launch tab ────────────────────────────────────────────────────────────────
  const openBtn  = document.getElementById('openWidget');
  const statusEl = document.getElementById('status');

  openBtn.addEventListener('click', async () => {
    console.log('[SP:LAUNCH] button clicked');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log(`[SP:LAUNCH] tab id=${tab?.id} url=${tab?.url}`);
      if (!tab?.id) throw new Error('No active tab found');

      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') ||
          tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
        statusEl.textContent = 'ScreenPilot cannot run on browser internal pages';
        statusEl.className = 'status error';
        return;
      }

      // PATH A: content script already injected by manifest — send OPEN_WIDGET directly
      console.log('[SP:LAUNCH] PATH A: attempting sendMessage to existing content script');
      try {
        const respA = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
        console.log('[SP:LAUNCH] PATH A: sendMessage OK, response=', respA, '— closing popup');
        window.close();
        return;
      } catch (innerErr) {
        console.warn('[SP:LAUNCH] PATH A: sendMessage failed:', innerErr.message, '— proceeding to PATH B');
      }

      // PATH B: content script not present — inject all scripts manually
      console.log('[SP:LAUNCH] PATH B: injecting scripts');
      console.log('[SP:LAUNCH]   → enterprise-context-service.js');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['services/enterprise-context-service.js'] });
      console.log('[SP:LAUNCH]   → lib/dom-matcher.js');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/dom-matcher.js'] });
      console.log('[SP:LAUNCH]   → content.js');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      console.log('[SP:LAUNCH]   → widget.css');
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/widget.css'] });
      console.log('[SP:LAUNCH] PATH B: all scripts injected, waiting 150ms');
      await new Promise(resolve => setTimeout(resolve, 150));
      console.log('[SP:LAUNCH] PATH B: sending OPEN_WIDGET');
      const respB = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
      console.log('[SP:LAUNCH] PATH B: sendMessage OK, response=', respB, '— closing popup');
      window.close();
    } catch (error) {
      console.error('[SP:LAUNCH] OUTER ERROR:', error.message, error);
      statusEl.textContent = 'Could not open ScreenPilot: ' + error.message;
      statusEl.className = 'status error';
    }
  });

  // ── Analytics tab ─────────────────────────────────────────────────────────────
  document.getElementById('clearAnalytics').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_ANALYTICS' });
    loadAnalytics();
  });

  async function loadAnalytics() {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ANALYTICS' }).catch(() => null);
    if (!res?.success) return;
    renderKPIs(res.analytics.kpis);
    renderTasks(res.analytics.tasks);
  }

  function renderKPIs(kpis) {
    // Row 1 — Core navigation efficiency
    setKPI('kpi-plan-success',    kpis.planSuccessRate,      pct, 0.6,  0.4,  false);
    setKPI('kpi-cache-hit',       kpis.cacheHitRate,         pct, 0.3,  0.1,  false);
    setKPI('kpi-gemini-per-task', kpis.geminiCallsPerTask,   num, 2,    4,    true);
    setKPI('kpi-completion',      kpis.taskCompletionRate,   pct, 0.7,  0.4,  false);

    // Row 2 — Enterprise intelligence & cost avoidance
    setKPI('kpi-gemini-avoided',  kpis.geminiAvoidanceRate,  pct, 0.4,  0.15, false);
    setKPI('kpi-recovery',        kpis.recoverySuccessRate,  pct, 0.6,  0.3,  false);
    setKPI('kpi-enterprise',      kpis.enterpriseDetectionRate, pct, 0.5, 0.2, false);
    setKPI('kpi-memory-hit',      kpis.memoryHitRate,        pct, 0.2,  0.05, false);
  }

  // Colours a KPI cell. lowerIsBetter reverses the good/warn logic.
  function setKPI(id, value, fmt, goodThreshold, warnThreshold, lowerIsBetter) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value === null || value === undefined) {
      el.textContent = '—';
      el.className = 'sp-kpi-value empty';
      return;
    }
    el.textContent = fmt(value);
    const isGood = lowerIsBetter ? value <= goodThreshold : value >= goodThreshold;
    const isBad  = lowerIsBetter ? value > warnThreshold  : value < warnThreshold;
    el.className = 'sp-kpi-value' + (isGood ? ' good' : isBad ? ' warn' : '');
  }

  function renderTasks(tasks) {
    const list = document.getElementById('tasksList');
    if (!tasks.length) {
      list.innerHTML = '<div class="sp-no-data">No tasks recorded yet</div>';
      return;
    }
    const recent = [...tasks].reverse().slice(0, 20);
    list.innerHTML = recent.map(t => {
      const geminiLabel   = `${t.geminiCalls}G`;
      const planLabel     = t.planGenerated ? ` · ${t.planStepsSucceeded}/${t.planStepsAttempted}p` : '';
      const memoryBadge   = t.memoryHit  ? ' · M' : '';
      const entBadge      = t.enterpriseApp ? ` · ${escHtml(t.enterpriseApp.slice(0, 8))}` : '';
      return `
        <div class="sp-task-row">
          <div class="sp-task-dot ${t.completionStatus}"></div>
          <div class="sp-task-goal" title="${escHtml(t.goal)}">${escHtml(t.goal)}</div>
          <div class="sp-task-meta">${geminiLabel}${planLabel}${memoryBadge}${entBadge}</div>
        </div>`;
    }).join('');
  }

  function pct(v) { return Math.round(v * 100) + '%'; }
  function num(v) { return Number(v).toFixed(1); }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Settings tab ──────────────────────────────────────────────────────────────
  async function loadSettings() {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    const statusEl = document.getElementById('key-status');
    const inputEl  = document.getElementById('gemini-key-input');
    if (geminiApiKey) {
      inputEl.placeholder = '••••••••' + geminiApiKey.slice(-4);
      statusEl.textContent = 'Your key is active — using your own Gemini quota';
      statusEl.className = 'sp-key-status saved';
    } else {
      inputEl.placeholder = 'AIza...';
      statusEl.textContent = 'No key set — using shared quota (may hit limits)';
      statusEl.className = 'sp-key-status';
    }
  }

  document.getElementById('save-key-btn').addEventListener('click', async () => {
    const inputEl  = document.getElementById('gemini-key-input');
    const statusEl = document.getElementById('key-status');
    const key = inputEl.value.trim();
    if (!key) {
      statusEl.textContent = 'Paste a key first.';
      statusEl.className = 'sp-key-status error';
      return;
    }
    await chrome.storage.local.set({ geminiApiKey: key });
    inputEl.value = '';
    inputEl.placeholder = '••••••••' + key.slice(-4);
    statusEl.textContent = 'Key saved — using your own Gemini quota';
    statusEl.className = 'sp-key-status saved';
  });

  document.getElementById('clear-key-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove('geminiApiKey');
    const inputEl  = document.getElementById('gemini-key-input');
    const statusEl = document.getElementById('key-status');
    inputEl.value = '';
    inputEl.placeholder = 'AIza...';
    statusEl.textContent = 'Key cleared — using shared quota';
    statusEl.className = 'sp-key-status';
  });
});
