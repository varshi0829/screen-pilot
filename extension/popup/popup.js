// ScreenPilot - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_BACKEND_URL = 'https://screen-pilot-j1az.vercel.app/api/analyze';

  // ── Tab switching ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.sp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.sp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
      document.querySelectorAll('.sp-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${target}`));
      if (target === 'analytics')  loadAnalytics();
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

      console.log('[SP:LAUNCH] sending START_V2_TASK via background');
      const resp = await chrome.runtime.sendMessage({ type: 'START_V2_TASK', tabId: tab.id });
      if (!resp?.success) throw new Error(resp?.error || 'Could not open ScreenPilot');
      console.log('[SP:LAUNCH] overlay opened — closing popup');
      window.close();
    } catch (error) {
      console.error('[SP:LAUNCH] ERROR:', error.message, error);
      statusEl.textContent = 'ScreenPilot needs to activate on this page first. Press Ctrl+R (Cmd+R on Mac) to reload, then click Open ScreenPilot again.';
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
    const { openRouterApiKey, screenPilotBackendUrl } = await chrome.storage.local.get(['openRouterApiKey', 'screenPilotBackendUrl']);
    const statusEl = document.getElementById('key-status');
    const inputEl  = document.getElementById('openrouter-key-input');
    if (openRouterApiKey) {
      inputEl.placeholder = '••••••••' + openRouterApiKey.slice(-4);
      statusEl.textContent = 'Your key is active — using your own OpenRouter quota';
      statusEl.className = 'sp-key-status saved';
    } else {
      inputEl.placeholder = 'sk-or-...';
      statusEl.textContent = 'No key set — using shared quota (may hit limits)';
      statusEl.className = 'sp-key-status';
    }

    const backendInput = document.getElementById('backend-url-input');
    const backendStatus = document.getElementById('backend-status');
    if (screenPilotBackendUrl) {
      backendInput.value = screenPilotBackendUrl;
      backendStatus.textContent = 'Using configured backend URL';
      backendStatus.className = 'sp-key-status saved';
    } else {
      backendInput.value = '';
      backendInput.placeholder = DEFAULT_BACKEND_URL;
      backendStatus.textContent = 'Using the deployed backend URL by default';
      backendStatus.className = 'sp-key-status';
    }
  }

  document.getElementById('save-key-btn').addEventListener('click', async () => {
    const inputEl  = document.getElementById('openrouter-key-input');
    const statusEl = document.getElementById('key-status');
    const key = inputEl.value.trim();
    if (!key) {
      statusEl.textContent = 'Paste a key first.';
      statusEl.className = 'sp-key-status error';
      return;
    }
    await chrome.storage.local.set({ openRouterApiKey: key });
    inputEl.value = '';
    inputEl.placeholder = '••••••••' + key.slice(-4);
    statusEl.textContent = 'Key saved — using your own OpenRouter quota';
    statusEl.className = 'sp-key-status saved';
  });

  document.getElementById('clear-key-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove('openRouterApiKey');
    const inputEl  = document.getElementById('openrouter-key-input');
    const statusEl = document.getElementById('key-status');
    inputEl.value = '';
    inputEl.placeholder = 'sk-or-...';
    statusEl.textContent = 'Key cleared — using shared quota';
    statusEl.className = 'sp-key-status';
  });

  document.getElementById('save-backend-btn').addEventListener('click', async () => {
    const inputEl = document.getElementById('backend-url-input');
    const statusEl = document.getElementById('backend-status');
    const value = inputEl.value.trim();
    if (!value) {
      await chrome.storage.local.remove('screenPilotBackendUrl');
      inputEl.placeholder = DEFAULT_BACKEND_URL;
      statusEl.textContent = 'Backend URL cleared — using deployed default';
      statusEl.className = 'sp-key-status';
      return;
    }
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) throw new Error('Backend URL must use http or https');
      await chrome.storage.local.set({ screenPilotBackendUrl: url.toString().replace(/\/$/, '') });
      statusEl.textContent = 'Backend URL saved';
      statusEl.className = 'sp-key-status saved';
    } catch {
      statusEl.textContent = 'Enter a valid http(s) URL';
      statusEl.className = 'sp-key-status error';
    }
  });

  document.getElementById('clear-backend-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove('screenPilotBackendUrl');
    const inputEl = document.getElementById('backend-url-input');
    const statusEl = document.getElementById('backend-status');
    inputEl.value = '';
    inputEl.placeholder = DEFAULT_BACKEND_URL;
    statusEl.textContent = 'Backend URL cleared — using deployed default';
    statusEl.className = 'sp-key-status';
  });
});
