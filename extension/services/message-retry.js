// ScreenPilot v2 — bounded retry for chrome.tabs.sendMessage against a content
// script that may not have registered its onMessage listener yet.
//
// Root cause: content scripts are declared run_at: "document_idle", but on a
// heavy/slow-loading page the tab's URL can already reflect the new page while
// injection + top-level module init (and therefore listener registration) is
// still several seconds out. A message sent in that window fails with
// "Could not establish connection. Receiving end does not exist." even though
// the content script would have loaded fine moments later. This module retries
// ONLY that specific transient error, with a small bounded backoff — any other
// rejection (a real content-script/task error) fails immediately, unretried.
//
// Touches no chrome.* APIs directly — the caller supplies its own send
// function — so this is unit-testable in plain Node.

const RECEIVER_NOT_FOUND_MARKER = 'Receiving end does not exist';

// Gaps between attempts, ms. Sum = 2250ms of additional waiting on top of the
// immediate first attempt, keeping the total retry budget in the ~2-3s range
// called for by the fix requirements. This does not chase the full 8-9s worst
// case seen under heavy CPU/network throttling in the HubSpot repro — it's
// sized to resolve the common heavy-page case without hanging the popup UI on
// the rare, more extreme tail.
const DEFAULT_RETRY_DELAYS_MS = [150, 300, 600, 1200];

export function isReceiverNotFoundError(err) {
  const msg = err?.message || String(err || '');
  return msg.includes(RECEIVER_NOT_FOUND_MARKER);
}

/**
 * Attempts sendFn() immediately; on a "Receiving end does not exist" rejection
 * only, waits and retries per `delays` (default DEFAULT_RETRY_DELAYS_MS) until
 * one attempt succeeds or the delay budget is exhausted. Any other rejection
 * propagates immediately, unretried. Resolves with sendFn()'s resolved value;
 * rejects with the last error once the budget is exhausted.
 *
 * @param {() => Promise<any>} sendFn
 * @param {{ delays?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function sendWithRetry(sendFn, opts = {}) {
  const delays = opts.delays || DEFAULT_RETRY_DELAYS_MS;
  const sleep  = opts.sleep  || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      if (!isReceiverNotFoundError(err)) throw err;
      if (attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }
  throw lastErr;
}
