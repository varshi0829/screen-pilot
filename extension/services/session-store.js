// ScreenPilot — Session Store (v3)
//
// Persists WorkflowSession to chrome.storage.session keyed by tab ID.
// chrome.storage.session is cleared automatically when the browser closes.
//
// All reads enforce expiry and schema version.
// All writes extend expiresAt by SESSION_TTL_MS and regenerate the nonce.
//
// Stuck-workflow detection:
//   stepAttemptCount        — resets to 0 on each confirmed step completion.
//                             Reaches MAX_STEP_ATTEMPTS → stuck on same step.
//   plannerAttemptCount     — never resets. Dynamic budget via _maxPlannerCalls().
//   consecutiveFinalCount   — goal_reached returns denied by user.
//   consecutiveAmbiguousCount — consecutive ambiguous plan outcomes.
//   authAttemptCount        — cumulative auth-recovery attempts.
//
// Usage:
//   import { SessionStore } from './session-store.js';
//   const session = await SessionStore.load(tabId);

const SESSION_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const SCHEMA_VERSION = '3';
const KEY_PREFIX     = 'sp_session_';

export const MAX_STEP_ATTEMPTS = 3;   // planner calls on same step before ERROR
export const MAX_PLANNER_CALLS = 20;  // retained for import compat; enforcement uses _maxPlannerCalls()

// Dynamic global budget: 10 base + 2 per confirmed step, capped at 40.
// A session that has completed N steps earned N*2 additional attempts.
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
  const result = await chrome.storage.session.get(key);
  return result[key] ?? null;
}

async function _write(tabId, session) {
  await chrome.storage.session.set({
    [sessionKey(tabId)]: { ...session, nonce: crypto.randomUUID() },
  });
}

export const SessionStore = {
  /**
   * Create and persist a new session.
   * Overwrites any existing session for this tabId.
   *
   * @param {number} tabId
   * @param {string} goal
   * @returns {Promise<import('../shared/types/index.js').WorkflowSession>}
   */
  async create(tabId, goal) {
    const t = nowMs();
    /** @type {import('../shared/types/index.js').WorkflowSession} */
    const session = {
      sessionId:                 crypto.randomUUID(),
      tabId,
      schemaVersion:             SCHEMA_VERSION,
      nonce:                     crypto.randomUUID(),
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
   * Returns null when: absent, expired, or wrong schema version.
   * Schedules async cleanup on expiry.
   *
   * @param {number} tabId
   * @returns {Promise<import('../shared/types/index.js').WorkflowSession|null>}
   */
  async load(tabId) {
    const session = await _read(tabId);
    if (!session) return null;

    if (session.schemaVersion !== SCHEMA_VERSION) {
      chrome.storage.session.remove(sessionKey(tabId));
      return null;
    }

    if (nowMs() > session.expiresAt) {
      chrome.storage.session.remove(sessionKey(tabId));
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
    await chrome.storage.session.remove(sessionKey(tabId));
  },

  /**
   * Overwrite the pending step context and set phase to EXECUTING.
   * Must be called at element:ready — before any possible navigation —
   * so the context survives if the page unloads before user:acted fires.
   *
   * @param {number} tabId
   * @param {import('../shared/types/index.js').PendingStepContext} pendingStep
   * @returns {Promise<void>}
   */
  async setPendingStep(tabId, pendingStep) {
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
   * Resets stepAttemptCount to 0 and updates lastProgressAt.
   * Sets phase to PLANNING to signal the next content script to re-plan.
   *
   * @param {number} tabId
   * @param {import('../shared/types/index.js').StepRecord} stepRecord
   * @returns {Promise<void>}
   */
  async appendCompletedStep(tabId, stepRecord) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, {
      ...session,
      completedSteps:   [...session.completedSteps, stepRecord],
      planVersion:      session.planVersion + 1,
      stepAttemptCount: 0,
      lastProgressAt:   t,
      pendingStep:      null,
      phase:            'PLANNING',
      updatedAt:        t,
      expiresAt:        t + SESSION_TTL_MS,
    });
  },

  /**
   * Increment both planner attempt counters.
   * Must be called immediately before every /api/plan call.
   * Returns isStuck=true if either limit is reached, so the caller
   * can abort before making the network call.
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
   * Update the session phase without touching any other field.
   *
   * @param {number} tabId
   * @param {import('../shared/types/index.js').SessionPhase} phase
   * @returns {Promise<void>}
   */
  async setPhase(tabId, phase) {
    const session = await _read(tabId);
    if (!session) return;
    const t = nowMs();
    await _write(tabId, { ...session, phase, updatedAt: t, expiresAt: t + SESSION_TTL_MS });
  },

  /**
   * Increment plannerAttemptCount only (not stepAttemptCount).
   * Use for NAV_REFRESH, PAUSED resume, and auth retries — cases where the
   * step was never attempted and the per-step counter must not move.
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
   * Use for element-not-found and validation-failed — genuine failures on
   * the current step where the global budget should not advance.
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
   * The nonce is always regenerated by _write(); do not include it in updates.
   * Use for counter increments and field patches that have no dedicated method.
   *
   * @param {number} tabId
   * @param {Partial<import('../shared/types/index.js').WorkflowSession>} updates
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
