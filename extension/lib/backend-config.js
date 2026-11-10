// ScreenPilot — Backend URL configuration (single source of truth).
//
// The extension talks to ONE backend gateway (src/app/api/*). Its address comes
// from exactly two places, in this order:
//   1. chrome.storage.local `screenPilotBackendUrl` — set from the popup's
//      Settings tab, so local development needs no source edit or rebuild;
//   2. DEFAULT_BACKEND_URL — the production deployment.
//
// Both the planner (VercelBackendAdapter, via v2-task.js) and the vision path
// (vision-service.js) resolve through resolveBackendBaseUrl(); the popup
// validates through normalizeBackendUrl(). Nothing else may hard-code a URL.
//
// Only a URL is ever stored here. Provider credentials are server-side only and
// are never read, stored or sent by the extension.

export const DEFAULT_BACKEND_URL = 'https://screen-pilot-j1az.vercel.app';
export const BACKEND_URL_STORAGE_KEY = 'screenPilotBackendUrl';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Older popups stored a full endpoint URL; accept and strip it.
const ENDPOINT_SUFFIX = /\/api\/(analyze|plan|recover)\/?$/;

/**
 * Validate and canonicalise a user-supplied backend URL to its base form
 * (no trailing slash, no endpoint path).
 *
 * Rejected: non-strings/empty, malformed URLs, non-http(s) schemes, embedded
 * credentials, query strings/fragments, and plain http to anything other than
 * a loopback host (requests carry page-derived data; cleartext is local-only).
 *
 * @param {unknown} value
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function normalizeBackendUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Backend URL is empty' };
  let u;
  try { u = new URL(value.trim()); } catch { return { ok: false, error: 'Enter a valid http(s) URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Backend URL must use http or https' };
  if (u.username || u.password) return { ok: false, error: 'Backend URL must not contain credentials' };
  if (u.search || u.hash) return { ok: false, error: 'Backend URL must not contain a query string or fragment' };
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) {
    return { ok: false, error: 'Plain http is only allowed for localhost; use https' };
  }
  const path = u.pathname.replace(ENDPOINT_SUFFIX, '').replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path}` };
}

/**
 * The backend base URL to use right now. A missing override yields the
 * production default; an invalid stored override is ignored (with a warning)
 * rather than breaking every request.
 *
 * @param {{ get: (keys: string|string[]) => Promise<object> } | null | undefined} storageArea
 * @returns {Promise<string>}
 */
export async function resolveBackendBaseUrl(storageArea) {
  let stored;
  try {
    stored = (await storageArea?.get?.(BACKEND_URL_STORAGE_KEY))?.[BACKEND_URL_STORAGE_KEY];
  } catch {
    return DEFAULT_BACKEND_URL;
  }
  if (typeof stored !== 'string' || !stored.trim()) return DEFAULT_BACKEND_URL;
  const r = normalizeBackendUrl(stored);
  if (r.ok) return r.url;
  console.warn(`[SP:Config] Ignoring invalid ${BACKEND_URL_STORAGE_KEY}: ${r.error}; using default backend`);
  return DEFAULT_BACKEND_URL;
}
