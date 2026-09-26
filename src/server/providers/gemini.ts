// ScreenPilot backend gateway — Gemini provider call primitive.
//
// A pure request/response function: it makes exactly one HTTP call and never
// retries — retry policy differs between /api/plan and /api/analyze (see
// model-router.ts and each route), so it belongs to the CALLER, not here.

import type { CallResult, Screenshot } from '../types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiCallParams {
  key: string;
  model: string;
  prompt: string;
  screenshot: Screenshot;
  signal: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
}

export async function callGemini(params: GeminiCallParams): Promise<CallResult> {
  const { key, model, prompt, screenshot, signal, temperature = 0.1, maxOutputTokens = 2048 } = params;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: screenshot.mimeType ?? 'image/jpeg', data: screenshot.image } }
      ]
    }],
    generationConfig: { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } }
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
  } catch (err: unknown) {
    const name = (err as Error).name;
    return { ok: false, status: 0, message: (name === 'AbortError' || name === 'TimeoutError') ? 'timeout' : (err as Error).message };
  }

  if (!upstream.ok) {
    const errBody = await upstream.json().catch(() => null);
    return { ok: false, status: upstream.status, message: errBody?.error?.message ?? JSON.stringify(errBody ?? '').slice(0, 500) };
  }

  const data = await upstream.json();
  const rawText = (data?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined) ?? '';
  const finishReason = (data?.candidates?.[0]?.finishReason as string | undefined) ?? 'STOP';
  return {
    ok: true,
    data: {
      rawText,
      finishReason,
      modelUsed: model,
      usage: {
        inputTokens: (data?.usageMetadata?.promptTokenCount as number | undefined) ?? 0,
        outputTokens: (data?.usageMetadata?.candidatesTokenCount as number | undefined) ?? 0
      },
      raw: data
    }
  };
}
