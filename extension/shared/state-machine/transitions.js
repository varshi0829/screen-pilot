// ScreenPilot v2 — State Machine Vocabulary
//
// Defines all valid task states, the events that drive transitions between them,
// and the complete transition table. No logic lives here — only the vocabulary.
//
// The orchestrator is the sole entity that calls transition(). Engines emit
// events; they do not directly manipulate state.
//
// Usage:
//   import { TaskState, TaskEvent, TRANSITIONS, transition } from './transitions.js';

// ─── STATES ───────────────────────────────────────────────────────────────────

/**
 * All valid task lifecycle states.
 * @enum {string}
 */
export const TaskState = Object.freeze({
  /** No active task. Widget shows goal input. */
  IDLE: 'IDLE',

  /** Waiting for the backend to return an ExecutionPlan. */
  PLANNING: 'PLANNING',

  /** Plan received. Executor is resolving the current step's target element. */
  EXECUTING: 'EXECUTING',

  /** Element found and highlighted. Waiting for the user to take action. */
  AWAITING_USER: 'AWAITING_USER',

  /**
   * User acted. Collecting and scoring validation signals within the
   * step's timeout_ms window. Transitions immediately if confidence is
   * decisive before the window closes.
   */
  VALIDATING: 'VALIDATING',

  /**
   * Execution diverged from the plan. Recovery engine is classifying the
   * failure and selecting a strategy. May result in a provider call.
   */
  RECOVERING: 'RECOVERING',

  /** Goal successfully completed. */
  COMPLETE: 'COMPLETE',

  /** Unrecoverable failure or recovery attempts exhausted. */
  ERROR: 'ERROR',
});

// ─── EVENTS ───────────────────────────────────────────────────────────────────

/**
 * All events that can drive a state transition.
 * Events are emitted by engines and the UI; they are processed by the orchestrator.
 * @enum {string}
 */
export const TaskEvent = Object.freeze({
  // User-initiated
  GOAL_SUBMITTED:    'GOAL_SUBMITTED',
  STUCK_REQUESTED:   'STUCK_REQUESTED',
  CANCEL_CLICKED:    'CANCEL_CLICKED',
  RESET_CLICKED:     'RESET_CLICKED',
  DONE_CLICKED:      'DONE_CLICKED',

  // PlannerEngine outputs
  PLAN_RECEIVED:     'PLAN_RECEIVED',
  PLAN_FAILED:       'PLAN_FAILED',

  // ExecutorEngine outputs
  ELEMENT_READY:     'ELEMENT_READY',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',

  // Page signals (URL change, click on highlighted element, form submit)
  USER_ACTED:        'USER_ACTED',

  // ValidatorEngine outputs
  VALIDATION_PASSED:       'VALIDATION_PASSED',
  VALIDATION_INCONCLUSIVE: 'VALIDATION_INCONCLUSIVE',
  VALIDATION_FAILED:       'VALIDATION_FAILED',

  // CompletionEngine outputs (emitted on the final step only)
  FINAL_STEP_COMPLETE:  'FINAL_STEP_COMPLETE',
  FINAL_STEP_UNCERTAIN: 'FINAL_STEP_UNCERTAIN',

  // RecoveryEngine outputs
  STEP_CORRECTED:  'STEP_CORRECTED',
  REPLAN_RECEIVED: 'REPLAN_RECEIVED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
});

// ─── TRANSITION TABLE ─────────────────────────────────────────────────────────
//
// Format: TRANSITIONS[currentState][event] = nextState
//
// If an entry is missing, the event is ignored in that state (no transition).
// Guards (e.g., "only if final step") are enforced in the orchestrator before
// emitting the event, not in this table.

export const TRANSITIONS = Object.freeze({
  [TaskState.IDLE]: {
    [TaskEvent.GOAL_SUBMITTED]:  TaskState.PLANNING,
  },

  [TaskState.PLANNING]: {
    [TaskEvent.PLAN_RECEIVED]:   TaskState.EXECUTING,
    [TaskEvent.PLAN_FAILED]:     TaskState.ERROR,
    [TaskEvent.CANCEL_CLICKED]:  TaskState.IDLE,
  },

  [TaskState.EXECUTING]: {
    [TaskEvent.ELEMENT_READY]:     TaskState.AWAITING_USER,
    [TaskEvent.ELEMENT_NOT_FOUND]: TaskState.RECOVERING,
    [TaskEvent.CANCEL_CLICKED]:    TaskState.IDLE,
  },

  [TaskState.AWAITING_USER]: {
    [TaskEvent.USER_ACTED]:       TaskState.VALIDATING,
    [TaskEvent.STUCK_REQUESTED]:  TaskState.RECOVERING,
    [TaskEvent.CANCEL_CLICKED]:   TaskState.IDLE,
  },

  [TaskState.VALIDATING]: {
    // Non-final step: confidence crossed ADVANCE threshold
    [TaskEvent.VALIDATION_PASSED]:       TaskState.EXECUTING,
    // Final step: local signals confirm completion
    [TaskEvent.FINAL_STEP_COMPLETE]:     TaskState.COMPLETE,
    // Final step: signals too ambiguous for local determination
    [TaskEvent.FINAL_STEP_UNCERTAIN]:    TaskState.RECOVERING,
    // Signals still arriving within the timeout_ms window; re-evaluate
    [TaskEvent.VALIDATION_INCONCLUSIVE]: TaskState.VALIDATING,
    // Confidence below WAIT threshold after window closed
    [TaskEvent.VALIDATION_FAILED]:       TaskState.RECOVERING,
    [TaskEvent.CANCEL_CLICKED]:          TaskState.IDLE,
  },

  [TaskState.RECOVERING]: {
    // Provider returned a corrected single step
    [TaskEvent.STEP_CORRECTED]:  TaskState.EXECUTING,
    // Provider returned a new full plan from current state
    [TaskEvent.REPLAN_RECEIVED]: TaskState.EXECUTING,
    // Attempts exhausted, quota error, or provider failure
    [TaskEvent.RECOVERY_FAILED]: TaskState.ERROR,
    [TaskEvent.CANCEL_CLICKED]:  TaskState.IDLE,
  },

  [TaskState.COMPLETE]: {
    [TaskEvent.DONE_CLICKED]:   TaskState.IDLE,
  },

  [TaskState.ERROR]: {
    [TaskEvent.RESET_CLICKED]:  TaskState.IDLE,
    [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE,
  },
});

// ─── TRANSITION HELPER ────────────────────────────────────────────────────────

/**
 * Compute the next state for a given (current state, event) pair.
 * Returns null when the event is not valid in the current state.
 *
 * @param {TaskState[keyof TaskState]} currentState
 * @param {TaskEvent[keyof TaskEvent]} event
 * @returns {TaskState[keyof TaskState] | null}
 */
export function transition(currentState, event) {
  return TRANSITIONS[currentState]?.[event] ?? null;
}

/**
 * Returns true when the event is valid in the given state.
 *
 * @param {TaskState[keyof TaskState]} currentState
 * @param {TaskEvent[keyof TaskEvent]} event
 * @returns {boolean}
 */
export function isValidTransition(currentState, event) {
  return transition(currentState, event) !== null;
}

/**
 * Returns all events valid in a given state.
 *
 * @param {TaskState[keyof TaskState]} state
 * @returns {TaskEvent[keyof TaskEvent][]}
 */
export function validEventsFor(state) {
  return Object.keys(TRANSITIONS[state] ?? {});
}
