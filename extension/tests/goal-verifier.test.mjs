// ScreenPilot v2 — GoalVerifier test suite (Phase 23C)
// Run: node extension/tests/goal-verifier.test.mjs
//
// Zero dependencies. GoalVerifier is pure/read-only, so we inject a tiny fake
// document + location via the `env` argument — no browser globals required.

import assert from 'assert/strict';
import { GoalVerifier } from '../services/goal-verifier.js';

// ── Fake DOM ──────────────────────────────────────────────────────────────────

function makeEl({ tag = 'DIV', text = '', ariaLabel = null, title = null, alt = null, href = null }) {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: (a) => ({ 'aria-label': ariaLabel, title, alt, href }[a] ?? null),
  };
}

// selector-aware fake document. We only need two buckets: elements carrying an
// accessible-name attribute, and elements carrying visible text.
function makeDoc({ bodyText = '', labelled = [], texted = [] } = {}) {
  return {
    body: { innerText: bodyText, textContent: bodyText },
    querySelectorAll: (sel) => (sel.includes('aria-label') ? labelled : texted),
  };
}

const loc = (href) => ({ href });

// ── Runner ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (err) { console.error(`  ✗  ${name}\n     ${err.message}`); fail++; }
}

console.log('\nGoalVerifier\n');

// ── url_matches / url_leaves ──────────────────────────────────────────────────

test('url_matches passes when href contains the pattern', () => {
  const c = { match: 'all', successSignals: [{ type: 'url_matches', urlPattern: '/test' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc(), loc: loc('https://github.com/u/test') });
  assert.equal(r.satisfied, true);
  assert.equal(r.matchedSignals, 1);
  assert.equal(r.verdict, 'satisfied');
});

test('url_matches fails when href lacks the pattern', () => {
  const c = { match: 'all', successSignals: [{ type: 'url_matches', urlPattern: '/test' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc(), loc: loc('https://github.com/new') });
  assert.equal(r.satisfied, false);
  assert.equal(r.verdict, 'unsatisfied');
});

test('url_leaves passes when href no longer contains the pattern', () => {
  const c = { match: 'all', successSignals: [{ type: 'url_leaves', urlPattern: '/settings/ssh/new' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc(), loc: loc('https://github.com/settings/keys') });
  assert.equal(r.satisfied, true);
});

// ── text_present ──────────────────────────────────────────────────────────────

test('text_present passes when visible body text contains the target', () => {
  const c = { match: 'all', successSignals: [{ type: 'text_present', text: 'SSH keys' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc({ bodyText: 'Authentication\nSSH keys\nAdd new' }), loc: loc('x') });
  assert.equal(r.satisfied, true);
});

test('text_present fails when text is absent', () => {
  const c = { match: 'all', successSignals: [{ type: 'text_present', text: 'SSH keys' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc({ bodyText: 'nothing here' }), loc: loc('x') });
  assert.equal(r.satisfied, false);
});

// ── element_present / element_absent ──────────────────────────────────────────

test('element_present matches an accessible label', () => {
  const doc = makeDoc({ labelled: [makeEl({ ariaLabel: 'test repository' })] });
  const c = { match: 'all', successSignals: [{ type: 'element_present', text: 'test' }] };
  assert.equal(GoalVerifier.evaluate(c, { doc, loc: loc('x') }).satisfied, true);
});

test('element_present matches visible element text', () => {
  const doc = makeDoc({ texted: [makeEl({ tag: 'h1', text: 'test' })] });
  const c = { match: 'all', successSignals: [{ type: 'element_present', text: 'test' }] };
  assert.equal(GoalVerifier.evaluate(c, { doc, loc: loc('x') }).satisfied, true);
});

test('element_absent passes when the label is gone', () => {
  const doc = makeDoc({ labelled: [], texted: [] });
  const c = { match: 'all', successSignals: [{ type: 'element_absent', text: 'Create repository' }] };
  assert.equal(GoalVerifier.evaluate(c, { doc, loc: loc('x') }).satisfied, true);
});

// ── match: all vs any ─────────────────────────────────────────────────────────

test('match=all requires every signal', () => {
  const doc = makeDoc({ bodyText: 'SSH keys' });
  const c = { match: 'all', successSignals: [
    { type: 'url_matches', urlPattern: '/settings/keys' },  // fails on /new
    { type: 'text_present', text: 'SSH keys' },             // passes
  ] };
  const r = GoalVerifier.evaluate(c, { doc, loc: loc('https://github.com/settings/ssh/new') });
  assert.equal(r.matchedSignals, 1);
  assert.equal(r.totalSignals, 2);
  assert.equal(r.satisfied, false);
});

test('match=any passes when at least one signal passes', () => {
  const doc = makeDoc({ bodyText: 'SSH keys' });
  const c = { match: 'any', successSignals: [
    { type: 'url_matches', urlPattern: '/settings/keys' },  // fails
    { type: 'text_present', text: 'SSH keys' },             // passes
  ] };
  assert.equal(GoalVerifier.evaluate(c, { doc, loc: loc('https://github.com/settings/ssh/new') }).satisfied, true);
});

test('match=all satisfied when both pass (post-action repo page)', () => {
  const doc = makeDoc({ labelled: [makeEl({ ariaLabel: 'test' })] });
  const c = { match: 'all', successSignals: [
    { type: 'url_matches', urlPattern: '/test' },
    { type: 'element_present', text: 'test' },
  ] };
  assert.equal(GoalVerifier.evaluate(c, { doc, loc: loc('https://github.com/u/test') }).satisfied, true);
});

// ── unknown verdict ───────────────────────────────────────────────────────────

test('no signals → verdict unknown, satisfied false', () => {
  const r = GoalVerifier.evaluate({ match: 'all', successSignals: [] }, { doc: makeDoc(), loc: loc('x') });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.satisfied, false);
  assert.equal(r.totalSignals, 0);
});

test('missing criteria → verdict unknown', () => {
  const r = GoalVerifier.evaluate(undefined, { doc: makeDoc(), loc: loc('x') });
  assert.equal(r.verdict, 'unknown');
});

test('unsupported signal type contributes to unknown (all match, none passed)', () => {
  const c = { match: 'all', successSignals: [{ type: 'dom_mutation', text: 'x' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc(), loc: loc('x') });
  assert.equal(r.matchedSignals, 0);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.details[0].passed, null);
});

// ── Phase 26: shouldComplete gate ─────────────────────────────────────────────

const repoCriteria = (over = {}) => ({
  goalType: 'action', match: 'all', verificationStrategy: 'local_signals', requiresEffect: true,
  successSignals: [
    { type: 'url_matches', urlPattern: '/test' },
    { type: 'element_present', text: 'test' },
  ],
  ...over,
});
const postEffectEnv = () => ({
  doc: makeDoc({ labelled: [makeEl({ ariaLabel: 'test' })] }),
  loc: loc('https://github.com/u/test'),
});

test('shouldComplete: satisfied requiresEffect criteria → complete', () => {
  const g = GoalVerifier.shouldComplete(repoCriteria(), postEffectEnv());
  assert.equal(g.complete, true);
  assert.equal(g.reason, 'signals_satisfied');
  assert.equal(g.verdict.matchedSignals, 2);
});

test('shouldComplete: unsatisfied signals → not complete', () => {
  const g = GoalVerifier.shouldComplete(repoCriteria(), { doc: makeDoc(), loc: loc('https://github.com/new') });
  assert.equal(g.complete, false);
  assert.equal(g.reason, 'unsatisfied');
});

test('shouldComplete: requiresEffect false → never verifier-completes (legacy path)', () => {
  const g = GoalVerifier.shouldComplete(repoCriteria({ requiresEffect: false }), postEffectEnv());
  assert.equal(g.complete, false);
  assert.equal(g.reason, 'no_effect_contract');
});

test('shouldComplete: missing criteria → not complete', () => {
  assert.equal(GoalVerifier.shouldComplete(null).complete, false);
  assert.equal(GoalVerifier.shouldComplete(undefined).reason, 'no_criteria');
});

test('shouldComplete: confidenceThreshold blocks a weak any-match', () => {
  const c = repoCriteria({
    match: 'any', confidenceThreshold: 0.75,
    successSignals: [
      { type: 'url_matches', urlPattern: '/test' },       // passes
      { type: 'element_present', text: 'nope-a' },        // fails
      { type: 'element_present', text: 'nope-b' },        // fails
    ],
  });
  const g = GoalVerifier.shouldComplete(c, { doc: makeDoc(), loc: loc('https://github.com/u/test') });
  assert.equal(g.complete, false, '1/3 matched is below the 0.75 threshold');
  assert.equal(g.reason, 'below_confidence_threshold');
});

test('shouldComplete: never throws on malformed criteria', () => {
  const g = GoalVerifier.shouldComplete({ requiresEffect: true, successSignals: 'not-an-array' }, postEffectEnv());
  assert.equal(g.complete, false);
});

test('read-only: evaluate returns the required shape', () => {
  const c = { match: 'all', successSignals: [{ type: 'url_matches', urlPattern: '/x' }] };
  const r = GoalVerifier.evaluate(c, { doc: makeDoc(), loc: loc('/x') });
  assert.deepEqual(Object.keys(r).sort(), ['details', 'matchedSignals', 'satisfied', 'totalSignals', 'verdict']);
  assert.ok(Array.isArray(r.details));
});

// ── isGoalSatisfied: multi-word token-overlap + toggle-state signals ──────────
// Not exercised by any test above (all of those drive evaluate()/shouldComplete()
// via explicit successSignals) — this is genuinely new coverage for the generic
// completion heuristic that's the ONLY completion signal available to the local
// (non-cloud) planning pipeline.

// A fuller fake document: separates active-nav / heading / toggle buckets by
// selector, unlike the crude two-bucket `makeDoc` above (which only distinguishes
// "has aria-label in the selector" from everything else — not enough once
// isGoalSatisfied queries three additional, more specific selector groups).
function makeFullDoc({ bodyText = '', activeNav = [], headings = [], toggles = [], interactive = [] } = {}) {
  return {
    body: { innerText: bodyText, textContent: bodyText },
    title: '',
    getElementById: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('aria-checked') || sel.includes('input:checked')) return toggles;
      if (sel.includes('heading')) return headings;
      if (sel.includes('aria-current')) return activeNav;
      // hasAvailableInteractiveCounterpart's INTERACTIVE_CONTROL_SELECTOR —
      // 'a[href],button,[role="button"],[tabindex="0"]' — is the only
      // selector string in this file containing '[tabindex="0"]'.
      if (sel.includes('[tabindex="0"]')) return interactive;
      return [];
    },
  };
}

test('isGoalSatisfied: multi-word target matches a heading missing the generic qualifier word', () => {
  // The motivating case: goal "Find notification preferences" strips to target
  // object "notification preferences", but the real page heading is just
  // "Notifications" — a flat whole-phrase check can never match this. URL is
  // deliberately unrelated so this isolates the heading-overlap path (the URL
  // token-overlap check runs first and would otherwise also satisfy it).
  const doc = makeFullDoc({ headings: [makeEl({ tag: 'h1', text: 'Notifications' })] });
  const r = GoalVerifier.isGoalSatisfied('Find notification preferences', null, { doc, loc: loc('https://example.com/account') });
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, 'heading_token_overlap_match');
});

test('isGoalSatisfied: multi-word target rejects an unrelated heading sharing only the qualifier word', () => {
  // Guards against the naive "any token overlaps" version of this fix: "Billing
  // preferences" shares "preferences" with the goal but is not the same target —
  // the specific content word ("notification") must actually be present.
  const doc = makeFullDoc({ headings: [makeEl({ tag: 'h1', text: 'Billing preferences' })] });
  const r = GoalVerifier.isGoalSatisfied('Find notification preferences', null, { doc, loc: loc('https://example.com/billing') });
  assert.equal(r.satisfied, false);
});

test('isGoalSatisfied: multi-word target matches via URL token overlap when neither heading nor exact URL match', () => {
  const doc = makeFullDoc();
  const r = GoalVerifier.isGoalSatisfied('open notification settings', null, { doc, loc: loc('https://example.com/account/notifications') });
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, 'url_token_overlap_match');
});

test('isGoalSatisfied: toggle-state signal matches a checked control with a matching accessible name', () => {
  const toggle = makeEl({ tag: 'button', ariaLabel: 'Two-factor authentication' });
  toggle.getAttribute = (a) => ({ 'aria-checked': 'true', 'aria-label': 'Two-factor authentication' }[a] ?? null);
  const doc = makeFullDoc({ toggles: [toggle] });
  const r = GoalVerifier.isGoalSatisfied('enable two-factor authentication', null, { doc, loc: loc('https://example.com/settings/security') });
  assert.equal(r.satisfied, true);
  assert.equal(r.reason, 'toggle_state_matches_target');
});

test('isGoalSatisfied: toggle-state signal does not fire for an unrelated checked control', () => {
  const toggle = makeEl({ tag: 'input' });
  toggle.getAttribute = (a) => ({ 'aria-checked': 'true', 'aria-label': 'Email me about pull requests' }[a] ?? null);
  const doc = makeFullDoc({ toggles: [toggle] });
  const r = GoalVerifier.isGoalSatisfied('enable two-factor authentication', null, { doc, loc: loc('https://example.com/settings/security') });
  assert.equal(r.satisfied, false);
});

// Real-Chrome finding (vscode.dev, goal "Open Folder"): the toggle-state
// signal used to also query [aria-expanded="true"] — a disclosure-widget/
// accordion VISIBILITY state, not a settings/goal-achievement state like
// aria-checked or aria-pressed. VS Code's Explorer sidebar has a collapsible
// section header (`aria-expanded="true" aria-label="No Folder Opened
// Section"`) that is simply visually expanded, ordinary UI chrome — whose
// label happens to contain "folder" — so the goal was declared complete
// before any folder was ever opened, with the matched text literally saying
// the opposite ("No Folder Opened").
test('isGoalSatisfied: toggle-state signal no longer queries aria-expanded (disclosure-widget state, not a goal-achievement state)', () => {
  let capturedSelector = null;
  const doc = {
    body: { innerText: '', textContent: '' },
    title: '',
    getElementById: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('aria-checked') || sel.includes('input:checked')) { capturedSelector = sel; return []; }
      return [];
    },
  };
  GoalVerifier.isGoalSatisfied('Open Folder', null, { doc, loc: loc('https://vscode.dev/') });
  assert.ok(capturedSelector, 'the toggle-state query must still run');
  assert.ok(!capturedSelector.includes('aria-expanded'), `toggle-state selector must not include aria-expanded, got "${capturedSelector}"`);
});

test('isGoalSatisfied: single-word target still requires a real (non-qualifier-fallback) match', () => {
  const doc = makeFullDoc({ headings: [makeEl({ tag: 'h1', text: 'Billing' })] });
  const r = GoalVerifier.isGoalSatisfied('open issues', null, { doc, loc: loc('https://example.com/billing') });
  assert.equal(r.satisfied, false);
});

// Real-Chrome-runtime finding: a page can hold a heading/label matching the
// goal text that is NOT currently shown (a hidden tab panel, an inactive
// accordion section, a success banner not yet revealed — all common in real
// SPAs, e.g. GitHub settings pages keep multiple tab panels in the DOM at
// once). Before this fix, isGoalSatisfied treated that hidden node's text as
// proof the goal was already done, so the extension could report success
// without ever taking the action the user asked for. offsetParent === null +
// a zero-size bounding rect is how a `hidden`/`display:none` element reports
// itself in a real document.
function makeHiddenEl({ tag = 'DIV', text = '' }) {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: () => null,
    offsetParent: null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
}

test('isGoalSatisfied: a hidden heading matching the target does NOT satisfy the goal', () => {
  const doc = makeFullDoc({ headings: [makeHiddenEl({ tag: 'h2', text: 'Login Complete' })] });
  const r = GoalVerifier.isGoalSatisfied('Login', null, { doc, loc: loc('https://example.com/dashboard') });
  assert.equal(r.satisfied, false);
});

// Real-Chrome finding (vscode.dev, goal "Get started"): `.active` is a
// generic CSS class matched by the active-nav signal that also lands on
// large structural containers, not just real nav-item elements — VS Code's
// main `.editor-group-container.active` matched with textContent being the
// ENTIRE active editor pane's rendered text (menu commands, shortcuts,
// breadcrumbs, walkthrough content all concatenated — thousands of
// characters), which happened to contain "get started" as a substring,
// declaring the goal complete before any click. Same "huge unrelated
// container wins a bare substring match" class of bug already fixed for
// DOMMatcher's own contains-match scoring (lib/dom-matcher.js).
test('isGoalSatisfied: active-nav signal ignores a giant container matching only by substring, even when marked .active', () => {
  const giantContainerText = 'Show All Commands Ctrl+Shift+P '.repeat(20) + 'Get Started with VS Code for the Web '.repeat(1) + 'more unrelated editor chrome text '.repeat(20);
  const giantActiveContainer = makeEl({ tag: 'div', text: giantContainerText });
  const doc = makeFullDoc({ activeNav: [giantActiveContainer] });
  const r = GoalVerifier.isGoalSatisfied('Get started', null, { doc, loc: loc('https://vscode.dev/') });
  assert.equal(r.satisfied, false, 'a giant .active container must not satisfy the goal via a buried substring match');
});

test('isGoalSatisfied: active-nav signal still matches a real, short active tab/nav label exactly', () => {
  const realTab = makeEl({ tag: 'a', text: 'Get started' });
  const doc = makeFullDoc({ activeNav: [realTab] });
  const r = GoalVerifier.isGoalSatisfied('Get started', null, { doc, loc: loc('https://example.com/') });
  assert.equal(r.satisfied, true, 'a short, real active nav label must still satisfy the goal');
  assert.equal(r.reason, 'active_nav_matches_target_object');
});

// ── Approach A: heading/active-nav text inside a genuinely interactive,
// not-yet-clicked control must NOT count as completion evidence ───────────
//
// makeEl() has no closest() at all (defaults to "not interactive" per
// hasInteractiveAncestor's own degrade-safe convention, already covered by
// every test above this block). These four tests need a controllable
// closest() to simulate real DOM ancestry, so they use a small local
// element factory instead of extending the shared makeEl/makeFullDoc used by
// dozens of unrelated tests.
function makeElWithAncestry({ tag = 'H2', text = '', closestClickableSelector = null } = {}) {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: () => null,
    closest: (sel) => {
      // Real elements match `.closest(sel)` when ANY part of the passed
      // selector list matches an ancestor (or itself). closestClickableSelector
      // simulates "this element has a real clickable ancestor matched by sel".
      if (closestClickableSelector && sel.includes(closestClickableSelector)) return {};
      return null;
    },
  };
}

test('isGoalSatisfied: vscode.dev-style heading inside a real <button> must NOT report completion', () => {
  // Mirrors the actual real-Chrome DOM: <h3>Get Started with VS Code for the
  // Web</h3> nested inside <button class="getting-started-category">.
  const heading = makeElWithAncestry({ tag: 'h3', text: 'Get Started with VS Code for the Web', closestClickableSelector: 'button' });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('Get started', null, { doc, loc: loc('https://vscode.dev/') });
  assert.equal(r.satisfied, false, 'a heading that is really a button label must not satisfy the goal');
});

test('isGoalSatisfied: Wikipedia-style standalone section heading must still report completion', () => {
  // Real DOM: <h2>History</h2> is plain article content, not inside any link/button.
  const heading = makeElWithAncestry({ tag: 'h2', text: 'History', closestClickableSelector: null });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('History', null, { doc, loc: loc('https://en.wikipedia.org/wiki/Web_browser') });
  assert.equal(r.satisfied, true, 'a standalone, non-interactive heading must still satisfy the goal');
  assert.equal(r.reason, 'heading_matches_target_object');
});

// Real-Chrome finding (youtube.com, goal "Search"): the placeholder heading
// "Try searching to get started" — YouTube's own empty-state message, shown
// precisely when nothing has been searched yet — satisfied the goal purely
// because "search" is a textual prefix of "searching". Distinct from both
// prior fixes: not a giant container, and not wrapped by a clickable
// ancestor — a pure word-boundary issue in the substring check itself.
test('isGoalSatisfied: a target word that is only a PREFIX of a longer word in the heading must NOT satisfy the goal', () => {
  const heading = makeElWithAncestry({ tag: 'h2', text: 'Try searching to get started', closestClickableSelector: null });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('Search', null, { doc, loc: loc('https://www.youtube.com/') });
  assert.equal(r.satisfied, false, '"search" must not match as a substring of "searching"');
});

test('isGoalSatisfied: a target word that IS a real standalone word in the heading still satisfies the goal', () => {
  const heading = makeElWithAncestry({ tag: 'h1', text: 'Search results', closestClickableSelector: null });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('Search', null, { doc, loc: loc('https://example.com/results') });
  assert.equal(r.satisfied, true, 'a genuine whole-word match must still satisfy the goal');
  assert.equal(r.reason, 'heading_matches_target_object');
});

// Real-Chrome finding (news.ycombinator.com, goal "new"): the URL signal's
// old check (`normUrl.includes('/' + targetObject)`) matched because the
// hostname "news.ycombinator.com" contains "/new" as a substring (the "//"
// of "https://" plus "new" from "news") — declaring the goal satisfied on
// the plain homepage, unrelated to any actual "new stories" page.
test('isGoalSatisfied: a target word that is only a PREFIX of a longer URL segment/hostname must NOT satisfy the goal', () => {
  const doc = makeFullDoc();
  const r = GoalVerifier.isGoalSatisfied('new', null, { doc, loc: loc('https://news.ycombinator.com/') });
  assert.equal(r.satisfied, false, '"new" must not match as a substring of the "news" hostname');
});

test('isGoalSatisfied: a genuine URL path segment still satisfies the goal (no regression)', () => {
  const doc = makeFullDoc();
  const r = GoalVerifier.isGoalSatisfied('Open Issues', null, { doc, loc: loc('https://github.com/microsoft/vscode/issues') });
  assert.equal(r.satisfied, true, 'a real "/issues" path segment must still satisfy the goal');
  assert.equal(r.reason, 'url_matches_target_object');
});

test('isGoalSatisfied: a genuine URL path segment followed by more path/query still satisfies the goal', () => {
  const doc = makeFullDoc();
  const r = GoalVerifier.isGoalSatisfied('Go to Settings', null, { doc, loc: loc('https://example.com/settings?tab=general') });
  assert.equal(r.satisfied, true, '"/settings?..." must still satisfy the goal');
});

test('isGoalSatisfied: a URL segment that is a longer word starting with the target must NOT satisfy the goal', () => {
  const doc = makeFullDoc();
  const r = GoalVerifier.isGoalSatisfied('Go to Settings', null, { doc, loc: loc('https://example.com/settings2/legacy') });
  assert.equal(r.satisfied, false, '"/settings2" must not satisfy a goal targeting "settings"');
});

test('isGoalSatisfied: GitHub-style navigation-completion heading (no interactive wrapper at all) must report completion', () => {
  // Real DOM: after navigating to a repo's Issues page, the page heading is
  // plain content — the destination page's own title, not a label on some
  // still-unclicked control. Distinct from the tabindex="-1" case below,
  // which specifically exercises the "don't false-negative on an unrelated
  // focus-management attribute" edge case; this one is the plain, common
  // real-navigation-completion shape with no special wrapper at all.
  // URL deliberately does NOT contain "issues" — isolates the heading signal
  // from the (separately-tested, also-legitimate) URL-match signal, which
  // would otherwise short-circuit before the heading check ever runs.
  const heading = makeElWithAncestry({ tag: 'h1', text: 'Issues', closestClickableSelector: null });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('Open Issues', null, { doc, loc: loc('https://github.com/microsoft/vscode') });
  assert.equal(r.satisfied, true, 'a plain post-navigation heading must satisfy the goal');
  assert.equal(r.reason, 'heading_matches_target_object');
});

test('isGoalSatisfied: GitHub-style heading inside a tabindex="-1" layout wrapper must still report completion', () => {
  // Real DOM: GitHub's "All issues" heading sits inside a
  // <div tabindex="-1" class="SidebarPageLayout-module__HeaderInner..."> —
  // a programmatic-focus-only layout container, not a clickable control.
  // closest('a[href],button,[role="button"],[tabindex="0"]') must NOT match
  // it, since the selector never includes bare [tabindex].
  const heading = makeElWithAncestry({ tag: 'h1', text: 'All issues', closestClickableSelector: null });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('All issues', null, { doc, loc: loc('https://github.com/microsoft/vscode/issues') });
  assert.equal(r.satisfied, true, 'a heading inside a tabindex="-1" wrapper must still satisfy the goal (not a false negative)');
});

test('isGoalSatisfied: a heading inside a tabindex="0" interactive element must NOT report completion', () => {
  const heading = makeElWithAncestry({ tag: 'h3', text: 'Enable notifications', closestClickableSelector: '[tabindex="0"]' });
  const doc = makeFullDoc({ headings: [heading] });
  const r = GoalVerifier.isGoalSatisfied('Enable notifications', null, { doc, loc: loc('https://example.com/settings') });
  assert.equal(r.satisfied, false, 'a heading inside a real tabindex="0" interactive element must not satisfy the goal');
});

test('isGoalSatisfied: a hidden toggle matching the target does NOT satisfy the goal', () => {
  const toggle = makeHiddenEl({ tag: 'input' });
  toggle.getAttribute = (a) => ({ 'aria-checked': 'true', 'aria-label': 'Two-factor authentication' }[a] ?? null);
  const doc = makeFullDoc({ toggles: [toggle] });
  const r = GoalVerifier.isGoalSatisfied('enable two-factor authentication', null, { doc, loc: loc('https://example.com/settings/security') });
  assert.equal(r.satisfied, false);
});

// ── Heading vs. available CTA: a heading describing an action must not be
// mistaken for the action having been performed ──────────────────────────
//
// Real-Chrome findings (squarespace.com, goal "Get started"; notion.com/
// product/calendar, goal "Get Notion Calendar for free"): Approach A (above)
// catches a heading that IS a control's own label (nested inside it). It
// does NOT catch a heading that sits BESIDE a real, unclicked CTA control
// with matching text — a marketing headline describing the same action a
// sibling button performs. hasAvailableInteractiveCounterpart closes that
// gap generically: no CTA keyword list, just "does a real, available,
// non-fragment interactive control elsewhere on the page also match?"

test('isGoalSatisfied: a marketing heading (token-overlap match) does NOT satisfy an action goal when a real CTA is still available', () => {
  // Mirrors squarespace.com: heading "Getting started has never been easier
  // with AI" only overlaps target "get started" via shared tokens (not a
  // whole-phrase match) — and a real, unclicked "GET STARTED" link sits
  // elsewhere on the same page.
  const heading = makeEl({ tag: 'h2', text: 'Getting started has never been easier with AI' });
  const cta = makeEl({ tag: 'a', text: 'GET STARTED', href: '/signup' });
  const doc = makeFullDoc({ headings: [heading], interactive: [cta] });
  const r = GoalVerifier.isGoalSatisfied('Get started', null, { doc, loc: loc('https://example.com/') });
  assert.equal(r.satisfied, false,
    'a marketing heading merely describing the action must not satisfy the goal while its own CTA is still unclicked');
});

test('isGoalSatisfied: a literal matching heading does NOT cause false completion while the real action is still available', () => {
  // Mirrors notion.com/product/calendar: the page's own hero headline reads
  // almost identically to its CTA button ("Get Notion Calendar free"),
  // triggering the WHOLE-PHRASE heading path, not the token-overlap one.
  const heading = makeEl({ tag: 'h1', text: 'Get Notion Calendar free. Never miss a beat.' });
  const cta = makeEl({ tag: 'button', text: 'Get Notion Calendar free' });
  const doc = makeFullDoc({ headings: [heading], interactive: [cta] });
  const r = GoalVerifier.isGoalSatisfied('Get Notion Calendar for free', null, { doc, loc: loc('https://example.com/') });
  assert.equal(r.satisfied, false,
    'a literal-matching heading must not report completion while its own real CTA button is still unclicked');
});

test('isGoalSatisfied: a heading genuinely representing the reached state still satisfies the goal, even with a same-page TOC anchor present', () => {
  // Mirrors Wikipedia exactly: a real <h2 id="History">History</h2> section
  // heading, plus the article's own table-of-contents entry
  // <a href="#History">History</a> pointing at that very section. The TOC
  // link must NOT count as "an available unclicked action" — it only
  // scrolls to content that's already there.
  const heading = makeEl({ tag: 'h2', text: 'History' });
  const tocLink = makeEl({ tag: 'a', text: 'History', href: '#History' });
  const doc = makeFullDoc({ headings: [heading], interactive: [tocLink] });
  const r = GoalVerifier.isGoalSatisfied('History', null, { doc, loc: loc('https://en.wikipedia.org/wiki/Web_browser') });
  assert.equal(r.satisfied, true,
    'a genuine content-section heading must still satisfy the goal; a same-page TOC anchor is not a counterpart CTA');
  assert.equal(r.reason, 'heading_matches_target_object');
});

test('isGoalSatisfied: an unrelated interactive control elsewhere does not block a legitimate heading match', () => {
  // The counterpart check must be TARGETED — an interactive control that
  // simply doesn't match the target must not suppress a normal, single-
  // heading already-satisfied case (guards against an overly broad version
  // of this fix that treats "any button exists anywhere" as disqualifying).
  const heading = makeEl({ tag: 'h1', text: 'Search results' });
  const unrelated = makeEl({ tag: 'button', text: 'Sign in', href: null });
  const doc = makeFullDoc({ headings: [heading], interactive: [unrelated] });
  const r = GoalVerifier.isGoalSatisfied('Search', null, { doc, loc: loc('https://example.com/results') });
  assert.equal(r.satisfied, true, 'an unrelated interactive control must not suppress a genuine heading match');
  assert.equal(r.reason, 'heading_matches_target_object');
});

test('isGoalSatisfied: a structurally FAR exact-text-matching link does NOT suppress a genuine heading match', () => {
  // Real-Chrome finding (en.wikipedia.org, goal "History"): the article's
  // own "See also" list contains a real, visible <a href="...History_of_
  // the_web_browser">History</a> — exact text match, but a completely
  // different article, many DOM levels away from the actual <h2
  // id="History"> section heading. A common ancestor DOES exist (both are
  // on the same page) but only far up the tree — not within the small
  // "same visual block" hop budget a real CTA/heading pairing always is.
  const heading = makeEl({ tag: 'h2', text: 'History' });
  const seeAlsoLink = makeEl({ tag: 'a', text: 'History', href: 'https://en.wikipedia.org/wiki/History_of_the_web_browser' });
  // Simulate "far": containment is only true many hops up, past the check's budget.
  let hopCount = 0;
  seeAlsoLink.parentElement = {
    contains: () => { hopCount++; return false; },
    get parentElement() {
      return hopCount < 20
        ? { contains: () => { hopCount++; return false; }, parentElement: seeAlsoLink.parentElement }
        : null;
    },
  };
  const doc = makeFullDoc({ headings: [heading], interactive: [seeAlsoLink] });
  const r = GoalVerifier.isGoalSatisfied('History', null, { doc, loc: loc('https://en.wikipedia.org/wiki/Web_browser') });
  assert.equal(r.satisfied, true,
    'a same-text link many DOM levels away (a "See also" entry to a different article) must not suppress a real section heading');
});

test('isGoalSatisfied: a short token that is merely a coincidental substring of a longer word does NOT count as a match', () => {
  // Real-Chrome finding (en.wikipedia.org, goal "History"): a real, nearby
  // <a>Tor</a> link (linking to "Tor Browser") was briefly treated as
  // "covering" target token "history" purely because "tor" is a
  // coincidental substring of "hisTORy" — an unrelated 3-letter token
  // matching almost any longer word that happens to contain those letters.
  const heading = makeEl({ tag: 'h2', text: 'History' });
  const torLink = makeEl({ tag: 'a', text: 'Tor', href: 'https://en.wikipedia.org/wiki/Tor_Browser' });
  torLink.parentElement = { contains: () => true }; // deliberately "near" — isolates the token-length guard specifically
  const doc = makeFullDoc({ headings: [heading], interactive: [torLink] });
  const r = GoalVerifier.isGoalSatisfied('History', null, { doc, loc: loc('https://en.wikipedia.org/wiki/Web_browser') });
  assert.equal(r.satisfied, true,
    'a short, coincidentally-substring-matching token ("tor" inside "history") must not be treated as the same target');
});

test('isGoalSatisfied: a counterpart control introducing extra unrelated content does NOT suppress a genuine heading match', () => {
  // Guards the bidirectional design specifically: a real "New pull request"
  // button one-directionally covers target "pull requests" (shares "pull"
  // and "requests"~"request"), but introduces an extra concept ("new") the
  // target never mentioned — it is a DIFFERENT control, not a CTA
  // counterpart for the goal, and must not block a real, already-reached
  // Pull Requests page's own heading from confirming the goal.
  const heading = makeEl({ tag: 'h1', text: 'Pull requests' });
  const newPrButton = makeEl({ tag: 'a', text: 'New pull request', href: '/compare' });
  const doc = makeFullDoc({ headings: [heading], interactive: [newPrButton] });
  const r = GoalVerifier.isGoalSatisfied('Open Pull requests', null, { doc, loc: loc('https://github.com/org/repo/pulls') });
  assert.equal(r.satisfied, true,
    'a "New pull request" button must not be mistaken for an unclicked counterpart of the "pull requests" goal');
  assert.equal(r.reason, 'heading_matches_target_object');
});

test('isGoalSatisfied: toggle-state signal still reports completion when the toggle genuinely reflects the requested state', () => {
  // Direct re-confirmation (not just an unaffected-by-omission check) that
  // this fix, scoped entirely to the heading loop, leaves a clean,
  // unambiguous toggle-state match untouched.
  const toggle = makeEl({ tag: 'button', ariaLabel: 'Two-factor authentication' });
  toggle.getAttribute = (a) => ({ 'aria-checked': 'true', 'aria-label': 'Two-factor authentication' }[a] ?? null);
  const doc = makeFullDoc({ toggles: [toggle] });
  const r = GoalVerifier.isGoalSatisfied('enable two-factor authentication', null, { doc, loc: loc('https://example.com/settings/security') });
  assert.equal(r.satisfied, true, 'a toggle genuinely in the requested state must still satisfy the goal');
  assert.equal(r.reason, 'toggle_state_matches_target');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
