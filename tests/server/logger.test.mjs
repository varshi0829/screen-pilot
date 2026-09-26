import './_setup.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
const { logEvent, logWarn, logError, logModelOutcome } = await import('../../src/server/logger.ts');

const EMAIL = 'jane@example.com';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2ln_nature-123'].join('.');

function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

test('logEvent writes one JSON line with event/level/ts plus the given fields', () => {
  const [line] = capture(() => logEvent('plan_complete', { reqId: 'r1', latencyMs: 42 }));
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, 'plan_complete');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.reqId, 'r1');
  assert.equal(parsed.latencyMs, 42);
  assert.equal(typeof parsed.ts, 'string');
});

test('logWarn/logError use the matching console method and level', () => {
  const origWarn = console.warn, origError = console.error;
  let warnCalled = false, errorCalled = false;
  console.warn = () => { warnCalled = true; };
  console.error = () => { errorCalled = true; };
  try {
    logWarn('w', {});
    logError('e', {});
  } finally {
    console.warn = origWarn; console.error = origError;
  }
  assert.equal(warnCalled, true);
  assert.equal(errorCalled, true);
});

test('a raw API key value is redacted even under an unexpected field name', () => {
  const key = 'sk-' + 'proj1234567890ABCDEFGHIJ';
  const [line] = capture(() => logEvent('debug', { note: `using ${key}` }));
  assert.equal(line.includes(key), false);
});

test('a field literally named like a credential is redacted regardless of its value', () => {
  const [line] = capture(() => logEvent('debug', { apiKey: 'anything-at-all', Authorization: 'Bearer anything', password: 'x' }));
  const parsed = JSON.parse(line);
  assert.equal(parsed.apiKey, '[REDACTED]');
  assert.equal(parsed.Authorization, '[REDACTED]');
  assert.equal(parsed.password, '[REDACTED]');
});

test('PII inside nested objects/arrays is redacted; ordinary fields are untouched', () => {
  const [line] = capture(() => logEvent('req', {
    reqId: 'r1',
    session: { keyType: 'shared', contact: `mail ${EMAIL}` },
    steps: [`typed ${EMAIL}`, 'clicked Submit']
  }));
  assert.equal(line.includes(EMAIL), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.reqId, 'r1');
  assert.equal(parsed.session.keyType, 'shared');
  assert.match(parsed.session.contact, /\[REDACTED\]/);
  assert.equal(parsed.steps[1], 'clicked Submit');
});

test('a JWT anywhere in the fields never reaches the log line', () => {
  const [line] = capture(() => logEvent('req', { note: `token ${JWT}` }));
  assert.equal(line.includes(JWT), false);
});

test('logModelOutcome logs only length/parsedOk — never accepts or emits the raw text', () => {
  const [line] = capture(() => logModelOutcome('plan_model_output', { reqId: 'r1', rawLength: 512, parsedOk: true }));
  const parsed = JSON.parse(line);
  assert.equal(parsed.rawLength, 512);
  assert.equal(parsed.parsedOk, true);
  assert.equal('rawText' in parsed, false);
  assert.equal('text' in parsed, false);
});

test('non-string, non-object values pass through unchanged', () => {
  const [line] = capture(() => logEvent('req', { count: 3, ok: true, missing: null }));
  const parsed = JSON.parse(line);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.missing, null);
});
