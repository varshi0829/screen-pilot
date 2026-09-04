// ScreenPilot v2 — Small UI Grounding & Element Ranking Service
//
// Layer 2 of the Local-First Hierarchy. Evaluates normalized page state elements
// against natural language intent using feature scoring (text overlap, ARIA matching,
// DOM role compatibility, layout region, and keyword boost).
// Pure JavaScript, zero heavy tensor allocations, CPU-friendly (<15ms).

export const UIGroundingService = (() => {
  'use strict';

  function normalize(str) {
    return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim().toLowerCase() : '';
  }

  function tokenize(str) {
    const stopWords = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'is', 'it', 'and', 'or']);
    return normalize(str)
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stopWords.has(t));
  }

  /**
   * Score a single DOM element against user intent.
   *
   * @param {string} intent
   * @param {object} el - Normalized page state element
   * @returns {number} score between 0.0 and 1.0
   */
  function scoreElement(intent, el) {
    if (!el || !el.visible || el.enabled === false) return 0.0;

    const intentTokens = tokenize(intent);
    if (!intentTokens.length) return 0.0;

    const textTokens      = tokenize(el.text || '');
    const placeTokens     = tokenize(el.placeholder || '');
    const ariaTokens      = tokenize(el.ariaLabel || '');
    const valTokens       = tokenize(el.value || '');
    const allElTokens     = new Set([...textTokens, ...placeTokens, ...ariaTokens, ...valTokens]);

    if (!allElTokens.size) return 0.0;

    // 1. Text & Placeholder Token Overlap (weight: 0.35)
    const textMatches = intentTokens.filter(t => allElTokens.has(t)).length;
    const textScore   = textMatches / intentTokens.length;

    // 2. ARIA / Accessible Label Match (weight: 0.30)
    const ariaMatches = intentTokens.filter(t => ariaTokens.includes(t)).length;
    const ariaScore   = ariaTokens.length ? ariaMatches / intentTokens.length : textScore;

    // 3. Role & Action Compatibility (weight: 0.15)
    let roleScore = 0.5;
    const normIntent = normalize(intent);
    if (normIntent.includes('click') || normIntent.includes('open') || normIntent.includes('press')) {
      if (['button', 'link', 'combobox', 'tab'].includes(el.role) || el.tag === 'button' || el.tag === 'a') roleScore = 1.0;
    } else if (normIntent.includes('type') || normIntent.includes('fill') || normIntent.includes('search') || normIntent.includes('enter')) {
      if (['textbox', 'combobox', 'search'].includes(el.role) || ['input', 'textarea'].includes(el.tag)) roleScore = 1.0;
    }

    // 4. Region Priority (weight: 0.10)
    let regionScore = 0.6;
    if (el.region === 'top_navigation' || el.region === 'side_navigation' || el.region === 'modal') regionScore = 1.0;

    // 5. Exact Substring Boost (weight: 0.10)
    let boost = 0.0;
    const fullElText = normalize(`${el.text} ${el.placeholder} ${el.ariaLabel}`);
    if (normIntent && fullElText && (fullElText.includes(normIntent) || normIntent.includes(fullElText))) {
      boost = 1.0;
    }

    const finalScore = (0.35 * textScore) + (0.30 * ariaScore) + (0.15 * roleScore) + (0.10 * regionScore) + (0.10 * boost);
    return Math.min(1.0, Math.round(finalScore * 100) / 100);
  }

  /**
   * Rank all extracted elements by relevance to user intent.
   *
   * @param {string} intent
   * @param {Array<object>} elements
   * @returns {Array<{ element: object, score: number }>}
   */
  function rankElements(intent, elements) {
    if (!Array.isArray(elements) || !elements.length) return [];

    const scored = elements.map(el => ({
      element: el,
      score: scoreElement(intent, el)
    }));

    return scored
      .filter(item => item.score > 0.05)
      .sort((a, b) => b.score - a.score);
  }

  return { scoreElement, rankElements, tokenize };
})();

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = UIGroundingService;
}
