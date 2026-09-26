// Phase 6 — integrating the privacy / compact-state work into the V3 planner.
//
// V3's own behavior (candidate ranking, one-local-provider-per-cycle routing,
// target/value separation) is covered by decision-router*.test.mjs and
// local-qwen.test.mjs. This file covers only what Phase 6 adds on top:
//   • Qwen answers are VALIDATED (elementId, confidence, action) and an
//     unusable answer follows the existing fallback — straight to Cloud;
//   • a sensitive target never carries a value;
//   • both local model adapters sit behind SanitizingAdapter (goal, URL, title
//     and elements are scrubbed before any provider payload is built);
//   • toCompactElement() is the prompt-boundary projection in both adapters;
//   • nothing here made ScreenPilot act on the page, and no key is in source.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DecisionRouter, QWEN_MIN_CONFIDENCE, QWEN_CANDIDATE_LIMIT } from '../services/decision-router.js';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { LocalVisionAdapter } from '../providers/local-vision-adapter.js';
import { SanitizingAdapter } from '../providers/sanitizing-adapter.js';
import { TokenVault } from '../lib/pii-vault.js';
import { toCompactElement, toCompactPageState } from '../lib/compact-page-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(__dirname, '..');

const el = (id, text, extra = {}) => ({ id, role: 'link', tag: 'a', text, visible: true, enabled: true, ...extra });

// A goal L1/L2 cannot settle on their own, so the cycle reaches L3.
const GOAL = 'Update my billing address details';

function mockCloud() {
  const calls = [];
  return {
    calls,
    plan: async (req) => {
      calls.push(req);
      return { result: 'OK', state: 'planned', confidence: 0.8, plan: { steps: [{ targetElement: { text: 'Cloud Choice' } }] }, providerMetadata: { provider: 'cloud' } };
    }
  };
}

function qwenReturning(answer) {
  const seen = { requests: [] };
  return {
    seen,
    checkAvailability: async () => ({ available: true }),
    plan: async (req) => { seen.requests.push(req); return typeof answer === 'function' ? answer(req) : answer; }
  };
}

function plan(elementId, confidence = 0.9) {
  return {
    result: 'OK', state: 'planned', confidence,
    plan: { steps: [{ targetElement: { text: 'x', elementId } }] },
    providerMetadata: { provider: 'local-qwen' }
  };
}

function visionSpy() {
  const spy = { touched: false };
  spy.checkAvailability = async () => { spy.touched = true; return { available: true }; };
  spy.plan = async () => { spy.touched = true; return { result: 'OK', elementId: 'el_1', confidence: 0.9 }; };
  return spy;
}

const PAGE = {
  url: 'https://example.com', title: 'Account',
  elements: [el('el_1', 'Billing'), el('el_2', 'Update Profile Details')]
};

// ── ranked candidates reach Qwen ────────────────────────────────────────────

test('Qwen is offered the L2-ranked candidates: a relevant element at DOM position 35 leads the list, capped at QWEN_CANDIDATE_LIMIT', async () => {
  // Two equally good candidates (a genuine L2 tie, so the cycle reaches L3),
  // buried among 58 fillers; the first of them sits at DOM position 35.
  const elements = Array.from({ length: 60 }, (_, i) => el(`el_${i}`, `Language ${i}`));
  elements[35] = el('el_35', 'Update Billing Address');
  elements[50] = el('el_50', 'Update Billing Details');
  const qwen = qwenReturning(plan('el_35'));

  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwen, localVisionAdapter: visionSpy() });
  const result = await router.route(GOAL, { url: 'https://example.com', title: 't', elements });

  assert.equal(result.layer, 'local_qwen');
  const offered = qwen.seen.requests[0].elements;
  assert.ok(offered.length <= QWEN_CANDIDATE_LIMIT);
  assert.deepEqual(offered.slice(0, 2).map((e) => e.id), ['el_35', 'el_50'], 'the relevant elements must lead — a raw DOM-order slice would offer only Language 0..24');
  assert.ok(!offered.some((e) => e.id === 'el_59'), 'irrelevant filler is not offered');
});

test('the cap is applied AFTER ranking: 40 relevant candidates → Qwen gets exactly QWEN_CANDIDATE_LIMIT of them', async () => {
  const elements = Array.from({ length: 40 }, (_, i) => el(`el_${i}`, `Update Billing Address ${i}`));
  const qwen = qwenReturning(plan('el_0'));
  await new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwen, cloudAdapter: mockCloud() })
    .route(GOAL, { url: 'https://example.com', title: 't', elements });
  assert.equal(qwen.seen.requests[0].elements.length, QWEN_CANDIDATE_LIMIT);
});

// ── Qwen validation → existing fallback (Cloud), never the other local model ──

test('an unknown Qwen elementId is a local-provider failure: falls to Cloud, vision never touched, exactly one screenshot (Cloud\'s)', async () => {
  let shots = 0;
  const cloud = mockCloud();
  const vision = visionSpy();
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan('el_999')), localVisionAdapter: vision, cloudAdapter: cloud });

  const result = await router.route(GOAL, PAGE, { cloudContext: { getScreenshot: async () => { shots++; return { image: 'IMG', mimeType: 'image/jpeg' }; } } });

  assert.equal(result.layer, 'cloud');
  assert.equal(result.qwenFailureReason, 'invalid_element_id');
  assert.equal(cloud.calls.length, 1);
  assert.equal(vision.touched, false, 'one local provider per cycle — vision is not a second chance');
  assert.equal(shots, 1);
});

test('a Qwen plan naming an element that exists on the page but was NOT offered is also rejected', async () => {
  const elements = Array.from({ length: 40 }, (_, i) => el(`el_${i}`, `Language ${i}`));
  elements[0] = el('el_0', 'Update Billing Address');
  elements[1] = el('el_1', 'Update Billing Details');
  // Qwen is offered the top 25 by rank; el_39 is a plain filler outside them.
  const cloud = mockCloud();
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan('el_39')), cloudAdapter: cloud });
  const result = await router.route(GOAL, { url: 'https://example.com', title: 't', elements });

  assert.equal(result.layer, 'cloud');
  assert.equal(result.qwenFailureReason, 'invalid_element_id');
});

test('a Qwen plan with no elementId is rejected', async () => {
  const cloud = mockCloud();
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan(undefined)), cloudAdapter: cloud });
  const result = await router.route(GOAL, PAGE);
  assert.equal(result.layer, 'cloud');
  assert.equal(result.qwenFailureReason, 'invalid_element_id');
});

test('confidence below QWEN_MIN_CONFIDENCE is rejected; exactly at it is accepted', async () => {
  const low = await new DecisionRouter({
    executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan('el_1', QWEN_MIN_CONFIDENCE - 0.01)), cloudAdapter: mockCloud()
  }).route(GOAL, PAGE);
  assert.equal(low.layer, 'cloud');
  assert.equal(low.qwenFailureReason, 'low_confidence');

  const ok = await new DecisionRouter({
    executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan('el_1', QWEN_MIN_CONFIDENCE)), cloudAdapter: mockCloud()
  }).route(GOAL, PAGE);
  assert.equal(ok.layer, 'local_qwen');
});

test('a confident Qwen "finish" (no element) is accepted; a low-confidence one is not', async () => {
  const finish = (confidence) => ({ result: 'OK', state: 'complete', confidence, providerMetadata: { provider: 'local-qwen' } });
  const ok = await new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(finish(0.95)), cloudAdapter: mockCloud() }).route(GOAL, PAGE);
  assert.equal(ok.layer, 'local_qwen');
  const low = await new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(finish(0.2)), cloudAdapter: mockCloud() }).route(GOAL, PAGE);
  assert.equal(low.layer, 'cloud');
});

test('no unnecessary vision: a valid Qwen answer never touches vision or captures a screenshot', async () => {
  let shots = 0;
  const vision = visionSpy();
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwenReturning(plan('el_1')), localVisionAdapter: vision });
  const result = await router.route(GOAL, PAGE, { cloudContext: { getScreenshot: async () => { shots++; return { image: 'IMG' }; } } });

  assert.equal(result.layer, 'local_qwen');
  assert.equal(vision.touched, false);
  assert.equal(shots, 0);
});

test('cloud executionMode never contacts either local provider', async () => {
  const qwen = qwenReturning(plan('el_1'));
  const vision = visionSpy();
  const result = await new DecisionRouter({ localQwenAdapter: qwen, localVisionAdapter: vision, cloudAdapter: mockCloud() }).route(GOAL, PAGE);
  assert.equal(result.layer, 'cloud');
  assert.equal(qwen.seen.requests.length, 0);
  assert.equal(vision.touched, false);
});

// ── replan: every cycle validates against the CURRENT page ──────────────────

test('replan: an elementId valid on the previous cycle\'s page is rejected once the page changed, and the fresh ranking is used', async () => {
  const pageA = { url: 'https://example.com/a', title: 'A', elements: [el('el_1', 'Billing'), el('el_2', 'Update Profile Details')] };
  const pageB = { url: 'https://example.com/b', title: 'B', elements: [el('el_7', 'Update Billing Address'), el('el_8', 'Update Billing Details')] };
  const qwen = qwenReturning(plan('el_1'));
  const cloud = mockCloud();
  const router = new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwen, cloudAdapter: cloud });

  assert.equal((await router.route(GOAL, pageA)).layer, 'local_qwen');

  // Cycle 2 on the new page: Qwen (stale) repeats el_1, which no longer exists.
  const stale = await router.route(GOAL, pageB);
  assert.equal(stale.layer, 'cloud');
  assert.equal(stale.qwenFailureReason, 'invalid_element_id');
  assert.equal(qwen.seen.requests[1].elements[0].id, 'el_7', 'cycle 2 must rank the NEW page, not reuse cycle 1');

  // Cycle 3: Qwen answers with a real element of the current page.
  qwen.plan = async (req) => { qwen.seen.requests.push(req); return plan('el_7'); };
  assert.equal((await router.route(GOAL, pageB)).layer, 'local_qwen');
});

// ── LocalQwenAdapter: structured action, target vs value, sensitivity ───────

const qwenAdapter = new LocalQwenAdapter();
const fmt = (elements, out) => qwenAdapter._formatPlanResponse({ goal: 'g', elements }, out, 1);

test('click: target is the real element, value is empty', () => {
  const r = fmt([{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit' }], { action: 'click', elementId: 'el_1', value: null, confidence: 0.9 });
  const step = r.plan.steps[0];
  assert.equal(step.targetElement.elementId, 'el_1');
  assert.equal(step.targetElement.text, 'Submit');
  assert.equal(step.targetElement.value, '');
  assert.equal(step.phase, 'navigate');
});

test('click with a stray model-supplied value: the value is dropped', () => {
  const r = fmt([{ id: 'el_1', role: 'button', tag: 'button', text: 'Submit' }], { action: 'click', elementId: 'el_1', value: 'oops', confidence: 0.9 });
  assert.equal(r.plan.steps[0].targetElement.value, '');
});

test('fill: the element label and the user-provided value stay separate', () => {
  const r = fmt([{ id: 'el_3', role: 'textbox', tag: 'input', placeholder: 'Search', text: '' }], { action: 'fill', elementId: 'el_3', value: 'artificial intelligence', confidence: 0.92 });
  const step = r.plan.steps[0];
  assert.equal(step.targetElement.text, 'Search');
  assert.equal(step.targetElement.value, 'artificial intelligence');
  assert.equal(step.phase, 'fill_form');
  assert.equal(step.targetElement.type, 'input');
  assert.match(step.description, /artificial intelligence/);
});

test('legacy "type" verb is still accepted and behaves as "fill"', () => {
  const r = fmt([{ id: 'el_3', role: 'textbox', tag: 'input', placeholder: 'Search' }], { action: 'type', elementId: 'el_3', value: 'cats', confidence: 0.9 });
  assert.equal(r.plan.steps[0].phase, 'fill_form');
  assert.equal(r.plan.steps[0].targetElement.value, 'cats');
});

test('an invalid action is a Qwen failure (FAILED result, not a plan)', () => {
  const r = fmt([{ id: 'el_1', role: 'button', tag: 'button', text: 'Go' }], { action: 'delete_everything', elementId: 'el_1', confidence: 0.99 });
  assert.equal(r.result, 'FAILED');
  assert.equal(r.errorCode, 'INVALID_ACTION');
});

test('sensitive target: value is forced empty and the label is the static placeholder, never the field text', () => {
  const password = { id: 'el_9', role: 'textbox', tag: 'input', type: 'password', placeholder: 'Password', text: '[REDACTED]', value: '[REDACTED]' };
  const r = fmt([password], { action: 'fill', elementId: 'el_9', value: 'hunter2-secret', confidence: 0.95 });
  const step = r.plan.steps[0];
  assert.equal(step.targetElement.value, '');
  assert.equal(step.targetElement.text, 'Password');
  assert.ok(!JSON.stringify(r).includes('hunter2-secret'), 'a value proposed for a sensitive field must not survive anywhere in the plan');
});

test('sensitive targets of every irreversible kind get no value (card number field, via autocomplete)', () => {
  const card = { id: 'el_4', role: 'textbox', tag: 'input', autocomplete: 'cc-number', ariaLabel: 'Card number' };
  const r = fmt([card], { action: 'fill', elementId: 'el_4', value: '4111 1111 1111 1111', confidence: 0.9 });
  assert.equal(r.plan.steps[0].targetElement.value, '');
});

// ── compact element helper is the prompt-boundary projection ────────────────

test('toCompactElement: ordinary element → id/role/name/type; sensitive element → label only, flagged', () => {
  assert.deepEqual(
    toCompactElement({ id: 'el_1', role: 'button', tag: 'button', text: 'Buy now' }),
    { id: 'el_1', role: 'button', name: 'Buy now', type: 'button', sensitive: false, sensitiveType: null }
  );
  const c = toCompactElement({ id: 'el_2', role: 'textbox', tag: 'input', type: 'password', placeholder: 'Password', text: 'hunter2', value: 'hunter2' });
  assert.equal(c.sensitive, true);
  assert.equal(c.name, 'Password');
  assert.ok(!JSON.stringify(c).includes('hunter2'));
});

test('toCompactPageState reuses toCompactElement (one definition of "what a model is shown")', () => {
  const state = { url: 'u', title: 't', elements: [el('el_1', 'A'), el('el_2', 'B', { visible: false })] };
  assert.deepEqual(toCompactPageState(state).visibleInteractiveElements, [toCompactElement(state.elements[0])]);
});

test('the Qwen and vision prompts are built from toCompactElement: a sensitive field never leaks its text/value and is flagged for Qwen', () => {
  const leaky = { id: 'el_2', role: 'textbox', tag: 'input', type: 'password', placeholder: 'Password', text: 'hunter2-secret', value: 'hunter2-secret', bbox: { x: 1, y: 1, width: 5, height: 5 } };
  const qwenPrompt = new LocalQwenAdapter()._buildQwenPrompt({ goal: 'log in', page: { url: 'u', title: 't' }, elements: [el('el_1', 'Sign in'), leaky] });
  assert.ok(!qwenPrompt.includes('hunter2-secret'));
  assert.match(qwenPrompt, /"id":"el_2","role":"textbox","text":"Password","sensitive":true/);
  assert.match(qwenPrompt, /"id":"el_1","role":"link","text":"Sign in"\}/);

  const visionPrompt = new LocalVisionAdapter()._buildVisionPrompt({ goal: 'log in', page: { url: 'u', title: 't' }, elements: [leaky] });
  assert.ok(!visionPrompt.includes('hunter2-secret'));
  assert.match(visionPrompt, /"text":"Password"/);
});

test('the Qwen prompt asks for the structured schema: fill verb, value null, no overloaded "text" answer field', () => {
  const prompt = new LocalQwenAdapter()._buildQwenPrompt({ goal: 'g', page: {}, elements: [el('el_1', 'A')] });
  assert.match(prompt, /\{"action":"click"\|"fill"\|"select"\|"navigate"\|"finish","elementId":"el_1","value":null,"confidence":0\.95\}/);
  assert.ok(!/"text":"label"/.test(prompt));
});

// ── privacy: local providers sit behind SanitizingAdapter ───────────────────

const EMAIL = 'john.doe@example.com';
const PHONE = '+1 415 555 0134';
const CARD  = '4111 1111 1111 1111';
const OTHER_EMAIL = 'jane.roe@example.org';
// Two equally-scoring "Billing ..." controls (a genuine L2 tie) so the cycle
// reaches L3; both carry OTHER_EMAIL in their label so an offered element really contains PII.
const PII_GOAL = `Send the billing update to ${EMAIL} or call ${PHONE}, card ${CARD}`;
const PII_PAGE = {
  url: 'https://example.com', title: 't',
  elements: [
    { id: 'el_2', role: 'textbox', tag: 'input', placeholder: 'Billing recipient', visible: true, enabled: true },
    el('el_3', `Billing Contact Preferences ${OTHER_EMAIL}`),
    el('el_4', `Billing Notification Preferences ${OTHER_EMAIL}`)
  ]
};

function stubOllama(sent, respond) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ response: JSON.stringify(respond(JSON.parse(init.body))) }) };
  };
}

function wrappedRouter(vault = new TokenVault()) {
  return new DecisionRouter({
    executionMode: 'local-qwen',
    localQwenAdapter: new SanitizingAdapter(new LocalQwenAdapter(), { vault, onEvent: () => {} }),
    localVisionAdapter: new SanitizingAdapter(new LocalVisionAdapter(), { vault, onEvent: () => {} }),
    cloudAdapter: mockCloud()
  });
}

test('Qwen payload: goal, URL, title and element text are sanitized; a placeholder in the answer is restored locally', async () => {
  const sent = [];
  stubOllama(sent, () => ({ action: 'fill', elementId: 'el_2', value: '[EMAIL_1]', confidence: 0.9 }));
  const page = { ...PII_PAGE, url: 'https://example.com/billing?token=abc123secret&email=' + EMAIL, title: `Billing for ${EMAIL}` };

  const result = await wrappedRouter().route(PII_GOAL, page);
  assert.equal(result.layer, 'local_qwen');

  const wire = JSON.stringify(sent);
  for (const raw of [EMAIL, OTHER_EMAIL, PHONE, CARD, '4111', 'abc123secret']) {
    assert.ok(!wire.includes(raw), `raw value leaked into the Qwen provider payload: ${raw}`);
  }
  assert.match(wire, /\[EMAIL_1\]/, 'email must travel as a reversible placeholder');
  assert.match(wire, /\[REDACTED\]/, 'a card number is irreversibly redacted');

  // Restored for local display/matching only.
  assert.equal(result.planResponse.plan.steps[0].targetElement.value, EMAIL);
});

test('vision payload: goal, URL and title are sanitized; the (already-masked) screenshot passes through untouched', async () => {
  const sent = [];
  stubOllama(sent, () => ({ elementId: 'el_1', confidence: 0.9, reason: 'r' }));
  // One invisible element → L2 ranks nothing → the router picks vision.
  const page = {
    url: `https://example.com/?email=${EMAIL}`,
    title: `Inbox of ${EMAIL}`,
    elements: [el('el_1', 'Compose', { visible: false })]
  };

  const result = await wrappedRouter().route(`Open the message from ${EMAIL}`, page, {
    cloudContext: { getScreenshot: async () => ({ image: 'BASE64_MASKED_SCREENSHOT', mimeType: 'image/jpeg' }) }
  });

  assert.equal(result.layer, 'local_vision');
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes(EMAIL), 'raw email leaked into the vision provider payload');
  assert.match(wire, /\[EMAIL_1\]/);
  assert.deepEqual(sent[0].images, ['BASE64_MASKED_SCREENSHOT']);
});

test('one shared TokenVault backs the sanitizing wrappers: goal and element PII map to stable placeholders', async () => {
  const vault = new TokenVault();
  const sent = [];
  stubOllama(sent, () => ({ action: 'click', elementId: 'el_3', value: null, confidence: 0.9 }));
  const result = await wrappedRouter(vault).route(PII_GOAL, PII_PAGE);
  assert.equal(result.layer, 'local_qwen');
  // goal email + goal phone + the elements' email (one entry, deduplicated across both offered elements)
  assert.equal(vault.size, 3);
  const wire = JSON.stringify(sent);
  for (const token of ['[EMAIL_1]', '[EMAIL_2]', '[PHONE_1]']) assert.ok(wire.includes(token), `missing ${token}`);
});

test('DecisionRouter\'s own default adapters are SanitizingAdapter-wrapped', () => {
  const router = new DecisionRouter();
  for (const a of [router.localQwenAdapter, router.localVisionAdapter, router.cloudAdapter]) {
    assert.match(a.name, /^Sanitizing\(/);
  }
});

test('the goal is never logged raw by the router (only through the PII-safe logger)', async () => {
  const lines = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await new DecisionRouter({ cloudAdapter: mockCloud() }).route(`Email ${EMAIL} about ${CARD}`, PAGE);
  } finally {
    console.log = orig.log; console.warn = orig.warn;
  }
  const out = lines.join('\n');
  assert.ok(!out.includes(EMAIL), 'raw email in router log output');
  assert.ok(!out.includes(CARD), 'raw card number in router log output');
  assert.match(out, /\[SP:EVENT\].*layer3_invoked/);
});

test('the Qwen answer\'s value (restored to the user\'s real data) is never emitted into logs', async () => {
  // Same genuine L2 tie as above, so the cycle reaches L3. The email rides in
  // the page title, which registers it in the vault for the answer to restore.
  const elements = Array.from({ length: 60 }, (_, i) => el(`el_${i}`, `Language ${i}`));
  elements[35] = el('el_35', 'Update Billing Address');
  elements[50] = el('el_50', 'Update Billing Details');
  // The inner provider answers with a placeholder; SanitizingAdapter restores it
  // to the real email — so the router sees (and must not log) the actual value.
  const inner = {
    checkAvailability: async () => ({ available: true }),
    plan: async () => ({
      result: 'OK', state: 'planned', confidence: 0.9,
      plan: { steps: [{ phase: 'fill', targetElement: { text: 'x', elementId: 'el_35', value: '[EMAIL_1]' } }] },
      providerMetadata: { provider: 'local-qwen' }
    })
  };
  const qwen = new SanitizingAdapter(inner, { vault: new TokenVault(), onEvent: () => {} });

  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  let result;
  try {
    result = await new DecisionRouter({ executionMode: 'local-qwen', localQwenAdapter: qwen, localVisionAdapter: visionSpy() })
      .route(GOAL, { url: 'https://example.com', title: `Account ${EMAIL}`, elements });
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }

  // The restored value is still delivered to the caller — only the log changed.
  assert.equal(result.layer, 'local_qwen');
  assert.equal(result.planResponse.plan.steps[0].targetElement.value, EMAIL);

  const out = lines.join('\n');
  assert.ok(!out.includes(EMAIL), 'the restored Qwen value appeared in log output');
  assert.ok(!out.includes('john.doe'), 'part of the restored Qwen value appeared in log output');
  const ok = lines.find((l) => l.includes('layer3_qwen_ok'));
  assert.ok(ok, 'the PII-safe layer3_qwen_ok event is emitted');
  assert.match(ok, /\[SP:EVENT\]/);
  assert.match(ok, /"elementId":"el_35"/);
  assert.match(ok, /"phase":"fill"/);
  assert.match(ok, /"hasValue":true/);
  // eval/lib/metrics.mjs counts Qwen decisions from this exact line prefix.
  assert.ok(lines.some((l) => l.startsWith('[SP:DecisionRouter] Layer 3 LOCAL QWEN succeeded')), 'eval marker line preserved');
});

// ── invariants ──────────────────────────────────────────────────────────────

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(js|html|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('guide-only: no executor/adapter/router code clicks, submits or assigns a field value', () => {
  for (const f of ['services/executor-engine.js', 'providers/local-qwen-adapter.js', 'providers/local-vision-adapter.js', 'services/decision-router.js']) {
    const code = stripComments(fs.readFileSync(path.join(EXT, f), 'utf8'));
    assert.ok(!/\.click\s*\(/.test(code), `${f} calls .click()`);
    assert.ok(!/\.submit\s*\(/.test(code), `${f} calls .submit()`);
    assert.ok(!/\.requestSubmit\s*\(/.test(code), `${f} calls .requestSubmit()`);
    assert.ok(!/\.value\s*=[^=]/.test(code), `${f} assigns a .value`);
    assert.ok(!/dispatchEvent\s*\(/.test(code), `${f} dispatches synthetic events`);
  }
});

test('no provider API key or BYOK header appears anywhere in extension source (incl. dist bundles)', () => {
  const files = [...sourceFiles(EXT)];
  for (const f of fs.readdirSync(path.join(EXT, 'dist'))) files.push(path.join(EXT, 'dist', f));
  const patterns = [/X-(OpenRouter|Gemini)-Key/i, /AIza[0-9A-Za-z_-]{30,}/, /sk-or-[A-Za-z0-9-]{10,}/, /\bsk-[A-Za-z0-9]{32,}/, /generativelanguage\.googleapis/, /openrouter\.ai\/api/];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of patterns) assert.ok(!re.test(src), `${path.relative(EXT, f)} matches ${re}`);
  }
});
