// ScreenPilot v2 — GoalVerifier test suite (Phase 23C)
// Run: node extension/tests/goal-verifier.test.mjs
//
// Zero dependencies. GoalVerifier is pure/read-only, so we inject a tiny fake
// document + location via the `env` argument — no browser globals required.

import assert from 'assert/strict';
import { GoalVerifier } from '../services/goal-verifier.js';

// ── Fake DOM ──────────────────────────────────────────────────────────────────

function makeEl({ tag = 'DIV', text = '', ariaLabel = null, title = null, alt = null }) {
  return {
    tagName: tag.toUpperCase(),
    textContent: text,
    getAttribute: (a) => ({ 'aria-label': ariaLabel, title, alt }[a] ?? null),
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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
