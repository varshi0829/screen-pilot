// ScreenPilot - Telemetry Service
// Tracks task lifecycle, Gemini usage, planning efficiency, cache behaviour,
// enterprise context detection, memory/prediction hits, and recovery success.
//
// Storage: chrome.storage.local → key 'screenpilot_analytics'
// Buffer:  in-memory Map accumulates events during a task; flushed on completion.
//
// TaskRecord schema (per-task):
//   taskId, goal, startedAt, completedAt, durationMs,
//   geminiCalls, geminiErrors, totalGeminiLatencyMs,
//   planGenerated, planStepsTotal, planStepsAttempted, planStepsSucceeded, planStepsFailed,
//   fallbackCalls,
//   enterpriseDetected, enterpriseApp,
//   memoryHit, geminiAvoided,
//   recoveryAttempts, recoverySuccesses,
//   completionStatus, completionReason
//
// Global counters (per-installation):
//   totalCacheHits, totalMemoryHits, totalGeminiAvoided

export const TelemetryService = (() => {
  'use strict';

  const STORAGE_KEY = 'screenpilot_analytics';
  const MAX_TASKS   = 100;

  // In-memory event buffer: taskId → partial record
  const _buf = new Map();

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  function startTask(taskId, goal) {
    _buf.set(taskId, {
      taskId,
      goal:                 String(goal || '').slice(0, 200),
      startedAt:            Date.now(),
      completedAt:          null,
      durationMs:           null,
      // Gemini usage
      geminiCalls:          0,
      geminiErrors:         0,
      totalGeminiLatencyMs: 0,
      // Plan execution
      planGenerated:        false,
      planStepsTotal:       0,
      planStepsAttempted:   0,
      planStepsSucceeded:   0,
      planStepsFailed:      0,
      fallbackCalls:        0,
      // Enterprise context
      enterpriseDetected:   false,
      enterpriseApp:        null,
      // Memory / predictive navigation
      memoryHit:            false,
      geminiAvoided:        0,
      // Recovery mode
      recoveryAttempts:     0,
      recoverySuccesses:    0,
      // Lifecycle
      completionStatus:     'active',
      completionReason:     '',
    });
  }

  function recordGeminiCall(taskId, { latencyMs = 0, success = true } = {}) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.geminiCalls++;
    if (!success) r.geminiErrors++;
    r.totalGeminiLatencyMs += latencyMs;
  }

  function recordPlanGenerated(taskId, stepCount) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.planGenerated  = true;
    r.planStepsTotal = stepCount;
  }

  function recordPlanStep(taskId, succeeded) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.planStepsAttempted++;
    if (succeeded) {
      r.planStepsSucceeded++;
      r.geminiAvoided++;   // each DOM-only plan step avoids a Gemini call
    } else {
      r.planStepsFailed++;
    }
  }

  function recordFallback(taskId) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.fallbackCalls++;
  }

  /** Record which enterprise application was detected for this task. */
  function recordEnterpriseContext(taskId, { application = null, detected = false } = {}) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.enterpriseDetected = detected;
    r.enterpriseApp      = application || null;
  }

  /** Record that this task was started from a memory workflow (no initial Gemini call). */
  function recordMemoryHit(taskId) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.memoryHit = true;
    r.geminiAvoided++;
    _incrementGlobalCounter('totalMemoryHits').catch(() => {});
  }

  /** Record a recovery attempt and whether it succeeded. */
  function recordRecovery(taskId, succeeded) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.recoveryAttempts++;
    if (succeeded) r.recoverySuccesses++;
  }

  /** Increments global cache-hit counter (separate from per-task data). */
  async function recordCacheHit() {
    try {
      await _incrementGlobalCounter('totalCacheHits');
    } catch (err) {
      console.warn('[Telemetry] cache-hit write failed:', err?.message);
    }
  }

  function completeTask(taskId, status, reason = '') {
    const r = _buf.get(taskId);
    if (!r) return;
    r.completedAt      = Date.now();
    r.durationMs       = r.completedAt - r.startedAt;
    r.completionStatus = status;
    r.completionReason = String(reason).slice(0, 100);
    _buf.delete(taskId);
    _flush(r).catch(err => console.warn('[Telemetry] flush error:', err?.message));
  }

  async function getAnalytics() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY] || _emptyStore();
      return {
        tasks: data.tasks || [],
        kpis:  _calculateKPIs(data.tasks || [], data),
      };
    } catch {
      return { tasks: [], kpis: _emptyKPIs() };
    }
  }

  async function clear() {
    _buf.clear();
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  // ─── PRIVATE ────────────────────────────────────────────────────────────────

  async function _flush(record) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY] || _emptyStore();
      data.tasks.push(record);
      if (data.tasks.length > MAX_TASKS) {
        data.tasks = data.tasks.slice(-MAX_TASKS);
      }
      // Update rolling Gemini-avoided counter
      data.totalGeminiAvoided = (data.totalGeminiAvoided || 0) + (record.geminiAvoided || 0);
      data.updatedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (err) {
      console.warn('[Telemetry] storage write failed:', err?.message);
    }
  }

  async function _incrementGlobalCounter(field) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const data   = stored[STORAGE_KEY] || _emptyStore();
    data[field]  = (data[field] || 0) + 1;
    data.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }

  function _calculateKPIs(tasks, globals) {
    const finished      = tasks.filter(t => t.completionStatus !== 'active');
    const completedTask = finished.filter(t => t.completionStatus === 'completed');
    const _sum = (arr, k) => arr.reduce((a, t) => a + (Number(t[k]) || 0), 0);

    const totalGemini      = _sum(tasks, 'geminiCalls');
    const totalAttempted   = _sum(tasks, 'planStepsAttempted');
    const totalSucceeded   = _sum(tasks, 'planStepsSucceeded');
    const totalRecovAtt    = _sum(tasks, 'recoveryAttempts');
    const totalRecovSuc    = _sum(tasks, 'recoverySuccesses');
    const totalAvoided     = _sum(tasks, 'geminiAvoided') + (globals.totalGeminiAvoided || 0);
    const tasksWithPlan    = tasks.filter(t => t.planGenerated);
    const tasksWithFallbck = tasksWithPlan.filter(t => t.fallbackCalls > 0);
    const durations        = completedTask.filter(t => t.durationMs > 0).map(t => t.durationMs);
    const stepCounts       = completedTask.map(t => t.planStepsTotal || 0).filter(n => n > 0);
    const totalCacheHits   = globals.totalCacheHits || 0;
    const totalMemHits     = globals.totalMemoryHits || 0;
    const taskWithEnterprise = tasks.filter(t => t.enterpriseDetected);
    const tasksWithMemHit  = tasks.filter(t => t.memoryHit);

    return {
      // Existing KPIs
      planSuccessRate:        totalAttempted
        ? totalSucceeded / totalAttempted : null,
      geminiCallsPerTask:     finished.length
        ? totalGemini / finished.length : null,
      taskCompletionRate:     finished.length
        ? completedTask.length / finished.length : null,
      avgTaskLatencyMs:       durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      cacheHitRate:           (totalCacheHits + totalGemini)
        ? totalCacheHits / (totalCacheHits + totalGemini) : null,
      fallbackRate:           tasksWithPlan.length
        ? tasksWithFallbck.length / tasksWithPlan.length : null,

      // New KPIs (Phase 6)
      geminiAvoidanceRate:    (totalAvoided + totalGemini)
        ? totalAvoided / (totalAvoided + totalGemini) : null,
      enterpriseDetectionRate: tasks.length
        ? taskWithEnterprise.length / tasks.length : null,
      memoryHitRate:          tasks.length
        ? tasksWithMemHit.length / tasks.length : null,
      recoverySuccessRate:    totalRecovAtt
        ? totalRecovSuc / totalRecovAtt : null,
      avgWorkflowLength:      stepCounts.length
        ? stepCounts.reduce((a, b) => a + b, 0) / stepCounts.length : null,

      // Aggregate counters
      totalTasks:       tasks.length,
      completedTasks:   completedTask.length,
      totalGeminiCalls: totalGemini,
      totalCacheHits,
      totalMemoryHits:  totalMemHits,
      totalGeminiAvoided: totalAvoided,
    };
  }

  function _emptyKPIs() {
    return {
      planSuccessRate: null, geminiCallsPerTask: null, taskCompletionRate: null,
      avgTaskLatencyMs: null, cacheHitRate: null, fallbackRate: null,
      geminiAvoidanceRate: null, enterpriseDetectionRate: null,
      memoryHitRate: null, recoverySuccessRate: null, avgWorkflowLength: null,
      totalTasks: 0, completedTasks: 0, totalGeminiCalls: 0, totalCacheHits: 0,
      totalMemoryHits: 0, totalGeminiAvoided: 0,
    };
  }

  function _emptyStore() {
    return { tasks: [], totalCacheHits: 0, totalMemoryHits: 0, totalGeminiAvoided: 0, updatedAt: Date.now() };
  }

  return {
    startTask,
    recordGeminiCall,
    recordPlanGenerated,
    recordPlanStep,
    recordFallback,
    recordEnterpriseContext,
    recordMemoryHit,
    recordRecovery,
    recordCacheHit,
    completeTask,
    getAnalytics,
    clear,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelemetryService;
}
