// ScreenPilot — PII-safe structured event logging (Phase 3, extension side)
//
// Mirrors src/server/logger.ts's design and shares its source of truth for
// redaction (pii-detector.js), so extension-side and server-side
// observability follow one consistent, auditable rule: every string field
// value is redacted before it is ever written; a field whose NAME denotes a
// credential is redacted outright regardless of its value's shape. Never
// logs raw model output — pass a length/parsed flag, never the text itself.
//
// Output goes through console.log/warn/error (there is no server to ship
// structured logs to from a content script), prefixed [SP:EVENT] so it's
// filterable alongside the existing [SP:V2:*]/[SP:DecisionRouter]/etc. lines
// without replacing them — this is an additive, PII-safe observability
// layer, not a rework of existing logging.
//
// No logModelOutcome() here (unlike src/server/logger.ts): nothing at this
// layer ever sees a provider's raw response text — v2-task.js only ever
// receives the already-parsed plan response, so there is no raw-output value
// this module could accept without inventing an unused parameter.

import { redactText, isSensitiveKeyName } from './pii-detector.js';

const PREFIX = '[SP:EVENT]';
const MAX_DEPTH = 6;

function redactValue(key, value, depth) {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return isSensitiveKeyName(key) ? '[REDACTED]' : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  return value;
}

function write(sink, level, event, fields) {
  const safeFields = redactValue('', fields ?? {}, 0);
  sink(`${PREFIX} ${JSON.stringify({ event, level, ts: Date.now(), ...safeFields })}`);
}

export function logEvent(event, fields = {}) {
  write((line) => console.log(line), 'info', event, fields);
}

export function logWarn(event, fields = {}) {
  write((line) => console.warn(line), 'warn', event, fields);
}

export function logError(event, fields = {}) {
  write((line) => console.error(line), 'error', event, fields);
}
