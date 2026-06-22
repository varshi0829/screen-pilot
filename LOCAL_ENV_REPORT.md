# LOCAL_ENV_REPORT.md

**Date:** 2026-06-22

---

## Environment Status

| Item | Value |
|------|-------|
| `.env.local` key | `AQ.Ab8RN6...8Buw` |
| Shell env var | `AIzaSyDA...8Buw` (OLD - overrides .env.local) |
| Server port | 3001 (3000 was in use) |
| Status | 403 PERMISSION_DENIED |

## Key Fingerprint

- Local: `AQ.Ab8RN...8Buw` (new key from .env.local)
- Issue: Shell env var `GEMINI_API_KEY` overrides `.env.local`

## Root Cause

The shell environment has `GEMINI_API_KEY=AIzaSyDAQ.Ab8RN6JmgJT67z6V8WBqKMXMcqSu1GnfvH8TcwAbhvCxLN8Buw` which overrides `.env.local`.

When running with `unset GEMINI_API_KEY`, the local server uses the new key but returns 403 (project denied access).

## Test Results

| Endpoint | Status | Response |
|----------|--------|---------|
| localhost:3001 | 403 | PERMISSION_DENIED |

## Conclusion

Local environment has API key conflict. The new key `AQ.Ab8RN6...` is valid but the project has been denied access to Gemini API.

Vercel backend is working correctly (see VERCEL_ENV_REPORT.md).