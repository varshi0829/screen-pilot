// compact-page-state.js — minimal, decision-relevant page-state projection.
// Deliberately decoupled from page-state-service.js (no import of it at all);
// fixtures below match the documented PageStateService element shape
// (docs/PAGE_STATE.md) but are constructed independently.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { toCompactPageState, estimatePayloadBytes, estimateCompactionSavings } from '../lib/compact-page-state.js';
import { REDACTED } from '../lib/privacy-sanitizer.js';

function el(overrides = {}) {
  return {
    id: 'el_1', role: 'button', tag: 'button', text: 'Submit', placeholder: '', ariaLabel: '',
    value: '', href: '', visible: true, enabled: true, region: 'main_content',
    bbox: { x: 0, y: 0, width: 10, height: 10 }, type: '', autocomplete: '',
    ...overrides
  };
}

function pageState(elements, overrides = {}) {
  return { url: 'https://example.com/', title: 'Example', elements, sensitiveRegions: [], timestamp: 1, ...overrides };
}

// ── toCompactPageState — shape and basics ───────────────────────────────────

test('projects url/title and each element to {id, role, name, type, sensitive, sensitiveType}', () => {
  const out = toCompactPageState(pageState([el({ id: 'el_1', role: 'button', tag: 'button', text: 'Submit' })]));
  assert.equal(out.url, 'https://example.com/');
  assert.equal(out.title, 'Example');
  assert.deepEqual(out.visibleInteractiveElements, [
    { id: 'el_1', role: 'button', name: 'Submit', type: 'button', sensitive: false, sensitiveType: null }
  ]);
});

test('name falls back placeholder -> ariaLabel when text is empty', () => {
  const out = toCompactPageState(pageState([
    el({ id: 'a', text: '', placeholder: 'Search products' }),
    el({ id: 'b', text: '', placeholder: '', ariaLabel: 'Close dialog' }),
  ]));
  assert.equal(out.visibleInteractiveElements[0].name, 'Search products');
  assert.equal(out.visibleInteractiveElements[1].name, 'Close dialog');
});

test('name is truncated to 60 chars', () => {
  const long = 'x'.repeat(200);
  const out = toCompactPageState(pageState([el({ text: long })]));
  assert.equal(out.visibleInteractiveElements[0].name.length, 60);
});

// ── visibility / enabled filtering ───────────────────────────────────────────

test('excludes invisible and disabled elements', () => {
  const out = toCompactPageState(pageState([
    el({ id: 'a', visible: true, enabled: true }),
    el({ id: 'b', visible: false }),
    el({ id: 'c', enabled: false }),
  ]));
  assert.deepEqual(out.visibleInteractiveElements.map((e) => e.id), ['a']);
});

test('tolerates a missing/malformed elements array or pageState', () => {
  assert.deepEqual(toCompactPageState({ url: 'x', title: 'y' }).visibleInteractiveElements, []);
  assert.deepEqual(toCompactPageState(null), { url: '', title: '', visibleInteractiveElements: [] });
  assert.deepEqual(toCompactPageState(undefined).visibleInteractiveElements, []);
});

test('skips null/undefined entries inside the elements array without throwing', () => {
  const out = toCompactPageState(pageState([el({ id: 'a' }), null, undefined, el({ id: 'b' })]));
  assert.deepEqual(out.visibleInteractiveElements.map((e) => e.id), ['a', 'b']);
});

// ── maxElements cap ───────────────────────────────────────────────────────────

test('caps at the default of 150, in original order', () => {
  const many = Array.from({ length: 400 }, (_, i) => el({ id: `el_${i}` }));
  const out = toCompactPageState(pageState(many));
  assert.equal(out.visibleInteractiveElements.length, 150);
  assert.equal(out.visibleInteractiveElements[0].id, 'el_0');
  assert.equal(out.visibleInteractiveElements[149].id, 'el_149');
});

test('maxElements is configurable', () => {
  const many = Array.from({ length: 10 }, (_, i) => el({ id: `el_${i}` }));
  const out = toCompactPageState(pageState(many), { maxElements: 3 });
  assert.deepEqual(out.visibleInteractiveElements.map((e) => e.id), ['el_0', 'el_1', 'el_2']);
});

// ── sensitivity: RE-DERIVED here, never trusted blindly ─────────────────────

test('flags a sensitive element via the same PrivacySanitizer rules PageStateService uses', () => {
  const out = toCompactPageState(pageState([el({ type: 'password', text: '', placeholder: 'Password' })]));
  assert.equal(out.visibleInteractiveElements[0].sensitive, true);
  assert.equal(out.visibleInteractiveElements[0].sensitiveType, 'password');
});

test('SAFETY: a sensitive element NEVER exposes its text/value in `name`, even if the caller forgot to sanitize it', () => {
  // Simulates a page-state object that was NOT pre-sanitized (e.g. built by
  // different/future code) — this module must still never leak the real value.
  const out = toCompactPageState(pageState([
    el({ type: 'password', text: 'hunter2', placeholder: 'Password' }),
    el({ type: 'email', text: 'jane@example.com', placeholder: '' }),
  ]));
  assert.equal(out.visibleInteractiveElements[0].name, 'Password', 'falls back to the static label');
  assert.equal(out.visibleInteractiveElements[0].name.includes('hunter2'), false);
  assert.equal(out.visibleInteractiveElements[1].name, REDACTED, 'no safe label available -> REDACTED, never the raw value');
});

test('a non-sensitive field with an ALREADY-redacted text (upstream Phase 1) is unaffected — REDACTED marker is not itself sensitive', () => {
  const out = toCompactPageState(pageState([el({ type: 'text', text: REDACTED, sensitive: true, sensitiveType: 'email' })]));
  // sensitiveType is re-derived from type/autocomplete/label/content, not trusted
  // from the input flag — a generic text input with only a REDACTED marker and
  // no other signal is correctly judged non-sensitive by the real rules.
  assert.equal(out.visibleInteractiveElements[0].sensitive, false);
});

test('a normal field with legitimate visible text is passed through untouched', () => {
  const out = toCompactPageState(pageState([el({ type: 'text', text: 'Search products' })]));
  assert.equal(out.visibleInteractiveElements[0].name, 'Search products');
  assert.equal(out.visibleInteractiveElements[0].sensitive, false);
});

// ── estimatePayloadBytes / estimateCompactionSavings ─────────────────────────

test('estimatePayloadBytes returns a UTF-8 byte length and tolerates cycles', () => {
  assert.equal(estimatePayloadBytes('abc'), 5); // JSON.stringify('abc') === '"abc"'
  assert.equal(estimatePayloadBytes({ a: 1 }), JSON.stringify({ a: 1 }).length);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(estimatePayloadBytes(cyclic), 0);
});

test('estimateCompactionSavings reports counts/bytes and never mutates the input', () => {
  const elements = Array.from({ length: 20 }, (_, i) => el({ id: `el_${i}`, text: `Item number ${i} with a longer descriptive label` }));
  const ps = pageState(elements);
  const before = JSON.stringify(ps);
  const savings = estimateCompactionSavings(ps);
  assert.equal(savings.rawElementCount, 20);
  assert.equal(savings.compactElementCount, 20);
  assert.ok(savings.rawBytes > 0);
  assert.ok(savings.compactBytes > 0);
  assert.ok(savings.reductionPct >= 0 && savings.reductionPct <= 100);
  assert.equal(JSON.stringify(ps), before);
});

test('estimateCompactionSavings handles an empty/missing elements array without dividing by zero', () => {
  const savings = estimateCompactionSavings(pageState([]));
  assert.deepEqual(savings, { rawElementCount: 0, compactElementCount: 0, rawBytes: 2, compactBytes: 2, reductionPct: 0 });
});

test('this module never imports page-state-service.js (fully decoupled from V3-owned extraction logic)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'compact-page-state.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/from ['"].*page-state-service/.test(code), false);
});
