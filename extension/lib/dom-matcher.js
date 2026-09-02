// ScreenPilot - DOM Matcher
// Resolves Gemini target elements against the live DOM.

const DOMMatcher = (() => {
  'use strict';

  // Score adjustments for region matching.
  // Applied when targetElement.region is provided and detectRegion() agrees/disagrees.
  const REGION_MATCH_BONUS     = 20;
  const REGION_MISMATCH_PENALTY = 8;

  // Divisor used to normalise raw score (0–200) → confidence (0.0–1.0).
  // A single perfect exact-text match scores 110; dividing by 150 yields 0.73.
  const CONFIDENCE_DIVISOR = 150;

  // "Contains match" candidate-text length cap for aria-label / placeholder /
  // name / id / data-* / etc. — attributes that are always a single string
  // authored for exactly one element as its accessible name/identifier, and
  // so can legitimately be longer than the target without that meaning
  // anything about specificity (aria-label="View profile and more" for
  // target "profile"). Any realistic label/badge-suffixed name is well under
  // this; only structural containers (a <main>/<div> wrapping large chunks of
  // the page, swept in via the generic [id] selector) exceed it. Generous
  // margin above real-world labels (existing candidates top out around
  // 40 chars) and below the real-world false-positive containers this exists
  // to stop (measured 151–7689 chars on github.com/microsoft/vscode).
  const CANDIDATE_CONTAINS_LENGTH_CAP = 120;

  // Floor for any decayed "contains match" score (both the length-cap path
  // above and the specificity path below) — a match is never scored at 0,
  // just heavily deprioritised against a more specific candidate.
  const MIN_CONTAINS_SCORE = 15;

  // 'text' (innerText/textContent) and 'title' are NOT given the length-cap
  // protection above: 'text' can aggregate several sibling controls' labels
  // into one blob (a <nav> wrapping five tab links); 'title' is routinely
  // attached to genuinely arbitrary, unrelated prose on real sites (a GitHub
  // commit-history link's title is its full commit message). Real-Chrome
  // finding (github.com/microsoft/vscode, goal "Open Issues"): a <nav>
  // aggregating "Code Issues 5k+ Pull requests 2.5k Actions Project" (~55
  // chars, under the 120-char cap) scored an identical flat 70 to the real
  // "Issues 5k+" tab link and won a tie via DOM order; separately, a commit
  // link's title="fix(docs): correct grammar and typo issues in
  // documentation" (61 chars) outscored the real tab purely by containing
  // "issues" once. Both attributes are instead scored continuously by
  // specificity — how much of the longer string (target vs. candidate) is
  // the matching part — below.
  //
  // Below this many EXTRA characters beyond the target, that specificity
  // score is skipped entirely and the full flat 70 is kept — covers
  // realistic badge/count suffixes ("Issues 5k+", "Notifications (3)",
  // "Pull requests 2.5k") so a real, correct element isn't penalised for a
  // normal UI decoration. Real-Chrome finding: decaying ANY excess (even a
  // realistic badge suffix, e.g. real GitHub's own "Issues\n5k+", 4 chars
  // past the bare target) dropped a real, correct element's own score enough
  // that an undecayed 'id' contains-match became its "best" attribute
  // instead — and that alone was too weak to clear the executor's PRIMARY
  // acceptance threshold (60), turning a wrong-element bug into a
  // false-negative element_not_found. Chosen to comfortably cover realistic
  // badge/count suffixes (2-8 chars) while staying well under the excess
  // seen from real aggregating containers or unrelated prose (40+ chars in
  // every case measured on github.com/microsoft/vscode).
  const CONTAINS_GRACE_CHARS = 8;

  // Generic UI synonyms — no application names, no site-specific phrases.
  // Covers common action labels that mean the same thing across different UIs.
  const SYNONYM_GROUPS = [
    ['upload', 'attach', 'import'],
    ['file upload', 'upload file', 'attach file'],
    ['new', 'create', 'add'],
    ['settings', 'preferences', 'options', 'configuration'],
    ['submit', 'send', 'confirm', 'apply', 'save'],
    ['cancel', 'dismiss', 'close', 'discard'],
    ['search', 'find', 'filter', 'query', 'lookup'],
    ['edit', 'modify', 'update', 'change'],
    ['delete', 'remove', 'trash', 'discard'],
    ['next', 'continue', 'proceed', 'forward'],
    ['back', 'previous', 'return', 'go back']
  ];

  function matchElement(targetElement) {
    if (!targetElement?.text?.trim()) {
      return null;
    }

    const target       = buildTargetDescriptor(targetElement);
    const targetRegion = targetElement.region ?? null;
    // Single querySelectorAll instead of N separate calls — major perf win on large DOMs
    const combinedSelector = getCandidateSelectors(targetElement.type).join(',');
    const candidates = new Map();

    for (const element of document.querySelectorAll(combinedSelector)) {
      if (!isVisible(element)) continue;
      if (isDisabled(element)) continue;          // skip disabled/aria-disabled elements
      if (isScreenPilotNode(element)) continue;

      const candidate = scoreElement(element, target, targetElement.type, targetRegion);
      if (!candidate || candidate.score <= 0) continue;

      const existing = candidates.get(element);
      if (!existing || candidate.score > existing.score) candidates.set(element, candidate);
    }

    const ranked = Array.from(candidates.values()).sort((left, right) => right.score - left.score);
    if (!ranked.length) {
      return null;
    }

    const best       = ranked[0];
    // Confidence normalises raw score (0–200) to 0–1 for observability and telemetry.
    // It is NOT an independent ranking system — both the value and the enforcement threshold
    // derive from the same score scale. Raise CONFIDENCE in types/index.js only when
    // production distribution data shows that a higher cut-off reduces wrong-element matches.
    const confidence = Math.min(best.score / CONFIDENCE_DIVISOR, 1.0);

    return {
      bestMatch:    best,
      alternatives: ranked.slice(1, 5),
      candidates:   ranked.slice(0, 5),   // top-5 for debugging and telemetry
      element:      best.element,
      score:        best.score,
      confidence,                          // 0.0–1.0 normalized match quality
      reason:       best.reason,
      matchType:    best.matchType,
    };
  }

  // "+", "＋", or the word "plus" denote a generic create/add action but carry no
  // matchable text — "+" tokenizes to an empty set (split on non-alphanumerics),
  // which collapses the semantic, synonym and token-similarity passes and leaves
  // only degenerate substring / Levenshtein matching.  Seed the new/create/add
  // synonym family so icon-only create buttons (aria-label "Create new…") resolve
  // on the primary pass instead of scoring 0 and falling through to alternatives.
  const ADD_GLYPHS = new Set(['+', '＋', 'plus']);

  function buildTargetDescriptor(targetElement) {
    const normalized = normalizeText(targetElement.text);
    const tokens = ADD_GLYPHS.has(normalized) ? ['add', 'new', 'create'] : tokenize(normalized);
    const expandedTokens = expandTokens(tokens);
    const phraseVariants = buildPhraseVariants(normalized, expandedTokens);

    return {
      raw: targetElement.text,
      normalized,
      tokens,
      expandedTokens,
      phraseVariants
    };
  }

  function scoreElement(element, target, targetType, targetRegion) {
    const attributes = getCandidateAttributes(element);

    // Use the single best-matching attribute as the base score, weighted by that
    // attribute's reliability weight.  Summing all matching attributes was causing
    // false amplification: an element whose innerText contains the query *and* whose
    // aria-label also matches would score 2× vs a perfectly-labelled icon button that
    // only has an aria-label match.  The best attribute already captures match quality;
    // secondary attributes add noise, not signal.
    let bestWeightedScore = 0;
    let bestReason        = '';
    let bestMatchType     = '';
    let bestSpecificity   = 1;

    for (const attribute of attributes) {
      const scored = scoreAttributeValue(attribute.value, attribute.label, target);
      if (!scored) continue;

      const weighted = scored.score * attribute.weight;
      if (weighted > bestWeightedScore) {
        bestWeightedScore = weighted;
        bestReason        = scored.reason;
        bestMatchType     = scored.matchType;
        bestSpecificity   = scored.specificity;
      } else {
        // Keep track of the best match type even from lower-weight attributes
        bestMatchType = chooseMatchType(bestMatchType, scored.matchType);
      }
    }

    if (bestWeightedScore <= 0) {
      return null;
    }

    // Secondary signals are additive bonuses, each capped so they cannot individually
    // swing the winner.  The cap prevents a strong semantic container from overriding
    // a much better attribute match on a different element.
    const semantic  = scoreSemanticContainer(element, target, targetType, bestSpecificity);
    const typeBonus = scoreTypeAffinity(element, targetType);
    const region    = scoreRegion(element, targetRegion);

    const finalScore = Math.min(
      Math.round(bestWeightedScore + semantic.score + typeBonus.score + region.score),
      200
    );

    const reasonParts = [bestReason];
    if (semantic.reason)  reasonParts.push(semantic.reason);
    if (typeBonus.reason) reasonParts.push(typeBonus.reason);
    if (region.reason)    reasonParts.push(region.reason);

    return {
      element,
      score:     finalScore,
      reason:    Array.from(new Set(reasonParts)).join('; '),
      matchType: bestMatchType || 'fuzzy',
    };
  }

  // Score region match between element's actual DOM region and the planner's expected region.
  // A match boosts the element, a mismatch penalises it — critical for disambiguating pages
  // that have the same label in multiple regions (e.g. "Billing" in top nav vs sidebar).
  //
  // INVARIANT: Region is a soft signal — a score boost/penalty, never a hard filter.
  // Rejecting by region alone would cause element:not_found whenever the planner's region
  // inference is wrong (common for <nav> elements misclassified by the left-position
  // heuristic). The -8 mismatch only affects borderline matches (score 60–67); all
  // high-confidence matches survive even a wrong region classification.
  function scoreRegion(element, targetRegion) {
    if (!targetRegion) return { score: 0, reason: '' };
    const detected = detectRegion(element);
    if (detected === targetRegion) {
      return { score: REGION_MATCH_BONUS, reason: `region:${detected}` };
    }
    return { score: -REGION_MISMATCH_PENALTY, reason: '' };
  }

  // Return true when the element is non-interactive because it is disabled.
  // Checks both the native DOM property and the ARIA attribute.
  function isDisabled(element) {
    if (element.disabled === true) return true;
    if (element.getAttribute?.('aria-disabled') === 'true') return true;
    return false;
  }

  // Return true when the element has a non-zero bounding rect that intersects the viewport.
  //
  // INVARIANT: isInViewport must NOT be called from matchElement's candidate filter.
  // Elements below the fold are valid targets — highlighter.show() calls scrollIntoView
  // to bring them into view. Filtering off-screen elements here would cause systematic
  // element:not_found failures on any settings page or long form where key targets
  // (Save, Submit, Delete) appear below the initial viewport. Export-only; diagnostic use.
  function isInViewport(element) {
    try {
      const rect = element.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return false;
      const vw = (typeof window !== 'undefined' ? window.innerWidth  : 0) || 0;
      const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
      return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
    } catch {
      return true; // non-browser environment — assume in viewport
    }
  }

  // Resolve the visible label text associated with a form control, WITHOUT ever
  // returning the label element itself as a candidate — this only supplies a text
  // signal for an element that is already a legitimate editable control (Phase 24B
  // guarantees candidate generation stays restricted to input/textarea/
  // contenteditable/role=textbox; this helper must never widen that set).
  //
  // Resolution order:
  //   A. element.labels — native, live, and covers BOTH <label for="id"> and
  //      wrapping <label>text<input></label> with a single browser-provided API.
  //   B. aria-labelledby — resolve every referenced id and concatenate their text,
  //      for controls whose accessible name comes from a separate node that isn't
  //      a <label> at all.
  //   C. No association found — return '' (a no-op attribute value; scoreAttributeValue
  //      already short-circuits on empty values).
  function getAssociatedLabelText(element) {
    if (element.labels && element.labels.length) {
      return Array.from(element.labels)
        .map((label) => label.innerText || label.textContent || '')
        .join(' ')
        .trim();
    }

    const labelledBy = element.getAttribute?.('aria-labelledby');
    if (labelledBy && typeof document !== 'undefined') {
      return labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((el) => el.innerText || el.textContent || '')
        .join(' ')
        .trim();
    }

    return '';
  }

  function getCandidateAttributes(element) {
    // innerText on an icon-only button (e.g. <button><svg>…</svg></button>) returns
    // whitespace, unicode symbols, or raw SVG text nodes — none of which are meaningful
    // for matching.  Strip to an empty string so these elements aren't penalised (or
    // falsely rewarded) on the text attribute; their aria-label will carry the match.
    const rawText = element.innerText || element.textContent || '';
    const cleanText = rawText.replace(/[\u200b-\u200d\ufeff]/g, '') // zero-width chars
                             .replace(/[^\S\n]+/g, ' ')              // collapse whitespace
                             .trim();
    // Treat the text as empty when it consists only of punctuation / symbols with no
    // alphabetic or numeric content — covers "+" alone, "•", decorative separators, etc.
    const meaningfulText = /[a-z0-9]/i.test(cleanText) ? cleanText : '';

    // Icon-only elements (no visible text) rely entirely on aria-label for identity.
    // The comment above already states this intent; the weight was never adjusted to
    // reflect it, causing icon buttons to lose to sidebar links that share the same
    // label as plain visible text.  Boost only when meaningfulText is empty so that
    // text-bearing elements are completely unaffected.
    const ariaLabelWeight = meaningfulText === '' ? 1.6 : 1.1;

    // Accessible name from a descendant img[alt] — covers <button><img alt="…"></button>
    // where the ARIA accessible name is computed from the child img, not an explicit
    // aria-label on the button itself.  Optional chaining guards non-browser environments.
    const childImgAlt  = element.querySelector?.('img[alt]')?.getAttribute?.('alt')?.trim() ?? '';
    const imgAltWeight = meaningfulText === '' ? 1.4 : 0.7;

    return [
      { label: 'text',        value: meaningfulText,                              weight: 1             },
      { label: 'aria-label',  value: element.getAttribute('aria-label'),          weight: ariaLabelWeight },
      { label: 'title',       value: element.getAttribute('title'),               weight: 0.9  },
      { label: 'placeholder', value: element.getAttribute('placeholder'),         weight: 0.95 },
      { label: 'role',        value: element.getAttribute('role'),                weight: 0.7  },
      { label: 'name',        value: element.getAttribute('name'),                weight: 0.85 },
      { label: 'id',          value: element.getAttribute('id'),                  weight: 0.8  },
      { label: 'data-testid', value: element.getAttribute('data-testid'),         weight: 1.15 },
      { label: 'data-test',   value: element.getAttribute('data-test'),           weight: 1.05 },
      { label: 'data-cy',     value: element.getAttribute('data-cy'),             weight: 1.05 },
      { label: 'symbol-text', value: cleanText !== meaningfulText ? cleanText : '', weight: 0.9  },
      { label: 'img-alt',     value: childImgAlt,                                 weight: imgAltWeight },
      { label: 'associated-label', value: getAssociatedLabelText(element),        weight: 1.1  },
    ];
  }

  function scoreAttributeValue(value, label, target) {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) {
      return null;
    }

    // A pure-symbol target (e.g. "+", "#", ">", "*") normalizes to punctuation with no
    // alphanumeric content. Such a needle is meaningless for the substring/edit-distance
    // fallbacks: "+".includes-matches every element whose text contains a literal "+"
    // (including <main>, "C++", "+1,204"), producing a flat 70→62 field whose winner is
    // decided by DOM order. Gate those two fallbacks so a symbol target can only match
    // via the exact/token/synonym paths (icon create buttons resolve via their aria-label
    // synonym match; unrelated "+"-bearing nodes score nothing). See Phase 24 audit.
    const targetHasAlnum = /[a-z0-9]/i.test(target.normalized);

    if (normalizedValue === target.normalized) {
      return buildScore(110, `${label} exact match`, 'exact');
    }

    if (target.phraseVariants.has(normalizedValue) || normalizedValue.split(' ').sort().join(' ') === target.tokens.slice().sort().join(' ')) {
      return buildScore(102, `${label} synonym match`, 'synonym');
    }

    const valueTokens = tokenize(normalizedValue);
    const tokenSimilarity = calculateTokenSimilarity(target.expandedTokens, valueTokens);
    if (tokenSimilarity >= 0.99) {
      return buildScore(98, `${label} token reorder match`, 'fuzzy');
    }

    if (tokenSimilarity >= 0.74) {
      return buildScore(72 + Math.round(tokenSimilarity * 20), `${label} token similarity ${tokenSimilarity.toFixed(2)}`, 'fuzzy');
    }

    if (targetHasAlnum && (normalizedValue.includes(target.normalized) || target.normalized.includes(normalizedValue))) {
      // aria-label/placeholder/name/id/data-* etc.: length-cap-only decay.
      // See CANDIDATE_CONTAINS_LENGTH_CAP above for why these are protected.
      if (label !== 'text' && label !== 'title') {
        if (normalizedValue.length <= CANDIDATE_CONTAINS_LENGTH_CAP) {
          return buildScore(70, `${label} contains match`, 'fuzzy');
        }
        const decayed = Math.round(70 * (CANDIDATE_CONTAINS_LENGTH_CAP / normalizedValue.length));
        return buildScore(Math.max(MIN_CONTAINS_SCORE, decayed), `${label} contains match`, 'fuzzy');
      }

      // 'text'/'title': specificity-scaled, with a grace window for short
      // suffixes. See CONTAINS_GRACE_CHARS above for the full rationale.
      const shorter = Math.min(target.normalized.length, normalizedValue.length);
      const longer  = Math.max(target.normalized.length, normalizedValue.length);
      const excess  = longer - shorter;
      if (excess <= CONTAINS_GRACE_CHARS) {
        return buildScore(70, `${label} contains match`, 'fuzzy', 1);
      }
      const specificity = longer === 0 ? 1 : shorter / longer;
      const score = Math.max(MIN_CONTAINS_SCORE, Math.round(70 * specificity));
      return buildScore(score, `${label} contains match`, 'fuzzy', specificity);
    }

    const synonymSimilarity = calculateTokenSimilarity(target.expandedTokens, expandTokens(valueTokens));
    if (synonymSimilarity >= 0.8) {
      return buildScore(92, `${label} synonym token match`, 'synonym');
    }

    if (targetHasAlnum) {
      const distance = levenshteinDistance(normalizedValue, target.normalized);
      if (distance <= 2) {
        return buildScore(64 - distance * 8, `${label} fuzzy match`, 'fuzzy');
      }
    }

    return null;
  }

  // directSpecificity (0–1, default 1) is the winning attribute's own match
  // ratio — see the 'text'/'title' specificity scoring in scoreAttributeValue
  // above (CONTAINS_GRACE_CHARS comment). Real-Chrome finding
  // (github.com/microsoft/vscode, goal "Open Pull requests"):
  // this bonus is meant to help a WEAK/generic direct match ("Submit" among
  // several forms) using surrounding context — but a topically-narrow,
  // UNRELATED container (a wiki doc link sitting in a "Contributing" section)
  // could earn the full bonus and outscore the real, correctly-labelled repo
  // tab, whose own container is a shared nav strip diluted across several
  // OTHER unrelated tab names and so never qualifies for the bonus at all.
  // Scaling the bonus down as the direct match's own specificity rises means
  // context can still rescue a genuinely weak match, but can't stack an
  // additional swing on top of a match that already stands on its own.
  function scoreSemanticContainer(element, target, targetType, directSpecificity = 1) {
    const container = element.closest('form, nav, header, main, section, article, li, td, tr, label, [role="dialog"], [role="menu"], [role="navigation"], [aria-label]');
    if (!container || container === element) {
      return { score: 0, reason: '' };
    }

    const containerTokens = expandTokens(tokenize(normalizeText(container.innerText || container.textContent || container.getAttribute('aria-label') || '')));
    if (!containerTokens.length) {
      return { score: 0, reason: '' };
    }

    const similarity = calculateTokenSimilarity(target.expandedTokens, containerTokens);
    if (similarity >= 0.6) {
      const base = 10 + Math.round(similarity * 8);
      const scaled = Math.round(base * (1 - directSpecificity));
      if (scaled <= 0) return { score: 0, reason: '' };
      return {
        score: scaled,
        reason: 'semantic container context'
      };
    }

    return { score: 0, reason: '' };
  }

  function scoreTypeAffinity(element, targetType) {
    if (!targetType) {
      return { score: 0, reason: '' };
    }

    const role = normalizeText(element.getAttribute('role'));
    const tagName = element.tagName.toLowerCase();
    const affinityMap = {
      button: role === 'button' || tagName === 'button' || tagName === 'input',
      link: role === 'link' || tagName === 'a',
      input: ['input', 'textarea'].includes(tagName) || role === 'textbox' || element.isContentEditable,
      menu: role === 'menuitem' || role === 'button' || element.getAttribute('aria-haspopup') === 'menu' || tagName === 'a' || tagName === 'button'
    };

    return affinityMap[targetType]
      ? { score: 10, reason: 'target type affinity' }
      : { score: 0, reason: '' };
  }

  function getCandidateSelectors(type) {
    const common = [
      'button',
      'a',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="textbox"]',
      '[aria-label]',
      '[title]',
      '[placeholder]',
      '[data-testid]',
      '[data-test]',
      '[data-cy]',
      '[name]',
      '[id]',
      '[aria-haspopup]'
    ];

    const preferred = {
      button: ['button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]'],
      link: ['a', '[role="link"]'],
      input: ['input', 'textarea', '[contenteditable="true"]', '[role="textbox"]'],
      menu: ['[role="menuitem"]', '[aria-haspopup="menu"]', '[role="button"]', 'button', 'a']
    };

    // Editable controls are ALWAYS one of these four selectors — there is no
    // legitimate text-entry element reachable only through a generic attribute
    // selector like [id] or [aria-label]. Restricting type:"input" to exactly
    // this list (instead of unioning with `common`) structurally prevents
    // non-editable elements (labels, wrapper divs) from ever becoming candidates,
    // rather than relying on a scoring bonus that a strong text match on the
    // wrong element can still outweigh. See Phase 24B audit — a <label> was
    // winning over the real <input> via the generic [id] selector in `common`.
    if (type === "input") {
      return preferred.input;
    }

    return Array.from(new Set([...(preferred[type] || []), ...common]));
  }

  function tokenize(value) {
    return normalizeText(value)
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function expandTokens(tokens) {
    const expanded = new Set(tokens);

    for (const token of tokens) {
      for (const group of SYNONYM_GROUPS) {
        const groupTokens = group.flatMap((phrase) => tokenize(phrase));
        if (groupTokens.includes(token)) {
          for (const synonymToken of groupTokens) {
            expanded.add(synonymToken);
          }
        }
      }
    }

    return Array.from(expanded);
  }

  function buildPhraseVariants(normalizedPhrase, expandedTokens) {
    const variants = new Set([normalizedPhrase, expandedTokens.join(' '), expandedTokens.slice().sort().join(' ')]);

    for (const group of SYNONYM_GROUPS) {
      if (group.some((phrase) => normalizeText(phrase) === normalizedPhrase)) {
        for (const phrase of group) {
          variants.add(normalizeText(phrase));
          variants.add(tokenize(phrase).slice().sort().join(' '));
        }
      }
    }

    variants.add(targetTokenKey(tokenize(normalizedPhrase)));
    return variants;
  }

  function calculateTokenSimilarity(leftTokens, rightTokens) {
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const intersection = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
    const union = new Set([...leftSet, ...rightSet]).size;
    return union === 0 ? 0 : intersection / union;
  }

  function chooseMatchType(current, incoming) {
    const rank = { exact: 3, synonym: 2, fuzzy: 1, '': 0 };
    return rank[incoming] > rank[current] ? incoming : current;
  }

  // specificity defaults to 1 (no reduction) for every match type except the
  // 'text'/'title' contains-match branch above, which passes its own
  // computed ratio — see scoreSemanticContainer's use of it.
  function buildScore(score, reason, matchType, specificity = 1) {
    return { score, reason, matchType, specificity };
  }

  function targetTokenKey(tokens) {
    return tokens.slice().sort().join(' ');
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
  }

  function isVisible(element) {
    if (!element) return false;
    // checkVisibility() is a native C++ method (Chrome 105+), faster than JS-based checks
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isScreenPilotNode(node) {
    return Boolean(node.closest?.(
      '#screenpilot-widget, #screenpilot-highlight, #screenpilot-spotlight, #screenpilot-arrow, #screenpilot-bubble,' +
      '[id^="sp-"], [id^="screenpilot-"], [class*="sp-"], [data-screenpilot]'
    ));
  }

  /**
   * Classify a DOM element into one of 9 generic action types.
   * Uses tag, role, type attribute, and text — no site-specific patterns.
   */
  function classifyActionType(element) {
    const tag  = element.tagName?.toLowerCase() || '';
    const role = (element.getAttribute?.('role') || '').toLowerCase();
    const type = (element.getAttribute?.('type') || '').toLowerCase();
    const text = normalizeText(element.innerText || element.textContent || element.getAttribute?.('aria-label') || '');

    if (tag === 'textarea' || role === 'textbox' || element.isContentEditable) return 'input_field';
    if (tag === 'input') {
      if (type === 'hidden')   return null;
      if (type === 'search')   return 'filter_control';
      if (type === 'checkbox' || type === 'radio') return 'settings_control';
      if (type === 'submit')   return 'primary_action';
      if (type === 'reset')    return 'secondary_action';
      const ph   = (element.getAttribute?.('placeholder') || '').toLowerCase();
      const name = (element.getAttribute?.('name') || '').toLowerCase();
      if (['search', 'query', 'q', 'filter', 'find'].some(k => ph.includes(k) || name.includes(k))) return 'filter_control';
      return 'input_field';
    }
    if (tag === 'select') return 'filter_control';

    if (['checkbox', 'radio', 'switch'].includes(role))                         return 'settings_control';
    if (['menuitem', 'menuitemcheckbox', 'menuitemradio'].includes(role))       return 'menu_action';
    if (['option', 'row', 'gridcell', 'treeitem', 'listitem'].includes(role))  return 'content_item';
    if (role === 'tab') return 'navigation_action';

    const DESTRUCTIVE = ['delete', 'remove', 'trash', 'archive', 'discard', 'destroy', 'erase'];
    const SECONDARY   = ['cancel', 'close', 'dismiss', 'back', 'skip', 'reset', 'undo', 'clear'];
    if (DESTRUCTIVE.some(k => text === k || text.startsWith(k + ' '))) return 'destructive_action';
    if (SECONDARY.some(k => text === k || text.startsWith(k + ' ')))   return 'secondary_action';

    if (element.getAttribute?.('aria-haspopup') || role === 'combobox') return 'menu_action';
    if (tag === 'a' || role === 'link') return 'navigation_action';
    if (['li', 'tr', 'td'].includes(tag) && !['button', 'link'].includes(role)) return 'content_item';

    return 'primary_action';
  }

  /**
   * Detect which generic UI region contains an element.
   * Walks DOM ancestry — no site-specific element IDs or class names.
   */
  function detectRegion(element) {
    let node = element.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const tag  = node.tagName?.toLowerCase() || '';
      const role = (node.getAttribute?.('role') || '').toLowerCase();

      if (role === 'dialog' || node.getAttribute?.('aria-modal') === 'true') return 'modal';
      if (['menu', 'listbox'].includes(role))    return 'dropdown';
      if (tag === 'form'   || role === 'form')   return 'form';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (role === 'toolbar')                    return 'toolbar';
      if (tag === 'main'   || role === 'main')   return 'main_content';
      if (tag === 'aside'  || role === 'complementary') return 'side_navigation';
      if (tag === 'header' || role === 'banner') return 'top_navigation';
      if (tag === 'nav'    || role === 'navigation') {
        try {
          return node.getBoundingClientRect().left < 160 ? 'side_navigation' : 'top_navigation';
        } catch { return 'top_navigation'; }
      }
      node = node.parentElement;
    }
    return 'main_content';
  }

  function levenshteinDistance(left, right) {
    if (!left.length) {
      return right.length;
    }

    if (!right.length) {
      return left.length;
    }

    const matrix = Array.from({ length: right.length + 1 }, (_, rowIndex) => [rowIndex]);
    for (let columnIndex = 0; columnIndex <= left.length; columnIndex += 1) {
      matrix[0][columnIndex] = columnIndex;
    }

    for (let rowIndex = 1; rowIndex <= right.length; rowIndex += 1) {
      for (let columnIndex = 1; columnIndex <= left.length; columnIndex += 1) {
        if (right[rowIndex - 1] === left[columnIndex - 1]) {
          matrix[rowIndex][columnIndex] = matrix[rowIndex - 1][columnIndex - 1];
        } else {
          matrix[rowIndex][columnIndex] = Math.min(
            matrix[rowIndex - 1][columnIndex - 1] + 1,
            matrix[rowIndex][columnIndex - 1] + 1,
            matrix[rowIndex - 1][columnIndex] + 1
          );
        }
      }
    }

    return matrix[right.length][left.length];
  }

  return {
    matchElement,
    isVisible,
    isDisabled,
    isInViewport,
    classifyActionType,
    detectRegion,
  };
})();

// Expose on window so ES module content scripts (v2-task.js) can access it.
// const declarations are not properties of window — this bridges the gap.
if (typeof window !== 'undefined') {
  window.DOMMatcher = DOMMatcher;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DOMMatcher;
}
