// ScreenPilot v2 — DOMMatcher test suite
// Run: node extension/tests/dom-matcher.test.mjs

import assert from 'assert/strict';

// ── Browser global stubs ──────────────────────────────────────────────────────
//
// dom-matcher.js is an IIFE that (in ESM / extension mode) attaches itself to
// window.DOMMatcher instead of using module.exports.  Globals must be set
// BEFORE the dynamic import so the IIFE captures them.

const DEFAULT_RECT   = { width: 100, height: 40, top: 50, left: 50, bottom: 90, right: 150 };
const OFFSCREEN_RECT = { width: 100, height: 40, top: -200, left: -200, bottom: -160, right: -100 };
const ZERO_RECT      = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };

// Controls what querySelectorAll returns in the current test — mutated per test.
let _candidates = [];

global.window = {
  innerWidth:          1280,
  innerHeight:         800,
  getComputedStyle:   () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  addEventListener:    () => {},
  removeEventListener: () => {},
  DOMMatcher:          null,  // filled in by the IIFE on import
};

global.document = {
  querySelectorAll: () => _candidates,
  body:             null,
  documentElement:  null,
};

// ── Load DOMMatcher (sets window.DOMMatcher as side-effect) ───────────────────

await import('../lib/dom-matcher.js');
const DM = global.window.DOMMatcher;

if (!DM?.matchElement) {
  console.error('FATAL: window.DOMMatcher not populated after import');
  process.exit(1);
}

// ── Element factory ───────────────────────────────────────────────────────────

function makeEl({
  text         = '',
  ariaLabel    = null,
  title        = null,
  role         = null,
  tag          = 'BUTTON',
  disabled     = false,
  ariaDisabled = null,
  rect         = DEFAULT_RECT,
  parentTag    = 'NAV',   // used by detectRegion via closest() / parentElement chain
  parentRole   = null,
  parentLeft   = parentTag === 'ASIDE' ? 50 : 400,  // controls <nav> left-heuristic in detectRegion
  visible      = true,
  isConnected  = true,
  id           = null,
  dataTestid   = null,
} = {}) {
  const parent = {
    tagName:       parentTag,
    getAttribute:  (a) => {
      if (a === 'role') return parentRole;
      if (a === 'aria-modal') return null;
      return null;
    },
    parentElement: null,
    getBoundingClientRect: () => ({ left: parentLeft, ...DEFAULT_RECT }),
  };
  return {
    tagName:           tag,
    innerText:         text,
    textContent:       text,
    disabled:          disabled,
    isConnected,
    isContentEditable: false,
    getAttribute: (attr) => {
      if (attr === 'aria-label')    return ariaLabel;
      if (attr === 'title')         return title;
      if (attr === 'role')          return role;
      if (attr === 'aria-disabled') return ariaDisabled;
      if (attr === 'id')            return id;
      if (attr === 'data-testid')   return dataTestid;
      if (attr === 'disabled')      return disabled ? '' : null;
      if (attr === 'aria-modal')    return null;
      return null;
    },
    closest: (sel) => {
      // Simulate detectRegion() walking closest(landmark-selectors)
      // detectRegion looks for: dialog, [aria-modal], menu/listbox roles, form, footer,
      // toolbar, main, aside, header, nav — in that priority order.
      if (sel.includes('aside')  && parentTag === 'ASIDE')  return parent;
      if (sel.includes('header') && parentTag === 'HEADER') return parent;
      if (sel.includes('main')   && parentTag === 'MAIN')   return parent;
      if (sel.includes('nav')    && parentTag === 'NAV')    return parent;
      if (sel.includes('form')   && parentTag === 'FORM')   return parent;
      // screenpilot overlay check
      if (sel.includes('screenpilot')) return null;
      return null;
    },
    parentElement:         parent,
    getBoundingClientRect: () => ({ ...DEFAULT_RECT, ...rect }),
    checkVisibility:       () => visible,
  };
}

function setElems(...els) { _candidates = els; }

// ── Test runner ───────────────────────────────────────────────────────────────

let pass = 0, fail = 0;

async function test(name, fn) {
  _candidates = [];
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    fail++;
  }
}

console.log('\nDOMMatcher\n');

// ── 1. Null-guard ─────────────────────────────────────────────────────────────

await test('null / empty / whitespace text returns null', async () => {
  assert.equal(DM.matchElement(null),           null);
  assert.equal(DM.matchElement({}),             null);
  assert.equal(DM.matchElement({ text: '   ' }), null);
});

// ── 2. Exact text match ───────────────────────────────────────────────────────

await test('exact text match: score ≥ 100, matchType=exact', async () => {
  setElems(makeEl({ text: 'Submit', tag: 'BUTTON' }));
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r,                    'should match');
  assert.ok(r.score >= 100,       `score ${r.score} should be ≥ 100`);
  assert.equal(r.matchType, 'exact', `matchType should be exact, got ${r.matchType}`);
});

// ── 3. aria-label matching ────────────────────────────────────────────────────

await test('aria-label: icon-only element matched via aria-label', async () => {
  setElems(makeEl({ text: '', ariaLabel: 'Close dialog', tag: 'BUTTON' }));
  const r = DM.matchElement({ text: 'Close dialog', type: 'button' });
  assert.ok(r, 'should match via aria-label');
  assert.ok(r.score >= 100, `score ${r.score} should be ≥ 100 for aria-label exact match`);
});

await test('aria-label: element with junk text but good aria-label is matched', async () => {
  setElems(makeEl({ text: '×', ariaLabel: 'Close dialog', tag: 'BUTTON' }));
  const r = DM.matchElement({ text: 'Close dialog', type: 'button' });
  assert.ok(r, 'should match via aria-label over symbol text');
  assert.ok(r.score >= 100);
});

// ── 4. Hidden element excluded ────────────────────────────────────────────────

await test('hidden element excluded; visible duplicate still matched', async () => {
  setElems(
    makeEl({ text: 'Submit', visible: false, tag: 'BUTTON' }),
    makeEl({ text: 'Submit', visible: true,  tag: 'A' }),
  );
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r, 'should match visible element');
  assert.equal(r.element.tagName, 'A', 'hidden button excluded; <a> wins');
});

// ── 5. Disabled element filtered ─────────────────────────────────────────────

await test('disabled=true element excluded; enabled sibling wins', async () => {
  setElems(
    makeEl({ text: 'Submit', disabled: true,  tag: 'BUTTON' }),
    makeEl({ text: 'Submit', disabled: false, tag: 'A' }),
  );
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r, 'enabled element should match');
  assert.equal(r.element.tagName, 'A', 'disabled button must be excluded');
});

await test('aria-disabled="true" element excluded; enabled sibling wins', async () => {
  setElems(
    makeEl({ text: 'Next', ariaDisabled: 'true', tag: 'BUTTON' }),
    makeEl({ text: 'Next', ariaDisabled: null,   tag: 'A' }),
  );
  const r = DM.matchElement({ text: 'Next', type: 'button' });
  assert.ok(r, 'enabled element should match');
  assert.equal(r.element.tagName, 'A', 'aria-disabled element excluded');
});

await test('all disabled candidates → null', async () => {
  setElems(makeEl({ text: 'Submit', disabled: true }));
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.equal(r, null, 'null when only disabled elements exist');
});

// ── 6. Region match disambiguates duplicate labels ────────────────────────────

await test('region match: HEADER element wins over ASIDE when region=top_navigation', async () => {
  // detectRegion: HEADER → 'top_navigation', ASIDE → 'side_navigation'
  const topEl  = makeEl({ text: 'Billing', tag: 'A', parentTag: 'HEADER' });
  const sideEl = makeEl({ text: 'Billing', tag: 'A', parentTag: 'ASIDE'  });
  setElems(topEl, sideEl);

  const r = DM.matchElement({ text: 'Billing', type: 'link', region: 'top_navigation' });
  assert.ok(r, 'should match');
  assert.equal(r.element, topEl,
    `HEADER element must win; got parentTag=${r.element.parentElement?.tagName}`);
});

await test('region match: reason string includes region name', async () => {
  const el = makeEl({ text: 'Settings', tag: 'A', parentTag: 'HEADER' });
  setElems(el);
  const r = DM.matchElement({ text: 'Settings', type: 'link', region: 'top_navigation' });
  assert.ok(r?.reason?.includes('region') || r?.reason?.includes('top_navigation'),
    `reason should mention region, got: "${r?.reason}"`);
});

await test('no region hint: DOM-order first element wins (no penalty applied)', async () => {
  const el1 = makeEl({ text: 'Billing', tag: 'A', parentTag: 'HEADER' });
  const el2 = makeEl({ text: 'Billing', tag: 'A', parentTag: 'ASIDE'  });
  setElems(el1, el2);

  const r = DM.matchElement({ text: 'Billing', type: 'link' });
  assert.ok(r, 'should match');
  assert.equal(r.element, el1, 'first in DOM order wins when no region hint');
});

// ── 7. candidates array ────────────────────────────────────────────────────────

await test('candidates sorted descending by score', async () => {
  const e1 = makeEl({ text: 'Submit',      tag: 'BUTTON' });
  const e2 = makeEl({ text: 'Send',        tag: 'BUTTON' });  // synonym
  const e3 = makeEl({ text: 'Submit Form', tag: 'A' });       // contains / lower score
  setElems(e1, e2, e3);

  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r, 'should match');
  assert.ok(Array.isArray(r.candidates), 'candidates must be an array');
  assert.ok(r.candidates.length >= 1);

  for (let i = 1; i < r.candidates.length; i++) {
    assert.ok(
      r.candidates[i - 1].score >= r.candidates[i].score,
      `index ${i - 1} (score ${r.candidates[i-1].score}) should be ≥ index ${i} (score ${r.candidates[i].score})`
    );
  }
  assert.equal(r.element, e1, 'exact match is best candidate');
});

await test('candidates capped at 5', async () => {
  setElems(
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
    makeEl({ text: 'Submit' }),
  );
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r?.candidates?.length <= 5, `candidates should be ≤ 5, got ${r?.candidates?.length}`);
});

// ── 8. Confidence field ───────────────────────────────────────────────────────

await test('confidence is in [0, 1] range for exact match', async () => {
  setElems(makeEl({ text: 'Confirm' }));
  const r = DM.matchElement({ text: 'Confirm', type: 'button' });
  assert.ok(r, 'should match');
  assert.ok(typeof r.confidence === 'number',          'confidence must be a number');
  assert.ok(r.confidence >= 0 && r.confidence <= 1.0,
    `confidence ${r.confidence} out of range [0, 1]`);
  assert.ok(r.confidence >= 0.70,
    `exact match confidence ${r.confidence.toFixed(2)} should be ≥ 0.70`);
});

await test('exact match confidence > contains/fuzzy match confidence', async () => {
  setElems(makeEl({ text: 'Monthly Billing', tag: 'A' }));
  const rFuzzy = DM.matchElement({ text: 'Billing', type: 'button' });

  setElems(makeEl({ text: 'Billing', tag: 'BUTTON' }));
  const rExact = DM.matchElement({ text: 'Billing', type: 'button' });

  assert.ok(rFuzzy, 'fuzzy (contains) should still produce a match');
  assert.ok(rExact.confidence > rFuzzy.confidence,
    `exact (${rExact.confidence.toFixed(2)}) should exceed fuzzy (${rFuzzy.confidence.toFixed(2)})`);
});

await test('confidence capped at 1.0 even for multi-attribute match', async () => {
  setElems(makeEl({ text: 'Save', ariaLabel: 'Save', dataTestid: 'save-btn' }));
  const r = DM.matchElement({ text: 'Save', type: 'button' });
  assert.ok(r, 'should match');
  assert.ok(r.confidence <= 1.0, `confidence must be ≤ 1.0, got ${r.confidence}`);
});

// ── 9. isDisabled utility ─────────────────────────────────────────────────────

await test('isDisabled: native disabled=true → true', async () => {
  assert.equal(DM.isDisabled(makeEl({ disabled: true })), true);
});

await test('isDisabled: aria-disabled="true" → true', async () => {
  assert.equal(DM.isDisabled(makeEl({ ariaDisabled: 'true' })), true);
});

await test('isDisabled: enabled element → false', async () => {
  assert.equal(DM.isDisabled(makeEl({ disabled: false })), false);
});

// ── 10. isInViewport utility ──────────────────────────────────────────────────

await test('isInViewport: element within viewport → true', async () => {
  assert.equal(DM.isInViewport(makeEl({ rect: DEFAULT_RECT })), true);
});

await test('isInViewport: element completely off-screen → false', async () => {
  assert.equal(DM.isInViewport(makeEl({ rect: OFFSCREEN_RECT })), false);
});

await test('isInViewport: zero-size element → false', async () => {
  assert.equal(DM.isInViewport(makeEl({ rect: ZERO_RECT })), false);
});

// ── 11. Synonym matching ──────────────────────────────────────────────────────

await test('synonym: "Save" element matches target "submit"', async () => {
  setElems(makeEl({ text: 'Save', tag: 'BUTTON' }));
  const r = DM.matchElement({ text: 'submit', type: 'button' });
  assert.ok(r, 'synonym should match');
  assert.ok(
    r.matchType === 'synonym' || r.matchType === 'exact',
    `matchType should be synonym or exact, got ${r.matchType}`
  );
});

// ── 12. No match → null ───────────────────────────────────────────────────────

await test('no DOM elements → null', async () => {
  setElems();
  assert.equal(DM.matchElement({ text: 'Submit', type: 'button' }), null);
});

await test('DOM elements with no text match → null', async () => {
  setElems(makeEl({ text: 'Help' }), makeEl({ text: 'About' }));
  assert.equal(DM.matchElement({ text: 'Submit', type: 'button' }), null);
});

// ── 13. Region scoring edge cases ─────────────────────────────────────────────

await test('region mismatch: -8 penalty drops borderline title-contains score below PRIMARY=60', async () => {
  // title contains match: score=70 × weight=0.9 = 63.0 → round(63) = 63  (> PRIMARY)
  // ASIDE detectRegion → 'side_navigation'; target says 'top_navigation' → mismatch → -8
  // finalScore = round(63 - 8) = 55  — below PRIMARY=60, would fail executor gate
  const el = makeEl({ text: '', title: 'submit request', tag: 'SPAN', parentTag: 'ASIDE' });
  setElems(el);

  const rNoRegion = DM.matchElement({ text: 'submit' });
  assert.ok(rNoRegion, 'without region, borderline element should still be returned by matchElement');
  assert.equal(rNoRegion.score, 63,
    `no-region score should be 63, got ${rNoRegion.score}`);

  const rMismatch = DM.matchElement({ text: 'submit', region: 'top_navigation' });
  assert.ok(rMismatch, 'matchElement returns all scored elements — PRIMARY gate lives in executor');
  assert.equal(rMismatch.score, 55,
    `mismatch score should be 55, got ${rMismatch.score}`);
  assert.ok(rMismatch.score < 60,
    `score ${rMismatch.score} must be below PRIMARY=60 — executor would emit element:not_found`);
});

await test('region match: +20 bonus lifts Levenshtein title-match from below PRIMARY to above', async () => {
  // title levenshtein-1 ("xubmit"): score=56 × weight=0.9 = 50.4 → round(50) = 50  (< PRIMARY)
  // Note: "submitx" would trigger a CONTAINS match (score 70, not levenshtein).
  // "xubmit" (x replaces s) has levenshtein=1 and no substring overlap with "submit".
  // ASIDE detectRegion → 'side_navigation'; target says 'side_navigation' → match → +20
  // finalScore = round(50.4 + 20) = round(70.4) = 70  — above PRIMARY=60
  const el = makeEl({ text: '', title: 'xubmit', tag: 'SPAN', parentTag: 'ASIDE' });
  setElems(el);

  const rNoRegion = DM.matchElement({ text: 'submit' });
  assert.ok(rNoRegion, 'should match even without region');
  assert.equal(rNoRegion.score, 50,
    `no-region score should be 50, got ${rNoRegion.score}`);

  const rMatch = DM.matchElement({ text: 'submit', region: 'side_navigation' });
  assert.ok(rMatch, 'should match with correct region hint');
  assert.equal(rMatch.score, 70,
    `region-match score should be 70, got ${rMatch.score}`);
  assert.ok(rMatch.score >= 60,
    `score ${rMatch.score} must be ≥ PRIMARY=60 — executor would resolve element`);
});

await test('no region hint: score identical to pre-Phase-6 formula (region term = 0)', async () => {
  // Calling with no region / region:undefined must produce the same score either way.
  // Verifies that the region term is a pure additive extension with a clean zero path.
  const el = makeEl({ text: 'Billing', tag: 'BUTTON', parentTag: 'HEADER' });
  setElems(el);

  const rOmitted   = DM.matchElement({ text: 'Billing', type: 'button' });
  const rUndefined = DM.matchElement({ text: 'Billing', type: 'button', region: undefined });
  assert.ok(rOmitted, 'should match without region');
  assert.equal(rOmitted.score, rUndefined.score,
    `region omitted (${rOmitted.score}) vs region:undefined (${rUndefined.score}) must be equal`);
});

await test('detectRegion: <nav> at left=0 is classified as side_navigation (known heuristic gap)', async () => {
  // A full-width horizontal top navbar is a <nav> starting at left:0.
  // The left < 160 heuristic misclassifies it as side_navigation instead of top_navigation.
  // This is a pre-existing limitation of detectRegion — documented here as a known gap.
  // Consequence: target with region='top_navigation' inside such a <nav> gets -8 mismatch
  // instead of the expected +20 match, reducing score by 28 points total.
  const el = makeEl({ text: 'Billing', tag: 'A', parentTag: 'NAV', parentLeft: 0 });
  setElems(el);

  const region = DM.detectRegion(el);
  assert.equal(region, 'side_navigation',
    `<nav left=0> must be classified as side_navigation by the left<160 heuristic; got "${region}"`);

  // Element gets mismatch penalty (-8) instead of match bonus (+20): delta = 28 points
  const rExpected = DM.matchElement({ text: 'Billing', type: 'link' });          // no region
  const rPenalised = DM.matchElement({ text: 'Billing', type: 'link', region: 'top_navigation' });
  assert.ok(rPenalised.score < rExpected.score,
    `mismatch penalty must reduce score: penalised=${rPenalised.score} < baseline=${rExpected.score}`);
  assert.equal(rExpected.score - rPenalised.score, 8,
    `score delta should be exactly 8 (the REGION_MISMATCH_PENALTY constant)`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
