// Wiring: proves the sanitizer/guard are actually connected to the real egress
// points, not just correct in isolation.
//   1. VisionService (legacy /api/analyze path) — functional, with a stubbed fetch.
//   2. v2-task.js — structural (it is a whole content-script module, so the
//      existing tests read its source rather than import it).
//   3. Egress inventory — every network call in the extension source is either
//      sanitized, local-only, or an explicitly documented known gap.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ext = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(ext(...p), 'utf8').replace(/\r\n/g, '\n');

const EMAIL = 'john@example.com';
const PHONE = '+91 9876543210';

// ── 1. VisionService (functional) ────────────────────────────────────────────

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: store[key] };
        return { ...store };
      },
      async set(obj) { Object.assign(store, obj); }
    }
  }
};

const sentBodies = [];
let nextResponseText = '{"answer":"ok","confidence":0.9,"elementHint":""}';
globalThis.fetch = async (url, init) => {
  sentBodies.push(String(init.body));
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: nextResponseText }] } }] })
  };
};

const { VisionService } = await import('../services/vision-service.js');
const shot = { success: true, image: 'QUJD'.repeat(100), mimeType: 'image/jpeg' };

test('VisionService.askQuestion sends no raw PII and restores placeholders in the answer', async () => {
  sentBodies.length = 0;
  nextResponseText = JSON.stringify({ answer: 'The message was sent to [EMAIL_1]', confidence: 0.9, elementHint: '' });

  const result = await VisionService.askQuestion({
    screenshot: shot,
    question: `Did my message to ${EMAIL} (${PHONE}) go through? password: hunter22`,
    pageContext: { url: 'https://mail.example.com/sent?token=abc123secret&page=1', title: `Sent — ${EMAIL}` }
  });

  assert.equal(sentBodies.length, 1);
  const wire = sentBodies[0];
  for (const raw of [EMAIL, '9876543210', 'hunter22', 'abc123secret']) {
    assert.equal(wire.includes(raw), false, `raw value reached the network: ${raw}`);
  }
  const body = JSON.parse(wire);
  assert.match(body.goal, /\[EMAIL_1\]/);
  assert.match(body.pageContext.url, /token=\[REDACTED\]&page=1/);
  assert.equal(body.screenshot.image, shot.image, 'screenshot passes through untouched');
  assert.equal(body.mode, 'ask');

  assert.equal(result.success, true);
  assert.equal(result.answer, `The message was sent to ${EMAIL}`);
});

test('VisionService.analyzeScreenshot sanitizes goal, task state and enterprise context', async () => {
  sentBodies.length = 0;
  nextResponseText = JSON.stringify({
    screenSummary: 'Compose window', currentStep: 'Type the recipient', instruction: 'Click "To"',
    targetElement: { text: 'To', type: 'input' }, candidates: [], confidence: 0.9
  });

  await VisionService.analyzeScreenshot({
    screenshot: shot,
    goal: `email ${EMAIL}`,
    pageContext: { url: 'https://mail.example.com', title: 'Compose' },
    taskState: { completedSteps: [`Opened inbox for ${EMAIL}`], currentInstruction: `Type ${PHONE}` },
    enterpriseContext: { application: 'Mail', workspace: EMAIL }
  });

  const wire = sentBodies[0];
  for (const raw of [EMAIL, '9876543210']) assert.equal(wire.includes(raw), false, raw);
  const body = JSON.parse(wire);
  assert.equal(body.goal, 'email [EMAIL_1]');
  assert.equal(body.enterpriseContext.workspace, '[EMAIL_1]');
  assert.equal(body.taskState.currentInstruction, 'Type [PHONE_1]');
});

test('VisionService leaves clean requests untouched', async () => {
  sentBodies.length = 0;
  await VisionService.askQuestion({
    screenshot: shot,
    question: 'What is on this page?',
    pageContext: { url: 'https://en.wikipedia.org/wiki/Cat', title: 'Cat - Wikipedia' }
  });
  const body = JSON.parse(sentBodies[0]);
  assert.equal(body.goal, 'What is on this page?');
  assert.equal(body.pageContext.url, 'https://en.wikipedia.org/wiki/Cat');
  assert.equal(body.pageContext.title, 'Cat - Wikipedia');
});

test('VisionService source no longer sends the raw goal/pageContext/taskState', () => {
  const src = read('services', 'vision-service.js');
  assert.match(src, /sanitizeDeep\(/);
  assert.match(src, /goal:\s+safe\.goal/);
  assert.match(src, /pageContext:\s+safe\.pageContext/);
  assert.match(src, /taskState:\s+safe\.taskState/);
  assert.match(src, /restoreDeep\(await res\.json\(\), vault\)/);
});

// ── 2. v2-task.js (structural) ───────────────────────────────────────────────

test('v2-task.js wraps the cloud adapter in SanitizingAdapter and guards the highlighter', () => {
  const src = read('v2-task.js');
  assert.match(src, /import \{ SanitizingAdapter \}\s+from '\.\/providers\/sanitizing-adapter\.js'/);
  assert.match(src, /import \{ guardHighlighter \}\s+from '\.\/lib\/sensitive-guard\.js'/);
  assert.match(src, /new SanitizingAdapter\(new VercelBackendAdapter\(/);
  assert.match(src, /guardHighlighter\(resolveHighlighter\(\)\)/);
  // every VercelBackendAdapter constructed in v2-task.js is wrapped
  const constructed = (src.match(/new VercelBackendAdapter\(/g) || []).length;
  const wrapped = (src.match(/new SanitizingAdapter\(new VercelBackendAdapter\(/g) || []).length;
  assert.equal(constructed, wrapped);
});

test('v2-task.js never logs the raw goal', () => {
  const src = read('v2-task.js');
  assert.equal(/goal="\$\{session\.goal\}"/.test(src), false);
  assert.equal(/New task: "\$\{goal\}"/.test(src), false);
  assert.match(src, /goal="\$\{redactText\(session\.goal\)\}"/);
  assert.match(src, /New task: "\$\{redactText\(goal\)\}"/);
});

// ── 3. Egress inventory ──────────────────────────────────────────────────────

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['dist', 'tests', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const stripComments = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const rel = (f) => path.relative(ext(), f).split(path.sep).join('/');

// Every source file that performs a network call, and why that is acceptable.
const EGRESS_ALLOWLIST = {
  'providers/vercel-backend-adapter.js': 'cloud adapter — always wrapped by SanitizingAdapter in v2-task.js',
  'services/vision-service.js':          'legacy /api/analyze — payload sanitized before fetch (tested above)',
  'providers/local-qwen-adapter.js':     'local Ollama (127.0.0.1) — never leaves the device',
  'providers/local-vision-adapter.js':   'local Ollama (127.0.0.1) — never leaves the device',
  'services/ollama-proxy.js':            'local Ollama proxy — never leaves the device',
  'services/screenshot-service.js':      'fetch(dataUrl) — decodes an in-memory data: URL, no network'
};

test('every network call in the extension source is accounted for', () => {
  const found = sourceFiles(ext())
    .filter((f) => /\bfetch\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map(rel)
    .sort();
  assert.deepEqual(found, Object.keys(EGRESS_ALLOWLIST).sort(),
    'a new fetch() appeared (or one was removed) — route it through SanitizingAdapter/sanitizeDeep or add it to EGRESS_ALLOWLIST with a reason');
});

test('KNOWN GAP (documented, not yet wrapped): playground.js', () => {
  // playground.js is a developer tool outside scope. (Phase 6 closed the
  // DecisionRouter default: its fallback adapters are now SanitizingAdapter-
  // wrapped.) When playground.js is fixed, delete this test.
  const unwrapped = sourceFiles(ext())
    .filter((f) => /new VercelBackendAdapter\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .filter((f) => !/new SanitizingAdapter\(new VercelBackendAdapter\(/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map(rel)
    .sort();
  assert.deepEqual(unwrapped, ['playground/playground.js']);
});
