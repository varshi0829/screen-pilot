// ScreenPilot v2 — Ollama background proxy
//
// Content scripts can't reliably fetch() http://127.0.0.1:11434 directly (mixed
// content / page CSP on https:// sites), so local-qwen-adapter.js proxies through
// the background service worker via OLLAMA_GENERATE/OLLAMA_CHECK/OLLAMA_CANCEL
// messages. Touches no chrome.* APIs — pure fetch/AbortController/setTimeout — so
// it's unit-testable in Node with a stubbed global fetch.

// Safe default — used whenever a caller doesn't supply message.timeoutMs, or
// supplies something unusable (see resolveTimeoutMs). Previously this was the
// ONLY timeout in effect for every proxied request regardless of which local
// adapter (Qwen vs Moondream) sent it, since each adapter's own *_GENERATE_TIMEOUT_MS
// constant only applied to its direct-fetch fallback path, never to the
// proxied path actually used in the real extension. Callers now pass their
// own configured timeout per request (see resolveTimeoutMs below).
// Kept in step with local-qwen-adapter.js's QWEN_GENERATE_TIMEOUT_MS — see the
// re-benchmark recorded there. Only applies when a caller sends no timeoutMs
// of its own; both local adapters send theirs explicitly.
const OLLAMA_GENERATE_TIMEOUT_MS = 45_000;

const activeOllamaRequests = new Map();

// Accepts only a finite, positive number — anything else (missing, NaN,
// zero, negative, a string, etc.) falls back to the safe default rather than
// producing a broken/instant/never-firing timeout.
function resolveTimeoutMs(candidate) {
  return (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0)
    ? candidate
    : OLLAMA_GENERATE_TIMEOUT_MS;
}

export async function handleOllamaGenerate(message) {
  const reqId = message.reqId || `req_bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const url = message.url || 'http://127.0.0.1:11434/api/generate';
  const timeoutMs = resolveTimeoutMs(message.timeoutMs);
  const t0 = Date.now();

  const controller = new AbortController();
  activeOllamaRequests.set(reqId, controller);

  console.log(`[SP:V2:DEBUG] [Background] controller_created reqId=${reqId} signalAborted=${controller.signal.aborted}`);
  console.log(`[SP:V2:DEBUG] [Background] request_lifecycle status=start reqId=${reqId} url=${url} timeoutMs=${timeoutMs}`);

  const timeoutId = setTimeout(() => {
    console.log(`[SP:V2:DEBUG] [Background] abort_reason reqId=${reqId} reason=ollama_timeout_${timeoutMs}ms`);
    controller.abort(`ollama_timeout_${timeoutMs}ms`);
  }, timeoutMs);

  try {
    console.log(`[SP:V2:DEBUG] [Background] signal_start reqId=${reqId} aborted=${controller.signal.aborted}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.body),
      signal: controller.signal
    });
    if (!res.ok) {
      console.error(`[SP:V2:DEBUG] [Background] OLLAMA_GENERATE HTTP error status=${res.status}`);
      return { success: false, error: `Ollama status ${res.status}` };
    }
    const data = await res.json();
    console.log(`[SP:V2:DEBUG] [Background] OLLAMA_GENERATE success latencyMs=${Date.now() - t0}`);
    return { success: true, data };
  } catch (err) {
    // A cancelled request and a timed-out request both surface as AbortError from
    // fetch() — the abort reason (set at the controller.abort(reason) call site) is
    // the only way to tell them apart. Mirrors the same distinction local-qwen-adapter.js
    // already makes on its own direct-fetch fallback path.
    const reason = controller.signal.reason;
    const isCancelled = reason === 'caller_cancelled';
    console.error(`[SP:V2:DEBUG] [Background] OLLAMA_GENERATE exception name=${err?.name} message=${err?.message} reason=${reason}`);
    return {
      success: false,
      error: err?.message || String(err),
      errorCode: isCancelled ? 'ABORTED' : (err?.name === 'AbortError' ? 'TIMEOUT' : 'OLLAMA_UNAVAILABLE'),
    };
  } finally {
    // Unconditional on every exit path — previously clearTimeout only ran on the
    // success path, and this map entry was never deleted at all (slow leak, and
    // OLLAMA_CANCEL had nothing to look up even once it got a handler).
    clearTimeout(timeoutId);
    activeOllamaRequests.delete(reqId);
  }
}

export async function handleOllamaCheck(message) {
  const url = message.url || 'http://127.0.0.1:11434/api/tags';
  try {
    const res = await fetch(url, { method: 'GET' });
    return { available: res.ok };
  } catch (err) {
    return { available: false, error: err?.message || String(err) };
  }
}

export async function handleOllamaCancel(message) {
  const controller = activeOllamaRequests.get(message.reqId);
  if (!controller) {
    return { success: false, error: 'No active request for reqId' };
  }
  controller.abort('caller_cancelled');
  activeOllamaRequests.delete(message.reqId);
  return { success: true };
}

// Test-only accessor — never used by background.js itself.
export function __getActiveRequestCount() {
  return activeOllamaRequests.size;
}

// Test-only accessor for the validation/fallback logic — never used by
// background.js itself (handleOllamaGenerate calls the private function directly).
export function __resolveTimeoutMsForTests(candidate) {
  return resolveTimeoutMs(candidate);
}
