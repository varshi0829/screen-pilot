import { NextRequest, NextResponse } from "next/server";
import { buildCorsHeaders, preflight, newRequestId } from "../../../server/http";
import { validatePlanRequest, applyPiiBackstop } from "../../../server/validate";
import { createRateLimiter } from "../../../server/rate-limit";
import { logEvent, logWarn, logError, logModelOutcome } from "../../../server/logger";
import { selectPlannerChain, runPlannerChain } from "../../../server/model-router";

const PLANNER_VERSION       = "2.0";
const TOTAL_BUDGET_MS       = 22_000;
const PER_ATTEMPT_MS        = 12_000;
const MAX_SERVER_SIDE_CALLS = 12;

// Phase 2: BYOK removed — provider keys are server-side only (env vars via
// model-router.ts). "X-OpenRouter-Key"/"X-Gemini-Key" are no longer accepted
// or listed as allowed request headers.
const CORS_HEADERS = buildCorsHeaders("Content-Type, X-Session-ID");
const rateLimiter  = createRateLimiter();

// ── Request / Response types (unchanged) ───────────────────────────────────────

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
  // Phase 23A: optional, plan-level goal-completion contract. Passed through
  // verbatim — never validated, coerced, or acted upon in this phase.
  goalCompletionCriteria?: Record<string, unknown>;
  plan?: {
    goalType:       string;
    confidence:     number;
    steps:          unknown[];
    applicationId?: string;
  };
};

function extractJson(text: string): string {
  // Strip markdown code fences that Claude, Qwen, and others add around JSON output
  const stripped = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  const match    = stripped.match(/\{[\s\S]*\}/);
  return match?.[0] ?? stripped;
}

// ── Plan response assembly (unchanged logic; provider tag now selection-driven) ─

function assemblePlanResponse(
  reqId:     string,
  t0:        number,
  requestId: string | undefined,
  goal:      string,
  provider:  string,
  model:     string,
  { rawText, finishReason, usage }: { rawText: string; finishReason: string; usage: { inputTokens: number; outputTokens: number } },
): NextResponse {
  // Safety blocks: Gemini uses SAFETY/PROHIBITED_CONTENT, OpenRouter uses content_filter
  const isBlocked = finishReason === "SAFETY"
    || finishReason === "PROHIBITED_CONTENT"
    || finishReason === "content_filter";

  if (!rawText || isBlocked) {
    logError("plan_blocked", { reqId, finishReason: finishReason ?? "no_candidates", model });
    logEvent("plan_failed", { reqId, provider, model, latencyMs: Date.now() - t0, errorCode: "SAFETY_BLOCK", success: false });
    return errorResponse(reqId, "Request blocked by content filters.", "SAFETY_BLOCK", 422, t0, provider, model);
  }

  let parsed: PlannerOutput;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    logModelOutcome("plan_parse_failed", { reqId, model, rawLength: rawText.length, parsedOk: false });
    logEvent("plan_failed", { reqId, provider, model, latencyMs: Date.now() - t0, errorCode: "PARSE_ERROR", success: false });
    return errorResponse(reqId, "Planner returned an unparseable response.", "PARSE_ERROR", 502, t0, provider, model);
  }
  logModelOutcome("plan_model_output", { reqId, model, rawLength: rawText.length, parsedOk: true });

  const VALID_RESULTS = new Set(["OK", "NEEDS_USER", "FAILED"]);
  const VALID_STATES  = new Set(["planned", "blocked", "complete", "ambiguous"]);

  const result = VALID_RESULTS.has(parsed.result) ? parsed.result as "OK" | "NEEDS_USER" | "FAILED" : "FAILED";
  const state  = VALID_STATES.has(parsed.state)   ? parsed.state  as "planned" | "blocked" | "complete" | "ambiguous" : "ambiguous";

  if (result !== parsed.result || state !== parsed.state) {
    logWarn("plan_invalid_enum", { reqId, rawResult: String(parsed.result), result, rawState: String(parsed.state), state });
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
    // Phase 23A: preserve verbatim when present; undefined when absent. Not evaluated.
    goalCompletionCriteria: parsed.goalCompletionCriteria,
  } : undefined;

  if (!planApplicable && parsed.plan != null) {
    logWarn("plan_suppressed", { reqId, state });
  }

  const latencyMs    = Date.now() - t0;
  const stepCount    = Array.isArray(plan?.steps) ? plan.steps.length : 0;
  const estimatedUSD = ((usage.inputTokens * 0.25) + (usage.outputTokens * 0.75)) / 1_000_000;

  logEvent("plan_complete", {
    reqId, provider, model, latencyMs,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUSD,
    result, state, steps: stepCount, confidence: parsed.confidence ?? 0, success: true,
  });

  return NextResponse.json({
    schemaVersion:  "1" as const,
    requestId,
    result,
    state,
    plan,
    // Phase 23A: echo at the top level too (undefined when the planner omits it).
    goalCompletionCriteria: parsed.goalCompletionCriteria,
    interpretation: parsed.interpretation,
    blockers:       parsed.blockers ?? [],
    plannerSummary: parsed.plannerSummary,
    confidence:     parsed.confidence ?? 0,
    providerMetadata: {
      provider,
      model,
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
  return preflight(CORS_HEADERS, "POST, OPTIONS");
}

export async function POST(req: NextRequest) {
  const reqId = newRequestId();
  const t0    = Date.now();

  const chain     = selectPlannerChain();
  const provider  = chain[0]?.provider ?? "none";
  const sessionId = req.headers.get("x-session-id") ?? "anon";

  logEvent("plan_request", {
    reqId, session: sessionId.slice(-8), provider,
    openRouterPresent: !!process.env.OPENROUTER_API_KEY, geminiPresent: !!process.env.GEMINI_API_KEY,
  });

  if (chain.length === 0) {
    return errorResponse(reqId, "Service not configured — no API key available.", "SERVICE_UNAVAILABLE", 500, t0, "none", "none");
  }

  const block = rateLimiter.check(sessionId);
  if (block === "session" || block === "global") {
    logWarn("plan_rate_limited", { reqId, scope: block });
    return errorResponse(reqId, "Too many requests — please wait a moment.", "RATE_LIMITED", 429, t0, provider, chain[0].model);
  }

  let body: Partial<PlanRequest> | null;
  try {
    body = await req.json();
  } catch {
    return errorResponse(reqId, "Invalid JSON body.", "INVALID_REQUEST", 400, t0, provider, chain[0].model);
  }

  const invalid = validatePlanRequest(body as PlanRequest | null);
  if (invalid) {
    return errorResponse(reqId, invalid.error, invalid.status === 413 ? "SCREENSHOT_TOO_LARGE" : "INVALID_REQUEST", invalid.status, t0, provider, chain[0].model);
  }

  // Server-side PII backstop — a SECOND, independent layer behind the
  // extension's own client-side sanitizer (Phase 1). Redacts and logs; never
  // rejects. The screenshot is passed through untouched (masked client-side).
  const safeBody = applyPiiBackstop(body as PlanRequest, reqId, "plan");

  const {
    goal, page, previousPage, executionHistory, workflowMemory,
    recoveryContext, preferences, applicationMetadata, requestId, clarifications,
    pageControls,
  } = safeBody;

  // Server-side budget — second line of defense after the client-side session budget
  const attemptCount = executionHistory?.attemptCount ?? 0;
  if (attemptCount > MAX_SERVER_SIDE_CALLS) {
    logWarn("plan_budget_exceeded", { reqId, attemptCount });
    return errorResponse(reqId, "Planner budget exceeded for this workflow.", "BUDGET_EXCEEDED", 429, t0, provider, chain[0].model);
  }

  let prompt: string;
  try {
    prompt = buildPlannerPrompt({
      goal, page, previousPage, executionHistory,
      workflowMemory, recoveryContext, preferences, applicationMetadata, clarifications,
      pageControls,
    });
  } catch (err) {
    logError("plan_prompt_build_error", { reqId, message: (err as Error)?.message });
    return errorResponse(reqId, "Invalid request data.", "INVALID_REQUEST", 400, t0, provider, chain[0].model);
  }

  logEvent("plan_dispatch", { reqId, provider, promptLen: prompt.length, imageLen: page.screenshot.image.length, attemptCount });

  const gController  = new AbortController();
  const gBudgetTimer = setTimeout(() => gController.abort(), TOTAL_BUDGET_MS);

  try {
    const chainResult = await runPlannerChain(chain, {
      prompt,
      screenshot: page.screenshot,
      outerSignal: gController.signal,
      perAttemptMs: PER_ATTEMPT_MS,
      onAttempt: (evt) => logEvent("plan_attempt", { reqId, ...evt }),
    });

    if (chainResult.ok) {
      return assemblePlanResponse(reqId, t0, requestId, goal, chainResult.selection.provider, chainResult.selection.model, chainResult.data);
    }

    const failedProvider = chainResult.selection?.provider ?? provider;
    const failedModel    = chainResult.selection?.model ?? chain[0].model;

    if (gController.signal.aborted && chainResult.message === "timeout") {
      return errorResponse(reqId, "Analysis timed out.", "TIMEOUT", 504, t0, failedProvider, failedModel);
    }

    logEvent("plan_failed", { reqId, provider: failedProvider, model: failedModel, latencyMs: Date.now() - t0, upstreamStatus: chainResult.status, success: false });

    // Reproduces the exact pre-refactor per-provider status mapping:
    //   OpenRouter — any failure -> 502 UPSTREAM_ERROR.
    //   Gemini     — 429 -> 429 QUOTA_EXCEEDED (never retried, handled inside
    //                the chain); a fatal 400/401/403 -> 502 UPSTREAM_ERROR;
    //                anything else (timeout/5xx, already retried once inside
    //                the chain) -> 504 TIMEOUT.
    if (failedProvider === "gemini") {
      if (chainResult.status === 429) {
        return errorResponse(reqId, chainResult.message, "QUOTA_EXCEEDED", 429, t0, failedProvider, failedModel,
          { provider: failedProvider, upstreamStatus: chainResult.status, message: chainResult.message });
      }
      if ([400, 401, 403].includes(chainResult.status)) {
        return errorResponse(reqId, chainResult.message, "UPSTREAM_ERROR", 502, t0, failedProvider, failedModel,
          { provider: failedProvider, upstreamStatus: chainResult.status, message: chainResult.message });
      }
      return errorResponse(reqId, "Analysis timed out — please try again.", "TIMEOUT", 504, t0, failedProvider, failedModel);
    }
    return errorResponse(reqId, chainResult.message, "UPSTREAM_ERROR", 502, t0, failedProvider, failedModel,
      { provider: failedProvider, upstreamStatus: chainResult.status, message: chainResult.message });
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
  provider:  string,
  model:     string,
  extra?:    Record<string, unknown>,
) {
  const latencyMs = Date.now() - t0;
  logError("plan_error", { reqId, errorCode, latencyMs });
  return NextResponse.json(
    {
      schemaVersion: "1",
      result:        "FAILED",
      blockers:      [],
      confidence:    0,
      providerMetadata: { provider, model, plannerVersion: PLANNER_VERSION, latencyMs },
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
    lines.push(`Replan notice: ${req.executionHistory.completedSteps.length} step(s) already completed. Emit ONLY remaining required steps from current screen state. Keep plannerSummary to 1 short sentence.`);
  }

  if (req.workflowMemory?.extractedData && Object.keys(req.workflowMemory.extractedData).length) {
    const extractedData = JSON.stringify(req.workflowMemory.extractedData);
    lines.push(`Extracted data: ${extractedData.length > 500 ? `${extractedData.slice(0, 497)}...` : extractedData}`);
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
  if (req.preferences?.language) {
    lines.push(`Preferred language: ${req.preferences.language}`);
  }
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
  },
  "goalCompletionCriteria": {
    "goalType": "action",
    "match": "all",
    "verificationStrategy": "local_signals",
    "requiresEffect": true,
    "successSignals": [
      { "type": "url_matches", "urlPattern": "/test" },
      { "type": "element_present", "text": "test" }
    ]
  }
}

Rules:
- Return JSON only. No markdown.
- Produce ALL steps — never just the next one.
- The FINAL step of a successful plan MUST set "completionCondition": "final". Every earlier step keeps its mechanism value (url_change | dom_change | input_filled | element_disappears). The "final" marker lets the client detect goal completion the instant the last step succeeds — without an extra planner round-trip. Never mark more than one step "final", and never mark a non-final step "final".
- Prefer the SHORTEST PATH. If a global navigation control on the current page can achieve the goal (header "+" menu, sidebar Create button, toolbar action), use it directly. Do NOT add steps to navigate to a dashboard or home page first.
  Examples of always-available global controls: GitHub "+" (new repo/issue/PR from any page), Gmail "Compose" (always in left sidebar), LinkedIn message icon (always in top nav), YouTube "Create" (always in top nav).
- If the goal is already achieved: state="complete", plan.steps=[]. "Already achieved" means the goal's OUTCOME is visible on the current screen right now (the repository already exists, the SSH key is already listed, the message was sent). Arriving on a settings page, a list page, a creation page, or an empty form is NOT completion — do NOT return state="complete" and do NOT mark any step "final" merely because you navigated to the correct page.
- Before emitting a fill_form step, check whether the target field's CURRENT value, as visible in the screenshot, already matches the value you intend to enter. If the value is already correct, do NOT emit that fill_form step again. Proceed directly to the next incomplete step.
- For "create"/"add"/"new"/"compose"/"upload" goals, the plan MUST carry through to the terminal action, not just navigate to the surface that hosts it. After reaching the creation surface, include: (a) the step that opens/clicks the create control (e.g. "New SSH key", "New repository", "Compose"), then (b) fill_form steps for every required input the goal specifies, then (c) the final submit step (e.g. "Add SSH key", "Create repository", "Send"). Only that final submit step is marked "final".
  Example — goal "create a repository called test" from the dashboard: [open the create "+" menu] → ["New repository"] → [fill the "Repository name" field with "test" (phase:fill_form, completionCondition:input_filled)] → ["Create repository" (phase:submit, completionCondition:final)].
  Example — goal "add an SSH key" from anywhere: [avatar/profile menu] → ["Settings"] → ["SSH and GPG keys"] → ["New SSH key"] → [fill the key fields] → ["Add SSH key" (completionCondition:final)]. Never stop at "SSH and GPG keys".
- goalCompletionCriteria (OPTIONAL, top-level field alongside "plan", for "action" goals — create/add/new/change/send/upload): emit a plan-level contract describing the goal's OBSERVABLE OUTCOME on the page that exists AFTER the terminal action. Shape: { "goalType":"action", "match":"all", "verificationStrategy":"local_signals", "requiresEffect":true, "successSignals":[ … ] }. Each successSignal is exactly one of:
  - { "type":"url_matches",     "urlPattern":"<substring the post-action URL contains>" }
  - { "type":"url_leaves",      "urlPattern":"<substring the URL should no longer contain>" }
  - { "type":"text_present",    "text":"<visible text that appears on success>" }
  - { "type":"element_present", "text":"<accessible label/text present on success>" }
  - { "type":"element_absent",  "text":"<accessible label that disappears on success>" }
  Signals MUST be checkable AFTER the final action, never on the pre-action page. Prefer two signals: a URL transition AND a mutation signal (text/element). Omit goalCompletionCriteria entirely for pure navigation goals, or when you cannot state a reliable post-action signal.
  Example "add a new ssh key": { "goalType":"action","match":"all","verificationStrategy":"local_signals","requiresEffect":true,"successSignals":[ {"type":"url_matches","urlPattern":"/settings/keys"}, {"type":"text_present","text":"SSH keys"} ] }
  Example "create repository named test": { "goalType":"action","match":"all","verificationStrategy":"local_signals","requiresEffect":true,"successSignals":[ {"type":"url_matches","urlPattern":"/test"}, {"type":"element_present","text":"test"} ] }
- To fill a text field, set phase:"fill_form", completionCondition:"input_filled", type:"input", and put the exact value to enter in targetElement.intent (e.g. "enter 'test'").
- If blocked (not logged in, permission denied): result="OK", state="blocked", list blockers[], plan omitted.
- If multiple valid paths exist and user must choose: result="NEEDS_USER", state="ambiguous".
- If a destructive action requires explicit user confirmation: result="NEEDS_USER", state="planned".
- plannerSummary: 1–2 sentences on why this route was chosen (not a step list).
- Match element text EXACTLY as visible in the screenshot.
- targetElement.text must NEVER be null or empty. When the Interactive controls list above is present: find the element in the list and copy its quoted string EXACTLY as targetElement.text — character-for-character, no paraphrasing. For icon-only entries (marked as such), the quoted string is the element's aria-label or img alt text — the only machine-readable DOM identifier for that button; generating a visual description instead will cause element:not_found. When the list is absent or the element is not listed: for icon-only or image elements use a short descriptive phrase.
- alternatives[]: 2–3 fallback texts for the same element, ordered by likelihood.
- If userClarifications are provided, they represent explicit preferences recorded during this session. Use them to resolve ambiguous paths. Do NOT return state="ambiguous" when a clarification directly addresses the choice — instead set state="planned" and mention the applied clarification in plannerSummary.`;
}
