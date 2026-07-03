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

  /**
   * Workflow interrupted by unexpected navigation, a back-button event,
   * or an auth redirect. Waiting for the user to choose Resume or Stop.
   * The session is preserved; re-planning happens if the user resumes.
   */
  PAUSED: 'PAUSED',

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

  // Architecture B — session resume and progressive planning
  //
  // SESSION_RESUME:   A valid session was found on content script init. Skip the
  //                   goal overlay and go directly to PLANNING on the current page.
  //
  // REPLAN_TRIGGERED: The current plan is exhausted on the same page (no navigation
  //                   occurred). The orchestrator calls /api/plan again immediately.
  //                   This is the key Architecture B loop-back transition.
  //
  // WORKFLOW_PAUSED:  Navigation classification returned UNKNOWN or BACK_BUTTON,
  //                   or the planner returned state=blocked.
  //                   The session is preserved; the user must decide to Resume or Stop.
  //
  // USER_RESUMED:     User clicked "Resume" from the PAUSED banner.
  //                   The orchestrator calls /api/plan on the current page with full history.
  //
  // PLAN_COMPLETE:    The planner returned state=complete — goal already achieved.
  //                   Transitions directly from PLANNING to COMPLETE without executing
  //                   any step. Architecture B only.
  SESSION_RESUME:    'SESSION_RESUME',
  REPLAN_TRIGGERED:  'REPLAN_TRIGGERED',
  WORKFLOW_PAUSED:   'WORKFLOW_PAUSED',
  USER_RESUMED:      'USER_RESUMED',
  PLAN_COMPLETE:     'PLAN_COMPLETE',

  // AMBIGUOUS_RECEIVED: Planner returned state=ambiguous while in PLANNING.
  //   Multiple valid execution paths exist and cannot be disambiguated from the
  //   screenshot alone. Session is paused (pauseReason='ambiguous') so the user
  //   can provide a clarification. Clears when the user submits clarification and
  //   USER_RESUMED fires to re-enter the plan loop.
  AMBIGUOUS_RECEIVED: 'AMBIGUOUS_RECEIVED',
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
    // Architecture B: valid session found on page load — resume without showing overlay
    [TaskEvent.SESSION_RESUME]:  TaskState.PLANNING,
    // Architecture B: URL classification returned UNKNOWN/BACK_BUTTON before any step ran
    [TaskEvent.WORKFLOW_PAUSED]: TaskState.PAUSED,
  },

  [TaskState.PLANNING]: {
    [TaskEvent.PLAN_RECEIVED]:   TaskState.EXECUTING,
    [TaskEvent.PLAN_FAILED]:     TaskState.ERROR,
    [TaskEvent.CANCEL_CLICKED]:  TaskState.IDLE,
    // Architecture B: planner confirmed goal already achieved — no step required
    [TaskEvent.PLAN_COMPLETE]:   TaskState.COMPLETE,
    // Architecture B: planner returned blocked; session paused for user to resolve precondition
    [TaskEvent.WORKFLOW_PAUSED]: TaskState.PAUSED,
    // Architecture B: planner returned ambiguous; session paused for user clarification
    [TaskEvent.AMBIGUOUS_RECEIVED]: TaskState.PAUSED,
  },

  [TaskState.EXECUTING]: {
    [TaskEvent.ELEMENT_READY]:     TaskState.AWAITING_USER,
    [TaskEvent.ELEMENT_NOT_FOUND]: TaskState.RECOVERING,
    // Architecture B: plan exhausted after a non-navigation step; re-plan on same page
    [TaskEvent.REPLAN_TRIGGERED]:  TaskState.PLANNING,
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
    // Architecture B: element:not_found recovery — replan from current state
    [TaskEvent.REPLAN_TRIGGERED]: TaskState.PLANNING,
    // Architecture B: step-attempt budget exhausted while recovering
    [TaskEvent.PLAN_FAILED]:      TaskState.ERROR,
    // Provider returned a corrected single step
    [TaskEvent.STEP_CORRECTED]:  TaskState.EXECUTING,
    // Provider returned a new full plan from current state
    [TaskEvent.REPLAN_RECEIVED]: TaskState.EXECUTING,
    // Attempts exhausted, quota error, or provider failure
    [TaskEvent.RECOVERY_FAILED]: TaskState.ERROR,
    [TaskEvent.CANCEL_CLICKED]:  TaskState.IDLE,
  },

  // Architecture B: workflow interrupted; waiting for user decision
  [TaskState.PAUSED]: {
    [TaskEvent.USER_RESUMED]:   TaskState.PLANNING,  // re-plan from current page with full history
    [TaskEvent.CANCEL_CLICKED]: TaskState.IDLE,
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
