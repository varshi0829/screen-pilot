// ScreenPilot — Session Store (v3)
//
// Persists WorkflowSession to chrome.storage.local keyed by tab ID.
// Sessions self-expire via TTL (expiresAt); cleanupExpired() removes stale keys.
//
// All reads enforce expiry and schema version.
// All writes extend expiresAt by SESSION_TTL_MS.
//
// Stuck-workflow detection:
//   stepAttemptCount          — resets to 0 on each confirmed step completion.
//                               Reaches MAX_STEP_ATTEMPTS → stuck on same step.
//   plannerAttemptCount       — never resets. Dynamic budget via _maxPlannerCalls().
//   consecutiveFinalCount     — consecutive goal_reached outcomes. Resets on completeStep.
//   consecutiveAmbiguousCount — consecutive ambiguous outcomes. Resets on completeStep.
//   authAttemptCount          — cumulative auth-recovery attempts (never resets).
//
// Usage:
//   import { SessionStore } from './session-store.js';
//   const session = await SessionStore.load(tabId);

const SESSION_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const SCHEMA_VERSION = '3';
const KEY_PREFIX     = 'sp_session_';

export const MAX_STEP_ATTEMPTS         = 3;
export const MAX_PLANNER_CALLS         = 20;  // retained for import compat; enforcement uses _maxPlannerCalls()
export const MAX_CONSECUTIVE_AMBIGUOUS = 3;
export const MAX_CONSECUTIVE_FINAL     = 3;
export const MAX_AUTH_ATTEMPTS         = 3;

// Dynamic global budget: 10 base + 2 per confirmed step, capped at 40.
// A session with N completed steps has earned N*2 additional attempts.
function _maxPlannerCalls(session) {
  return Math.min(10 + 2 * session.completedSteps.length, 40);
}

function sessionKey(tabId) {
  return KEY_PREFIX + tabId;
}

function nowMs() {
  return Date.now();
}

async function _read(tabId) {
  const key    = sessionKey(tabId);
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

async function _write(tabId, session) {
  await chrome.storage.local.set({ [sessionKey(tabId)]: session });
}

export const SessionStore = {
  /**
   * Create and persist a new session. Overwrites any existing session for this tabId.
   *
   * @param {number} tabId
   * @param {string} goal
   * @returns {Promise<object>} the persisted session
   */
  async create(tabId, goal) {
    const t = nowMs();
    const session = {
      sessionId:                 crypto.randomUUID(),
      tabId,
      schemaVersion:             SCHEMA_VERSION,
      goal,
      completedSteps:            [],
      planVersion:               0,
      plannerAttemptCount:       0,
      stepAttemptCount:          0,
      consecutiveFinalCount:     0,
      consecutiveAmbiguousCount: 0,
      goalDeniedCount:           0,
      authAttemptCount:          0,
      currentBlocker:            null,
      pageUrlAtLoad:             null,
      lastProgressAt:            t,
      pendingStep:               null,
      clarifications:            [],
      phase:                     'PLANNING',
      createdAt:                 t,
      updatedAt:                 t,
      expiresAt:                 t + SESSION_TTL_MS,
    };
    await _write(tabId, session);
    return session;
  },

  /**
   * Load the session for the given tabId.
   * Returns null when absent, expired, or schema version mismatches.
   *
   * @param {number} tabId
   * @returns {Promise<object|null>}
   */
  async load(tabId) {
    const session = await _read(tabId);
    if (!session) return null;

    if (session.schemaVersion !== SCHEMA_VERSION) {
      chrome.storage.local.remove(sessionKey(tabId));
      return null;
    }

    if (nowMs() > session.expiresAt) {
      chrome.storage.local.remove(sessionKey(tabId));
      return null;
    }

    return session;
  },

  /**
   * Remove the session for the given tabId.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async clear(tabId) {
    await chrome.storage.local.remove(sessionKey(tabId));
  },

  /**
   * Scan all stored sessions and remove those that have expired.
   * Safe to call on any content script init for housekeeping.
   *
   * @returns {Promise<number>} count of sessions removed
   */
  async cleanupExpired() {
    const all  = await chrome.storage.local.get(null);
    const now  = nowMs();
    const keys = Object.keys(all).filter(
      k => k.startsWith(KEY_PREFIX) && now > (all[k]?.expiresAt ?? 0)
    );
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  },

  /**
   * Extend expiresAt without changing any other field.
   * Use during PAUSED state to keep the session alive while the user resolves a blocker.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async refreshExpiry(tabId) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, { ...session, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
  },

  /**
   * Persist the pending step context and set phase to EXECUTING.
   * Must be called at element:ready — before any possible navigation —
   * so the context survives if the page unloads before user:acted fires.
   *
   * @param {number} tabId
   * @param {object} pendingStep
   * @returns {Promise<void>}
   */
  async markPendingStep(tabId, pendingStep) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      pendingStep,
      phase:     'EXECUTING',
      updatedAt: t,
      expiresAt: t + SESSION_TTL_MS,
    });
  },

  /**
   * Append a confirmed step to history.
   * Resets stepAttemptCount, consecutiveFinalCount, and consecutiveAmbiguousCount.
   * Sets phase to PLANNING so the next content script re-plans.
   *
   * @param {number} tabId
   * @param {object} stepRecord
   * @returns {Promise<void>}
   */
  async completeStep(tabId, stepRecord) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      completedSteps:            [...session.completedSteps, stepRecord],
      planVersion:               session.planVersion + 1,
      stepAttemptCount:          0,
      consecutiveFinalCount:     0,
      consecutiveAmbiguousCount: 0,
      lastProgressAt:            t,
      pendingStep:               null,
      phase:                     'PLANNING',
      updatedAt:                 t,
      expiresAt:                 t + SESSION_TTL_MS,
    });
  },

  /**
   * Update the session phase without touching any other field.
   *
   * @param {number} tabId
   * @param {string} phase
   * @returns {Promise<void>}
   */
  async setPhase(tabId, phase) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, { ...session, phase, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
  },

  /**
   * Increment both planner attempt counters.
   * Use when the step genuinely failed (element-not-found, validation-failed).
   * Returns isStuck=true if either limit is reached.
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async incrementPlannerAttempt(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const nextPlannerCount = session.plannerAttemptCount + 1;
    const nextStepCount    = session.stepAttemptCount    + 1;
    const t = nowMs();

    await _write(tabId, {
      ...session,
      plannerAttemptCount: nextPlannerCount,
      stepAttemptCount:    nextStepCount,
      updatedAt:           t,
      expiresAt:           t + SESSION_TTL_MS,
    });

    if (nextStepCount >= MAX_STEP_ATTEMPTS) {
      return {
        isStuck: true,
        reason:  `Step attempt limit reached (${nextStepCount}/${MAX_STEP_ATTEMPTS}) — stuck on same step`,
      };
    }
    const budget = _maxPlannerCalls(session);
    if (nextPlannerCount >= budget) {
      return {
        isStuck: true,
        reason:  `Global planner call limit reached (${nextPlannerCount}/${budget})`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Increment plannerAttemptCount only (not stepAttemptCount).
   * Use for NAV_REFRESH and PAUSED resume — step was never attempted.
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async incrementPlannerAttemptOnly(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const nextPlannerCount = session.plannerAttemptCount + 1;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      plannerAttemptCount: nextPlannerCount,
      updatedAt:           t,
      expiresAt:           t + SESSION_TTL_MS,
    });

    const budget = _maxPlannerCalls(session);
    if (nextPlannerCount >= budget) {
      return {
        isStuck: true,
        reason:  `Global planner call limit reached (${nextPlannerCount}/${budget})`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Increment stepAttemptCount only (not plannerAttemptCount).
   * Use when retrying the same step without consuming global budget.
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async incrementStepAttempt(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const nextStepCount = session.stepAttemptCount + 1;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      stepAttemptCount: nextStepCount,
      updatedAt:        t,
      expiresAt:        t + SESSION_TTL_MS,
    });

    if (nextStepCount >= MAX_STEP_ATTEMPTS) {
      return {
        isStuck: true,
        reason:  `Step attempt limit reached (${nextStepCount}/${MAX_STEP_ATTEMPTS}) — stuck on same step`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Increment consecutiveAmbiguousCount.
   * Call when outcome === 'ambiguous'. Triggers guard at MAX_CONSECUTIVE_AMBIGUOUS.
   * Reset by completeStep() or patchSession(tabId, { consecutiveAmbiguousCount: 0 }).
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async incrementAmbiguousAttempt(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const next = session.consecutiveAmbiguousCount + 1;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      consecutiveAmbiguousCount: next,
      updatedAt:                 t,
      expiresAt:                 t + SESSION_TTL_MS,
    });

    if (next >= MAX_CONSECUTIVE_AMBIGUOUS) {
      return {
        isStuck: true,
        reason:  `Consecutive ambiguous limit reached (${next}/${MAX_CONSECUTIVE_AMBIGUOUS}) — cannot resolve path`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Increment authAttemptCount (never resets).
   * Call when entering auth recovery. Triggers guard at MAX_AUTH_ATTEMPTS.
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async incrementAuthAttempt(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const next = session.authAttemptCount + 1;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      authAttemptCount: next,
      updatedAt:        t,
      expiresAt:        t + SESSION_TTL_MS,
    });

    if (next >= MAX_AUTH_ATTEMPTS) {
      return {
        isStuck: true,
        reason:  `Auth recovery limit reached (${next}/${MAX_AUTH_ATTEMPTS}) — cannot authenticate`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Increment consecutiveFinalCount.
   * Call when outcome === 'goal_reached'. Triggers guard at MAX_CONSECUTIVE_FINAL.
   * When the user denies: patchSession(tabId, { consecutiveFinalCount: 0, goalDeniedCount: n+1 }).
   *
   * @param {number} tabId
   * @returns {Promise<{ isStuck: boolean, reason: string|null }>}
   */
  async recordGoalReached(tabId) {
    const session = await _read(tabId);
    if (!session) return { isStuck: false, reason: null };

    const next = session.consecutiveFinalCount + 1;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      consecutiveFinalCount: next,
      updatedAt:             t,
      expiresAt:             t + SESSION_TTL_MS,
    });

    if (next >= MAX_CONSECUTIVE_FINAL) {
      return {
        isStuck: true,
        reason:  `Goal confirmation repeatedly rejected (${next}/${MAX_CONSECUTIVE_FINAL}) — planner and user disagree`,
      };
    }
    return { isStuck: false, reason: null };
  },

  /**
   * Persist the blocker description from a blocked plan outcome.
   * Does not change phase — caller must call setPhase('PAUSED') separately.
   *
   * @param {number} tabId
   * @param {string} blockerText
   * @returns {Promise<void>}
   */
  async setBlocker(tabId, blockerText) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      currentBlocker: blockerText,
      updatedAt:      t,
      expiresAt:      t + SESSION_TTL_MS,
    });
  },

  /**
   * Clear the persisted blocker when the user resumes from PAUSED.
   * Does not change phase — caller must call setPhase() separately.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async clearBlocker(tabId) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      currentBlocker: null,
      updatedAt:      t,
      expiresAt:      t + SESSION_TTL_MS,
    });
  },

  /**
   * Merge arbitrary updates into the session.
   * Use for counter resets and field patches that have no dedicated method.
   * Example: patchSession(tabId, { consecutiveFinalCount: 0, goalDeniedCount: n+1 })
   *
   * @param {number} tabId
   * @param {object} updates
   * @returns {Promise<void>}
   */
  async patchSession(tabId, updates) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      ...updates,
      updatedAt: t,
      expiresAt: t + SESSION_TTL_MS,
    });
  },
};

// Backward-compatible aliases — existing callers continue to work unchanged.
SessionStore.setPendingStep      = SessionStore.markPendingStep;
SessionStore.appendCompletedStep = SessionStore.completeStep;
