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
import { DEFAULT_BACKEND_URL as DEFAULT_BASE_URL, normalizeBackendUrl } from '../lib/backend-config.js';
import { backendRequest, DEFAULT_BACKEND_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from '../services/backend-proxy.js';

// Gemini-2.5-flash pricing (approximate, per token)
const USD_PER_INPUT_TOKEN  = 0.00000025;
const USD_PER_OUTPUT_TOKEN = 0.00000075;

export class VercelBackendAdapter extends BackendAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]    - Backend base URL, used only when running outside the extension (inside it,
   *                                        the service worker resolves the configured URL itself). Defaults to production; throws if invalid.
   * @param {Function} [options.transport] - Test seam: replaces the default transport
   * @param {string} [options.sessionId]  - Session identifier for rate limiting and telemetry
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, sessionId, transport } = {}) {
    super();
    const checked   = normalizeBackendUrl(baseUrl);
    if (!checked.ok) throw new Error(`Invalid backend URL: ${checked.error}`);
    this._baseUrl   = checked.url;
    this._sessionId = sessionId ?? crypto.randomUUID().slice(0, 16);
    this._transport = typeof transport === 'function' ? transport : (req) => this._defaultTransport(req);
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

    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      return this._networkFailure(`Request to ${path} was aborted`, 'ABORTED');
    }

    const result = await this._transport({ path, body, headers, timeoutMs: REQUEST_TIMEOUT_MS, signal: callerSignal });

    if (result.networkError) {
      console.error(`[VercelBackendAdapter] ${result.errorCode} on ${path}:`, result.message);
      return this._networkFailure(result.message, result.errorCode);
    }
    if (result.parseError) {
      console.error(`[VercelBackendAdapter] Non-JSON response from ${path} (status ${result.status})`);
      return this._networkFailure(`Non-JSON response from ${path}`, 'PARSE_ERROR');
    }

    const { ok, status, data } = result;
    if (!ok) {
      const error     = data?.error     ?? `HTTP ${status}`;
      const errorCode = data?.errorCode ?? 'HTTP_ERROR';
      console.error(`[VercelBackendAdapter] ${path} → ${status}:`, error);
      // Spread server data first, then overwrite result/error/errorCode so our
      // sentinel values always win regardless of what the server body contains.
      return { blockers: [], confidence: 0, ...data, result: 'FAILED', error, errorCode };
    }

    return data;
  }

  /**
   * Default transport. Inside the extension (content script) the request is sent
   * to the service worker (services/backend-proxy.js), which resolves the
   * destination from the one configured backend URL itself — this adapter never
   * chooses where the request goes, and a page-origin fetch is never made, so
   * Chrome's loopback restrictions for https pages do not apply. Outside the
   * extension (unit tests, Node) the same backendRequest() runs directly.
   * There is no second HTTP implementation here.
   */
  async _defaultTransport({ path, body, headers, timeoutMs, signal }) {
    const rt = typeof chrome !== 'undefined' ? chrome?.runtime : null;
    if (!rt?.sendMessage || !rt.id) {
      return backendRequest({ baseUrl: this._baseUrl, path, body, headers, timeoutMs, signal });
    }
    const reqId = `req_be_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const onAbort = () => { try { rt.sendMessage({ type: 'BACKEND_CANCEL', reqId }); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await new Promise((resolve) => {
        try {
          rt.sendMessage({ type: 'BACKEND_REQUEST', reqId, path, body, headers, timeoutMs }, (r) => {
            if (rt.lastError) resolve({ networkError: true, errorCode: 'NETWORK_ERROR', message: rt.lastError.message });
            else resolve(r);
          });
        } catch (err) {
          resolve({ networkError: true, errorCode: 'NETWORK_ERROR', message: err?.message || String(err) });
        }
      });
      if (!resp || typeof resp !== 'object') {
        return { networkError: true, errorCode: 'NETWORK_ERROR', message: 'No response from background script' };
      }
      if (signal?.aborted) return { networkError: true, errorCode: 'ABORTED', message: `Request to ${path} was aborted` };
      return resp;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
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
