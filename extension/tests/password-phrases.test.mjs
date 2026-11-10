// Passwords written in free text (e.g. a goal) are detected and irreversibly
// redacted before logging, storage or any model request; ordinary talk about
// passwords is untouched; email/phone keep their reversible placeholders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactText, findPII, SensitiveType } from '../lib/pii-detector.js';
import { redactSecrets, outboundHandling, Outbound, allowsAutonomousFill } from '../lib/sensitive-policy.js';
import { SanitizingAdapter } from '../providers/sanitizing-adapter.js';
import { BackendAdapter } from '../providers/interface.js';
import { TokenVault } from '../lib/pii-vault.js';

const PW = 'Hunter2-Secret!9';

test('explicit password phrases are redacted', () => {
  for (const [input, expected] of [
    [`Log in to the dashboard with password ${PW}`, 'Log in to the dashboard with password [REDACTED]'],
    [`use password ${PW} to sign in`, 'use password [REDACTED] to sign in'],
    [`using the password ${PW}`, 'using the password [REDACTED]'],
    [`password: ${PW}`, 'password: [REDACTED]'],
    [`my password is ${PW}`, 'my password is [REDACTED]'],
    [`enter password Tr0ub4dor&3, then click Login`, 'enter password [REDACTED] then click Login'],
  ]) assert.equal(redactText(input), expected, input);
});

test('password followed by punctuation is still fully redacted', () => {
  for (const input of [`with password ${PW}.`, `with password ${PW}!`, `(use password ${PW})`, `use password ${PW}, then continue`]) {
    assert.ok(!redactText(input).includes('Hunter2'), input);
    assert.ok(!redactText(input).includes('Secret'), input);
  }
});

test('quoted values, including spaces, are redacted whole', () => {
  assert.equal(redactText(`with password 'correct horse battery'`), `with password '[REDACTED]'`);
  assert.equal(redactText(`password is "open sesame"`), `password is "[REDACTED]"`);
  assert.equal(redactText(`password: “my secret phrase” ok`), `password: “[REDACTED]” ok`);
});

test('ordinary uses of the word "password" are left alone', () => {
  for (const s of ['Reset my password', 'click the password field', 'use password manager to log in', 'enter your password in the box',
    'what is the password for wifi?', 'forgot password link', 'open the \'password\' settings and the \'username\' box',
    'type the password then press Enter', 'change password', 'password strength meter', 'with password reset enabled']) {
    assert.equal(redactText(s), s, s);
  }
});

test('other span types are unchanged by the new rules', () => {
  assert.equal(findPII('contact jane@example.com').map((x) => x.type).join(), SensitiveType.EMAIL);
  assert.equal(findPII('call +91 9876543210').map((x) => x.type).join(), SensitiveType.PHONE);
  assert.equal(outboundHandling(SensitiveType.PASSWORD), Outbound.REDACT);
  assert.equal(allowsAutonomousFill(SensitiveType.PASSWORD), false);
});

test('redactSecrets strips irreversible types but leaves email/phone for reversible placeholders', () => {
  const out = redactSecrets(`Sign in as jane@example.com (+91 9876543210) with password ${PW}`);
  assert.ok(out.includes('jane@example.com') && out.includes('9876543210'));
  assert.ok(!out.includes('Hunter2'));
  assert.equal(redactSecrets('Open settings'), 'Open settings');
  assert.equal(redactSecrets(undefined), undefined);
});

test('outbound cloud request: password never leaves, email becomes a reversible token', async () => {
  class Rec extends BackendAdapter {
    constructor() { super(); this.wire = []; }
    get name() { return 'Rec'; }
    async plan(req) { this.wire.push(JSON.stringify(req)); return { result: 'OK', plannerSummary: 'Enter [EMAIL_1] into the email field' }; }
  }
  const inner = new Rec();
  const events = [];
  const a = new SanitizingAdapter(inner, { vault: new TokenVault(), onEvent: (e) => events.push(JSON.stringify(e)) });
  // Even if a raw password reached the adapter (defence in depth), it must not go out.
  const resp = await a.plan({ goal: `Sign in as jane@example.com with password ${PW}`, page: { title: `password: ${PW}` } });
  const wire = inner.wire.join('');
  assert.ok(!wire.includes('Hunter2') && !wire.includes('Secret!9'), wire);
  assert.ok(!wire.includes('jane@example.com') && wire.includes('[EMAIL_1]'));
  assert.ok(resp.plannerSummary.includes('jane@example.com'), 'placeholder restored locally');
  assert.ok(!events.join('').includes('Hunter2'), 'PII events carry types and counts only');
});

test('no raw password reaches logs: goal is redacted at entry, before state log, storage and requests', () => {
  const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const task = fs.readFileSync(path.join(EXT, 'v2-task.js'), 'utf8');
  const start = task.slice(task.indexOf('async function _startNewTask('));
  const firstUse = start.indexOf('goal');
  assert.ok(/const goal = redactSecrets\(rawGoal\)/.test(start), 'goal is redacted at the top of _startNewTask');
  assert.ok(start.indexOf('redactSecrets(rawGoal)') < start.indexOf('_taskContext = { goal'), 'redaction precedes _taskContext');
  assert.ok(start.indexOf('redactSecrets(rawGoal)') < start.indexOf('SessionStore.create(_tabId, goal)'), 'redaction precedes persistence');
  assert.ok(start.indexOf('redactSecrets(rawGoal)') < start.indexOf('GOAL_SUBMITTED'), 'redaction precedes the state log');
  assert.ok(firstUse > -1);
  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.ok(/message\.goal = redactSecrets\(message\.goal\)/.test(bg), 'V1 message path redacts goals before storage/telemetry/memory');
});
