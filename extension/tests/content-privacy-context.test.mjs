// ScreenPilot v3 — content.js Privacy Context Tests (Phase 3)
//
// content.js is a classic (non-module) content script by design (Chrome
// content scripts declared without "type":"module" in manifest.json cannot
// use import/export — adding either would be a parse error at real page-load
// time), so it can't be imported/executed like an ES module the way
// v2-task.js or background.js are tested elsewhere in this suite.
//
// Two complementary checks instead:
// 1. Extract the actual getSensitiveScreenshotRegions/getScreenshotPrivacyContext
//    source (verbatim, not reimplemented) and run it in a sandboxed vm context
//    with mock document/window — proves the real detection logic works.
// 2. Static assertions that each of the three screenshot-triggering
//    chrome.runtime.sendMessage calls actually spreads getScreenshotPrivacyContext()
//    into its payload — guards against someone quietly removing the wiring.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS_PATH = path.join(__dirname, '..', 'content.js');
const source = fs.readFileSync(CONTENT_JS_PATH, 'utf8').replace(/\r\n/g, '\n');

// ── 1. Real behavior, via the verbatim source block ──────────────────────────

const startIdx = source.indexOf('const SP_SENSITIVE_INPUT_TYPES');
const endMarker = 'function getScreenshotPrivacyContext()';
const endFnIdx = source.indexOf(endMarker);
assert.ok(startIdx !== -1 && endFnIdx !== -1, 'content.js must still contain the PRIVACY helper block (getSensitiveScreenshotRegions/getScreenshotPrivacyContext)');
// Slice from the constants through the end of getScreenshotPrivacyContext's body —
// find that function's closing brace (first "\n  }\n" after its opening).
const afterFnStart = source.slice(endFnIdx);
const closeRel = afterFnStart.indexOf('\n  }\n');
assert.ok(closeRel !== -1, 'could not find the end of getScreenshotPrivacyContext()');
const helperSource = source.slice(startIdx, endFnIdx + closeRel + '\n  }\n'.length);

function makeInputStub({
  type = 'text', autocomplete = '', placeholder = '', ariaLabel = '', value = '',
  rect = { x: 0, y: 0, width: 100, height: 20 },
} = {}) {
  const attrs = { type, autocomplete, placeholder, 'aria-label': ariaLabel };
  return {
    getAttribute: (name) => (name in attrs ? attrs[name] || null : null),
    type,
    value,
    getBoundingClientRect: () => rect,
  };
}

function runHelper({ inputs = [], textareas = [], devicePixelRatio = 1 } = {}) {
  const sandbox = {
    document: {
      querySelectorAll: (sel) => (sel === 'input, textarea' ? [...inputs, ...textareas] : []),
    },
    window: { devicePixelRatio },
    exports: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${helperSource}\nexports.getSensitiveScreenshotRegions = getSensitiveScreenshotRegions;\nexports.getScreenshotPrivacyContext = getScreenshotPrivacyContext;`,
    sandbox
  );
  return sandbox.exports;
}

// vm sandbox objects live in a different realm (different Array/Object
// prototypes) than this test file's own plain objects — round-trip through
// JSON so assert.deepEqual compares values, not cross-realm identity.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('getSensitiveScreenshotRegions flags a password input', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'password', rect: { x: 1, y: 2, width: 100, height: 20 } })],
  });
  const regions = getSensitiveScreenshotRegions();
  assert.equal(regions.length, 1);
  assert.deepEqual(plain(regions[0]), { x: 1, y: 2, width: 100, height: 20 });
});

test('getSensitiveScreenshotRegions flags a field via sensitive autocomplete, ignoring input type', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'text', autocomplete: 'cc-number' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 1);
});

test('getSensitiveScreenshotRegions ignores an ordinary search input', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'search' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 0);
});

test('getSensitiveScreenshotRegions flags a field via sensitive placeholder keyword, regardless of type', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'text', placeholder: 'CVV' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 1);
});

test('getSensitiveScreenshotRegions flags a field via sensitive aria-label keyword', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'text', ariaLabel: 'Social Security Number' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 1);
});

test('getSensitiveScreenshotRegions flags a generic field whose typed value looks like an email/SSN/credit card', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [
      makeInputStub({ type: 'text', value: 'jane.doe@example.com' }),
      makeInputStub({ type: 'text', value: '123-45-6789', rect: { x: 10, y: 10, width: 50, height: 10 } }),
      makeInputStub({ type: 'text', value: '4111 1111 1111 1111', rect: { x: 20, y: 20, width: 50, height: 10 } }),
    ],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 3);
});

test('getSensitiveScreenshotRegions flags a sensitive <textarea>, now that the query covers input + textarea', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    textareas: [makeInputStub({ type: '', placeholder: 'Paste your API key here' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 1);
});

test('an ordinary input/textarea with plain content is NOT flagged, even with the expanded rules', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'text', placeholder: 'Product code', value: 'SKU-88213' })],
    textareas: [makeInputStub({ type: '', placeholder: 'Leave a comment', value: 'Great product, fast shipping!' })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 0);
});

test('getSensitiveScreenshotRegions skips a sensitive field with no visible size', () => {
  const { getSensitiveScreenshotRegions } = runHelper({
    inputs: [makeInputStub({ type: 'password', rect: { x: 0, y: 0, width: 0, height: 0 } })],
  });
  assert.equal(getSensitiveScreenshotRegions().length, 0);
});

test('getScreenshotPrivacyContext reports window.devicePixelRatio, defaulting to 1', () => {
  const { getScreenshotPrivacyContext } = runHelper({ inputs: [], devicePixelRatio: 2.5 });
  const ctx = getScreenshotPrivacyContext();
  assert.equal(ctx.devicePixelRatio, 2.5);
  assert.deepEqual(plain(ctx.sensitiveRegions), []);

  const { getScreenshotPrivacyContext: withNoDpr } = runHelper({ inputs: [], devicePixelRatio: 0 });
  assert.equal(withNoDpr().devicePixelRatio, 1);
});

// ── 2. Static wiring checks: the three message call sites actually use it ───

function assertCallSiteUsesPrivacyContext(typeLiteral) {
  const idx = source.indexOf(typeLiteral);
  assert.ok(idx !== -1, `content.js must still send a message of type ${typeLiteral}`);
  const windowText = source.slice(idx, idx + 400);
  assert.ok(
    windowText.includes('getScreenshotPrivacyContext()'),
    `the ${typeLiteral} sendMessage payload must spread getScreenshotPrivacyContext()`
  );
}

test('the GET_SCREEN_EXPLANATION message includes getScreenshotPrivacyContext()', () => {
  assertCallSiteUsesPrivacyContext("'GET_SCREEN_EXPLANATION'");
});

test('the ASK_QUESTION message includes getScreenshotPrivacyContext()', () => {
  assertCallSiteUsesPrivacyContext("'ASK_QUESTION'");
});

test('the ANALYZE_GOAL/REANALYZE message (sent via the shared messageType variable) includes getScreenshotPrivacyContext()', () => {
  const idx = source.indexOf('type:             messageType,');
  assert.ok(idx !== -1, 'content.js must still build the shared ANALYZE_GOAL/REANALYZE request object');
  const windowText = source.slice(idx, idx + 400);
  assert.ok(windowText.includes('getScreenshotPrivacyContext()'));
});
