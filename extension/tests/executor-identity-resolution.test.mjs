// ExecutorEngine — resolve the SPECIFIC element a step's planner selected, using
// identity evidence that survives layout change (row context + position among
// same-labelled controls), and FAIL CLOSED when that evidence is missing,
// contradicted or ambiguous — never substituting an arbitrary same-labelled
// control. Nothing here names a site; rows are made-up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorEngine } from '../services/executor-engine.js';
import { PageStateService } from '../services/page-state-service.js';
import { resolveRowContext } from '../lib/row-context.js';

// ── DOM mock: rows of [name link, same-labelled button] with movable geometry ──
const LABEL = 'Repository settings';
const PITCH = 100;
const ROW_TAGS = new Set(['LI']);

function el(tagName, { text = '', attrs = {}, children = [], className = '' } = {}) {
  const n = {
    tagName, className, children, parentElement: null, isConnected: true, disabled: false,
    offsetParent: {}, _text: text, _acted: [], _y: 0,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    matches: () => ROW_TAGS.has(tagName),
    closest: (sel) => (sel.startsWith('button') ? n : null),
    querySelector: () => null,
    querySelectorAll: () => n._controls ?? [],
    contains: () => true,
    getBoundingClientRect: () => ({ x: 500, y: n._y, left: 500, top: n._y, right: 540, bottom: n._y + 20, width: 40, height: 20 }),
    click() { n._acted.push('click'); }, focus() { n._acted.push('focus'); },
    dispatchEvent() { n._acted.push('dispatchEvent'); return true; },
  };
  Object.defineProperty(n, 'innerText', { get: () => n._text || n.children.map((c) => c.innerText).filter(Boolean).join(' ') });
  Object.defineProperty(n, 'textContent', { get: () => n.innerText });
  for (const c of children) c.parentElement = n;
  return n;
}

/** A list page: one row per name, each with a name link and a same-labelled settings button. */
function page(names) {
  const buttons = [];
  const rows = names.map((name, i) => {
    const link = el('A', { text: name, attrs: { href: `/${name}` } });
    const btn = el('BUTTON', { text: LABEL, attrs: { 'aria-label': LABEL } });
    buttons.push(btn);
    const row = el('LI', { children: [link, btn] });
    row._controls = [link, btn];
    link._y = btn._y = i * PITCH;
    return row;
  });
  const controls = rows.flatMap((r) => r.children);
  const p = { names, rows, buttons, controls, extra: [] };
  p.all = () => [...p.extra, ...controls]; // DOM order: anything in `extra` sits above the list
  p.scroll = (dy) => controls.forEach((c) => { c._y += dy; });
  return p;
}

const rectOf = (btn) => { const r = btn.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };

/** What enrichStepFromPageState records at extraction time for the button at `index`. */
function recordedStep(p, index, { context = true, ordinal = true, bbox = true } = {}) {
  const t = { text: LABEL, type: 'button', intent: LABEL, elementId: `el_${index + 1}` };
  if (bbox) t.bbox = rectOf(p.buttons[index]);
  if (context) t.context = p.names[index];
  if (ordinal) { t.labelIndex = index; t.labelCount = p.buttons.length; }
  return t;
}

const docStub = { addEventListener() {}, removeEventListener() {}, elementFromPoint: () => null, getElementById: () => null, querySelectorAll: () => [] };
globalThis.document = docStub;
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'https://host.example/list' } };

function run(p, targetElement, { textFirst } = {}) {
  docStub.querySelectorAll = () => p.all();
  const shownFor = [];
  const ex = new ExecutorEngine({
    domMatcher: {
      // The legacy text match: every duplicate ties, so the FIRST in DOM order wins,
      // with only the first few offered as alternatives (DOMMatcher's top-5 cap).
      matchElement: () => {
        const list = p.buttons;
        const first = textFirst ?? list[0];
        return { element: first, score: 100, alternatives: list.filter((b) => b !== first).slice(0, 4).map((element) => ({ element, score: 100 })), candidates: [] };
      },
      isVisible: () => true,
      isDisabled: (e) => e.disabled === true,
    },
    highlighter: { show: async (e) => { shownFor.push(e); return true; }, clear() {} },
    captureSnapshot: () => ({ url: 'u', title: 't', domHash: 'h', highlightedElementText: '', capturedAt: 0 }),
    elementResolvePollIntervalMs: 1, elementResolveMaxWaitMs: 0,
  });
  const outcome = new Promise((resolve) => {
    ex.on('element:ready', (e) => resolve({ ready: e }));
    ex.on('element:not_found', (e) => resolve({ notFound: e }));
  });
  const acted = [];
  ex.on('user:acted', () => acted.push('user:acted'));
  ex.start({
    planId: 'p', goal: 'g', goalType: 'action', planVersion: 1, confidence: 1, createdAt: 0, currentStepIndex: 0,
    steps: [{ id: 1, description: 'd', intent: 'i', phase: 'navigate', optional: false, timeout_ms: 3000, completionCondition: 'dom_change', reversible: true, targetElement }],
  });
  return { ex, outcome, shownFor, acted };
}

const NAMES = ['alpha-app', 'UpNext', 'beta-svc', 'gamma-lib'];

// ── unchanged page ───────────────────────────────────────────────────────────

test('unchanged page: the selected duplicate resolves — not the first text match', async () => {
  const p = page(NAMES);
  const { ex, outcome } = run(p, recordedStep(p, 1));
  const { ready } = await outcome;
  assert.equal(ready.element, p.buttons[1]);
  ex.abort();
});

test('unchanged page: every row resolves to itself (not only the second)', async () => {
  for (let i = 0; i < NAMES.length; i++) {
    const p = page(NAMES);
    const { ex, outcome } = run(p, recordedStep(p, i));
    assert.equal((await outcome).ready.element, p.buttons[i], `row ${i}`);
    ex.abort();
  }
});

// ── more than five identical controls (no top-5 dependency) ─────────────────

test('more than five identical controls: the 7th of 8 resolves, though it is far outside any top-5', async () => {
  const p = page(Array.from({ length: 8 }, (_, i) => `repo-${i}`));
  const { ex, outcome, shownFor } = run(p, recordedStep(p, 6));
  assert.equal((await outcome).ready.element, p.buttons[6]);
  assert.deepEqual(shownFor, [p.buttons[6]]);
  ex.abort();
});

test('more than five identical controls, target off-screen (nothing painted at its bbox): still resolves by context + ordinal', async () => {
  const p = page(Array.from({ length: 9 }, (_, i) => `repo-${i}`));
  p.buttons.forEach((b, i) => { b._y = 2000 + i * PITCH; }); // all below the fold at extraction
  const { ex, outcome } = run(p, recordedStep(p, 7));
  assert.equal((await outcome).ready.element, p.buttons[7]);
  ex.abort();
});

// ── layout shift: another same-labelled element occupies the old bbox ───────

test('layout shift: a DIFFERENT duplicate now sits at the old bbox — the selected one is still returned, the impostor is not', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 2);
  p.scroll(PITCH); // everything moves down one row: row 1's button is now exactly where row 2's was
  assert.deepEqual(rectOf(p.buttons[1]), step.bbox, 'precondition: the impostor occupies the recorded bbox');
  const { ex, outcome } = run(p, step);
  const { ready } = await outcome;
  assert.equal(ready.element, p.buttons[2]);
  assert.notEqual(ready.element, p.buttons[1]);
  ex.abort();
});

test('layout shift with NO row context (ordinal + position only): position is contradicted -> fail closed, no highlight', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 2, { context: false });
  p.scroll(PITCH);
  const { ex, outcome, shownFor } = run(p, step);
  const { notFound } = await outcome;
  assert.ok(notFound, 'unresolved is reported as not-found so the orchestrator replans from fresh state');
  assert.deepEqual(shownFor, [], 'nothing highlighted');
  ex.abort();
});

test('a row inserted above (the label now occurs one more time): ordinal contradicted -> fail closed', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 2);
  const stray = el('BUTTON', { text: LABEL, attrs: { 'aria-label': LABEL } });
  const strayRow = el('LI', { children: [el('A', { text: 'new-row', attrs: { href: '/n' } }), stray] });
  strayRow._controls = strayRow.children;
  p.extra = strayRow.children;
  p.buttons.unshift(stray);
  const { ex, outcome, shownFor } = run(p, step);
  assert.ok((await outcome).notFound);
  assert.deepEqual(shownFor, []);
  ex.abort();
});

// ── scrolling by one row pitch ──────────────────────────────────────────────

test('scrolling by one row pitch: resolves the selected row by context, never the row now under the old point', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 1);
  p.scroll(-PITCH); // row 2's button is now at row 1's old position
  assert.deepEqual(rectOf(p.buttons[2]), step.bbox, 'precondition: a different duplicate is at the recorded bbox');
  const { ex, outcome } = run(p, step);
  assert.equal((await outcome).ready.element, p.buttons[1]);
  ex.abort();
});

test('scrolling by one row pitch with NO row context: fail closed rather than take the impostor', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 1, { context: false });
  p.scroll(-PITCH);
  const { ex, outcome, shownFor } = run(p, step);
  assert.ok((await outcome).notFound);
  assert.deepEqual(shownFor, []);
  ex.abort();
});

// ── ambiguity fails closed ──────────────────────────────────────────────────

test('ambiguous: two rows with identical context and no ordinal -> position cannot separate them -> no arbitrary highlight', async () => {
  const p = page(['same-row', 'same-row', 'other']);
  const step = recordedStep(p, 0, { ordinal: false });
  p.scroll(37); // nothing sits at the recorded bbox any more
  const { ex, outcome, shownFor } = run(p, step);
  assert.ok((await outcome).notFound);
  assert.deepEqual(shownFor, [], 'the text matcher would have happily returned the first duplicate; it must not be used');
  ex.abort();
});

test('duplicates with a bare {elementId, bbox} (no context, no ordinal): no corroborating evidence -> fail closed', async () => {
  const p = page(NAMES);
  const step = recordedStep(p, 1, { context: false, ordinal: false });
  const { ex, outcome, shownFor } = run(p, step);
  assert.ok((await outcome).notFound);
  assert.deepEqual(shownFor, []);
  ex.abort();
});

test('context that no candidate carries any more (row text changed) -> fail closed', async () => {
  const p = page(NAMES);
  const step = { ...recordedStep(p, 1), context: 'renamed-row' };
  const { ex, outcome, shownFor } = run(p, step);
  assert.ok((await outcome).notFound);
  assert.deepEqual(shownFor, []);
  ex.abort();
});

// ── not applicable -> legacy behaviour unchanged ────────────────────────────

test('legacy text-only step (no elementId/bbox): resolved by text exactly as before', async () => {
  const p = page(NAMES);
  const { ex, outcome } = run(p, { text: LABEL, type: 'button', intent: LABEL });
  assert.equal((await outcome).ready.element, p.buttons[0]);
  ex.abort();
});

test('a unique label with full identity evidence resolves to that one control', async () => {
  const p = page(['only-row']);
  const { ex, outcome } = run(p, recordedStep(p, 0));
  assert.equal((await outcome).ready.element, p.buttons[0]);
  ex.abort();
});

test('the label is not on the page at all: legacy text matching decides (identity does not apply)', async () => {
  const p = page(NAMES);
  const step = { ...recordedStep(p, 1), text: 'Something else entirely' };
  const { ex, outcome } = run(p, step);
  assert.equal((await outcome).ready.element, p.buttons[0]);
  ex.abort();
});

// ── guide-only ──────────────────────────────────────────────────────────────

test('guide-only: the executor never clicks, focuses or dispatches on any control, and user:acted comes only from the user', async () => {
  const p = page(NAMES);
  const { ex, outcome, shownFor, acted } = run(p, recordedStep(p, 1));
  await outcome;
  assert.deepEqual(shownFor, [p.buttons[1]]);
  for (const c of p.controls) assert.deepEqual(c._acted, []);
  assert.deepEqual(acted, []);
  ex.abort();
});

// ── context parity with page-state extraction ───────────────────────────────

test('the executor derives the SAME row context page-state extraction recorded (parity guard for the duplicated algorithm)', () => {
  const p = page(NAMES);
  const state = PageStateService.extractPageState({
    doc: { title: 't', querySelectorAll: () => p.controls, getElementById: () => null },
    loc: { href: 'https://host.example/list' },
  });
  const settings = state.elements.filter((e) => e.text === LABEL);
  assert.equal(settings.length, NAMES.length);
  settings.forEach((e, i) => {
    const live = resolveRowContext(p.buttons[i], PageStateService.clean(p.buttons[i].innerText), PageStateService.resolveAccessibleName(p.buttons[i], docStub));
    assert.equal(live, e.context, `row ${i}`);
    assert.match(e.context, new RegExp(NAMES[i]));
  });
});
