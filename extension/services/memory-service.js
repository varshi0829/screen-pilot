// ScreenPilot - Memory Service
// Lightweight persistence layer that learns from completed tasks.
//
// What is stored:
//  - Workflow patterns: goal → ordered navigation steps (for predictive plan generation)
//  - Element patterns: step description + URL → matched element text (for faster DOM matching)
//
// What is NOT stored:
//  - No user-entered form values, credentials, or personal data
//  - No page content or screenshots
//  - No cookies or session tokens
//
// Storage limits:
//  - Max 100 workflow patterns (FIFO eviction by lastUsed)
//  - Max 500 element patterns (eviction by hit-weighted recency)
//  - Max age: 30 days (auto-cleaned on next lookup)
//
// Predictive navigation confidence thresholds:
//  - >= 0.85: exact goal match, 2+ completions → synthetic plan returned, Gemini skipped
//  - >= 0.70: fuzzy token match → synthetic plan returned as hint (still validated by DOM)
//  - <  0.70: no memory hit, always calls Gemini

export const MemoryService = (() => {
  'use strict';

  const STORAGE_KEY         = 'screenpilot_memory';
  const MAX_WORKFLOWS       = 100;
  const MAX_ELEMENTS        = 500;
  const MAX_AGE_MS          = 30 * 24 * 60 * 60 * 1000; // 30 days
  const MIN_COMPLETIONS     = 2;  // require 2 successful runs before trusting a workflow
  const EXACT_CONFIDENCE    = 0.92;
  const FUZZY_CONFIDENCE_MIN = 0.72;
  const TOKEN_SIMILARITY_MIN = 0.75;

  // In-process read-through cache — cleared only on explicit clear()
  let _cache = null;

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  /**
   * Save a completed workflow to memory.
   * Idempotent: updates existing record if same normalized goal is found.
   *
   * @param {{goal, steps, geminiCalls, completionStatus, application}} taskRecord
   *   steps: [{ description, element: {text, type, region}, urlPattern }]
   */
  async function saveWorkflow(taskRecord) {
    if (!taskRecord?.goal?.trim()) return;
    if (!Array.isArray(taskRecord.steps) || taskRecord.steps.length === 0) return;
    if (taskRecord.completionStatus !== 'completed') return;

    const data       = await _load();
    const normalized = _normalizeGoal(taskRecord.goal);
    const existing   = data.workflows.find(w => w.goalNormalized === normalized);

    if (existing) {
      const prev = existing.completionCount;
      existing.completionCount++;
      existing.lastUsed      = Date.now();
      existing.steps         = taskRecord.steps;                          // update with latest
      existing.avgGeminiCalls = Math.round(
        ((existing.avgGeminiCalls * prev) + (taskRecord.geminiCalls || 1)) / existing.completionCount * 10
      ) / 10;
      if (taskRecord.application) existing.application = taskRecord.application;
    } else {
      data.workflows.push({
        id:              _fnv32a(normalized),
        goal:            taskRecord.goal.slice(0, 200),
        goalNormalized:  normalized,
        steps:           taskRecord.steps,
        completionCount: 1,
        avgGeminiCalls:  taskRecord.geminiCalls || 1,
        application:     taskRecord.application || null,
        lastUsed:        Date.now(),
        createdAt:       Date.now(),
      });
    }

    // Evict by LRU if over cap
    if (data.workflows.length > MAX_WORKFLOWS) {
      data.workflows.sort((a, b) => b.lastUsed - a.lastUsed);
      data.workflows.length = MAX_WORKFLOWS;
    }

    await _save(data);
  }

  /**
   * Save a successful element match (step description → element text) for future DOM hinting.
   *
   * @param {string} stepDescription
   * @param {string} url
   * @param {{text, type, region}} element
   */
  async function saveElementPattern(stepDescription, url, element) {
    if (!stepDescription?.trim() || !element?.text) return;

    const data = await _load();
    const key  = _fnv32a(_normalizeGoal(stepDescription) + '|' + _urlPattern(url));
    const existing = data.elements.find(e => e.key === key);

    if (existing) {
      existing.hits++;
      existing.lastUsed = Date.now();
      existing.element  = element;              // keep the most recent match
    } else {
      data.elements.push({
        key,
        stepDescription:  stepDescription.slice(0, 200),
        urlPattern:        _urlPattern(url),
        element,
        hits:              1,
        lastUsed:          Date.now(),
        createdAt:         Date.now(),
      });
    }

    // Evict: score = hits * 0.6 + recency (normalized) * 0.4
    if (data.elements.length > MAX_ELEMENTS) {
      const now = Date.now();
      data.elements.sort((a, b) =>
        (b.hits * 0.6 + (b.lastUsed / now) * 0.4) - (a.hits * 0.6 + (a.lastUsed / now) * 0.4)
      );
      data.elements.length = MAX_ELEMENTS;
    }

    await _save(data);
  }

  /**
   * Find the best matching workflow for a goal.
   * Returns null if no reliable match exists.
   *
   * @returns {{ workflow, confidence, matchType } | null}
   */
  async function findWorkflow(goal) {
    await _evictStale();
    const data       = await _load();
    const normalized = _normalizeGoal(goal);

    // Tier 1: Exact normalized match
    const exact = data.workflows.find(
      w => w.goalNormalized === normalized && w.completionCount >= MIN_COMPLETIONS
    );
    if (exact) {
      exact.lastUsed = Date.now();
      await _save(data);
      return { workflow: exact, confidence: EXACT_CONFIDENCE, matchType: 'exact' };
    }

    // Tier 2: Token-overlap fuzzy match
    const tokens = _tokenize(normalized);
    if (tokens.length === 0) return null;

    let best = null, bestRatio = 0;
    for (const w of data.workflows) {
      if (w.completionCount < MIN_COMPLETIONS) continue;
      const wTokens = _tokenize(w.goalNormalized);
      const overlap  = tokens.filter(t => wTokens.includes(t)).length;
      // Sørensen–Dice coefficient
      const ratio    = (2 * overlap) / (tokens.length + wTokens.length);
      if (ratio > bestRatio && ratio >= TOKEN_SIMILARITY_MIN) {
        best = w; bestRatio = ratio;
      }
    }

    if (best) {
      const confidence = FUZZY_CONFIDENCE_MIN + (bestRatio - TOKEN_SIMILARITY_MIN) * ((EXACT_CONFIDENCE - FUZZY_CONFIDENCE_MIN) / (1 - TOKEN_SIMILARITY_MIN));
      best.lastUsed = Date.now();
      await _save(data);
      return { workflow: best, confidence: Math.min(0.88, confidence), matchType: 'fuzzy' };
    }

    return null;
  }

  /**
   * Find a previously successful element match for a step description on the current URL.
   *
   * @returns {{ element, hits } | null}
   */
  async function findElementPattern(stepDescription, url) {
    const data = await _load();
    const key  = _fnv32a(_normalizeGoal(stepDescription) + '|' + _urlPattern(url));
    const el   = data.elements.find(e => e.key === key);
    if (el) return { element: el.element, hits: el.hits };
    return null;
  }

  /**
   * Returns aggregate memory statistics for telemetry/analytics.
   */
  async function getStats() {
    const data = await _load();
    return {
      workflowCount:    data.workflows.length,
      elementCount:     data.elements.length,
      totalCompletions: data.workflows.reduce((s, w) => s + w.completionCount, 0),
      highConfidenceWorkflows: data.workflows.filter(w => w.completionCount >= MIN_COMPLETIONS).length,
      updatedAt:        data.updatedAt || 0,
    };
  }

  /** Remove all memory data. */
  async function clear() {
    _cache = null;
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────────

  async function _load() {
    if (_cache) return _cache;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    _cache = stored[STORAGE_KEY] || { workflows: [], elements: [], updatedAt: Date.now() };
    return _cache;
  }

  async function _save(data) {
    _cache = data;
    data.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }

  async function _evictStale() {
    const data   = await _load();
    const cutoff = Date.now() - MAX_AGE_MS;
    const wBefore = data.workflows.length;
    const eBefore = data.elements.length;
    data.workflows = data.workflows.filter(w => w.lastUsed > cutoff);
    data.elements  = data.elements.filter(e => e.lastUsed > cutoff);
    if (data.workflows.length !== wBefore || data.elements.length !== eBefore) {
      await _save(data);
    }
  }

  function _normalizeGoal(goal) {
    return goal
      .toLowerCase()
      .replace(/['"()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _tokenize(normalized) {
    const STOP = new Set(['the','a','an','to','in','on','at','of','and','or','for','with','my','this','that','click','go','open','use']);
    return normalized.split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));
  }

  function _urlPattern(url) {
    try {
      const u = new URL(url);
      // Strip long path segments that are likely IDs
      const path = u.pathname.replace(/\/[a-zA-Z0-9_-]{16,}/g, '/:id');
      return (u.hostname + path).slice(0, 80);
    } catch {
      return String(url).slice(0, 80);
    }
  }

  // FNV-32a hash — fast, deterministic, no external dependencies
  function _fnv32a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h  = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  return {
    saveWorkflow,
    saveElementPattern,
    findWorkflow,
    findElementPattern,
    getStats,
    clear,
  };
})();
