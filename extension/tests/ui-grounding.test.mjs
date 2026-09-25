// ScreenPilot v2 — UI Grounding Model Unit Tests
//
// P0 #1: L2 was rewritten from token-count-diluted scoring (matches / total
// user tokens) to IDF-weighted coverage scoring, computed dynamically from
// the current page's own candidate elements — no hardcoded vocabulary, no
// synonyms, no site-specific rules, no phrase dictionaries. See
// ui-grounding-service.js's scoreElement() doc comment for the rationale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { UIGroundingService } from '../services/ui-grounding-service.js';

test('UIGroundingService ranks candidate elements by intent relevance', () => {
  const elements = [
    { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search products', visible: true, enabled: true },
    { id: 'el_2', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true },
    { id: 'el_3', role: 'link', tag: 'a', text: 'Contact Us', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Search products', elements);

  assert.equal(ranked.length > 0, true);
  assert.equal(ranked[0].element.id, 'el_1', 'Search input element should rank top for Search products');
  assert.ok(ranked[0].score >= 0.70, 'Search input score should meet or exceed 0.70 threshold');
});

test('UIGroundingService assigns zero score to invisible elements', () => {
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Hidden Button', visible: false, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Click Hidden Button', elements);
  assert.equal(ranked.length, 0, 'Invisible elements must be excluded from ranking');
});

// ── Generic natural-language phrasing (the exact bug this rewrite fixes) ────
//
// Longer, more natural phrasing used to be punished because the old score
// divided matches by the FULL user token count. None of these tests encode
// any specific site, phrase, or button-name rule — they only rely on the
// generic mechanism: extra words that don't appear on ANY candidate must not
// dilute a candidate whose own words are fully present in the goal.

test('a natural, longer phrasing ("help me sign in") still clears the L2 threshold for a clearly-matching control', () => {
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Sign In', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Create Account', visible: true, enabled: true },
    { id: 'el_3', role: 'link', tag: 'a', text: 'Forgot Password', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('help me sign in', elements);

  assert.ok(ranked.length > 0, 'at least one candidate must be ranked');
  assert.equal(ranked[0].element.id, 'el_1');
  assert.ok(ranked[0].score >= 0.70, `expected top score >= 0.70, got ${ranked[0].score}`);
});

test('a goal with a value/payload token that appears on no candidate does not dilute the matching candidate below threshold', () => {
  // "artificial intelligence" is the thing to type, not a page label — no
  // candidate's own text could ever contain it. The old scoring (matches /
  // total intent tokens) would have driven this below 0.70; the new
  // coverage scoring excludes ungroundable tokens from the denominator.
  const elements = [
    { id: 'el_1', role: 'searchbox', tag: 'input', ariaLabel: 'Search Wikipedia', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Main page', visible: true, enabled: true },
    { id: 'el_3', role: 'link', tag: 'a', text: 'Random article', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Search Wikipedia for artificial intelligence', elements);

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].element.id, 'el_1');
  assert.ok(ranked[0].score >= 0.70, `expected top score >= 0.70, got ${ranked[0].score}`);
});

// ── Rare vs. common tokens (IDF) ─────────────────────────────────────────────

test('a token shared by many candidates contributes less than a token unique to one candidate', () => {
  // "settings" appears on three unrelated controls (common/low-IDF); "theme"
  // appears only on the one control the goal is actually about (rare/high-IDF).
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Theme Settings', visible: true, enabled: true },
    { id: 'el_2', role: 'button', tag: 'button', text: 'Account Settings', visible: true, enabled: true },
    { id: 'el_3', role: 'button', tag: 'button', text: 'Privacy Settings', visible: true, enabled: true },
    { id: 'el_4', role: 'button', tag: 'button', text: 'Notification Settings', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('change the theme settings', elements);

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].element.id, 'el_1', 'the element covering the rare/distinctive token ("theme") should outrank the others');
  assert.ok(ranked[0].score > ranked[1].score, 'the rare-token match must score strictly higher than a common-token-only match');
});

// ── Removed constant floors: an unrelated element must never be inflated ────

test('an element with zero lexical overlap scores exactly 0, never inflated by role/region defaults', () => {
  const elements = [
    { id: 'el_1', role: 'generic', tag: 'div', text: 'Unrelated Content', visible: true, enabled: true, region: 'top_navigation' }
  ];

  const score = UIGroundingService.scoreElement('Update my billing address', elements[0]);
  assert.equal(score, 0, 'an element sharing no vocabulary with the goal must score 0, even with a "boosted" region');
});

test('rankElements filters out every candidate when none share any vocabulary with the goal', () => {
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Unrelated Content', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Also Unrelated', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Perform complex multi-step workflow', elements);
  assert.equal(ranked.length, 0, 'zero shared vocabulary must mean zero ranked candidates, not a role/region-floor score');
});

// ── Determinism / genericness ────────────────────────────────────────────────

test('scoring is deterministic — identical inputs always produce identical output', () => {
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Checkout', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'View Cart', visible: true, enabled: true }
  ];

  const first  = UIGroundingService.rankElements('proceed to checkout', elements);
  const second = UIGroundingService.rankElements('proceed to checkout', elements);
  assert.deepEqual(first, second);
});

test('no hardcoded phrase table: swapping in a structurally-equivalent but different vocabulary produces the analogous result', () => {
  // Same shape of goal/candidates as the "sign in" test above, entirely
  // different words — if any behavior were hardcoded to specific phrases,
  // this would fail while the other test passed.
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Export Report', visible: true, enabled: true },
    { id: 'el_2', role: 'link', tag: 'a', text: 'Delete Workspace', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('please export the report for me', elements);

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].element.id, 'el_1');
  assert.ok(ranked[0].score >= 0.70);
});
