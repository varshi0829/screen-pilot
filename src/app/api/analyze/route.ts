import { NextRequest, NextResponse } from "next/server";
import { buildCorsHeaders, preflight, newRequestId } from "../../../server/http";
import { validateAnalyzeRequest, applyPiiBackstop } from "../../../server/validate";
import { createRateLimiter } from "../../../server/rate-limit";
import { logEvent, logWarn, logError, logModelOutcome } from "../../../server/logger";
import { selectVisionProvider } from "../../../server/model-router";
import { callGemini } from "../../../server/providers/gemini";

const MODE_CONFIG = {
  navigate: { temperature: 0.2, maxOutputTokens: 2048 },
  explain:  { temperature: 0.2, maxOutputTokens: 2048 },
  ask:      { temperature: 0.3, maxOutputTokens: 512 },
} as const;
type Mode = keyof typeof MODE_CONFIG;

const TOTAL_BUDGET_MS      = 22_000;
const PER_ATTEMPT_MS       = 12_000;
const MAX_GEMINI_RETRIES   = 2;

// Phase 2: BYOK removed — provider keys are server-side only. "X-Gemini-Key"
// is no longer accepted or listed as an allowed request header.
const CORS_HEADERS = buildCorsHeaders("Content-Type, X-Session-ID");
const rateLimiter  = createRateLimiter();

export async function OPTIONS() {
  return preflight(CORS_HEADERS, "POST, OPTIONS");
}

export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  const t0    = Date.now();

  const selection = selectVisionProvider();
  if (!selection) {
    logError("analyze_no_key", { reqId });
    return json({ error: "Service not configured." }, 500);
  }

  const sessionId = req.headers.get("x-session-id") ?? "anon";
  logEvent("analyze_request", { reqId, session: sessionId.slice(-8), model: selection.model });

  const block = rateLimiter.check(sessionId);
  if (block === "session" || block === "global") {
    logWarn("analyze_rate_limited", { reqId, scope: block });
    return json({ error: "Too many requests — please wait a moment and try again.", source: block }, 429);
  }

  let body: {
    screenshot: { image: string; mimeType?: string };
    goal: string;
    pageContext?: Record<string, string>;
    taskState?: {
      completedSteps?: string[];
      currentInstruction?: string;
      currentPage?: { url?: string; title?: string };
    } | null;
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

  const invalid = validateAnalyzeRequest(body);
  if (invalid) {
    if (invalid.status === 413) logWarn("analyze_screenshot_too_large", { reqId, bytes: body?.screenshot?.image?.length });
    return json({ error: invalid.error }, invalid.status);
  }

  // Server-side PII backstop — a second, independent layer behind the
  // extension's own client-side sanitizer (Phase 1). Never rejects; the
  // screenshot passes through untouched (masked client-side, not scanned here).
  const safeBody = applyPiiBackstop(body, reqId, "analyze");

  const { screenshot, goal, pageContext = {}, taskState = null, enterpriseContext = null, mode: rawMode = "navigate" } = safeBody;
  const mode: Mode = (["navigate", "explain", "ask"] as const).includes(rawMode as Mode) ? (rawMode as Mode) : "navigate";

  const prompt = mode === "ask"
    ? buildQAPrompt(goal, pageContext)
    : buildNavigatePrompt(goal, pageContext, taskState, enterpriseContext);

  logEvent("analyze_dispatch", { reqId, mode, model: selection.model, session: sessionId, promptLen: prompt.length, imageLen: screenshot.image.length });

  const gController  = new AbortController();
  const gBudgetTimer = setTimeout(() => gController.abort(), TOTAL_BUDGET_MS);
  const { temperature, maxOutputTokens } = MODE_CONFIG[mode];

  try {
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      if (gController.signal.aborted) {
        logError("analyze_budget_exhausted", { reqId, session: sessionId });
        return json({ error: "Analysis timed out — please try again." }, 504);
      }

      logEvent("analyze_attempt", { reqId, attempt, maxAttempts: MAX_GEMINI_RETRIES, mode, model: selection.model });

      const local     = new AbortController();
      const localTimer = setTimeout(() => local.abort(), PER_ATTEMPT_MS);
      gController.signal.addEventListener("abort", () => local.abort(), { once: true });
      const call = await callGemini({ key: selection.key, model: selection.model, prompt, screenshot, signal: local.signal, temperature, maxOutputTokens });
      clearTimeout(localTimer);

      if (!call.ok) {
        // A genuine timeout/AbortError (callGemini reports it as status:0,
        // message:"timeout") is retried once, then 504 — original /api/analyze
        // behavior, deliberately differing from /api/plan's Gemini retry policy
        // (which also retries 5xx). See routes-characterization.test.mjs.
        // A DIFFERENT network-layer failure (status:0 but some other message —
        // e.g. a generic fetch TypeError) is NOT retried and maps to a plain
        // 500 "Internal server error." — also original behavior, and the one
        // case callGemini's uniform {status:0} shape can't distinguish on its
        // own, so it's disambiguated here via the message it set.
        if (call.status === 0 && call.message === "timeout") {
          if (gController.signal.aborted) {
            logError("analyze_budget_exhausted", { reqId, session: sessionId });
            return json({ error: "Analysis timed out — please try again." }, 504);
          }
          if (attempt < MAX_GEMINI_RETRIES) {
            const backoffMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
            logWarn("analyze_timeout_retry", { reqId, nextAttempt: attempt + 1, backoffMs: Math.round(backoffMs) });
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          logError("analyze_timeout", { reqId, session: sessionId });
          return json({ error: "Analysis timed out — please try again." }, 504);
        }
        if (call.status === 0) {
          logError("analyze_internal_error", { reqId });
          return json({ error: "Internal server error." }, 500);
        }

        logError("analyze_upstream_error", { reqId, status: call.status });
        if (call.status === 429) {
          logError("analyze_quota_exceeded", { reqId, model: selection.model });
          return json({ error: `Gemini API quota exceeded: ${call.message}`, source: "gemini" }, 429);
        }
        return json({ error: `Upstream error ${call.status}.` }, 502);
      }

      logModelOutcome("analyze_model_output", { reqId, model: selection.model, rawLength: call.data.rawText.length, parsedOk: true });
      logEvent("analyze_complete", { reqId, attempt, mode, latencyMs: Date.now() - t0 });
      // Contract: /api/analyze returns the raw provider response body verbatim
      // (vision-service.js reads candidates[0].content.parts[0].text itself) —
      // unchanged from before this refactor.
      return NextResponse.json(call.data.raw, { headers: CORS_HEADERS });
    }
  } catch (err) {
    logError("analyze_internal_error", { reqId, message: (err as Error)?.message });
    return json({ error: "Internal server error." }, 500);
  } finally {
    clearTimeout(gBudgetTimer);
  }

  // Unreachable — the loop above always returns; kept only to satisfy TS.
  return json({ error: "Internal server error." }, 500);
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
  taskState: {
    completedSteps?: string[];
    currentInstruction?: string;
    currentPage?: { url?: string; title?: string };
  } | null,
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

  const prevUrl = taskState?.currentPage?.url;
  const urlActuallyChanged = prevUrl && pageContext.url && prevUrl !== pageContext.url;

  const context = [
    `Goal: ${goal}`,
    pageContext.url   ? `URL: ${pageContext.url}` : "",
    urlActuallyChanged ? `Previous URL: ${prevUrl}` : "",
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
