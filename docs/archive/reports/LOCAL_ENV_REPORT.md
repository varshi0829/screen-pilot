# Local Environment Note

**Date:** 2026-08-21

---

This file is retained as a historical environment note. The current workspace did not re-run the Gemini/OpenRouter credential check from June, so the exact API-key conflict described here is not revalidated in this session.

## Current Verified State

- `npm run build` passes locally.
- `npm run build:ext` passes locally.
- The local unit suite passes.
- The extension code now falls back to `chrome.storage.session` in tests when `chrome.storage.local` is absent.

## Remaining External Dependency

- Live Gemini/OpenRouter verification still depends on a valid API key and quota in the active environment.

## Notes

- The extension backend URL remains hardcoded in `extension/services/vision-service.js`.
- If you need local API verification, set the backend to the local Next.js dev server and provide a valid Gemini key in `.env.local`.
