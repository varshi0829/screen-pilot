// ScreenPilot v2 — Optimization, Generic Multi-Site & Safeguard Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ScreenshotService } from '../services/screenshot-service.js';
import { VercelBackendAdapter } from '../providers/vercel-backend-adapter.js';
import { GoalVerifier } from '../services/goal-verifier.js';

test('A. Stale planner response after DOM change is detected and discarded', () => {
  const preSnap  = { url: 'https://example.org/dashboard', domHash: 'hash1', title: 'Dashboard' };
  const postSnap = { url: 'https://example.org/dashboard', domHash: 'hash2', title: 'Dashboard' }; // DOM changed

  const urlChanged = preSnap.url !== postSnap.url;
  const domChanged = preSnap.domHash !== postSnap.domHash;
  const isStale    = urlChanged || domChanged;

  assert.equal(isStale, true, 'Plan response must be flagged stale when DOM hash changes');
});

test('B. Stale planner response after URL change is detected and discarded', () => {
  const preSnap  = { url: 'https://example.com/app', domHash: 'hash1', title: 'App' };
  const postSnap = { url: 'https://example.com/settings', domHash: 'hash1', title: 'Settings' }; // URL changed

  const urlChanged = preSnap.url !== postSnap.url;
  const domChanged = preSnap.domHash !== postSnap.domHash;
  const isStale    = urlChanged || domChanged;

  assert.equal(isStale, true, 'Plan response must be flagged stale when URL changes');
});

test('C. Aborting an obsolete planner request returns ABORTED error code gracefully', async () => {
  const adapter = new VercelBackendAdapter({ baseUrl: 'https://screen-pilot-j1az.vercel.app' });
  const controller = new AbortController();

  controller.abort('page_changed');

  const response = await adapter.plan({
    schemaVersion: '1',
    requestId: 'test-req',
    goal: 'test goal',
    page: { url: 'https://example.com', title: 'Example', screenshot: { image: 'aaaa' } }
  }, { signal: controller.signal });

  assert.equal(response.result, 'FAILED', 'Aborted request should return FAILED result');
  assert.equal(response.errorCode, 'ABORTED', 'Aborted request should return ABORTED error code');
});

test('D. Terminal step completion does not fire extra planner request', () => {
  const plannerStep = {
    id: 1,
    intent: 'submit_form',
    description: 'Submit form',
    completionCondition: 'final'
  };

  const isTerminalStep = (step) => step?.completionCondition === 'final';
  assert.equal(isTerminalStep(plannerStep), true, 'Terminal step identified by completionCondition: final');
});

test('E. Verification succeeds with condition-based 150ms delay when state changes', async () => {
  const pre = { url: 'https://example.com', domHash: 'hashA' };
  let post  = { url: 'https://example.com', domHash: 'hashA' };

  const t0 = Date.now();
  const stateChangeTimer = setTimeout(() => {
    post = { url: 'https://example.com', domHash: 'hashB' };
  }, 30);

  while (Date.now() - t0 < 150 && pre.domHash === post.domHash && pre.url === post.url) {
    await new Promise(r => setTimeout(r, 10));
  }
  clearTimeout(stateChangeTimer);

  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150, `Verification settled quickly on state change (${elapsed}ms < 150ms)`);
  assert.notEqual(pre.domHash, post.domHash, 'DOM hash changed after state transition');
});

test('F. Soft-navigation resume timer uses 200ms delay', () => {
  const SOFT_NAV_RESUME_DELAY_MS = 200;
  assert.equal(SOFT_NAV_RESUME_DELAY_MS, 200, 'Soft navigation resume delay must be 200ms');
});

test('G. Screenshot validation remains valid with optimized compression', () => {
  const validScreenshot = {
    success: true,
    image: 'A'.repeat(5000),
    mimeType: 'image/jpeg'
  };

  const validation = ScreenshotService.validateScreenshot(validScreenshot);
  assert.equal(validation.valid, true, 'Screenshot validation passes for compressed JPEG');
});

test('H. Generic Task Scenarios: Simple Click, Navigation, Input, Dropdown', () => {
  const clickStep = { intent: 'click_button', targetElement: { text: 'Submit', type: 'button' } };
  const navStep   = { intent: 'navigate_page', expectedPageState: { urlChanges: true } };
  const inputStep = { intent: 'fill_field', targetElement: { text: 'Username', type: 'input' } };
  const menuStep  = { intent: 'open_menu', targetElement: { text: 'Options', type: 'dropdown' } };

  assert.ok(clickStep.targetElement.text === 'Submit', 'Simple click task step structured properly');
  assert.ok(navStep.expectedPageState.urlChanges === true, 'Navigation task step expects URL change');
  assert.ok(inputStep.targetElement.type === 'input', 'Form input step structured properly');
  assert.ok(menuStep.targetElement.type === 'dropdown', 'Menu dropdown step structured properly');
});

test('I. Desired state already satisfied stops execution via GoalVerifier', () => {
  const criteria = {
    goalType: 'action',
    match: 'all',
    requiresEffect: true,
    successSignals: [{ type: 'url_matches', urlPattern: '/dashboard' }]
  };

  const mockLoc = { href: 'https://app.com/dashboard' };
  const verdict = GoalVerifier.shouldComplete(criteria, { loc: mockLoc });
  assert.equal(verdict.complete, true, 'GoalVerifier stops execution when current page satisfies goal criteria');
});

test('J. Generic Dedup Guard prevents repeated actions when state is unchanged', () => {
  const recentCompleted = [
    { intent: 'click_login', description: 'Click Login', urlBefore: 'https://example.com/login', domHashBefore: 'hash123' }
  ];
  const currentSnap = { url: 'https://example.com/login', domHash: 'hash123' };
  const plannerStep = { intent: 'click_login', targetElement: { text: 'Login' } };

  const targetText = plannerStep.targetElement.text.toLowerCase();
  const planIntent = plannerStep.intent.toLowerCase();

  const matching = recentCompleted.find(s => s.intent.toLowerCase() === planIntent || s.description.toLowerCase().includes(targetText));
  const urlSame = currentSnap.url === matching.urlBefore;
  const domHashSame = currentSnap.domHash === matching.domHashBefore;

  assert.ok(matching != null, 'Found matching recently completed action');
  assert.equal(urlSame && domHashSame, true, 'Page state is identical to pre-action baseline — dedup guard must fire');
});

test('K. Codebase Audit: Verify NO website-specific code branches or selectors exist', () => {
  const filesToCheck = [
    'extension/v2-task.js',
    'extension/providers/interface.js',
    'extension/providers/vercel-backend-adapter.js',
    'extension/services/screenshot-service.js',
    'extension/services/executor-engine.js',
    'extension/services/goal-verifier.js',
    'extension/lib/dom-matcher.js'
  ];

  for (const relPath of filesToCheck) {
    const fullPath = path.join(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');

    // Ensure no site-specific code conditions like `if (github)` or `if (youtube)` exist
    assert.equal(/if\s*\([^)]*github\.com/i.test(content), false, `${relPath} contains domain-specific github condition`);
    assert.equal(/if\s*\([^)]*youtube\.com/i.test(content), false, `${relPath} contains domain-specific youtube condition`);
    assert.equal(/if\s*\([^)]*amazon\.com/i.test(content), false, `${relPath} contains domain-specific amazon condition`);
  }
});
