// ScreenPilot backend gateway — request validation + server-side PII backstop.
//
// Validation rules and error messages are extracted VERBATIM from the two
// routes (same required fields, same size limit, same messages) so the 400/413
// responses are byte-for-byte unchanged.
//
// The backstop: the extension's Phase 1 SanitizingAdapter already strips PII
// before a request leaves the browser (the primary defense). This is a SECOND,
// independent layer here on the server — belt-and-braces against a client that
// is old, modified, or buggy. Policy: REDACT-AND-LOG, never reject. A redacted
// COPY of the text fields is what actually gets sent to the provider; the
// screenshot is never touched (it is masked client-side by bounding box, not
// scanned server-side — no OCR in this phase). Every redaction is logged as a
// PII-safe event (type + count only, see logger.ts) so genuine gateway-level
// leaks are visible in the logs without ever recording the value.

import { redactText, findPII } from '../../extension/lib/pii-detector.js';
import { logEvent } from './logger';

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export interface ValidationError {
  error: string;
  status: number;
}

function err(error: string, status: number): ValidationError {
  return { error, status };
}

export interface PlanRequestBody {
  schemaVersion?: string;
  requestId?: string;
  goal: string;
  page: { url: string; title: string; screenshot: { image: string; mimeType?: string } };
  [k: string]: unknown;
}

export function validatePlanRequest(body: Partial<PlanRequestBody> | null): ValidationError | null {
  if (!body?.goal?.trim()) return err('goal is required.', 400);
  if (!body.page?.url) return err('page.url is required.', 400);
  if (!body.page?.screenshot?.image) return err('page.screenshot.image is required.', 400);
  if (body.page.screenshot.image.length > MAX_SCREENSHOT_BYTES) return err('Screenshot too large — zoom out and try again.', 413);
  return null;
}

export interface AnalyzeRequestBody {
  goal: string;
  screenshot: { image: string; mimeType?: string };
  [k: string]: unknown;
}

export function validateAnalyzeRequest(body: Partial<AnalyzeRequestBody> | null): ValidationError | null {
  if (!body?.goal?.trim()) return err('goal is required.', 400);
  if (!body.screenshot?.image) return err('screenshot.image is required.', 400);
  if (body.screenshot.image.length > MAX_SCREENSHOT_BYTES) return err('Screenshot too large. Please zoom out or reduce browser zoom level.', 413);
  return null;
}

// Keys whose string value is opaque/structural — must never be regex-scanned
// or altered (a base64 screenshot, ids, version markers).
const SKIP_KEYS = new Set(['image', 'mimeType', 'schemaVersion', 'requestId', 'sessionId', 'planId']);
const MAX_DEPTH = 12;

function backstopValue(value: unknown, tally: Record<string, number>, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (!value) return value;
    for (const span of findPII(value)) tally[span.type] = (tally[span.type] ?? 0) + 1;
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => backstopValue(v, tally, key, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SKIP_KEYS.has(k) ? v : backstopValue(v, tally, k, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact-and-log server-side PII backstop. Returns a deep copy with every
 * sensitive string irreversibly redacted (SKIP_KEYS, e.g. the screenshot,
 * pass through untouched); logs a `server_pii_backstop` event (types+counts
 * only) when anything was actually redacted, so a client-side gap is visible.
 * Never throws, never rejects the request — the redacted copy is always usable.
 */
export function applyPiiBackstop<T>(body: T, reqId: string, route: string): T {
  const tally: Record<string, number> = {};
  const safe = backstopValue(body, tally, '', 0) as T;
  if (Object.keys(tally).length) {
    logEvent('server_pii_backstop', { reqId, route, types: tally });
  }
  return safe;
}
