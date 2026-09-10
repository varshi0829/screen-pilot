// ScreenPilot v3 — Privacy Sanitizer Unit Tests (privacy-vision Phase 1)

import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivacySanitizer, REDACTED } from '../lib/privacy-sanitizer.js';
import { PageStateService } from '../services/page-state-service.js';

function el(overrides = {}) {
  return {
    id: 'el_1',
    role: 'textbox',
    tag: 'input',
    text: '',
    placeholder: '',
    ariaLabel: '',
    value: '',
    href: '',
    visible: true,
    enabled: true,
    region: 'main_content',
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    type: '',
    autocomplete: '',
    ...overrides
  };
}

// ── isSensitiveElement / sanitizeElement ─────────────────────────────────────

test('password input value is redacted', () => {
  const passwordEl = el({ type: 'password', value: 'hunter2', placeholder: 'Password' });
  assert.equal(PrivacySanitizer.isSensitiveElement(passwordEl), true);

  const sanitized = PrivacySanitizer.sanitizeElement(passwordEl);
  assert.equal(sanitized.value, REDACTED);
  assert.equal(sanitized.sensitive, true);
  // Grounding metadata (what the field IS) is preserved so the router can still
  // resolve "click the password field".
  assert.equal(sanitized.placeholder, 'Password');
  assert.equal(sanitized.bbox.width, 100);
});

test('email input value is redacted even without an autocomplete attribute', () => {
  const emailEl = el({ type: 'email', value: 'jane.doe@example.com' });
  const sanitized = PrivacySanitizer.sanitizeElement(emailEl);
  assert.equal(sanitized.value, REDACTED);
  assert.equal(sanitized.sensitive, true);
});

test('sensitive autocomplete token flags a generic text input', () => {
  const ccEl = el({ type: 'text', autocomplete: 'cc-number', value: '4111111111111111' });
  assert.equal(PrivacySanitizer.isSensitiveElement(ccEl), true);
  assert.equal(PrivacySanitizer.sanitizeElement(ccEl).value, REDACTED);
});

test('sensitive label/placeholder keyword flags a field regardless of type', () => {
  const cvvEl = el({ type: 'text', placeholder: 'CVV', value: '123' });
  assert.equal(PrivacySanitizer.isSensitiveElement(cvvEl), true);
  assert.equal(PrivacySanitizer.sanitizeElement(cvvEl).value, REDACTED);
});

test('normal text/search fields are left completely unchanged', () => {
  const searchEl = el({ type: 'search', placeholder: 'Search products', value: 'wireless headphones', text: '' });
  assert.equal(PrivacySanitizer.isSensitiveElement(searchEl), false);
  const sanitized = PrivacySanitizer.sanitizeElement(searchEl);
  assert.equal(sanitized, searchEl); // same reference — untouched
  assert.equal(sanitized.value, 'wireless headphones');
  assert.equal(sanitized.sensitive, undefined);
});

test('a normal button with ordinary text is left unchanged', () => {
  const buttonEl = el({ tag: 'button', role: 'button', type: '', text: 'Add to cart' });
  assert.equal(PrivacySanitizer.isSensitiveElement(buttonEl), false);
  assert.equal(PrivacySanitizer.sanitizeElement(buttonEl).text, 'Add to cart');
});

// ── obvious PII patterns embedded in otherwise-generic fields ────────────────

test('an email address typed into a generic field is redacted', () => {
  const genericEl = el({ type: 'text', value: 'contact me at jane.doe@example.com' });
  assert.equal(PrivacySanitizer.isSensitiveElement(genericEl), true);
  assert.equal(PrivacySanitizer.sanitizeElement(genericEl).value, REDACTED);
});

test('an SSN-shaped value in a generic field is redacted', () => {
  const genericEl = el({ type: 'text', value: '123-45-6789' });
  assert.equal(PrivacySanitizer.isSensitiveElement(genericEl), true);
  assert.equal(PrivacySanitizer.sanitizeElement(genericEl).value, REDACTED);
});

test('a credit-card-shaped value in a generic field is redacted', () => {
  const genericEl = el({ type: 'text', value: '4111 1111 1111 1111' });
  assert.equal(PrivacySanitizer.isSensitiveElement(genericEl), true);
  assert.equal(PrivacySanitizer.sanitizeElement(genericEl).value, REDACTED);
});

test('an ordinary product SKU / numeric id does not falsely trigger PII redaction', () => {
  const genericEl = el({ type: 'text', value: 'SKU-88213', placeholder: 'Product code' });
  assert.equal(PrivacySanitizer.isSensitiveElement(genericEl), false);
});

// ── sanitizeElements / getSensitiveRegions ───────────────────────────────────

test('sanitizeElements redacts only sensitive elements in a mixed list', () => {
  const elements = [
    el({ id: 'el_1', type: 'text', placeholder: 'Search', value: 'shoes' }),
    el({ id: 'el_2', type: 'password', value: 'hunter2', bbox: { x: 10, y: 20, width: 150, height: 24 } }),
    el({ id: 'el_3', tag: 'button', role: 'button', type: '', text: 'Submit' })
  ];

  const sanitized = PrivacySanitizer.sanitizeElements(elements);
  assert.equal(sanitized[0].value, 'shoes');
  assert.equal(sanitized[1].value, REDACTED);
  assert.equal(sanitized[2].text, 'Submit');
});

test('getSensitiveRegions returns only bboxes of sensitive elements', () => {
  const elements = [
    el({ id: 'el_1', type: 'text', value: 'shoes', bbox: { x: 1, y: 1, width: 50, height: 10 } }),
    el({ id: 'el_2', type: 'password', value: 'hunter2', bbox: { x: 10, y: 20, width: 150, height: 24 } })
  ];

  const regions = PrivacySanitizer.getSensitiveRegions(elements);
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0], { x: 10, y: 20, width: 150, height: 24 });
});

test('getSensitiveRegions ignores sensitive elements with no usable bbox', () => {
  const elements = [
    el({ type: 'password', value: 'hunter2', bbox: null })
  ];
  assert.deepEqual(PrivacySanitizer.getSensitiveRegions(elements), []);
});

// ── integration with PageStateService ────────────────────────────────────────

function mockDocWithPassword() {
  const passwordInput = {
    tagName: 'INPUT',
    type: 'password',
    value: 'hunter2',
    getAttribute: (k) => (k === 'type' ? 'password' : k === 'placeholder' ? 'Password' : null),
    innerText: '',
    textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 40, width: 200, height: 30 }),
    closest: () => null
  };
  const searchInput = {
    tagName: 'INPUT',
    type: 'text',
    value: 'wireless headphones',
    getAttribute: (k) => (k === 'placeholder' ? 'Search products' : null),
    innerText: '',
    textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }),
    closest: () => null
  };

  return {
    title: 'Account Settings',
    querySelectorAll: () => [searchInput, passwordInput]
  };
}

test('PageStateService redacts password value end-to-end and exposes sensitiveRegions', () => {
  const doc = mockDocWithPassword();
  const loc = { href: 'https://example.com/account' };

  const state = PageStateService.extractPageState({ doc, loc });

  const search = state.elements.find((e) => e.placeholder === 'Search products');
  const password = state.elements.find((e) => e.placeholder === 'Password');

  assert.equal(search.value, 'wireless headphones');
  assert.equal(password.value, REDACTED);
  assert.equal(password.sensitive, true);

  assert.equal(state.sensitiveRegions.length, 1);
  assert.deepEqual(state.sensitiveRegions[0], { x: 0, y: 40, width: 200, height: 30 });
});
