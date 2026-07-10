import { NextRequest, NextResponse } from "next/server";

const PLANNER_VERSION       = "2.0";
const GEMINI_MODEL          = "gemini-2.5-flash";
const RATE_WINDOW_MS        = 60_000;
const RATE_MAX              = 100;
const MAX_SCREENSHOT_BYTES  = 8 * 1024 * 1024;
const TOTAL_BUDGET_MS       = 22_000;
const PER_ATTEMPT_MS        = 12_000;
const MAX_GEMINI_RETRIES    = 2;
const GLOBAL_MAX            = 12;
const MAX_SERVER_SIDE_CALLS = 12;

// Phase 1: single model only. Phase 2: add "anthropic/claude-haiku-4-5-20251001".
const VISION_MODELS: readonly string[] = [
  "google/gemini-2.5-flash",
];

// 400/401/403 mean the request itself is broken — retrying a different model won't help.
const FATAL_UPSTREAM_STATUS = new Set([400, 401, 403]);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const sessions = new Map<string, { count: number; resetAt: number }>();
let globalCount   = 0;
let globalResetAt = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-ID, X-OpenRouter-Key",
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
    trigger:           string;
    reason:            string;
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
  clarifications?: string[];
  pageControls?: Array<{
    region:    string;
    tag:       string;
    text:      string;
    ariaLabel: string;
    title:     string;
    imgAlt:    string;
  }>;
  extensions?: {
    gemini?:     Record<string, unknown>;
    enterprise?: Record<string, unknown>;
    memory?:     Record<string, unknown>;
    [k: string]: Record<string, unknown> | undefined;
  };
};

type PlannerOutput = {
  result:        "OK" | "NEEDS_USER" | "FAILED";
  state:         "planned" | "blocked" | "complete" | "ambiguous";
  interpretation?: {
    goalType:             string;
    application:          string;
    pageType:             string;
    destinationPageType?: string;
    navigationRequired:   boolean;
    authenticated:        boolean;
    currentActivity?:     string;
  };
  blockers?:       string[];
  plannerSummary?: string;
  confidence:      number;
  plan?: {
    goalType:       string;
    confidence:     number;
    steps:          unknown[];
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
      console.warn(`[SP:PLAN] ${reqId} rate=BLOCKED session=${sessionId}`);
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
    console.warn(`[SP:PLAN] ${reqId} rate=GLOBAL_BLOCKED count=${globalCount}/${GLOBAL_MAX}`);
    return "global";
  }
  globalCount++;
  return null;
}

// ── Provider abstraction ──────────────────────────────────────────────────────

type ProviderResult = {
  rawText:      string;
  finishReason: string;
  modelUsed:    string;
  usage: { inputTokens: number; outputTokens: number };
};

type CallOk    = { ok: true;  data: ProviderResult };
type CallError = { ok: false; status: number; message: string };

function extractJson(text: string): string {
  // Strip markdown code fences that Claude, Qwen, and others add around JSON output
  const stripped = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  const match    = stripped.match(/\{[\s\S]*\}/);
  return match?.[0] ?? stripped;
}

async function callGeminiDirect(
  key:        string,
  prompt:     string,
  screenshot: { image: string; mimeType?: string },
  signal:     AbortSignal,
): Promise<CallOk | CallError> {
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: screenshot.mimeType ?? "image/jpeg", data: screenshot.image } },
      ],
    }],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 2048,
      thinkingConfig:  { thinkingBudget: 0 }, // Gemini-specific: disable extended thinking
    },
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${key}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal,
    });
  } catch (err: unknown) {
    const name = (err as Error).name;
    return { ok: false, status: 0, message: (name === "AbortError" || name === "TimeoutError") ? "timeout" : (err as Error).message };
  }

  if (!upstream.ok) {
    const errBody = await upstream.json().catch(() => null);
    return { ok: false, status: upstream.status, message: errBody?.error?.message ?? JSON.stringify(errBody ?? "").slice(0, 500) };
  }

  const data        = await upstream.json();
  const rawText     = (data?.candidates?.[0]?.content?.parts?.[0]?.text  as string | undefined) ?? "";
  const finishReason = (data?.candidates?.[0]?.finishReason               as string | undefined) ?? "STOP";
  return {
    ok: true,
    data: {
      rawText,
      finishReason,
      modelUsed: GEMINI_MODEL,
      usage: {
        inputTokens:  (data?.usageMetadata?.promptTokenCount     as number | undefined) ?? 0,
        outputTokens: (data?.usageMetadata?.candidatesTokenCount as number | undefined) ?? 0,
      },
    },
  };
}

async function callOpenRouter(
  key:        string,
  model:      string,
  prompt:     string,
  screenshot: { image: string; mimeType?: string },
  signal:     AbortSignal,
): Promise<CallOk | CallError> {
  const mimeType = screenshot.mimeType ?? "image/jpeg";
  const body = {
    model,
    messages: [{
      role:    "user",
      content: [
        { type: "text",      text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${screenshot.image}` } },
      ],
    }],
    temperature: 0.1,
    max_tokens:  2048,
  };

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${key}`,
        "HTTP-Referer":  "https://screen-pilot-j1az.vercel.app",
        "X-Title":       "ScreenPilot",
      },
      body:   JSON.stringify(body),
      signal,
    });
  } catch (err: unknown) {
    const name = (err as Error).name;
    return { ok: false, status: 0, message: (name === "AbortError" || name === "TimeoutError") ? "timeout" : (err as Error).message };
  }

  if (!upstream.ok) {
    const errBody = await upstream.json().catch(() => null);
    return { ok: false, status: upstream.status, message: errBody?.error?.message ?? JSON.stringify(errBody ?? "").slice(0, 500) };
  }

  const data         = await upstream.json();
  const rawText      = (data?.choices?.[0]?.message?.content as string | undefined) ?? "";
  const finishReason = (data?.choices?.[0]?.finish_reason   as string | undefined) ?? "stop";
  return {
    ok: true,
    data: {
      rawText,
      finishReason,
      modelUsed: model,
      usage: {
        inputTokens:  (data?.usage?.prompt_tokens     as number | undefined) ?? 0,
        outputTokens: (data?.usage?.completion_tokens as number | undefined) ?? 0,
      },
    },
  };
}

// ── Telemetry ─────────────────────────────────────────────────────────────────

function logTelemetry(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...fields, ts: new Date().toISOString() }));
}

// ── Plan response assembly ────────────────────────────────────────────────────

function assemblePlanResponse(
  reqId:     string,
  t0:        number,
  requestId: string | undefined,
  goal:      string,
  keyType:   string,
  { rawText, finishReason, modelUsed, usage }: ProviderResult,
): NextResponse {
  // Safety blocks: Gemini uses SAFETY/PROHIBITED_CONTENT, OpenRouter uses content_filter
  const isBlocked = finishReason === "SAFETY"
    || finishReason === "PROHIBITED_CONTENT"
    || finishReason === "content_filter";

  if (!rawText || isBlocked) {
    console.error(`[SP:PLAN] reqId=${reqId} blocked finishReason=${finishReason ?? "no_candidates"} model=${modelUsed}`);
    logTelemetry({ event: "plan_failed", reqId, keyType, model: modelUsed, latencyMs: Date.now() - t0, errorCode: "SAFETY_BLOCK", success: false });
    return errorResponse(reqId, "Request blocked by content filters.", "SAFETY_BLOCK", 422, t0);
  }

  let parsed: PlannerOutput;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    console.error(`[SP:PLAN] reqId=${reqId} parse_failed model=${modelUsed} raw=${rawText.slice(0, 300)}`);
    logTelemetry({ event: "plan_failed", reqId, keyType, model: modelUsed, latencyMs: Date.now() - t0, errorCode: "PARSE_ERROR", success: false });
    return errorResponse(reqId, "Planner returned an unparseable response.", "PARSE_ERROR", 502, t0);
  }

  const VALID_RESULTS = new Set(["OK", "NEEDS_USER", "FAILED"]);
  const VALID_STATES  = new Set(["planned", "blocked", "complete", "ambiguous"]);

  const result = VALID_RESULTS.has(parsed.result) ? parsed.result as "OK" | "NEEDS_USER" | "FAILED" : "FAILED";
  const state  = VALID_STATES.has(parsed.state)   ? parsed.state  as "planned" | "blocked" | "complete" | "ambiguous" : "ambiguous";

  if (result !== parsed.result || state !== parsed.state) {
    console.warn(`[SP:PLAN] reqId=${reqId} invalid_enum result=${String(parsed.result)}→${result} state=${String(parsed.state)}→${state}`);
  }

  const planId = crypto.randomUUID();
  const now    = Date.now();

  const planApplicable = result !== "FAILED" && state === "planned" && parsed.plan != null;
  const plan = planApplicable ? {
    planId,
    goal,
    goalType:         parsed.plan!.goalType ?? parsed.interpretation?.goalType ?? "mixed",
    steps:            Array.isArray(parsed.plan!.steps) ? parsed.plan!.steps : [],
    // TODO(bug-10): applicationId is a human-readable name, not a stable fingerprint.
    applicationId:    parsed.plan!.applicationId ?? parsed.interpretation?.application,
    currentStepIndex: 0,
    planVersion:      1,
    confidence:       parsed.plan!.confidence ?? parsed.confidence ?? 0,
    createdAt:        now,
  } : undefined;

  if (!planApplicable && parsed.plan != null) {
    console.warn(`[SP:PLAN] reqId=${reqId} plan_suppressed state=${state}`);
  }

  const latencyMs    = Date.now() - t0;
  const stepCount    = Array.isArray(plan?.steps) ? plan.steps.length : 0;
  const estimatedUSD = ((usage.inputTokens * 0.25) + (usage.outputTokens * 0.75)) / 1_000_000;

  logTelemetry({
    event:        "plan_complete",
    reqId,
    keyType,
    model:        modelUsed,
    latencyMs,
    inputTokens:  usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedUSD,
    result,
    state,
    steps:        stepCount,
    confidence:   parsed.confidence ?? 0,
    success:      true,
  });

  return NextResponse.json({
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
      provider:       "openrouter",
      model:          modelUsed,
      plannerVersion: PLANNER_VERSION,
      latencyMs,
      inputTokens:    usage.inputTokens,
      outputTokens:   usage.outputTokens,
    },
    extensions: { finishReason },
  }, { headers: CORS_HEADERS });
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

  const userOrKey   = req.headers.get("x-openrouter-key"); // BYOK: user's own OpenRouter key
  const sharedOrKey = process.env.OPENROUTER_API_KEY;      // primary shared key
  const geminiKey   = process.env.GEMINI_API_KEY;          // legacy fallback
  const sessionId   = req.headers.get("x-session-id") ?? "anon";
  const keyType     = userOrKey ? "byok" : sharedOrKey ? "shared-or" : "shared-gemini";

  console.log(
    `[SP:PLAN] reqId=${reqId} ts=${new Date().toISOString()}` +
    ` session=${sessionId.slice(-8)} keyType=${keyType}` +
    ` openRouterPresent=${!!(userOrKey || sharedOrKey)} geminiPresent=${!!geminiKey}`
  );

  if (!userOrKey && !sharedOrKey && !geminiKey) {
    return errorResponse(reqId, "Service not configured — no API key available.", "SERVICE_UNAVAILABLE", 500, t0);
  }

  if (!userOrKey) {
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
    recoveryContext, preferences, applicationMetadata, requestId, clarifications,
    pageControls,
  } = body;

  if (!goal?.trim())            return errorResponse(reqId, "goal is required.",                   "INVALID_REQUEST",     400, t0);
  if (!page?.url)               return errorResponse(reqId, "page.url is required.",               "INVALID_REQUEST",     400, t0);
  if (!page?.screenshot?.image) return errorResponse(reqId, "page.screenshot.image is required.",  "INVALID_REQUEST",     400, t0);
  if (page.screenshot.image.length > MAX_SCREENSHOT_BYTES)
    return errorResponse(reqId, "Screenshot too large — zoom out and try again.", "SCREENSHOT_TOO_LARGE", 413, t0);

  // Server-side budget — second line of defense after the client-side session budget
  const attemptCount = executionHistory?.attemptCount ?? 0;
  if (attemptCount > MAX_SERVER_SIDE_CALLS) {
    console.warn(`[SP:PLAN] reqId=${reqId} BUDGET_EXCEEDED attemptCount=${attemptCount}`);
    return errorResponse(reqId, "Planner budget exceeded for this workflow.", "BUDGET_EXCEEDED", 429, t0);
  }

  let prompt: string;
  try {
    prompt = buildPlannerPrompt({
      goal, page, previousPage, executionHistory,
      workflowMemory, recoveryContext, preferences, applicationMetadata, clarifications,
      pageControls,
    });
  } catch (err) {
    console.error(`[SP:PLAN] reqId=${reqId} prompt_build_error`, err);
    return errorResponse(reqId, "Invalid request data.", "INVALID_REQUEST", 400, t0);
  }

  console.log(
    `[SP:PLAN] reqId=${reqId} keyType=${keyType}` +
    ` prompt_len=${prompt.length} image_len=${page.screenshot.image.length} attemptCount=${attemptCount}`
  );

  const gController  = new AbortController();
  const gBudgetTimer = setTimeout(() => gController.abort(), TOTAL_BUDGET_MS);

  try {
    // ── BYOK: user-supplied OpenRouter key ─────────────────────────────────
    if (userOrKey) {
      if (gController.signal.aborted) return errorResponse(reqId, "Analysis timed out.", "TIMEOUT", 504, t0);
      const local = new AbortController();
      const lt    = setTimeout(() => local.abort(), PER_ATTEMPT_MS);
      gController.signal.addEventListener("abort", () => local.abort(), { once: true });
      const call  = await callOpenRouter(userOrKey, VISION_MODELS[0], prompt, page.screenshot, local.signal);
      clearTimeout(lt);
      if (!call.ok) {
        logTelemetry({ event: "plan_failed", reqId, keyType, model: VISION_MODELS[0], latencyMs: Date.now() - t0, upstreamStatus: call.status, errorCode: "UPSTREAM_ERROR", success: false });
        return errorResponse(reqId, call.message, "UPSTREAM_ERROR", 502, t0, { provider: "openrouter", upstreamStatus: call.status, message: call.message });
      }
      return assemblePlanResponse(reqId, t0, requestId, goal, keyType, call.data);
    }

    // ── Shared OpenRouter key: try each model in priority order ────────────
    if (sharedOrKey) {
      let lastErr = { status: 0, message: "all models exhausted" };
      for (const model of VISION_MODELS) {
        if (gController.signal.aborted) return errorResponse(reqId, "Analysis timed out.", "TIMEOUT", 504, t0);
        console.log(`[SP:PLAN] reqId=${reqId} trying model=${model}`);
        const local = new AbortController();
        const lt    = setTimeout(() => local.abort(), PER_ATTEMPT_MS);
        gController.signal.addEventListener("abort", () => local.abort(), { once: true });
        const call  = await callOpenRouter(sharedOrKey, model, prompt, page.screenshot, local.signal);
        clearTimeout(lt);
        if (call.ok) return assemblePlanResponse(reqId, t0, requestId, goal, keyType, call.data);
        logTelemetry({ event: "plan_failed", reqId, keyType, model, latencyMs: Date.now() - t0, upstreamStatus: call.status, errorCode: "UPSTREAM_ERROR", success: false });
        lastErr = { status: call.status, message: call.message };
        if (FATAL_UPSTREAM_STATUS.has(call.status)) {
          console.error(`[SP:PLAN] reqId=${reqId} fatal status=${call.status} model=${model} — aborting`);
          return errorResponse(reqId, call.message, "UPSTREAM_ERROR", 502, t0, { provider: "openrouter", upstreamStatus: call.status, message: call.message });
        }
        console.warn(`[SP:PLAN] reqId=${reqId} model=${model} status=${call.status} — trying next`);
      }
      return errorResponse(reqId, lastErr.message, "UPSTREAM_ERROR", 502, t0, { provider: "openrouter", upstreamStatus: lastErr.status, message: lastErr.message });
    }

    // ── Legacy: shared Gemini key (OPENROUTER_API_KEY not set) ────────────
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      if (gController.signal.aborted) return errorResponse(reqId, "Analysis timed out.", "TIMEOUT", 504, t0);
      console.log(`[SP:PLAN] reqId=${reqId} gemini-direct attempt=${attempt}/${MAX_GEMINI_RETRIES}`);
      const local = new AbortController();
      const lt    = setTimeout(() => local.abort(), PER_ATTEMPT_MS);
      gController.signal.addEventListener("abort", () => local.abort(), { once: true });
      const call  = await callGeminiDirect(geminiKey!, prompt, page.screenshot, local.signal);
      clearTimeout(lt);
      if (call.ok) return assemblePlanResponse(reqId, t0, requestId, goal, keyType, call.data);
      logTelemetry({ event: "plan_failed", reqId, keyType, model: GEMINI_MODEL, latencyMs: Date.now() - t0, upstreamStatus: call.status, errorCode: call.status === 429 ? "QUOTA_EXCEEDED" : "UPSTREAM_ERROR", success: false });
      if (FATAL_UPSTREAM_STATUS.has(call.status) || call.status === 429) {
        return errorResponse(reqId, call.message, call.status === 429 ? "QUOTA_EXCEEDED" : "UPSTREAM_ERROR",
          call.status === 429 ? 429 : 502, t0, { provider: "gemini", upstreamStatus: call.status, message: call.message });
      }
      if (attempt < MAX_GEMINI_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.warn(`[SP:PLAN] reqId=${reqId} gemini timeout — retry in ${Math.round(backoff)}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0);
  } finally {
    clearTimeout(gBudgetTimer);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorResponse(
  reqId:     string,
  message:   string,
  errorCode: string,
  status:    number,
  t0:        number,
  extra?:    Record<string, unknown>,
) {
  const latencyMs = Date.now() - t0;
  console.error(`[SP:PLAN] reqId=${reqId} ${errorCode} latencyMs=${latencyMs}`);
  return NextResponse.json(
    {
      schemaVersion: "1",
      result:        "FAILED",
      blockers:      [],
      confidence:    0,
      providerMetadata: {
        provider:       "openrouter",
        model:          VISION_MODELS[0],
        plannerVersion: PLANNER_VERSION,
        latencyMs,
      },
      error:     message,
      errorCode,
      ...extra,
    },
    { status, headers: CORS_HEADERS }
  );
}

function buildPlannerPrompt(req: {
  goal:                 string;
  page:                 { url: string; title: string };
  previousPage?:        { url: string; title: string };
  executionHistory?:    { completedSteps: Array<{ description: string; intent: string }>; planVersion: number; attemptCount: number };
  workflowMemory?:      { application?: string; visitedUrls?: string[]; extractedData?: Record<string, unknown> };
  recoveryContext?:     { trigger: string; reason: string; failedStepIntent?: string };
  preferences?:         { confirmDestructiveActions?: boolean; maxSteps?: number; language?: string };
  applicationMetadata?: { application?: string; module?: string; workspace?: string; pageType?: string; navigationHierarchy?: string[]; confidence?: number };
  clarifications?:      string[];
  pageControls?:        Array<{ region: string; tag: string; text: string; ariaLabel: string; title: string; imgAlt: string }>;
}): string {
  const lines: string[] = [
    `Goal: ${req.goal}`,
  ];

  if (req.clarifications?.length) {
    lines.push(`User clarifications (apply when choosing between paths):\n${req.clarifications.map(c => `- ${c}`).join('\n')}`);
  }

  lines.push(
    `Current URL: ${req.page.url}`,
    `Current page: ${req.page.title}`,
  );

  if (req.previousPage) {
    lines.push(`Previous URL: ${req.previousPage.url}`);
  }

  const am = req.applicationMetadata;
  if (am?.application && (am.confidence ?? 0) >= 0.5) {
    lines.push([
      `App: ${am.application}`,
      am.module                              ? `Module: ${am.module}`                          : "",
      am.workspace                           ? `Workspace: ${am.workspace}`                    : "",
      am.pageType && am.pageType !== "other" ? `Page type: ${am.pageType}`                    : "",
      am.navigationHierarchy?.length         ? `Nav: ${am.navigationHierarchy.join(" > ")}`   : "",
    ].filter(Boolean).join(" | "));
  }

  if (req.executionHistory?.completedSteps.length) {
    lines.push(`Completed: ${req.executionHistory.completedSteps.map(s => s.description).join(" → ")}`);
    lines.push(`Plan version: ${req.executionHistory.planVersion} | Recovery attempts: ${req.executionHistory.attemptCount}`);
  }

  if (req.workflowMemory?.extractedData && Object.keys(req.workflowMemory.extractedData).length) {
    // TODO(bug-12): No size limit on extractedData. Truncate to ~500 chars before Phase 3.
    lines.push(`Extracted data: ${JSON.stringify(req.workflowMemory.extractedData)}`);
  }

  if (req.recoveryContext) {
    lines.push(`⚠ Recovery requested: ${req.recoveryContext.reason} (trigger: ${req.recoveryContext.trigger})`);
    if (req.recoveryContext.failedStepIntent) {
      lines.push(`Failed step intent: ${req.recoveryContext.failedStepIntent}`);
    }
  }

  if (req.pageControls?.length) {
    const entries = req.pageControls.map(c => {
      const label   = c.text || c.ariaLabel || c.imgAlt || c.title;
      const iconTag = !c.text ? ' (icon-only)' : '';
      return label ? `[${c.region}] ${c.tag} → "${label}"${iconTag}` : null;
    }).filter((e): e is string => e !== null);
    if (entries.length) {
      lines.push(
        'Interactive controls on this page — use these exact strings for targetElement.text:',
        ...entries,
      );
    }
  }

  const maxSteps    = req.preferences?.maxSteps ?? 10;
  const confirmDest = req.preferences?.confirmDestructiveActions !== false;
  // TODO(bug-11): preferences.language is never injected into the prompt.
  // TODO(bug-13): step.phase is advisory; validate against enum in the Phase 3 executor.

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
- Prefer the SHORTEST PATH. If a global navigation control on the current page can achieve the goal (header "+" menu, sidebar Create button, toolbar action), use it directly. Do NOT add steps to navigate to a dashboard or home page first.
  Examples of always-available global controls: GitHub "+" (new repo/issue/PR from any page), Gmail "Compose" (always in left sidebar), LinkedIn message icon (always in top nav), YouTube "Create" (always in top nav).
- If the goal is already achieved: state="complete", plan.steps=[].
- If blocked (not logged in, permission denied): result="OK", state="blocked", list blockers[], plan omitted.
- If multiple valid paths exist and user must choose: result="NEEDS_USER", state="ambiguous".
- If a destructive action requires explicit user confirmation: result="NEEDS_USER", state="planned".
- plannerSummary: 1–2 sentences on why this route was chosen (not a step list).
- Match element text EXACTLY as visible in the screenshot.
- targetElement.text must NEVER be null or empty. When the Interactive controls list above is present: find the element in the list and copy its quoted string EXACTLY as targetElement.text — character-for-character, no paraphrasing. For icon-only entries (marked as such), the quoted string is the element's aria-label or img alt text — the only machine-readable DOM identifier for that button; generating a visual description instead will cause element:not_found. When the list is absent or the element is not listed: for icon-only or image elements use a short descriptive phrase.
- alternatives[]: 2–3 fallback texts for the same element, ordered by likelihood.
- If userClarifications are provided, they represent explicit preferences recorded during this session. Use them to resolve ambiguous paths. Do NOT return state="ambiguous" when a clarification directly addresses the choice — instead set state="planned" and mention the applied clarification in plannerSummary.`;
}
