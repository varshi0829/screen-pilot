// ScreenPilot - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  // ── Tab switching ────────────────────────────────────────────────────────────
  document.querySelectorAll('.sp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.sp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
      document.querySelectorAll('.sp-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${target}`));
      if (target === 'analytics') loadAnalytics();
    });
  });

  // ── Launch tab ───────────────────────────────────────────────────────────────
  const openBtn  = document.getElementById('openWidget');
  const statusEl = document.getElementById('status');

  openBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found');

      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') ||
          tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
        statusEl.textContent = 'ScreenPilot cannot run on browser internal pages';
        statusEl.className = 'status error';
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
        window.close();
        return;
      } catch {
        // Content script not present — fall through to inject
      }

      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/dom-matcher.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/widget.css'] });
      await new Promise(resolve => setTimeout(resolve, 150));
      await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
      window.close();
    } catch (error) {
      statusEl.textContent = 'Could not open ScreenPilot: ' + error.message;
      statusEl.className = 'status error';
    }
  });

  // ── Analytics tab ────────────────────────────────────────────────────────────
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
    setKPI('kpi-plan-success',    kpis.planSuccessRate,    pct, 0.6, 0.4, false);
    setKPI('kpi-cache-hit',       kpis.cacheHitRate,       pct, 0.3, 0.1, false);
    setKPI('kpi-gemini-per-task', kpis.geminiCallsPerTask, num, 2,   4,   true);
    setKPI('kpi-completion',      kpis.taskCompletionRate, pct, 0.7, 0.4, false);
  }

  // Sets a KPI cell. lowerIsBetter reverses the good/warn colour logic.
  function setKPI(id, value, fmt, goodThreshold, warnThreshold, lowerIsBetter) {
    const el = document.getElementById(id);
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
      const geminiLabel = `${t.geminiCalls}G`;
      const planLabel   = t.planGenerated
        ? ` · ${t.planStepsSucceeded}/${t.planStepsAttempted}p`
        : '';
      return `
        <div class="sp-task-row">
          <div class="sp-task-dot ${t.completionStatus}"></div>
          <div class="sp-task-goal" title="${escHtml(t.goal)}">${escHtml(t.goal)}</div>
          <div class="sp-task-meta">${geminiLabel}${planLabel}</div>
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
});
