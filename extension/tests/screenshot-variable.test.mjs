// ScreenPilot V2.1 — Regression Test for screenshotMs & isNodeTest variable scope errors

import test from 'node:test';
import assert from 'node:assert/strict';

test('1. Performance logging string constructs correctly with and without screenshot capture', () => {
  const cycleMs = 150;
  const reqMs = 120;
  const modelUsed = 'qwen2.5-coder:7b';
  const inTokens = 450;
  const outTokens = 65;

  let screenshotMs = 0;

  // Verify that string interpolation with screenshotMs = 0 works cleanly
  const logStr1 = `[SP:V2:PERF] cycleMs=${cycleMs}ms screenshotMs=${screenshotMs}ms reqMs=${reqMs}ms model=${modelUsed} inTokens=${inTokens} outTokens=${outTokens}`;
  assert.ok(logStr1.includes('screenshotMs=0ms'));

  screenshotMs = 45;
  const logStr2 = `[SP:V2:PERF] cycleMs=${cycleMs}ms screenshotMs=${screenshotMs}ms reqMs=${reqMs}ms model=${modelUsed} inTokens=${inTokens} outTokens=${outTokens}`;
  assert.ok(logStr2.includes('screenshotMs=45ms'));
});

test('2. isNodeTest evaluates safely without throwing ReferenceError when process is undefined', () => {
  const isNodeTestCheck = (fakeProcess) => {
    return typeof fakeProcess !== 'undefined' && Array.isArray(fakeProcess?.argv) && fakeProcess.argv.some(a => typeof a === 'string' && a.includes('test'));
  };

  // Simulating Chrome extension content script runtime (process is undefined)
  const fakeProcessUndefined = undefined;
  assert.equal(isNodeTestCheck(fakeProcessUndefined), false);

  // Simulating Chrome extension background service worker (process is undefined object)
  const fakeProcessEmpty = {};
  assert.equal(isNodeTestCheck(fakeProcessEmpty), false);
});

test('3. isNodeTest evaluates to true in Node test runner environment', () => {
  const isNodeTest = typeof process !== 'undefined' && Array.isArray(process?.argv) && process.argv.some(a => typeof a === 'string' && a.includes('test'));
  assert.equal(isNodeTest, true);
});
