// ScreenPilot — Backend request proxy (service worker side) and the single
// backend HTTP implementation.
//
// Why: a content script runs with the PAGE's origin. From an https:// page,
// Chrome blocks a request to a loopback backend ("Permission was denied for this
// request to access the `loopback` address space"). The service worker is not
// subject to that, so planner requests are sent here as BACKEND_REQUEST messages
// (see providers/vercel-backend-adapter.js), mirroring ollama-proxy.js.
//
// Security properties, all enforced here and not by the sender:
//   • The destination is NEVER taken from the message. It is resolved from the
//     one configured backend URL (lib/backend-config.js) and re-validated.
//   • Only fixed API paths are reachable; only fixed, non-credential headers
//     are forwarded; requests carry no cookies/credentials.
//   • Only messages from this extension's own contexts are served.
//   • The extension holds no provider credential, so none is ever sent.
//
// backendRequest() is the only place the backend is fetched for planning. It
// touches no chrome.* APIs, so it is unit-testable with a stubbed fetch.

import { normalizeBackendUrl, resolveBackendBaseUrl } from '../lib/backend-config.js';

export const BACKEND_PATHS = Object.freeze(['/api/plan', '/api/recover', '/api/analyze']);
const FORWARDED_HEADERS = Object.freeze(['content-type', 'x-session-id']);
export const DEFAULT_BACKEND_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 16 * 1024 * 1024;

const inFlight = new Map();

function fail(errorCode, message, extra = {}) {
  return { networkError: true, errorCode, message, ...extra };
}

/**
 * POST JSON to the backend.
 *
 * @param {object} req
 * @param {string} req.baseUrl     validated again here
 * @param {string} req.path        one of BACKEND_PATHS
 * @param {object} req.body        JSON-serialisable object
 * @param {Record<string,string>} [req.headers]  filtered to FORWARDED_HEADERS
 * @param {number} [req.timeoutMs]
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<
 *   | { networkError: true, errorCode: 'INVALID_REQUEST'|'ABORTED'|'REQUEST_TIMEOUT'|'NETWORK_ERROR', message: string }
 *   | { parseError: true, status: number }
 *   | { ok: boolean, status: number, data: object }>}
 */
export async function backendRequest({ baseUrl, path, body, headers = {}, timeoutMs, signal }) {
  const base = normalizeBackendUrl(baseUrl);
  if (!base.ok) return fail('INVALID_REQUEST', `Invalid backend URL: ${base.error}`);
  if (!BACKEND_PATHS.includes(path)) return fail('INVALID_REQUEST', `Unsupported backend path: ${String(path).slice(0, 40)}`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_REQUEST', 'Request body must be a JSON object');

  let payload;
  try { payload = JSON.stringify(body); } catch { return fail('INVALID_REQUEST', 'Request body is not serialisable'); }
  if (payload.length > MAX_BODY_CHARS) return fail('INVALID_REQUEST', 'Request body too large');

  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (FORWARDED_HEADERS.includes(String(k).toLowerCase()) && typeof v === 'string') safeHeaders[k] = v;
  }

  const ms = (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : DEFAULT_BACKEND_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('backend_timeout'), ms);
  if (signal) {
    if (signal.aborted) controller.abort('caller_cancelled');
    else signal.addEventListener('abort', () => controller.abort('caller_cancelled'), { once: true });
  }

  let response;
  try {
    response = await fetch(`${base.url}${path}`, {
      method: 'POST', headers: safeHeaders, body: payload, signal: controller.signal, credentials: 'omit'
    });
  } catch (err) {
    clearTimeout(timer);
    const cancelled = controller.signal.reason === 'caller_cancelled';
    const timedOut = !cancelled && err?.name === 'AbortError';
    return fail(cancelled ? 'ABORTED' : timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      cancelled ? `Request to ${path} was aborted` : timedOut ? `Request to ${path} timed out after ${Math.round(ms / 1000)}s` : (err?.message || String(err)));
  }

  let data;
  try { data = await response.json(); } catch { clearTimeout(timer); return { parseError: true, status: response.status }; }
  clearTimeout(timer);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { parseError: true, status: response.status };
  return { ok: response.ok, status: response.status, data };
}

/**
 * BACKEND_REQUEST handler. `message` = { reqId, path, body, headers, timeoutMs };
 * any `url`/`baseUrl` field in it is ignored by design.
 */
export async function handleBackendRequest(message, sender, { storageArea } = {}) {
  if (sender && typeof chrome !== 'undefined' && chrome?.runtime?.id && sender.id !== chrome.runtime.id) {
    return fail('INVALID_REQUEST', 'Rejected: sender is not this extension');
  }
  const reqId = message?.reqId || `req_be_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const controller = new AbortController();
  inFlight.set(reqId, controller);
  try {
    const baseUrl = await resolveBackendBaseUrl(storageArea ?? (typeof chrome !== 'undefined' ? chrome.storage?.local : null));
    return await backendRequest({
      baseUrl, path: message?.path, body: message?.body, headers: message?.headers,
      timeoutMs: message?.timeoutMs, signal: controller.signal
    });
  } finally {
    inFlight.delete(reqId);
  }
}

export function handleBackendCancel(message) {
  const c = inFlight.get(message?.reqId);
  if (c) c.abort('caller_cancelled');
  return { success: true, cancelled: !!c };
}
