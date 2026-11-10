# Security notes

## Secrets and repository history

| Item | State |
|---|---|
| Current tree, untracked files, all local and remote branch tips | Scanned for Gemini/OpenRouter/Anthropic/GitHub key patterns: **none found**. `extension/dist` bundles also clean |
| `.env`, `.env.local`, `.env.*.local` | Gitignored. `.env.example` holds placeholders only |
| **Historical exposure** | A Gemini-style API key (`AIza…`) appears in git history: commit `9a56de1` (2026-06-21, `background.js`). `.env.local` was committed in `93f08ba` and `7324d9e`; `93f08ba` contains a `GEMINI_API_KEY=AIza…` line. These commits are on the public `origin` |
| Revocation | The owner is verifying deletion/revocation in Google AI Studio / Cloud Console. **Not verified by this repo's tooling** — no request was made with the old key |
| History rewrite | Deliberately not done. Treat any key in history as compromised; its safety rests entirely on it having been revoked |

## Design

- Provider keys exist only in backend environment variables. The extension holds none (BYOK removed in `0feef8d`).
- The backend sets `Access-Control-Allow-Origin: *` and is protected by per-session and global rate limits, so a public deployment spends its owner's provider quota on anyone's requests. Treat a public instance accordingly.
- Outbound text is sanitised by `SanitizingAdapter` (fails closed). Screenshots are masked from DOM bounding boxes of sensitive fields.
- `sensitive-policy.js` is a fixed table; `autonomousFill` is `false` for every type and tested.
- Planner requests are made by the service worker (`services/backend-proxy.js`). It ignores any destination in the message, accepts only fixed API paths, forwards only `Content-Type` and `X-Session-ID`, omits credentials, and refuses senders other than this extension.
- Credentials typed into a goal: `redactSecrets()` (`lib/sensitive-policy.js`) irreversibly redacts passwords, tokens, keys and other REDACT-policy values when a task starts (`_startNewTask`) and for V1 messages in `background.js`, before logging, `chrome.storage` or any request; `SanitizingAdapter` still redacts again on the way out. Email/phone keep reversible placeholders. Detection is phrase-based (see README limitations).
- Backend URL setting: stores a URL only; validated (https, or http for loopback only; no credentials, query or fragment). No provider credential is ever read, stored or sent by the extension (a test asserts the adapter sends none). The popup also purges any key a pre-BYOK-removal version stored.
- Logging: PII-bearing events log types and counts, not values. Diagnostic logs that exposed raw model output, candidate lists, element text and typed field values were removed in this pass; the `[SP:FILL]` completion log now records value length only.

- Log hygiene is enforced by `extension/tests/logging-hygiene.test.mjs` (no `SP:DIAG`, no raw model output, fill log records length only, no key patterns in source or bundles). Legacy V1 logs in `content.js`/`background.js` now record lengths instead of goal/instruction text.

## Remaining concerns

- Some console logs still include the page URL (query strings can carry personal data) and `[SP:V2]` planner summaries (now passed through `redactText`).
- `host_permissions: <all_urls>` is broad by necessity for a generic guide, but is a large trust surface.
- Local Ollama traffic is plain HTTP on loopback.
