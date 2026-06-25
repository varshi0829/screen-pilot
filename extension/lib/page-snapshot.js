// ScreenPilot v2 — Page Snapshot
//
// Captures a stable, lightweight fingerprint of the current page state.
// Used as the pre-action baseline that the Validator compares against
// post-action state to determine whether a step succeeded.
//
// The domHash is an FNV-32a hash over the accessible text of the 60 most
// prominent interactive elements visible in the viewport. It changes when
// the page adds, removes, or relabels interactive elements — which is the
// signal we care about, not attribute churn or animation updates.

/**
 * Capture a PageSnapshot of the current page.
 *
 * @param {string} [highlightedElementText] - Accessible text of the element
 *   the Executor is about to highlight. Stored so the Validator can verify
 *   whether that element disappeared after the user acted.
 * @returns {import('../shared/types/index.js').PageSnapshot}
 */
export function capturePageSnapshot(highlightedElementText = '') {
  return {
    url:                    window.location.href,
    title:                  document.title,
    domHash:                _computeDomHash(),
    highlightedElementText: String(highlightedElementText),
    capturedAt:             Date.now(),
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function _computeDomHash() {
  const els = document.querySelectorAll(
    'button,a,input,select,textarea,' +
    '[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
  );
  let fingerprint = '';
  let count = 0;
  for (const el of els) {
    if (!_isVisible(el)) continue;
    const text = (
      el.getAttribute('aria-label') ||
      el.innerText                  ||
      el.getAttribute('placeholder') ||
      ''
    ).trim().slice(0, 20);
    fingerprint += `${text}|`;
    if (++count >= 60) break;
  }
  return _fnv32a(fingerprint);
}

function _isVisible(el) {
  if (el.offsetParent === null && el.tagName !== 'BODY') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// FNV-32a — fast, non-cryptographic, stable across identical inputs.
// Suitable for DOM fingerprinting where collision resistance is not required.
function _fnv32a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
