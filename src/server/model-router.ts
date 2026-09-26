// ScreenPilot backend gateway — model routing.
//
// Two responsibilities:
//   1. selectPlannerChain / selectVisionProvider — WHICH provider+model to use
//      for a role, built from env, so the extension never needs to know
//      whether the backend is currently OpenRouter or Gemini.
//   2. runPlannerChain — executes an ordered list of attempts for the planner
//      role, moving to the NEXT attempt when one is exhausted.
//
// Default env (no PLANNER_MODEL_*/FALLBACK_* set) reproduces the exact
// pre-Phase-2 selection and retry behavior:
//   OPENROUTER_API_KEY set  -> OpenRouter, one model, one attempt, no retry.
//   else GEMINI_API_KEY set -> Gemini, up to 2 attempts (timeout/5xx retried
//                              once; 429 and 400/401/403 are never retried).
//   neither set              -> no chain (route returns SERVICE_UNAVAILABLE).
// A FALLBACK_PROVIDER env var (unset by default) adds a second, different
// provider to the chain, tried only after the primary is fully exhausted —
// this is the only NEW behavior this module can introduce, and only when an
// operator opts in.
//
// /api/analyze has only ever had one provider (Gemini) with its OWN retry
// policy (see that route) — it uses callGemini directly and does not need a
// chain, so no vision "chain" executor is provided here, only selection.

import { callOpenRouter } from './providers/openrouter';
import { callGemini } from './providers/gemini';
import type { CallResult, ProviderResult, RoleSelection, Screenshot } from './types';

export const DEFAULT_OPENROUTER_MODEL = 'google/gemma-4-26b-a4b-it:free';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

// 400/401/403: the request itself is broken — another attempt of the SAME
// provider won't help, but a different provider (a fallback, if configured)
// might, so this still advances the chain rather than stopping outright.
const FATAL_UPSTREAM_STATUS = new Set([400, 401, 403]);

type Env = Record<string, string | undefined>;

/**
 * Ordered attempts for the planner role (/api/plan). Mirrors the exact
 * pre-refactor selection: OpenRouter when its key is present, else Gemini.
 */
export function selectPlannerChain(env: Env = process.env): RoleSelection[] {
  const chain: RoleSelection[] = [];
  const openRouterKey = env.OPENROUTER_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;

  if (openRouterKey) {
    chain.push({ provider: 'openrouter', model: env.PLANNER_MODEL_OPENROUTER || DEFAULT_OPENROUTER_MODEL, key: openRouterKey });
  } else if (geminiKey) {
    chain.push({ provider: 'gemini', model: env.PLANNER_MODEL_GEMINI || DEFAULT_GEMINI_MODEL, key: geminiKey });
  }

  // Opt-in secondary provider, tried only once the primary is exhausted.
  // Unset by default, so the chain has exactly one entry unless an operator
  // explicitly configures this — no change to default behavior.
  if (env.FALLBACK_PROVIDER === 'gemini' && geminiKey && chain[0]?.provider !== 'gemini') {
    chain.push({ provider: 'gemini', model: env.FALLBACK_MODEL || DEFAULT_GEMINI_MODEL, key: geminiKey });
  } else if (env.FALLBACK_PROVIDER === 'openrouter' && openRouterKey && chain[0]?.provider !== 'openrouter') {
    chain.push({ provider: 'openrouter', model: env.FALLBACK_MODEL || DEFAULT_OPENROUTER_MODEL, key: openRouterKey });
  }

  return chain;
}

/** The single provider for the vision role (/api/analyze). Gemini-only, as before. */
export function selectVisionProvider(env: Env = process.env): RoleSelection | null {
  const geminiKey = env.GEMINI_API_KEY;
  if (!geminiKey) return null;
  return { provider: 'gemini', model: env.VISION_MODEL_GEMINI || DEFAULT_GEMINI_MODEL, key: geminiKey };
}

// Deliberately NOT RoleSelection — omits `key` so a caller that logs this event
// (see logger.ts's onAttempt wiring in the routes) can never leak the raw key.
export interface ChainAttemptEvent {
  provider: RoleSelection['provider'];
  model: string;
  attempt: number;
  maxAttempts: number;
  ok: boolean;
  status?: number;
}

export interface ChainSuccess {
  ok: true;
  data: ProviderResult;
  selection: RoleSelection;
}
export interface ChainFailure {
  ok: false;
  status: number;
  message: string;
  /** The attempt the chain was on when it gave up — null only if the chain was empty. */
  selection: RoleSelection | null;
}
export type ChainResult = ChainSuccess | ChainFailure;

export interface RunChainOptions {
  prompt: string;
  screenshot: Screenshot;
  /** Aborts the WHOLE chain (a total time budget), independent of any per-attempt timeout. */
  outerSignal: AbortSignal;
  perAttemptMs: number;
  /** Gemini attempts per chain entry (OpenRouter entries always get exactly 1). */
  geminiMaxAttemptsPerEntry?: number;
  backoffMs?: (attempt: number) => number;
  onAttempt?: (evt: ChainAttemptEvent) => void;
}

const defaultBackoff = (attempt: number) => 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;

/**
 * Runs a planner chain built by selectPlannerChain. For each entry: OpenRouter
 * gets exactly one attempt (its own historical behavior — no internal retry);
 * Gemini gets up to `geminiMaxAttemptsPerEntry` attempts, retrying only
 * timeouts and 5xx (never 429, never 400/401/403) — reproducing /api/plan's
 * exact pre-refactor Gemini retry policy. When an entry is exhausted the loop
 * moves to the next chain entry, if any; the final failure carries the status
 * from the LAST attempt actually made, matching the old `lastErr` behavior.
 */
export async function runPlannerChain(chain: RoleSelection[], opts: RunChainOptions): Promise<ChainResult> {
  const geminiMaxAttempts = opts.geminiMaxAttemptsPerEntry ?? 2;
  const backoff = opts.backoffMs ?? defaultBackoff;
  let lastFailure: ChainFailure = { ok: false, status: 0, message: 'no provider configured', selection: null };

  for (const selection of chain) {
    const maxAttempts = selection.provider === 'gemini' ? geminiMaxAttempts : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (opts.outerSignal.aborted) return { ok: false, status: 0, message: 'timeout', selection };

      const local = new AbortController();
      const localTimer = setTimeout(() => local.abort(), opts.perAttemptMs);
      opts.outerSignal.addEventListener('abort', () => local.abort(), { once: true });

      const call: CallResult = selection.provider === 'openrouter'
        ? await callOpenRouter({ key: selection.key, model: selection.model, prompt: opts.prompt, screenshot: opts.screenshot, signal: local.signal })
        : await callGemini({ key: selection.key, model: selection.model, prompt: opts.prompt, screenshot: opts.screenshot, signal: local.signal, temperature: 0.1, maxOutputTokens: 2048 });
      clearTimeout(localTimer);

      if (call.ok) {
        opts.onAttempt?.({ provider: selection.provider, model: selection.model, attempt, maxAttempts, ok: true });
        return { ok: true, data: call.data, selection };
      }

      opts.onAttempt?.({ provider: selection.provider, model: selection.model, attempt, maxAttempts, ok: false, status: call.status });
      lastFailure = { ok: false, status: call.status, message: call.message, selection };

      // Gemini: stop retrying THIS entry on a fatal request error or a 429 —
      // move on to the next chain entry (if any) instead.
      if (selection.provider === 'gemini' && (FATAL_UPSTREAM_STATUS.has(call.status) || call.status === 429)) break;
      // OpenRouter never retries internally.
      if (selection.provider === 'openrouter') break;

      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, backoff(attempt)));
    }
  }

  return lastFailure;
}
