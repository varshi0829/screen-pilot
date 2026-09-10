// ScreenPilot v3 — collectPageControls() Privacy Regression Test
//
// v2-task.js's collectPageControls() reads live DOM text (innerText,
// aria-label, title, img[alt]) directly and its output is attached verbatim
// to cloudContext.pageControls, which decision-router.js sends straight to
// the cloud planner — unlike PageStateService.elements, it never passed
// through PrivacySanitizer. This proves the fix: each field is now checked
// via the real PrivacySanitizer.isSensitiveElement and, only when sensitive,
// replaced with PrivacySanitizer.REDACTED — ordinary labels are untouched.
//
// v2-task.js is bundled/executed as a whole content-script module with heavy
// browser dependencies, so rather than importing the entire file, this
// extracts the actual sanitizeControlField/collectPageControls source
// (verbatim, not reimplemented) and runs it in a vm sandbox alongside the
// REAL PrivacySanitizer module — so this test exercises the genuine fix, not
// a mock of it.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivacySanitizer } from '../lib/privacy-sanitizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.join(__dirname, '..', 'v2-task.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const startIdx = source.indexOf('function sanitizeControlField(value)');
const endMarker = 'function collectPageControls()';
const endFnIdx = source.indexOf(endMarker);
assert.ok(startIdx !== -1 && endFnIdx !== -1, 'v2-task.js must still contain sanitizeControlField/collectPageControls');
const afterFnStart = source.slice(endFnIdx);
const closeRel = afterFnStart.indexOf('\n}\n');
assert.ok(closeRel !== -1, 'could not find the end of collectPageControls()');
const helperSource = source.slice(startIdx, endFnIdx + closeRel + '\n}\n'.length);

function makeControlStub({ tag = 'BUTTON', text = '', ariaLabel = '', title = '', imgAlt = '', visible = true } = {}) {
  return {
    tagName: tag,
    innerText: text,
    getAttribute: (name) => (name === 'aria-label' ? ariaLabel : name === 'title' ? title : null),
    querySelector: (sel) => (sel === 'img[alt]' && imgAlt ? { getAttribute: () => imgAlt } : null),
    closest: () => null,
    __visible: visible,
  };
}

function runCollectPageControls(controls) {
  const sandbox = {
    document: { querySelectorAll: () => controls },
    window: {
      DOMMatcher: {
        isVisible: (el) => el.__visible !== false,
        detectRegion: () => 'other',
      },
    },
    PrivacySanitizer,
    exports: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${helperSource}\nexports.collectPageControls = collectPageControls;`, sandbox);
  return sandbox.exports.collectPageControls();
}

test('a control whose text embeds an email is redacted — the raw email cannot reach the cloud planner', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Sign out jane.doe@example.com' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, PrivacySanitizer.REDACTED);
  assert.ok(!result[0].text.includes('jane.doe@example.com'), 'the raw email must not survive anywhere in the returned control');
});

test('an ordinary control label ("Search") is preserved exactly', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Search' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'Search');
});

test('a sensitive aria-label (SSN keyword) is redacted while an unrelated text field on the same control is preserved', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Continue', ariaLabel: 'Enter your Social Security Number' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ariaLabel, PrivacySanitizer.REDACTED);
  assert.equal(result[0].text, 'Continue', 'a non-sensitive field must be left untouched — redaction is per-field, not per-control');
});

test('a credit-card-shaped title is redacted', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Pay now', title: '4111 1111 1111 1111' }),
  ]);
  assert.equal(result[0].title, PrivacySanitizer.REDACTED);
  assert.equal(result[0].text, 'Pay now');
});

test('a password-keyword img alt text is redacted', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Reset', imgAlt: 'password reset icon' }),
  ]);
  assert.equal(result[0].imgAlt, PrivacySanitizer.REDACTED);
});

test('multiple controls: only the sensitive one is redacted, others pass through unchanged', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Search' }),
    makeControlStub({ text: 'Sign out jane.doe@example.com' }),
    makeControlStub({ text: 'Cart' }),
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].text, 'Search');
  assert.equal(result[1].text, PrivacySanitizer.REDACTED);
  assert.equal(result[2].text, 'Cart');
});

test('an invisible control is still excluded entirely (existing visibility behavior unchanged)', () => {
  const result = runCollectPageControls([
    makeControlStub({ text: 'Hidden', visible: false }),
  ]);
  assert.equal(result.length, 0);
});
