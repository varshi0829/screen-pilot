// ScreenPilot backend gateway — shared HTTP helpers (CORS, JSON responses, ids).
// Every route keeps its own exact CORS header VALUES (they differ per route,
// e.g. which extra header names are allowed in preflight), so this only removes
// the repeated boilerplate, never the per-route contract.

import { NextResponse } from 'next/server';

export function buildCorsHeaders(allowHeaders: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': allowHeaders
  };
}

export function preflight(corsHeaders: Record<string, string>, allowMethods: string): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': allowMethods } });
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
