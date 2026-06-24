import { NextRequest, NextResponse } from "next/server";

const MODELS = {
  navigate: "gemini-2.0-flash",
  explain:  "gemini-2.0-flash",
  ask:      "gemini-2.0-flash",
} as const;
type Mode = keyof typeof MODELS;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 100; // DEV: raised from 12 — restore before public launch
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB base64 limit

// In-memory store — resets on cold start, sufficient for current scale
const sessions = new Map<string, { count: number; resetAt: number }>();

// Global rate limiter — protects shared Gemini API key from multi-user overload.
// Gemini free tier is 15 RPM; keep 3 RPM headroom for network jitter.
const GLOBAL_MAX  = 12;
let globalCount   = 0;
let globalResetAt = 0;

// ── In-process metrics (resets on cold start) ────────────────────────────────
const _m = {
  totalRequests:     0,
  totalGeminiCalls:  0,
  total429:          0,
  sharedKeyRequests: 0,
  userKeyRequests:   0,
};

function logMetrics(reqId: string) {
  const avg = _m.totalRequests > 0
    ? (_m.totalGeminiCalls / _m.totalRequests).toFixed(2)
    : "0.00";
  console.log(
    `[SCREENPILOT_METRICS] reqId=${reqId}` +
    ` total_requests=${_m.totalRequests}` +
    ` total_gemini_calls=${_m.totalGeminiCalls}` +
    ` avg_calls_per_request=${avg}` +
    ` 429_count=${_m.total429}` +
    ` shared_key_requests=${_m.sharedKeyRequests}` +
    ` user_key_requests=${_m.userKeyRequests}`
  );
}

type BlockReason = 'session' | 'global' | null;

function allowRequest(sessionId: string, reqId: string): BlockReason {
  const now = Date.now();

  // ── Per-session limiter ────────────────────────────────────────────────
  const s = sessions.get(sessionId);
  let sessionCount: number;
  if (!s || now > s.resetAt) {
    sessions.set(sessionId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    sessionCount = 1;
  } else {
    if (s.count >= RATE_MAX) {
      console.warn(`[analyze] ${reqId} rate=BLOCKED session=${sessionId} count=${s.count}/${RATE_MAX}`);
      return 'session';
    }
    s.count++;
    sessionCount = s.count;
  }
  console.log(`[analyze] ${reqId} rate=PASS session=${sessionId} session_count=${sessionCount}/${RATE_MAX}`);

  // ── Global limiter (protects shared Gemini API key) ────────────────────
  if (now > globalResetAt) {
    globalCount = 1;
    globalResetAt = now + RATE_WINDOW_MS;
    console.log(`[analyze] ${reqId} global_rate=PASS count=${globalCount}/${GLOBAL_MAX}`);
    return null;
  }
  if (globalCount >= GLOBAL_MAX) {
    console.warn(`[analyze] ${reqId} rate=GLOBAL_BLOCKED count=${globalCount}/${GLOBAL_MAX}`);
    return 'global';
  }
  globalCount++;
  console.log(`[analyze] ${reqId} global_rate=PASS count=${globalCount}/${GLOBAL_MAX}`);
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-ID, X-Gemini-Key",
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS" },
  });
}

export async function POST(req: NextRequest) {
  const reqId = crypto.randomUUID().slice(0, 8);

  // User-supplied key takes priority over shared env key (BYOK).
  const userApiKey = req.headers.get("x-gemini-key");
  const sharedKey  = process.env.GEMINI_API_KEY;
  const apiKey     = userApiKey || sharedKey;

  if (!apiKey) {
    console.error(`[analyze] ${reqId} no API key available`);
    return json({ error: "Service not configured." }, 500);
  }

  const sessionId = req.headers.get("x-session-id") ?? "anon";

  // Skip global rate limit when user provides their own key — they burn their own quota.
  _m.totalRequests++;
  if (userApiKey) { _m.userKeyRequests++; } else { _m.sharedKeyRequests++; }

  const keyType = userApiKey ? "user" : "shared";
  console.log(
    `[SP:REQ] reqId=${reqId} ts=${new Date().toISOString()}` +
    ` session=${sessionId.slice(-8)} key=${keyType}`
  );

  if (!userApiKey) {
    const blockReason = allowRequest(sessionId, reqId);
    if (blockReason === 'session') {
      console.error(`[analyze] ${reqId} 429 SESSION_RATE_LIMIT session=${sessionId} max=${RATE_MAX}`);
      logMetrics(reqId);
      return json({ error: `Too many requests — please wait a moment and try again.`, source: "session" }, 429);
    }
    if (blockReason === 'global') {
      console.error(`[analyze] ${reqId} 429 GLOBAL_RATE_LIMIT count=${globalCount}/${GLOBAL_MAX}`);
      logMetrics(reqId);
      return json({ error: `Too many requests — please wait a moment and try again.`, source: "global" }, 429);
    }
  }

  let body: {
    screenshot: { image: string; mimeType?: string };
    goal: string;
    pageContext?: Record<string, string>;
    taskState?: { completedSteps?: string[]; currentInstruction?: string } | null;
    enterpriseContext?: {
      application?: string | null;
      module?: string | null;
      workspace?: string | null;
      pageType?: string;
      navigationHierarchy?: string[];
      confidence?: number;
    } | null;
    mode?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const { screenshot, goal, pageContext = {}, taskState = null, enterpriseContext = null, mode: rawMode = "navigate" } = body;
  const mode: Mode = (["navigate", "explain", "ask"] as const).includes(rawMode as Mode)
    ? (rawMode as Mode)
    : "navigate";

  if (!goal?.trim()) return json({ error: "goal is required." }, 400);
  if (!screenshot?.image) return json({ error: "screenshot.image is required." }, 400);

  // Payload size guard — reject oversized screenshots before sending to Gemini
  if (screenshot.image.length > MAX_SCREENSHOT_BYTES) {
    console.warn(`[analyze] ${reqId} screenshot too large: ${screenshot.image.length} bytes`);
    return json({ error: "Screenshot too large. Please zoom out or reduce browser zoom level." }, 413);
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[mode]}:generateContent`;
  const prompt = mode === "ask"
    ? buildQAPrompt(goal, pageContext)
    : buildNavigatePrompt(goal, pageContext, taskState, enterpriseContext);

  // Build request body for logging
  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { mimeType: screenshot.mimeType ?? "image/jpeg", data: screenshot.image } },
        ],
      },
    ],
    generationConfig: {
      temperature: mode === "ask" ? 0.3 : 0.2,
      maxOutputTokens: mode === "ask" ? 512 : 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  console.log(`[analyze] ${reqId} mode=${mode} model=${MODELS[mode]} session=${sessionId} prompt_len=${prompt.length} image_len=${screenshot.image.length}`);

  const TOTAL_BUDGET_MS = 22_000;
  const PER_ATTEMPT_MS  = 12_000;
  const gController     = new AbortController();
  const gBudgetTimer    = setTimeout(() => gController.abort(), TOTAL_BUDGET_MS);
  const MAX_GEMINI_RETRIES = 2;
  try {
    for (let gAttempt = 1; gAttempt <= MAX_GEMINI_RETRIES; gAttempt++) {
      if (gController.signal.aborted) {
        console.error(`[analyze] ${reqId} gemini_budget_exhausted session=${sessionId}`);
        return json({ error: "Analysis timed out — please try again." }, 504);
      }
      _m.totalGeminiCalls++;
      console.log(
        `[SP:GEMINI] reqId=${reqId} attempt=${gAttempt}/${MAX_GEMINI_RETRIES}` +
        ` ts=${new Date().toISOString()} session=${sessionId.slice(-8)}` +
        ` key=${keyType} mode=${mode}`
      );

      let upstream;
      let localTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const localController = new AbortController();
        localTimeout = setTimeout(() => localController.abort(), PER_ATTEMPT_MS);
        gController.signal.addEventListener('abort', () => localController.abort(), { once: true });
        upstream = await fetch(`${geminiUrl}?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: localController.signal,
        });
        clearTimeout(localTimeout);
        localTimeout = undefined;
      } catch (err: unknown) {
        clearTimeout(localTimeout);
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") {
          if (gController.signal.aborted) {
            console.error(`[analyze] ${reqId} gemini_budget_exhausted session=${sessionId}`);
            return json({ error: "Analysis timed out — please try again." }, 504);
          }
          if (gAttempt < MAX_GEMINI_RETRIES) {
            const backoffMs = 1000 * Math.pow(2, gAttempt - 1) + Math.random() * 500;
            console.warn(`[analyze] ${reqId} gemini_timeout retry ${gAttempt + 1}/${MAX_GEMINI_RETRIES} in ${Math.round(backoffMs)}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }
          console.error(`[analyze] ${reqId} gemini_timeout session=${sessionId}`);
          return json({ error: "Analysis timed out — please try again." }, 504);
        }
        console.error(`[analyze] ${reqId} internal_error`, err);
        return json({ error: "Internal server error." }, 500);
      }

      if (!upstream.ok) {
        const errBody = await upstream.json().catch(() => null);
        console.error(`[analyze] ${reqId} gemini_status=${upstream.status} body=${JSON.stringify(errBody)}`);
        if (upstream.status === 429) {
          // Never retry a 429 — retrying burns more quota without benefit.
          _m.total429++;
          const geminiMsg = errBody?.error?.message || JSON.stringify(errBody);
          console.error(`[SP:GEMINI] ${reqId} 429 QUOTA_EXCEEDED key=${keyType} — not retrying`);
          logMetrics(reqId);
          return json({ error: `Gemini API quota exceeded: ${geminiMsg}`, source: "gemini" }, 429);
        }
        return json({ error: `Upstream error ${upstream.status}.` }, 502);
      }

      const data = await upstream.json();
      console.log(`[SP:GEMINI] ${reqId} attempt=${gAttempt} OK mode=${mode}`);
      logMetrics(reqId);
      return NextResponse.json(data, { headers: CORS_HEADERS });
    }
  } finally {
    clearTimeout(gBudgetTimer);
  }
}

function json(body: object, status: number) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

function buildQAPrompt(question: string, pageContext: Record<string, string>): string {
  const ctx = [
    pageContext.url   ? `URL: ${pageContext.url}` : "",
    pageContext.title ? `Page: ${pageContext.title}` : "",
  ].filter(Boolean).join("\n");

  return `${ctx}

The user is looking at this browser screenshot and asking:
"${question}"

Analyze the screenshot and answer accurately. Return ONLY valid JSON (no markdown):
{
  "answer": "1–3 sentence answer referencing what you actually see",
  "confidence": 0.95,
  "elementHint": "text of the most relevant element, or empty string if not applicable"
}

Rules:
- Be specific; reference visible text, buttons, menus, or sections in your answer
- Never assume features that aren't visible in the screenshot
- If you cannot see enough to answer, say so in the answer field
- Return JSON only, no extra text`;
}

/**
 * 8-Step Copilot Architecture:
 * 1. State Detection - detect application, page type, auth state
 * 2. Goal Understanding - convert goal to destination state
 * 3. Gap Analysis - generate transitions path
 * 4. Blocker Detection - check auth, permissions, prerequisites
 * 5. Route Execution - generate single next action only
 * 6. State Verification - verify URL/DOM changed
 * 7. Replanning - generate new route if failed
 * 8. Token Efficiency - cache and reuse
 */

function buildNavigatePrompt(
  goal: string,
  pageContext: Record<string, string>,
  taskState: { completedSteps?: string[]; currentInstruction?: string } | null,
  enterpriseContext?: {
    application?: string | null;
    module?: string | null;
    workspace?: string | null;
    pageType?: string;
    navigationHierarchy?: string[];
    confidence?: number;
  } | null
): string {
  // Build enterprise context line — only inject when confidence is sufficient
  const ec = enterpriseContext;
  const ecLine = (ec && ec.application && (ec.confidence ?? 0) >= 0.5)
    ? [
        ec.application  ? `Enterprise app: ${ec.application}` : "",
        ec.module       ? `Module: ${ec.module}` : "",
        ec.workspace    ? `Workspace: ${ec.workspace}` : "",
        ec.pageType && ec.pageType !== "other" ? `Detected page type: ${ec.pageType}` : "",
        ec.navigationHierarchy?.length ? `Navigation: ${ec.navigationHierarchy.join(" > ")}` : "",
      ].filter(Boolean).join(" | ")
    : "";

  const context = [
    `Goal: ${goal}`,
    pageContext.url   ? `URL: ${pageContext.url}` : "",
    pageContext.title ? `Page title: ${pageContext.title}` : "",
    ecLine || "",
    taskState?.completedSteps?.length
      ? `Completed: ${taskState.completedSteps.join(" → ")}`
      : "",
    taskState?.currentInstruction
      ? `Last instruction: ${taskState.currentInstruction}`
      : "",
  ].filter(Boolean).join("\n");

  return `${context}

You are a universal browser copilot. Follow this 8-step architecture:

## STEP 1: STATE DETECTION
Analyze the screenshot and determine:
- application: name of the app (GitHub, Gmail, Notion, Salesforce, Jira, etc.)
- pageType: one of login|list|detail|form|dashboard|editor|settings|search|media|conversation|empty|error|other
- authenticated: true if signed in, false if not signed in or login page
- currentActivity: what the user is currently doing on this page

## STEP 2: GOAL UNDERSTANDING
Convert the goal into a destination state:
- destinationApplication: the app needed to complete the goal
- destinationPageType: the page type needed (e.g., "repository_creation", "compose_email")

## STEP 3: GAP ANALYSIS
Compare current state vs destination state:
- If same application and pageType: navigationRequired = false
- If different or need different pageType: navigationRequired = true
- Generate transitions: array of page types from current to destination

## STEP 4: BLOCKER DETECTION
Check for blockers BEFORE navigation:
- not_logged_in: user needs to sign in first
- permission_denied: user lacks permissions
- organization_access_missing: needs org access
- account_required: needs account setup
- workspace_not_selected: needs workspace selection

If blocker exists:
- blockers: ["specific blocker message"]
- STOP here, do not continue planning

## STEP 5: ROUTE EXECUTION
Generate ONLY the next actionable step (never full plan):
- nextAction: short instruction like "Click 'New Repository'" or "Fill repository name"
- targetElement: { text: "exact visible text", type: "button|link|input" }
- expectedState: what the page should look like AFTER this action

## STEP 6: STATE VERIFICATION (only if taskState.currentInstruction exists)
Verify the previous action worked:
- urlChanged: did URL change meaningfully?
- domChanged: did page content change?
- pageTypeChanged: did page type change?

If no meaningful change: replan = true

## STEP 7: REPLANNING (only if replan = true)
Reanalyze current screen and generate new route.

## STEP 8: TOKEN EFFICIENCY
- If task is complete: set currentStep to "Task complete", confidence to 1
- If no clear next action: targetElement.text = "", confidence below 0.4

Classify elements using ONLY these action types:
- primary_action: Submit, Save, Create, Send, Confirm, Next, Apply, Post
- secondary_action: Cancel, Back, Reset, Skip, Dismiss, Close
- navigation_action: tab, breadcrumb, sidebar link
- destructive_action: Delete, Remove, Archive, Trash
- menu_action: dropdown, popover, context menu
- content_item: row, card, list item
- input_field: text box, textarea, date picker, select
- filter_control: search bar, filter dropdown
- settings_control: toggle, checkbox, radio

Classify regions using ONLY:
- top_navigation, side_navigation, main_content, toolbar, modal, dropdown, form, footer

Return ONLY valid JSON:
{
  "application": "GitHub",
  "pageType": "repository_detail",
  "authenticated": true,
  "currentActivity": "viewing repository",
  "destinationApplication": "GitHub",
  "destinationPageType": "repository_creation",
  "navigationRequired": true,
  "transitions": ["repository_detail", "dashboard", "repository_creation"],
  "blockers": [],
  "currentStep": "Click 'Your repositories' to go to dashboard",
  "nextAction": "Click 'Your repositories'",
  "targetElement": { "text": "Your repositories", "type": "link" },
  "expectedState": { "pageType": "dashboard" },
  "urlChanged": false,
  "domChanged": true,
  "pageTypeChanged": true,
  "replan": false,
  "confidence": 0.9,
  "candidates": [
    { "text": "Your repositories", "actionType": "navigation_action", "elementType": "link", "region": "side_navigation", "confidence": 0.9, "reasoning": "navigates to dashboard where new repo can be created" }
  ]
}

Rules:
- Return JSON only. No markdown.
- STEP 5: Generate ONE next action only, never a full plan.
- STEP 4: If blocked, return blockers and STOP.
- STEP 6: Only include verification fields if taskState.currentInstruction exists.
- Match element text EXACTLY as shown in the UI.
- If task complete: currentStep = "Task complete", confidence = 1`;
}
