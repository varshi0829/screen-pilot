// sensitive-policy.js — the fixed sensitive-data policy table.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { SensitiveType } from '../lib/pii-detector.js';
import {
  Outbound,
  POLICY_TYPES,
  getPolicy,
  outboundHandling,
  allowsAutonomousFill,
  fieldInstruction
} from '../lib/sensitive-policy.js';

const ALL_TYPES = Object.values(SensitiveType);

test('every SensitiveType has a policy entry (no type can be forgotten)', () => {
  assert.deepEqual([...POLICY_TYPES].sort(), [...ALL_TYPES].sort());
  for (const type of ALL_TYPES) assert.ok(getPolicy(type), type);
});

test('GUIDE-ONLY invariant: no type ever allows autonomous filling', () => {
  for (const type of ALL_TYPES) {
    assert.equal(allowsAutonomousFill(type), false, type);
    assert.equal(getPolicy(type).autonomousFill, false, type);
    assert.equal(getPolicy(type).guidance, 'user_enters', type);
  }
  assert.equal(allowsAutonomousFill('not-a-type'), false);
});

test('email and phone get reversible placeholders; every other type is irreversibly redacted', () => {
  assert.equal(outboundHandling(SensitiveType.EMAIL), Outbound.PLACEHOLDER);
  assert.equal(outboundHandling(SensitiveType.PHONE), Outbound.PLACEHOLDER);
  for (const type of ALL_TYPES) {
    if (type === SensitiveType.EMAIL || type === SensitiveType.PHONE) continue;
    assert.equal(outboundHandling(type), Outbound.REDACT, type);
  }
});

test('secrets are never eligible for a placeholder (they could otherwise be restored)', () => {
  for (const t of [SensitiveType.PASSWORD, SensitiveType.JWT, SensitiveType.API_KEY, SensitiveType.SECRET,
                   SensitiveType.CREDIT_CARD, SensitiveType.SSN, SensitiveType.OTP]) {
    assert.notEqual(outboundHandling(t), Outbound.PLACEHOLDER, t);
  }
});

test('unknown types fail closed (redact)', () => {
  assert.equal(outboundHandling('something_new'), Outbound.REDACT);
  assert.equal(outboundHandling(undefined), Outbound.REDACT);
});

test('fieldInstruction tells the user to enter the value themselves and contains no value', () => {
  for (const type of ALL_TYPES) {
    const text = fieldInstruction(type);
    assert.match(text, /yourself/i, type);
    assert.match(text, /never reads, stores, or types it/i, type);
  }
  assert.match(fieldInstruction(SensitiveType.PASSWORD), /password/);
  assert.match(fieldInstruction(SensitiveType.CREDIT_CARD), /card/);
});

test('fieldInstruction returns null for non-sensitive input', () => {
  assert.equal(fieldInstruction(null), null);
  assert.equal(fieldInstruction('text'), null);
});

test('policy entries are frozen', () => {
  assert.throws(() => { 'use strict'; getPolicy(SensitiveType.PASSWORD).outbound = 'placeholder'; });
});
