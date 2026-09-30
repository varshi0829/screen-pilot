// ScreenPilot v2 — Contextual container label (page-state `context`) + its use in L2 grounding.
//
// Generic by construction: nothing here names a site, a repo host, or a fixed
// vocabulary — repeated rows of identically-labelled controls are the shape
// under test, with arbitrary made-up row names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateService } from '../services/page-state-service.js';
import { UIGroundingService } from '../services/ui-grounding-service.js';
import { PrivacySanitizer } from '../lib/privacy-sanitizer.js';
import { DecisionRouter } from '../services/decision-router.js';

// ── Minimal DOM mock: parent chain, siblings, matches(), querySelectorAll() ──

const ROW_TAGS = new Set(['LI', 'TR', 'ARTICLE']);

function node(tagName, { className = '', text = '', attrs = {}, children = [] } = {}) {
  const n = {
    tagName,
    className,
    parentElement: null,
    children,
    _text: text,
    _attrs: attrs,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    matches: (sel) => ROW_TAGS.has(tagName) || (attrs.role && sel.includes(`[role="${attrs.role}"]`)),
    offsetParent: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    closest: () => null,
    querySelectorAll: () => n._controls ?? [],
    _controls: null,
  };
  Object.defineProperty(n, 'innerText', {
    get() { return n._text || n.children.map((c) => c.innerText).filter(Boolean).join(' '); },
  });
  Object.defineProperty(n, 'textContent', { get() { return n.innerText; } });
  for (const c of children) c.parentElement = n;
  return n;
}

function button(label) {
  return node('BUTTON', { text: label });
}

/** A list whose rows each hold a name link, a description, and a same-labelled settings button. */
function buildRows(rows, { rowTag = 'LI', rowClass = 'row', controlLabel = 'Repository settings' } = {}) {
  const settings = [];
  const rowNodes = rows.map((r) => {
    const link = node('A', { text: r.name, attrs: { href: `/x/${r.name}` } });
    const desc = node('SPAN', { text: r.desc ?? '' });
    const btn = button(controlLabel);
    settings.push(btn);
    const row = node(rowTag, { className: rowClass, children: [link, desc, btn] });
    row._controls = [link, btn];
    return row;
  });
  const list = node('UL', { children: rowNodes });
  const all = [];
  rowNodes.forEach((row) => row.children.forEach((c) => { if (c.tagName !== 'SPAN') all.push(c); }));
  return { list, rowNodes, settings, all };
}

const loc = { href: 'https://host.example/list' };
const extract = (all) => PageStateService.extractPageState({ doc: { title: 'List', querySelectorAll: () => all }, loc });
const settingsOf = (state) => state.elements.filter((e) => e.text === 'Repository settings');

// ── Extraction ──────────────────────────────────────────────────────────────

test('context: identically-labelled controls get their own row name as context', () => {
  const { all } = buildRows([{ name: 'alpha-app' }, { name: 'UpNext' }, { name: 'beta-svc' }]);
  const [a, u, b] = settingsOf(extract(all));
  assert.match(a.context, /alpha-app/);
  assert.match(u.context, /UpNext/);
  assert.match(b.context, /beta-svc/);
  assert.doesNotMatch(u.context, /alpha-app|beta-svc/, 'a row must not leak its neighbours');
});

test('context: never repeats the control\'s own label', () => {
  const { all } = buildRows([{ name: 'UpNext' }, { name: 'other' }]);
  for (const el of settingsOf(extract(all))) {
    assert.doesNotMatch(el.context.toLowerCase(), /repository settings/);
  }
});

test('context: capped, and a row with a long description stays compact', () => {
  const long = 'lorem ipsum '.repeat(80);
  const { all } = buildRows([{ name: 'UpNext', desc: long }, { name: 'other', desc: long }]);
  for (const el of settingsOf(extract(all))) assert.ok(el.context.length <= 60, `context length ${el.context.length}`);
});

test('context: works for structure with no list/table semantics (repeated look-alike siblings)', () => {
  const { all } = buildRows([{ name: 'UpNext' }, { name: 'other' }], { rowTag: 'DIV', rowClass: 'card' });
  const [u, o] = settingsOf(extract(all));
  assert.match(u.context, /UpNext/);
  assert.match(o.context, /other/);
});

test('context: a lone wrapper that adds nothing beyond the control is skipped for the enclosing row', () => {
  const link = node('A', { text: 'UpNext', attrs: { href: '/u' } });
  const btn = button('Repository settings');
  const wrapper = node('LI', { children: [btn] }); // only the control's own text
  const row = node('LI', { children: [link, wrapper] });
  row._controls = [link, btn];
  const state = extract([link, btn]);
  assert.match(state.elements.find((e) => e.text === 'Repository settings').context, /UpNext/);
});

test('context: ordinary elements outside any row have an empty context', () => {
  const state = PageStateService.extractPageState({
    doc: {
      title: 'Plain',
      querySelectorAll: () => [
        { tagName: 'BUTTON', getAttribute: () => null, innerText: 'Save', textContent: 'Save', offsetParent: {},
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }), closest: () => null },
      ],
    },
    loc,
  });
  assert.equal(state.elements[0].context, '');
});

test('context: a container holding many controls (a whole region/menu) is not treated as a row', () => {
  const links = Array.from({ length: 20 }, (_, i) => node('A', { text: `item${i}`, attrs: { href: `/${i}` } }));
  const btn = button('Repository settings');
  const menuItem = node('LI', { children: [btn] });
  menuItem._controls = links; // 20 controls inside the "row"
  const state = extract([btn]);
  assert.equal(state.elements[0].context, '');
});

test('context: PII in surrounding row text is redacted', () => {
  const link = node('A', { text: 'Ada Lovelace ada@example.com', attrs: { href: '/u' } });
  const btn = button('Edit');
  const row = node('LI', { children: [link, btn] });
  row._controls = [link, btn];
  const state = extract([btn]);
  assert.doesNotMatch(state.elements[0].context, /ada@example\.com/);
});

// ── Privacy: sensitive elements ─────────────────────────────────────────────

test('sanitizer: a sensitive element keeps no row context, and stays flagged sensitive', () => {
  const sanitized = PrivacySanitizer.sanitizeElement({
    id: 'el_1', role: 'textbox', tag: 'input', type: 'password', text: '', value: 'hunter2',
    placeholder: 'Password', context: 'Ada Lovelace admin account', visible: true, enabled: true,
  });
  assert.equal(sanitized.sensitive, true);
  assert.equal(sanitized.context, '');
  assert.equal(sanitized.value, '[REDACTED]');
});

test('sanitizer: a non-sensitive element\'s context is left untouched', () => {
  const el = { id: 'el_1', role: 'button', tag: 'button', text: 'Save', context: 'Project Alpha', visible: true, enabled: true };
  assert.deepEqual(PrivacySanitizer.sanitizeElement(el), el);
});

test('end to end: a password field inside a named row exposes no context in the page state', () => {
  const pw = node('INPUT', { attrs: { type: 'password', placeholder: 'Password' } });
  pw.type = 'password';
  pw.value = 'hunter2';
  const label = node('SPAN', { text: 'Acme Corp admin' });
  const row = node('LI', { children: [label, pw] });
  row._controls = [pw];
  const el = extract([pw]).elements[0];
  assert.equal(el.sensitive, true);
  assert.equal(el.context, '');
});

// ── L2 scoring ──────────────────────────────────────────────────────────────

function el(id, text, context = '', extra = {}) {
  return { id, role: 'button', tag: 'button', text, context, visible: true, enabled: true, region: 'main_content', ...extra };
}

test('L2: the identically-labelled control in the named row outranks the others', () => {
  const elements = [
    el('el_1', 'screen-pilot', '', { role: 'link', tag: 'a' }),
    el('el_2', 'Repository settings', 'screen-pilot Public'),
    el('el_3', 'UpNext', '', { role: 'link', tag: 'a' }),
    el('el_4', 'Repository settings', 'UpNext Public'),
    el('el_5', 'other-repo', '', { role: 'link', tag: 'a' }),
    el('el_6', 'Repository settings', 'other-repo Private'),
  ];
  const ranked = UIGroundingService.rankElements('open the UpNext repository settings', elements);
  const scoreOf = (id) => ranked.find((r) => r.element.id === id)?.score ?? 0;
  assert.ok(scoreOf('el_4') > scoreOf('el_2'), `UpNext row ${scoreOf('el_4')} must beat screen-pilot row ${scoreOf('el_2')}`);
  assert.ok(scoreOf('el_4') > scoreOf('el_6'));
  assert.equal(scoreOf('el_2'), scoreOf('el_6'), 'rows unrelated to the goal stay tied with each other');
});

test('L2: without context the two rows are an exact tie (the behaviour this fixes)', () => {
  const elements = [
    el('el_1', 'Repository settings', ''),
    el('el_2', 'Repository settings', ''),
    el('el_3', 'UpNext', '', { role: 'link', tag: 'a' }),
  ];
  const ranked = UIGroundingService.rankElements('open the UpNext repository settings', elements);
  const s = (id) => ranked.find((r) => r.element.id === id)?.score;
  assert.equal(s('el_1'), s('el_2'));
});

test('L2: a goal naming a row wins on the control whose OWN label matches over one matching only via context', () => {
  const elements = [
    el('el_1', 'UpNext', '', { role: 'link', tag: 'a' }),
    el('el_2', 'Star', 'UpNext Public'),
    el('el_3', 'Star', 'other Public'),
  ];
  const ranked = UIGroundingService.rankElements('UpNext', elements);
  assert.equal(ranked[0].element.id, 'el_1');
});

test('L2: elements without context score exactly as before (no regression for ordinary pages)', () => {
  const plain = [
    { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search products', visible: true, enabled: true },
    { id: 'el_2', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true },
    { id: 'el_3', role: 'link', tag: 'a', text: 'Contact Us', visible: true, enabled: true },
  ];
  const withEmptyContext = plain.map((e) => ({ ...e, context: '' }));
  const a = UIGroundingService.rankElements('Search products', plain).map((r) => [r.element.id, r.score]);
  const b = UIGroundingService.rankElements('Search products', withEmptyContext).map((r) => [r.element.id, r.score]);
  assert.deepEqual(a, b);
  assert.equal(a[0][0], 'el_1');
  assert.ok(a[0][1] >= 0.70);
});

test('L2: context alone never scores an element with no own label', () => {
  const elements = [{ id: 'el_1', role: 'button', tag: 'button', text: '', context: 'UpNext', visible: true, enabled: true }];
  assert.equal(UIGroundingService.rankElements('UpNext', elements).length, 0);
});

test('L2: a goal word found only in row context is not reported as unmatched', () => {
  const elements = [el('el_1', 'Repository settings', 'UpNext Public')];
  const a = UIGroundingService.assessGrounding('UpNext repository settings', elements);
  assert.deepEqual(a.unmatchedIntentTokens, []);
});

// ── L1 unchanged; Qwen prompt ───────────────────────────────────────────────

test('L1 fast path ignores context entirely', () => {
  const router = new DecisionRouter();
  const elements = [el('el_1', 'Repository settings', 'UpNext'), el('el_2', 'Save', 'anything')];
  assert.equal(router._evalFastPath('something unrelated', elements), null);
  assert.equal(router._evalFastPath('Save', elements).element.id, 'el_2');
});
