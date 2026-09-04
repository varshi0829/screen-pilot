// ScreenPilot v2 — Generic Normalized Page-State Service
//
// Extracts a website-agnostic, lightweight, normalized JSON representation of
// the current live webpage DOM state. Used by Fast Path, Small ML Scorer, and
// Local Qwen Planner to reason without raw HTML or cloud LLM calls.

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

    const elements = [];
    let count = 0;
    const seen = new Set();

    for (const el of rawEls) {
      if (seen.has(el)) continue;
      seen.add(el);

      const visible = isVisible(el);
      if (!visible) continue;

      const tag         = el.tagName ? el.tagName.toLowerCase() : 'div';
      const role        = getRole(el);
      const text        = clean(el.innerText || el.textContent || '');
      const placeholder = clean(el.getAttribute?.('placeholder') || '');
      const ariaLabel   = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.querySelector?.('img[alt]')?.getAttribute?.('alt') || '');
      const value       = typeof el.value === 'string' ? clean(el.value) : '';
      const href        = clean(el.getAttribute?.('href') || '', 120);
      const enabled     = !el.disabled;
      const region      = getRegion(el);

      // Skip elements without machine-readable or visible labels
      if (!text && !placeholder && !ariaLabel && !value && !href && role !== 'textbox') continue;

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
        bbox
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

    return {
      url,
      title,
      elements,
      timestamp: Date.now()
    };
  }

  return { extractPageState, clean, getRole };
})();

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = PageStateService;
}
