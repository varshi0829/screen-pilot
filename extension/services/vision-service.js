// ScreenPilot - Vision Service
// Sends screenshot + goal to the ScreenPilot backend; backend holds the API key.

export const VisionService = (() => {
  'use strict';

  const BACKEND_URL = 'https://screen-pilot-j1az.vercel.app/api/analyze';
  const REQUEST_TIMEOUT_MS = 28000;
  const MAX_ATTEMPTS = 2;

  async function analyzeScreenshot({ screenshot, goal, pageContext = {}, taskState = null }) {
    if (!goal?.trim()) {
      return buildError('Enter a goal before starting ScreenPilot.', false);
    }
    if (!screenshot?.success) {
      return buildError(screenshot?.error || 'No screenshot available for analysis.');
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const raw = await callBackend({ screenshot, goal, pageContext, taskState });
        const parsed = parseVisionResponse(raw);
        if (parsed.success) parsed.attempts = attempt;
        return parsed;
      } catch (err) {
        console.error(`[VisionService] Attempt ${attempt} failed:`, err.message);
        lastError = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
      }
    }
    return buildError(normalizeError(lastError), isRetryable(lastError));
  }

  async function callBackend({ screenshot, goal, pageContext, taskState }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const sessionId = await getOrCreateSessionId();
      const res = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
        },
        body: JSON.stringify({
          screenshot: { image: screenshot.image, mimeType: screenshot.mimeType },
          goal,
          pageContext,
          taskState,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
        const err = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getOrCreateSessionId() {
    const stored = await chrome.storage.local.get('sessionId');
    if (stored.sessionId) return stored.sessionId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ sessionId: id });
    return id;
  }

  function parseVisionResponse(data) {
    try {
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p) => p.text && !p.thought);
      const rawText = textPart?.text || '';
      const parsed = JSON.parse(extractJson(rawText));
      const normalized = normalizeResult(parsed);

      if (!normalized.screenSummary && !normalized.currentStep && !normalized.instruction) {
        return buildError('Received an incomplete response. Please try again.');
      }

      if (!normalized.instruction && normalized.candidates?.length) {
        normalized.instruction = `Click "${normalized.candidates[0].text}"`;
      }
      if (!normalized.targetElement?.text && normalized.candidates?.length) {
        const c = normalized.candidates[0];
        normalized.targetElement = { text: c.text, type: c.elementType || 'button' };
      }

      return { success: true, ...normalized, raw: parsed };
    } catch (err) {
      return buildError(`Could not parse response: ${err.message}`);
    }
  }

  function extractJson(rawText) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{')) return trimmed;
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response.');
    return match[0];
  }

  function normalizeResult(result) {
    const targetElement = {
      text: typeof result?.targetElement?.text === 'string' ? result.targetElement.text.trim() : '',
      type: normalizeElementType(result?.targetElement?.type),
    };
    const confidence = Number.isFinite(result?.confidence)
      ? Math.max(0, Math.min(1, result.confidence))
      : 0;
    const candidates = Array.isArray(result?.candidates)
      ? result.candidates
          .filter((c) => typeof c?.text === 'string' && c.text.trim())
          .map((c) => ({
            text:        c.text.trim(),
            actionType:  normalizeActionType(c.actionType),
            elementType: normalizeElementType(c.elementType),
            region:      normalizeRegion(c.region),
            confidence:  Number.isFinite(c.confidence) ? Math.max(0, Math.min(1, c.confidence)) : 0,
            reasoning:   typeof c.reasoning === 'string' ? c.reasoning.trim() : '',
          }))
      : [];

    return {
      screenSummary: typeof result?.screenSummary === 'string' ? result.screenSummary.trim() : '',
      currentRegion: normalizeRegion(result?.currentRegion),
      currentStep:   typeof result?.currentStep === 'string' ? result.currentStep.trim() : '',
      targetElement,
      candidates,
      instruction:   typeof result?.instruction === 'string' ? result.instruction.trim() : '',
      confidence,
      complete: result?.currentStep === 'Task complete' || result?.instruction === 'Task complete',
    };
  }

  function normalizeElementType(t) {
    return ['button', 'link', 'input', 'menu'].includes(t) ? t : 'button';
  }

  function normalizeActionType(t) {
    const VALID = ['primary_action','secondary_action','navigation_action','destructive_action',
                   'menu_action','content_item','input_field','filter_control','settings_control'];
    return VALID.includes(t) ? t : 'primary_action';
  }

  function normalizeRegion(r) {
    const VALID = ['top_navigation','side_navigation','main_content','toolbar',
                   'modal','dropdown','form','footer'];
    return VALID.includes(r) ? r : 'main_content';
  }

  function normalizeError(err) {
    if (!err) return 'Unknown error.';
    if (err.name === 'AbortError') return 'Request timed out. Please try again.';
    if (err.status === 429) return 'Too many requests — please wait a moment and try again.';
    if (err.status >= 500) return 'ScreenPilot service is temporarily unavailable.';
    return `Analysis failed: ${err.message}`;
  }

  function isRetryable(err) {
    if (!err) return false;
    return err.name === 'AbortError' || (err.status >= 500 && err.status !== 501);
  }

  function buildError(error, retryable = true) {
    return { success: false, error, retryable };
  }

  return { analyzeScreenshot };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VisionService;
}
