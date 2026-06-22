// ScreenPilot - ScreenContext
// Normalizes and validates the screen understanding payload returned by Gemini.
// Produced once per analysis cycle from the same Gemini call that drives navigation.
// Used downstream by: StateManager (persistence), Phase 2 Explain, Phase 3 Q&A,
// Phase 6 ApplicationDetector.

export const ScreenContextService = (() => {
  'use strict';

  const VALID_PAGE_TYPES = [
    'list', 'detail', 'form', 'dashboard', 'editor', 'settings',
    'login', 'search', 'media', 'conversation', 'empty', 'error', 'other'
  ];

  /**
   * Build a validated ScreenContext from raw Gemini output.
   * All fields have safe defaults so callers never need to null-check.
   *
   * @param {object} raw - The parsed Gemini JSON response
   * @returns {ScreenContext}
   */
  function buildScreenContext(raw) {
    return {
      application:       normalizeString(raw?.application),
      pageType:          normalizePageType(raw?.pageType),
      screenSummary:     normalizeString(raw?.screenSummary),
      visibleActions:    normalizeStringArray(raw?.visibleActions, 5),
      importantElements: normalizeElementArray(raw?.importantElements, 5),
      confidence:        normalizeConfidence(raw?.confidence),
    };
  }

  function normalizeString(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function normalizePageType(v) {
    const t = normalizeString(v).toLowerCase();
    return VALID_PAGE_TYPES.includes(t) ? t : 'other';
  }

  function normalizeStringArray(v, max) {
    if (!Array.isArray(v)) return [];
    return v
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim())
      .slice(0, max);
  }

  function normalizeElementArray(v, max) {
    if (!Array.isArray(v)) return [];
    return v
      .filter(e => typeof e?.label === 'string' && e.label.trim())
      .map(e => ({
        label:       e.label.trim(),
        description: normalizeString(e.description),
      }))
      .slice(0, max);
  }

  function normalizeConfidence(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  return { buildScreenContext };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScreenContextService;
}
