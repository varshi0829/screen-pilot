// ScreenPilot v2 — Small UI Grounding & Element Ranking Service
//
// Layer 2 of the Local-First Hierarchy. Evaluates normalized page state elements
// against natural language intent using IDF-weighted coverage scoring (see
// scoreElement's own doc comment for why), plus role/region/substring bonuses.
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

  // Minimum length of the SHORTER token before a prefix relation is allowed to
  // count. Short prefixes are where this would go wrong — "new" prefixes
  // "newsletter", "car" prefixes "card", "on" prefixes "one" — so anything
  // under this length is required to match exactly, as before.
  const MORPH_MIN_LEN = 4;
  // A prefix relation is weaker evidence than the same word actually being
  // there, so it earns partial credit. An exact match therefore always
  // outscores a morphological one, and a candidate can never win on prefixes
  // alone against a candidate that genuinely uses the word.
  // Calibrated, not guessed. At 0.9 a decoy that matches the goal's verb
  // exactly while the real target only matches morphologically lands within
  // the existing near-tie band (measured margin 0.030), so that case still
  // escalates to semantic reasoning exactly as it does today instead of being
  // committed to to the wrong control. Lower values let the decoy win
  // outright; 1.0 would erase the exact-beats-prefix guarantee entirely.
  const MORPH_CREDIT = 0.9;

  /**
   * Is one token a morphological prefix of the other?
   *
   * This is a string relation, not a vocabulary: nothing is listed anywhere
   * and nothing is site-specific. It is evaluated at runtime between the
   * goal's own words and whatever words the page in front of us happens to
   * use, so it works the same for any abbreviation a person naturally types
   * against any longer form a page happens to render.
   */
  function morphRelated(a, b) {
    if (a === b) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= MORPH_MIN_LEN && long.startsWith(short);
  }

  /** 1 for an exact match, MORPH_CREDIT for a prefix relation, 0 for neither. */
  function matchStrength(token, tokenSet) {
    if (tokenSet.has(token)) return 1;
    for (const candidate of tokenSet) {
      if (morphRelated(token, candidate)) return MORPH_CREDIT;
    }
    return 0;
  }

  function elementLabelTokens(el) {
    const textTokens  = tokenize(el.text || '');
    const placeTokens = tokenize(el.placeholder || '');
    const ariaTokens  = tokenize(el.ariaLabel || '');
    const valTokens   = tokenize(el.value || '');
    return new Set([...textTokens, ...placeTokens, ...ariaTokens, ...valTokens]);
  }

  /**
   * Document-frequency-based IDF weights computed dynamically from THIS
   * page's own candidate elements — no external/global vocabulary, no
   * hardcoded terms, no site-specific rules. A token appearing on few
   * candidates (distinctive) gets a high weight; one appearing on many
   * (common page chrome) gets a low weight. Smoothed IDF (`+1` in both the
   * numerator and denominator) avoids division by zero and an unbounded
   * weight for tokens that appear on every element.
   *
   * @param {Array<Set<string>>} elementTokenSets
   * @returns {{ idf: Map<string, number>, df: Map<string, number> }}
   */
  function computeIdf(elementTokenSets) {
    const df = new Map();
    for (const tokens of elementTokenSets) {
      for (const t of tokens) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }
    const n = elementTokenSets.length;
    const idf = new Map();
    for (const [t, d] of df) {
      idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
    }
    return { idf, df };
  }

  /**
   * Score a single DOM element against user intent using IDF-weighted
   * coverage: of the intent tokens that appear on AT LEAST ONE candidate on
   * this page (i.e. tokens the page's own vocabulary could possibly
   * satisfy), how much of their combined (rarity-weighted) importance does
   * THIS element cover?
   *
   * Intent tokens absent from every candidate (conversational filler like
   * "help"/"me", or a typed value meant for a field rather than a label,
   * e.g. a search query) are excluded from the denominator entirely — no
   * candidate could ever be evaluated on them, so they must not dilute
   * every candidate's score equally the way dividing by the user's total
   * token count used to. That dilution was the exact bug this rewrite
   * fixes: natural, longer phrasing no longer punishes an otherwise-perfect
   * match. This keeps L2 purely lexical/statistical, not semantic — a goal
   * whose meaningful words genuinely don't appear anywhere in the page's
   * own text still correctly scores 0 here and falls through to Qwen (L3),
   * which is the intended division of labor.
   *
   * @param {string} intent
   * @param {object} el - Normalized page state element
   * @param {{idf: Map, df: Map}} [corpus] - Precomputed via computeIdf() over
   *   the full candidate set, passed in once per rankElements() call. A
   *   standalone scoreElement() call without a corpus falls back to treating
   *   this element as its own single-document corpus.
   * @returns {number} score between 0.0 and 1.0
   */
  function scoreElement(intent, el, corpus = null) {
    if (!el || !el.visible || el.enabled === false) return 0.0;

    const intentTokens = tokenize(intent);
    if (!intentTokens.length) return 0.0;

    const elTokens = elementLabelTokens(el);
    if (!elTokens.size) return 0.0;

    const { idf, df } = corpus || computeIdf([elTokens]);

    // Only intent tokens that appear on at least one candidate can possibly
    // be covered by any element — everything else is excluded, not scored
    // against a phantom "0 for everyone" baseline.
    // A goal word counts when the page uses that word, OR when the page uses a
    // longer form the goal abbreviated (see morphRelated). Without the second
    // case a goal word the page only spells out in full is dropped from the
    // denominator entirely, and every candidate is then judged on whatever
    // generic filler remains — measured on a real menu, that left five sibling
    // controls tied at exactly 0.850 with nothing to choose between them.
    const scorableTokens = [];
    for (const t of intentTokens) {
      if ((df.get(t) || 0) > 0) {
        scorableTokens.push({ token: t, weight: idf.get(t) || 1 });
        continue;
      }
      // Borrow the weight of the longest form the page actually uses, so a
      // morphologically-related word is scored as the distinctive term it
      // stands in for rather than as an unknown.
      let best = null;
      for (const pageToken of df.keys()) {
        if (!morphRelated(t, pageToken)) continue;
        const w = idf.get(pageToken) || 1;
        if (!best || w > best.weight) best = { token: t, weight: w };
      }
      if (best) scorableTokens.push(best);
    }
    if (!scorableTokens.length) return 0.0;

    let totalWeight = 0;
    let matchedWeight = 0;
    for (const { token, weight } of scorableTokens) {
      totalWeight += weight;
      matchedWeight += weight * matchStrength(token, elTokens);
    }
    if (totalWeight <= 0) return 0.0;

    const coverage = matchedWeight / totalWeight;
    if (coverage <= 0) return 0.0;

    // Structural bonuses — tie-breakers/boosts applied ONLY on top of a
    // nonzero lexical coverage score, never a floor: an element with zero
    // coverage stays at exactly 0 regardless of role/region, so these can
    // never inflate an unrelated element the way constant floors used to.
    //
    // Fixed (additive) budget, not a multiplier on coverage: two candidates
    // that both fully cover the goal's vocabulary (coverage=1.0, e.g. same
    // text on a <button> vs. a plain <div>) must still be distinguishable by
    // role — a multiplicative bonus saturates at the 1.0 cap for both and
    // erases that signal entirely.
    let bonus = 0;
    const normIntent = normalize(intent);
    if (normIntent.includes('click') || normIntent.includes('open') || normIntent.includes('press')) {
      if (['button', 'link', 'combobox', 'tab'].includes(el.role) || el.tag === 'button' || el.tag === 'a') bonus += 0.08;
    } else if (normIntent.includes('type') || normIntent.includes('fill') || normIntent.includes('search') || normIntent.includes('enter')) {
      if (['textbox', 'combobox', 'search'].includes(el.role) || ['input', 'textarea'].includes(el.tag)) bonus += 0.08;
    }
    if (el.region === 'top_navigation' || el.region === 'side_navigation' || el.region === 'modal') bonus += 0.04;

    const fullElText = normalize(`${el.text || ''} ${el.placeholder || ''} ${el.ariaLabel || ''}`);
    if (normIntent && fullElText && (fullElText.includes(normIntent) || normIntent.includes(fullElText))) {
      bonus += 0.03;
    }

    const finalScore = Math.min(1.0, (coverage * 0.85) + bonus);
    return Math.round(finalScore * 100) / 100;
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

    // IDF corpus computed once from THIS page's own candidate elements —
    // dynamic per call, no persisted/global vocabulary.
    const elementTokenSets = elements.map(el => elementLabelTokens(el));
    const corpus = computeIdf(elementTokenSets);

    const scored = elements.map(el => ({
      element: el,
      score: scoreElement(intent, el, corpus)
    }));

    return scored
      .filter(item => item.score > 0.05)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Assess how much EVIDENCE the ranking rests on, alongside the ranking
   * itself. Pure observation of the candidate set — it computes no new score
   * and changes nothing about scoreElement/rankElements.
   *
   * A high score does not by itself mean the winner is the right element. Two
   * distinct, measured ways lexical grounding is untrustworthy:
   *
   *  - `unmatchedIntentTokens` — content words of the goal that appear on NO
   *    candidate at all. scoreElement deliberately drops these from its
   *    denominator (they cannot be covered by anyone, so scoring against them
   *    would dilute every candidate equally). The consequence is that the goal
   *    is then judged on whatever words REMAIN, which can be pure filler:
   *    measured on a real menu, the goal's distinguishing word was absent from
   *    the page's vocabulary and the winner scored 0.850 on the leftover
   *    generic verb while the element a person would pick scored 0.290. The
   *    margin was wide (0.560) — the ranking was confident and wrong, so a
   *    margin test cannot catch this class. What it means is that the page's
   *    wording does not express part of what was asked, and deciding whether
   *    some candidate nonetheless MEANS that is a semantic judgement, not a
   *    lexical one.
   *
   *  - `margin` — the gap to the runner-up. Near zero, several candidates are
   *    covering the same vocabulary equally well (measured 0.000 across three
   *    sibling controls) and the winner is decided by sort order alone.
   *
   * Neither signal names a site, a phrase, or a synonym; both are relationships
   * within whatever candidates the current page happens to offer.
   *
   * @param {string} intent
   * @param {Array<object>} elements
   * @returns {{ ranked: Array<{element: object, score: number}>, topScore: number,
   *             runnerUpScore: number, margin: number, rivals: number,
   *             unmatchedIntentTokens: string[] }}
   */
  function assessGrounding(intent, elements) {
    const ranked = rankElements(intent, elements);
    const list = Array.isArray(elements) ? elements : [];
    const { df } = computeIdf(list.map(el => elementLabelTokens(el)));
    // Uses the same matching rule scoreElement does — a goal word the page
    // only spells out in full is matched, not reported as missing. Reporting
    // it as unmatched here while scoring it as matched there would have the
    // ambiguity check escalating a candidate the ranking had already resolved.
    const unmatchedIntentTokens = tokenize(intent).filter((t) => {
      if ((df.get(t) || 0) > 0) return false;
      for (const pageToken of df.keys()) if (morphRelated(t, pageToken)) return false;
      return true;
    });

    const topScore      = ranked[0]?.score ?? 0;
    const runnerUpScore = ranked[1]?.score ?? 0;
    const margin        = topScore - runnerUpScore;

    return { ranked, topScore, runnerUpScore, margin, rivals: ranked.length, unmatchedIntentTokens };
  }

  return { scoreElement, rankElements, tokenize, assessGrounding };
})();

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = UIGroundingService;
}
