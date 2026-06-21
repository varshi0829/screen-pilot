// ScreenPilot - Vision Service
// Gemini Vision integration for structured next-step guidance.

export const VisionService = (() => {
  'use strict';

  const GEMINI_VISION_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const REQUEST_TIMEOUT_MS = 20000;
  const MAX_ATTEMPTS = 2;
  let apiKey = null;

  function init(key) {
    apiKey = key;
  }

  async function analyzeScreenshot({ screenshot, goal, pageContext = {}, taskState = null }) {
    console.log('[VisionService] analyzeScreenshot — goal:', goal, '| key:', !!apiKey);

    if (!apiKey) {
      return buildError('API key not configured. Add your Gemini API key in the extension popup.', false);
    }

    if (!goal?.trim()) {
      return buildError('Enter a goal before starting ScreenPilot.', false);
    }

    if (!screenshot?.success) {
      return buildError(screenshot?.error || 'No screenshot available for analysis.');
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await callGeminiVision(buildVisionPrompt(goal, pageContext, taskState), screenshot);
        const parsed   = parseVisionResponse(response);
        if (parsed.success) parsed.attempts = attempt;
        return parsed;
      } catch (error) {
        console.error(`[VisionService] Attempt ${attempt} failed: ${error.message}`);
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;
      }
    }

    const errorMessage = normalizeApiError(lastError);
    console.error('[VisionService] Final error:', errorMessage);
    return buildError(errorMessage, isRetryable(lastError));
  }

  function buildVisionPrompt(goal, pageContext, taskState) {
    const context = [
      `Goal: ${goal}`,
      pageContext.url   ? `URL: ${pageContext.url}`           : '',
      pageContext.title ? `Page title: ${pageContext.title}`  : '',
      taskState?.completedSteps?.length
        ? `Completed: ${taskState.completedSteps.join(' → ')}` : '',
      taskState?.currentInstruction
        ? `Last instruction: ${taskState.currentInstruction}` : ''
    ].filter(Boolean).join('\n');

    return `${context}

Analyze this browser screenshot and determine the next action to achieve the goal.

Classify each relevant UI element using ONLY these generic action types (never use website or brand names):
- primary_action    : main call-to-action (Submit, Save, Create, Send, Confirm, Next, Apply, Post)
- secondary_action  : supporting action (Cancel, Back, Reset, Skip, Dismiss, Close)
- navigation_action : moves to another page or section (tab, breadcrumb, sidebar link)
- destructive_action: removes or deletes content (Delete, Remove, Archive, Trash)
- menu_action       : opens a dropdown, popover, or context menu
- content_item      : selectable row, card, list item, or search result
- input_field       : text box, textarea, date picker, file picker, select
- filter_control    : search bar, filter dropdown, sort control, tag filter
- settings_control  : toggle, checkbox, radio button, configuration field

Classify each element's UI region using ONLY these generic region types:
- top_navigation, side_navigation, main_content, toolbar, modal, dropdown, form, footer

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "screenSummary": "brief description of the visible application and its current state",
  "currentRegion": "the most relevant generic region type currently visible",
  "currentStep": "description of the next step toward the goal",
  "candidates": [
    {
      "text": "exact visible text, label, or placeholder of the element",
      "actionType": "one of the 9 action types above",
      "elementType": "button|link|input|menu",
      "region": "one of the 8 region types above",
      "confidence": 0.95,
      "reasoning": "one sentence: why this element is the right next action for the goal"
    }
  ],
  "targetElement": { "text": "text of best candidate", "type": "button|link|input|menu" },
  "instruction": "short user-facing instruction (e.g. Click 'Save Changes')",
  "confidence": 0.95
}

Rules:
- Return JSON only. No markdown, no commentary outside the JSON.
- Never reference website names, brand names, or domain-specific terminology.
- Reason from: visual layout, element roles, semantic match to goal, standard UI conventions.
- List up to 5 candidates in descending order of relevance to the goal.
- Match element text EXACTLY as shown in the UI — copy verbatim.
- Never repeat a completed step.
- If the task is already complete: set currentStep to "Task complete", targetElement.text to "", confidence to 1.
- If no clear next action is visible: leave targetElement.text empty, set confidence below 0.4.`;
  }

  async function callGeminiVision(prompt, screenshot) {
    console.log('[VisionService] fetch — payload:', Math.round((prompt.length + (screenshot.image?.length || 0)) / 1024), 'KB');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const requestBody = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: screenshot.mimeType || 'image/png',
                  data: screenshot.image
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 }
        }
      };

      // payload size already logged above — skip expensive JSON.stringify here

      const response = await fetch(`${GEMINI_VISION_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify(requestBody)
      });

      console.log('[VisionService] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[VisionService] Error response body:', errorText);
        console.error('[VisionService] Response headers:', Object.fromEntries(response.headers.entries()));
        
        throw new Error(`Gemini ${response.status}: ${errorText}`);
      }

      const jsonResponse = await response.json();
      return jsonResponse;
    } catch (error) {
      console.error('[VisionService] Fetch error:', error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function parseVisionResponse(data) {
    try {
      const parts = data.candidates?.[0]?.content?.parts || [];
      // Skip thought-summary parts (thinking models return part.thought === true first)
      const textPart = parts.find((p) => p.text && !p.thought);
      const rawText = textPart?.text || '';
      const parsed = JSON.parse(extractJson(rawText));
      const normalized = normalizeResult(parsed);
      console.log('[VisionService] result — step:', normalized.currentStep, '| target:', normalized.targetElement?.text, '| conf:', normalized.confidence);

      // Be more lenient - allow partial responses
      if (!normalized.screenSummary && !normalized.currentStep && !normalized.instruction) {
        return buildError('Gemini returned an incomplete response. Please try again.');
      }

      // If instruction is missing but we have candidates, generate a default instruction
      if (!normalized.instruction && normalized.candidates?.length) {
        const firstCandidate = normalized.candidates[0];
        normalized.instruction = `Click "${firstCandidate.text}"`;
        console.log('[VisionService] Generated instruction from candidate:', normalized.instruction);
      }

      // If targetElement is missing but we have candidates, use first candidate
      if (!normalized.targetElement?.text && normalized.candidates?.length) {
        const firstCandidate = normalized.candidates[0];
        normalized.targetElement = { text: firstCandidate.text, type: firstCandidate.elementType || 'button' };
        console.log('[VisionService] Generated targetElement from candidate:', normalized.targetElement);
      }

      return {
        success: true,
        ...normalized,
        raw: parsed
      };
    } catch (error) {
      console.error('[VisionService] parseVisionResponse failed:', error.message);
      return buildError(`Could not parse Gemini response: ${error.message}`);
    }
  }

  function extractJson(rawText) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{')) {
      return trimmed;
    }

    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('No JSON object found in Gemini response.');
    }

    return match[0];
  }

  function normalizeResult(result) {
    const targetElement = {
      text: typeof result?.targetElement?.text === 'string' ? result.targetElement.text.trim() : '',
      type: normalizeElementType(result?.targetElement?.type)
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
            reasoning:   typeof c.reasoning === 'string' ? c.reasoning.trim() : ''
          }))
      : [];

    return {
      screenSummary: typeof result?.screenSummary  === 'string' ? result.screenSummary.trim()  : '',
      currentRegion: normalizeRegion(result?.currentRegion),
      currentStep:   typeof result?.currentStep    === 'string' ? result.currentStep.trim()    : '',
      targetElement,
      candidates,
      instruction:   typeof result?.instruction    === 'string' ? result.instruction.trim()    : '',
      confidence,
      complete: result?.currentStep === 'Task complete' || result?.instruction === 'Task complete'
    };
  }

  function normalizeElementType(type) {
    return ['button', 'link', 'input', 'menu'].includes(type) ? type : 'button';
  }

  function normalizeActionType(type) {
    const VALID = ['primary_action', 'secondary_action', 'navigation_action', 'destructive_action',
                   'menu_action', 'content_item', 'input_field', 'filter_control', 'settings_control'];
    return VALID.includes(type) ? type : 'primary_action';
  }

  function normalizeRegion(region) {
    const VALID = ['top_navigation', 'side_navigation', 'main_content', 'toolbar',
                   'modal', 'dropdown', 'form', 'footer'];
    return VALID.includes(region) ? region : 'main_content';
  }

  function normalizeApiError(error) {
    const message = error?.name === 'AbortError'
      ? 'Gemini took too long to respond.'
      : error?.message || 'Unknown Gemini error';

    if (message.includes('429')) {
      const delayMatch = message.match(/"retryDelay":\s*"(\d+)s"/);
      const wait = delayMatch ? `${delayMatch[1]} seconds` : 'about a minute';
      return `Gemini rate limit reached. Please wait ${wait} and try again.`;
    }

    if (message.includes('403') || message.includes('401')) {
      return 'Gemini rejected the API key. Check the key in the extension popup.';
    }

    if (message.includes('404')) {
      return 'Gemini model not found. Please update the extension.';
    }

    if (message.includes('400')) {
      return 'Invalid request. Screenshot may be too large (max 4MB) or malformed.';
    }

    if (message.includes('500') || message.includes('503')) {
      return 'Gemini is temporarily unavailable. Please retry shortly.';
    }

    return `Gemini analysis failed: ${message}`;
  }

  function isRetryable(error) {
    const message = error?.message || '';
    // 429 has a retryDelay of ~52s — retrying immediately wastes quota; surface the error
    return error?.name === 'AbortError' || message.includes('500') || message.includes('503');
  }

  function buildError(error, retryable = true) {
    return {
      success: false,
      error,
      retryable
    };
  }

  return {
    init,
    analyzeScreenshot
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VisionService;
}
