// ScreenPilot - DOM Matcher
// Resolves Gemini target elements against the live DOM.

const DOMMatcher = (() => {
  'use strict';

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

    const target = buildTargetDescriptor(targetElement);
    // Single querySelectorAll instead of N separate calls — major perf win on large DOMs
    const combinedSelector = getCandidateSelectors(targetElement.type).join(',');
    const candidates = new Map();

    for (const element of document.querySelectorAll(combinedSelector)) {
      if (!isVisible(element)) continue;
      if (isScreenPilotNode(element)) {
        // console.log('[DOMMatcher] Excluded ScreenPilot overlay candidate');
        continue;
      }

      const candidate = scoreElement(element, target, targetElement.type);
      if (!candidate || candidate.score <= 0) continue;

      const existing = candidates.get(element);
      if (!existing || candidate.score > existing.score) candidates.set(element, candidate);
    }

    const ranked = Array.from(candidates.values()).sort((left, right) => right.score - left.score);
    if (!ranked.length) {
      return null;
    }

    return {
      bestMatch:    ranked[0],
      alternatives: ranked.slice(1, 5),
      candidates:   ranked.slice(0, 5),   // for score distribution telemetry
      element:      ranked[0].element,
      score:        ranked[0].score,
      reason:       ranked[0].reason,
      matchType:    ranked[0].matchType
    };
  }

  function buildTargetDescriptor(targetElement) {
    const normalized = normalizeText(targetElement.text);
    const tokens = tokenize(normalized);
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

  function scoreElement(element, target, targetType) {
    const attributes = getCandidateAttributes(element);
    let aggregateScore = 0;
    let bestReason = '';
    let bestMatchType = '';
    const matchedReasons = [];

    for (const attribute of attributes) {
      const scored = scoreAttributeValue(attribute.value, attribute.label, target);
      if (!scored) {
        continue;
      }

      aggregateScore += scored.score * attribute.weight;
      matchedReasons.push(scored.reason);

      if (!bestReason || scored.score > aggregateScore) {
        bestReason = scored.reason;
      }

      bestMatchType = chooseMatchType(bestMatchType, scored.matchType);
    }

    if (aggregateScore <= 0) {
      return null;
    }

    const semantic = scoreSemanticContainer(element, target, targetType);
    const typeBonus = scoreTypeAffinity(element, targetType);
    const finalScore = Math.min(Math.round(aggregateScore + semantic.score + typeBonus.score), 200);
    const reasonParts = matchedReasons.slice(0, 3);

    if (semantic.reason) {
      reasonParts.push(semantic.reason);
    }

    if (typeBonus.reason) {
      reasonParts.push(typeBonus.reason);
    }

    return {
      element,
      score: finalScore,
      reason: Array.from(new Set(reasonParts)).join('; '),
      matchType: bestMatchType || 'fuzzy'
    };
  }

  function getCandidateAttributes(element) {
    return [
      { label: 'text', value: element.innerText || element.textContent, weight: 1 },
      { label: 'aria-label', value: element.getAttribute('aria-label'), weight: 1.1 },
      { label: 'title', value: element.getAttribute('title'), weight: 0.9 },
      { label: 'placeholder', value: element.getAttribute('placeholder'), weight: 0.95 },
      { label: 'role', value: element.getAttribute('role'), weight: 0.7 },
      { label: 'name', value: element.getAttribute('name'), weight: 0.85 },
      { label: 'id', value: element.getAttribute('id'), weight: 0.8 },
      { label: 'data-testid', value: element.getAttribute('data-testid'), weight: 1.15 },
      { label: 'data-test', value: element.getAttribute('data-test'), weight: 1.05 },
      { label: 'data-cy', value: element.getAttribute('data-cy'), weight: 1.05 }
    ];
  }

  function scoreAttributeValue(value, label, target) {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) {
      return null;
    }

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

    if (normalizedValue.includes(target.normalized) || target.normalized.includes(normalizedValue)) {
      return buildScore(70, `${label} contains match`, 'fuzzy');
    }

    const synonymSimilarity = calculateTokenSimilarity(target.expandedTokens, expandTokens(valueTokens));
    if (synonymSimilarity >= 0.8) {
      return buildScore(92, `${label} synonym token match`, 'synonym');
    }

    const distance = levenshteinDistance(normalizedValue, target.normalized);
    if (distance <= 2) {
      return buildScore(64 - distance * 8, `${label} fuzzy match`, 'fuzzy');
    }

    return null;
  }

  function scoreSemanticContainer(element, target, targetType) {
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
      return {
        score: 10 + Math.round(similarity * 8),
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

  function buildScore(score, reason, matchType) {
    return { score, reason, matchType };
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
      '#screenpilot-widget, #screenpilot-highlight, #screenpilot-spotlight, #screenpilot-arrow, #screenpilot-bubble'
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
    classifyActionType,
    detectRegion
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
