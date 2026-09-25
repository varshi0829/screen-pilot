// ScreenPilot v2 — Ollama background proxy test suite
// Run: node extension/tests/ollama-proxy.test.mjs
//
// handleOllamaGenerate/handleOllamaCheck/handleOllamaCancel touch no chrome.*
// APIs — pure fetch/AbortController/setTimeout — so they're testable in plain
// Node with a stubbed global fetch. This is the coverage for a previously
// completely dead code path: OLLAMA_CANCEL had no handler at all, and the
// activeOllamaRequests map was populated but never read or cleaned up.

import assert from 'assert/strict';
import {
  handleOllamaGenerate,
  handleOllamaCheck,
  handleOllamaCancel,
  __getActiveRequestCount,
  __resolveTimeoutMsForTests,
} from '../services/ollama-proxy.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (err) { console.error(`  ✗  ${name}\n     ${err.message}`); fail++; }
}

const originalFetch = globalThis.fetch;
function restoreFetch() { globalThis.fetch = originalFetch; }

console.log('\nOllama background proxy\n');

await test('handleOllamaGenerate: success path removes the tracked request', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: '{"action":"click"}' }) });
  const before = __getActiveRequestCount();
  const result = await handleOllamaGenerate({ reqId: 'req_1', body: {} });
  restoreFetch();
  assert.equal(result.success, true);
  assert.equal(__getActiveRequestCount(), before, 'map entry must be removed on success, not just on error');
});

await test('handleOllamaGenerate: HTTP-error path still removes the tracked request', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const before = __getActiveRequestCount();
  const result = await handleOllamaGenerate({ reqId: 'req_2', body: {} });
  restoreFetch();
  assert.equal(result.success, false);
  assert.equal(__getActiveRequestCount(), before, 'HTTP-error path leaked a map entry before this fix (no finally block)');
});

await test('handleOllamaGenerate: thrown-exception path still removes the tracked request', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const before = __getActiveRequestCount();
  const result = await handleOllamaGenerate({ reqId: 'req_3', body: {} });
  restoreFetch();
  assert.equal(result.success, false);
  assert.equal(__getActiveRequestCount(), before, 'exception path leaked a map entry before this fix (clearTimeout/delete were never reached)');
});

await test('handleOllamaCancel: aborts the correct in-flight request', async () => {
  let sawAbort = false;
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { sawAbort = true; reject(new DOMException('aborted', 'AbortError')); });
  });

  const genPromise = handleOllamaGenerate({ reqId: 'req_cancel', body: {} });
  // Let handleOllamaGenerate register the controller in the map before cancelling.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(__getActiveRequestCount(), 1, 'controller should be tracked while in flight');

  const cancelResult = await handleOllamaCancel({ reqId: 'req_cancel' });
  const genResult = await genPromise;
  restoreFetch();

  assert.equal(cancelResult.success, true);
  assert.equal(sawAbort, true, 'the actual fetch AbortSignal must fire — this was previously impossible since OLLAMA_CANCEL had no handler at all');
  assert.equal(genResult.success, false);
  assert.equal(genResult.errorCode, 'ABORTED', 'a caller-initiated cancel must be distinguishable from the 60s timeout');
  assert.equal(__getActiveRequestCount(), 0);
});

await test('handleOllamaCancel: unknown reqId is a safe no-op, does not throw', async () => {
  const result = await handleOllamaCancel({ reqId: 'never-existed' });
  assert.equal(result.success, false);
});

await test('handleOllamaCheck: reports available on 200 OK', async () => {
  globalThis.fetch = async () => ({ ok: true });
  const result = await handleOllamaCheck({});
  restoreFetch();
  assert.equal(result.available, true);
});

await test('handleOllamaCheck: reports unavailable when fetch throws', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const result = await handleOllamaCheck({});
  restoreFetch();
  assert.equal(result.available, false);
});

// ── P0 #3: per-request timeout propagation ────────────────────────────────
//
// Production requests go local-qwen-adapter.js / local-vision-adapter.js ->
// chrome.runtime.sendMessage(OLLAMA_GENERATE) -> background.js ->
// handleOllamaGenerate -> Ollama. Each adapter's own *_GENERATE_TIMEOUT_MS
// constant only ever applied to its direct-fetch fallback (never used in the
// real extension) — the proxy always used its own fixed 15s regardless.
// These tests prove message.timeoutMs now actually controls the proxy's
// timeout, with the 15s default and validation preserved.

await test('resolveTimeoutMs (validation): a valid supplied timeout is used as-is', async () => {
  assert.equal(__resolveTimeoutMsForTests(5000), 5000);
  assert.equal(__resolveTimeoutMsForTests(1), 1);
  assert.equal(__resolveTimeoutMsForTests(60000), 60000);
});

// Must track ollama-proxy.js's OLLAMA_GENERATE_TIMEOUT_MS. Raised from 15s
// after re-benchmarking the real Qwen prompt (17-25s measured); the fallback
// BEHAVIOUR asserted below is unchanged.
const DEFAULT_TIMEOUT_MS = 45000;

await test('resolveTimeoutMs (default): a missing timeout falls back to the default', async () => {
  assert.equal(__resolveTimeoutMsForTests(undefined), DEFAULT_TIMEOUT_MS);
});

await test('resolveTimeoutMs (validation): invalid values (NaN, zero, negative, non-number, null) all safely fall back to the default', async () => {
  assert.equal(__resolveTimeoutMsForTests(NaN), DEFAULT_TIMEOUT_MS);
  assert.equal(__resolveTimeoutMsForTests(0), DEFAULT_TIMEOUT_MS);
  assert.equal(__resolveTimeoutMsForTests(-1), DEFAULT_TIMEOUT_MS);
  assert.equal(__resolveTimeoutMsForTests(-5000), DEFAULT_TIMEOUT_MS);
  assert.equal(__resolveTimeoutMsForTests('5000'), DEFAULT_TIMEOUT_MS, 'a string must not be coerced — only an actual number is trusted');
  assert.equal(__resolveTimeoutMsForTests(null), DEFAULT_TIMEOUT_MS);
  assert.equal(__resolveTimeoutMsForTests(Infinity), DEFAULT_TIMEOUT_MS, 'Infinity is a number but not finite — must not produce a never-firing timeout');
  assert.equal(__resolveTimeoutMsForTests({}), DEFAULT_TIMEOUT_MS);
});

await test('handleOllamaGenerate: a supplied timeoutMs actually governs when the request aborts (short-circuits well before the 15s default)', async () => {
  let sawAbort = false;
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    // Never resolves on its own — only the timeout (or a cancel) can end this.
    signal.addEventListener('abort', () => { sawAbort = true; reject(new DOMException('aborted', 'AbortError')); });
  });

  const t0 = Date.now();
  const result = await handleOllamaGenerate({ reqId: 'req_short_timeout', body: {}, timeoutMs: 30 });
  const elapsedMs = Date.now() - t0;
  restoreFetch();

  assert.equal(sawAbort, true);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'TIMEOUT');
  assert.ok(elapsedMs < 1000, `a 30ms timeoutMs must not wait anywhere near the 15s default (took ${elapsedMs}ms)`);
});

await test('handleOllamaGenerate: an invalid supplied timeoutMs does not break the request — it behaves exactly like the omitted-default case', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: '{"action":"click"}' }) });
  const result = await handleOllamaGenerate({ reqId: 'req_invalid_timeout', body: {}, timeoutMs: -100 });
  restoreFetch();
  assert.equal(result.success, true, 'an invalid timeoutMs must not prevent the request from completing normally');
});

await test('handleOllamaCancel: cancellation and active-request cleanup still work when a custom timeoutMs is supplied', async () => {
  let sawAbort = false;
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { sawAbort = true; reject(new DOMException('aborted', 'AbortError')); });
  });

  const genPromise = handleOllamaGenerate({ reqId: 'req_cancel_custom_timeout', body: {}, timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(__getActiveRequestCount(), 1, 'controller should be tracked while in flight');

  const cancelResult = await handleOllamaCancel({ reqId: 'req_cancel_custom_timeout' });
  const genResult = await genPromise;
  restoreFetch();

  assert.equal(cancelResult.success, true);
  assert.equal(sawAbort, true);
  assert.equal(genResult.success, false);
  assert.equal(genResult.errorCode, 'ABORTED', 'a caller-initiated cancel must still be distinguishable from a timeout when timeoutMs is custom');
  assert.equal(__getActiveRequestCount(), 0, 'active-request cleanup must still run');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
