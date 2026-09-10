// ScreenPilot v3 — Local Vision PERCEPTION Adapter (privacy-vision Phase 2, corrected)
//
// This is a VISUAL PERCEPTION component, not a second independent planner.
// Implements BackendAdapter for a local Ollama-hosted multimodal model
// (default "moondream"), whose only job is: given a screenshot, the goal, and
// the DOM elements PageStateService already extracted, point at which ONE of
// those existing elements looks right. It may only ever reference an
// elementId that was handed to it — it cannot invent selectors, click
// anything, or produce a full multi-step plan. Turning a validated pick into
// an executable step is the router's job (DecisionRouter._buildPlanFromElement
// — the exact same helper L1/L2 already use), so there is exactly one place
// in the codebase that shapes a PlanResponse from a resolved element.
//
// Mirrors local-qwen-adapter.js's availability/timeout/proxying plumbing
// (that part is genuinely shared shape), but plan() here returns a small
// perception result — { result, elementId, action, confidence, reason } —
// not a PlanResponse.
//
// Screenshot contract: the caller MUST pass the already-sanitized screenshot
// (see PageStateService/ScreenshotService's PrivacySanitizer redaction) as
// request.page.screenshot.image. This adapter never captures a screenshot
// itself and never talks to any endpoint other than local Ollama.

import { BackendAdapter } from './interface.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL      = 'moondream';
const DEFAULT_KEEP_ALIVE = '5m';

// SIH 2026 demo latency fix: this used to copy Qwen's 15s budget verbatim,
// but Moondream (~1.8B) is a much smaller/faster model than qwen2.5-coder:7b
// (7B) — a 15s timeout meant a stuck/slow vision call could block the entire
// task for 15s before Qwen/cloud fallback even started. Still not benchmarked
// on real hardware (revisit once it is, the same way QWEN_GENERATE_TIMEOUT_MS's
// own comment describes), but 8s is a deliberately tighter, still-generous
// budget for a model this size, so a hang degrades to fallback fast instead
// of stalling the whole demo.
const VISION_GENERATE_TIMEOUT_MS     = 8_000;
const VISION_AVAILABILITY_TIMEOUT_MS = 2_500;

export class LocalVisionAdapter extends BackendAdapter {
  /**
   * @param {object} [options]
   * @param {string} [options.ollamaUrl] - Local Ollama server URL (defaults to http://127.0.0.1:11434)
   * @param {string} [options.model]     - Local vision model name (defaults to "moondream")
   * @param {string} [options.keepAlive] - Model warm duration (defaults to "5m")
   */
  constructor({ ollamaUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_MODEL, keepAlive = DEFAULT_KEEP_ALIVE } = {}) {
    super();
    this._ollamaUrl = ollamaUrl.replace(/\/$/, '');
    this._model     = model;
    this._keepAlive = keepAlive;
  }

  get name() { return 'LocalVisionAdapter'; }

  /**
   * Identify which one existing element (if any) visually matches the next
   * step toward the goal. NOT a planner call — returns a minimal perception
   * result, never a full PlanResponse. The caller (DecisionRouter) is
   * responsible for validating the returned elementId against the current
   * page-state element list before trusting it.
   *
   * @param {{goal:string, page:{url?:string, title?:string, screenshot?:{image:string,mimeType?:string}}, elements?:object[]}} request
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{result:'OK', elementId:string|null, action:string|null, confidence:number, reason:string}|{result:'FAILED', error:string, errorCode:string}>}
   */
  async plan(request, options = {}) {
    const t0 = Date.now();
    const callerSignal = options?.signal;
    const reqId = request?.requestId || `req_vision_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    console.log(`[SP:V2:DEBUG] LocalVisionAdapter request start reqId=${reqId} model=${this._model}`);

    if (callerSignal?.aborted) {
      return this._networkFailure('Request aborted', 'ABORTED');
    }

    const imageBase64 = request?.page?.screenshot?.image;
    if (!imageBase64) {
      // Defense-in-depth: a caller that forgets to attach a screenshot must not
      // silently be treated as a text-only Qwen-style request — vision needs
      // an image, full stop.
      return this._networkFailure('No screenshot provided for local vision reasoning', 'NO_SCREENSHOT');
    }

    const prompt = this._buildVisionPrompt(request);
    const targetUrl = `${this._ollamaUrl}/api/generate`;
    const requestBody = {
      model:      this._model,
      prompt,
      images:     [imageBase64],
      format:     'json',
      stream:     false,
      keep_alive: this._keepAlive,
      options: {
        temperature: 0,
        num_predict: 128
      }
    };

    let data = null;
    let isSuccess = false;

    // Same background-proxy pattern as LocalQwenAdapter: a direct fetch from a
    // content-script context to a local http:// endpoint is blocked by Chrome's
    // Private Network Access policy on real https:// sites, so route through
    // the background service worker (background.js's OLLAMA_GENERATE handler,
    // services/ollama-proxy.js) when available, falling back to a direct
    // fetch for non-extension contexts (e.g. these unit tests).
    const hasChromeRuntime = typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;

    if (hasChromeRuntime) {
      try {
        let abortHandler = null;
        if (callerSignal) {
          abortHandler = () => {
            try { chrome.runtime.sendMessage({ type: 'OLLAMA_CANCEL', reqId }); } catch { /* ignore */ }
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

        if (!bgResp?.success) {
          console.error(`[SP:V2:DEBUG] Background Ollama proxy failed (vision) reqId=${reqId}: ${bgResp?.error}`);
          const errCode = bgResp?.errorCode || (callerSignal?.aborted ? 'ABORTED' : 'OLLAMA_UNAVAILABLE');
          return this._networkFailure(bgResp?.error || 'Background Ollama proxy failed', errCode);
        }

        data = bgResp.data;
        isSuccess = true;
      } catch (proxyErr) {
        console.error(`[SP:V2:DEBUG] Background proxy error (vision) reqId=${reqId} message=${proxyErr?.message}`);
        // Fall back to direct fetch if message passing fails.
      }
    }

    if (!isSuccess) {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => {
        controller.abort(`vision_timeout_${VISION_GENERATE_TIMEOUT_MS}ms`);
      }, VISION_GENERATE_TIMEOUT_MS);

      if (callerSignal) {
        callerSignal.addEventListener('abort', () => {
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
        const isCallerAborted = callerSignal?.aborted;
        const isTimeout       = err instanceof Error && err.name === 'AbortError' && !isCallerAborted;
        const message         = isCallerAborted
          ? 'Local vision request was aborted'
          : isTimeout
            ? 'Local vision inference timed out'
            : (err instanceof Error ? err.message : String(err));
        const errorCode       = isCallerAborted ? 'ABORTED' : isTimeout ? 'TIMEOUT' : 'OLLAMA_UNAVAILABLE';
        return this._networkFailure(message, errorCode);
      }

      if (!upstream.ok) {
        return this._networkFailure(`Ollama returned status ${upstream.status}`, 'OLLAMA_ERROR');
      }

      data = await upstream.json().catch(() => null);
    }

    const rawResponse = data?.response ?? '';
    const latencyMs   = Date.now() - t0;
    console.log(`[SP:V2:PERF] visionLatencyMs=${latencyMs} model=${this._model}`);

    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      return this._networkFailure('Local vision model returned invalid JSON', 'PARSE_ERROR');
    }

    console.log(`[SP:V2:DEBUG] LocalVisionAdapter perception result reqId=${reqId} elementId=${parsed?.elementId ?? 'null'} action=${parsed?.action ?? 'n/a'}`);
    return this._formatPerceptionResult(parsed);
  }

  async recover(request, options = {}) {
    return this.plan(request, options);
  }

  async explain() {
    return { success: true, screenContext: { application: 'Web App', pageType: 'other' } };
  }

  async ask() {
    return { success: true, answer: 'Local vision screen analysis complete.' };
  }

  estimateCost() {
    return { inputTokens: 0, outputTokens: 0, estimatedUSD: 0 };
  }

  /**
   * Same proxy-with-direct-fetch-fallback pattern as LocalQwenAdapter.checkAvailability.
   */
  async checkAvailability() {
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
          new Promise((resolve) => setTimeout(() => resolve({ __proxyTimeout: true }), VISION_AVAILABILITY_TIMEOUT_MS)),
        ]);
        if (!proxied.__proxyFailed && !proxied.__proxyTimeout) {
          return proxied.available
            ? { available: true }
            : { available: false, reason: proxied.error || ('Ollama server not reachable at ' + this._ollamaUrl) };
        }
        if (proxied.__proxyTimeout) {
          return { available: false, reason: 'Ollama availability check timed out at ' + this._ollamaUrl };
        }
      } catch {
        // Fall through to direct fetch.
      }
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort('availability_timeout'), VISION_AVAILABILITY_TIMEOUT_MS);
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

  /**
   * Minimum useful context for the vision model: the goal, and a compact
   * (already-sanitized, already-capped) list of interactive elements with
   * stable ids — not the full page state. The screenshot itself carries the
   * visual context; this text just gives the model the fixed vocabulary of
   * ids it is allowed to answer with.
   */
  _buildVisionPrompt(request) {
    const page     = request.page ?? {};
    const elements = request.elements ?? [];

    const compactElements = elements.slice(0, 25).map(e => ({
      id: e.id,
      role: e.role,
      text: e.text || e.ariaLabel || e.placeholder || ''
    }));

    return `Goal: "${request.goal}"
Page: ${page.title || ''} (${page.url || ''})

You are a VISUAL PERCEPTION assistant, not a planner. You are shown a
screenshot of the current page (sensitive fields are already blacked out
locally — you will never see real passwords, emails, or card numbers).

Known interactive elements already extracted from the page (id, role, text):
${JSON.stringify(compactElements)}

Using the screenshot, identify which ONE of the elements above is the
visually correct next target for the goal.

Rules:
- "elementId" MUST be copied exactly from the list above. Never invent,
  guess, or construct a new id.
- If none of the listed elements visually match, return elementId: null.

Return JSON ONLY:
{"action":"click"|"type"|"select"|"navigate","elementId":"el_12","confidence":0.91,"reason":"short reason"}`;
  }

  /**
   * Deliberately minimal: this is a perception result, not a plan. It names
   * which known element (if any) looks right and how confident the model is
   * — it does NOT shape a step/PlanResponse. DecisionRouter validates
   * elementId against the live page state and, only then, builds the actual
   * executable step via the same _buildPlanFromElement helper L1/L2 use.
   */
  _formatPerceptionResult(visionOutput) {
    return {
      result:     'OK',
      elementId:  typeof visionOutput?.elementId === 'string' ? visionOutput.elementId : null,
      action:     typeof visionOutput?.action === 'string' ? visionOutput.action : null,
      confidence: Number.isFinite(visionOutput?.confidence) ? Math.max(0, Math.min(1, visionOutput.confidence)) : 0,
      reason:     typeof visionOutput?.reason === 'string' ? visionOutput.reason : ''
    };
  }

  _networkFailure(error, errorCode) {
    return {
      schemaVersion: '1',
      result: 'FAILED',
      blockers: [],
      confidence: 0,
      providerMetadata: { provider: 'local-vision', model: this._model, latencyMs: 0 },
      error,
      errorCode
    };
  }
}
