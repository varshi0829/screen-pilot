// ScreenPilot v2 — Local Qwen Backend Adapter
//
// Implements BackendAdapter for local Ollama-hosted Qwen models (qwen2.5-coder:7b).
// Executes completely locally without cloud APIs, external keys, or remote servers.
// Uses `keep_alive: "5m"` to keep model warm in memory and `temperature: 0` for fast CPU evaluation.

import { BackendAdapter } from './interface.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL      = 'qwen2.5-coder:7b';
const DEFAULT_KEEP_ALIVE = '5m';

// Qwen is now an opt-in L3 backend that falls back to Cloud on failure, so it
// must release control well before that becomes a stuck-planner problem.
// Measured on real hardware with the actual production prompt (qwen2.5-coder:7b,
// CPU-only, this repo's page-state/goal prompt shape, not a trivial one-liner):
// ~11.4s warm (steady-state, keep_alive keeps it warm for 5m between calls),
// ~22.9s cold (first call after the model has unloaded). Earlier docs/memory
// citing "~1.8s" were a stale/lighter benchmark — do not trust that figure.
// 15s leaves only ~3.6s margin over the measured warm baseline on this
// hardware and will essentially always miss a cold load — the first Qwen call
// of an idle session should be expected to fall back to Cloud, then
// subsequent calls in that session hit the warm path. If warm calls start
// timing out in practice (slower CPUs, larger prompts, system load), this is
// the first constant to revisit — re-benchmark before raising it. Must match
// ollama-proxy.js's OLLAMA_GENERATE_TIMEOUT_MS.
const QWEN_GENERATE_TIMEOUT_MS      = 15_000;
// Cheap /api/tags liveness probe before attempting a full generate call, so an
// unreachable Ollama fails fast instead of waiting out the generate timeout.
const QWEN_AVAILABILITY_TIMEOUT_MS  = 2_500;

export class LocalQwenAdapter extends BackendAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.ollamaUrl] - Local Ollama server URL (defaults to http://127.0.0.1:11434)
   * @param {string} [options.model]     - Local model name (defaults to qwen2.5-coder:7b)
   * @param {string} [options.keepAlive] - Model warm duration (defaults to "5m")
   */
  constructor({ ollamaUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_MODEL, keepAlive = DEFAULT_KEEP_ALIVE } = {}) {
    super();
    this._ollamaUrl = ollamaUrl.replace(/\/$/, '');
    this._model     = model;
    this._keepAlive = keepAlive;
  }

  get name() { return 'LocalQwenAdapter'; }

  /**
   * Plan 1 action at a time from a goal and current page state.
   *
   * @param {import('../shared/types/index.js').PlanRequest} request
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<import('../shared/types/index.js').PlanResponse>}
   */
  async plan(request, options = {}) {
    const t0 = Date.now();
    const callerSignal = options?.signal;
    const reqId = request?.requestId || `req_qwen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    console.log(`[SP:V2:DEBUG] controller_id reqId=${reqId}`);
    console.log(`[SP:V2:DEBUG] signal_before_request reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);

    if (callerSignal?.aborted) {
      console.log(`[SP:V2:DEBUG] LocalQwenAdapter callerSignal already aborted reqId=${reqId} reason=${callerSignal.reason}`);
      return this._networkFailure('Request aborted', 'ABORTED');
    }

    const prompt = this._buildQwenPrompt(request);
    const targetUrl = `${this._ollamaUrl}/api/generate`;
    const requestBody = {
      model:      this._model,
      prompt,
      format:     'json',
      stream:     false,
      keep_alive: this._keepAlive,
      options: {
        temperature: 0,
        num_predict: 128
      }
    };

    console.log(`[SP:V2:DEBUG] LocalQwenAdapter request start reqId=${reqId} url=${targetUrl} method=POST startMs=${t0} callerAborted=${callerSignal?.aborted ?? false}`);
    console.log(`[SP:V2:DEBUG] signal_start reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);
    console.log(`[SP:V2:DEBUG] request_lifecycle status=start reqId=${reqId}`);

    let data = null;
    let isSuccess = false;

    // In Chrome extension content script context, proxy fetch through background service worker
    // to bypass page Mixed Content (HTTP from HTTPS) and CSP restrictions.
    const hasChromeRuntime = typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;

    if (hasChromeRuntime) {
      try {
        console.log(`[SP:V2:DEBUG] Proxying Ollama request via chrome.runtime.sendMessage(OLLAMA_GENERATE) reqId=${reqId}`);

        // Listen for callerSignal abort while background message is in flight
        let abortHandler = null;
        if (callerSignal) {
          abortHandler = () => {
            console.log(`[SP:V2:DEBUG] callerSignal aborted during proxy call reqId=${reqId} reason=${callerSignal.reason}`);
            try {
              chrome.runtime.sendMessage({ type: 'OLLAMA_CANCEL', reqId });
            } catch { /* ignore */ }
          };
          callerSignal.addEventListener('abort', abortHandler, { once: true });
        }

        const bgResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'OLLAMA_GENERATE',
            reqId,
            url: targetUrl,
            body: requestBody
          }, (response) => {
            if (callerSignal && abortHandler) {
              callerSignal.removeEventListener('abort', abortHandler);
            }
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(response || { success: false, error: 'No response from background script' });
            }
          });
        });

        console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${callerSignal?.aborted ?? false}`);
        console.log(`[SP:V2:DEBUG] request_lifecycle status=end reqId=${reqId} latencyMs=${Date.now() - t0}`);

        if (!bgResp?.success) {
          console.error(`[SP:V2:DEBUG] Background Ollama proxy failed reqId=${reqId}: ${bgResp?.error}`);
          const errCode = bgResp?.errorCode || (callerSignal?.aborted ? 'ABORTED' : 'OLLAMA_UNAVAILABLE');
          return this._networkFailure(bgResp?.error || 'Background Ollama proxy failed', errCode);
        }

        data = bgResp.data;
        isSuccess = true;
      } catch (proxyErr) {
        console.error(`[SP:V2:DEBUG] Background proxy error reqId=${reqId} name=${proxyErr?.name} message=${proxyErr?.message}`);
        // Fall back to direct fetch if message passing fails
      }
    }

    if (!isSuccess) {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => {
        console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=qwen_timeout_${QWEN_GENERATE_TIMEOUT_MS}ms`);
        controller.abort(`qwen_timeout_${QWEN_GENERATE_TIMEOUT_MS}ms`);
      }, QWEN_GENERATE_TIMEOUT_MS);

      if (callerSignal) {
        callerSignal.addEventListener('abort', () => {
          console.log(`[SP:V2:DEBUG] abort_reason reqId=${reqId} reason=${callerSignal.reason}`);
          controller.abort(callerSignal.reason || 'caller_aborted');
        }, { once: true });
      }

      let upstream;
      try {
        upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (err) {
        clearTimeout(timeoutId);
        const elapsedMs       = Date.now() - t0;
        const isCallerAborted = callerSignal?.aborted;
        const isTimeout       = err instanceof Error && err.name === 'AbortError' && !isCallerAborted;
        console.log(`[SP:V2:DEBUG] signal_end reqId=${reqId} aborted=${controller.signal.aborted} reason=${controller.signal.reason}`);
        console.log(`[SP:V2:DEBUG] request_lifecycle status=end reqId=${reqId} elapsedMs=${elapsedMs}`);
        console.error(`[SP:V2:DEBUG] LocalQwenAdapter direct fetch exception reqId=${reqId} url=${targetUrl} name=${err?.name} message=${err?.message} stack=${err?.stack}`);
        const message         = isCallerAborted
          ? 'Local Qwen request was aborted'
          : isTimeout
            ? 'Local Qwen inference timed out'
            : (err instanceof Error ? err.message : String(err));
        const errorCode       = isCallerAborted ? 'ABORTED' : isTimeout ? 'TIMEOUT' : 'OLLAMA_UNAVAILABLE';
        return this._networkFailure(message, errorCode);
      }

      if (!upstream.ok) {
        console.error(`[SP:V2:DEBUG] Ollama HTTP status error status=${upstream.status}`);
        return this._networkFailure(`Ollama returned status ${upstream.status}`, 'OLLAMA_ERROR');
      }

      data = await upstream.json().catch(() => null);
    }

    const rawResponse = data?.response ?? '';
    const latencyMs   = Date.now() - t0;

    console.log(`[SP:V2:PERF] qwenLatencyMs=${latencyMs} model=${this._model} keep_alive=${this._keepAlive}`);
    console.log(`[SP:V2:DEBUG] Ollama response received rawLen=${rawResponse.length} latencyMs=${latencyMs}`);

    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      return this._networkFailure('Local Qwen returned invalid JSON', 'PARSE_ERROR');
    }

    return this._formatPlanResponse(request, parsed, latencyMs);
  }

  async recover(request, options = {}) {
    return this.plan(request, options);
  }

  async explain() {
    return { success: true, screenContext: { application: 'Web App', pageType: 'other' } };
  }

  async ask() {
    return { success: true, answer: 'Local Qwen screen analysis complete.' };
  }

  estimateCost() {
    return { inputTokens: 0, outputTokens: 0, estimatedUSD: 0 };
  }

  async checkAvailability() {
    // Real-Chrome finding: a direct fetch() from THIS content-script context to
    // http://127.0.0.1:11434 works fine on a plain-http local page (no policy
    // gate applies loopback-to-loopback) but is silently blocked by Chrome's
    // Private Network Access policy when the current tab is a real https://
    // site (i.e. virtually every real website) — the request never resolves
    // or rejects, it just hangs until this function's own timeout fires. That
    // made local-Qwen mode ALWAYS report "unavailable" and fall back to Cloud
    // on real sites regardless of whether Ollama was actually running,
    // burning the full QWEN_AVAILABILITY_TIMEOUT_MS every time. The
    // OLLAMA_GENERATE call below already avoids this by proxying through the
    // background service worker (a privileged extension context PNA doesn't
    // gate) via chrome.runtime.sendMessage — background.js's OLLAMA_CHECK
    // handler (services/ollama-proxy.js) already existed for exactly this,
    // it just was never wired up here. Mirror the same proxy-with-fallback
    // pattern plan() uses below, so a non-extension/test context (no chrome
    // global) keeps working via the direct fetch.
    const hasChromeRuntime = typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;

    if (hasChromeRuntime) {
      try {
        const proxied = await Promise.race([
          new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'OLLAMA_CHECK', url: `${this._ollamaUrl}/api/tags` }, (response) => {
              if (chrome.runtime.lastError) resolve({ __proxyFailed: true });
              else resolve(response || { __proxyFailed: true });
            });
          }),
          new Promise((resolve) => setTimeout(() => resolve({ __proxyTimeout: true }), QWEN_AVAILABILITY_TIMEOUT_MS)),
        ]);
        if (!proxied.__proxyFailed && !proxied.__proxyTimeout) {
          return proxied.available
            ? { available: true }
            : { available: false, reason: proxied.error || ('Ollama server not reachable at ' + this._ollamaUrl) };
        }
        if (proxied.__proxyTimeout) {
          return { available: false, reason: 'Ollama availability check timed out at ' + this._ollamaUrl };
        }
        // __proxyFailed — background messaging itself broke; fall through to direct fetch below.
      } catch {
        // Fall through to direct fetch.
      }
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort('availability_timeout'), QWEN_AVAILABILITY_TIMEOUT_MS);
    try {
      const res = await fetch(`${this._ollamaUrl}/api/tags`, { method: 'GET', signal: controller.signal });
      return { available: res.ok };
    } catch {
      return { available: false, reason: 'Ollama server not reachable at ' + this._ollamaUrl };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _buildQwenPrompt(request) {
    const page      = request.page ?? {};
    const history   = request.executionHistory?.completedSteps ?? [];
    const elements  = request.elements ?? [];

    const compactElements = elements.slice(0, 25).map(e => ({
      id: e.id,
      role: e.role,
      text: e.text || e.ariaLabel || e.placeholder || ''
    }));

    return `Goal: "${request.goal}"
Page: ${page.title || ''} (${page.url || ''})
${history.length ? `History: ${history.map(h => h.description).join(' -> ')}` : ''}

Elements:
${JSON.stringify(compactElements)}

Select single action.
Return JSON ONLY:
{"action":"click"|"type"|"select"|"navigate"|"finish","elementId":"el_1","text":"label","confidence":0.95}`;
  }

  _formatPlanResponse(request, qwenOutput, latencyMs) {
    const action    = qwenOutput.action ?? 'click';
    const text      = qwenOutput.text || request.goal;
    const isFinish  = action === 'finish';
    const elementId = qwenOutput.elementId;

    if (isFinish) {
      return {
        schemaVersion: '1',
        result: 'OK',
        state: 'complete',
        blockers: [],
        plannerSummary: qwenOutput.reason || 'Goal completed.',
        confidence: qwenOutput.confidence ?? 0.9,
        providerMetadata: { provider: 'local-qwen', model: this._model, latencyMs, inputTokens: 0, outputTokens: 0 }
      };
    }

    const step = {
      id: 1,
      description: text,
      intent: text,
      phase: action === 'type' ? 'fill_form' : 'navigate',
      completionCondition: 'dom_change',
      targetElement: {
        text: text,
        type: action === 'type' ? 'input' : 'button',
        intent: qwenOutput.value ?? text,
        elementId
      },
      // Provisional — Qwen's own action verb is an unreliable signal for whether a
      // click actually navigates (it often labels a link click "click", not
      // "navigate"). v2-task.js's plan-loop enrichment step overrides this from the
      // resolved element's real tag/href when it can; this stays as the fallback.
      expectedPageState: { urlChanges: action === 'navigate' }
    };

    return {
      schemaVersion: '1',
      result: 'OK',
      state: 'planned',
      plannerSummary: `Action: ${action} on ${elementId ?? text}`,
      confidence: qwenOutput.confidence ?? 0.85,
      plan: {
        goalType: 'action',
        confidence: qwenOutput.confidence ?? 0.85,
        steps: [step]
      },
      providerMetadata: { provider: 'local-qwen', model: this._model, latencyMs, inputTokens: 0, outputTokens: 0 }
    };
  }

  _networkFailure(error, errorCode) {
    return {
      schemaVersion: '1',
      result: 'FAILED',
      blockers: [],
      confidence: 0,
      providerMetadata: { provider: 'local-qwen', model: this._model, latencyMs: 0 },
      error,
      errorCode
    };
  }
}
