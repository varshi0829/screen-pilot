// ScreenPilot v2 — message-retry test suite
// Run: node extension/tests/message-retry.test.mjs
//
// sendWithRetry touches no chrome.* APIs — the caller injects its own send
// function and sleep — so it's testable in plain Node with a fake clock
// (injected `sleep`) rather than real timers.

import assert from 'assert/strict';
import { sendWithRetry, isReceiverNotFoundError } from '../services/message-retry.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓  ${name}`); pass++; }
  catch (err) { console.error(`  ✗  ${name}\n     ${err.message}`); fail++; }
}

const RECEIVER_NOT_FOUND = new Error('Could not establish connection. Receiving end does not exist.');
const OTHER_ERROR = new Error('Extension context invalidated.');

function fakeSleep(log) {
  return async (ms) => { log.push(ms); };
}

console.log('\nmessage-retry\n');

await test('isReceiverNotFoundError: matches the exact Chrome message', () => {
  assert.equal(isReceiverNotFoundError(RECEIVER_NOT_FOUND), true);
});

await test('isReceiverNotFoundError: does not match unrelated errors', () => {
  assert.equal(isReceiverNotFoundError(OTHER_ERROR), false);
});

await test('immediate success: sendFn resolves on first attempt, no retries, no sleep', async () => {
  let calls = 0;
  const sleepLog = [];
  const result = await sendWithRetry(async () => { calls++; return { success: true }; }, { sleep: fakeSleep(sleepLog) });
  assert.deepEqual(result, { success: true });
  assert.equal(calls, 1, 'must not retry when the first attempt succeeds');
  assert.deepEqual(sleepLog, [], 'must not sleep when the first attempt succeeds');
});

await test('receiver-not-found once, then success', async () => {
  let calls = 0;
  const sleepLog = [];
  const result = await sendWithRetry(async () => {
    calls++;
    if (calls === 1) throw RECEIVER_NOT_FOUND;
    return { success: true };
  }, { sleep: fakeSleep(sleepLog) });
  assert.deepEqual(result, { success: true });
  assert.equal(calls, 2);
  assert.equal(sleepLog.length, 1, 'exactly one backoff wait before the second attempt');
});

await test('receiver-not-found multiple times, then success', async () => {
  let calls = 0;
  const sleepLog = [];
  const result = await sendWithRetry(async () => {
    calls++;
    if (calls < 4) throw RECEIVER_NOT_FOUND;
    return { success: true };
  }, { sleep: fakeSleep(sleepLog) });
  assert.deepEqual(result, { success: true });
  assert.equal(calls, 4);
  assert.equal(sleepLog.length, 3, 'one backoff wait per failed attempt before the success');
});

await test('receiver-not-found exhausting the budget: rejects with the last error, stays bounded', async () => {
  let calls = 0;
  const sleepLog = [];
  const delays = [150, 300, 600, 1200];
  await assert.rejects(
    () => sendWithRetry(async () => { calls++; throw RECEIVER_NOT_FOUND; }, { delays, sleep: fakeSleep(sleepLog) }),
    (err) => isReceiverNotFoundError(err)
  );
  assert.equal(calls, delays.length + 1, 'one immediate attempt plus one per delay slot, then stop');
  assert.deepEqual(sleepLog, delays, 'must sleep exactly the configured schedule, then give up — bounded, not infinite');
});

await test('non-transient error is not retried: fails on the very first attempt', async () => {
  let calls = 0;
  const sleepLog = [];
  await assert.rejects(
    () => sendWithRetry(async () => { calls++; throw OTHER_ERROR; }, { sleep: fakeSleep(sleepLog) }),
    (err) => err === OTHER_ERROR
  );
  assert.equal(calls, 1, 'a non-transient error must fail fast, no retry attempts');
  assert.deepEqual(sleepLog, [], 'a non-transient error must not incur any backoff wait');
});

await test('successful response value is passed through unchanged (any shape)', async () => {
  const payload = { success: true, nested: { a: 1 }, arr: [1, 2, 3] };
  const result = await sendWithRetry(async () => payload, { sleep: fakeSleep([]) });
  assert.equal(result, payload, 'must be the exact same value/reference, not a copy or wrapper');
});

await test('final failure after budget exhaustion is the same Error the underlying send threw', async () => {
  let caught = null;
  try {
    await sendWithRetry(async () => { throw RECEIVER_NOT_FOUND; }, { delays: [10], sleep: fakeSleep([]) });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught, RECEIVER_NOT_FOUND, 'callers (e.g. background.js startV2Task) must see the same error shape as before, for their existing catch-and-report-error behavior');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
