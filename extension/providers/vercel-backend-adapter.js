// ScreenPilot v2 — Vercel Backend Adapter
//
// Implements BackendAdapter for the ScreenPilot Vercel deployment.
// The extension never calls AI providers directly; all AI calls are proxied here.
//
// Provider API keys are server-side only (Phase 2) — this adapter never holds
// or sends one; the backend resolves its own key from its own environment.
//
// Usage:
//   import { VercelBackendAdapter } from './vercel-backend-adapter.js';
//   const backend = new VercelBackendAdapter();
//   const response = await backend.plan(planRequest);

import { BackendAdapter } from './interface.js';

const DEFAULT_BASE_URL = 'https://screen-pilot-j1az.vercel.app';

// Gemini-2.5-flash pricing (approximate, per token)
const USD_PER_INPUT_TOKEN  = 0.00000025;
const USD_PER_OUTPUT_TOKEN = 0.00000075;

export class VercelBackendAdapter extends BackendAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]    - Backend base URL (defaults to Vercel deployment)
   * @param {string} [options.sessionId]  - Session identifier for rate limiting and telemetry
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, sessionId } = {}) {
    super();
    this._baseUrl   = baseUrl.replace(/\/$/, '');
    this._sessionId = sessionId ?? crypto.randomUUID().slice(0, 16);
  }

  get name() { return 'VercelBackendAdapter'; }

  /**
   * Plan a full workflow from a goal and current page context.
   * Calls POST /api/plan and returns a PlanResponse.
   *
   * @param {import('../shared/types/index.js').PlanRequest} request
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
   */
  async plan(request, options = {}) {
    return this._post('/api/plan', request, options);
  }

  /**
   * Request a corrected step or full replan after execution diverged.
   * Calls POST /api/recover and returns a RecoverResponse.
   *
   * @param {import('../shared/types/index.js').RecoverRequest} request
   * @param {object} [options]
   * @returns {Promise<import('../shared/types/index.js').RecoverResponse>}
   */
  async recover(request, options = {}) {
    return this._post('/api/recover', request, options);
  }

  /**
   * Explain what is currently visible on screen.
   *
   * @param {{ screenshot: { image: string, mimeType: string }, pageContext: object }} request
   * @param {object} [options]
   * @returns {Promise<{ success: boolean, screenContext?: object, error?: string }>}
   */
  async explain({ screenshot, pageContext = {} }, options = {}) {
    return this._post('/api/analyze', {
      screenshot,
      pageContext,
      goal: 'Explain what is visible on this screen',
      mode: 'explain',
    }, options);
  }

  /**
   * Answer a question about the current screen.
   *
   * @param {{ screenshot: { image: string, mimeType: string }, question: string, pageContext: object }} request
   * @param {object} [options]
   * @returns {Promise<{ success: boolean, answer?: string, confidence?: number, elementHint?: string, error?: string }>}
   */
  async ask({ screenshot, question, pageContext = {} }, options = {}) {
    return this._post('/api/analyze', {
      screenshot,
      goal: question,
      pageContext,
      mode: 'ask',
    }, options);
  }

  /**
   * Estimate the token cost of a request before sending it.
   * Synchronous — called before the async request is issued.
   *
   * @param {'plan'|'recover'|'explain'|'ask'} operation
   * @param {object} request
   * @returns {{ inputTokens: number, outputTokens: number, estimatedUSD: number }}
   */
  estimateCost(operation, request) {
    // Base64 image: ~4 bytes → 1 token (rough approximation for vision models)
    const imageBytes  = request?.page?.screenshot?.image?.length
                     ?? request?.screenshot?.image?.length
                     ?? 0;
    const imageTokens = Math.ceil(imageBytes / 4);
    const promptTokens = 800;  // prompt overhead

    const outputTokens = operation === 'plan' ? 1500 : 512;
    const inputTokens  = imageTokens + promptTokens;

    return {
      inputTokens,
      outputTokens,
      estimatedUSD: inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN,
    };
  }

  /**
   * Returns whether this adapter can currently accept requests.
   * A full implementation would ping a /health endpoint or check quota state.
   *
   * @returns {Promise<{ available: boolean, reason?: string }>}
   */
  async checkAvailability() {
    return { available: true };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Send a POST request to the backend and return the parsed JSON response.
   * Network and HTTP errors are caught and returned as FAILED PlanResponse shapes
   * so callers never need to handle thrown exceptions.
   *
   * @param {string} path
   * @param {object} body
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<object>}
   */
  async _post(path, body, options = {}) {
    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
      'X-Session-ID': this._sessionId,
    };

    // 30 s client-side timeout — matches the Vercel function's own budget ceiling.
    // Without this, a stalled connection hangs the service worker indefinitely.
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 30_000);

    const callerSignal = options?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
      }
    }

    let response;
    try {
      response = await fetch(`${this._baseUrl}${path}`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const isCallerAborted = callerSignal?.aborted;
      const isTimeout       = err instanceof Error && err.name === 'AbortError' && !isCallerAborted;
      const message         = isCallerAborted
        ? `Request to ${path} was aborted`
        : isTimeout
          ? `Request to ${path} timed out after 30s`
          : (err instanceof Error ? err.message : String(err));
      const errorCode       = isCallerAborted ? 'ABORTED' : isTimeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
      console.error(`[VercelBackendAdapter] ${isCallerAborted ? 'Aborted' : isTimeout ? 'Timeout' : 'Network error'} on ${path}:`, message);
      return this._networkFailure(message, errorCode);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      console.error(`[VercelBackendAdapter] Non-JSON response from ${path} (status ${response.status})`);
      return this._networkFailure(`Non-JSON response from ${path}`, 'PARSE_ERROR');
    }

    if (!response.ok) {
      const error     = data?.error     ?? `HTTP ${response.status}`;
      const errorCode = data?.errorCode ?? 'HTTP_ERROR';
      console.error(`[VercelBackendAdapter] ${path} → ${response.status}:`, error);
      // Spread server data first, then overwrite result/error/errorCode so our
      // sentinel values always win regardless of what the server body contains.
      return { blockers: [], confidence: 0, ...data, result: 'FAILED', error, errorCode };
    }

    return data;
  }

  /**
   * Synthesize a minimal FAILED PlanResponse for network-layer errors.
   * Keeps the shape consistent with what /api/plan returns for provider failures.
   *
   * @param {string} error
   * @param {string} errorCode
   * @returns {object}
   */
  _networkFailure(error, errorCode) {
    return {
      schemaVersion:    '1',
      result:           'FAILED',
      blockers:         [],
      confidence:       0,
      providerMetadata: { provider: 'gemini', model: 'unknown', plannerVersion: 'unknown', latencyMs: 0 },
      error,
      errorCode,
    };
  }
}
