// sp-logger.js — PII-safe structured event logging (extension side).
// Mirrors tests/server/logger.test.mjs since the two modules share the same
// design and redaction source of truth (pii-detector.js).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { logEvent, logWarn, logError } from '../lib/sp-logger.js';

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

test('logEvent writes one prefixed JSON line with event/level/ts plus the given fields', () => {
  const [line] = capture(() => logEvent('routing_result', { reqId: 'r1', layer: 'ml_grounding' }));
  assert.match(line, /^\[SP:EVENT\] /);
  const parsed = JSON.parse(line.slice('[SP:EVENT] '.length));
  assert.equal(parsed.event, 'routing_result');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.reqId, 'r1');
  assert.equal(parsed.layer, 'ml_grounding');
  assert.equal(typeof parsed.ts, 'number');
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

test('a raw API key/JWT value anywhere in the fields is redacted', () => {
  const key = 'sk-' + 'proj1234567890ABCDEFGHIJ';
  const [l1] = capture(() => logEvent('debug', { note: `key ${key}` }));
  assert.equal(l1.includes(key), false);
  const [l2] = capture(() => logEvent('debug', { note: `jwt ${JWT}` }));
  assert.equal(l2.includes(JWT), false);
});

test('a field literally named like a credential is redacted regardless of its value', () => {
  const [line] = capture(() => logEvent('debug', { apiKey: 'anything', password: 'x' }));
  const parsed = JSON.parse(line.slice('[SP:EVENT] '.length));
  assert.equal(parsed.apiKey, '[REDACTED]');
  assert.equal(parsed.password, '[REDACTED]');
});

test('PII nested in objects/arrays is redacted; ordinary fields pass through', () => {
  const [line] = capture(() => logEvent('routing_result', {
    reqId: 'r1', layer: 'cloud', step: { description: `email ${EMAIL}` }, notes: [`sent to ${EMAIL}`, 'ok']
  }));
  assert.equal(line.includes(EMAIL), false);
  const parsed = JSON.parse(line.slice('[SP:EVENT] '.length));
  assert.equal(parsed.reqId, 'r1');
  assert.equal(parsed.layer, 'cloud');
  assert.match(parsed.step.description, /\[REDACTED\]/);
  assert.equal(parsed.notes[1], 'ok');
});

test('non-string values pass through unchanged', () => {
  const [line] = capture(() => logEvent('routing_result', { layer1Ms: 12, ok: true, missing: null }));
  const parsed = JSON.parse(line.slice('[SP:EVENT] '.length));
  assert.equal(parsed.layer1Ms, 12);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.missing, null);
});

test('this module never references chrome.storage/fetch (no persistence, no network)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'sp-logger.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const banned of ['chrome.storage', 'fetch(']) assert.equal(code.includes(banned), false, banned);
});
