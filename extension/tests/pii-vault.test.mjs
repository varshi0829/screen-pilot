// pii-vault.js — in-memory token vault + outgoing-text sanitizers.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TokenVault,
  sanitizeText,
  sanitizeUrl,
  sanitizeDeep,
  restoreDeep
} from '../lib/pii-vault.js';
import { REDACTED } from '../lib/privacy-sanitizer.js';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2ln_nature-123'].join('.');
const EMAIL = 'john@example.com';
const PHONE = '+91 9876543210';

// ── TokenVault ───────────────────────────────────────────────────────────────

test('register returns stable, numbered placeholders per type', () => {
  const v = new TokenVault();
  assert.equal(v.register('email', 'a@x.com'), '[EMAIL_1]');
  assert.equal(v.register('email', 'b@x.com'), '[EMAIL_2]');
  assert.equal(v.register('phone', '555-123-4567'), '[PHONE_1]');
  // same value → same token; email match is case-insensitive
  assert.equal(v.register('email', 'A@X.com'), '[EMAIL_1]');
  assert.equal(v.size, 3);
});

test('restore swaps known placeholders back and leaves unknown ones alone', () => {
  const v = new TokenVault();
  v.register('email', EMAIL);
  assert.equal(v.restore('send to [EMAIL_1] now'), `send to ${EMAIL} now`);
  assert.equal(v.restore('send to [EMAIL_9] now'), 'send to [EMAIL_9] now');
  assert.equal(v.restore('no tokens here'), 'no tokens here');
  assert.equal(v.restore(undefined), undefined);
});

test('only email and phone are tokenizable — secrets can never enter the vault', () => {
  const v = new TokenVault();
  for (const type of ['password', 'jwt', 'api_key', 'credit_card', 'ssn', 'secret', 'otp']) {
    assert.throws(() => v.register(type, 'x'), /not tokenizable/, type);
  }
  assert.equal(v.size, 0);
});

test('clear empties the vault and restarts numbering', () => {
  const v = new TokenVault();
  v.register('email', 'a@x.com');
  v.clear();
  assert.equal(v.size, 0);
  assert.equal(v.restore('[EMAIL_1]'), '[EMAIL_1]');
  assert.equal(v.register('email', 'z@x.com'), '[EMAIL_1]');
});

test('the vault never exposes values through serialization or inspection', () => {
  const v = new TokenVault();
  v.register('email', EMAIL);
  v.register('phone', PHONE);
  assert.equal(JSON.stringify(v).includes('example.com'), false);
  assert.equal(JSON.stringify(v).includes('9876543210'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), { tokens: 2 });
  assert.equal(Object.keys(v).length, 0);
  assert.equal(String(Object.getOwnPropertyNames(v)).includes('example'), false);
});

test('the vault module never persists anything (no storage APIs referenced)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'pii-vault.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const banned of ['chrome.storage', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch(', 'console.']) {
    assert.equal(code.includes(banned), false, `pii-vault.js must not reference ${banned}`);
  }
});

// ── sanitizeText ─────────────────────────────────────────────────────────────

test('email/phone become placeholders; secrets become [REDACTED]; tally counts types', () => {
  const v = new TokenVault();
  const tally = {};
  const out = sanitizeText(
    `Send an email to ${EMAIL}, call ${PHONE}, card 4111 1111 1111 1111, token ${JWT}`,
    v,
    tally
  );
  assert.equal(out, `Send an email to [EMAIL_1], call [PHONE_1], card ${REDACTED}, token ${REDACTED}`);
  assert.deepEqual(tally, { email: 1, phone: 1, credit_card: 1, jwt: 1 });
  assert.equal(v.restore(out).includes(EMAIL), true);
  assert.equal(v.restore(out).includes('4111'), false, 'a redacted card must NOT be restorable');
});

test('sanitizeText is idempotent and leaves clean text untouched', () => {
  const v = new TokenVault();
  const once = sanitizeText(`mail ${EMAIL}`, v);
  assert.equal(sanitizeText(once, v), once);
  assert.equal(sanitizeText('Search for cats', v), 'Search for cats');
  assert.equal(sanitizeText('', v), '');
  assert.equal(sanitizeText(undefined, v), undefined);
});

test('the same email appearing twice reuses one placeholder', () => {
  const v = new TokenVault();
  assert.equal(sanitizeText(`${EMAIL} and again ${EMAIL}`, v), '[EMAIL_1] and again [EMAIL_1]');
  assert.equal(v.size, 1);
});

// ── sanitizeUrl ──────────────────────────────────────────────────────────────

test('sanitizeUrl redacts credential-like params by NAME and keeps ordinary ones', () => {
  const v = new TokenVault();
  const out = sanitizeUrl('https://app.example.com/cb?code=abc123&state=xyz&q=hello&access_token=tok999', v);
  assert.equal(out, `https://app.example.com/cb?code=${REDACTED}&state=xyz&q=hello&access_token=${REDACTED}`);
});

test('sanitizeUrl handles fragments, userinfo and emails in path/query (incl. percent-encoded)', () => {
  const v = new TokenVault();
  const out = sanitizeUrl('https://user:pw@x.com/u/john@example.com?ref=john%40example.com&page=2#id_token=abc', v);
  assert.equal(out.includes('user:pw'), false);
  assert.equal(out.includes('john@example.com'), false);
  assert.equal(out.includes('john%40example.com'), false);
  assert.match(out, /page=2/);
  assert.match(out, /#id_token=\[REDACTED\]$/);
  assert.match(out, /\[EMAIL_1\]/);
});

test('sanitizeUrl leaves a clean URL byte-for-byte unchanged', () => {
  const v = new TokenVault();
  const url = 'https://en.wikipedia.org/wiki/Special:Search?search=artificial+intelligence&lang=en%20US';
  assert.equal(sanitizeUrl(url, v), url);
});

// ── sanitizeDeep / restoreDeep ───────────────────────────────────────────────

test('sanitizeDeep walks nested structures, never mutates the input, and skips the screenshot', () => {
  const v = new TokenVault();
  const screenshot = { image: 'AAAA' + 'QUJDRA=='.repeat(50) + `${EMAIL}`, mimeType: 'image/jpeg' };
  const request = {
    schemaVersion: '1',
    requestId: 'req_1',
    goal: `email ${EMAIL}`,
    page: { url: 'https://x.com/?token=abc123', title: `Inbox — ${EMAIL}`, screenshot },
    executionHistory: { completedSteps: [{ description: `Typed ${PHONE}`, intent: 'fill' }], attemptCount: 1 },
    clarifications: [`use ${EMAIL}`],
    workflowMemory: { visitedUrls: ['https://a.com/?email=x'], extractedData: { password: 'hunter22', note: 'ok' } }
  };
  const snapshot = JSON.stringify(request);
  const tally = {};
  const safe = sanitizeDeep(request, v, tally);

  assert.equal(JSON.stringify(request), snapshot, 'input must not be mutated');
  assert.equal(safe.page.screenshot.image, screenshot.image, 'base64 screenshot passes through byte-for-byte');
  assert.equal(safe.goal, 'email [EMAIL_1]');
  assert.equal(safe.page.title, 'Inbox — [EMAIL_1]');
  assert.equal(safe.page.url, `https://x.com/?token=${REDACTED}`);
  assert.equal(safe.executionHistory.completedSteps[0].description, 'Typed [PHONE_1]');
  assert.equal(safe.executionHistory.attemptCount, 1);
  assert.equal(safe.clarifications[0], 'use [EMAIL_1]');
  assert.equal(safe.workflowMemory.visitedUrls[0], `https://a.com/?email=${REDACTED}`);
  assert.equal(safe.workflowMemory.extractedData.password, REDACTED);
  assert.equal(safe.workflowMemory.extractedData.note, 'ok');
  assert.equal(safe.requestId, 'req_1');
});

test('sanitizeDeep fails closed on pathologically deep input', () => {
  const v = new TokenVault();
  let deep = { s: EMAIL };
  for (let i = 0; i < 30; i++) deep = { n: deep };
  const out = JSON.stringify(sanitizeDeep(deep, v));
  assert.equal(out.includes('example.com'), false);
  assert.match(out, /\[TRUNCATED\]/);
});

test('restoreDeep restores placeholders throughout a response, without mutating it', () => {
  const v = new TokenVault();
  sanitizeText(`${EMAIL} ${PHONE}`, v);
  const response = { plannerSummary: 'Email [EMAIL_1]', plan: { steps: [{ description: 'Call [PHONE_1]', n: 3 }] } };
  const snapshot = JSON.stringify(response);
  const restored = restoreDeep(response, v);
  assert.equal(restored.plannerSummary, `Email ${EMAIL}`);
  assert.equal(restored.plan.steps[0].description, `Call ${PHONE}`);
  assert.equal(restored.plan.steps[0].n, 3);
  assert.equal(JSON.stringify(response), snapshot);
});
