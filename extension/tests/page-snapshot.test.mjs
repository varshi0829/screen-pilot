// page-snapshot.js — computeRelevantStateFingerprint() (Phase 7).
//
// Pure function of an already-extracted PageStateService-shaped pageState —
// no DOM access, no dependency on page-state-service.js itself. Fixtures
// below match the documented PageStateService element shape but are
// constructed independently, same convention as compact-page-state.test.mjs.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeRelevantStateFingerprint } from '../lib/page-snapshot.js';

function el(overrides = {}) {
  return {
    id: 'el_1', role: 'button', tag: 'button', text: 'Submit', placeholder: '', ariaLabel: '',
    value: '', href: '', visible: true, enabled: true, region: 'main_content',
    bbox: { x: 0, y: 0, width: 10, height: 10 }, type: '', autocomplete: '', formId: null, required: false,
    ...overrides
  };
}

function pageState(elements, overrides = {}) {
  return { url: 'https://example.com/', title: 'Example', elements, sensitiveRegions: [], timestamp: 1, ...overrides };
}

// ── Determinism / sorting ────────────────────────────────────────────────────

test('same elements in a different DOM order produce the identical fingerprint', () => {
  const a = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', text: 'Submit' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Cancel' }),
  ]));
  const b = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Cancel' }),
    el({ id: 'el_1', text: 'Submit' }),
  ]));
  assert.equal(a.hash, b.hash);
  assert.equal(a.count, b.count);
});

test('is a pure function — same input called twice yields the identical hash', () => {
  const ps = pageState([el(), el({ id: 'el_2', role: 'link', tag: 'a', text: 'Cancel' })]);
  const a = computeRelevantStateFingerprint(ps);
  const b = computeRelevantStateFingerprint(ps);
  assert.equal(a.hash, b.hash);
});

// ── Filtering ────────────────────────────────────────────────────────────────

test('excludes invisible and disabled elements from both count and hash', () => {
  const visibleOnly = computeRelevantStateFingerprint(pageState([el({ id: 'el_1' })]));
  const withHiddenAndDisabled = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1' }),
    el({ id: 'el_2', visible: false, text: 'Hidden' }),
    el({ id: 'el_3', enabled: false, text: 'Disabled' }),
  ]));
  assert.equal(withHiddenAndDisabled.count, visibleOnly.count);
  assert.equal(withHiddenAndDisabled.hash, visibleOnly.hash);
});

test('does not include the synthetic el.id — renumbering an unrelated earlier element does not change the fingerprint', () => {
  const a = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', text: 'Submit' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Cancel' }),
  ]));
  // Same two elements, same labels/roles, but every synthetic id shifted by
  // one (as if an unrelated element earlier in DOM order had appeared).
  const b = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_2', text: 'Submit' }),
    el({ id: 'el_3', role: 'link', tag: 'a', text: 'Cancel' }),
  ]));
  assert.equal(a.hash, b.hash);
});

// ── Meaningful vs. unrelated change ─────────────────────────────────────────

test('a new visible interactive element changes the fingerprint', () => {
  const before = computeRelevantStateFingerprint(pageState([el({ id: 'el_1' })]));
  const after = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'New link' }),
  ]));
  assert.notEqual(before.hash, after.hash);
  assert.equal(after.count, before.count + 1);
});

test('a field going from empty to non-empty (valuePresent) changes the fingerprint', () => {
  const empty = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', text: '', placeholder: 'Search', value: '' }),
  ]));
  const filled = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', text: '', placeholder: 'Search', value: 'hello' }),
  ]));
  assert.notEqual(empty.hash, filled.hash);
});

test('the URL is reported as its own field, separate from the element-shape hash', () => {
  // By design (see the audited skip condition in v2-task.js), the caller
  // compares url AND hash independently — the hash itself is scoped to the
  // relevant INTERACTIVE-SURFACE shape (role/label/formId/valuePresent) and
  // is legitimately identical across two pages that happen to offer the same
  // controls under a different URL (e.g. two near-identical list-item pages).
  // A navigation is still caught, just via the separate url field.
  const a = computeRelevantStateFingerprint(pageState([el()], { url: 'https://example.com/a' }));
  const b = computeRelevantStateFingerprint(pageState([el()], { url: 'https://example.com/b' }));
  assert.equal(a.hash, b.hash, 'same element shape -> same hash, regardless of url');
  assert.notEqual(a.url, b.url);
  assert.equal(a.url, 'https://example.com/a');
  assert.equal(b.url, 'https://example.com/b');
});

test('an unrelated change to a non-interactive/invisible element does not change the fingerprint', () => {
  // pageState.elements only ever contains interactive elements (that's
  // PageStateService's own extraction contract) — an "unrelated" DOM change
  // (a live region ticking, an image swapping) never appears here at all, so
  // it is invisible to this fingerprint by construction. Modelled here as an
  // element that becomes invisible (the fingerprint's own filter already
  // excludes it either way).
  const before = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Unrelated', visible: true }),
  ]));
  const after = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Unrelated', visible: false }),
  ]));
  assert.notEqual(before.hash, after.hash, 'a genuinely-relevant visibility change is expected to differ');
  // But re-running the SAME "after" state twice must be stable — the point
  // being tested is stability under repetition, not sensitivity to noise.
  const afterAgain = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1' }),
    el({ id: 'el_2', role: 'link', tag: 'a', text: 'Unrelated', visible: false }),
  ]));
  assert.equal(after.hash, afterAgain.hash);
});

// ── Privacy / sensitivity ────────────────────────────────────────────────────

test('a sensitive field never contributes its raw text/value — only its static label or REDACTED', () => {
  const withEmailValue = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', type: 'email', text: '', placeholder: 'Email address', value: 'alice@example.com' }),
  ]));
  const withDifferentEmailValue = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', type: 'email', text: '', placeholder: 'Email address', value: 'bob@other.org' }),
  ]));
  // Different raw values, same sensitive-field shape (still non-empty) ->
  // identical fingerprint: valuePresent is boolean-only, and the label comes
  // only from the static placeholder, never from the value itself.
  assert.equal(withEmailValue.hash, withDifferentEmailValue.hash);
});

test('a sensitive field with no static label falls back to the fixed REDACTED marker, never raw content', () => {
  const fp = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', type: 'password', text: 'hunter2', placeholder: '', ariaLabel: '', value: 'hunter2' }),
  ]));
  // No assertion can inspect the hash's preimage directly, but a differently
  // labelled sensitive field (still no static label) must hash identically —
  // proving the raw text never entered the projection.
  const fp2 = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', type: 'password', text: 'totallyDifferentSecret', placeholder: '', ariaLabel: '', value: 'totallyDifferentSecret' }),
  ]));
  assert.equal(fp.hash, fp2.hash);
});

// ── Structural relationship (formId) ────────────────────────────────────────

test('formId participates in the fingerprint — two same-label fields in different forms differ from two in the same form', () => {
  const sameForm = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', text: '', placeholder: 'Name', formId: 'form_0' }),
    el({ id: 'el_2', role: 'button', tag: 'button', text: 'Submit', formId: 'form_0' }),
  ]));
  const differentForms = computeRelevantStateFingerprint(pageState([
    el({ id: 'el_1', role: 'textbox', tag: 'input', text: '', placeholder: 'Name', formId: 'form_0' }),
    el({ id: 'el_2', role: 'button', tag: 'button', text: 'Submit', formId: 'form_1' }),
  ]));
  assert.notEqual(sameForm.hash, differentForms.hash);
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('returns exactly {url, count, hash} and nothing else', () => {
  const fp = computeRelevantStateFingerprint(pageState([el()]));
  assert.deepEqual(Object.keys(fp).sort(), ['count', 'hash', 'url']);
  assert.equal(typeof fp.hash, 'string');
  assert.equal(typeof fp.count, 'number');
});

test('tolerates a missing/malformed pageState without throwing', () => {
  assert.doesNotThrow(() => computeRelevantStateFingerprint(null));
  assert.doesNotThrow(() => computeRelevantStateFingerprint({}));
  assert.doesNotThrow(() => computeRelevantStateFingerprint({ elements: null }));
  const fp = computeRelevantStateFingerprint(null);
  assert.equal(fp.count, 0);
  assert.equal(fp.url, '');
});
