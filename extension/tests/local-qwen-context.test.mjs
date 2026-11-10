// Local Qwen prompt: generic row/container `context` in the compact element line.
//
// Format: `id|role|text` — plus `|context` ONLY when the element has context.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalQwenAdapter } from '../providers/local-qwen-adapter.js';
import { SanitizingAdapter } from '../providers/sanitizing-adapter.js';
import { PrivacySanitizer } from '../lib/privacy-sanitizer.js';

const el = (id, text, extra = {}) => ({ id, role: 'button', tag: 'button', text, visible: true, enabled: true, ...extra });
const prompt = (elements, goal = 'g') => new LocalQwenAdapter()._buildQwenPrompt({ goal, page: { url: 'u', title: 't' }, elements });
const elementLines = (p) => p.split('\nElements:\n')[1].trim().split('\n');

test('context is appended as a fourth field when present', () => {
  const p = prompt([el('el_1', 'Repository settings', { context: 'UpNext Public' })]);
  assert.deepEqual(elementLines(p), ['el_1|button|Repository settings|UpNext Public']);
});

test('two identically-labelled controls in different rows are distinguishable in the prompt', () => {
  const lines = elementLines(prompt([
    el('el_2', 'Repository settings', { context: 'screen-pilot Public' }),
    el('el_4', 'Repository settings', { context: 'UpNext Public' }),
  ]));
  assert.notEqual(lines[0], lines[1]);
  assert.ok(lines[0].endsWith('|screen-pilot Public'));
  assert.ok(lines[1].endsWith('|UpNext Public'));
});

test('context is omitted (line byte-for-byte unchanged) when absent or empty', () => {
  const lines = elementLines(prompt([
    el('el_1', 'Save'),
    el('el_2', 'Cancel', { context: '' }),
    el('el_3', 'Help', { context: '   ' }),
    { id: 'el_4', role: 'textbox', tag: 'input', placeholder: 'Search' },
  ]));
  assert.deepEqual(lines, ['el_1|button|Save', 'el_2|button|Cancel', 'el_3|button|Help', 'el_4|textbox|Search']);
});

test('a sensitive element never carries context, even if a raw one is supplied', () => {
  const secret = 'Acme admin hunter2-context';
  const p = prompt([{
    id: 'el_1', role: 'textbox', tag: 'input', type: 'password', placeholder: 'Password',
    text: 'hunter2', value: 'hunter2', context: secret, visible: true, enabled: true,
  }]);
  assert.ok(!p.includes('hunter2'));
  assert.ok(!p.includes('Acme admin'));
  assert.deepEqual(elementLines(p), ['el_1|textbox|Password [sensitive]']);
});

test('page-state sanitization output (context blanked) reaches the prompt with no context', () => {
  const sanitized = PrivacySanitizer.sanitizeElement({
    id: 'el_1', role: 'textbox', tag: 'input', type: 'password', placeholder: 'Password',
    value: 'hunter2', context: 'Ada Lovelace admin', visible: true, enabled: true,
  });
  assert.deepEqual(elementLines(prompt([sanitized])), ['el_1|textbox|Password [sensitive]']);
});

test('context is normalized: pipes and whitespace cannot break the one-line-per-element format, and it is bounded', () => {
  const lines = elementLines(prompt([el('el_1', 'Edit', { context: 'a | b\n c\t|  d ' + 'x'.repeat(200) })]));
  assert.equal(lines.length, 1);
  const fields = lines[0].split('|');
  assert.equal(fields.length, 4, 'exactly id|role|text|context');
  assert.ok(fields[3].length <= 60);
  assert.match(fields[3], /^a b c d x+$/);
});

test('PII in context is placeholdered by the SanitizingAdapter before the local model sees it', async () => {
  let seen;
  const inner = { name: 'stub', plan: async (req) => { seen = req; return {}; } };
  const adapter = new SanitizingAdapter(inner, { onEvent: () => {} });
  await adapter.plan({
    goal: 'edit', page: { url: 'u', title: 't' },
    elements: [el('el_1', 'Edit', { context: 'Jane jane.roe@example.org' })],
  });
  const p = prompt(seen.elements);
  assert.ok(!p.includes('jane.roe@example.org'));
  assert.match(elementLines(p)[0], /^el_1\|button\|Edit\|Jane \[EMAIL_\d+\]$/);
});

test('existing behavior: context-free format, output schema and instructions are unchanged', () => {
  const p = prompt([el('el_1', 'Sign in', { role: 'link', tag: 'a' })]);
  assert.match(p, /^el_1\|link\|Sign in$/m);
  assert.match(p, /\{"action":"click","elementId":"e3"\}/);
  assert.match(p, /action is click\|fill\|select\|navigate\|finish/);
  assert.match(p, /Only for "fill", add "value"/);
  assert.match(p, /elementId must be copied exactly from Elements/);
  assert.match(p, /use it to choose between controls with the same text/);
  assert.ok(p.startsWith('Choose the single next UI action'), 'static instructions still come first (prompt-prefix cache)');
});

test('the 25-element window is unchanged', () => {
  const many = Array.from({ length: 40 }, (_, i) => el(`el_${i + 1}`, `Item ${i + 1}`, { context: 'row' }));
  assert.equal(elementLines(prompt(many)).length, 25);
});
