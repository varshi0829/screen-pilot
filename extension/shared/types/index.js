// ScreenPilot v2 — Canonical Type Definitions
//
// All types used across the v2 engine pipeline are defined here.
// JavaScript consumers use the JSDoc @typedef for IDE support.
// Runtime constants (Object.freeze enums) provide shape validation at runtime.
//
// Import pattern (ES module):
//   import { ElementType, CompletionCondition, ValidationThreshold } from '../shared/types/index.js';

// ─── ELEMENT TYPES ────────────────────────────────────────────────────────────

/** @enum {string} */
export const ElementType = Object.freeze({
  BUTTON: 'button',
  LINK:   'link',
  INPUT:  'input',
  MENU:   'menu',
  ANY:    'any',
});

// ─── GOAL TYPES ───────────────────────────────────────────────────────────────

/** @enum {string} */
export const GoalType = Object.freeze({
  NAVIGATION: 'navigation',
  ACTION:     'action',
  MIXED:      'mixed',
});

// ─── COMPLETION CONDITIONS ────────────────────────────────────────────────────

/** @enum {string} */
export const CompletionCondition = Object.freeze({
  URL_CHANGE:          'url_change',
  DOM_CHANGE:          'dom_change',
  INPUT_FILLED:        'input_filled',
  ELEMENT_DISAPPEARS:  'element_disappears',
  FINAL:               'final',
});

// ─── STEP STATUS ──────────────────────────────────────────────────────────────

/** @enum {string} */
export const StepStatus = Object.freeze({
  PENDING:   'pending',
  EXECUTING: 'executing',
  COMPLETE:  'complete',
  SKIPPED:   'skipped',
  FAILED:    'failed',
});

// ─── VALIDATION ───────────────────────────────────────────────────────────────

/** @enum {string} */
export const ValidationRecommendation = Object.freeze({
  ADVANCE:  'ADVANCE',
  WAIT:     'WAIT',
  RECOVER:  'RECOVER',
});

/**
 * Validation confidence thresholds and timing.
 * Changing these affects the sensitivity of the validation pipeline.
 * ADVANCE: confidence at or above this → immediately advance to the next step.
 * WAIT: confidence between WAIT and ADVANCE → hold; wait for more signals.
 * Below WAIT (after window closes) → trigger recovery.
 * WINDOW_MS: maximum time to accumulate signals before forcing a decision.
 */
export const ValidationThreshold = Object.freeze({
  ADVANCE:   0.55,
  WAIT:      0.25,
  WINDOW_MS: 2500,
});

/**
 * Weights for individual validation signals.
 * Sum of all positive weights can exceed 1.0; confidence is capped at 1.0.
 * Negative weights penalize misleading signals.
 */
export const SignalWeight = Object.freeze({
  URL_CHANGED:              0.35,
  URL_MATCHES_EXPECTED:     0.30,
  URL_WRONG_DESTINATION:   -0.15,
  TARGET_ELEMENT_GONE:      0.20,
  DOM_SIGNATURE_CHANGED:    0.12,
  TITLE_CHANGED:            0.08,
  COMPLETION_CONDITION_MET: 0.25,
  INPUT_FILLED:             0.30,
});

// ─── RECOVERY ─────────────────────────────────────────────────────────────────

/** @enum {string} */
export const RecoveryTrigger = Object.freeze({
  ELEMENT_NOT_FOUND:      'ELEMENT_NOT_FOUND',
  LOW_VALIDATION:         'LOW_VALIDATION',
  UNEXPECTED_NAVIGATION:  'UNEXPECTED_NAVIGATION',
  USER_REQUESTED:         'USER_REQUESTED',
  TIMEOUT:                'TIMEOUT',
  QUOTA_ERROR:            'QUOTA_ERROR',
  PRECONDITION_FAILED:    'PRECONDITION_FAILED',
});

/** @enum {string} */
export const RecoveryStrategy = Object.freeze({
  STEP_CORRECT:     'STEP_CORRECT',
  REPLAN:           'REPLAN',
  CONFIRM_COMPLETE: 'CONFIRM_COMPLETE',
  WAIT_AND_RETRY:   'WAIT_AND_RETRY',
  SKIP_STEP:        'SKIP_STEP',
  ABORT:            'ABORT',
});

// ─── ELEMENT RESOLUTION ───────────────────────────────────────────────────────

/** Minimum DOMMatcher score to accept an element as resolved. */
export const ElementResolutionThreshold = Object.freeze({
  PRIMARY:   60,
  RECOVERY:  50,
  REGION:    50,
});

// ─── TYPE DEFINITIONS (JSDoc) ─────────────────────────────────────────────────
// These @typedef blocks provide IDE intellisense. They carry no runtime cost.

/**
 * @typedef {Object} PlanStepTarget
 * @property {string} text - Primary element text for DOMMatcher
 * @property {ElementType[keyof ElementType]} type - Element type hint
 * @property {string} [region] - Page region ('top_navigation', 'main_content', etc.)
 * @property {string[]} [alternatives] - Fallback texts tried in order
 * @property {string} intent - Semantic description of what this element does;
 *   stable across UI copy changes; used by recovery to search for alternatives
 */

/**
 * @typedef {Object} PlanStepPrecondition
 * @property {string} [urlContains] - window.location.href must include this string
 * @property {string} [urlPattern] - RegExp-compatible pattern the URL must match
 * @property {string} [elementPresent] - Accessible text that must be in the DOM
 * @property {string} [titleContains] - document.title must include this string
 */

/**
 * @typedef {Object} PlanStepExpectedState
 * @property {string} [urlPattern] - URL pattern expected after this action completes
 * @property {boolean} [urlChanges] - Whether a URL change is expected at all
 * @property {string} [titleContains] - Substring expected in document.title after action
 */

/**
 * A single step in a conditional linear execution plan.
 *
 * @typedef {Object} PlanStep
 * @property {number} id - 1-based step index within the plan
 * @property {string} description - Human-readable step description shown in UI
 * @property {string} intent - Semantic intent; stable when UI copy changes
 * @property {string} phase - Phase group name (e.g. 'navigate', 'fill_form', 'submit')
 * @property {boolean} optional - If true, skip without recovery when element not found
 * @property {number} timeout_ms - Validation window duration for this step
 * @property {CompletionCondition[keyof CompletionCondition]} completionCondition
 * @property {PlanStepTarget} targetElement
 * @property {PlanStepPrecondition} [precondition]
 * @property {PlanStepExpectedState} [expectedPageState]
 * @property {boolean} reversible - False for destructive actions (delete, send, publish)
 * @property {StepStatus[keyof StepStatus]} [status]
 */

/**
 * A full conditional linear execution plan returned by the Planner.
 *
 * @typedef {Object} ExecutionPlan
 * @property {string} planId - Unique identifier for this plan instance
 * @property {string} goal - Original goal string
 * @property {GoalType[keyof GoalType]} goalType - 'navigation', 'action', or 'mixed'
 * @property {PlanStep[]} steps - Ordered steps; may contain optional steps
 * @property {number} currentStepIndex - Index of the active step (0-based)
 * @property {number} planVersion - Incremented on replanning; starts at 1
 * @property {number} confidence - Planner's confidence in this plan (0–1)
 * @property {number} createdAt - Unix timestamp (ms)
 * @property {string} [applicationId] - Detected application fingerprint
 * @property {Record<string, unknown>} [metadata] - Provider-specific metadata
 */

/**
 * DOM and page state captured immediately before a user action.
 * Used as the baseline for validation signal comparison.
 *
 * @typedef {Object} PageSnapshot
 * @property {string} url - window.location.href at capture time
 * @property {string} title - document.title at capture time
 * @property {string} domHash - FNV-32a hash of visible interactive element texts
 * @property {string} highlightedElementText - Accessible text of the highlighted element
 * @property {number} capturedAt - Unix timestamp (ms)
 */

/**
 * Evidence breakdown from individual validation signals.
 * Each field is true when the corresponding signal fired.
 *
 * @typedef {Object} SignalEvidence
 * @property {boolean} urlChanged
 * @property {boolean} urlMatchesExpected
 * @property {boolean} urlWrongDestination
 * @property {boolean} targetElementGone
 * @property {boolean} domSignatureChanged
 * @property {boolean} titleChanged
 * @property {boolean} completionConditionMet
 * @property {boolean} inputFilled
 */

/**
 * Output of a single ValidationEngine evaluation pass.
 *
 * @typedef {Object} ValidationResult
 * @property {boolean} passed - True when recommendation is ADVANCE
 * @property {number} confidence - Weighted signal sum, clamped 0–1
 * @property {SignalEvidence} evidence - Per-signal breakdown
 * @property {ValidationRecommendation[keyof ValidationRecommendation]} recommendation
 * @property {number} evaluatedAt - Unix timestamp (ms)
 */

/**
 * Context passed to RecoveryEngine when the pipeline stalls.
 *
 * @typedef {Object} RecoveryContext
 * @property {RecoveryTrigger[keyof RecoveryTrigger]} trigger
 * @property {PlanStep} failedStep
 * @property {ExecutionPlan} plan
 * @property {ValidationResult} [validationResult]
 * @property {number} attemptCount - Total recovery attempts for this goal so far
 * @property {PageSnapshot} [snapshot]
 */

/**
 * Output of RecoveryEngine strategy selection.
 *
 * @typedef {Object} RecoveryDecision
 * @property {RecoveryStrategy[keyof RecoveryStrategy]} strategy
 * @property {boolean} shouldAbort
 * @property {string} promptHint - Context hint to include in the recovery prompt
 * @property {string} reason - Human-readable reason for logging
 */

/**
 * Output of CompletionEngine evaluation.
 *
 * @typedef {Object} CompletionResult
 * @property {boolean} complete
 * @property {boolean} requiresAIConfirm - True when local signals are ambiguous
 * @property {number} confidence
 * @property {string} reason - How completion was determined
 */

// ─── BACKEND API CONTRACTS ────────────────────────────────────────────────────

/**
 * Namespaced extension bag — every namespace is provider- or domain-scoped.
 * Adding a new namespace never collides with existing ones.
 *
 * @typedef {Object} ExtensionBag
 * @property {Record<string, unknown>} [gemini]     - Gemini-specific flags (safetySettings, thinkingBudget override)
 * @property {Record<string, unknown>} [enterprise] - Enterprise-specific context beyond applicationMetadata
 * @property {Record<string, unknown>} [memory]     - Memory/RAG context injected by workflow memory providers
 */

/**
 * Request body sent to POST /api/plan.
 *
 * This is the stable Planner interface. All fields beyond `goal` and `page` are
 * optional so that minimal callers and full-context callers share the same contract.
 * New planner implementations consume whichever fields they need; the rest are ignored.
 *
 * @typedef {Object} PlanRequest
 * @property {"1"} [schemaVersion]          - Schema version; defaults to "1"
 * @property {string} [requestId]           - Caller-generated UUID echoed in the response
 * @property {string} goal                  - The user's goal in natural language
 *
 * @property {Object} page                  - Current page context (always required)
 * @property {string} page.url
 * @property {string} page.title
 * @property {{ image: string, mimeType?: string }} page.screenshot
 *
 * @property {{ url: string, title: string }} [previousPage] - Absent on the first invocation
 *
 * @property {Object} [executionHistory]    - Steps already completed in this session
 * @property {Array<{ description: string, intent: string, completedAt?: number }>} executionHistory.completedSteps
 * @property {number} executionHistory.planVersion   - How many times the plan has been regenerated
 * @property {number} executionHistory.attemptCount  - Total recovery attempts for this goal
 *
 * @property {Object} [workflowMemory]      - Cross-step extracted data and visited locations
 * @property {string} [workflowMemory.application]
 * @property {string[]} [workflowMemory.visitedUrls]
 * @property {Record<string, unknown>} [workflowMemory.extractedData] - Form values, IDs, names gathered so far
 *
 * @property {Object} [recoveryContext]     - Present only when re-planning after a failure
 * @property {string} recoveryContext.trigger        - RecoveryTrigger enum value
 * @property {string} recoveryContext.reason         - Human-readable; injected into the planner prompt
 * @property {string} [recoveryContext.failedStepIntent] - Semantic intent of the step that failed
 *
 * @property {Object} [preferences]
 * @property {boolean} [preferences.confirmDestructiveActions]
 * @property {number}  [preferences.maxSteps]
 * @property {string}  [preferences.language] - BCP 47 (e.g. "en", "fr") for localised instructions
 *
 * @property {Object} [applicationMetadata] - Detected externally or by a prior call
 * @property {string} [applicationMetadata.application]
 * @property {string} [applicationMetadata.module]
 * @property {string} [applicationMetadata.workspace]
 * @property {string} [applicationMetadata.pageType]
 * @property {string[]} [applicationMetadata.navigationHierarchy]
 * @property {number}  [applicationMetadata.confidence] - 0–1; planner skips this if below its own threshold
 *
 * @property {ExtensionBag} [extensions]
 */

/**
 * Response from POST /api/plan.
 *
 * `result` and `state` are deliberately separate concerns:
 *   result — did the transport and provider layer succeed? (OK | NEEDS_USER | FAILED)
 *   state  — what did the planner determine about the goal? (planned | blocked | complete | ambiguous)
 *
 * `state` is always present when result !== "FAILED".
 * `plan`  is always present when state === "planned".
 *
 * @typedef {Object} PlanResponse
 * @property {"1"} schemaVersion
 * @property {string} [requestId]     - Echoed from the request for correlation
 *
 * @property {"OK"|"NEEDS_USER"|"FAILED"} result
 *   - OK:         Planner ran and produced actionable output.
 *   - NEEDS_USER: Planner ran but needs a clarification or confirmation from the user
 *                 before the engine can proceed (e.g. ambiguous path, destructive action).
 *   - FAILED:     Infrastructure or provider failure; execution cannot continue.
 *
 * @property {"planned"|"blocked"|"complete"|"ambiguous"} [state]
 *   - planned:   ExecutionPlan is ready and steps are safe to execute.
 *   - blocked:   A precondition is unmet (auth wall, permission gap). See blockers[].
 *   - complete:  Goal is already achieved; no steps required.
 *   - ambiguous: Multiple valid execution paths exist; surface to the user.
 *
 * @property {ExecutionPlan} [plan]           - Present when state === "planned"
 *
 * @property {Object} [interpretation]        - Planner's world-model; useful for UI and A/B testing
 * @property {"navigation"|"action"|"mixed"} interpretation.goalType
 * @property {string} interpretation.application       - Detected app name
 * @property {string} interpretation.pageType          - Detected current page type
 * @property {string} [interpretation.destinationPageType]
 * @property {boolean} interpretation.navigationRequired
 * @property {boolean} interpretation.authenticated
 * @property {string} [interpretation.currentActivity]
 *
 * @property {string[]} blockers              - Always present; empty when not blocked
 * @property {number} confidence              - Planner's confidence in the plan (0–1)
 *
 * @property {string} [plannerSummary]
 *   Concise 1–2 sentence explanation of why the planner chose this approach.
 *   NOT chain-of-thought; suitable for display in UI and telemetry dashboards.
 *
 * @property {Object} providerMetadata        - Which AI ran, which model, timing, token counts
 * @property {string} providerMetadata.provider       - "gemini" | "claude" | "openai" | "mock"
 * @property {string} providerMetadata.model
 * @property {string} providerMetadata.plannerVersion - Version of the prompt/planner logic
 * @property {number} providerMetadata.latencyMs
 * @property {number} [providerMetadata.inputTokens]
 * @property {number} [providerMetadata.outputTokens]
 *
 * @property {ExtensionBag} [extensions]
 *
 * @property {string} [error]                 - Human-readable; present when result === "FAILED"
 * @property {string} [errorCode]             - Machine-readable: "QUOTA_EXCEEDED" | "TIMEOUT" | "PARSE_ERROR" | ...
 */

/**
 * Request body sent to POST /api/recover
 *
 * @typedef {Object} RecoverRequest
 * @property {string} goal
 * @property {{ image: string, mimeType: string }} screenshot
 * @property {{ url: string, title: string }} pageContext
 * @property {PlanStep} failedStep
 * @property {string[]} completedStepDescriptions
 * @property {RecoveryTrigger[keyof RecoveryTrigger]} triggerType
 * @property {RecoveryStrategy[keyof RecoveryStrategy]} strategy
 */

/**
 * Response from POST /api/recover
 *
 * @typedef {Object} RecoverResponse
 * @property {boolean} success
 * @property {'step'|'plan'|'complete'} type
 * @property {PlanStep} [step] - Corrected step (when type === 'step')
 * @property {ExecutionPlan} [plan] - New full plan (when type === 'plan')
 * @property {boolean} [complete] - Goal already achieved (when type === 'complete')
 * @property {string[]} [blockers]
 * @property {number} confidence
 * @property {string} [error]
 */
