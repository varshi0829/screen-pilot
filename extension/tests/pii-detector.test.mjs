// pii-detector.js — deterministic PII / secret detection.
// Secret-shaped fixtures are assembled at runtime so no key-looking literal
// is committed to the repo.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SensitiveType as T,
  findPII,
  detectType,
  redactText,
  classifyElement,
  isLuhnValid,
  isSensitiveParamName,
  isSensitiveKeyName
} from '../lib/pii-detector.js';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2ln_nature-123'].join('.');
const OPENAI_STYLE = 'sk-' + 'proj1234567890ABCDEFGHIJ';
const GOOGLE_STYLE = 'AI' + 'za' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const GITHUB_STYLE = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const types = (text) => findPII(text).map((s) => s.type);
const slice = (text) => findPII(text).map((s) => text.slice(s.start, s.end));

// ── contact details ──────────────────────────────────────────────────────────

test('detects email addresses', () => {
  assert.deepEqual(types('write to jane.doe+work@example.co.uk today'), [T.EMAIL]);
  assert.deepEqual(slice('write to jane.doe+work@example.co.uk today'), ['jane.doe+work@example.co.uk']);
});

test('detects phone numbers, including an international prefix', () => {
  assert.deepEqual(types('call +91 9876543210 now'), [T.PHONE]);
  assert.deepEqual(types('call (555) 123-4567 now'), [T.PHONE]);
  assert.deepEqual(types('call 555-123-4567'), [T.PHONE]);
});

test('ordinary text and short numbers are not flagged', () => {
  assert.deepEqual(findPII('Search Wikipedia for artificial intelligence'), []);
  assert.deepEqual(findPII('Step 3 of 12 — page 2024'), []);
  assert.deepEqual(findPII('Sign in'), []);
});

// ── cards ────────────────────────────────────────────────────────────────────

test('detects Luhn-valid card numbers with or without separators', () => {
  assert.deepEqual(types('card 4111 1111 1111 1111'), [T.CREDIT_CARD]);
  assert.deepEqual(types('card 4111-1111-1111-1111'), [T.CREDIT_CARD]);
  assert.deepEqual(types('card 4111111111111111'), [T.CREDIT_CARD]);
});

test('long digit runs that fail the Luhn checksum are NOT treated as cards', () => {
  // order ids / timestamps / tracking numbers
  assert.deepEqual(findPII('order 1234567890123'), []);
  assert.deepEqual(findPII('ts 1700000000000000'), []);
  assert.equal(isLuhnValid('4111111111111111'), true);
  assert.equal(isLuhnValid('4111111111111112'), false);
  assert.equal(isLuhnValid('123'), false);
});

test('detects US SSNs', () => {
  assert.deepEqual(types('ssn 123-45-6789'), [T.SSN]);
});

// ── secrets ──────────────────────────────────────────────────────────────────

test('detects JWTs', () => {
  assert.deepEqual(types(`Authorization payload ${JWT} end`), [T.JWT]);
  assert.deepEqual(slice(`x ${JWT} y`), [JWT]);
});

test('detects well-known API key / token shapes', () => {
  assert.deepEqual(types(`key ${OPENAI_STYLE}`), [T.API_KEY]);
  assert.deepEqual(types(`key ${GOOGLE_STYLE}`), [T.API_KEY]);
  assert.deepEqual(types(`token ${GITHUB_STYLE}`), [T.API_KEY]);
  assert.deepEqual(types('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), [T.API_KEY]);
});

test('does not flag hyphenated words that merely resemble a key prefix', () => {
  assert.deepEqual(findPII('sk-learn-tutorial-basics'), []);
  assert.deepEqual(findPII('a task-management risk-assessment guide'), []);
});

test('detects private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----';
  assert.deepEqual(types(`here: ${pem}`), [T.SECRET]);
});

test('detects credential assignments and redacts only the VALUE span', () => {
  const text = 'login with password: hunter22 please';
  assert.deepEqual(types(text), [T.PASSWORD]);
  assert.deepEqual(slice(text), ['hunter22']);
  assert.equal(redactText(text), 'login with password: [REDACTED] please');

  assert.deepEqual(types('api_key=abcdef123456'), [T.API_KEY]);
  assert.deepEqual(types('access_token = zzzzzz999999'), [T.SECRET]);
});

test('detects a spoken password ("my password is …")', () => {
  const text = 'my password is swordfish and I want to log in';
  assert.deepEqual(slice(text), ['swordfish']);
});

test('overlapping matches resolve to one span (secrets win over contact details)', () => {
  const text = `password=${'a'.repeat(6)}@example.com`;
  const spans = findPII(text);
  assert.equal(spans.length, 1);
});

test('findPII returns only positions and types — never the matched value', () => {
  for (const span of findPII('jane@example.com')) {
    assert.deepEqual(Object.keys(span).sort(), ['end', 'start', 'type']);
  }
});

test('redactText replaces every span and leaves clean text alone', () => {
  assert.equal(redactText('hello'), 'hello');
  assert.equal(
    redactText('jane@example.com and 4111 1111 1111 1111'),
    '[REDACTED] and [REDACTED]'
  );
  assert.equal(redactText('x jane@example.com', '<r>'), 'x <r>');
});

test('detectType returns the first span type or null', () => {
  assert.equal(detectType('nothing here'), null);
  assert.equal(detectType('mail jane@example.com'), T.EMAIL);
});

// ── DOM metadata classification ──────────────────────────────────────────────

test('classifies by input type', () => {
  assert.equal(classifyElement({ type: 'password' }), T.PASSWORD);
  assert.equal(classifyElement({ type: 'email' }), T.EMAIL);
  assert.equal(classifyElement({ type: 'tel' }), T.PHONE);
  assert.equal(classifyElement({ type: 'text' }), null);
  assert.equal(classifyElement({ type: 'search' }), null);
});

test('classifies by autocomplete token', () => {
  assert.equal(classifyElement({ type: 'text', autocomplete: 'cc-number' }), T.CREDIT_CARD);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'current-password' }), T.PASSWORD);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'one-time-code' }), T.OTP);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'tel' }), T.PHONE);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'street-address' }), T.ADDRESS);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'bday' }), T.DATE_OF_BIRTH);
  assert.equal(classifyElement({ type: 'text', autocomplete: 'off' }), null);
});

test('classifies by label / placeholder / aria-label / name / id keywords', () => {
  assert.equal(classifyElement({ type: 'text', placeholder: 'CVV' }), T.CREDIT_CARD);
  assert.equal(classifyElement({ type: 'text', ariaLabel: 'Card number' }), T.CREDIT_CARD);
  assert.equal(classifyElement({ type: 'text', placeholder: 'Enter OTP' }), T.OTP);
  assert.equal(classifyElement({ type: 'text', name: 'user_password' }), T.PASSWORD);
  assert.equal(classifyElement({ type: 'text', id: 'api-key' }), T.API_KEY);
  assert.equal(classifyElement({ type: 'text', label: 'Social Security Number' }), T.SSN);
  assert.equal(classifyElement({ type: 'text', placeholder: 'Search' }), null);
});

test('classifies by field content (value / text)', () => {
  assert.equal(classifyElement({ type: 'text', value: 'jane@example.com' }), T.EMAIL);
  assert.equal(classifyElement({ type: 'text', text: `token ${JWT}` }), T.JWT);
  assert.equal(classifyElement({ type: 'text', value: '4111 1111 1111 1111' }), T.CREDIT_CARD);
  assert.equal(classifyElement({ type: 'text', value: 'hello world' }), null);
});

test('classifyElement tolerates missing input', () => {
  assert.equal(classifyElement(null), null);
  assert.equal(classifyElement(undefined), null);
  assert.equal(classifyElement({}), null);
});

// ── name helpers ─────────────────────────────────────────────────────────────

test('sensitive URL parameter / object key names', () => {
  for (const n of ['token', 'access_token', 'api_key', 'password', 'code', 'sid', 'email', 'signature']) {
    assert.equal(isSensitiveParamName(n), true, n);
  }
  for (const n of ['q', 'page', 'sort', 'lang']) assert.equal(isSensitiveParamName(n), false, n);

  for (const n of ['password', 'token', 'apiKey', 'authorization']) assert.equal(isSensitiveKeyName(n), true, n);
  for (const n of ['goal', 'title', 'url', 'email', 'description']) assert.equal(isSensitiveKeyName(n), false, n);
});
