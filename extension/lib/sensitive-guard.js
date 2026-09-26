// ScreenPilot — Sensitive-field guard (guide-only)
//
// ScreenPilot only ever highlights a field and waits for the user; it never
// types. This guard decorates the highlighter so that when the element about
// to be highlighted is a sensitive field (password, card, OTP, …) the on-screen
// instruction is replaced by the fixed policy text telling the user to enter
// the value THEMSELVES. It classifies the ACTUAL resolved DOM element from its
// attributes only — never from what has been typed into it — and never reads,
// stores or logs a field value.
//
// It wraps the highlighter object handed to ExecutorEngine (which is
// constructor-injected), so no executor code changes.

import { classifyElement } from './pii-detector.js';
import { fieldInstruction } from './sensitive-policy.js';

/**
 * SensitiveType of a live DOM form field, judged by metadata only
 * (type / autocomplete / placeholder / aria-label / name / id / <label>).
 * Non-fields and anything unexpected return null — the guard never throws.
 */
export function classifyDomElement(el) {
  try {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const tag = String(el.tagName || '').toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    if (!isField) return null;
    const attr = (name) => el.getAttribute(name) || '';
    return classifyElement({
      type:         tag === 'input' ? (attr('type') || el.type || '') : '',
      autocomplete: attr('autocomplete'),
      placeholder:  attr('placeholder'),
      ariaLabel:    attr('aria-label') || attr('title'),
      name:         attr('name'),
      id:           attr('id'),
      label:        el.labels?.[0]?.textContent || ''
    });
  } catch {
    return null;
  }
}

/**
 * @param {{ show(element: Element, text: string): Promise<boolean>|boolean, clear(): void }} highlighter
 * @param {{ classify?: (el: Element) => string|null }} [options]
 * @returns {{ show(element: Element, text: string): Promise<boolean>|boolean, clear(): void }}
 */
export function guardHighlighter(highlighter, { classify = classifyDomElement } = {}) {
  return {
    show(element, text) {
      const type = classify(element);
      return highlighter.show(element, (type && fieldInstruction(type)) || text);
    },
    clear() {
      return highlighter.clear();
    }
  };
}
