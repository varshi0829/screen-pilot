// ScreenPilot - Validation Service
// Manages validation runs alongside TelemetryService — captures richer per-step
// event timelines and generates readiness reports with root-cause analysis.
//
// Relationship to TelemetryService:
//   TelemetryService: aggregate KPIs, rolling 100-task history, analytics popup
//   ValidationService: per-step event log, root-cause analysis, readiness score
//
// Storage: chrome.storage.local → 'screenpilot_validation'
// Max history: 50 validation runs (FIFO eviction)

export const ValidationService = (() => {
  'use strict';

  const STORAGE_KEY = 'screenpilot_validation';
  const MAX_RUNS    = 50;
  const MAX_EVENTS  = 50; // events kept per run in storage

  // ─── BENCHMARK LIBRARY ────────────────────────────────────────────────────────
  // Goal templates the user can inject via the Validation popup tab.
  // category: 'generic' runs on any page; 'enterprise' requires the named app.

  const BENCHMARK_LIBRARY = [
    // Generic — work on any web application
    { id: 'gen-search',   name: 'Search for Content',      goal: 'Search for "test" using the search bar or search input',        category: 'generic',    difficulty: 'easy',   hint: 'Any page with a search input field' },
    { id: 'gen-settings', name: 'Open Settings',           goal: 'Navigate to the settings or configuration page',                category: 'generic',    difficulty: 'easy',   hint: 'Any app with a settings link or menu' },
    { id: 'gen-create',   name: 'Create New Item',         goal: 'Create a new item or record on this page',                      category: 'generic',    difficulty: 'medium', hint: 'Apps with a New / Create / Add button' },
    { id: 'gen-profile',  name: 'Open User Profile',       goal: 'Open the user profile or account settings',                     category: 'generic',    difficulty: 'easy',   hint: 'Any app with a user avatar or profile menu' },
    { id: 'gen-filter',   name: 'Apply a Filter',          goal: 'Apply a filter to the list or table on this page',              category: 'generic',    difficulty: 'medium', hint: 'Pages with filterable lists or data grids' },
    { id: 'gen-save',     name: 'Save a Form',             goal: 'Save or submit the form currently visible',                     category: 'generic',    difficulty: 'medium', hint: 'Any page with a visible form and Save/Submit button' },
    // Enterprise — require the named app
    { id: 'jira-issue',   name: 'Jira: Create Issue',      goal: 'Create a new bug issue in Jira',                                category: 'enterprise', difficulty: 'medium', app: 'Jira',          hint: 'Requires Jira project board' },
    { id: 'jira-move',    name: 'Jira: Move to In Progress', goal: 'Move the first open issue to In Progress in Jira',            category: 'enterprise', difficulty: 'medium', app: 'Jira',          hint: 'Requires Jira board with backlog issues' },
    { id: 'sfdc-contact', name: 'Salesforce: New Contact', goal: 'Create a new contact record in Salesforce',                     category: 'enterprise', difficulty: 'medium', app: 'Salesforce',    hint: 'Requires Salesforce CRM with Contacts module' },
    { id: 'snow-incident',name: 'ServiceNow: New Incident',goal: 'Create a new incident ticket in ServiceNow',                    category: 'enterprise', difficulty: 'hard',   app: 'ServiceNow',    hint: 'Requires ServiceNow ITSM access' },
    { id: 'ado-workitem', name: 'Azure DevOps: Work Item', goal: 'Create a new work item or task in Azure DevOps',                category: 'enterprise', difficulty: 'medium', app: 'Azure DevOps',  hint: 'Requires Azure DevOps project board' },
    { id: 'confluence-page', name: 'Confluence: New Page', goal: 'Create a new page in the current Confluence space',             category: 'enterprise', difficulty: 'easy',   app: 'Confluence',    hint: 'Requires Confluence with a space open' },
    { id: 'workday-profile', name: 'Workday: View Profile',goal: 'Navigate to the personal profile or employee self-service page in Workday', category: 'enterprise', difficulty: 'easy', app: 'Workday', hint: 'Requires Workday access' },
  ];

  // Active run accumulator (in-process only; does not require storage reads to update)
  let _activeRun = null;

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * Begin tracking a new validation run. Call when a task starts.
   */
  function startRun(taskId, goal, { benchmarkId = null, url = '' } = {}) {
    _activeRun = {
      id:                Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      taskId,
      benchmarkId,
      goal:              String(goal).slice(0, 200),
      url:               String(url).slice(0, 200),
      startedAt:         Date.now(),
      completedAt:       null,
      durationMs:        null,
      status:            'running',
      // Metric counters
      geminiCalls:       0,
      geminiTotalMs:     0,
      planStepsTotal:    0,
      planStepsAttempted:0,
      planStepsSucceeded:0,
      planStepsFailed:   0,
      recoveryAttempts:  0,
      recoverySuccesses: 0,
      fromMemory:        false,
      cacheHit:          false,
      enterpriseDetected:false,
      enterpriseApp:     null,
      // Failure diagnostics
      failureReason:     null,
      lastFailedStep:    null,
      lastDomScore:      null,
      lastRecoveryTier:  null,
      // Event timeline (capped at MAX_EVENTS in storage)
      events: [],
    };
    return _activeRun;
  }

  /**
   * Record a significant event during the active run.
   * Updates metric counters automatically based on event type.
   *
   * @param {string} type - Event type (see EVENT TYPES below)
   * @param {object} data - Event payload
   *
   * EVENT TYPES:
   *   GEMINI_CALL          { mode }
   *   GEMINI_RESPONSE      { latencyMs, success }
   *   PLAN_GENERATED       { stepCount }
   *   PLAN_STEP_PRIMARY    { stepIndex, score, description }
   *   PLAN_STEP_RECOVERY_1 { stepIndex, score, description }
   *   PLAN_STEP_RECOVERY_2 { stepIndex, score, description }
   *   PLAN_STEP_FAILED     { stepIndex, score, description, recoveryTier }
   *   MEMORY_HIT           { confidence, matchType }
   *   CACHE_HIT            {}
   *   ENTERPRISE_CONTEXT   { application, module, confidence }
   *   TASK_END             { status, reason }
   */
  function recordEvent(type, data = {}) {
    if (!_activeRun) return;

    const event = { ts: Date.now() - _activeRun.startedAt, type, data };
    _activeRun.events.push(event);
    if (_activeRun.events.length > MAX_EVENTS) _activeRun.events.shift();

    // Update counters
    switch (type) {
      case 'GEMINI_CALL':
        _activeRun.geminiCalls++;
        break;
      case 'GEMINI_RESPONSE':
        if (data.latencyMs > 0) _activeRun.geminiTotalMs += data.latencyMs;
        break;
      case 'PLAN_GENERATED':
        _activeRun.planStepsTotal = data.stepCount || 0;
        break;
      case 'PLAN_STEP_PRIMARY':
        _activeRun.planStepsAttempted++;
        _activeRun.planStepsSucceeded++;
        break;
      case 'PLAN_STEP_RECOVERY_1':
      case 'PLAN_STEP_RECOVERY_2':
        _activeRun.planStepsAttempted++;
        _activeRun.planStepsSucceeded++;
        _activeRun.recoveryAttempts++;
        _activeRun.recoverySuccesses++;
        break;
      case 'PLAN_STEP_FAILED':
        _activeRun.planStepsAttempted++;
        _activeRun.planStepsFailed++;
        _activeRun.lastFailedStep    = String(data.description || '').slice(0, 100);
        _activeRun.lastDomScore      = data.score ?? null;
        _activeRun.lastRecoveryTier  = data.recoveryTier || 'none';
        break;
      case 'MEMORY_HIT':
        _activeRun.fromMemory = true;
        break;
      case 'CACHE_HIT':
        _activeRun.cacheHit = true;
        break;
      case 'ENTERPRISE_CONTEXT':
        _activeRun.enterpriseDetected = !!(data.application);
        _activeRun.enterpriseApp      = data.application || null;
        break;
    }
  }

  /**
   * Finalize the active run and persist it.
   * @param {'completed'|'failed'|'aborted'} status
   * @param {string} reason
   */
  async function endRun(status, reason = '') {
    if (!_activeRun) return null;

    _activeRun.completedAt  = Date.now();
    _activeRun.durationMs   = _activeRun.completedAt - _activeRun.startedAt;
    _activeRun.status       = status === 'completed' ? 'passed'
      : status === 'aborted' ? 'aborted' : 'failed';
    if (reason) _activeRun.failureReason = String(reason).slice(0, 200);

    // Trim event list before persisting
    const run = { ..._activeRun, events: _activeRun.events.slice(-20) };
    _activeRun = null;

    await _persistRun(run);
    return run;
  }

  function getActiveRun() { return _activeRun; }

  function getBenchmarks() { return BENCHMARK_LIBRARY; }

  /**
   * Generate a full validation report from persisted runs.
   */
  async function generateReport() {
    const stored  = await chrome.storage.local.get(STORAGE_KEY);
    const data    = stored[STORAGE_KEY] || { runs: [] };
    const runs    = (data.runs || []).filter(r => r.status !== 'running');

    if (!runs.length) {
      return { error: 'No completed validation runs yet. Run tasks via the Validation tab first.' };
    }

    const passed    = runs.filter(r => r.status === 'passed');
    const failed    = runs.filter(r => r.status === 'failed');
    const aborted   = runs.filter(r => r.status === 'aborted');
    const metrics   = _calculateMetrics(runs);
    const score     = calculateReadinessScore(metrics);
    const failures  = analyzeFailures(failed);

    return {
      generatedAt:    Date.now(),
      totalRuns:      runs.length,
      passedRuns:     passed.length,
      failedRuns:     failed.length,
      abortedRuns:    aborted.length,
      metrics,
      readinessScore: score.value,
      readinessLabel: score.label,
      readinessColor: score.color,
      breakdown:      score.breakdown,
      failures,
      recentRuns:     runs.slice(-10).reverse().map(r => ({
        id: r.id, goal: r.goal, status: r.status,
        geminiCalls: r.geminiCalls, durationMs: r.durationMs,
        fromMemory: r.fromMemory, enterpriseApp: r.enterpriseApp,
      })),
    };
  }

  /**
   * Calculate a 0–100 readiness score from aggregate metrics.
   * Returns {value, label, color, breakdown}.
   */
  function calculateReadinessScore(metrics) {
    const nav      = metrics.navigationSuccessRate ?? 0;
    const plan     = metrics.planSuccessRate       ?? 0;
    const efficiency = metrics.geminiEfficiency    ?? 0;
    const recovery = metrics.recoverySuccessRate   ?? 1; // default 1.0 when no recovery needed
    const enterprise = typeof metrics.enterpriseDetectionRate === 'number'
      ? metrics.enterpriseDetectionRate : null;

    // Weights sum to 100; enterprise weight only applied when enterprise runs exist
    const entWeight = enterprise !== null ? 10 : 0;
    const base      = (nav * 30) + (plan * 25) + (efficiency * 20) + (recovery * 15);
    const entBonus  = enterprise !== null ? enterprise * 10 : 0;
    const totalW    = 90 + entWeight;
    const value     = Math.round((base + entBonus) / totalW * 100);

    const label = value >= 85 ? 'Production Ready'
      : value >= 65 ? 'Mostly Ready'
      : value >= 40 ? 'Needs Improvement'
      : 'Not Ready';
    const color = value >= 85 ? 'green' : value >= 65 ? 'amber' : value >= 40 ? 'orange' : 'red';

    const breakdown = {
      'Task Completion':     { score: Math.round(nav * 30),        max: 30, pct: nav },
      'Plan Execution':      { score: Math.round(plan * 25),       max: 25, pct: plan },
      'Gemini Efficiency':   { score: Math.round(efficiency * 20), max: 20, pct: efficiency },
      'Recovery Rate':       { score: Math.round(recovery * 15),   max: 15, pct: recovery },
      'Enterprise Detection':{ score: Math.round(entBonus),        max: entWeight, pct: enterprise },
    };

    return { value, label, color, breakdown };
  }

  /**
   * Produce structured root-cause analysis for failed runs.
   */
  function analyzeFailures(failedRuns) {
    return failedRuns.map(run => ({
      goal:           run.goal,
      url:            run.url,
      failureReason:  run.failureReason || 'Unknown',
      lastFailedStep: run.lastFailedStep,
      domScore:       run.lastDomScore,
      recoveryTier:   run.lastRecoveryTier,
      geminiCalls:    run.geminiCalls,
      rootCause:      _inferRootCause(run),
      fix:            _suggestFix(run),
    }));
  }

  /** Delete all validation history. */
  async function clear() {
    _activeRun = null;
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────────

  function _calculateMetrics(runs) {
    if (!runs.length) return {};
    const _sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const finished = runs.filter(r => r.status !== 'running');
    if (!finished.length) return {};

    const passed          = finished.filter(r => r.status === 'passed');
    const totalAttempted  = _sum(finished, 'planStepsAttempted');
    const totalSucceeded  = _sum(finished, 'planStepsSucceeded');
    const totalRecovAtt   = _sum(finished, 'recoveryAttempts');
    const totalRecovSuc   = _sum(finished, 'recoverySuccesses');
    const totalGemini     = _sum(finished, 'geminiCalls');
    const entRuns         = finished.filter(r => r.enterpriseDetected);
    const memRuns         = finished.filter(r => r.fromMemory);
    const avgGemini       = finished.length ? totalGemini / finished.length : 0;
    const durations       = passed.map(r => r.durationMs).filter(d => d > 0);

    return {
      navigationSuccessRate:   finished.length ? passed.length / finished.length : null,
      planSuccessRate:          totalAttempted  ? totalSucceeded / totalAttempted  : null,
      recoverySuccessRate:      totalRecovAtt   ? totalRecovSuc  / totalRecovAtt   : null,
      geminiEfficiency:         Math.max(0, 1 - (avgGemini - 1) / 4),
      avgGeminiCalls:           avgGemini,
      avgDurationMs:            durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      memoryHitRate:            finished.length ? memRuns.length / finished.length : null,
      enterpriseDetectionRate:  entRuns.length  ? entRuns.length / finished.length : null,
    };
  }

  function _inferRootCause(run) {
    if (run.geminiCalls === 0 && !run.fromMemory && !run.cacheHit) {
      return 'No Gemini call was made — screenshot capture or network request failed before analysis';
    }
    if (run.planStepsTotal === 0 && run.geminiCalls > 0) {
      return 'Gemini did not generate a plan — goal may be unclear or page state was unexpected';
    }
    if (run.planStepsFailed > 0 && run.planStepsSucceeded === 0) {
      return `All ${run.planStepsFailed} plan step(s) failed DOM matching — element text may be dynamic or truncated`;
    }
    if (run.geminiCalls >= 4) {
      return `High Gemini usage (${run.geminiCalls} calls) — plan steps frequently falling back to re-analysis`;
    }
    if (run.failureReason?.includes('Rate limit')) {
      return 'Extension rate limit reached — reduce task frequency or raise PER_MIN_LIMIT';
    }
    if (run.failureReason?.includes('timed out') || run.failureReason?.includes('timeout')) {
      return 'Gemini API call timed out — check network connection or Vercel function cold start';
    }
    if (run.lastDomScore !== null && run.lastDomScore < 40) {
      return `DOM match score critically low (${run.lastDomScore}/100) — element text does not match plan description`;
    }
    if (run.lastRecoveryTier === 'exhausted') {
      return 'All recovery tiers exhausted (primary, alternatives, semantic search) — element is not in the DOM';
    }
    return run.failureReason || 'Unknown — check DevTools console for [Plan] or [Error] log lines';
  }

  function _suggestFix(run) {
    if (run.planStepsTotal === 0) {
      return 'Make the goal more specific and action-oriented (e.g. "Click the New Issue button")';
    }
    if (run.lastDomScore !== null && run.lastDomScore < 50) {
      return 'The Gemini-predicted element text does not match the DOM text. Check if the button label is dynamic or truncated.';
    }
    if (run.geminiCalls >= 4) {
      return 'Lower PLAN_STEP_MIN_SCORE slightly (try 65) or investigate why DOM fingerprint changes between steps.';
    }
    if (run.failureReason?.includes('Rate limit')) {
      return 'Raise PER_MIN_LIMIT in rate-limiter-service.js or space out benchmark tasks.';
    }
    return 'Review DevTools console logs starting with [Plan] for detailed per-step diagnostics.';
  }

  async function _persistRun(run) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY] || { runs: [], updatedAt: 0 };
      data.runs.push(run);
      if (data.runs.length > MAX_RUNS) data.runs = data.runs.slice(-MAX_RUNS);
      data.updatedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (err) {
      console.warn('[ValidationService] persist failed:', err?.message);
    }
  }

  return {
    startRun,
    recordEvent,
    endRun,
    getActiveRun,
    getBenchmarks,
    generateReport,
    calculateReadinessScore,
    analyzeFailures,
    clear,
  };
})();
