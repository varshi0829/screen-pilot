// ScreenPilot backend gateway — session + global rate limiting.
//
// Each route calls createRateLimiter() ONCE at module scope, giving it its own
// independent in-memory state — exactly like the two separate hand-rolled
// limiters /api/plan and /api/analyze had before this module existed. State is
// in-memory only (resets on cold start / redeploy); this is unchanged and
// documented as sufficient at current scale, same as before.

import type { RateLimitBlock, RateLimiter } from './types';

export interface RateLimiterOptions {
  windowMs?: number;
  /** Requests a single session may make per window. */
  sessionMax?: number;
  /** Requests ALL sessions combined may make per window (protects a shared provider key). */
  globalMax?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const sessionMax = options.sessionMax ?? envInt('RATE_LIMIT_SESSION_PER_MIN', 100);
  const globalMax = options.globalMax ?? envInt('RATE_LIMIT_GLOBAL_PER_MIN', 12);
  const now = options.now ?? (() => Date.now());

  const sessions = new Map<string, { count: number; resetAt: number }>();
  let globalCount = 0;
  let globalResetAt = 0;

  return {
    check(sessionId: string, exempt = false): RateLimitBlock {
      const t = now();

      const s = sessions.get(sessionId);
      if (!s || t > s.resetAt) {
        sessions.set(sessionId, { count: 1, resetAt: t + windowMs });
      } else {
        if (s.count >= sessionMax) return 'session';
        s.count++;
      }

      if (exempt) return null;

      if (t > globalResetAt) {
        globalCount = 1;
        globalResetAt = t + windowMs;
        return null;
      }
      if (globalCount >= globalMax) return 'global';
      globalCount++;
      return null;
    }
  };
}
