import { NextRequest, NextResponse } from "next/server";

const PLANNER_VERSION      = "2.0";
const GEMINI_MODEL         = "gemini-2.5-flash";
const RATE_WINDOW_MS       = 60_000;
const RATE_MAX             = 100;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const TOTAL_BUDGET_MS      = 22_000;
const PER_ATTEMPT_MS       = 12_000;
const MAX_GEMINI_RETRIES   = 2;
const GLOBAL_MAX           = 12;

const sessions = new Map<string, { count: number; resetAt: number }>();
let globalCount   = 0;
let globalResetAt = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-ID, X-Gemini-Key",
};

// ── Request / Response types ──────────────────────────────────────────────────

type PlanRequest = {
  schemaVersion?: string;
  requestId?:     string;
  goal:           string;
  page: {
    url:        string;
    title:      string;
    screenshot: { image: string; mimeType?: string };
  };
  previousPage?: { url: string; title: string };
  executionHistory?: {
    completedSteps: Array<{ description: string; intent: string; completedAt?: number }>;
    planVersion:    number;
    attemptCount:   number;
  };
  workflowMemory?: {
    application?:   string;
    visitedUrls?:   string[];
    extractedData?: Record<string, unknown>;
  };
  recoveryContext?: {
    trigger:          string;
    reason:           string;
    failedStepIntent?: string;
  };
  preferences?: {
    confirmDestructiveActions?: boolean;
    maxSteps?:                  number;
    language?:                  string;
  };
  applicationMetadata?: {
    application?:         string;
    module?:              string;
    workspace?:           string;
    pageType?:            string;
    navigationHierarchy?: string[];
    confidence?:          number;
  };
  extensions?: {
    gemini?:     Record<string, unknown>;
    enterprise?: Record<string, unknown>;
    memory?:     Record<string, unknown>;
    [k: string]: Record<string, unknown> | undefined;
  };
};

// Shape that Gemini is asked to return — server adds planId, goal, createdAt, etc.
type PlannerOutput = {
  result:        "OK" | "NEEDS_USER" | "FAILED";
  state:         "planned" | "blocked" | "complete" | "ambiguous";
  interpretation?: {
    goalType:              string;
    application:           string;
    pageType:              string;
    destinationPageType?:  string;
    navigationRequired:    boolean;
    authenticated:         boolean;
    currentActivity?:      string;
  };
  blockers?:       string[];
  plannerSummary?: string;
  confidence:      number;
  plan?: {
    goalType:    string;
    confidence:  number;
    steps:       unknown[];
    applicationId?: string;
  };
};

// ── Rate limiting ─────────────────────────────────────────────────────────────

function checkRateLimit(sessionId: string, reqId: string, isUserKey: boolean): "session" | "global" | null {
  const now = Date.now();
  const s   = sessions.get(sessionId);
  if (!s || now > s.resetAt) {
    sessions.set(sessionId, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    if (s.count >= RATE_MAX) {
      console.warn(`[plan] ${reqId} rate=BLOCKED session=${sessionId}`);
      return "session";
    }
    s.count++;
  }
  if (isUserKey) return null;
  if (now > globalResetAt) {
    globalCount   = 1;
    globalResetAt = now + RATE_WINDOW_MS;
    return null;
  }
  if (globalCount >= GLOBAL_MAX) {
    console.warn(`[plan] ${reqId} rate=GLOBAL_BLOCKED count=${globalCount}/${GLOBAL_MAX}`);
    return "global";
  }
  globalCount++;
  return null;
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function OPTIONS() {
  return new NextResponse(null, {
    status:  204,
    headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS" },
  });
}

export async function POST(req: NextRequest) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const t0    = Date.now();

  const userKey   = req.headers.get("x-gemini-key");
  const sharedKey = process.env.GEMINI_API_KEY;
  const apiKey    = userKey || sharedKey;

  if (!apiKey) {
    return errorResponse(reqId, "Service not configured.", "SERVICE_UNAVAILABLE", 500, t0);
  }

  const sessionId = req.headers.get("x-session-id") ?? "anon";
  const keyType   = userKey ? "user" : "shared";

  console.log(
    `[SP:PLAN] reqId=${reqId} ts=${new Date().toISOString()}` +
    ` session=${sessionId.slice(-8)} key=${keyType}`
  );

  if (!userKey) {
    const block = checkRateLimit(sessionId, reqId, false);
    if (block === "session") return errorResponse(reqId, "Too many requests — please wait a moment.", "RATE_LIMITED", 429, t0);
    if (block === "global")  return errorResponse(reqId, "Too many requests — please wait a moment.", "RATE_LIMITED", 429, t0);
  }

  let body: PlanRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse(reqId, "Invalid JSON body.", "INVALID_REQUEST", 400, t0);
  }

  const {
    goal, page, previousPage, executionHistory, workflowMemory,
    recoveryContext, preferences, applicationMetadata, requestId,
  } = body;

  if (!goal?.trim())              return errorResponse(reqId, "goal is required.",                   "INVALID_REQUEST",    400, t0);
  if (!page?.url)                 return errorResponse(reqId, "page.url is required.",               "INVALID_REQUEST",    400, t0);
  if (!page?.screenshot?.image)   return errorResponse(reqId, "page.screenshot.image is required.",  "INVALID_REQUEST",    400, t0);
  if (page.screenshot.image.length > MAX_SCREENSHOT_BYTES)
    return errorResponse(reqId, "Screenshot too large — zoom out and try again.", "SCREENSHOT_TOO_LARGE", 413, t0);

  let prompt: string;
  try {
    prompt = buildPlannerPrompt({
      goal, page, previousPage, executionHistory,
      workflowMemory, recoveryContext, preferences, applicationMetadata,
    });
  } catch (err) {
    console.error(`[plan] ${reqId} prompt_build_error`, err);
    return errorResponse(reqId, "Invalid request data.", "INVALID_REQUEST", 400, t0);
  }

  const geminiUrl   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const geminiBody  = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: page.screenshot.mimeType ?? "image/jpeg", data: page.screenshot.image } },
      ],
    }],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 4096,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  };

  console.log(
    `[SP:PLAN] reqId=${reqId} mode=plan model=${GEMINI_MODEL}` +
    ` session=${sessionId} prompt_len=${prompt.length} image_len=${page.screenshot.image.length}`
  );

  const gController  = new AbortController();
  const gBudgetTimer = setTimeout(() => gController.abort(), TOTAL_BUDGET_MS);

  try {
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      if (gController.signal.aborted) {
        return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0);
      }

      console.log(`[SP:PLAN] reqId=${reqId} attempt=${attempt}/${MAX_GEMINI_RETRIES}`);

      let upstream: Response;
      let localTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const local = new AbortController();
        localTimeout = setTimeout(() => local.abort(), PER_ATTEMPT_MS);
        gController.signal.addEventListener("abort", () => local.abort(), { once: true });
        upstream = await fetch(geminiUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(geminiBody),
          signal:  local.signal,
        });
        clearTimeout(localTimeout);
      } catch (err: unknown) {
        clearTimeout(localTimeout);
        const name = (err as Error).name;
        if (name === "AbortError" || name === "TimeoutError") {
          if (gController.signal.aborted) {
            return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0);
          }
          if (attempt < MAX_GEMINI_RETRIES) {
            const backoff = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.warn(`[plan] ${reqId} timeout — retry ${attempt + 1}/${MAX_GEMINI_RETRIES} in ${Math.round(backoff)}ms`);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0);
        }
        console.error(`[plan] ${reqId} fetch error`, err);
        return errorResponse(reqId, "Internal server error.", "INTERNAL_ERROR", 500, t0);
      }

      if (!upstream.ok) {
        const errBody = await upstream.json().catch(() => null);
        if (upstream.status === 429) {
          const msg = errBody?.error?.message ?? JSON.stringify(errBody);
          console.error(`[SP:PLAN] ${reqId} 429 QUOTA_EXCEEDED key=${keyType}`);
          return errorResponse(reqId, `Gemini API quota exceeded: ${msg}`, "QUOTA_EXCEEDED", 429, t0);
        }
        console.error(`[plan] ${reqId} gemini_status=${upstream.status}`);
        return errorResponse(reqId, `Upstream error ${upstream.status}.`, "UPSTREAM_ERROR", 502, t0);
      }

      const geminiData   = await upstream.json();
      const finishReason = geminiData?.candidates?.[0]?.finishReason as string | undefined;
      const rawText      = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      if (!rawText || finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
        console.error(`[plan] ${reqId} gemini_blocked finishReason=${finishReason ?? "no_candidates"}`);
        return errorResponse(reqId, "Request blocked by Gemini content filters.", "SAFETY_BLOCK", 422, t0);
      }

      let parsed: PlannerOutput;
      try {
        const match = rawText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match?.[0] ?? rawText);
      } catch {
        console.error(`[plan] ${reqId} JSON parse failed — raw: ${rawText.slice(0, 300)}`);
        return errorResponse(reqId, "Planner returned an unparseable response.", "PARSE_ERROR", 502, t0);
      }

      const latencyMs = Date.now() - t0;

      // Validate enums — never trust Gemini to return exactly the values we specified.
      // Unknown values fall back to safe sentinels rather than silently succeeding.
      const VALID_RESULTS = new Set(["OK", "NEEDS_USER", "FAILED"]);
      const VALID_STATES  = new Set(["planned", "blocked", "complete", "ambiguous"]);

      const result = VALID_RESULTS.has(parsed.result)
        ? parsed.result as "OK" | "NEEDS_USER" | "FAILED"
        : "FAILED";
      const state  = VALID_STATES.has(parsed.state)
        ? parsed.state as "planned" | "blocked" | "complete" | "ambiguous"
        : "ambiguous";

      if (result !== parsed.result || state !== parsed.state) {
        console.warn(
          `[plan] ${reqId} invalid_enum result=${String(parsed.result)}→${result}` +
          ` state=${String(parsed.state)}→${state}`
        );
      }

      // Server-generated fields that callers must never produce themselves.
      const planId = crypto.randomUUID();
      const now    = Date.now();

      // A plan is only meaningful when the planner determined there are steps to execute.
      // Suppressed for: result=FAILED (nothing is actionable), state=blocked (gate not met),
      // state=complete (goal already done). The orchestrator must not execute steps unless
      // result=OK and state=planned are both true.
      const planApplicable = result !== "FAILED" && state === "planned" && parsed.plan != null;
      const plan = planApplicable ? {
        planId,
        goal,
        goalType:         parsed.plan!.goalType ?? parsed.interpretation?.goalType ?? "mixed",
        steps:            Array.isArray(parsed.plan!.steps) ? parsed.plan!.steps : [],
        // TODO(bug-10): applicationId stores a human-readable name ("GitHub") rather than
        // a stable fingerprint. Phase 3 application-detection will need a normalised ID
        // format before applicationId can be used reliably for plan caching or telemetry.
        applicationId:    parsed.plan!.applicationId ?? parsed.interpretation?.application,
        currentStepIndex: 0,
        planVersion:      1,
        confidence:       parsed.plan!.confidence ?? parsed.confidence ?? 0,
        createdAt:        now,
      } : undefined;

      if (!planApplicable && parsed.plan != null) {
        console.warn(`[plan] ${reqId} plan_suppressed state=${state}`);
      }

      const response = {
        schemaVersion:  "1" as const,
        requestId,
        result,
        state,
        plan,
        interpretation: parsed.interpretation,
        blockers:       parsed.blockers ?? [],
        plannerSummary: parsed.plannerSummary,
        confidence:     parsed.confidence ?? 0,
        providerMetadata: {
          provider:       "gemini",
          model:          GEMINI_MODEL,
          plannerVersion: PLANNER_VERSION,
          latencyMs,
          inputTokens:    geminiData?.usageMetadata?.promptTokenCount    as number | undefined,
          outputTokens:   geminiData?.usageMetadata?.candidatesTokenCount as number | undefined,
        },
        extensions: {
          gemini: { finishReason },
        },
      };

      const stepCount = Array.isArray(plan?.steps) ? plan.steps.length : 0;
      console.log(
        `[SP:PLAN] reqId=${reqId} OK result=${result} state=${state}` +
        ` steps=${stepCount} confidence=${response.confidence} latency=${latencyMs}ms`
      );

      return NextResponse.json(response, { headers: CORS_HEADERS });
    }
  } finally {
    clearTimeout(gBudgetTimer);
  }

  return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorResponse(reqId: string, message: string, errorCode: string, status: number, t0: number) {
  console.error(`[plan] ${reqId} ${errorCode} latency=${Date.now() - t0}ms`);
  return NextResponse.json(
    {
      schemaVersion: "1",
      result:        "FAILED",
      blockers:      [],
      confidence:    0,
      providerMetadata: {
        provider:       "gemini",
        model:          GEMINI_MODEL,
        plannerVersion: PLANNER_VERSION,
        latencyMs:      Date.now() - t0,
      },
      error:     message,
      errorCode,
    },
    { status, headers: CORS_HEADERS }
  );
}

function buildPlannerPrompt(req: {
  goal:                string;
  page:                { url: string; title: string };
  previousPage?:       { url: string; title: string };
  executionHistory?:   { completedSteps: Array<{ description: string; intent: string }>; planVersion: number; attemptCount: number };
  workflowMemory?:     { application?: string; visitedUrls?: string[]; extractedData?: Record<string, unknown> };
  recoveryContext?:    { trigger: string; reason: string; failedStepIntent?: string };
  preferences?:        { confirmDestructiveActions?: boolean; maxSteps?: number; language?: string };
  applicationMetadata?: { application?: string; module?: string; workspace?: string; pageType?: string; navigationHierarchy?: string[]; confidence?: number };
}): string {
  const lines: string[] = [
    `Goal: ${req.goal}`,
    `Current URL: ${req.page.url}`,
    `Current page: ${req.page.title}`,
  ];

  if (req.previousPage) {
    lines.push(`Previous URL: ${req.previousPage.url}`);
  }

  const am = req.applicationMetadata;
  if (am?.application && (am.confidence ?? 0) >= 0.5) {
    lines.push([
      `App: ${am.application}`,
      am.module                    ? `Module: ${am.module}`                               : "",
      am.workspace                 ? `Workspace: ${am.workspace}`                         : "",
      am.pageType && am.pageType !== "other" ? `Page type: ${am.pageType}`               : "",
      am.navigationHierarchy?.length ? `Nav: ${am.navigationHierarchy.join(" > ")}`      : "",
    ].filter(Boolean).join(" | "));
  }

  if (req.executionHistory?.completedSteps.length) {
    lines.push(`Completed: ${req.executionHistory.completedSteps.map(s => s.description).join(" → ")}`);
    lines.push(`Plan version: ${req.executionHistory.planVersion} | Recovery attempts: ${req.executionHistory.attemptCount}`);
  }

  if (req.workflowMemory?.extractedData && Object.keys(req.workflowMemory.extractedData).length) {
    // TODO(bug-12): No size limit on extractedData injected into the prompt. A large payload
    // (e.g. a full API response extracted as workflow memory) can push past Gemini's context
    // limit or degrade planning quality. Truncate to ~500 chars before Phase 3 ships.
    lines.push(`Extracted data: ${JSON.stringify(req.workflowMemory.extractedData)}`);
  }

  if (req.recoveryContext) {
    lines.push(`⚠ Recovery requested: ${req.recoveryContext.reason} (trigger: ${req.recoveryContext.trigger})`);
    if (req.recoveryContext.failedStepIntent) {
      lines.push(`Failed step intent: ${req.recoveryContext.failedStepIntent}`);
    }
  }

  const maxSteps    = req.preferences?.maxSteps ?? 10;
  const confirmDest = req.preferences?.confirmDestructiveActions !== false;
  // TODO(bug-11): preferences.language is accepted in PlanRequest but never injected
  // into the prompt. Until it is, all instructions are produced in English regardless
  // of the user's locale. Add `If the page language is X, respond in X.` to the prompt.

  // TODO(bug-13): The phase enum list in the prompt is advisory, not enforced. Gemini may
  // still invent values. The Phase 3 executor should validate step.phase against the enum
  // before passing the step to the element resolver, and default to "navigate" if invalid.

  return `${lines.join("\n")}

You are the ScreenPilot planning engine. Analyze this browser screenshot and produce a complete execution plan — ALL steps needed to achieve the goal from the current state.

Limit to ${maxSteps} steps maximum.
${confirmDest ? "Set reversible=false for destructive actions (delete, remove, archive, send, publish, submit final forms)." : ""}

Element action types — use exactly these values:
primary_action | secondary_action | navigation_action | destructive_action | menu_action | content_item | input_field | filter_control | settings_control

Element regions — use exactly these values:
top_navigation | side_navigation | main_content | toolbar | modal | dropdown | form | footer

Completion conditions — use exactly these values:
url_change | dom_change | input_filled | element_disappears | final

Step phases — use exactly these values:
navigate | fill_form | submit | confirm

Return ONLY valid JSON (no markdown, no explanation):
{
  "result": "OK",
  "state": "planned",
  "interpretation": {
    "goalType": "navigation",
    "application": "GitHub",
    "pageType": "dashboard",
    "destinationPageType": "repository_creation",
    "navigationRequired": true,
    "authenticated": true,
    "currentActivity": "browsing dashboard"
  },
  "blockers": [],
  "plannerSummary": "Starting from the dashboard, the New button in the top navigation directly opens the repository creation form — no intermediate navigation required.",
  "confidence": 0.9,
  "plan": {
    "goalType": "navigation",
    "confidence": 0.9,
    "steps": [
      {
        "id": 1,
        "description": "Click 'New' to open the repository creation form",
        "intent": "navigate to repository creation",
        "phase": "navigate",
        "optional": false,
        "timeout_ms": 3000,
        "completionCondition": "url_change",
        "targetElement": {
          "text": "New",
          "type": "button",
          "region": "top_navigation",
          "intent": "create new repository",
          "alternatives": ["New repository", "Create repository", "+ New"]
        },
        "precondition": {},
        "expectedPageState": { "urlPattern": "/new", "urlChanges": true },
        "reversible": true
      }
    ]
  }
}

Rules:
- Return JSON only. No markdown.
- Produce ALL steps — never just the next one.
- If the goal is already achieved: state="complete", plan.steps=[].
- If blocked (not logged in, permission denied): result="OK", state="blocked", list blockers[], plan omitted.
- If multiple valid paths exist and user must choose: result="NEEDS_USER", state="ambiguous".
- If a destructive action requires explicit user confirmation: result="NEEDS_USER", state="planned".
- plannerSummary: 1–2 sentences on why this route was chosen (not a step list).
- Match element text EXACTLY as visible in the screenshot.
- alternatives[]: 2–3 fallback texts for the same element, ordered by likelihood.`;
}
