// ScreenPilot v2 — Page Snapshot
//
// Captures a stable, lightweight fingerprint of the current page state.
// Used as the pre-action baseline that the Validator compares against
// post-action state to determine whether a step succeeded.
//
// The domHash is an FNV-32a hash over the accessible text of the first 200
// visible interactive elements in DOM order. It changes when
// the page adds, removes, or relabels interactive elements — which is the
// signal we care about, not attribute churn or animation updates.
//
// computeRelevantStateFingerprint() (Phase 7) is a SEPARATE, deliberately
// narrower fingerprint with a different contract: it is a pure function of an
// already-extracted PageStateService-shaped pageState object — no DOM access
// of its own, no second extraction, and no dependency on L1/L2/L3 routing or
// on any settled-step/candidate filtering. It exists so v2-task.js can decide
// whether the RELEVANT interactive surface has changed since the last real
// planning cycle without paying for a fresh DOM walk. See its own doc comment
// for exactly what it includes/excludes and why.

import { PrivacySanitizer } from './privacy-sanitizer.js';

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
    // Same DOM-order-first-N truncation pattern confirmed as a real bug in
    // page-state-service.js's element cap (see its comment there) — here it
    // means a DOM mutation past the first N interactive elements never changes
    // the hash, so stale-plan discard and the dedup guard can silently miss
    // it. Raised as a precautionary analog of that confirmed fix, not a fully
    // reproduced-and-closed bug itself: on an artificial worst case (a button
    // appended as literally the last of 423 interactive elements on
    // github.com/microsoft/vscode) this cap still doesn't cover it — that
    // remains a known residual limitation of any DOM-order-based cap, same as
    // the page-state-service.js one. Purely local/never-network computation,
    // so raising it costs nothing but a little iteration time — kept bounded
    // (not removed outright) because capturePageSnapshot() runs on a tight
    // budget: the executor's 150ms post-action verification polls it every
    // ~25ms.
    if (++count >= 200) break;
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

// ── Relevant-state fingerprint (Phase 7) ────────────────────────────────────

// Same truncation length compact-page-state.js's toCompactElement() already
// uses for a label — not reinvented, just matched, so a fingerprint label and
// a compact-element name mean the same thing wherever both exist.
const FINGERPRINT_LABEL_MAX_LEN = 60;

/**
 * Privacy-safe label for one element's fingerprint entry. Never reads
 * text/value for a field PrivacySanitizer classifies as sensitive — only its
 * static label (placeholder/ariaLabel), or the fixed REDACTED marker when
 * even that is absent — mirroring compact-page-state.js's bestName() exactly,
 * so sensitivity handling is expressed identically in both places rather than
 * re-derived with different rules.
 *
 * @param {object} el - a PageStateService-shaped element
 * @returns {string}
 */
function _fingerprintLabel(el) {
  const sensitiveType = PrivacySanitizer.getSensitiveType(el);
  if (sensitiveType) {
    const label = el.placeholder || el.ariaLabel || '';
    return label ? label.slice(0, FINGERPRINT_LABEL_MAX_LEN) : PrivacySanitizer.REDACTED;
  }
  const raw = el.text || el.placeholder || el.ariaLabel || '';
  return raw.slice(0, FINGERPRINT_LABEL_MAX_LEN);
}

/**
 * A small, deterministic, decision-relevant projection of an
 * ALREADY-EXTRACTED PageStateService-shaped pageState — pure, no DOM access,
 * no second extraction, independent of L1/L2/L3 routing, settled-step
 * filtering, or any model output.
 *
 * Deliberately excludes:
 *   - the synthetic per-extraction `el.id` (`el_N`) — not a stable identity
 *     across cycles (reassigned in DOM order on every extraction), so using
 *     it would produce false "changed" results whenever an unrelated element
 *     earlier in DOM order appears/disappears. (role, label, formId) is the
 *     natural key instead.
 *   - raw text/value of a sensitive field — only its static label, or REDACTED.
 *   - checked/selected/pressed state — PageStateService.extractPageState()
 *     does not currently capture it (GoalVerifier's own toggle-state signal
 *     has to query the live DOM directly for exactly this reason), and
 *     capturing it here would require either a second DOM walk or a change to
 *     page-state-service.js — both out of scope. Documented gap, not a silent
 *     omission: GoalVerifier's own goal-completion check still runs
 *     independently, every cycle, directly against the live DOM regardless of
 *     this fingerprint — so a toggle/checkbox this fingerprint can't see
 *     changing can cost at most one extra cycle of latency before the router
 *     re-examines it, never a missed completion.
 *
 * @param {{url?: string, elements?: object[]}} pageState - a
 *   PageStateService-shaped object (the same one v2-task.js already extracted
 *   this cycle)
 * @returns {{url: string, count: number, hash: string}}
 */
export function computeRelevantStateFingerprint(pageState) {
  const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];

  const projected = [];
  for (const el of elements) {
    if (!el || el.visible === false || el.enabled === false) continue;
    projected.push({
      role: el.role || '',
      label: _fingerprintLabel(el),
      // The one "relevant structural relationship" already available without
      // extra cost — the native <form> association PageStateService already
      // resolves (resolveFormId), surfaced here as-is.
      formId: el.formId ?? null,
      // Boolean only — never the raw value, even for a non-sensitive field.
      valuePresent: !!(el.value && el.value.trim())
    });
  }

  // Sort before hashing so pure DOM-order churn (an element moving earlier or
  // later without any of these four fields changing) can never change the
  // hash on its own.
  projected.sort((a, b) => {
    const af = a.formId ?? '', bf = b.formId ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    if (a.valuePresent !== b.valuePresent) return a.valuePresent ? 1 : -1;
    return 0;
  });

  return {
    url: pageState?.url ?? '',
    count: projected.length,
    hash: _fnv32a(JSON.stringify(projected))
  };
}
