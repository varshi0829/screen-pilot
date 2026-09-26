// sensitive-guard.js — guide-only protection for sensitive fields.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyDomElement, guardHighlighter } from '../lib/sensitive-guard.js';
import { fieldInstruction } from '../lib/sensitive-policy.js';
import { SensitiveType } from '../lib/pii-detector.js';

function field({ tag = 'INPUT', attrs = {}, labelText = '', isContentEditable = false, value = '' } = {}) {
  return {
    tagName: tag,
    type: attrs.type,
    isContentEditable,
    value, // present so tests can prove it is never consulted
    labels: labelText ? [{ textContent: labelText }] : [],
    getAttribute: (n) => (n in attrs ? attrs[n] : null)
  };
}

function recordingHighlighter() {
  const calls = [];
  return {
    calls,
    async show(element, text) { calls.push(['show', element, text]); return true; },
    clear() { calls.push(['clear']); }
  };
}

test('classifies password / email / phone inputs by type', () => {
  assert.equal(classifyDomElement(field({ attrs: { type: 'password' } })), SensitiveType.PASSWORD);
  assert.equal(classifyDomElement(field({ attrs: { type: 'email' } })), SensitiveType.EMAIL);
  assert.equal(classifyDomElement(field({ attrs: { type: 'tel' } })), SensitiveType.PHONE);
});

test('classifies by autocomplete, name/id, aria-label and <label> text', () => {
  assert.equal(classifyDomElement(field({ attrs: { type: 'text', autocomplete: 'cc-number' } })), SensitiveType.CREDIT_CARD);
  assert.equal(classifyDomElement(field({ attrs: { type: 'text', name: 'user_password' } })), SensitiveType.PASSWORD);
  assert.equal(classifyDomElement(field({ attrs: { type: 'text', 'aria-label': 'One-time code' } })), SensitiveType.OTP);
  assert.equal(classifyDomElement(field({ attrs: { type: 'text' }, labelText: 'Social Security Number' })), SensitiveType.SSN);
  assert.equal(classifyDomElement(field({ tag: 'TEXTAREA', attrs: { placeholder: 'Paste your API key' } })), SensitiveType.API_KEY);
});

test('ordinary fields and non-field elements are not classified', () => {
  assert.equal(classifyDomElement(field({ attrs: { type: 'search', placeholder: 'Search' } })), null);
  assert.equal(classifyDomElement(field({ attrs: { type: 'text', name: 'username' } })), null);
  assert.equal(classifyDomElement({ tagName: 'BUTTON', getAttribute: () => 'password' }), null);
  assert.equal(classifyDomElement({ tagName: 'A', getAttribute: () => null }), null);
});

test('classification uses attributes only — a value typed into the field is never read', () => {
  const el = field({ attrs: { type: 'text', name: 'q' }, value: 'jane@example.com' });
  // value contains an email, but the guard must judge metadata only
  assert.equal(classifyDomElement(el), null);
  let touched = false;
  const spy = { ...field({ attrs: { type: 'text' } }) };
  Object.defineProperty(spy, 'value', { get() { touched = true; return 'x'; } });
  classifyDomElement(spy);
  assert.equal(touched, false);
});

test('never throws on odd / mock elements', () => {
  assert.equal(classifyDomElement(null), null);
  assert.equal(classifyDomElement({}), null);
  assert.equal(classifyDomElement({ tagName: 'INPUT' }), null);
  assert.equal(classifyDomElement({ tagName: 'INPUT', getAttribute() { throw new Error('boom'); } }), null);
});

test('a sensitive field gets the fixed "enter it yourself" instruction instead of the planner text', async () => {
  const h = recordingHighlighter();
  const guarded = guardHighlighter(h);
  const el = field({ attrs: { type: 'password' } });
  const shown = await guarded.show(el, "Fill 'Password' with hunter22");
  assert.equal(shown, true);
  assert.equal(h.calls[0][1], el);
  assert.equal(h.calls[0][2], fieldInstruction(SensitiveType.PASSWORD));
  assert.equal(h.calls[0][2].includes('hunter22'), false);
  assert.match(h.calls[0][2], /yourself/);
});

test('a normal element keeps the original instruction text', async () => {
  const h = recordingHighlighter();
  const guarded = guardHighlighter(h);
  const btn = { tagName: 'BUTTON', getAttribute: () => null };
  await guarded.show(btn, "Click 'Sign in'");
  assert.equal(h.calls[0][2], "Click 'Sign in'");
  await guarded.show(field({ attrs: { type: 'search', placeholder: 'Search' } }), "Fill 'Search'");
  assert.equal(h.calls[1][2], "Fill 'Search'");
});

test('clear delegates to the wrapped highlighter', () => {
  const h = recordingHighlighter();
  guardHighlighter(h).clear();
  assert.deepEqual(h.calls, [['clear']]);
});

test('the guard exposes exactly the highlighter surface the executor uses (show, clear)', () => {
  const guarded = guardHighlighter(recordingHighlighter());
  assert.deepEqual(Object.keys(guarded).sort(), ['clear', 'show']);
});

test('a custom classifier can be injected', async () => {
  const h = recordingHighlighter();
  const guarded = guardHighlighter(h, { classify: () => SensitiveType.CREDIT_CARD });
  await guarded.show({}, 'x');
  assert.equal(h.calls[0][2], fieldInstruction(SensitiveType.CREDIT_CARD));
});
