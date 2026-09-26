// PrivacySanitizer — additive `sensitiveType` and the new secret detection.
// (The original behavior is covered, unchanged, by privacy-sanitizer.test.mjs.)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrivacySanitizer, REDACTED } from '../lib/privacy-sanitizer.js';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2ln_nature-123'].join('.');
const APIKEY = 'sk-' + 'proj1234567890ABCDEFGHIJ';

function el(overrides = {}) {
  return {
    id: 'el_1', role: 'textbox', tag: 'input', text: '', placeholder: '', ariaLabel: '', value: '', href: '',
    visible: true, enabled: true, region: 'main_content',
    bbox: { x: 0, y: 0, width: 100, height: 20 }, type: '', autocomplete: '',
    ...overrides
  };
}

test('redacted elements carry the deterministic sensitiveType', () => {
  assert.equal(PrivacySanitizer.sanitizeElement(el({ type: 'password', value: 'x' })).sensitiveType, 'password');
  assert.equal(PrivacySanitizer.sanitizeElement(el({ type: 'email', value: 'a@b.co' })).sensitiveType, 'email');
  assert.equal(PrivacySanitizer.sanitizeElement(el({ type: 'text', autocomplete: 'cc-number', value: '4111111111111111' })).sensitiveType, 'credit_card');
  assert.equal(PrivacySanitizer.sanitizeElement(el({ type: 'text', placeholder: 'CVV', value: '123' })).sensitiveType, 'credit_card');
  const s = PrivacySanitizer.sanitizeElement(el({ type: 'password', value: 'x' }));
  assert.equal(s.sensitive, true);
  assert.equal(s.value, REDACTED);
});

test('JWTs and API keys in an element\'s text/value are now detected and redacted', () => {
  const a = PrivacySanitizer.sanitizeElement(el({ tag: 'div', role: 'generic', text: `token ${JWT}` }));
  assert.equal(a.sensitiveType, 'jwt');
  assert.equal(a.text, REDACTED);
  const b = PrivacySanitizer.sanitizeElement(el({ type: 'text', value: APIKEY }));
  assert.equal(b.sensitiveType, 'api_key');
  assert.equal(b.value, REDACTED);
  const c = PrivacySanitizer.sanitizeElement(el({ type: 'text', value: 'password: hunter22' }));
  assert.equal(c.sensitiveType, 'password');
});

test('non-sensitive elements are returned as the very same object (no sensitiveType added)', () => {
  const plain = el({ role: 'button', tag: 'button', text: 'Submit' });
  assert.equal(PrivacySanitizer.sanitizeElement(plain), plain);
  assert.equal('sensitiveType' in plain, false);
});

test('an order id or timestamp is no longer mistaken for a card number (Luhn)', () => {
  assert.equal(PrivacySanitizer.isSensitiveElement(el({ tag: 'span', text: 'Order 1234567890123' })), false);
  assert.equal(PrivacySanitizer.isSensitiveElement(el({ tag: 'span', text: 'Card 4111 1111 1111 1111' })), true);
});

test('getSensitiveType is exposed and agrees with isSensitiveElement', () => {
  for (const e of [el({ type: 'password' }), el({ type: 'text' }), el({ text: 'jane@example.com' })]) {
    assert.equal(PrivacySanitizer.isSensitiveElement(e), PrivacySanitizer.getSensitiveType(e) !== null);
  }
});

test('sensitive regions still come from every classified element', () => {
  const regions = PrivacySanitizer.getSensitiveRegions([
    el({ type: 'password', bbox: { x: 1, y: 2, width: 30, height: 10 } }),
    el({ type: 'text' }),
    el({ tag: 'div', text: `key ${APIKEY}`, bbox: { x: 5, y: 6, width: 40, height: 12 } })
  ]);
  assert.deepEqual(regions, [{ x: 1, y: 2, width: 30, height: 10 }, { x: 5, y: 6, width: 40, height: 12 }]);
});
