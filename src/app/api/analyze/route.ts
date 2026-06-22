import { NextRequest, NextResponse } from "next/server";

const MODELS = {
  navigate: "gemini-2.5-flash",
  explain:  "gemini-2.0-flash",
  ask:      "gemini-2.0-flash",
} as const;
type Mode = keyof typeof MODELS;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 100; // DEV: raised from 12 — restore before public launch
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB base64 limit

// In-memory store — resets on cold start, sufficient for current scale
const sessions = new Map<string, { count: number; resetAt: number }>();

function allowRequest(sessionId: string, reqId: string): boolean {
  const now = Date.now();
  const s = sessions.get(sessionId);
  if (!s || now > s.resetAt) {
    sessions.set(sessionId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    console.log(`[analyze] ${reqId} rate=PASS session=${sessionId} count=1/${RATE_MAX}`);
    return true;
  }
  if (s.count >= RATE_MAX) {
    console.warn(`[analyze] ${reqId} rate=BLOCKED session=${sessionId} count=${s.count}/${RATE_MAX}`);
    return false;
  }
  s.count++;
  console.log(`[analyze] ${reqId} rate=PASS session=${sessionId} count=${s.count}/${RATE_MAX}`);
  return true;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-ID",
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS" },
  });
}

export async function POST(req: NextRequest) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(`[analyze] ${reqId} GEMINI_API_KEY not set`);
    return json({ error: "Service not configured." }, 500);
  }
  // Debug: log key fingerprint (first 8 + last 4 chars)
  console.log(`[analyze] ${reqId} key_fingerprint=${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

  const sessionId = req.headers.get("x-session-id") ?? "anon";
  if (!allowRequest(sessionId, reqId)) {
    return json({ error: `Rate limit: ${RATE_MAX} requests/minute per session.` }, 429);
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

  console.log(`[analyze] ${reqId} mode=${mode} model=${MODELS[mode]} session=${sessionId}`);

  try {
    const upstream = await fetch(`${geminiUrl}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      const errBody = await upstream.json().catch(() => null);
      console.error(`[analyze] ${reqId} gemini_status=${upstream.status} body=${JSON.stringify(errBody)}`);
      if (upstream.status === 429) {
        return json({ error: "Service busy — please retry in a moment.", source: "gemini" }, 429);
      }
      return json({ error: `Upstream error ${upstream.status}.` }, 502);
    }

    const data = await upstream.json();
    console.log(`[analyze] ${reqId} gemini_ok mode=${mode}`);
    return NextResponse.json(data, { headers: CORS_HEADERS });
  } catch (err: unknown) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      console.error(`[analyze] ${reqId} gemini_timeout session=${sessionId}`);
      return json({ error: "Analysis timed out — please try again." }, 504);
    }
    console.error(`[analyze] ${reqId} internal_error`, err);
    return json({ error: "Internal server error." }, 500);
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

Analyze this browser screenshot and determine the next action to achieve the goal.

Classify each relevant UI element using ONLY these generic action types (never use website or brand names):
- primary_action    : main call-to-action (Submit, Save, Create, Send, Confirm, Next, Apply, Post)
- secondary_action  : supporting action (Cancel, Back, Reset, Skip, Dismiss, Close)
- navigation_action : moves to another page or section (tab, breadcrumb, sidebar link)
- destructive_action: removes or deletes content (Delete, Remove, Archive, Trash)
- menu_action       : opens a dropdown, popover, or context menu
- content_item      : selectable row, card, list item, or search result
- input_field       : text box, textarea, date picker, file picker, select
- filter_control    : search bar, filter dropdown, sort control, tag filter
- settings_control  : toggle, checkbox, radio button, configuration field

Classify each element's UI region using ONLY these generic region types:
- top_navigation, side_navigation, main_content, toolbar, modal, dropdown, form, footer

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "application": "name of the application or website visible (e.g. GitHub, Gmail, Notion). Use 'Unknown' if unclear.",
  "pageType": "one of: list|detail|form|dashboard|editor|settings|login|search|media|conversation|empty|error|other",
  "screenSummary": "1-2 sentence description of what is currently visible and the application state",
  "visibleActions": ["up to 5 short labels of the most prominent actions a user could take on this screen"],
  "importantElements": [
    { "label": "visible label or name of a notable UI area", "description": "one sentence on its purpose" }
  ],
  "currentRegion": "the most relevant generic region type currently visible",
  "currentStep": "description of the next step toward the goal",
  "candidates": [
    {
      "text": "exact visible text, label, or placeholder of the element",
      "actionType": "one of the 9 action types above",
      "elementType": "button|link|input|menu",
      "region": "one of the 8 region types above",
      "confidence": 0.95,
      "reasoning": "one sentence: why this element is the right next action for the goal"
    }
  ],
  "targetElement": { "text": "text of best candidate", "type": "button|link|input|menu" },
  "instruction": "short user-facing instruction (e.g. Click 'Save Changes')",
  "confidence": 0.95,
  "plan": [
    {
      "id": 1,
      "description": "short action label visible to the user (e.g. 'Click New Issue')",
      "expectedElement": { "text": "exact visible text of the element", "type": "button|link|input|menu", "region": "one of the 8 region types" }
    }
  ]
}

Rules:
- Return JSON only. No markdown, no commentary outside the JSON.
- Reason from: visual layout, element roles, semantic match to goal, standard UI conventions.
- List up to 5 candidates in descending order of relevance to the goal.
- List up to 5 visibleActions and up to 5 importantElements.
- Match element text EXACTLY as shown in the UI — copy verbatim.
- Never repeat a completed step.
- If the task is already complete: set currentStep to "Task complete", targetElement.text to "", confidence to 1.
- If no clear next action is visible: leave targetElement.text empty, set confidence below 0.4.
- For "plan": include 1–6 steps predicting ALL actions needed to complete the goal from the current screen.
  Step 1 must match the current instruction. Include only steps you can predict with reasonable confidence.
  Omit steps that depend on unknown future UI state. Use the same element text format as candidates.`;
}
