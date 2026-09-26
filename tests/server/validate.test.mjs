import './_setup.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
const { validatePlanRequest, validateAnalyzeRequest, applyPiiBackstop, MAX_SCREENSHOT_BYTES } = await import('../../src/server/validate.ts');

const EMAIL = 'jane@example.com';

function planBody(overrides = {}) {
  return { goal: 'do x', page: { url: 'https://x.com', title: 't', screenshot: { image: 'AAAA' } }, ...overrides };
}

// ── validatePlanRequest — messages/status pinned to the pre-refactor routes ──

test('validatePlanRequest: accepts a well-formed body', () => {
  assert.equal(validatePlanRequest(planBody()), null);
});

test('validatePlanRequest: missing/blank goal', () => {
  assert.deepEqual(validatePlanRequest(planBody({ goal: '' })), { error: 'goal is required.', status: 400 });
  assert.deepEqual(validatePlanRequest(planBody({ goal: '   ' })), { error: 'goal is required.', status: 400 });
  assert.deepEqual(validatePlanRequest(null), { error: 'goal is required.', status: 400 });
});

test('validatePlanRequest: missing page.url', () => {
  const b = planBody(); b.page.url = '';
  assert.deepEqual(validatePlanRequest(b), { error: 'page.url is required.', status: 400 });
});

test('validatePlanRequest: missing screenshot', () => {
  const b = planBody(); delete b.page.screenshot;
  assert.deepEqual(validatePlanRequest(b), { error: 'page.screenshot.image is required.', status: 400 });
  const b2 = planBody(); b2.page.screenshot = {};
  assert.deepEqual(validatePlanRequest(b2), { error: 'page.screenshot.image is required.', status: 400 });
});

test('validatePlanRequest: oversized screenshot → 413', () => {
  const b = planBody();
  b.page.screenshot.image = 'A'.repeat(MAX_SCREENSHOT_BYTES + 1);
  assert.deepEqual(validatePlanRequest(b), { error: 'Screenshot too large — zoom out and try again.', status: 413 });
});

test('validatePlanRequest: a screenshot at exactly the limit is accepted', () => {
  const b = planBody();
  b.page.screenshot.image = 'A'.repeat(MAX_SCREENSHOT_BYTES);
  assert.equal(validatePlanRequest(b), null);
});

// ── validateAnalyzeRequest ────────────────────────────────────────────────────

test('validateAnalyzeRequest: accepts a well-formed body', () => {
  assert.equal(validateAnalyzeRequest({ goal: 'x', screenshot: { image: 'AAAA' } }), null);
});

test('validateAnalyzeRequest: missing goal / screenshot / oversized', () => {
  assert.deepEqual(validateAnalyzeRequest({ goal: ' ', screenshot: { image: 'A' } }), { error: 'goal is required.', status: 400 });
  assert.deepEqual(validateAnalyzeRequest({ goal: 'x', screenshot: {} }), { error: 'screenshot.image is required.', status: 400 });
  assert.deepEqual(
    validateAnalyzeRequest({ goal: 'x', screenshot: { image: 'A'.repeat(MAX_SCREENSHOT_BYTES + 1) } }),
    { error: 'Screenshot too large. Please zoom out or reduce browser zoom level.', status: 413 }
  );
});

// ── applyPiiBackstop ──────────────────────────────────────────────────────────

test('applyPiiBackstop redacts a raw PII value that slipped through the client', () => {
  const body = { goal: `email ${EMAIL}`, page: { url: 'https://x.com', title: 't' } };
  const safe = applyPiiBackstop(body, 'r1', 'plan');
  assert.equal(safe.goal, 'email [REDACTED]');
  assert.equal(body.goal.includes(EMAIL), true, 'the caller\'s original object must not be mutated');
});

test('applyPiiBackstop never touches the screenshot payload', () => {
  const body = { page: { screenshot: { image: 'AAAA' + EMAIL, mimeType: 'image/jpeg' } } };
  const safe = applyPiiBackstop(body, 'r1', 'plan');
  assert.equal(safe.page.screenshot.image, 'AAAA' + EMAIL);
});

test('applyPiiBackstop logs a PII-safe event only when something was actually redacted', () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    applyPiiBackstop({ goal: `contact ${EMAIL}` }, 'r1', 'plan');
    applyPiiBackstop({ goal: 'clean text' }, 'r2', 'plan');
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  const evt = JSON.parse(lines[0]);
  assert.equal(evt.event, 'server_pii_backstop');
  assert.equal(evt.reqId, 'r1');
  assert.ok(evt.types.email >= 1);
  assert.equal(lines[0].includes(EMAIL), false);
});

test('applyPiiBackstop leaves a clean request completely unchanged', () => {
  const body = { goal: 'search for cats', page: { url: 'https://x.com' } };
  assert.deepEqual(applyPiiBackstop(body, 'r1', 'plan'), body);
});
