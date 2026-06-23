// ScreenPilot - Vision Service
// Sends screenshot + goal to the ScreenPilot backend; backend holds the API key.

import { ScreenContextService } from './screen-context.js';

export const VisionService = (() => {
  'use strict';

  const BACKEND_URL       = 'https://screen-pilot-j1az.vercel.app/api/analyze';
  const REQUEST_TIMEOUT_MS = 28000;
  const MAX_ATTEMPTS       = 3;

  // ─── PUBLIC ────────────────────────────────────────────────────────────────

  async function analyzeScreenshot({ screenshot, goal, pageContext = {}, taskState = null, enterpriseContext = null }) {
    if (!goal?.trim()) {
      return buildError('Enter a goal before starting ScreenPilot.', false);
    }
    if (!screenshot?.success) {
      return buildError(screenshot?.error || 'No screenshot available for analysis.');
    }
    return _callWithRetry({ screenshot, goal, pageContext, taskState, enterpriseContext, mode: 'navigate' }, parseVisionResponse);
  }

  // Returns { success, screenContext } — uses existing ScreenContext if caller passes one.
  async function explainScreen({ screenshot, pageContext = {} }) {
    if (!screenshot?.success) {
      return buildError(screenshot?.error || 'No screenshot available.');
    }
    return _callWithRetry({ screenshot, goal: 'Explain what is visible on this screen', pageContext, taskState: null, mode: 'explain' }, parseExplainResponse);
  }

  // Returns { success, answer, confidence, elementHint }
  async function askQuestion({ screenshot, question, pageContext = {} }) {
    if (!question?.trim()) return buildError('Question is required.', false);
    if (!screenshot?.success) return buildError(screenshot?.error || 'No screenshot available.');
    return _callWithRetry({ screenshot, goal: question, pageContext, taskState: null, mode: 'ask' }, parseQAResponse);
  }

  // ─── PRIVATE ───────────────────────────────────────────────────────────────

  async function _callWithRetry(params, parser) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const raw    = await callBackend(params);
        const parsed = parser(raw);
        if (parsed.success) parsed.attempts = attempt;
        return parsed;
      } catch (err) {
        console.error(`[VisionService] Attempt ${attempt} failed:`, err.message);
        lastError = err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) break;
        const baseMs = err.status === 429 ? 2000 : 1000;
        const delayMs = Math.min(baseMs * Math.pow(2, attempt - 1) + Math.random() * 1000, 10000);
        console.warn(`[VisionService] Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return buildError(normalizeError(lastError), isRetryable(lastError));
  }

  async function callBackend({ screenshot, goal, pageContext, taskState, enterpriseContext, mode = 'navigate' }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const sessionId = await getOrCreateSessionId();
      const res = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Session-ID':  sessionId,
        },
        body: JSON.stringify({
          screenshot:      { image: screenshot.image, mimeType: screenshot.mimeType },
          goal,
          pageContext,
          taskState,
          enterpriseContext: enterpriseContext || null,
          mode,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
        const err  = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body   = body;
        if (res.status === 429) {
          console.error(`[VisionService] 429 response:`, JSON.stringify(body));
        }
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

  // ─── RESPONSE PARSERS ──────────────────────────────────────────────────────

  function parseVisionResponse(data) {
    try {
      const parsed = _extractParsedJSON(data);
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

      const screenContext = ScreenContextService.buildScreenContext(parsed);
      const taskPlan      = buildTaskPlan(parsed);

      return { success: true, ...normalized, screenContext, taskPlan, raw: parsed };
    } catch (err) {
      return buildError(`Could not parse response: ${err.message}`);
    }
  }

  function parseExplainResponse(data) {
    try {
      const parsed      = _extractParsedJSON(data);
      const screenContext = ScreenContextService.buildScreenContext(parsed);
      return { success: true, screenContext };
    } catch (err) {
      return buildError(`Could not parse explanation: ${err.message}`);
    }
  }

  function parseQAResponse(data) {
    try {
      const parsed = _extractParsedJSON(data);
      return {
        success:     true,
        answer:      typeof parsed.answer === 'string' ? parsed.answer.trim() : 'I could not answer that question.',
        confidence:  Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
        elementHint: typeof parsed.elementHint === 'string' ? parsed.elementHint.trim() : '',
      };
    } catch (err) {
      return buildError(`Could not parse answer: ${err.message}`);
    }
  }

  function _extractParsedJSON(data) {
    const parts   = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => p.text && !p.thought);
    const rawText  = textPart?.text || '';
    return JSON.parse(extractJson(rawText));
  }

  function extractJson(rawText) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{')) return trimmed;
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in response.');
    return match[0];
  }

  // ─── NORMALIZERS ───────────────────────────────────────────────────────────

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
          .filter(c => typeof c?.text === 'string' && c.text.trim())
          .map(c => ({
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
      currentStep:   typeof result?.currentStep === 'string'   ? result.currentStep.trim() : '',
      targetElement,
      candidates,
      instruction:   typeof result?.instruction === 'string'   ? result.instruction.trim() : '',
      confidence,
      complete: result?.currentStep === 'Task complete' || result?.instruction === 'Task complete',
    };
  }

  function buildTaskPlan(raw) {
    if (!Array.isArray(raw?.plan) || !raw.plan.length) return null;

    const VALID_TYPES   = ['button', 'link', 'input', 'menu'];
    const VALID_REGIONS = ['top_navigation','side_navigation','main_content','toolbar',
                           'modal','dropdown','form','footer'];

    const steps = raw.plan
      .filter(s => typeof s?.description === 'string' && s.description.trim())
      .map((s, i) => ({
        id:              Number.isFinite(Number(s.id)) ? Number(s.id) : (i + 1),
        description:     s.description.trim(),
        expectedElement: {
          text:   typeof s.expectedElement?.text === 'string' ? s.expectedElement.text.trim() : '',
          type:   VALID_TYPES.includes(s.expectedElement?.type) ? s.expectedElement.type : 'button',
          region: VALID_REGIONS.includes(s.expectedElement?.region) ? s.expectedElement.region : 'main_content',
        },
        status: 'pending',
      }))
      .filter(s => s.expectedElement.text);

    if (!steps.length) return null;
    return { steps, currentStepIndex: 0, planVersion: 1, createdAt: Date.now() };
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
    if (err.status === 429) {
      const source = err.body?.source === 'gemini' ? 'Gemini AI' : 'rate limit';
      const detail = err.body?.error || '';
      console.error(`[VisionService] 429 source=${source} detail="${detail}" body=${JSON.stringify(err.body)}`);
      return detail || 'Too many requests — please wait a moment and try again.';
    }
    if (err.status >= 500)         return 'ScreenPilot service is temporarily unavailable.';
    return `Analysis failed: ${err.message}`;
  }

  function isRetryable(err) {
    if (!err) return false;
    return err.name === 'AbortError' || err.status === 429 || (err.status >= 500 && err.status !== 501);
  }

  function buildError(error, retryable = true) {
    return { success: false, error, retryable };
  }

  return { analyzeScreenshot, explainScreen, askQuestion };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VisionService;
}
