import { NextRequest, NextResponse } from "next/server";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;

// In-memory store — resets on cold start, sufficient for hackathon
const sessions = new Map<string, { count: number; resetAt: number }>();

function allowRequest(sessionId: string): boolean {
  const now = Date.now();
  const s = sessions.get(sessionId);
  if (!s || now > s.resetAt) {
    sessions.set(sessionId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (s.count >= RATE_MAX) return false;
  s.count++;
  return true;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-ID",
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "Service not configured." }, 500);
  }

  const sessionId = req.headers.get("x-session-id") ?? "anon";
  if (!allowRequest(sessionId)) {
    return json({ error: "Rate limit: 12 requests/minute per session." }, 429);
  }

  let body: {
    screenshot: { image: string; mimeType?: string };
    goal: string;
    pageContext?: Record<string, string>;
    taskState?: { completedSteps?: string[]; currentInstruction?: string } | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const { screenshot, goal, pageContext = {}, taskState = null } = body;
  if (!goal?.trim()) return json({ error: "goal is required." }, 400);
  if (!screenshot?.image) return json({ error: "screenshot.image is required." }, 400);

  const prompt = buildPrompt(goal, pageContext, taskState);

  try {
    const upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: screenshot.mimeType ?? "image/jpeg",
                  data: screenshot.image,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return json({ error: "Service busy — please retry in a moment." }, 429);
      }
      return json({ error: `Upstream error ${upstream.status}.` }, 502);
    }

    const data = await upstream.json();
    return NextResponse.json(data, { headers: CORS_HEADERS });
  } catch (err: unknown) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return json({ error: "Analysis timed out — please try again." }, 504);
    }
    console.error("[analyze] internal error:", err);
    return json({ error: "Internal server error." }, 500);
  }
}

function json(body: object, status: number) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

function buildPrompt(
  goal: string,
  pageContext: Record<string, string>,
  taskState: { completedSteps?: string[]; currentInstruction?: string } | null
): string {
  const context = [
    `Goal: ${goal}`,
    pageContext.url ? `URL: ${pageContext.url}` : "",
    pageContext.title ? `Page title: ${pageContext.title}` : "",
    taskState?.completedSteps?.length
      ? `Completed: ${taskState.completedSteps.join(" → ")}`
      : "",
    taskState?.currentInstruction
      ? `Last instruction: ${taskState.currentInstruction}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

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
  "screenSummary": "brief description of the visible application and its current state",
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
  "confidence": 0.95
}

Rules:
- Return JSON only. No markdown, no commentary outside the JSON.
- Never reference website names, brand names, or domain-specific terminology.
- Reason from: visual layout, element roles, semantic match to goal, standard UI conventions.
- List up to 5 candidates in descending order of relevance to the goal.
- Match element text EXACTLY as shown in the UI — copy verbatim.
- Never repeat a completed step.
- If the task is already complete: set currentStep to "Task complete", targetElement.text to "", confidence to 1.
- If no clear next action is visible: leave targetElement.text empty, set confidence below 0.4.`;
}
