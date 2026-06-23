/**
 * State Machine Caching for Token Efficiency
 * 
 * Rules:
 * 1. Never call Gemini twice for the same screen
 * 2. Cache screen state
 * 3. Cache successful routes
 * 4. Cache workflow patterns
 * 5. Use DOM-first navigation whenever possible
 * 6. Reuse previous plans
 */

export interface ScreenState {
  url: string;
  application: string;
  pageType: string;
  authenticated: boolean;
  currentActivity: string;
  confidence: number;
  timestamp: number;
}

export interface CachedRoute {
  application: string;
  workflow: string;
  steps: RouteStep[];
  timestamp: number;
  successCount: number;
}

export interface RouteStep {
  id: number;
  description: string;
  expectedElement: {
    text: string;
    type: string;
    region: string;
  };
}

export interface WorkflowPattern {
  application: string;
  workflowType: string;
  fromPage: string;
  toPage: string;
  steps: RouteStep[];
  successCount: number;
  timestamp: number;
}

// In-memory cache (resets on cold start)
const screenStateCache = new Map<string, ScreenState>();
const routeCache = new Map<string, CachedRoute>();
const workflowPatternCache = new Map<string, WorkflowPattern>();

const CACHE_TTL_MS = 30_000; // 30 seconds for screen state
const ROUTE_TTL_MS = 300_000; // 5 minutes for routes
const PATTERN_TTL_MS = 600_000; // 10 minutes for workflow patterns

/**
 * Generate cache key from URL and application
 */
function screenKey(url: string, application: string): string {
  return `${application}:${url}`;
}

/**
 * Generate cache key for route
 */
function routeKey(application: string, workflow: string): string {
  return `${application}:${workflow}`;
}

/**
 * Generate cache key for workflow pattern
 */
function patternKey(application: string, workflowType: string, fromPage: string, toPage: string): string {
  return `${application}:${workflowType}:${fromPage}:${toPage}`;
}

/**
 * Get cached screen state if fresh
 */
export function getCachedState(url: string, application: string): ScreenState | null {
  const key = screenKey(url, application);
  const cached = screenStateCache.get(key);
  
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    screenStateCache.delete(key);
    return null;
  }
  
  return cached;
}

/**
 * Cache screen state
 */
export function cacheScreenState(state: Omit<ScreenState, 'timestamp'>): void {
  const key = screenKey(state.url, state.application);
  screenStateCache.set(key, { ...state, timestamp: Date.now() });
}

/**
 * Get cached route if fresh
 */
export function getCachedRoute(application: string, workflow: string): CachedRoute | null {
  const key = routeKey(application, workflow);
  const cached = routeCache.get(key);
  
  if (!cached) return null;
  if (Date.now() - cached.timestamp > ROUTE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  
  return cached;
}

/**
 * Cache successful route
 */
export function cacheSuccessfulRoute(route: Omit<CachedRoute, 'timestamp' | 'successCount'>): void {
  const key = routeKey(route.application, route.workflow);
  const existing = routeCache.get(key);
  routeCache.set(key, {
    ...route,
    successCount: existing ? existing.successCount + 1 : 1,
    timestamp: Date.now(),
  });
}

/**
 * Get cached workflow pattern if fresh
 */
export function getCachedWorkflowPattern(
  application: string,
  workflowType: string,
  fromPage: string,
  toPage: string
): WorkflowPattern | null {
  const key = patternKey(application, workflowType, fromPage, toPage);
  const cached = workflowPatternCache.get(key);
  
  if (!cached) return null;
  if (Date.now() - cached.timestamp > PATTERN_TTL_MS) {
    workflowPatternCache.delete(key);
    return null;
  }
  
  return cached;
}

/**
 * Cache workflow pattern and increment success count
 */
export function cacheWorkflowPattern(pattern: Omit<WorkflowPattern, 'successCount' | 'timestamp'>): void {
  const key = patternKey(pattern.application, pattern.workflowType, pattern.fromPage, pattern.toPage);
  const existing = workflowPatternCache.get(key);
  
  workflowPatternCache.set(key, {
    ...pattern,
    successCount: existing ? existing.successCount + 1 : 1,
    timestamp: Date.now(),
  });
}

/**
 * Check if we can skip Gemini call by using cached route
 */
export function canUseCachedRoute(application: string, workflow: string): boolean {
  const cached = getCachedRoute(application, workflow);
  return cached !== null && cached.successCount > 0;
}

/**
 * Get all cached data for debugging
 */
export function getCacheStats(): {
  screenStates: number;
  routes: number;
  patterns: number;
} {
  return {
    screenStates: screenStateCache.size,
    routes: routeCache.size,
    patterns: workflowPatternCache.size,
  };
}

/**
 * Clear all caches (for testing)
 */
export function clearAllCaches(): void {
  screenStateCache.clear();
  routeCache.clear();
  workflowPatternCache.clear();
}