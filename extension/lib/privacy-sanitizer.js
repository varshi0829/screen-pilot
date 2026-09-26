// ScreenPilot v3 — Local Privacy Sanitizer (privacy-vision Phase 1)
//
// Detects and redacts sensitive DOM field content entirely locally, before a
// page state (or any bounding box derived from it) is eligible to leave the
// device in a cloud request. Small, dependency-free, and reusable by both
// PageStateService (text/value redaction) and ScreenshotService (pixel
// region redaction — see getSensitiveRegions).
//
// Detection only ever inspects local, already-extracted DOM signals (input
// type, autocomplete, label/placeholder/aria-label text, and the field's own
// text/value content) — nothing here makes a network call or depends on one.
//
// The actual detection rules (input types, autocomplete tokens, label
// keywords, PII/secret patterns) live in pii-detector.js — the single source
// of truth shared with the outgoing-text sanitizer and the field guard. This
// module keeps its original API and adds `sensitiveType` to redacted elements.

import { classifyElement } from './pii-detector.js';

export const REDACTED = '[REDACTED]';

/**
 * Decide whether a normalized page-state element (see page-state-service.js)
 * carries, or is structurally likely to carry, sensitive content that must
 * not leave the device.
 *
 * @param {object} el - normalized element ({ type, autocomplete, placeholder, ariaLabel, text, value, ... })
 * @returns {boolean}
 */
function isSensitiveElement(el) {
  return classifyElement(el) !== null;
}

/**
 * Return a redacted copy of a normalized element. Grounding metadata that is
 * not itself sensitive content (role, tag, id, region, bbox, visible,
 * enabled, placeholder, ariaLabel — i.e. what the field *is*, not what was
 * typed into it) is preserved unchanged; only `text`/`value` content is
 * replaced. Redacted elements are marked `sensitive: true` with the
 * deterministic `sensitiveType` (see pii-detector.js SensitiveType).
 * Non-sensitive elements are returned as-is.
 *
 * @param {object} el
 * @returns {object}
 */
function sanitizeElement(el) {
  const sensitiveType = classifyElement(el);
  if (!sensitiveType) return el;
  return {
    ...el,
    text:  el.text  ? REDACTED : el.text,
    value: el.value ? REDACTED : el.value,
    sensitive: true,
    sensitiveType
  };
}

/**
 * Sanitize a full elements array. Returns a new array; the input is left
 * untouched.
 *
 * @param {object[]} elements
 * @returns {object[]}
 */
function sanitizeElements(elements) {
  if (!Array.isArray(elements)) return elements;
  return elements.map(sanitizeElement);
}

/**
 * Collect the bounding boxes of sensitive elements, for masking the matching
 * regions of a screenshot before it is compressed/encoded.
 *
 * @param {object[]} elements
 * @returns {{x:number,y:number,width:number,height:number}[]}
 */
function getSensitiveRegions(elements) {
  if (!Array.isArray(elements)) return [];
  return elements
    .filter(isSensitiveElement)
    .map((el) => el.bbox)
    .filter((bbox) => bbox && bbox.width > 0 && bbox.height > 0);
}

export const PrivacySanitizer = {
  REDACTED,
  isSensitiveElement,
  getSensitiveType: classifyElement,
  sanitizeElement,
  sanitizeElements,
  getSensitiveRegions
};

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = PrivacySanitizer;
}
