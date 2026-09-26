// ScreenPilot backend gateway — structured, PII-safe logging.
//
// Every field value is passed through the SAME deterministic detector the
// extension uses (single source of truth — extension/lib/pii-detector.js):
// any email/phone/card/SSN/JWT/API-key/password-shaped substring is replaced
// with [REDACTED] before the line is ever written. A field whose NAME denotes
// a credential (e.g. "apiKey", "authorization") is redacted outright, so a key
// can never reach a log line even by being passed under the wrong name.
//
// This is the server's PII backstop for observability: callers are expected to
// pass already-safe values (never a raw provider key, never an unredacted
// model response), and this module is the last line of defense if one doesn't.
// It logs raw MODEL OUTPUT never — see logModelOutcome, which takes only a
// length and a parse-success boolean, never the text itself.

import { redactText, isSensitiveKeyName } from '../../extension/lib/pii-detector.js';
import type { LogFields } from './types';

const MAX_DEPTH = 6;

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return isSensitiveKeyName(key) ? '[REDACTED]' : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  return value;
}

function write(sink: (line: string) => void, level: string, event: string, fields: LogFields): void {
  const safeFields = redactValue('', fields, 0) as Record<string, unknown>;
  sink(JSON.stringify({ event, level, ts: new Date().toISOString(), ...safeFields }));
}

export function logEvent(event: string, fields: LogFields = {}): void {
  write((line) => console.log(line), 'info', event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  write((line) => console.warn(line), 'warn', event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  write((line) => console.error(line), 'error', event, fields);
}

/** Records that a model call finished — length and validity only, NEVER the text. */
export function logModelOutcome(event: string, fields: LogFields & { rawLength: number; parsedOk: boolean }): void {
  logEvent(event, fields);
}
