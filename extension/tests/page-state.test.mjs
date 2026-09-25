// ScreenPilot v2 — Page State Extraction Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateService } from '../services/page-state-service.js';

function mockDoc() {
  const elements = [
    {
      tagName: 'INPUT',
      getAttribute: (k) => k === 'placeholder' ? 'Search products' : null,
      innerText: '',
      textContent: '',
      offsetParent: {},
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 30 }),
      closest: () => null
    },
    {
      tagName: 'BUTTON',
      getAttribute: (k) => k === 'aria-label' ? 'Submit Search' : null,
      innerText: 'Search',
      textContent: 'Search',
      offsetParent: {},
      getBoundingClientRect: () => ({ x: 220, y: 10, width: 80, height: 30 }),
      closest: (sel) => sel.includes('nav') ? {} : null
    }
  ];

  return {
    title: 'Test Store Page',
    querySelectorAll: () => elements
  };
}

function mockLoc() {
  return { href: 'https://store.example.com/search' };
}

test('PageStateService extracts normalized website-agnostic page state', () => {
  const doc = mockDoc();
  const loc = mockLoc();

  const state = PageStateService.extractPageState({ doc, loc });

  assert.equal(state.url, 'https://store.example.com/search');
  assert.equal(state.title, 'Test Store Page');
  assert.equal(state.elements.length, 2);

  const inputEl = state.elements[0];
  assert.equal(inputEl.id, 'el_1');
  assert.equal(inputEl.role, 'textbox');
  assert.equal(inputEl.tag, 'input');
  assert.equal(inputEl.placeholder, 'Search products');
  assert.equal(inputEl.visible, true);
  assert.equal(inputEl.enabled, true);

  const buttonEl = state.elements[1];
  assert.equal(buttonEl.id, 'el_2');
  assert.equal(buttonEl.role, 'button');
  assert.equal(buttonEl.tag, 'button');
  assert.equal(buttonEl.text, 'Search');
  assert.equal(buttonEl.ariaLabel, 'Submit Search');
});

// ── Generic accessible-name resolution (aria-labelledby / label[for] / ─────
// ── ancestor <label>) ────────────────────────────────────────────────────
//
// These prove PageState accurately represents what a webpage's interactive
// elements are called even when the accessible name comes from a standard
// DOM/ARIA relationship rather than an inline aria-label/placeholder — no
// site-specific logic, just the DOM/ARIA relationships themselves.

function makeTextNode(id, text) {
  return { id, innerText: text, textContent: text, getAttribute: () => null };
}

function makeInputStub({ id = '', ariaLabelledby = '', getAttrs = {}, closestResult = null } = {}) {
  return {
    id,
    tagName: 'INPUT',
    type: 'text',
    getAttribute: (k) => {
      if (k === 'aria-labelledby') return ariaLabelledby || null;
      if (k === 'id') return id || null;
      return Object.prototype.hasOwnProperty.call(getAttrs, k) ? getAttrs[k] : null;
    },
    innerText: '',
    textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    closest: (sel) => (sel === 'label' ? closestResult : null),
  };
}

test('resolveAccessibleName: aria-labelledby resolves a single referenced element', () => {
  const target = makeInputStub({ id: 'field1', ariaLabelledby: 'lbl1' });
  const doc = {
    getElementById: (id) => (id === 'lbl1' ? makeTextNode('lbl1', 'Full Name') : null),
    querySelectorAll: () => [],
  };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Full Name');
});

test('resolveAccessibleName: aria-labelledby resolves and joins MULTIPLE space-separated references', () => {
  const target = makeInputStub({ id: 'field2', ariaLabelledby: 'lbl-a lbl-b' });
  const nodes = { 'lbl-a': makeTextNode('lbl-a', 'Billing'), 'lbl-b': makeTextNode('lbl-b', 'Address') };
  const doc = {
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: () => [],
  };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Billing Address');
});

test('resolveAccessibleName: falls back to an associated label[for] when no aria-label/aria-labelledby exists', () => {
  const target = makeInputStub({ id: 'field3' });
  const label = { getAttribute: (k) => (k === 'for' ? 'field3' : null), innerText: 'Email Address', textContent: 'Email Address' };
  const doc = {
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === 'label[for]' ? [label] : []),
  };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Email Address');
});

test('resolveAccessibleName: falls back to an ancestor <label> wrapping the control', () => {
  const wrappingLabel = { innerText: 'Remember me', textContent: 'Remember me' };
  const target = makeInputStub({ id: 'field4', closestResult: wrappingLabel });
  const doc = { getElementById: () => null, querySelectorAll: () => [] };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Remember me');
});

test('resolveAccessibleName precedence: direct aria-label wins over aria-labelledby, label[for], and title', () => {
  const label = { getAttribute: (k) => (k === 'for' ? 'field5' : null), innerText: 'From label[for]', textContent: 'From label[for]' };
  const target = makeInputStub({
    id: 'field5',
    ariaLabelledby: 'lbl5',
    getAttrs: { 'aria-label': 'Direct Label', title: 'From title' },
  });
  const doc = {
    getElementById: (id) => (id === 'lbl5' ? makeTextNode('lbl5', 'From labelledby') : null),
    querySelectorAll: () => [label],
  };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Direct Label');
});

test('resolveAccessibleName precedence: aria-labelledby wins over label[for] and title when aria-label is absent', () => {
  const label = { getAttribute: (k) => (k === 'for' ? 'field6' : null), innerText: 'From label[for]', textContent: 'From label[for]' };
  const target = makeInputStub({ id: 'field6', ariaLabelledby: 'lbl6', getAttrs: { title: 'From title' } });
  const doc = {
    getElementById: (id) => (id === 'lbl6' ? makeTextNode('lbl6', 'From labelledby') : null),
    querySelectorAll: () => [label],
  };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'From labelledby');
});

test('resolveAccessibleName precedence: label[for] wins over title when aria-label/aria-labelledby are absent', () => {
  const label = { getAttribute: (k) => (k === 'for' ? 'field7' : null), innerText: 'From label[for]', textContent: 'From label[for]' };
  const target = makeInputStub({ id: 'field7', getAttrs: { title: 'From title' } });
  const doc = { getElementById: () => null, querySelectorAll: () => [label] };
  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'From label[for]');
});

test('resolveAccessibleName: still falls back to title, then to existing img[alt] behavior, when nothing else resolves', () => {
  const withTitle = makeInputStub({ id: 'field8', getAttrs: { title: 'From title' } });
  const doc = { getElementById: () => null, querySelectorAll: () => [] };
  assert.equal(PageStateService.resolveAccessibleName(withTitle, doc), 'From title');

  const withImgAlt = {
    ...makeInputStub({ id: 'field9' }),
    querySelector: (sel) => (sel === 'img[alt]' ? { getAttribute: () => 'Icon description' } : null),
  };
  assert.equal(PageStateService.resolveAccessibleName(withImgAlt, doc), 'Icon description');
});

test('extractPageState: an input labeled only via label[for] is now given a usable ariaLabel end-to-end', () => {
  const inputEl = {
    id: 'search-box',
    tagName: 'INPUT',
    type: 'text',
    getAttribute: (k) => (k === 'id' ? 'search-box' : null),
    innerText: '', textContent: '',
    offsetParent: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }),
    closest: () => null,
  };
  const labelEl = { getAttribute: (k) => (k === 'for' ? 'search-box' : null), innerText: 'Search this site', textContent: 'Search this site' };
  const doc = {
    title: 'Test Page',
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === 'label[for]' ? [labelEl] : [inputEl]),
  };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].ariaLabel, 'Search this site', 'previously this would have been empty — the exact class of gap that hid a real search input from L2/Qwen');
});

// ── Privacy: newly-resolved labels go through the SAME sanitization path ───

test('a password input labeled only via label[for] is still correctly flagged sensitive and its value redacted', () => {
  const pwdInput = {
    id: 'pwd',
    tagName: 'INPUT',
    type: 'password',
    value: 'hunter2',
    getAttribute: (k) => (k === 'id' ? 'pwd' : k === 'type' ? 'password' : null),
    innerText: '', textContent: '',
    offsetParent: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }),
    closest: () => null,
  };
  const labelEl = { getAttribute: (k) => (k === 'for' ? 'pwd' : null), innerText: 'Password', textContent: 'Password' };
  const doc = {
    title: 'Login',
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === 'label[for]' ? [labelEl] : [pwdInput]),
  };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com/login' } });
  assert.equal(state.elements[0].ariaLabel, 'Password');
  assert.equal(state.elements[0].sensitive, true, 'the label[for]-resolved "Password" name must still trigger PrivacySanitizer\'s sensitive-keyword detection');
  assert.equal(state.elements[0].value, '[REDACTED]', 'the actual typed value must still be redacted, regardless of which accessible-name source labeled the field');
});

test('a field labeled "Social Security Number" only via aria-labelledby is still flagged sensitive', () => {
  const ssnInput = {
    id: 'ssn',
    tagName: 'INPUT',
    type: 'text',
    value: '123-45-6789',
    getAttribute: (k) => (k === 'aria-labelledby' ? 'ssn-label' : k === 'id' ? 'ssn' : null),
    innerText: '', textContent: '',
    offsetParent: {}, getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }),
    closest: () => null,
  };
  const doc = {
    title: 'Profile',
    getElementById: (id) => (id === 'ssn-label' ? makeTextNode('ssn-label', 'Social Security Number') : null),
    querySelectorAll: () => [ssnInput],
  };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com/profile' } });
  assert.equal(state.elements[0].ariaLabel, 'Social Security Number');
  assert.equal(state.elements[0].sensitive, true);
  assert.equal(state.elements[0].value, '[REDACTED]');
});

// ── formId: the standard native `element.form` relationship, exposed so the ─
// ── decision-router can generically find a filled input's own submit control ─

test('extractPageState: two elements that share the same native <form> get the same formId', () => {
  const sharedForm = { tagName: 'FORM' };
  const input = {
    tagName: 'INPUT', type: 'text', form: sharedForm,
    getAttribute: (k) => (k === 'placeholder' ? 'Search' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }), closest: () => null,
  };
  const button = {
    tagName: 'BUTTON', form: sharedForm,
    getAttribute: () => null, innerText: 'Go', textContent: 'Go', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 50, height: 20 }), closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [input, button] };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.equal(state.elements.length, 2);
  assert.ok(state.elements[0].formId, 'formId must be populated when a native <form> association exists');
  assert.equal(state.elements[0].formId, state.elements[1].formId, 'elements sharing the same <form> must get the same formId');
});

// ── Latency regression: the label[for] index is built ONCE per extraction ───
//
// Resolving the label per element previously issued a fresh
// querySelectorAll('label[for]') — a full document walk — for every element
// carrying an id (measured: 301 scans for a 300-element page, and
// extractPageState runs more than once per planning cycle).

test('extractPageState scans for label[for] exactly once, regardless of element count', () => {
  let labelScans = 0;
  const makeIdedInput = (i) => ({
    tagName: 'INPUT', type: 'text', id: `field-${i}`,
    getAttribute: (k) => (k === 'id' ? `field-${i}` : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    closest: () => null,
  });
  const inputs = Array.from({ length: 50 }, (_, i) => makeIdedInput(i));
  const label  = { getAttribute: (k) => (k === 'for' ? 'field-7' : null), innerText: 'Field Seven', textContent: 'Field Seven' };
  const doc = {
    title: 'T', getElementById: () => null,
    querySelectorAll: (sel) => {
      if (sel === 'label[for]') { labelScans++; return [label]; }
      return inputs;
    },
  };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(labelScans, 1, `label[for] must be indexed once per extraction, not per element (was ${labelScans} scans for ${inputs.length} elements)`);
  assert.equal(state.elements[7].ariaLabel, 'Field Seven', 'the indexed lookup must still resolve the right label');
  assert.equal(state.elements[6].ariaLabel, '', 'elements without a matching label must still resolve to empty');
});

test('the label[for] index keeps first-match-in-document-order semantics on duplicate for values', () => {
  const target = {
    tagName: 'INPUT', type: 'text', id: 'dup',
    getAttribute: (k) => (k === 'id' ? 'dup' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    closest: () => null,
  };
  const first  = { getAttribute: (k) => (k === 'for' ? 'dup' : null), innerText: 'First Label', textContent: 'First Label' };
  const second = { getAttribute: (k) => (k === 'for' ? 'dup' : null), innerText: 'Second Label', textContent: 'Second Label' };
  const doc = {
    title: 'T', getElementById: () => null,
    querySelectorAll: (sel) => (sel === 'label[for]' ? [first, second] : [target]),
  };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.equal(state.elements[0].ariaLabel, 'First Label', 'the earlier label in document order must still win, as the old per-element scan did');
});

test('resolveAccessibleName still works when called directly without a prebuilt index', () => {
  // The two-argument form is part of the module surface and is used outside
  // the extraction loop — it must keep resolving label[for] on its own.
  const target = {
    tagName: 'INPUT', id: 'solo',
    getAttribute: (k) => (k === 'id' ? 'solo' : null),
    innerText: '', textContent: '', closest: () => null,
  };
  const label = { getAttribute: (k) => (k === 'for' ? 'solo' : null), innerText: 'Standalone', textContent: 'Standalone' };
  const doc = { getElementById: () => null, querySelectorAll: (sel) => (sel === 'label[for]' ? [label] : []) };

  assert.equal(PageStateService.resolveAccessibleName(target, doc), 'Standalone');
});

test('extractPageState: elements in different forms (or no form) get different/null formIds', () => {
  const formA = { tagName: 'FORM' };
  const formB = { tagName: 'FORM' };
  const inA = {
    tagName: 'INPUT', type: 'text', form: formA,
    getAttribute: (k) => (k === 'placeholder' ? 'Field A' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }), closest: () => null,
  };
  const inB = {
    tagName: 'INPUT', type: 'text', form: formB,
    getAttribute: (k) => (k === 'placeholder' ? 'Field B' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }), closest: () => null,
  };
  const noForm = {
    tagName: 'INPUT', type: 'text', form: null,
    getAttribute: (k) => (k === 'placeholder' ? 'Field C' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }), closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [inA, inB, noForm] };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.notEqual(state.elements[0].formId, state.elements[1].formId);
  assert.equal(state.elements[2].formId, null);
});

// ── Standard HTML `required` attribute is surfaced generically ─────────────

test('extractPageState: the required attribute is exposed via getAttribute (mock-safe path)', () => {
  const input = {
    tagName: 'INPUT', type: 'text', id: 'repo-name',
    getAttribute: (k) => (k === 'required' ? '' : k === 'id' ? 'repo-name' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }), closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [input] };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.equal(state.elements[0].required, true);
});

test('extractPageState: a control with no required attribute reports required=false', () => {
  const input = {
    tagName: 'INPUT', type: 'text', id: 'optional-field',
    getAttribute: (k) => (k === 'placeholder' ? 'Optional' : null),
    innerText: '', textContent: '', offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 30 }), closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [input] };

  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });
  assert.equal(state.elements[0].required, false);
});

// ── ScreenPilot's own on-page UI is excluded from page state ───────────────
//
// The widget (goal input, Explain/Ask buttons, highlight overlay) matches the
// same generic selector as any other page control, so without an exclusion it
// entered pageState.elements and became a routing candidate — reachable and
// scoreable by L1/L2/Qwen, but never actually resolvable by the executor
// (which already excludes it via the same selector), so a plan that picked it
// could only fail. This reuses the identical selector already used by
// collectPageControls() / isScreenPilotNode() rather than inventing a new one.

function makeMockEl({ id = '', className = '', dataScreenpilot = false, text = '', isSpDescendant = false } = {}) {
  const isSpSelf = id.startsWith('sp-') || id.startsWith('screenpilot-') || className.includes('sp-') || dataScreenpilot;
  return {
    tagName: 'BUTTON',
    id,
    className,
    getAttribute: (k) => {
      if (k === 'id') return id || null;
      if (k === 'data-screenpilot') return dataScreenpilot ? '' : null;
      return null;
    },
    innerText: text,
    textContent: text,
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 24 }),
    // Mirrors real Element.closest() behavior against the SP_SEL compound
    // selector: matches if this element itself is SP-owned, OR (for a plain
    // descendant with no SP markers of its own) if isSpDescendant says an
    // ancestor is.
    closest: (sel) => ((isSpSelf || isSpDescendant) && /sp-|screenpilot-|data-screenpilot/.test(sel)) ? {} : null,
  };
}

test('extractPageState excludes ScreenPilot elements identified by id', () => {
  const els = [
    makeMockEl({ id: 'screenpilot-widget', text: 'Explain' }),
    makeMockEl({ id: 'ordinary-button', text: 'Submit' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Submit');
});

test('extractPageState excludes ScreenPilot elements identified by class', () => {
  const els = [
    makeMockEl({ className: 'sp-btn-ask', text: 'Ask' }),
    makeMockEl({ className: 'page-button', text: 'Save' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Save');
});

test('extractPageState excludes ScreenPilot elements identified by data-screenpilot', () => {
  const els = [
    makeMockEl({ dataScreenpilot: true, text: 'Explain' }),
    makeMockEl({ id: 'checkout', text: 'Checkout' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Checkout');
});

test('extractPageState excludes nested descendants inside the ScreenPilot widget', () => {
  // The descendant carries no sp-/screenpilot- marker of its own — only an
  // ancestor (e.g. #screenpilot-widget) does. closest() must still catch it.
  const els = [
    makeMockEl({ isSpDescendant: true, text: 'What do you want to do?' }),
    makeMockEl({ id: 'login-btn', text: 'Log in' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Log in');
});

test('extractPageState leaves ordinary page elements with superficially similar names untouched', () => {
  // Guards against SP_SEL's substring match ([class*="sp-"]) over-matching a
  // site's own unrelated class such as "display-sp-large".
  const el = makeMockEl({ className: 'display-large', text: 'Sponsor banner' });
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [el] };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Sponsor banner');
});

test('extractPageState element ids stay contiguous after excluding ScreenPilot elements', () => {
  const els = [
    makeMockEl({ id: 'screenpilot-widget', text: 'Explain' }),
    makeMockEl({ id: 'first', text: 'First' }),
    makeMockEl({ className: 'sp-btn-ask', text: 'Ask' }),
    makeMockEl({ id: 'second', text: 'Second' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 2);
  assert.equal(state.elements[0].id, 'el_1');
  assert.equal(state.elements[0].text, 'First');
  assert.equal(state.elements[1].id, 'el_2');
  assert.equal(state.elements[1].text, 'Second');
});

test('extractPageState regression: a genuine page target remains available alongside ScreenPilot UI', () => {
  const els = [
    makeMockEl({ id: 'screenpilot-widget', text: 'Explain' }),
    makeMockEl({ className: 'sp-btn-ask', text: 'Ask' }),
    makeMockEl({ id: 'submit-order', text: 'Submit Order' }),
  ];
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => els };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].text, 'Submit Order');
});

// ── Icon-only buttons (no accessible name) are still valid candidates ──────
//
// A button/role="button" conveying its purpose purely visually (e.g. via
// CSS/pseudo-elements, no text/aria-label/title/placeholder) is a standard,
// generic UI pattern — not a "no information" element. It still carries role,
// tag, and a bounding box, which is exactly what visual-perception (Moondream)
// candidate resolution needs. Previously such a button was silently dropped
// before L1/L2/L3 ever saw it, so it could never be offered as a candidate at
// all — "elementId: null" from vision was actually an upstream "never even
// offered" bug, not a perception failure.

test('extractPageState retains a <button> with no text/aria-label/title/placeholder', () => {
  const iconButton = {
    tagName: 'BUTTON',
    getAttribute: () => null,
    innerText: '', textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 500, y: 400, width: 40, height: 40 }),
    closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [iconButton] };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1, 'an icon-only button must still be extracted as a candidate');
  assert.equal(state.elements[0].role, 'button');
  assert.equal(state.elements[0].text, '');
  assert.deepEqual(state.elements[0].bbox, { x: 500, y: 400, width: 40, height: 40 });
});

test('extractPageState retains a non-<button> element with role="button" and no accessible name', () => {
  const iconRoleButton = {
    tagName: 'DIV',
    getAttribute: (k) => (k === 'role' ? 'button' : null),
    innerText: '', textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 32, height: 32 }),
    closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [iconRoleButton] };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].role, 'button');
});

test('extractPageState still drops a genuinely unnamed, non-button element (e.g. a bare <span>)', () => {
  // Preserves existing behavior: the exception is scoped to buttons only —
  // an unnamed, non-interactive-role element with no label of any kind still
  // carries no useful information for any consumer and stays excluded.
  const bareSpan = {
    tagName: 'SPAN',
    getAttribute: () => null,
    innerText: '', textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }),
    closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [bareSpan] };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 0);
});

test('extractPageState still drops a genuinely unnamed link (href-less exception is not extended to links)', () => {
  const bareAnchor = {
    tagName: 'A',
    getAttribute: () => null, // no href, no aria-label, no title
    innerText: '', textContent: '',
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }),
    closest: () => null,
  };
  const doc = { title: 'T', getElementById: () => null, querySelectorAll: () => [bareAnchor] };
  const state = PageStateService.extractPageState({ doc, loc: { href: 'https://example.com' } });

  assert.equal(state.elements.length, 0);
});
