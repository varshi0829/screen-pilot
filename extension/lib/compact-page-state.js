// ScreenPilot — Compact page-state representation (Phase 3)
//
// Produces a minimal, decision-relevant projection of a page-state object —
// the same shape PageStateService.extractPageState() returns (see
// docs/PAGE_STATE.md: {url, title, elements[], sensitiveRegions, timestamp})
// — WITHOUT importing page-state-service.js. This module has zero dependency
// on that file or any other V3-owned module: it is a pure, standalone
// transform over the documented element shape, so it can never conflict with
// V3-owned page-state extraction logic and needs no change if that logic
// changes, as long as the element shape it reads stays the same.
//
// It does not replace extractPageState(): L1/L2 still read the full element
// shape. Phase 6 uses toCompactElement() at the local-model prompt boundary
// (LocalQwenAdapter / LocalVisionAdapter prompt builders); v2-task.js's
// compact_state_built log remains the diagnostic consumer of the page-level
// projection.
//
// Sensitivity is RE-DERIVED here via PrivacySanitizer (the same Phase 1
// source of truth PageStateService itself uses), and a sensitive element's
// `name` is built ONLY from its static label (placeholder/ariaLabel), never
// from `text`/`value` — independent of whether the input was already
// sanitized upstream, so this module is safe even given a page-state object
// from different or future code that skipped that step.

import { PrivacySanitizer } from './privacy-sanitizer.js';

const DEFAULT_MAX_ELEMENTS = 150;
const MAX_NAME_LENGTH = 60;

function truncate(s) {
  return s.length > MAX_NAME_LENGTH ? s.slice(0, MAX_NAME_LENGTH) : s;
}

function bestName(el, sensitiveType) {
  if (sensitiveType) {
    // Never read text/value for a sensitive field — only its static label.
    const label = el.placeholder || el.ariaLabel || '';
    return label ? truncate(label) : PrivacySanitizer.REDACTED;
  }
  return truncate(el.text || el.placeholder || el.ariaLabel || '');
}

/**
 * Compact projection of ONE element — the single definition of "what a model
 * is shown about an element". Pure; applies no visibility filtering (that is
 * toCompactPageState's job). Sensitivity is re-derived here, so a sensitive
 * element never contributes text/value content, only its static label.
 *
 * @param {object} el - a PageStateService-shaped element
 * @returns {{id:string, role:string, name:string, type:string, sensitive:boolean, sensitiveType:string|null}}
 */
export function toCompactElement(el) {
  const sensitiveType = PrivacySanitizer.getSensitiveType(el);
  return {
    id: el.id,
    role: el.role,
    name: bestName(el, sensitiveType),
    type: el.tag,
    sensitive: sensitiveType !== null,
    sensitiveType
  };
}

/**
 * @param {{url?:string, title?:string, elements?: object[]}} pageState - a
 *   PageStateService-shaped object (or any object matching that shape)
 * @param {object} [options]
 * @param {number} [options.maxElements] - cap on visibleInteractiveElements,
 *   kept in the input's original order (no goal-relevance ranking — that's
 *   UIGroundingService's job, a V3-owned module this file deliberately does
 *   not depend on)
 * @returns {{url:string, title:string, visibleInteractiveElements: Array<{
 *   id:string, role:string, name:string, type:string, sensitive:boolean,
 *   sensitiveType:string|null}>}}
 */
export function toCompactPageState(pageState, { maxElements = DEFAULT_MAX_ELEMENTS } = {}) {
  const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];

  const visibleInteractiveElements = [];
  for (const el of elements) {
    if (!el || el.visible === false || el.enabled === false) continue;
    visibleInteractiveElements.push(toCompactElement(el));
    if (visibleInteractiveElements.length >= maxElements) break;
  }

  return {
    url: pageState?.url ?? '',
    title: pageState?.title ?? '',
    visibleInteractiveElements
  };
}

/** Approximate UTF-8 byte size of a JSON payload — for relative size comparisons/diagnostics only. */
export function estimatePayloadBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

/**
 * Diagnostics only — computed for logging; never changes what is actually
 * sent anywhere. Compares the size of the full `elements` array against the
 * compact projection, so the real, measured savings are visible even where
 * this module isn't (yet) wired into an actual outgoing payload.
 *
 * @param {{elements?: object[]}} pageState
 * @param {object} [options] - forwarded to toCompactPageState
 */
export function estimateCompactionSavings(pageState, options) {
  const compact = toCompactPageState(pageState, options);
  const rawBytes = estimatePayloadBytes(pageState?.elements ?? []);
  const compactBytes = estimatePayloadBytes(compact.visibleInteractiveElements);
  return {
    rawElementCount: Array.isArray(pageState?.elements) ? pageState.elements.length : 0,
    compactElementCount: compact.visibleInteractiveElements.length,
    rawBytes,
    compactBytes,
    reductionPct: rawBytes > 0 ? Math.round((1 - compactBytes / rawBytes) * 100) : 0
  };
}
