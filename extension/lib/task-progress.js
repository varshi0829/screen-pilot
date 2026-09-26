// ScreenPilot — TaskProgress (Phase 4)
//
// An ISOLATED, read-only projection over the existing task-state machinery —
// TaskState (extension/shared/state-machine/transitions.js) and SessionStore
// (extension/services/session-store.js). It does not replace either, does
// not introduce new persistence beyond three small additive SessionStore
// fields (replanCount, lastActionResult, lastActionAt — see session-store.js;
// all enums/timestamps, zero PII risk), and makes no network or LLM call —
// deriveTaskProgress() is a pure function of its inputs (constraint: prefer
// deterministic/local transitions).
//
// Why a derive function rather than a new store: SessionStore is already the
// single source of truth for what survives navigation; duplicating it into a
// second persisted structure would reintroduce exactly the kind of
// duplicated/drifting state this phase's own inspection found — e.g.
// v2-task.js's in-memory `_state` and `_taskContext` already drift from
// SessionStore across a navigation because they're page-scoped JS globals,
// not persisted (see the Phase 4 audit report for the full inspection
// findings). TaskProgress avoids adding a THIRD copy by only ever reading,
// never owning, state.
//
// Field-by-field mapping to what's actually available today (see the phase's
// inspection notes for what's duplicated/lost/inferred in the existing flow):
//   goal              -> session.goal (redacted — see below)
//   status            -> taskState param if given (authoritative — matches
//                        the state machine exactly), else inferred from
//                        session.phase (coarser: only 'PLANNING'/'EXECUTING'/
//                        'PAUSED' are ever persisted there)
//   currentStep       -> session.pendingStep (redacted description/intent)
//   completedSteps    -> session.completedSteps (redacted summaries)
//   remainingSteps    -> ALWAYS null. The architecture is genuinely single-
//                        step: only plan.steps[0] is ever consumed and the
//                        rest of any multi-step planner response is discarded
//                        every cycle (v2-task.js re-plans after every step).
//                        Fabricating a count here would overstate confidence
//                        the app doesn't have — reported as a known gap, not
//                        silently invented.
//   expectedState     -> session.pendingStep.expectedUrlPattern/expectedUrlChanges
//   attempts          -> session.stepAttemptCount/plannerAttemptCount + the
//                        real dynamic budget (session-store.js's exported
//                        maxPlannerCalls — same formula, not duplicated)
//   replanCount       -> session.replanCount (Phase 4 addition; undefined ->
//                        0 for a session created before this phase)
//   lastAction        -> session.lastActionResult/lastActionAt (Phase 4
//                        addition; null for an older session or before the
//                        first action of a new one)
//   completionStatus  -> derived from taskState/session.phase; SessionStore
//                        itself clears the session on completion (existing,
//                        unchanged behavior), so this is only ever "complete"
//                        for the brief window a caller passes taskState
//                        explicitly — once cleared, session is null and
//                        status is 'idle', not 'complete'. Documented, not a
//                        bug: SessionStore was never a completed-task log.
//   failureStatus     -> same shape as completionStatus, from taskState==='ERROR'
//   aborted           -> true only when taskState is explicitly passed as
//                        'IDLE' or 'ABORTED' by a caller that just aborted —
//                        SessionStore has no "this was aborted" flag of its
//                        own (clear() looks identical whether the task
//                        completed, failed, or was cancelled); v2-task.js
//                        passes { aborted: true } explicitly when it knows.

import { redactText } from './pii-detector.js';
import { maxPlannerCalls } from '../services/session-store.js';

// Coarser than TaskState — a handful of buckets meaningful to something
// displaying "what is ScreenPilot doing right now", not every state-machine
// micro-state (AWAITING_USER/VALIDATING/RECOVERING all read as "running").
export const ProgressStatus = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  ERROR: 'error',
  ABORTED: 'aborted'
});

const TASKSTATE_TO_STATUS = Object.freeze({
  IDLE: ProgressStatus.IDLE,
  PLANNING: ProgressStatus.PLANNING,
  EXECUTING: ProgressStatus.RUNNING,
  AWAITING_USER: ProgressStatus.RUNNING,
  VALIDATING: ProgressStatus.RUNNING,
  RECOVERING: ProgressStatus.RUNNING,
  PAUSED: ProgressStatus.PAUSED,
  COMPLETE: ProgressStatus.COMPLETE,
  ERROR: ProgressStatus.ERROR
});

const PHASE_TO_STATUS = Object.freeze({
  PLANNING: ProgressStatus.PLANNING,
  EXECUTING: ProgressStatus.RUNNING,
  PAUSED: ProgressStatus.PAUSED
});

export const TERMINAL_STATUSES = Object.freeze([ProgressStatus.COMPLETE, ProgressStatus.ERROR, ProgressStatus.ABORTED]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

function safe(text) {
  return typeof text === 'string' && text ? redactText(text) : text ?? null;
}

function summarizeStep(step) {
  if (!step) return null;
  return {
    description: safe(step.description),
    intent: safe(step.intent),
    completionCondition: step.completionCondition ?? null,
    completedAt: step.completedAt ?? null
  };
}

function deriveStatus(session, taskState, aborted) {
  if (aborted) return ProgressStatus.ABORTED;
  if (taskState && TASKSTATE_TO_STATUS[taskState]) return TASKSTATE_TO_STATUS[taskState];
  if (!session) return ProgressStatus.IDLE;
  return PHASE_TO_STATUS[session.phase] ?? ProgressStatus.RUNNING;
}

/**
 * @param {object|null} session - a SessionStore session (from SessionStore.load()),
 *   or null for "no active task" (also covers an expired session, which
 *   SessionStore.load() already resolves to null — see session-store.js).
 * @param {object} [options]
 * @param {string} [options.taskState] - the in-memory TaskState (transitions.js),
 *   when the caller has it — authoritative over session.phase when given,
 *   since it reflects micro-states (AWAITING_USER, VALIDATING, …) SessionStore
 *   never persists at that granularity.
 * @param {boolean} [options.aborted] - true when the caller just aborted the
 *   task and knows it (SessionStore.clear() alone can't distinguish an abort
 *   from a completion or a failure — see the module doc comment above).
 * @returns {object} TaskProgress — see the module doc comment for field mapping.
 */
export function deriveTaskProgress(session, { taskState, aborted = false } = {}) {
  const status = deriveStatus(session, taskState, aborted);

  if (!session) {
    return {
      goal: null,
      status,
      currentStep: null,
      completedSteps: { count: 0, steps: [] },
      remainingSteps: null,
      expectedState: null,
      attempts: null,
      replanCount: 0,
      lastAction: null,
      completion: { complete: status === ProgressStatus.COMPLETE, reason: null },
      failure: { failed: status === ProgressStatus.ERROR, reason: null },
      aborted: status === ProgressStatus.ABORTED,
      createdAt: null,
      updatedAt: null
    };
  }

  const completedSteps = Array.isArray(session.completedSteps) ? session.completedSteps : [];
  // Uses the already-normalized local array, not the raw session, so a
  // malformed/partial session object (missing completedSteps entirely) can
  // never throw here — resilience matters more than a raw session ever
  // actually being malformed in practice (SessionStore.create()/load() always
  // include it).
  const budget = maxPlannerCalls({ completedSteps });

  return {
    goal: safe(session.goal),
    status,
    currentStep: summarizeStep(session.pendingStep),
    completedSteps: { count: completedSteps.length, steps: completedSteps.map(summarizeStep) },
    // Always null — see the module doc comment: genuinely not tracked by the
    // current single-step-per-cycle architecture, never fabricated here.
    remainingSteps: null,
    expectedState: session.pendingStep
      ? {
          urlPattern: session.pendingStep.expectedUrlPattern ?? null,
          urlChanges: session.pendingStep.expectedUrlChanges ?? false
        }
      : null,
    attempts: {
      step: session.stepAttemptCount ?? 0,
      stepMax: 3, // MAX_STEP_ATTEMPTS in session-store.js — not exported as a constant import to keep this module's only session-store dependency the pure budget formula; both are small, stable, already-tested constants.
      planner: session.plannerAttemptCount ?? 0,
      plannerMax: budget
    },
    replanCount: session.replanCount ?? 0,
    lastAction: session.lastActionResult
      ? { result: session.lastActionResult, at: session.lastActionAt ?? null }
      : null,
    completion: { complete: status === ProgressStatus.COMPLETE, reason: status === ProgressStatus.COMPLETE ? 'goal_reached' : null },
    failure: { failed: status === ProgressStatus.ERROR, reason: status === ProgressStatus.ERROR ? (session.currentBlocker ?? null) : null },
    aborted: status === ProgressStatus.ABORTED,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null
  };
}
