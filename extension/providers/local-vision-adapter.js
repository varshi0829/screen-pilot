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
import { toCompactElement } from '../lib/compact-page-state.js';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL      = 'moondream';
const DEFAULT_KEEP_ALIVE = '5m';
// Numeric mirror of DEFAULT_KEEP_ALIVE, used only for this adapter's own
// warm-tracking bookkeeping (see _warmModelIfNeeded) — never sent to Ollama,
// which always receives the string form via keep_alive.
const DEFAULT_KEEP_ALIVE_MS = 5 * 60 * 1000;

// SIH 2026 demo latency fix: this used to copy Qwen's 15s budget verbatim,
// but Moondream (~1.8B) is a much smaller/faster model than qwen2.5-coder:7b
// (7B) — a 15s timeout meant a stuck/slow vision call could block the entire
// task for 15s before Qwen/cloud fallback even started. Tightened to 8s as a
// still-unbenchmarked guess, which real hardware then proved too tight: a
// warm Moondream's FIRST real vision generation measured ~10.2s (subsequent
// warm calls measured ~3.6s), so the 8s cap aborted every live vision
// request via the background proxy (ollama_timeout_8000ms) and fell through
// to cloud. 30s covers the measured 10.2s with real headroom while staying
// well under Qwen's own 45s budget (see QWEN_GENERATE_TIMEOUT_MS) — vision
// still degrades to fallback faster than text reasoning does, just no longer
// faster than Moondream can actually finish a real request.
const VISION_GENERATE_TIMEOUT_MS     = 30_000;
const VISION_AVAILABILITY_TIMEOUT_MS = 2_500;

// P1 #2: the screenshot handed to this adapter is already resized to 1024px
// wide (ScreenshotService.captureVisibleTab, shared with the cloud path) and
// already redacted (sensitiveRegions masking happens during that same
// capture, before this adapter — or any other consumer — ever sees the
// image). This adapter further downscales its OWN copy to ~512px before
// sending it to Moondream, purely to cut CPU prefill/inference cost for a
// small model — it never touches the original screenshot object, which
// stays untouched at 1024px for reuse by the cloud fallback if vision fails
// (see decision-router.js's getScreenshotOnce()). Resizing an
// already-redacted image cannot un-redact it — the masked regions just scale
// down along with everything else.
const VISION_IMAGE_MAX_WIDTH = 512;
const VISION_IMAGE_QUALITY   = 0.70;

/**
 * Pure dimension math — scales sourceWidth/sourceHeight down to fit within
 * targetWidth, preserving aspect ratio, never upscaling. No image/canvas
 * APIs involved, so this is directly unit-testable outside a browser.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} [targetWidth]
 * @returns {{width:number, height:number}}
 */
export function computeVisionResizeDimensions(sourceWidth, sourceHeight, targetWidth = VISION_IMAGE_MAX_WIDTH) {
  if (!sourceWidth || !sourceHeight) return { width: sourceWidth || 0, height: sourceHeight || 0 };
  const scale = Math.min(1, targetWidth / sourceWidth);
  return {
    width:  Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

// Precision for normalized bbox coordinates. 1/1000th of the viewport is far
// finer than any spatial distinction the model could actually act on — this
// just keeps the JSON compact, not a claim of that much real precision.
const BBOX_COORD_PRECISION = 1000;

/**
 * Convert a pageState element's bbox — CSS pixels, relative to the viewport,
 * exactly as PageStateService's getBoundingClientRect()-derived bbox already
 * is — into normalized 0-1 fractions of that same viewport. Normalized so the
 * representation stays valid regardless of the screenshot's own resolution:
 * the screenshot handed to Moondream is resized (twice — see
 * VISION_IMAGE_MAX_WIDTH above) from the viewport that produced these bbox
 * values, so a raw pixel bbox would silently point at the wrong spot once the
 * image shrinks; a fraction of the viewport does not.
 *
 * Pure/derived only — never invents a position. Returns null (never a
 * fabricated box) whenever there isn't enough real information to normalize
 * against: no bbox on the element, a zero-area bbox, or an unknown viewport
 * size. Callers must treat null as "omit spatial info for this element",
 * exactly as an element with no bbox already is handled.
 *
 * @param {{x:number,y:number,width:number,height:number}|null|undefined} bbox
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function normalizeBboxForVision(bbox, viewportWidth, viewportHeight) {
  if (!bbox || !viewportWidth || !viewportHeight) return null;
  if (!(bbox.width > 0) || !(bbox.height > 0)) return null;

  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const round   = (n) => Math.round(n * BBOX_COORD_PRECISION) / BBOX_COORD_PRECISION;

  return {
    x:      round(clamp01(bbox.x / viewportWidth)),
    y:      round(clamp01(bbox.y / viewportHeight)),
    width:  round(clamp01(bbox.width  / viewportWidth)),
    height: round(clamp01(bbox.height / viewportHeight)),
  };
}

/**
 * Pure — computes the on-canvas pixel position at which each candidate's
 * marker/label should be drawn, derived ONLY from that element's EXISTING
 * pageState bbox (via normalizeBboxForVision, already resolution-independent)
 * and the target canvas size. No canvas/image APIs involved, so this is
 * directly unit-testable, and it works identically for any element/site —
 * nothing here knows or cares what a candidate is or means.
 *
 * A candidate with no id, or no resolvable bbox (missing/zero-area bbox, or
 * unknown viewport), is simply OMITTED from the result — never given a
 * guessed position. This is the same "omit, never fabricate" contract
 * normalizeBboxForVision already has.
 *
 * @param {object[]} elements
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @returns {{id:string, x:number, y:number}[]}
 */
export function computeCandidateMarkerPositions(elements, canvasWidth, canvasHeight, viewportWidth, viewportHeight) {
  if (!Array.isArray(elements) || !canvasWidth || !canvasHeight) return [];
  const positions = [];
  for (const el of elements) {
    if (!el?.id) continue;
    const norm = normalizeBboxForVision(el.bbox, viewportWidth, viewportHeight);
    if (!norm) continue;
    positions.push({
      id: el.id,
      x: Math.round(norm.x * canvasWidth),
      y: Math.round(norm.y * canvasHeight),
    });
  }
  return positions;
}

// Marker appearance — chosen only for legibility against arbitrary page
// content, nothing about any particular site/element.
const MARKER_RADIUS     = 4;
const MARKER_FONT       = 'bold 11px sans-serif';
const MARKER_COLOR      = '#ff00ff'; // magenta — rarely used in ordinary UI, high contrast
const MARKER_TEXT_COLOR = '#000000';
const MARKER_TEXT_BG    = '#ffff00';

/**
 * Draw a small marker + "[elementId]" label at each precomputed position,
 * directly onto the canvas context already holding the resized screenshot.
 * Purely a rendering step over computeCandidateMarkerPositions's pure output
 * — no bbox/normalization logic lives here. Guarded per-marker so one bad
 * draw call can't lose the rest; the whole thing is additionally wrapped by
 * resizeImageForVision's own try/catch, so any failure here still degrades
 * to "send the resized-but-unannotated image" rather than breaking the
 * request.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{id:string, x:number, y:number}[]} positions
 */
function drawCandidateMarkers(ctx, positions) {
  for (const { id, x, y } of positions) {
    try {
      ctx.beginPath();
      ctx.arc(x, y, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = MARKER_COLOR;
      ctx.fill();

      const label = `[${id}]`;
      ctx.font = MARKER_FONT;
      const textWidth = typeof ctx.measureText === 'function' ? ctx.measureText(label).width : label.length * 6;
      const labelX = x + MARKER_RADIUS + 2;
      const labelY = y - MARKER_RADIUS - 2;

      ctx.fillStyle = MARKER_TEXT_BG;
      ctx.fillRect(labelX - 1, labelY - 10, textWidth + 2, 12);
      ctx.fillStyle = MARKER_TEXT_COLOR;
      ctx.fillText(label, labelX, labelY);
    } catch { /* one marker failing must not lose the rest */ }
  }
}

/**
 * Downscale an already-captured, already-redacted base64 JPEG to ~512px
 * wide for Moondream specifically, and (when candidate elements/viewport are
 * given) draw a small "[elementId]" marker near each candidate's own known
 * position — generated generically from whatever elements/bboxes are passed
 * in, nothing site- or element-specific. This is the ONLY copy of the image
 * that is ever annotated: it happens after the already-redacted screenshot
 * has been copied onto this canvas, and only that in-memory copy is sent to
 * Moondream — imageBase64 (the caller's original, already-redacted
 * screenshot object) is never touched, so the cloud fallback still gets the
 * clean, unannotated, full-resolution image if this local attempt fails.
 *
 * Browser-only APIs (createImageBitmap / OffscreenCanvas) — never throws:
 * any failure (missing API, corrupt image, marker drawing) falls back to
 * returning the original image unchanged, so a resize/annotation problem
 * degrades to "send the larger/unmarked image" rather than breaking the
 * request.
 *
 * @param {string} base64Image
 * @param {object[]} [elements] - Candidate elements to mark, if any.
 * @param {number} [viewportWidth]
 * @param {number} [viewportHeight]
 * @returns {Promise<string>}
 */
async function resizeImageForVision(base64Image, elements = [], viewportWidth = 0, viewportHeight = 0) {
  try {
    const binary = atob(base64Image);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

    const { width, height } = computeVisionResizeDimensions(bitmap.width, bitmap.height, VISION_IMAGE_MAX_WIDTH);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    // Markers are drawn AFTER the already-redacted screenshot is copied onto
    // this canvas — strictly on this in-memory, Moondream-only copy.
    const positions = computeCandidateMarkerPositions(elements, width, height, viewportWidth, viewportHeight);
    if (positions.length) drawCandidateMarkers(ctx, positions);

    const outBlob  = await canvas.convertToBlob({ type: 'image/jpeg', quality: VISION_IMAGE_QUALITY });
    const buffer   = await outBlob.arrayBuffer();
    const outBytes = new Uint8Array(buffer);

    const CHUNK = 8192;
    let str = '';
    for (let i = 0; i < outBytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, outBytes.subarray(i, Math.min(i + CHUNK, outBytes.length)));
    }
    return btoa(str);
  } catch (err) {
    console.log(`[SP:V2:DEBUG] LocalVisionAdapter image resize failed, using original image: ${err?.message}`);
    return base64Image;
  }
}

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
    // 0 = "not known to be warm". Set after any successful load (preload or
    // real generate) to Date.now() + keep-alive window; _warmModelIfNeeded
    // skips its preload entirely while still within that window.
    this._warmUntilMs = 0;
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

    // Warm ONLY this adapter's own model, and only if we don't already
    // believe it's resident — never a second real generation, never both
    // local models (L3 routing already guarantees only one adapter's plan()
    // is ever called per cycle; this just avoids re-paying a cold load on
    // every single call within that adapter).
    await this._warmModelIfNeeded(callerSignal, reqId);

    // Downscale ONLY the copy sent to Moondream — imageBase64 (and the
    // caller's original screenshot object) is left untouched, so the cloud
    // fallback still gets the full 1024px, already-redacted image if this
    // local attempt fails. Redaction was already applied upstream (before
    // this adapter ever saw the image); resizing preserves it as-is.
    //
    // Same viewport reference frame and same first-25 candidate cap
    // _buildVisionPrompt uses below, so the markers drawn on the image and
    // the ids listed in the text prompt describe exactly the same set.
    const viewportWidth  = typeof window !== 'undefined' ? window.innerWidth  : 0;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
    const candidateElements = (request?.elements ?? []).slice(0, 25);
    const visionImageBase64 = await resizeImageForVision(imageBase64, candidateElements, viewportWidth, viewportHeight);

    const prompt = this._buildVisionPrompt(request);
    const targetUrl = `${this._ollamaUrl}/api/generate`;
    const requestBody = {
      model:      this._model,
      prompt,
      images:     [visionImageBase64],
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
            body: requestBody,
            timeoutMs: VISION_GENERATE_TIMEOUT_MS
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

    // A successful call — like the preload below — refreshes Ollama's own
    // keep_alive for this model, so extend our own warm-tracking window too.
    this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS;

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
   * Preload this adapter's own model into Ollama's memory before the real
   * generate call, so that call itself doesn't pay the cold-load cost.
   * Reuses the exact same OLLAMA_GENERATE proxy path plan() uses — no second
   * client/architecture — but the request body carries no `prompt`/`images`,
   * which is Ollama's own documented mechanism for loading (and
   * keep_alive-refreshing) a model without running any generation: not a
   * second inference task.
   *
   * No-ops entirely when we already believe the model is warm (bookkeeping
   * only — see _warmUntilMs), when the caller already aborted, or outside a
   * real chrome-extension context. Never throws — a failed/timed-out preload
   * just means the real call below proceeds exactly as it already would have.
   */
  async _warmModelIfNeeded(callerSignal, reqId) {
    if (Date.now() < this._warmUntilMs) {
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter model already warm reqId=${reqId} warmUntilMs=${this._warmUntilMs} — skipping preload`);
      return;
    }
    if (callerSignal?.aborted) return;

    const hasChromeRuntime = typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage;
    if (!hasChromeRuntime) return;

    const warmReqId = `${reqId}_warmup`;
    const targetUrl = `${this._ollamaUrl}/api/generate`;
    const warmBody  = { model: this._model, keep_alive: this._keepAlive, stream: false };

    console.log(`[SP:V2:DEBUG] LocalVisionAdapter warming model=${this._model} reqId=${warmReqId}`);
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'OLLAMA_GENERATE',
          reqId: warmReqId,
          url: targetUrl,
          body: warmBody,
          timeoutMs: VISION_GENERATE_TIMEOUT_MS
        }, (response) => {
          if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
          else resolve(response || { success: false, error: 'No response from background script' });
        });
      });

      if (resp?.success) {
        this._warmUntilMs = Date.now() + DEFAULT_KEEP_ALIVE_MS;
        console.log(`[SP:V2:DEBUG] LocalVisionAdapter model warm reqId=${warmReqId} warmUntilMs=${this._warmUntilMs}`);
      } else {
        console.log(`[SP:V2:DEBUG] LocalVisionAdapter warm-up failed reqId=${warmReqId} error=${resp?.error} — proceeding to real generate anyway`);
      }
    } catch (err) {
      console.log(`[SP:V2:DEBUG] LocalVisionAdapter warm-up threw reqId=${warmReqId} message=${err?.message} — proceeding to real generate anyway`);
    }
  }

  /**
   * P1 #2: a concise visual-PERCEPTION question, not a planning prompt.
   * Moondream is only ever reached when the L3 router found zero viable
   * text candidates (see decision-router.js) — its one job here is to look
   * at the screenshot and point at which known element (if any) is the
   * visual target. It is explicitly NOT asked to decide what kind of
   * interaction to perform (click/type/select/...) — decision-router.js
   * derives that itself from the resolved element's own role/tag via
   * _buildPlanFromElement, the same as L1/L2 already do, so asking the
   * model to also choose an action would be asking it to plan, not perceive.
   *
   * Context given is the minimum useful amount: the goal, and a compact
   * (already-sanitized, already-capped) list of interactive elements with
   * stable ids — not the full page state. The screenshot itself carries the
   * visual context; this text just gives the model the fixed vocabulary of
   * ids it is allowed to answer with.
   *
   * Each candidate also carries its own bbox WHEN one can be derived (see
   * normalizeBboxForVision) — normalized to a 0-1 fraction of the viewport,
   * not raw pixels, so it stays correct after the screenshot is resized for
   * this model. This exists because an element with no distinguishing text
   * (a purely visual/icon-only control) previously gave the model nothing
   * to connect what it sees to which known id that is; bbox is the same kind
   * of ground truth id/role/text already are — read from pageState, never
   * invented — it just happens to describe WHERE instead of WHAT.
   */
  _buildVisionPrompt(request) {
    const page     = request.page ?? {};
    const elements = request.elements ?? [];

    // The bbox on a pageState element (see page-state-service.js) is CSS
    // pixels relative to the viewport — the same reference frame
    // window.innerWidth/innerHeight already describe elsewhere in this
    // extension (e.g. v2-task.js's own screenshot canvas). Guarded for the
    // non-browser context these adapters are also unit-tested in; absent
    // there, every element's bbox is simply omitted (see
    // normalizeBboxForVision's own null contract) rather than guessed at.
    const viewportWidth  = typeof window !== 'undefined' ? window.innerWidth  : 0;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

    const compactElements = elements.slice(0, 25).map(e => {
      // toCompactElement(): a sensitive element contributes only its static label.
      const c = toCompactElement(e);
      const entry = {
        id: c.id,
        role: c.role,
        text: c.sensitive ? c.name : (e.text || e.ariaLabel || e.placeholder || '')
      };
      const bbox = normalizeBboxForVision(e.bbox, viewportWidth, viewportHeight);
      if (bbox) entry.bbox = bbox;
      return entry;
    });

    return `Goal: "${request.goal}"
Page: ${page.title || ''} (${page.url || ''})

You are a VISUAL PERCEPTION component, not a planner. You do not decide how
to interact with anything — only WHICH element is the visual target. Sensitive
fields in the screenshot are already blacked out locally; you will never see
real passwords, emails, or card numbers.

The screenshot contains TEMPORARY candidate markers — small colored dots, each
with a "[elementId]" label next to it (for example "[el_7]") — placed at the
known position of each element listed below. These markers are not part of
the real page; they exist only in this copy of the screenshot to help you
answer this question, and are the most direct way to identify a visually
distinctive but unlabeled element (e.g. an icon-only button with no visible
text): find the marker at the right visual spot, then read its label.

Known interactive elements already extracted from the page (id, role, text,
and bbox when available). bbox gives that same element's location in the
screenshot as {x, y, width, height} — each a fraction from 0 to 1 of the full
image (0,0 is the top-left corner, 1,1 is the bottom-right corner),
independent of the image's actual pixel size — matching where its marker is
drawn, for elements whose marker you cannot read clearly:
${JSON.stringify(compactElements)}

Question: looking at the screenshot and its candidate markers, which ONE
element from the list above is visually the target for this goal?

Rules:
- "elementId" MUST be copied exactly from the list above. Never invent,
  guess, or construct a new id.
- If none of the listed elements visually match, return elementId: null.

Return JSON ONLY:
{"elementId":"el_12","confidence":0.91,"reason":"short reason"}`;
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
