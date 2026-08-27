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
  childImgAlt  = null,   // simulates <img alt="…"> inside the element
  isSpNode     = false,  // simulates element inside a ScreenPilot overlay (#sp-* or screenpilot-*)
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
      // ScreenPilot self-match filter: return truthy when this element is marked as a
      // ScreenPilot node AND the selector asks about sp-* / screenpilot-* membership.
      if (isSpNode && (sel.includes('sp-') || sel.includes('screenpilot'))) return {};
      // Simulate detectRegion() walking closest(landmark-selectors)
      // detectRegion looks for: dialog, [aria-modal], menu/listbox roles, form, footer,
      // toolbar, main, aside, header, nav — in that priority order.
      if (sel.includes('aside')  && parentTag === 'ASIDE')  return parent;
      if (sel.includes('header') && parentTag === 'HEADER') return parent;
      if (sel.includes('main')   && parentTag === 'MAIN')   return parent;
      if (sel.includes('nav')    && parentTag === 'NAV')    return parent;
      if (sel.includes('form')   && parentTag === 'FORM')   return parent;
      return null;
    },
    parentElement:         parent,
    getBoundingClientRect: () => ({ ...DEFAULT_RECT, ...rect }),
    checkVisibility:       () => visible,
    querySelector: (sel) => {
      if (sel === 'img[alt]' && childImgAlt !== null) {
        return { getAttribute: (a) => a === 'alt' ? childImgAlt : null };
      }
      return null;
    },
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

await test('icon-only boost: aria-label button in correct region beats exact-text sidebar link', async () => {
  // Regression for the GitHub avatar-vs-Profile-link mismatch (Phase 4.1 audit).
  //
  // Sidebar <a>Profile</a> in <nav left=0> → detectRegion='side_navigation':
  //   text exact 110×1.0=110  |  type(<a>+menu)=+10  |  region mismatch=-8  →  112
  //
  // Avatar <button aria-label="View profile and more"> in <header> → top_navigation:
  //   no text → ariaLabelWeight=1.6; contains match 70×1.6=112  |  type=+10  |  region match=+20  →  142
  //
  // Avatar must win; before the fix it scored 107 (weight=1.1) and lost.
  const sidebarLink = makeEl({
    text:       'Profile',
    tag:        'A',
    parentTag:  'NAV',
    parentLeft: 0,       // left < 160 → detectRegion returns 'side_navigation'
  });
  const avatarButton = makeEl({
    text:       '',
    ariaLabel:  'View profile and more',
    tag:        'BUTTON',
    parentTag:  'HEADER', // → detectRegion returns 'top_navigation'
  });

  setElems(sidebarLink, avatarButton);
  const r = DM.matchElement({ text: 'profile', type: 'menu', region: 'top_navigation' });

  assert.ok(r, 'should resolve an element');
  assert.equal(r.element, avatarButton,
    `avatar button must win; got tagName=${r.element.tagName} innerText="${r.element.innerText}"`);
  assert.ok(r.score >= 140,
    `avatar score ${r.score} must be ≥ 140 (sidebar scores 112 in this shim; need clear margin)`);
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

// ── 14. img-alt accessible name ───────────────────────────────────────────────

await test('img-alt: icon-only button matched via child img alt', async () => {
  // <button><img alt="User avatar"></button> — no aria-label, no visible text.
  // The ARIA accessible name is computed from the child img per the ARIA spec.
  // img-alt weight=1.4 (icon-only): 110 × 1.4 = 154 + type(+10) + region(+20) = 184.
  const avatarBtn = makeEl({
    text:        '',
    ariaLabel:   null,
    childImgAlt: 'User avatar',
    tag:         'BUTTON',
    parentTag:   'HEADER',
  });
  setElems(avatarBtn);
  const r = DM.matchElement({ text: 'User avatar', type: 'button', region: 'top_navigation' });
  assert.ok(r,                   'should match via img-alt');
  assert.equal(r.element, avatarBtn, 'matched element must be the avatar button');
  assert.ok(r.score >= 140,      `score ${r.score} should be ≥ 140`);
});

await test('img-alt: aria-label takes priority over img-alt when both match', async () => {
  // When a button has both aria-label and child img alt, aria-label wins.
  // aria-label weight=1.6 (icon-only): 110 × 1.6 = 176
  // img-alt    weight=1.4 (icon-only): 110 × 1.4 = 154
  // scoreElement() picks the highest weighted score — aria-label always wins.
  const el = makeEl({
    text:        '',
    ariaLabel:   'User avatar',
    childImgAlt: 'User avatar',
    tag:         'BUTTON',
    parentTag:   'HEADER',
  });
  setElems(el);
  const r = DM.matchElement({ text: 'User avatar', type: 'button', region: 'top_navigation' });
  assert.ok(r, 'should match');
  // Score must reflect aria-label weight (1.6), not img-alt weight (1.4):
  // 110 × 1.6 = 176 + type(+10) + region(+20) = 206 → capped at 200.
  assert.equal(r.score, 200, `score ${r.score} should be 200 (aria-label wins, capped)`);
});

await test('img-alt: text-bearing button has img-alt weight suppressed to 0.7', async () => {
  // When a button has both visible text and a decorative img, the text is the primary label.
  // img-alt weight drops to 0.7 to prevent decorative alts from outscoring visible text.
  // "save" text: 110 × 1.0 = 110  vs  "icon" img-alt: 110 × 0.7 = 77
  const el = makeEl({
    text:        'Save',
    childImgAlt: 'icon',
    tag:         'BUTTON',
    parentTag:   'MAIN',
  });
  setElems(el);
  // Target matches visible text "Save" — must win over img-alt "icon"
  const rText = DM.matchElement({ text: 'Save', type: 'button' });
  assert.ok(rText, 'should match via text');
  assert.ok(rText.score >= 110, `text score ${rText.score} should be ≥ 110`);

  // Target matches img-alt "icon" only — must score lower than a text match
  const rImgAlt = DM.matchElement({ text: 'icon', type: 'button' });
  assert.ok(rImgAlt, 'should also match via img-alt');
  assert.ok(rImgAlt.score < rText.score,
    `img-alt score ${rImgAlt.score} must be lower than text score ${rText.score}`);
});

await test('img-alt: absent img yields no contribution (no regression on existing elements)', async () => {
  // Elements without a child img[alt] must behave identically to before the change.
  // querySelector returns null → childImgAlt = '' → scoreAttributeValue returns null.
  const el = makeEl({ text: 'Submit', ariaLabel: null, childImgAlt: null, tag: 'BUTTON' });
  setElems(el);
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r, 'should match via text');
  // text exact match: 110 × 1.0 = 110 + type(+10) = 120 (no region hint)
  assert.equal(r.score, 120, `score ${r.score} must be exactly 120 — same as pre-change`);
});

// ── 15. ScreenPilot self-match filter ────────────────────────────────────────

await test('self-match guard: sp-v2-status-banner excluded from candidates', async () => {
  // Regression for [SP:Exec] Candidate 1/1 score=90 <div id="sp-v2-status-banner">.
  // The status banner enters via the [id] selector in getCandidateSelectors(), then
  // slips through isScreenPilotNode() because the old filter only listed the 5
  // screenpilot-* IDs and had no pattern for sp-v2-* elements.
  const spBanner = makeEl({
    text:     'ScreenPilot · Planning…',
    tag:      'DIV',
    id:       'sp-v2-status-banner',
    isSpNode: true,
  });
  setElems(spBanner);
  const r = DM.matchElement({ text: 'Planning', type: 'button' });
  assert.equal(r, null, 'sp-v2-status-banner must be excluded — isScreenPilotNode must return true for [id^="sp-"]');
});

await test('self-match guard: sp-* element excluded even when it outscores a page element', async () => {
  // Both elements have exact text "Create", but the sp-* one must be excluded regardless
  // of score. The real page element must win.
  const spBtn  = makeEl({ text: 'Create', tag: 'BUTTON', id: 'sp-v2-create-btn', isSpNode: true  });
  const pageEl = makeEl({ text: 'Create', tag: 'BUTTON', id: null,               isSpNode: false });
  setElems(spBtn, pageEl);
  const r = DM.matchElement({ text: 'Create', type: 'button' });
  assert.ok(r,                   'real page element must still match');
  assert.equal(r.element, pageEl, 'winner must be the real page element, not the sp-* button');
});

await test('self-match guard: non-sp element with matching text is unaffected', async () => {
  // Confirm the fix does not suppress legitimate page elements.
  const el = makeEl({ text: 'Submit', tag: 'BUTTON', id: 'page-submit-btn', isSpNode: false });
  setElems(el);
  const r = DM.matchElement({ text: 'Submit', type: 'button' });
  assert.ok(r, 'real page element must still match after the sp-* filter is applied');
  assert.equal(r.element, el, 'page element must be returned');
});

// ── Phase 24A: pure-symbol target collapse ─────────────────────────────────────
//
// A pure-symbol target ("+", "#", ">", "*") must NOT reach the substring/Levenshtein
// fallbacks — those made every "+"-bearing node (<main>, "C++", "+1,204") score 62 and
// let DOM order pick <main>. Symbol targets may only match via exact/token/synonym.

await test('symbol target "+": <main>, "C++", "+123" do NOT match (no substring collapse)', async () => {
  setElems(
    makeEl({ text: 'Star 12 Fork 3 C++ 98.7% +1,204 −56', tag: 'MAIN', id: 'js-repo-pjax-container', parentTag: 'MAIN' }),
    makeEl({ text: 'C++',    tag: 'A',    parentTag: 'MAIN' }),
    makeEl({ text: '+123',   tag: 'SPAN', id: 'diffstat', parentTag: 'MAIN' }),
  );
  const r = DM.matchElement({ text: '+', type: 'button', region: 'top_navigation' });
  assert.equal(r, null, 'pure "+" must not substring-match "+"-bearing text → element_not_found');
});

await test('symbol target "+": still matches "Create new…" via the synonym path', async () => {
  setElems(makeEl({ text: '', ariaLabel: 'Create new…', tag: 'BUTTON', parentTag: 'HEADER' }));
  const r = DM.matchElement({ text: '+', type: 'button', region: 'top_navigation' });
  assert.ok(r, 'the icon create button must still resolve');
  assert.ok(r.score >= 100, `expected strong synonym score, got ${r.score}`);
});

await test('symbol target "+": create button wins and "+"-noise is not even a candidate', async () => {
  const noise = makeEl({ text: 'C++ 98.7% +1,204', tag: 'MAIN', id: 'js-repo-pjax-container', parentTag: 'MAIN' });
  const create = makeEl({ text: '', ariaLabel: 'Create new…', tag: 'BUTTON', parentTag: 'HEADER' });
  setElems(noise, create);
  const r = DM.matchElement({ text: '+', type: 'button', region: 'top_navigation' });
  assert.equal(r.element, create, 'winner must be the create button');
  assert.equal(r.candidates.length, 1, '"+"-bearing noise must be filtered out entirely');
});

await test('symbol target "#": does not substring-match a "#tag" node', async () => {
  setElems(makeEl({ text: '#trending', tag: 'A', parentTag: 'MAIN' }));
  const r = DM.matchElement({ text: '#', type: 'link', region: 'main_content' });
  assert.equal(r, null, 'pure "#" must not substring-match "#trending"');
});

await test('alphanumeric target: contains fallback still works (no regression)', async () => {
  setElems(makeEl({ text: 'Settings', tag: 'A', parentTag: 'NAV' }));
  const r = DM.matchElement({ text: 'ettings', type: 'link', region: 'side_navigation' });
  assert.ok(r, 'a real alphanumeric substring target must still contains-match');
});

// ── Phase 24B: type:"input" candidate-selector restriction ────────────────────
//
// The querySelectorAll mock (`() => _candidates`) ignores the selector string
// entirely, so scoring-level tests can't exercise this fix — a label placed
// into _candidates would be "found" by the stub regardless of the generated
// selector. These tests capture the actual selector string passed to
// querySelectorAll to verify getCandidateSelectors() itself, independent of
// scoring (which was explicitly NOT touched by this fix).

await test('type:"input": generated selector excludes [id]/[aria-label]/[data-testid]/select — labels and wrappers can never become candidates', async () => {
  let capturedSelector = null;
  const originalQSA = document.querySelectorAll;
  document.querySelectorAll = (sel) => { capturedSelector = sel; return originalQSA(sel); };
  try {
    setElems(makeEl({ text: 'Repository name', tag: 'INPUT' }));
    DM.matchElement({ text: 'Repository name', type: 'input', region: 'form' });
  } finally {
    document.querySelectorAll = originalQSA;
  }
  assert.equal(
    capturedSelector,
    'input,textarea,[contenteditable="true"],[role="textbox"]',
    'type:"input" must query ONLY the editable-control selectors'
  );
  assert.ok(!capturedSelector.includes('[id]'),          'must not include [id] (this is what let the <label id="..."> in)');
  assert.ok(!capturedSelector.includes('[aria-label]'),  'must not include [aria-label]');
  assert.ok(!capturedSelector.includes('[data-testid]'), 'must not include [data-testid]');
  assert.ok(!capturedSelector.includes('select'),         'must not include select');
  assert.ok(!capturedSelector.includes('button'),         'must not include button');
});

await test('type:"button"/"link"/"menu": selector generation is unchanged (still preferred + common union)', async () => {
  const cases = [
    { type: 'button', text: 'Submit', tag: 'BUTTON' },
    { type: 'link',    text: 'Home',   tag: 'A' },
    { type: 'menu',    text: 'More',   tag: 'BUTTON' },
  ];
  for (const { type, text, tag } of cases) {
    let capturedSelector = null;
    const originalQSA = document.querySelectorAll;
    document.querySelectorAll = (sel) => { capturedSelector = sel; return originalQSA(sel); };
    try {
      setElems(makeEl({ text, tag }));
      DM.matchElement({ text, type });
    } finally {
      document.querySelectorAll = originalQSA;
    }
    assert.ok(capturedSelector.includes('[id]'),         `type:"${type}" must still include [id] (unchanged)`);
    assert.ok(capturedSelector.includes('[aria-label]'), `type:"${type}" must still include [aria-label] (unchanged)`);
    assert.ok(capturedSelector.includes('select'),        `type:"${type}" must still include select (unchanged)`);
  }
});

await test('type:"input": a real <input> still matches normally (no regression)', async () => {
  setElems(makeEl({ tag: 'INPUT', text: '', ariaLabel: 'Repository name' }));
  const r = DM.matchElement({ text: 'Repository name', type: 'input' });
  assert.ok(r, 'real input must still match');
  assert.ok(r.score >= 100, `expected a strong match, got ${r?.score}`);
});

// ── Associated-label scoring (Option B) ────────────────────────────────────────
//
// The label itself must NEVER be a candidate (Phase 24B guarantee, unaffected —
// getCandidateSelectors('input') is untouched). These tests confirm the WINNING
// element is always the <input>, using label text only as a scoring signal.

await test('Case 1: <label for="repo"> resolves via element.labels — input matches, label never a candidate', async () => {
  const input = makeEl({ tag: 'INPUT', id: 'repo', text: '', ariaLabel: null });
  input.labels = [{ innerText: 'Repository name', textContent: 'Repository name' }];
  setElems(input);
  const r = DM.matchElement({ text: 'Repository name', type: 'input' });
  assert.ok(r, 'input must match via its associated label text');
  assert.equal(r.element, input, 'winner must be the input, never a label');
  assert.ok(r.score >= 100, `expected a strong (exact) match, got ${r?.score}`);
  assert.ok(r.reason.includes('associated-label'), `reason should cite associated-label, got "${r.reason}"`);
});

await test('Case 2: wrapping <label>text<input></label> also resolves via element.labels', async () => {
  // Implicit label association (no `for`/`id` needed) — element.labels covers this
  // natively in a real browser; the mock here simulates that same resolved list.
  const input = makeEl({ tag: 'INPUT', text: '', ariaLabel: null });
  input.labels = [{ innerText: 'Repository name', textContent: 'Repository name' }];
  setElems(input);
  const r = DM.matchElement({ text: 'Repository name', type: 'input' });
  assert.ok(r, 'input must match via its wrapping label text');
  assert.equal(r.element, input, 'winner must be the input, never a label');
});

await test('Case 3: aria-labelledby fallback resolves and concatenates referenced ids', async () => {
  const originalGetById = document.getElementById;
  document.getElementById = (id) => (id === 'label-id' ? { innerText: 'Repository name', textContent: 'Repository name' } : null);
  try {
    const input = makeEl({ tag: 'INPUT', text: '', ariaLabel: null });
    const originalGetAttribute = input.getAttribute;
    input.getAttribute = (attr) => (attr === 'aria-labelledby' ? 'label-id' : originalGetAttribute(attr));
    setElems(input);
    const r = DM.matchElement({ text: 'Repository name', type: 'input' });
    assert.ok(r, 'input must match via aria-labelledby resolution');
    assert.equal(r.element, input, 'winner must be the input');
  } finally {
    document.getElementById = originalGetById;
  }
});

await test('Case 4: input with no label association behaves unchanged (own aria-label still wins)', async () => {
  // No .labels, no aria-labelledby — getAssociatedLabelText() must return '' (a no-op)
  // and NOT interfere with the element's own attribute scoring.
  setElems(makeEl({ tag: 'INPUT', text: '', ariaLabel: 'Repository name' }));
  const r = DM.matchElement({ text: 'Repository name', type: 'input' });
  assert.ok(r, 'input must still match via its own aria-label, unaffected by the new signal');
  assert.ok(r.score >= 100, `expected a strong match, got ${r?.score}`);
});

await test('defense-in-depth: input outranks a same-text label even in a mixed candidate pool', async () => {
  // Actual candidate-pool EXCLUSION of labels is a selector-generation guarantee
  // (Phase 24B, getCandidateSelectors('input')) — this mock's querySelectorAll
  // ignores the selector string entirely (see the Phase 24B selector-capture
  // tests above), so it cannot re-prove that exclusion here. What this DOES
  // prove: even in the worst case where a label ends up scored alongside the
  // input, the input's new associated-label signal (weight 1.1) plus its
  // type-affinity bonus now outrank the label's raw exact-text match (weight 1,
  // no type bonus) — a genuine second line of defense beyond selector exclusion.
  const label = makeEl({ tag: 'LABEL', id: 'repository-name-input-label', text: 'Repository name' });
  const input = makeEl({ tag: 'INPUT', id: 'repo' });
  input.labels = [{ innerText: 'Repository name', textContent: 'Repository name' }];
  setElems(label, input);
  const r = DM.matchElement({ text: 'Repository name', type: 'input' });
  assert.equal(r.element, input, 'winner must be the input, outranking the label even when both are scored');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
