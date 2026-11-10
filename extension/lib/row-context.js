// ScreenPilot — Row/container context for a LIVE control.
//
// The executor needs to ask of a live DOM element the very question
// PageStateService.extractPageState() answered about it when page state was
// built: "which row/list item does this control sit in?" (`element.context`).
// Comparing the two answers is what lets the executor tell identically-labelled
// controls apart by WHICH ROW they belong to rather than by where they happened
// to be painted.
//
// This is the same algorithm as page-state-service.js's resolveContext, kept as
// a standalone module because that file is a pinned V3-owned file and its
// helper is private. Both MUST produce the same string for the same element —
// tests/executor-identity-resolution.test.mjs asserts that parity on a shared
// DOM, so drift fails a test instead of silently breaking identity resolution.

import { redactText } from './pii-detector.js';

const CONTEXT_MAX_LEN      = 60;
const CONTEXT_MAX_RAW      = 400;
const CONTEXT_MAX_DEPTH    = 8;
const CONTEXT_MAX_CONTROLS = 12;
const ROW_SELECTOR         = 'li, tr, article, [role="listitem"], [role="row"], [role="option"], [role="treeitem"], [role="article"]';
const REGION_TAGS          = new Set(['BODY', 'HTML', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'SECTION']);
const CONTROL_SELECTOR     = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], summary';

function clean(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function removeOwnLabel(text, label) {
  const needle = (label || '').trim().toLowerCase();
  if (!needle) return text;
  let out = text;
  let idx = out.toLowerCase().indexOf(needle);
  while (idx !== -1) {
    out = out.slice(0, idx) + ' ' + out.slice(idx + needle.length);
    idx = out.toLowerCase().indexOf(needle);
  }
  return out;
}

function isRowLike(node) {
  if (typeof node.matches === 'function' && node.matches(ROW_SELECTOR)) return true;
  const siblings = node.parentElement?.children;
  if (!siblings || siblings.length < 2) return false;
  let same = 0;
  for (const sib of siblings) {
    if (sib.tagName === node.tagName && (sib.className || '') === (node.className || '')) same += 1;
    if (same >= 2) return true;
  }
  return false;
}

/**
 * @param {Element} el
 * @param {string} ownText  - the control's own text, cleaned exactly as page state cleans it
 * @param {string} ownLabel - the control's own accessible name, resolved exactly as page state resolves it
 * @returns {string} short row text, or '' when the control is not in a row
 */
export function resolveRowContext(el, ownText, ownLabel) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < CONTEXT_MAX_DEPTH; depth++, node = node.parentElement) {
    if (REGION_TAGS.has(node.tagName)) return '';
    const controls = typeof node.querySelectorAll === 'function' ? node.querySelectorAll(CONTROL_SELECTOR).length : 0;
    if (controls > CONTEXT_MAX_CONTROLS) return '';
    if (!isRowLike(node)) continue;

    const raw = clean(node.innerText || node.textContent || '', CONTEXT_MAX_RAW);
    const remaining = clean(removeOwnLabel(removeOwnLabel(raw, ownText), ownLabel), CONTEXT_MAX_LEN);
    if (remaining) return redactText(remaining);
  }
  return '';
}
