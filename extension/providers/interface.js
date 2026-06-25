// ScreenPilot v2 — Backend Adapter Interface
//
// The extension never calls AI providers (Gemini, Claude, OpenAI) directly.
// All AI calls are proxied through the ScreenPilot backend. This file defines
// the contract that every backend adapter must satisfy.
//
// Current implementation: VercelBackendAdapter (Phase 2)
// Test implementation:     MockBackendAdapter (for unit testing engines)
//
// Usage:
//   import { BackendAdapter } from '../providers/interface.js';
//   class VercelBackendAdapter extends BackendAdapter { ... }

/**
 * BackendAdapter — abstract base class for ScreenPilot backend communication.
 *
 * All methods are async and return typed response objects. Errors are surfaced
 * as `{ success: false, error: string }` responses — adapters must NOT throw
 * for expected failure cases (network errors, quota limits, invalid responses).
 * Throwing is reserved for programmer errors (missing required arguments).
 *
 * @abstract
 */
export class BackendAdapter {
  /**
   * Unique identifier for this adapter (used in telemetry and logs).
   * @returns {string}
   */
  get name() {
    return 'BackendAdapter';
  }

  /**
   * Plan a full workflow from a goal and current page context.
   * Makes a POST /api/plan request to the backend.
   *
   * The backend runs Gemini (or another configured provider) to produce a
   * conditional linear ExecutionPlan with all steps upfront.
   *
   * @param {import('../shared/types/index.js').PlanRequest} request
   * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
   */
  async plan(request) {
    throw new Error(`${this.name} must implement plan(request)`);
  }

  /**
   * Request a corrected step or full replan after execution diverged.
   * Makes a POST /api/recover request to the backend.
   *
   * @param {import('../shared/types/index.js').RecoverRequest} request
   * @returns {Promise<import('../shared/types/index.js').RecoverResponse>}
   */
  async recover(request) {
    throw new Error(`${this.name} must implement recover(request)`);
  }

  /**
   * Explain what is currently visible on screen.
   * Used for the "Explain" widget button; does not affect plan execution.
   *
   * @param {{ screenshot: { image: string, mimeType: string }, pageContext: object }} request
   * @returns {Promise<{ success: boolean, screenContext?: object, error?: string }>}
   */
  async explain(request) {
    throw new Error(`${this.name} must implement explain(request)`);
  }

  /**
   * Answer a question about the current screen.
   * Used for the "Ask" widget button; does not affect plan execution.
   *
   * @param {{ screenshot: { image: string, mimeType: string }, question: string, pageContext: object }} request
   * @returns {Promise<{ success: boolean, answer?: string, confidence?: number, elementHint?: string, error?: string }>}
   */
  async ask(request) {
    throw new Error(`${this.name} must implement ask(request)`);
  }

  /**
   * Estimate the cost of a request before sending it.
   * Used for budget enforcement and telemetry.
   * Must be synchronous — called before the async request is issued.
   *
   * @param {'plan'|'recover'|'explain'|'ask'} operation
   * @param {object} request
   * @returns {{ inputTokens: number, outputTokens: number, estimatedUSD: number }}
   */
  estimateCost(operation, request) {
    throw new Error(`${this.name} must implement estimateCost(operation, request)`);
  }

  /**
   * Returns true when the adapter can currently accept requests.
   * Implementations should check quota, key validity, and network status.
   *
   * @returns {Promise<{ available: boolean, reason?: string }>}
   */
  async checkAvailability() {
    throw new Error(`${this.name} must implement checkAvailability()`);
  }
}

// ─── VALIDATION HELPER ────────────────────────────────────────────────────────

/**
 * Verify that an object conforms to the BackendAdapter interface.
 * Throws if any required method is missing.
 *
 * @param {object} adapter
 */
export function assertBackendAdapter(adapter) {
  const required = ['plan', 'recover', 'explain', 'ask', 'estimateCost', 'checkAvailability'];
  for (const method of required) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`BackendAdapter: "${adapter.name ?? 'unknown'}" is missing required method "${method}"`);
    }
  }
}
