// ScreenPilot backend gateway — OpenRouter provider call primitive.
//
// A pure request/response function: one HTTP call, no retry (OpenRouter is
// never retried internally today — see model-router.ts's chain instead, which
// moves to the NEXT configured attempt rather than retrying this one).

import type { CallResult, Screenshot } from '../types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Not a secret — required by OpenRouter's own attribution policy.
const HTTP_REFERER = 'https://screen-pilot-j1az.vercel.app';

export interface OpenRouterCallParams {
  key: string;
  model: string;
  prompt: string;
  screenshot: Screenshot;
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export async function callOpenRouter(params: OpenRouterCallParams): Promise<CallResult> {
  const { key, model, prompt, screenshot, signal, temperature = 0.1, maxTokens = 768 } = params;
  const mimeType = screenshot.mimeType ?? 'image/jpeg';

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${screenshot.image}` } }
      ]
    }],
    temperature,
    max_tokens: maxTokens
  };

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': HTTP_REFERER,
        'X-Title': 'ScreenPilot'
      },
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
  const rawText = (data?.choices?.[0]?.message?.content as string | undefined) ?? '';
  const finishReason = (data?.choices?.[0]?.finish_reason as string | undefined) ?? 'stop';
  return {
    ok: true,
    data: {
      rawText,
      finishReason,
      modelUsed: model,
      usage: {
        inputTokens: (data?.usage?.prompt_tokens as number | undefined) ?? 0,
        outputTokens: (data?.usage?.completion_tokens as number | undefined) ?? 0
      },
      raw: data
    }
  };
}
