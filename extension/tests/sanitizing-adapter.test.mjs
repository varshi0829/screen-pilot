// SanitizingAdapter — proves PII never reaches the wrapped (external) adapter,
// that placeholders are restored locally on the way back, and that it fails closed.
// Secret-shaped fixtures are assembled at runtime.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BackendAdapter, assertBackendAdapter } from '../providers/interface.js';
import { SanitizingAdapter } from '../providers/sanitizing-adapter.js';
import { TokenVault } from '../lib/pii-vault.js';

const EMAIL  = 'john@example.com';
const PHONE  = '+91 9876543210';
const CARD   = '4111 1111 1111 1111';
const JWT    = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2ln_nature-123'].join('.');
const APIKEY = 'sk-' + 'proj1234567890ABCDEFGHIJ';
const PASSWD = 'hunter22';
const RAW_SECRETS = [EMAIL, '9876543210', '4111', JWT, APIKEY, PASSWD];

/** Records exactly what it was asked to send, as a JSON string (i.e. what would go on the wire). */
class RecordingAdapter extends BackendAdapter {
  constructor(responder = () => ({ result: 'OK', state: 'planned' })) {
    super();
    this.sent = [];
    this.options = [];
    this.responder = responder;
  }
  get name() { return 'Recording'; }
  async plan(request, options)    { this.sent.push({ m: 'plan', body: JSON.stringify(request) });    this.options.push(options); return this.responder('plan', request); }
  async recover(request, options) { this.sent.push({ m: 'recover', body: JSON.stringify(request) }); this.options.push(options); return this.responder('recover', request); }
  async explain(request, options) { this.sent.push({ m: 'explain', body: JSON.stringify(request) }); this.options.push(options); return this.responder('explain', request); }
  async ask(request, options)     { this.sent.push({ m: 'ask', body: JSON.stringify(request) });     this.options.push(options); return this.responder('ask', request); }
  estimateCost() { return { inputTokens: 1, outputTokens: 1, estimatedUSD: 0 }; }
  async checkAvailability() { return { available: true }; }
}

function sensitivePlanRequest() {
  return {
    schemaVersion: '1',
    requestId: 'req_123',
    goal: `Send an email to ${EMAIL} and call ${PHONE}; my password is ${PASSWD}`,
    page: {
      url: `https://mail.example.com/compose?to=${EMAIL}&token=abc123secret&page=2`,
      title: `Compose — ${EMAIL}`,
      screenshot: { image: 'QUJD'.repeat(200), mimeType: 'image/jpeg' }
    },
    executionHistory: {
      completedSteps: [
        { description: `Typed ${CARD} into the card field`, intent: 'fill_card', completedAt: 1 },
        { description: `Pasted ${JWT}`, intent: 'paste' }
      ],
      planVersion: 2,
      attemptCount: 3
    },
    clarifications: [`use key ${APIKEY}`],
    pageControls: [{ region: 'top_navigation', tag: 'BUTTON', text: `Sign out ${EMAIL}`, ariaLabel: '', title: '', imgAlt: '' }],
    workflowMemory: { visitedUrls: [`https://a.example.com/?email=${EMAIL}`], extractedData: { password: PASSWD } }
  };
}

test('SanitizingAdapter satisfies the BackendAdapter interface', () => {
  const a = new SanitizingAdapter(new RecordingAdapter(), { onEvent: () => {} });
  assert.doesNotThrow(() => assertBackendAdapter(a));
  assert.equal(a.name, 'Sanitizing(Recording)');
  assert.throws(() => new SanitizingAdapter(null), /inner adapter is required/);
});

test('OUTGOING PAYLOAD CONTAINS NO PII: email, phone, card, JWT, API key, password, URL secrets', async () => {
  const inner = new RecordingAdapter();
  const a = new SanitizingAdapter(inner, { onEvent: () => {} });
  await a.plan(sensitivePlanRequest());

  const wire = inner.sent[0].body;
  for (const secret of RAW_SECRETS) {
    assert.equal(wire.includes(secret), false, `raw value leaked to the external adapter: ${secret.slice(0, 4)}…`);
  }
  assert.equal(wire.includes('abc123secret'), false, 'URL token value leaked');
  assert.equal(wire.includes('john%40'), false);

  // reasoning-friendly placeholders survive, structure is preserved
  assert.match(wire, /\[EMAIL_1\]/);
  assert.match(wire, /\[PHONE_1\]/);
  const sent = JSON.parse(wire);
  assert.match(sent.goal, /^Send an email to \[EMAIL_1\] and call \[PHONE_1\]; my password is \[REDACTED\]$/);
  assert.match(sent.page.url, /^https:\/\/mail\.example\.com\/compose\?to=\[EMAIL_1\]&token=\[REDACTED\]&page=2$/);
  assert.equal(sent.executionHistory.planVersion, 2);
  assert.equal(sent.executionHistory.attemptCount, 3);
  assert.equal(sent.requestId, 'req_123');
});

test('the screenshot passes through byte-for-byte', async () => {
  const inner = new RecordingAdapter();
  const req = sensitivePlanRequest();
  await new SanitizingAdapter(inner, { onEvent: () => {} }).plan(req);
  assert.equal(JSON.parse(inner.sent[0].body).page.screenshot.image, req.page.screenshot.image);
});

test('the caller\'s request object is never mutated', async () => {
  const req = sensitivePlanRequest();
  const before = JSON.stringify(req);
  await new SanitizingAdapter(new RecordingAdapter(), { onEvent: () => {} }).plan(req);
  assert.equal(JSON.stringify(req), before);
});

test('recover, explain and ask are sanitized too', async () => {
  const inner = new RecordingAdapter();
  const a = new SanitizingAdapter(inner, { onEvent: () => {} });
  await a.recover({ goal: `fix ${EMAIL}`, page: { url: 'https://x.com', title: 'x' } });
  await a.explain({ screenshot: { image: 'QUJD', mimeType: 'image/png' }, pageContext: { url: 'https://x.com/?token=zzz', title: EMAIL } });
  await a.ask({ screenshot: { image: 'QUJD', mimeType: 'image/png' }, question: `is ${PHONE} shown?`, pageContext: { url: 'https://x.com' } });
  assert.equal(inner.sent.length, 3);
  for (const s of inner.sent) {
    for (const secret of [EMAIL, '9876543210', 'zzz']) assert.equal(s.body.includes(secret), false, `${s.m}: ${secret}`);
  }
});

test('placeholders in the response are restored locally; unknown ones are left alone', async () => {
  const inner = new RecordingAdapter(() => ({
    result: 'OK',
    plannerSummary: 'Composing to [EMAIL_1]',
    plan: { steps: [{ description: "Enter '[EMAIL_1]' then call [PHONE_1] or [EMAIL_9]", targetElement: { text: 'Sign out [EMAIL_1]', intent: 'enter [EMAIL_1]' } }] }
  }));
  const a = new SanitizingAdapter(inner, { onEvent: () => {} });
  const res = await a.plan(sensitivePlanRequest());
  assert.equal(res.plannerSummary, `Composing to ${EMAIL}`);
  assert.equal(res.plan.steps[0].description, `Enter '${EMAIL}' then call ${PHONE} or [EMAIL_9]`);
  assert.equal(res.plan.steps[0].targetElement.text, `Sign out ${EMAIL}`, 'DOM matching text is restored');
});

test('a redacted secret can never be restored, even if the model echoes the marker', async () => {
  const inner = new RecordingAdapter((m, req) => ({ echoed: req.goal }));
  const res = await new SanitizingAdapter(inner, { onEvent: () => {} }).plan({ goal: `password: ${PASSWD} for ${EMAIL}` });
  assert.equal(res.echoed.includes(PASSWD), false);
  assert.match(res.echoed, /\[REDACTED\]/);
});

test('one vault spans successive calls: same value keeps the same placeholder', async () => {
  const inner = new RecordingAdapter();
  const a = new SanitizingAdapter(inner, { onEvent: () => {} });
  await a.plan({ goal: `mail ${EMAIL}` });
  await a.plan({ goal: `again ${EMAIL}` });
  assert.match(inner.sent[0].body, /\[EMAIL_1\]/);
  assert.match(inner.sent[1].body, /\[EMAIL_1\]/);
});

test('the caller can supply its own vault (e.g. one per task)', async () => {
  const vault = new TokenVault();
  const inner = new RecordingAdapter((m, req) => ({ echoed: req.goal }));
  const res = await new SanitizingAdapter(inner, { vault, onEvent: () => {} }).plan({ goal: `mail ${EMAIL}` });
  assert.equal(vault.size, 1);
  assert.equal(res.echoed, `mail ${EMAIL}`);
});

test('options (AbortSignal) reach the inner adapter untouched', async () => {
  const inner = new RecordingAdapter();
  const controller = new AbortController();
  await new SanitizingAdapter(inner, { onEvent: () => {} }).plan({ goal: 'x' }, { signal: controller.signal });
  assert.equal(inner.options[0].signal, controller.signal);
});

test('inner adapter results (including FAILED) pass through', async () => {
  const failed = { result: 'FAILED', error: 'boom', errorCode: 'NETWORK_ERROR', blockers: [], confidence: 0 };
  const res = await new SanitizingAdapter(new RecordingAdapter(() => failed), { onEvent: () => {} }).plan({ goal: 'x' });
  assert.deepEqual(res, failed);
});

test('estimateCost and checkAvailability delegate', async () => {
  const a = new SanitizingAdapter(new RecordingAdapter(), { onEvent: () => {} });
  assert.equal(a.estimateCost('plan', {}).inputTokens, 1);
  assert.deepEqual(await a.checkAvailability(), { available: true });
});

test('FAILS CLOSED: if sanitization throws, nothing is sent and a FAILED result is returned', async () => {
  const inner = new RecordingAdapter();
  const events = [];
  const a = new SanitizingAdapter(inner, { onEvent: (e) => events.push(e) });
  const poisoned = { get goal() { throw new Error('boom'); } };
  const res = await a.plan(poisoned);
  assert.equal(inner.sent.length, 0, 'the inner adapter must not be called');
  assert.equal(res.result, 'FAILED');
  assert.equal(res.errorCode, 'SANITIZE_ERROR');
  assert.equal(events[0].event, 'sanitize_failed');
});

test('events carry only types and counts — never a value', async () => {
  const events = [];
  const a = new SanitizingAdapter(new RecordingAdapter(), { onEvent: (e) => events.push(e) });
  await a.plan(sensitivePlanRequest());
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'pii_redacted');
  assert.equal(events[0].method, 'plan');
  assert.ok(events[0].types.email >= 1 && events[0].types.phone >= 1 && events[0].types.jwt >= 1);
  const dump = JSON.stringify(events);
  for (const secret of RAW_SECRETS) assert.equal(dump.includes(secret), false, secret.slice(0, 4));
});

test('no event is emitted when there is nothing to redact', async () => {
  const events = [];
  await new SanitizingAdapter(new RecordingAdapter(), { onEvent: (e) => events.push(e) }).plan({ goal: 'Search Wikipedia for cats' });
  assert.deepEqual(events, []);
});

test('the default logger writes types/counts only — no raw PII reaches the console', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await new SanitizingAdapter(new RecordingAdapter()).plan(sensitivePlanRequest());
  } finally {
    console.log = orig;
  }
  const out = lines.join('\n');
  assert.match(out, /\[SP:PII\]/);
  for (const secret of RAW_SECRETS) assert.equal(out.includes(secret), false, secret.slice(0, 4));
});

test('a throwing onEvent callback never affects the request', async () => {
  const inner = new RecordingAdapter();
  const a = new SanitizingAdapter(inner, { onEvent: () => { throw new Error('logger down'); } });
  const res = await a.plan(sensitivePlanRequest());
  assert.equal(res.result, 'OK');
  assert.equal(inner.sent.length, 1);
});
