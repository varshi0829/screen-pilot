// ScreenPilot - Rate Limiter Service
// Extension-side rate limiting that:
//  - Persists across browser restarts and extension reloads (chrome.storage.local)
//  - Tracks per-minute and per-day Gemini call budgets
//  - Prevents accidental flooding independent of backend limits
//
// Limits (conservative defaults; backend enforces its own limits separately):
//  - PER_MINUTE: 20 Gemini calls/minute  (backend allows 100 — we stay well below)
//  - PER_DAY:    200 Gemini calls/day    (prevents runaway automation)
//
// Usage in background.js:
//   const ok = await RateLimiterService.canProceed();
//   if (!ok) return { success: false, error: 'Rate limit reached.' };
//   await RateLimiterService.recordRequest();

export const RateLimiterService = (() => {
  'use strict';

  const STORAGE_KEY   = 'screenpilot_rate_limits';
  const PER_MIN_LIMIT = 20;
  const PER_DAY_LIMIT = 200;
  const MIN_MS        = 60_000;
  const DAY_MS        = 86_400_000;

  /**
   * Returns true if a new Gemini call is within rate limits.
   * Does NOT record the request — call recordRequest() after a successful check.
   */
  async function canProceed() {
    const usage = await getUsage();
    if (usage.perMinute.count >= PER_MIN_LIMIT) return false;
    if (usage.perDay.count    >= PER_DAY_LIMIT) return false;
    return true;
  }

  /**
   * Records that a Gemini call is being made.
   * Must be called immediately before the API call.
   * @returns {Promise<{perMinute, perDay}>} updated usage counters
   */
  async function recordRequest() {
    const data = await _load();
    const now  = Date.now();

    if (now > data.perMinute.resetAt) {
      data.perMinute = { count: 0, resetAt: now + MIN_MS };
    }
    if (now > data.perDay.resetAt) {
      data.perDay = { count: 0, resetAt: now + DAY_MS };
    }

    data.perMinute.count++;
    data.perDay.count++;
    await _save(data);

    return {
      perMinute: { count: data.perMinute.count, limit: PER_MIN_LIMIT, resetAt: data.perMinute.resetAt },
      perDay:    { count: data.perDay.count,    limit: PER_DAY_LIMIT, resetAt: data.perDay.resetAt    },
    };
  }

  /**
   * Returns current usage without modifying state.
   * Expired windows are reported as count=0.
   *
   * @returns {Promise<{perMinute: {count, limit, resetAt, remaining}, perDay: {count, limit, resetAt, remaining}}>}
   */
  async function getUsage() {
    const data = await _load();
    const now  = Date.now();

    const minCount = now > data.perMinute.resetAt ? 0 : data.perMinute.count;
    const dayCount = now > data.perDay.resetAt    ? 0 : data.perDay.count;

    return {
      perMinute: {
        count:     minCount,
        limit:     PER_MIN_LIMIT,
        remaining: Math.max(0, PER_MIN_LIMIT - minCount),
        resetAt:   data.perMinute.resetAt,
      },
      perDay: {
        count:     dayCount,
        limit:     PER_DAY_LIMIT,
        remaining: Math.max(0, PER_DAY_LIMIT - dayCount),
        resetAt:   data.perDay.resetAt,
      },
    };
  }

  /**
   * Resets all counters (use for testing only).
   */
  async function reset() {
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────────

  async function _load() {
    const now    = Date.now();
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] || {
      perMinute: { count: 0, resetAt: now + MIN_MS },
      perDay:    { count: 0, resetAt: now + DAY_MS },
    };
  }

  async function _save(data) {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }

  return { canProceed, recordRequest, getUsage, reset };
})();
