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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
