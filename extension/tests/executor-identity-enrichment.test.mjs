// v2-task.js enrichStepFromPageState — the identity a model-built step needs.
//
// A step built by a model tier (local Qwen) carries only text + elementId. The
// executor's identity resolution (see executor-identity-resolution.test.mjs)
// needs bbox, row context and the label's ordinal, all of which the SAME
// page-state element the step was grounded against already holds.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

global.chrome = {
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  runtime: {
    sendMessage: async (msg) => (msg?.type === 'GET_TAB_ID' ? { tabId: null } : { success: false }),
    onMessage: { addListener: () => {} },
  },
};
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
  body: { appendChild: () => {} }, title: 'Test page',
  addEventListener: () => {}, removeEventListener: () => {}, querySelectorAll: () => [],
};
global.window = { location: { href: 'https://example.com/' }, __SP_Highlighter: null, DOMMatcher: null, addEventListener: () => {}, removeEventListener: () => {} };

const { __enrichStepFromPageState: enrich } = await import('../v2-task.js');

const LABEL = 'Repository settings';
const el = (id, text, extra = {}) => ({ id, role: 'button', tag: 'button', text, visible: true, enabled: true, region: 'main_content', ...extra });
const bb = (y) => ({ x: 500, y, width: 40, height: 20 });
const pageState = () => ({
  url: 'https://host.example/list',
  elements: [
    el('el_1', 'alpha-app', { role: 'link', tag: 'a' }),
    el('el_2', LABEL, { bbox: bb(0), context: 'alpha-app Public' }),
    el('el_3', 'UpNext', { role: 'link', tag: 'a' }),
    el('el_4', LABEL, { bbox: bb(100), context: 'UpNext Public' }),
    el('el_5', LABEL, { bbox: bb(200), context: 'gamma-lib Private' }),
  ],
});
const qwenStep = (elementId) => ({ targetElement: { text: LABEL, type: 'button', intent: LABEL, value: '', elementId } });

test('a Qwen-shaped step (id + text only) gains bbox, context and its ordinal among same-labelled controls', () => {
  const step = qwenStep('el_4');
  enrich(step, pageState());
  assert.deepEqual(step.targetElement.bbox, bb(100));
  assert.equal(step.targetElement.context, 'UpNext Public');
  assert.equal(step.targetElement.labelIndex, 1);
  assert.equal(step.targetElement.labelCount, 3);
});

test('the ordinal follows the selected element, not the first match', () => {
  const [a, b, c] = ['el_2', 'el_4', 'el_5'].map((id) => { const s = qwenStep(id); enrich(s, pageState()); return s.targetElement.labelIndex; });
  assert.deepEqual([a, b, c], [0, 1, 2]);
});

test('values already on the step are never overwritten', () => {
  const step = { targetElement: { text: LABEL, elementId: 'el_4', bbox: bb(999), context: 'kept', labelIndex: 7, labelCount: 9 } };
  enrich(step, pageState());
  assert.deepEqual(step.targetElement.bbox, bb(999));
  assert.equal(step.targetElement.context, 'kept');
  assert.equal(step.targetElement.labelIndex, 7);
  assert.equal(step.targetElement.labelCount, 9);
});

test('no context recorded -> no context field added; a unique label gets ordinal 0 of 1', () => {
  const ps = { elements: [el('el_1', 'Save', { bbox: bb(0) })] };
  const step = { targetElement: { text: 'Save', elementId: 'el_1' } };
  enrich(step, ps);
  assert.equal('context' in step.targetElement, false);
  assert.equal(step.targetElement.labelIndex, 0);
  assert.equal(step.targetElement.labelCount, 1);
});

test('an elementId that is not in page state, or a step without one, is left untouched', () => {
  const stale = qwenStep('el_99');
  enrich(stale, pageState());
  assert.deepEqual(stale, qwenStep('el_99'));
  const cloud = { targetElement: { text: LABEL, type: 'button' } }; // cloud steps carry no elementId
  enrich(cloud, pageState());
  assert.deepEqual(cloud, { targetElement: { text: LABEL, type: 'button' } });
});
