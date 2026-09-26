import { NextResponse } from "next/server";
import { buildCorsHeaders, preflight } from "../../../server/http";
import { selectPlannerChain } from "../../../server/model-router";

const CORS_HEADERS = buildCorsHeaders("Content-Type");
const SERVER_SIDE_BUDGET = 12;

export async function GET() {
  const openRouterKeyPresent = !!process.env.OPENROUTER_API_KEY;
  const geminiKeyPresent     = !!process.env.GEMINI_API_KEY;
  const activeProvider       = openRouterKeyPresent ? "openrouter" : geminiKeyPresent ? "gemini-direct" : "none";

  // Phase 2 fix: previously reported a hardcoded, stale model name
  // ("google/gemini-2.5-flash") unrelated to what /api/plan actually uses.
  // Now reflects the REAL currently-configured model chain (still never the key).
  const models = selectPlannerChain().map((s) => s.model);

  return NextResponse.json(
    {
      status:               "ok",
      activeProvider,
      openRouterKeyPresent,
      geminiKeyPresent,
      models,
      serverSideBudget:     SERVER_SIDE_BUDGET,
    },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return preflight(CORS_HEADERS, "GET, OPTIONS");
}
