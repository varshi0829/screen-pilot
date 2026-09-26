// ScreenPilot backend gateway — shared types.
// Plain interfaces/type aliases only (no enums, no parameter properties) so this
// file stays "erasable" and can be imported by both Next's bundler and plain
// Node's built-in TypeScript type-stripping (used by the server test suite).

export interface Screenshot {
  image: string;
  mimeType?: string;
}

export interface ProviderResult {
  rawText: string;
  finishReason: string;
  modelUsed: string;
  usage: { inputTokens: number; outputTokens: number };
  /** The verbatim upstream JSON body — only /api/analyze's contract needs this (it
   *  passes the raw provider response through to the extension unchanged). */
  raw?: unknown;
}

export type CallResult =
  | { ok: true; data: ProviderResult }
  | { ok: false; status: number; message: string };

export type ProviderName = 'openrouter' | 'gemini';

export interface RoleSelection {
  provider: ProviderName;
  model: string;
  key: string;
}

export type RateLimitBlock = 'session' | 'global' | null;

export interface RateLimiter {
  /** @param exempt - skip the GLOBAL check (still applies the per-session check) */
  check(sessionId: string, exempt?: boolean): RateLimitBlock;
}

export type LogFields = Record<string, unknown>;
