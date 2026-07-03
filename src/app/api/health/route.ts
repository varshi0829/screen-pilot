import { NextResponse } from "next/server";

// Phase 1: single model. See VISION_MODELS in route.ts.
const VISION_MODELS = ["google/gemini-2.5-flash"] as const;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
};

export async function GET() {
  const openRouterKeyPresent = !!process.env.OPENROUTER_API_KEY;
  const geminiKeyPresent     = !!process.env.GEMINI_API_KEY;
  const activeProvider       = openRouterKeyPresent ? "openrouter" : geminiKeyPresent ? "gemini-direct" : "none";

  return NextResponse.json(
    {
      status:               "ok",
      activeProvider,
      openRouterKeyPresent,
      geminiKeyPresent,
      models:               VISION_MODELS,
      serverSideBudget:     12,
    },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status:  204,
    headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
