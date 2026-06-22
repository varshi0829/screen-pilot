// ScreenPilot - Telemetry Service
// Tracks task lifecycle, Gemini usage, planning efficiency, and cache behaviour.
// Storage: chrome.storage.local → key 'screenpilot_analytics'
// Buffer:  in-memory Map accumulates events during a task; flushed on completion.

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
      goal: String(goal || '').slice(0, 200),
      startedAt:            Date.now(),
      completedAt:          null,
      durationMs:           null,
      geminiCalls:          0,
      geminiErrors:         0,
      totalGeminiLatencyMs: 0,
      planGenerated:        false,
      planStepsTotal:       0,
      planStepsAttempted:   0,
      planStepsSucceeded:   0,
      planStepsFailed:      0,
      fallbackCalls:        0,
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
    r.planGenerated   = true;
    r.planStepsTotal  = stepCount;
  }

  function recordPlanStep(taskId, succeeded) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.planStepsAttempted++;
    if (succeeded) r.planStepsSucceeded++;
    else           r.planStepsFailed++;
  }

  function recordFallback(taskId) {
    const r = _buf.get(taskId);
    if (!r) return;
    r.fallbackCalls++;
  }

  // Increments the global cache-hit counter (stored separately from per-task records).
  // Cache misses are implicit: every Gemini call that reached the backend = a miss.
  async function recordCacheHit() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY] || { tasks: [], totalCacheHits: 0 };
      data.totalCacheHits = (data.totalCacheHits || 0) + 1;
      data.updatedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (err) {
      console.warn('[Telemetry] cache-hit write failed:', err?.message);
    }
  }

  function completeTask(taskId, status, reason = '') {
    const r = _buf.get(taskId);
    if (!r) return;
    r.completedAt        = Date.now();
    r.durationMs         = r.completedAt - r.startedAt;
    r.completionStatus   = status;
    r.completionReason   = String(reason).slice(0, 100);
    _buf.delete(taskId);
    _flush(r).catch(err => console.warn('[Telemetry] flush error:', err?.message));
  }

  async function getAnalytics() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data   = stored[STORAGE_KEY] || { tasks: [], totalCacheHits: 0 };
      const tasks  = data.tasks || [];
      return {
        tasks,
        kpis: _calculateKPIs(tasks, data.totalCacheHits || 0),
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
      const data   = stored[STORAGE_KEY] || { tasks: [], totalCacheHits: 0 };
      data.tasks.push(record);
      if (data.tasks.length > MAX_TASKS) {
        data.tasks = data.tasks.slice(-MAX_TASKS);
      }
      data.updatedAt = Date.now();
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (err) {
      console.warn('[Telemetry] storage write failed:', err?.message);
    }
  }

  function _calculateKPIs(tasks, totalCacheHits) {
    const finished = tasks.filter(t => t.completionStatus !== 'active');
    if (!finished.length && !tasks.length) return _emptyKPIs();

    const _sum = (arr, key) => arr.reduce((acc, t) => acc + (Number(t[key]) || 0), 0);

    const totalGemini      = _sum(tasks, 'geminiCalls');
    const totalAttempted   = _sum(tasks, 'planStepsAttempted');
    const totalSucceeded   = _sum(tasks, 'planStepsSucceeded');
    const completedTasks   = finished.filter(t => t.completionStatus === 'completed');
    const durations        = completedTasks.filter(t => t.durationMs > 0).map(t => t.durationMs);
    const tasksWithPlan    = tasks.filter(t => t.planGenerated);
    const tasksWithFallbck = tasksWithPlan.filter(t => t.fallbackCalls > 0);
    const totalHits        = totalCacheHits;
    const totalMisses      = totalGemini;

    return {
      planSuccessRate:   totalAttempted  ? totalSucceeded / totalAttempted       : null,
      geminiCallsPerTask: finished.length ? totalGemini / finished.length         : null,
      taskCompletionRate: finished.length ? completedTasks.length / finished.length : null,
      avgTaskLatencyMs:   durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      cacheHitRate:      (totalHits + totalMisses)
        ? totalHits / (totalHits + totalMisses) : null,
      fallbackRate:      tasksWithPlan.length
        ? tasksWithFallbck.length / tasksWithPlan.length : null,
      totalTasks:        tasks.length,
      completedTasks:    completedTasks.length,
      totalGeminiCalls:  totalGemini,
      totalCacheHits,
    };
  }

  function _emptyKPIs() {
    return {
      planSuccessRate: null, geminiCallsPerTask: null,
      taskCompletionRate: null, avgTaskLatencyMs: null,
      cacheHitRate: null, fallbackRate: null,
      totalTasks: 0, completedTasks: 0,
      totalGeminiCalls: 0, totalCacheHits: 0,
    };
  }

  return {
    startTask,
    recordGeminiCall,
    recordPlanGenerated,
    recordPlanStep,
    recordFallback,
    recordCacheHit,
    completeTask,
    getAnalytics,
    clear,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelemetryService;
}
