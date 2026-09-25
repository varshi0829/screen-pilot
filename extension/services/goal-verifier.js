// ScreenPilot v2 — Goal Verifier (Phase 23C, SHADOW MODE)
//
// Evaluates a plan-level GoalCompletionCriteria (Phase 23A/23B) against the live
// page and produces a verdict. This module is intentionally READ-ONLY and side
// effect-free: it inspects `document` / `location` and returns a plain object.
//
// SHADOW MODE CONTRACT: nothing here triggers completion, changes state, or alters
// runtime behavior. The orchestrator only logs the verdict for agreement telemetry.
//
// It uses dumb URL / text / accessible-name presence predicates only — it is NOT
// the DOMMatcher and performs no ranking or scoring.

import { UIGroundingService } from './ui-grounding-service.js';

/** Collapse whitespace + lowercase for case-insensitive text/label comparison. */
function normalize(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

// Generic UI "container" words that a multi-word goal commonly pairs with a
// specific noun but that the destination page itself often doesn't show verbatim
// (a goal for "notification preferences" typically lands on a page titled just
// "Notifications" — the qualifier "preferences" is implied, not present). Small
// and deliberately generic/app-agnostic — the same vocabulary dom-matcher.js
// already treats as synonyms (its SYNONYM_GROUPS includes this exact
// settings/preferences/options/configuration family) — not a site-specific list.
const GENERIC_QUALIFIER_WORDS = new Set([
  'preferences', 'preference', 'settings', 'setting', 'options', 'option',
  'configuration', 'config', 'information', 'info', 'details', 'management', 'page',
]);

/** Does this array of candidate tokens contain the target's specific/content
 *  words? Layered on top of the existing whole-phrase checks below — it only ever
 *  ADDS matches for multi-word target objects whose exact phrasing doesn't appear
 *  verbatim on the page, it never removes a match the whole-phrase checks already
 *  found. Takes pre-tokenized candidateTokens rather than raw text because "what
 *  counts as a token separator" differs by source — free text (a heading, a
 *  toggle's accessible name) splits on whitespace via UIGroundingService.tokenize;
 *  a URL has no whitespace at all and needs its own path-segment splitter (see the
 *  urlSegments call site below) — routing a URL through the whitespace tokenizer
 *  would concatenate the entire path into one unsplit token. Substring comparison
 *  in both directions per token (not exact equality) covers simple pluralization
 *  ("notification" vs "notifications") without a stemmer.
 *
 *  Ignores GENERIC_QUALIFIER_WORDS when deciding what must match: requiring EVERY
 *  token (including the qualifier) would reject the exact case this exists for;
 *  requiring only "most" tokens would instead accept unrelated pages that merely
 *  share the qualifier (e.g. "notification preferences" incorrectly matching a
 *  "Billing preferences" heading). Requiring all the *content* tokens gets both
 *  right: it matches "Notifications" (content word present) and rejects "Billing
 *  preferences" (content word absent). */
function tokenOverlapMatches(targetTokens, candidateTokens) {
  if (!targetTokens.length || !candidateTokens?.length) return false;
  const contentTokens = targetTokens.filter((t) => !GENERIC_QUALIFIER_WORDS.has(t));
  const required = contentTokens.length ? contentTokens : targetTokens;
  return required.every((t) => candidateTokens.some((ct) => ct.includes(t) || t.includes(ct)));
}

/** Lightweight accessible-name resolution for the toggle/checkbox signal below.
 *  Deliberately NOT dom-matcher.js's richer resolver — this module is documented
 *  as "dumb URL/text/accessible-name presence predicates only, no ranking." */
function accessibleName(el, doc) {
  const aria = el.getAttribute?.('aria-label');
  if (aria) return aria;
  if (el.labels && el.labels.length) {
    return Array.from(el.labels).map((l) => l.innerText || l.textContent || '').join(' ');
  }
  const labelledBy = el.getAttribute?.('aria-labelledby');
  if (labelledBy && doc) {
    return labelledBy.split(/\s+/).filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent || '')
      .join(' ');
  }
  return el.textContent || el.getAttribute?.('title') || '';
}

/** Same layout-based visibility heuristic PageStateService/page-snapshot.js
 *  already use elsewhere in this codebase (offsetParent + a non-zero bounding
 *  rect). Missing in a test-mock `doc`'s elements (no getBoundingClientRect /
 *  offsetParent at all) defaults to "visible" rather than throwing, so it's a
 *  no-op against the existing fake-DOM unit tests. In a real document it stops
 *  a `hidden`/`display:none` element — a hidden tab panel, an inactive
 *  accordion section, a not-yet-shown success banner, all common in real
 *  SPAs — from satisfying a heading/label/toggle signal it was never actually
 *  showing to the user. */
function isElementVisible(el) {
  if (!el) return false;
  if (typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    if (r && r.width === 0 && r.height === 0) return false;
  }
  if (typeof el.offsetParent !== 'undefined' && el.offsetParent === null && el.tagName !== 'BODY') return false;
  return true;
}

// Genuinely interactive controls — a real navigable link, a button, an ARIA
// button, or an element explicitly placed in the tab order (tabindex="0").
// Deliberately [tabindex="0"] only, NOT bare [tabindex] — tabindex="-1" is a
// common accessibility pattern for programmatic-focus-only containers (skip
// links, scroll regions, layout wrappers) and is NOT a clickable affordance.
// Real-Chrome finding (github.com, a genuine "All issues" page heading): it
// sits inside a tabindex="-1" layout <div> — a naive bare-[tabindex] check
// would wrongly suppress this legitimate, already-satisfied case. Shared by
// hasInteractiveAncestor and hasAvailableInteractiveCounterpart below so both
// checks agree on exactly what counts as "a real control."
const INTERACTIVE_CONTROL_SELECTOR = 'a[href],button,[role="button"],[tabindex="0"]';

/** True when `el` sits inside (or is) a genuinely interactive control. A
 *  heading/active-nav element that matches here is a LABEL on an action the
 *  user hasn't taken yet, not evidence the action was performed —
 *  real-Chrome finding (vscode.dev, goal "Get started"): the walkthrough
 *  tile's own `<h3>Get Started with VS Code for the Web</h3>` sits two
 *  levels inside `<button class="getting-started-category">`, so its mere
 *  presence on page load was being read as "goal already satisfied."
 *
 *  Missing `closest` (an older/minimal mock) defaults to "not interactive",
 *  matching this file's existing degrade-safe convention (see
 *  isElementVisible above) — a no-op against any existing fake-DOM test that
 *  doesn't provide one. */
function hasInteractiveAncestor(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest(INTERACTIVE_CONTROL_SELECTOR);
}

/** True when `el` is a same-document fragment link (href="#...") — clicking
 *  one only SCROLLS to content already present on the page (a table-of-
 *  contents entry, a "jump to this section" link), it does not trigger a new
 *  action or reveal anything that wasn't already there. Excluded from
 *  hasAvailableInteractiveCounterpart below so a genuine TOC entry pointing
 *  at the very section a heading signal just matched (e.g. Wikipedia's own
 *  `<a href="#History">History</a>`) doesn't get mistaken for "an unclicked
 *  CTA for this goal still sitting on the page." A real action-triggering
 *  control (a signup/navigation link, a button) is never a bare same-page
 *  fragment, so this exclusion is generic, not a site-specific carve-out. */
function isFragmentOnlyLink(el) {
  if (el.tagName?.toLowerCase?.() !== 'a') return false;
  const href = el.getAttribute?.('href') || '';
  return href.startsWith('#');
}

/** True when `candidate` and `headingEl` are structurally close — share a
 *  common ancestor within a small number of hops — rather than merely
 *  co-existing anywhere on the same, possibly very long, page. Real-Chrome
 *  finding (en.wikipedia.org, goal "History"): the article's own "See also"
 *  list contains a real, visible `<a>History</a>` linking to an entirely
 *  DIFFERENT article ("History of the web browser") — exact-text match,
 *  structurally isolated exactly like a real CTA link (its own parent <li>
 *  contains nothing else), but many DOM levels away from — and unrelated
 *  to — the `<h2 id="History">` section heading the goal actually reached.
 *  A genuine CTA/heading pairing (a hero heading next to its own "GET
 *  STARTED" button) is always structurally close, the same visual block —
 *  bounding the search to nearby ancestors keeps a far-away incidental
 *  match (a citation, a "See also"/related-links entry) from counting as a
 *  counterpart. Missing `contains`/`parentElement` (an older/minimal mock)
 *  defaults to "near enough" — for this specific check, erring toward
 *  suppressing an uncertain match is the safer choice, since the failure
 *  mode this whole fix exists to prevent (a false completion) is worse than
 *  the failure mode of occasionally requiring one extra confirmation. */
function isStructurallyNear(headingEl, candidate, maxHops = 6) {
  if (typeof candidate.parentElement === 'undefined') return true;
  let node = candidate.parentElement;
  for (let hops = 0; node && hops < maxHops; hops++, node = node.parentElement) {
    if (typeof node.contains === 'function' && node.contains(headingEl)) return true;
  }
  return false;
}

/** True when a genuinely interactive, visible, not-yet-fragment-only,
 *  structurally-near control exists ELSEWHERE on the page whose own
 *  text/accessible-name is essentially THE SAME target as `targetObject`
 *  (see isSameTargetPhrase). Real-Chrome findings (squarespace.com, goal
 *  "Get started"; notion.com/product/calendar, goal "Get Notion Calendar
 *  for free"): a marketing heading ("Getting started has never been easier
 *  with AI") sitting BESIDE — not inside — a real, unclicked "GET STARTED
 *  →" CTA link is a different case from Approach A's heading-inside-a-
 *  button pattern (hasInteractiveAncestor doesn't apply — the heading and
 *  the CTA are siblings, not parent/child), but the underlying problem is
 *  the same: the heading merely DESCRIBES an action that a real, still-
 *  available control on the same page actually performs. When such a
 *  control exists nearby, the heading is evidence of that description, not
 *  of the action having been taken — the goal is not yet satisfied. */
function hasAvailableInteractiveCounterpart(doc, targetObject, targetTokens, headingEl) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return false;
  for (const el of doc.querySelectorAll(INTERACTIVE_CONTROL_SELECTOR)) {
    if (!isElementVisible(el)) continue;
    if (isFragmentOnlyLink(el)) continue;
    const text = normalize(el.textContent || el.getAttribute?.('aria-label') || '');
    if (!text) continue;
    const matches = text === targetObject || isSameTargetPhrase(targetTokens, UIGroundingService.tokenize(text));
    if (matches && isStructurallyNear(headingEl, el)) return true;
  }
  return false;
}

/** True when `token` and `other` are the same word, tolerating simple
 *  pluralization/inflection ("request"/"requests") but NOT arbitrary
 *  substring containment. Real-Chrome finding (en.wikipedia.org, goal
 *  "History"): a raw `a.includes(b) || b.includes(a)` check — the same
 *  pattern tokenOverlapMatches above already uses safely, because it only
 *  ever runs one-directionally against a single, already-whole-word-
 *  filtered heading — treated short token "tor" (linking to "Tor Browser")
 *  as "covered by" target token "history", purely because "tor" is a
 *  coincidental substring of "hisTORy". Requiring the length difference
 *  between the two tokens to be small (≤2 characters) keeps genuine
 *  inflection matches while rejecting a short token that merely happens to
 *  appear inside an unrelated longer word. */
function isCloseTokenMatch(token, other) {
  if (token === other) return true;
  const shorter = token.length <= other.length ? token : other;
  const longer  = token.length <= other.length ? other : token;
  return longer.includes(shorter) && longer.length - shorter.length <= 2;
}

/** True when `tokensA` and `tokensB` describe essentially THE SAME target —
 *  every token of A is covered by some token of B and vice versa. Deliberately
 *  BIDIRECTIONAL, unlike tokenOverlapMatches (which only requires the
 *  target's own tokens to be covered, one-directionally, by the candidate —
 *  right for "does this heading express the same idea, possibly with extra
 *  words" but wrong here). Real-Chrome finding: a real GitHub "New pull
 *  request" button one-directionally covers target "pull requests" (shares
 *  "pull" and "requests"~"request"), which would wrongly disqualify a real,
 *  already-reached Pull Requests page's own heading if used for this check —
 *  but it is NOT essentially the same target, because it introduces a whole
 *  extra concept ("new") the target never mentioned. A genuine CTA
 *  counterpart ("Get Notion Calendar free" for target "get notion calendar
 *  for free") has no such extra content on either side. */
function isSameTargetPhrase(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return false;
  const isCoveredBy = (token, otherTokens) => otherTokens.some((o) => isCloseTokenMatch(token, o));
  return tokensA.every((t) => isCoveredBy(t, tokensB)) && tokensB.every((t) => isCoveredBy(t, tokensA));
}

/** True when `needle` appears in `haystack` as a whole word/phrase, not
 *  merely as a substring of a longer word. Real-Chrome finding (youtube.com,
 *  goal "Search"): the placeholder heading "Try searching to get started" —
 *  shown precisely when NOTHING has been searched yet, an empty-state
 *  message — satisfied a raw substring check purely because "search" is a
 *  textual prefix of "searching", declaring the goal already done. Boundary
 *  = start/end of string or a non-alphanumeric character on either side,
 *  consistent with how tokenize() elsewhere in this codebase already splits
 *  on non-alphanumeric runs. */
function includesWholeWord(haystack, needle) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/** True when `targetObject` appears as a genuine URL PATH SEGMENT in
 *  `normUrl` — "/issues" matches ".../issues" and ".../issues/123", but not
 *  ".../issuesXYZ" or a hostname that merely starts with the same letters.
 *  Real-Chrome finding (news.ycombinator.com, goal "new"): the OLD check
 *  (`normUrl.includes('/' + targetObject)`) matched because the hostname
 *  "news.ycombinator.com" contains "/new" as a substring — the leading "//"
 *  of "https://" plus "new" from "news" — declaring the goal satisfied on
 *  the homepage with nothing to do with "new" stories at all. Deliberately
 *  NOT reusing includesWholeWord() above: that helper expects a bare word
 *  and matches a boundary character on both sides, but here the needle is
 *  constructed with its own leading "/", which already IS the left
 *  boundary — requiring another one before it rejects legitimate matches
 *  like ".../issues" (the "s" of a hostname or preceding path segment isn't
 *  a boundary character, so the older helper's dual-boundary check
 *  incorrectly failed this exact "/issues" case in testing). */
function urlPathSegmentIncludes(normUrl, targetObject) {
  const escaped = targetObject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/${escaped}([^a-z0-9]|$)`, 'i').test(normUrl);
}

function hrefIncludes(loc, pattern) {
  if (!pattern) return null;                 // nothing to test → unknown
  const href = (loc && loc.href) || '';
  return href.includes(pattern);
}

/** Visible page text contains `text` (case-insensitive). Uses innerText so hidden
 *  nodes are excluded the same way a user would perceive the page. */
function textPresent(doc, text) {
  const needle = normalize(text);
  if (!needle) return null;
  const body = doc && doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
  return normalize(body).includes(needle);
}

/** An element with a matching accessible name (aria-label / title / img alt) OR a
 *  matching visible text label exists. Plain scan — no matcher, no scoring. */
function elementPresent(doc, text) {
  const needle = normalize(text);
  if (!needle) return null;
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  for (const el of doc.querySelectorAll('[aria-label],[title],img[alt]')) {
    if (!isElementVisible(el)) continue;
    const name = normalize(
      el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || ''
    );
    if (name.includes(needle)) return true;
  }
  for (const el of doc.querySelectorAll('a,button,[role="button"],[role="link"],h1,h2,h3,summary,li,td,strong,span')) {
    if (!isElementVisible(el)) continue;
    if (normalize(el.textContent || '').includes(needle)) return true;
  }
  return false;
}

/**
 * Evaluate a single SuccessSignal.
 * @returns {{ type: string, target: string, passed: boolean|null }}
 *   passed === null means "could not evaluate" (missing target, no DOM, or an
 *   unsupported signal type) → contributes to an "unknown" verdict.
 */
function evaluateSignal(signal, doc, loc) {
  const type   = signal && signal.type;
  const target = (signal && (signal.urlPattern ?? signal.text)) ?? '';
  let passed;
  switch (type) {
    case 'url_matches':     passed = loc ? hrefIncludes(loc, signal.urlPattern) : null; break;
    case 'url_leaves':      { const inc = loc ? hrefIncludes(loc, signal.urlPattern) : null; passed = inc === null ? null : !inc; break; }
    case 'text_present':    passed = textPresent(doc, signal.text); break;
    case 'element_present': passed = elementPresent(doc, signal.text); break;
    case 'element_absent':  { const pres = elementPresent(doc, signal.text); passed = pres === null ? null : !pres; break; }
    default:                passed = null; // unsupported type → unknown
  }
  return { type: type || 'unknown', target, passed };
}

const ACTION_PREFIXES = [
  'navigate to', 'head to', 'go to', 'visit', 'check', 'open', 'view',
  'see', 'find', 'enter', 'select', 'show', 'click on', 'click',
  'fill', 'search for', 'search', 'type', 'look at',
  // Toggle/checkbox-goal verbs — stripped for the same reason as the navigation
  // verbs above: the destination control's own accessible name says what it IS
  // ("Two-factor authentication"), not the imperative the user asked for
  // ("enable two-factor authentication") — leaving the verb in would make it a
  // mandatory (and never-matching) content token in the DOM-mutation signal.
  'turn on', 'turn off', 'switch on', 'switch off',
  'enable', 'disable', 'activate', 'deactivate', 'toggle'
];

function extractTargetObject(goal) {
  let norm = normalize(goal);
  for (const prefix of ACTION_PREFIXES) {
    if (norm.startsWith(prefix + ' ')) {
      norm = norm.slice(prefix.length + 1).trim();
      break;
    }
  }
  return norm.replace(/^['"]|['"]$/g, '').trim();
}

export const GoalVerifier = {
  extractTargetObject,

  /**
   * Determine whether a natural language goal is ALREADY satisfied by generic page state.
   */
  isGoalSatisfied(goal, pageState = null, env = {}) {
    const t0 = Date.now();
    const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
    const loc = env.loc ?? (typeof location !== 'undefined' ? location : null);
    const url = pageState?.url || (loc && loc.href) || '';

    if (!goal) return { satisfied: false, reason: 'no_goal', latencyMs: Date.now() - t0 };

    const targetObject = extractTargetObject(goal);
    if (!targetObject || targetObject.length < 2) {
      return { satisfied: false, reason: 'unclear_target_object', latencyMs: Date.now() - t0 };
    }

    const targetTokens = UIGroundingService.tokenize(targetObject);
    const isMultiWord = targetTokens.length >= 2;

    // 1. URL Path / Query / Hash Signal (e.g. /issues, /practice, /settings, /pulls, /billing)
    if (url) {
      const normUrl = url.toLowerCase();
      const urlSegments = normUrl.split(/[/\-?#&=._]/).filter(s => s.length > 2);
      if (urlSegments.includes(targetObject) || urlPathSegmentIncludes(normUrl, targetObject)) {
        return { satisfied: true, reason: 'url_matches_target_object', targetObject, latencyMs: Date.now() - t0 };
      }
      // 1b. Multi-word target, per-token substring match against the URL (e.g.
      // "notification preferences" -> "notification" alone appearing in a URL
      // segment like "/settings/notifications" — a whole-phrase match can never
      // work here since URL segments never contain literal spaces).
      if (isMultiWord && tokenOverlapMatches(targetTokens, urlSegments)) {
        return { satisfied: true, reason: 'url_token_overlap_match', targetObject, latencyMs: Date.now() - t0 };
      }
    }

    // 2. Active Navigation Tab / ARIA Current Signal
    if (doc && typeof doc.querySelectorAll === 'function') {
      for (const el of doc.querySelectorAll('[aria-current="page"],[aria-selected="true"],.active,.selected,[data-active="true"]')) {
        if (!isElementVisible(el)) continue;
        if (hasInteractiveAncestor(el)) continue;
        const text = normalize(el.textContent || el.getAttribute('aria-label') || '');
        // Real-Chrome finding (vscode.dev, goal "Get started"): `.active` is a
        // generic CSS class that also matches large structural containers, not
        // just real nav-item elements — VS Code's main
        // `.editor-group-container.active` matched here with textContent being
        // the ENTIRE active editor pane's rendered text (thousands of
        // characters: menu commands, shortcuts, breadcrumbs, walkthrough
        // content), which happened to contain "get started" as a substring —
        // declaring the goal complete before any click. A real active
        // nav-item/tab label is short; the substring branch is gated to that
        // case only. Exact equality (a short target matching a short label
        // exactly) is unaffected — it can't produce this failure.
        if (text === targetObject || (text && text.length <= 120 && includesWholeWord(text, targetObject))) {
          return { satisfied: true, reason: 'active_nav_matches_target_object', targetObject, latencyMs: Date.now() - t0 };
        }
      }
      // 3. Heading Signal — whole-phrase first (h1/h2/h3/legend/[role=heading]),
      // then multi-word token-overlap fallback for phrasing that doesn't literally
      // appear (e.g. target "notification preferences" vs. heading "Notifications").
      //
      // A heading that matches is trusted UNLESS a genuinely interactive,
      // available control elsewhere on the page ALSO matches the same target
      // (hasAvailableInteractiveCounterpart) — that pattern means the heading
      // is describing/promoting an action a real, unclicked control still
      // performs (a marketing headline beside its own CTA button), not
      // reporting that the action already happened. See that function's doc
      // comment for the full real-Chrome evidence. A match that IS suppressed
      // this way doesn't stop the loop — a DIFFERENT heading with no such
      // counterpart may still legitimately satisfy the goal.
      for (const el of doc.querySelectorAll('h1, h2, h3, legend, [role="heading"]')) {
        if (!isElementVisible(el)) continue;
        if (hasInteractiveAncestor(el)) continue;
        const headingText = normalize(el.textContent || '');
        if (!headingText) continue;
        const wholePhraseMatch = headingText === targetObject || includesWholeWord(headingText, targetObject);
        const tokenOverlapMatch = !wholePhraseMatch && isMultiWord &&
          tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(headingText));
        if (wholePhraseMatch || tokenOverlapMatch) {
          if (hasAvailableInteractiveCounterpart(doc, targetObject, targetTokens, el)) continue;
          return {
            satisfied: true,
            reason: wholePhraseMatch ? 'heading_matches_target_object' : 'heading_token_overlap_match',
            targetObject,
            latencyMs: Date.now() - t0,
          };
        }
      }
      // 4. DOM-mutation signal — a control matching the target's own accessible name
      // is now checked/pressed. Covers goals like "enable two-factor auth" or "turn
      // off email notifications" that complete via a toggle, not navigation.
      // Real-DOM only: live checked/pressed state isn't captured generically in the
      // pageState.elements fallback below (that branch only exists for headless/test
      // environments, where isGoalSatisfied is always called with a real document
      // in the actual content-script runtime).
      //
      // Deliberately NOT [aria-expanded="true"] (removed after a real-Chrome
      // finding, vscode.dev goal "Open Folder"): aria-expanded is a disclosure-
      // widget/accordion VISIBILITY state ("is this panel's content currently
      // shown"), not a settings/goal-achievement state like aria-checked or
      // aria-pressed. VS Code's own Explorer sidebar has a collapsible section
      // header — `aria-expanded="true" aria-label="No Folder Opened Section"` —
      // that is simply visually expanded (ordinary UI chrome, nothing to do
      // with the goal), whose label happens to contain "folder", so the goal
      // was declared complete before any folder was ever opened — the header
      // literally says "No Folder Opened". aria-checked/aria-pressed/
      // input:checked don't share this problem: they're tied to a specific
      // setting's own state, not a container's open/closed chrome.
      for (const el of doc.querySelectorAll('[aria-checked="true"],[aria-pressed="true"],input:checked')) {
        if (!isElementVisible(el)) continue;
        const name = normalize(accessibleName(el, doc));
        if (!name) continue;
        if (tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(name))) {
          return { satisfied: true, reason: 'toggle_state_matches_target', targetObject, latencyMs: Date.now() - t0 };
        }
      }
    } else if (Array.isArray(pageState?.elements)) {
      for (const el of pageState.elements) {
        if (!el.visible) continue;
        const text = normalize(el.text || el.ariaLabel || '');
        if (!text) continue;
        if ((el.tag === 'h1' || el.tag === 'h2' || el.tag === 'h3' || el.tag === 'legend' || el.role === 'heading') && text.includes(targetObject)) {
          return { satisfied: true, reason: 'page_state_heading_matches', targetObject, latencyMs: Date.now() - t0 };
        }
        if (isMultiWord && (el.tag === 'h1' || el.tag === 'h2' || el.tag === 'h3' || el.tag === 'legend' || el.role === 'heading') &&
            tokenOverlapMatches(targetTokens, UIGroundingService.tokenize(text))) {
          return { satisfied: true, reason: 'page_state_heading_token_overlap_match', targetObject, latencyMs: Date.now() - t0 };
        }
      }
    }

    return { satisfied: false, reason: 'not_yet_satisfied', targetObject, latencyMs: Date.now() - t0 };
  },

  /**
   * Evaluate goalCompletionCriteria against the current page.
   *
   * @param {import('../shared/types/index.js').GoalCompletionCriteria} criteria
   * @param {{ doc?: Document, loc?: Location }} [env] - injectable for tests
   * @returns {{ satisfied: boolean, verdict: 'satisfied'|'unsatisfied'|'unknown',
   *             matchedSignals: number, totalSignals: number,
   *             details: Array<{type: string, target: string, passed: boolean|null}> }}
   */
  evaluate(criteria, env = {}) {
    const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
    const loc = env.loc ?? (typeof location !== 'undefined' ? location : null);

    const signals = Array.isArray(criteria && criteria.successSignals) ? criteria.successSignals : [];
    const totalSignals = signals.length;

    if (totalSignals === 0) {
      return { satisfied: false, verdict: 'unknown', matchedSignals: 0, totalSignals: 0, details: [] };
    }

    const details = signals.map((s) => evaluateSignal(s, doc, loc));
    const matchedSignals = details.filter((d) => d.passed === true).length;
    const anyUnknown     = details.some((d) => d.passed === null);

    // Match rule: 'any' → ≥1 signal passes; anything else defaults to 'all'.
    const match = criteria && criteria.match === 'any' ? 'any' : 'all';
    const satisfied = match === 'any' ? matchedSignals >= 1 : matchedSignals === totalSignals;

    let verdict;
    if (satisfied)            verdict = 'satisfied';
    else if (anyUnknown)      verdict = 'unknown';
    else                      verdict = 'unsatisfied';

    return { satisfied, verdict, matchedSignals, totalSignals, details };
  },

  /**
   * Phase 26 — completion gate. Decides whether the verifier may DRIVE completion.
   *
   * @param {import('../shared/types/index.js').GoalCompletionCriteria|null} criteria
   * @param {{ doc?: Document, loc?: Location }} [env]
   * @param {string} [goal]
   * @param {object} [pageState]
   */
  shouldComplete(criteria, env = {}, goal = null, pageState = null) {
    const result = (() => {
      try {
        if (criteria && criteria.requiresEffect === true) {
          const verdict = this.evaluate(criteria, env);
          if (!verdict.satisfied) {
            return { complete: false, reason: 'unsatisfied', verdict };
          }
          if (typeof criteria.confidenceThreshold === 'number' && verdict.totalSignals > 0 &&
              (verdict.matchedSignals / verdict.totalSignals) < criteria.confidenceThreshold) {
            return { complete: false, reason: 'below_confidence_threshold', verdict };
          }
          return { complete: true, reason: 'signals_satisfied', verdict };
        }
        // `genericCheck` is attached to whichever result is returned below so a
        // caller running several checks in ONE planning cycle can reuse this
        // exact result instead of re-scanning the same live document with the
        // same inputs a few milliseconds later. It stays undefined whenever no
        // generic check was actually performed (no goal given, or a
        // requiresEffect contract short-circuited above), so a caller can
        // always tell "computed and unsatisfied" from "not computed".
        let genericCheck;
        if (goal) {
          genericCheck = this.isGoalSatisfied(goal, pageState, env);
          if (genericCheck.satisfied) {
            return { complete: true, reason: 'goal_already_satisfied', verdict: { satisfied: true, reason: genericCheck.reason }, genericCheck };
          }
        }
        if (!criteria) return { complete: false, reason: 'no_criteria', verdict: null, genericCheck };
        if (criteria.requiresEffect !== true) return { complete: false, reason: 'no_effect_contract', verdict: null, genericCheck };
        return { complete: false, reason: 'unsatisfied', verdict: null, genericCheck };
      } catch {
        return { complete: false, reason: 'evaluation_error', verdict: null };
      }
    })();
    // Diagnostic only — logs the exact decision this call produced, no behavior change.
    console.log("[SP:GoalVerifier]", {
      complete:       result.complete,
      reason:         result.reason,
      matchedSignals: result.verdict?.matchedSignals,
      totalSignals:   result.verdict?.totalSignals,
      details:        result.verdict?.details
    });
    return result;
  },
};
