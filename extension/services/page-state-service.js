// ScreenPilot v2 — Generic Normalized Page-State Service
//
// Extracts a website-agnostic, lightweight, normalized JSON representation of
// the current live webpage DOM state. Used by Fast Path, Small ML Scorer, and
// Local Qwen Planner to reason without raw HTML or cloud LLM calls.
//
// Accessible-name resolution (see resolveAccessibleName) reads only standard
// DOM/ARIA relationships (aria-label, aria-labelledby, label[for], an
// ancestor <label>, title, img[alt]) — no site-specific logic. An element
// whose only accessible name comes from one of these (rather than an inline
// aria-label/placeholder) previously extracted with NO usable text at all,
// making it invisible to L1/L2 scoring and to Qwen's candidate list.
//
// Every element passes through PrivacySanitizer before this function returns,
// so sensitive text/value content never enters the L1/L2/L3 pipeline (and
// therefore never reaches a cloud request) in the first place — this applies
// identically regardless of which accessible-name source populated
// `ariaLabel`, since sanitization only ever looks at the final field value.

import { PrivacySanitizer } from '../lib/privacy-sanitizer.js';

export const PageStateService = (() => {
  'use strict';

  /**
   * Normalize whitespace and trim string.
   */
  function clean(str, maxLen = 80) {
    if (typeof str !== 'string') return '';
    return str.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  /**
   * Determine element role based on ARIA role or DOM tag.
   */
  function getRole(el) {
    const ariaRole = el.getAttribute?.('role');
    if (ariaRole) return clean(ariaRole, 30);

    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type))) return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input' && ['text', 'search', 'email', 'password', 'url', 'number', 'tel'].includes(el.type || 'text')) return 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return el.type;
    return tag || 'generic';
  }

  /**
   * Check if element is visible.
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  }

  /**
   * Resolve the text of the element(s) referenced by `aria-labelledby`
   * (a space-separated list of ids per the ARIA spec — supports multiple
   * references, joined in order). Standard DOM/ARIA relationship only, no
   * site-specific logic.
   */
  function resolveAriaLabelledBy(el, doc) {
    const idList = (el.getAttribute?.('aria-labelledby') || '').trim();
    if (!idList || typeof doc?.getElementById !== 'function') return '';
    return idList
      .split(/\s+/)
      .map((id) => {
        const ref = doc.getElementById(id);
        return ref ? (ref.innerText || ref.textContent || '') : '';
      })
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Build the document's `<label for="...">` index ONCE, as a Map from the
   * `for` value to that label's text. Earlier labels win, matching the
   * first-match-in-document-order semantics of the previous per-element
   * scan exactly.
   *
   * This exists because resolving the label per element previously issued a
   * fresh `querySelectorAll('label[for]')` — a full document walk — for
   * EVERY element carrying an id, i.e. up to one document scan per element
   * (measured: 301 scans for a 300-element page, and extractPageState runs
   * more than once per planning cycle). Indexing once is the same standard
   * DOM relationship, just not recomputed per element.
   *
   * @param {Document|null} doc
   * @returns {Map<string, string>}
   */
  function buildLabelForMap(doc) {
    const map = new Map();
    if (typeof doc?.querySelectorAll !== 'function') return map;
    for (const label of doc.querySelectorAll('label[for]')) {
      const forId = label.getAttribute?.('for');
      if (!forId || map.has(forId)) continue;
      map.set(forId, label.innerText || label.textContent || '');
    }
    return map;
  }

  /**
   * Resolve the text of an associated `<label for="id">` element from the
   * prebuilt index. Uses the id as a plain Map key rather than a CSS
   * attribute-selector with the id interpolated into it, so an id containing
   * characters that would need CSS escaping can never break the lookup.
   */
  function resolveLabelFor(el, labelForMap) {
    const id = el.id || el.getAttribute?.('id') || '';
    if (!id || !labelForMap) return '';
    return labelForMap.get(id) || '';
  }

  /**
   * Resolve the text of an ancestor `<label>` that wraps the control
   * directly (the other standard way to associate a label with a control,
   * without a `for`/id pair).
   */
  function resolveAncestorLabel(el) {
    const label = typeof el.closest === 'function' ? el.closest('label') : null;
    if (!label || label === el) return '';
    return label.innerText || label.textContent || '';
  }

  /**
   * Generic accessible-name resolution for an interactive element, using
   * only standard DOM/ARIA relationships — no website-specific logic, no
   * phrase matching. Precedence (most to least explicit): direct
   * `aria-label`, `aria-labelledby` reference(s), an associated
   * `<label for="id">`, an ancestor `<label>` wrapping the control, `title`,
   * then a nested `<img alt>` — matching the priority the existing code
   * already gave `aria-label` over `title` over `img[alt]`, with the new
   * label-based sources inserted between (a real `<label>` association is a
   * stronger, more explicit signal than a generic tooltip `title`).
   *
   * @param {Element} el
   * @param {Document|null} doc
   * @param {Map<string, string>} [labelForMap] - Prebuilt `label[for]` index
   *   (see buildLabelForMap). extractPageState passes one built once for the
   *   whole extraction; when omitted it is built on demand, so the two-argument
   *   form keeps working identically for callers outside the extraction loop.
   * @returns {string}
   */
  function resolveAccessibleName(el, doc, labelForMap = null) {
    const direct     = clean(el.getAttribute?.('aria-label') || '');
    if (direct) return direct;

    const labelledBy = clean(resolveAriaLabelledBy(el, doc));
    if (labelledBy) return labelledBy;

    const labelFor    = clean(resolveLabelFor(el, labelForMap ?? buildLabelForMap(doc)));
    if (labelFor) return labelFor;

    const ancestorLabel = clean(resolveAncestorLabel(el));
    if (ancestorLabel) return ancestorLabel;

    const title = clean(el.getAttribute?.('title') || '');
    if (title) return title;

    return clean(el.querySelector?.('img[alt]')?.getAttribute?.('alt') || '');
  }

  /**
   * Resolve a per-extraction-cycle, opaque id for the `<form>` an element is
   * natively associated with (the standard `element.form` reference every
   * form-associated control has, falling back to `closest('form')` for
   * elements/mocks that don't expose it) — the same "standard DOM
   * relationship, no site logic" pattern as resolveAccessibleName. `formMap`
   * is a WeakMap scoped to a single extractPageState() call, so the same
   * `<form>` always maps to the same id WITHIN that call, without the id
   * needing to be stable across calls or pages.
   *
   * @param {Element} el
   * @param {{ map: WeakMap<Element, string>, count: number }} formMap
   * @returns {string|null}
   */
  function resolveFormId(el, formMap) {
    const form = el.form ?? (typeof el.closest === 'function' ? el.closest('form') : null);
    if (!form) return null;
    // WeakMap has no .size — the counter is tracked separately on the map's
    // own carrier object (see the `_count` field seeded by the caller).
    if (!formMap.map.has(form)) formMap.map.set(form, `form_${formMap.count++}`);
    return formMap.map.get(form);
  }

  /**
   * Detect layout region.
   */
  function getRegion(el) {
    if (!el || typeof el.closest !== 'function') return 'main_content';
    if (el.closest('nav, header, [role="banner"], [role="navigation"]')) return 'top_navigation';
    if (el.closest('aside, [role="complementary"], [role="navigation"].sidebar, .sidebar')) return 'side_navigation';
    if (el.closest('[role="dialog"], [role="alertdialog"], .modal, .dialog')) return 'modal';
    if (el.closest('footer, [role="contentinfo"]')) return 'footer';
    return 'main_content';
  }

  /**
   * Extract normalized page state from a document/location object.
   *
   * @param {{ doc?: Document, loc?: Location }} [env]
   * @returns {import('../shared/types/index.js').NormalizedPageState}
   */
  function extractPageState(env = {}) {
    const doc = env.doc ?? (typeof document !== 'undefined' ? document : null);
    const loc = env.loc ?? (typeof location !== 'undefined' ? location : null);

    const url   = loc?.href  ?? '';
    const title = doc?.title ?? '';

    const selector = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="textbox"], summary';
    const rawEls = doc && typeof doc.querySelectorAll === 'function'
      ? Array.from(doc.querySelectorAll(selector))
      : [];

    // ScreenPilot's own on-page UI (goal input, Explain/Ask buttons, highlight
    // overlay, etc.) matches the generic selector above like any other page
    // control, so without this exclusion it entered pageState.elements and
    // became an L1/L2/Qwen candidate — reachable and lexically scoreable, but
    // never actually resolvable by the executor (which excludes it), so a
    // plan that picked it could only fail. Same selector already used by
    // collectPageControls() (v2-task.js), isScreenPilotNode() (content.js),
    // and isScreenPilotNode() (lib/dom-matcher.js) — reused here rather than
    // reinvented so all four stay in agreement about what counts as "not part
    // of the page".
    const SP_SEL = '[id^="sp-"],[id^="screenpilot-"],[class*="sp-"],[data-screenpilot]';

    const elements = [];
    let count = 0;
    const seen = new Set();
    const formMap = { map: new WeakMap(), count: 0 };
    // Indexed once for the whole extraction — see buildLabelForMap.
    const labelForMap = buildLabelForMap(doc);

    for (const el of rawEls) {
      if (seen.has(el)) continue;
      seen.add(el);

      if (el.closest?.(SP_SEL)) continue;

      const visible = isVisible(el);
      if (!visible) continue;

      const tag         = el.tagName ? el.tagName.toLowerCase() : 'div';
      const role        = getRole(el);
      const text        = clean(el.innerText || el.textContent || '');
      const placeholder = clean(el.getAttribute?.('placeholder') || '');
      const ariaLabel   = resolveAccessibleName(el, doc, labelForMap);
      const value       = typeof el.value === 'string' ? clean(el.value) : '';
      const href        = clean(el.getAttribute?.('href') || '', 120);
      const enabled     = !el.disabled;
      const region      = getRegion(el);
      const type        = tag === 'input' ? clean(el.getAttribute?.('type') || el.type || '', 20) : '';
      const autocomplete = clean(el.getAttribute?.('autocomplete') || '', 30);
      const formId      = resolveFormId(el, formMap);
      // Standard HTML `required` attribute — real DOM elements resolve this
      // as a boolean property; the attribute check covers mocks/environments
      // that only expose getAttribute. No site knowledge: this is the native
      // signal a form itself uses to say a field must be filled before submit.
      const required    = Boolean(el.required) || el.getAttribute?.('required') != null;

      // Skip elements without machine-readable or visible labels. A button
      // (real <button> or role="button") is kept even with no accessible name
      // at all — an icon-only button conveying its purpose purely visually
      // (e.g. via CSS/pseudo-elements, no text/aria-label/title) is a standard,
      // generic UI pattern, not a "no information" element: it still carries
      // role, tag, and a bounding box, which is exactly what visual-perception
      // (Moondream) candidate resolution needs. Without this, such a button was
      // silently dropped before L1/L2/L3 ever saw it, so it could never be
      // offered as a candidate — a downstream "no match" (or vision returning
      // elementId: null) was actually an upstream "never a candidate" bug.
      if (!text && !placeholder && !ariaLabel && !value && !href && role !== 'textbox' && role !== 'button') continue;

      let bbox = null;
      if (typeof el.getBoundingClientRect === 'function') {
        const r = el.getBoundingClientRect();
        bbox = { x: Math.round(r.x || r.left || 0), y: Math.round(r.y || r.top || 0), width: Math.round(r.width || 0), height: Math.round(r.height || 0) };
      }

      count += 1;
      const id = `el_${count}`;

      elements.push({
        id,
        role,
        tag,
        text,
        placeholder,
        ariaLabel,
        value,
        href,
        visible,
        enabled,
        region,
        bbox,
        type,
        autocomplete,
        formId,
        required
      });

      // Cap in raw DOM order. Real-Chrome finding (getbootstrap.com docs page,
      // 362 total interactive elements — mostly per-code-example "Copy to
      // clipboard" buttons — with a legitimate, unambiguous exact-match target
      // sitting at DOM position 300): the old cap of 50 silently excluded it
      // from L1/L2's candidate pool entirely, forcing an unnecessary L3
      // escalation for what should have been a free, instant match. Neither
      // the cloud path (uses the separately-built, separately-capped
      // pageControls) nor Qwen (re-slices its own prompt input to 25) actually
      // consumes this array beyond a small prefix, so raising it doesn't grow
      // any network payload — it only widens L1/L2's own local candidate pool.
      // 300 covers the measured real case above (position 300) with no margin
      // to spare; pages with an even more extreme control count can still
      // exceed it, an accepted residual limitation of a DOM-order cap, not a
      // regression — L1/L2's per-element cost is simple string/token
      // comparisons, negligible even at this size.
      if (count >= 300) break;
    }

    // Sanitize before this ever returns — no caller (L1/L2 matching, the Qwen
    // prompt builder, or a cloud request) ever sees an unredacted element.
    const sanitizedElements = PrivacySanitizer.sanitizeElements(elements);
    const sensitiveRegions  = PrivacySanitizer.getSensitiveRegions(elements);

    return {
      url,
      title,
      elements: sanitizedElements,
      sensitiveRegions,
      timestamp: Date.now()
    };
  }

  return { extractPageState, clean, getRole, resolveAccessibleName };
})();

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = PageStateService;
}
