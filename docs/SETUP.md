# Setup and reproducibility

Everything marked **verified** was run on the development machine (Linux, Node v22.18.0, npm 10.9.3) while preparing this document. Everything else is stated from the code/config and has **not** been tried on a clean machine.

## Requirements

| Need | Version / detail | Status |
|---|---|---|
| Node.js | v22.18.0 used. No `engines` field exists in `package.json`; Next.js 15 needs Node ≥ 18.18 | verified on 22 only |
| npm | 10.9.3 | verified |
| Chrome / Chromium | Any recent version with MV3 and "Load unpacked" | not exercised in this pass |
| Ollama | Only for local inference. Default URL `http://127.0.0.1:11434` | installed here |
| Ollama models | `qwen2.5-coder:7b` (text), `moondream` (vision) | `qwen2.5-coder:7b` present here; **`moondream` is not pulled on this machine** |
| Provider key | At least one of `OPENROUTER_API_KEY` / `GEMINI_API_KEY`, backend-side | needed for cloud mode |

## Ports

| Port | Used by |
|---|---|
| 3000 | Next.js backend (`npm run dev` / `npm start`); verified `/api/health` responds (tested on an alternate port with `next dev -p`) |
| 11434 | Ollama (local mode). The extension reaches it through the background service worker (`OLLAMA_GENERATE` / `OLLAMA_CHECK` messages), because content scripts on HTTPS pages can't fetch it directly |

## Steps

```bash
git clone <repo> && cd screen-pilot
npm ci                              # verified indirectly: node_modules present and all suites run
cp .env.example .env.local          # then fill in a key — never commit .env.local (it is gitignored)
npm run build:ext                   # verified; writes extension/dist/*.bundle.js
npm run dev                         # verified; GET /api/health -> {"status":"ok",...}
```

`/api/health` reports which provider keys are present (booleans only) and the active models.

### Environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Primary planner provider if set |
| `GEMINI_API_KEY` | Vision (`/api/analyze`) always; planner if OpenRouter isn't set |
| `PLANNER_MODEL_OPENROUTER` | Override. Default `google/gemini-2.5-flash`. Must accept image input |
| `PLANNER_MODEL_GEMINI`, `VISION_MODEL_GEMINI` | Overrides; default `gemini-2.5-flash` |
| `FALLBACK_PROVIDER`, `FALLBACK_MODEL` | Optional secondary provider once the primary chain is exhausted |
| `RATE_LIMIT_SESSION_PER_MIN`, `RATE_LIMIT_GLOBAL_PER_MIN` | Defaults 100 / 12 per 60 s window |

### Load the extension

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose the `extension/` directory.
2. Open any page, open the ScreenPilot popup, enter a goal.
3. Optional: tick **Local AI** to use Ollama (`ollama pull qwen2.5-coder:7b`, `ollama pull moondream`).

### Backend URL

One source of truth: `extension/lib/backend-config.js`. The planner (`v2-task.js` → `VercelBackendAdapter`), the playground and the legacy vision path all resolve the URL through it.

1. `chrome.storage.local.screenPilotBackendUrl` — set in the popup: **Settings → Backend URL → Save**. No rebuild needed.
2. Otherwise the production default (`DEFAULT_BACKEND_URL`).

Accepted: `https://…` anywhere; `http://` for `localhost`, `127.0.0.1`, `[::1]` only. Rejected with an inline message: malformed URLs, other schemes, embedded credentials, query strings/fragments, plain http to non-loopback hosts. A legacy stored `…/api/analyze` value is reduced to its base. An invalid value already in storage is ignored (console warning) and the default is used.

Local development: run `npm run dev`, then save `http://localhost:3000` in the popup. Only a URL is stored; provider keys stay in the backend's environment.

Planner requests are made by the extension's **service worker** (`services/backend-proxy.js`), not by the web page. Chrome blocks a page-origin request from an https site to a loopback address ("Permission was denied … `loopback` address space", observed in testing); the service worker is not subject to that. The content script only sends a `BACKEND_REQUEST` message naming a fixed API path; the service worker resolves the destination from the setting above itself, re-validates it, forwards only `Content-Type` and `X-Session-ID`, and sends no cookies. Messages from other extensions are rejected.

Verified in a real Chromium session (headless, automated): URL saved through the popup, persisted across a browser restart, and a request from an https page (Wikipedia) reached a local backend. Not verified: headed Chrome on other platforms; the legacy vision path (`vision-service.js`) still has its own fetch, which runs in the service worker.

## Commands

| Command | Purpose |
|---|---|
| `npm run build:ext` | Bundle `extension/v2-task.js` and `playground/playground.js` into `extension/dist/` |
| `npm run test:ext` / `test:server` / `test:eval` | Test suites |
| `npm run lint` | ESLint over `src/` |
| `npx tsc --noEmit` | Type check |
| `npm run build` | Production backend build |
| `npm run eval:*` | Evaluation harness (Windows-oriented; needs Ollama models) |

`extension/dist/` is **generated and committed on purpose** (the extension loads unpacked straight from the repo). Rebuild and commit it after changing bundled sources.

## Verified state

Run on the committed `infra/gateway-privacy` tree (Linux, Node v22.18.0), including from a clean export of the tree with `npm ci` (369 packages) and no existing `node_modules`:

| Check | Result |
|---|---|
| `npm run test:ext` | **857 / 857 pass**, 0 skipped |
| `npm run test:server` | **112 / 112 pass**, 0 skipped |
| `npm run test:eval` | **19 / 19 pass** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean; covers `src/` only, with all 21 `@next/next` rules, react-hooks and typescript-eslint recommended. Not covered: eslint-plugin-react, jsx-a11y and import rules (the legacy `eslint-config-next` preset had them) |
| `npm run build:ext` | succeeds; bundles contain no `SP:DIAG` and no key-shaped strings |
| `npm run build` | succeeds; no "Next.js plugin not detected" warning |

Notes on earlier failures:
- Server: tests expected the old OpenRouter defaults. The source intentionally changed them (default model `google/gemini-2.5-flash`, `max_tokens` 2048, OpenRouter 429 → HTTP 429 `QUOTA_EXCEEDED`); the tests now assert the new behaviour with the same strength.
- Eval: a visual case referenced `node_modules/privacy-demo.html`, a file that was never committed and is gone. A replacement fixture (`eval/fixtures/icon-buttons-page.html`) was written; see `eval/README.md` for the effect on recorded results.
- Lint: `FlatCompat` + `eslint-config-next` crashed under ESLint 9.39. `eslint.config.mjs` now builds the flat config directly from `@next/eslint-plugin-next`, `eslint-plugin-react-hooks` and `@typescript-eslint/*`, which are declared as direct devDependencies at the versions that were already installed.

### Checked in a real browser (automated, headless Chromium with the extension loaded; user actions scripted)

- Popup saves, rejects and persists the backend URL across a browser restart.
- A planner request from an https page (Wikipedia) reached a local backend through the service worker; with no override it went to the production backend and returned a plan.
- A simple search task on Wikipedia: highlight, detected user input, replan, verified completion.
- One run on a synthetic repository-list page with local Qwen highlighted the named row's control rather than a duplicate's.
- A password and an email in a goal did not appear in page logs, outbound payloads or `chrome.storage` (the email became a placeholder, the password was redacted).

These are single runs against simple pages, not a reliability claim.

### Not verified

- The GitHub "make the UpNext repo private" workflow and other logged-in real-site flows.
- A compound goal with several requirements in a live browser (covered by unit tests only).
- Moondream-based flows (model not installed on the dev machine).
- A manually driven (headed) Chrome session, including the popup UI by hand.
- A fresh `git clone` from GitHub, and `npm run eval:*` (needs Ollama models; Windows-oriented).
- Windows/macOS, Firefox, Safari.
- That the historical Gemini key has been revoked (see [SECURITY.md](SECURITY.md)).
