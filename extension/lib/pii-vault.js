// ScreenPilot — Per-task token vault + outgoing-text sanitizers
//
// TokenVault maps reversible placeholders ([EMAIL_1], [PHONE_1]) to the real
// value, IN MEMORY ONLY. It is never written to chrome.storage / localStorage,
// never serialized, and never logged. It lives exactly as long as the object
// that owns it (one plan loop / one legacy request) — a page navigation, which
// reloads the content script, drops it by design.
//
// Only types whose policy is 'placeholder' (email, phone) ever enter the vault.
// Everything else (passwords, cards, JWTs, API keys, …) is irreversibly
// replaced with [REDACTED] and can never be restored or sent anywhere.
//
// sanitizeText / sanitizeUrl / sanitizeDeep produce the SAFE copy that may be
// handed to an external model; restoreDeep turns placeholders in the model's
// answer back into the user's real values for local display/matching.

import { SensitiveType, findPII, isSensitiveParamName, isSensitiveKeyName } from './pii-detector.js';
import { Outbound, outboundHandling } from './sensitive-policy.js';
import { REDACTED } from './privacy-sanitizer.js';

const TOKEN_LABEL = { [SensitiveType.EMAIL]: 'EMAIL', [SensitiveType.PHONE]: 'PHONE' };
const TOKEN_RE = /\[(EMAIL|PHONE)_(\d+)\]/g;

// Payload keys whose string values are opaque/structural and must pass through
// untouched (a base64 screenshot must never be regex-scanned or altered).
const SKIP_KEYS = new Set(['image', 'mimeType', 'schemaVersion', 'requestId', 'sessionId', 'planId']);
const MAX_DEPTH = 12;
const TRUNCATED = '[TRUNCATED]';

function normalizeForKey(type, value) {
  const v = String(value).trim();
  if (type === SensitiveType.EMAIL) return v.toLowerCase();
  if (type === SensitiveType.PHONE) return v.replace(/\D/g, '');
  return v;
}

export class TokenVault {
  #byToken = new Map();
  #byKey = new Map();
  #counters = {};

  /** Register a value and return its stable placeholder (same value → same token). */
  register(type, value) {
    const label = TOKEN_LABEL[type];
    if (!label) throw new Error(`TokenVault: type "${type}" is not tokenizable`);
    const key = `${type}:${normalizeForKey(type, value)}`;
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const n = (this.#counters[type] = (this.#counters[type] ?? 0) + 1);
    const token = `[${label}_${n}]`;
    this.#byKey.set(key, token);
    this.#byToken.set(token, String(value).trim());
    return token;
  }

  /** Replace any known placeholders in `text` with the real values. Unknown tokens are left as-is. */
  restore(text) {
    if (typeof text !== 'string' || !text || !text.includes('[')) return text;
    return text.replace(TOKEN_RE, (token) => this.#byToken.get(token) ?? token);
  }

  get size() {
    return this.#byToken.size;
  }

  clear() {
    this.#byToken.clear();
    this.#byKey.clear();
    this.#counters = {};
  }

  // Defense in depth: even JSON.stringify(vault) can never expose a value.
  toJSON() {
    return { tokens: this.size };
  }
}

function tallyOne(tally, type) {
  if (tally) tally[type] = (tally[type] ?? 0) + 1;
}

/**
 * Replace sensitive spans in free text: placeholders for email/phone, [REDACTED]
 * for everything else. Idempotent. `tally` (optional) receives { type: count }.
 */
export function sanitizeText(text, vault, tally = null) {
  if (typeof text !== 'string' || !text) return text;
  const spans = findPII(text);
  if (!spans.length) return text;
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start);
    out += outboundHandling(s.type) === Outbound.PLACEHOLDER
      ? vault.register(s.type, text.slice(s.start, s.end))
      : REDACTED;
    tallyOne(tally, s.type);
    last = s.end;
  }
  return out + text.slice(last);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function sanitizeParams(params, vault, tally) {
  return params
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return sanitizeText(pair, vault, tally);
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!value) return pair;
      if (isSensitiveParamName(safeDecode(name))) {
        tallyOne(tally, SensitiveType.SECRET);
        return `${name}=${REDACTED}`;
      }
      const decoded = safeDecode(value);
      const safe = sanitizeText(decoded, vault, tally);
      // Keep the original percent-encoding when nothing was sensitive.
      return safe === decoded ? pair : `${name}=${safe}`;
    })
    .join('&');
}

/**
 * Sanitize a URL: strips `user:pass@` credentials, redacts credential-like
 * query/fragment parameters by NAME, and sanitizes every other value and the
 * path by content. The origin/path structure is preserved so the URL still
 * tells the planner where the user is.
 */
export function sanitizeUrl(url, vault, tally = null) {
  if (typeof url !== 'string' || !url) return url;
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = beforeHash.indexOf('?');
  const query = qIdx >= 0 ? beforeHash.slice(qIdx + 1) : null;
  let base = qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash;

  if (/\/\/[^/@\s]+@/.test(base)) {
    base = base.replace(/\/\/[^/@\s]+@/, `//${REDACTED}@`);
    tallyOne(tally, SensitiveType.SECRET);
  }
  let out = sanitizeText(base, vault, tally);
  if (query !== null) out += `?${sanitizeParams(query, vault, tally)}`;
  if (fragment !== null) out += `#${sanitizeParams(fragment, vault, tally)}`;
  return out;
}

const URL_KEY_RE = /(?:url|urls|href)$/i;

/**
 * Deep-copy `value` with every string sanitized. URL-named keys go through
 * sanitizeUrl; credential-named keys are redacted outright; `SKIP_KEYS`
 * (e.g. the base64 screenshot) pass through untouched. Never mutates the input.
 * Fails closed: anything nested deeper than MAX_DEPTH is dropped.
 */
export function sanitizeDeep(value, vault, tally = null, key = '', depth = 0) {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === 'string') {
    if (key && isSensitiveKeyName(key)) {
      tallyOne(tally, SensitiveType.SECRET);
      return REDACTED;
    }
    return URL_KEY_RE.test(key) ? sanitizeUrl(value, vault, tally) : sanitizeText(value, vault, tally);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v, vault, tally, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SKIP_KEYS.has(k) ? v : sanitizeDeep(v, vault, tally, k, depth + 1);
    }
    return out;
  }
  return value;
}

/** Deep-copy `value` with placeholders restored to the real values (for local use only). */
export function restoreDeep(value, vault, depth = 0) {
  if (typeof value === 'string') return vault.restore(value);
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeep(v, vault, depth + 1);
    return out;
  }
  return value;
}
