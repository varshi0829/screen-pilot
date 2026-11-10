# ScreenPilot V3 — Development Cycle Changes

Branch: `v3-privacy-vision`. This document covers everything changed on this branch relative to `main`, in the order it was actually built: local privacy sanitization, local visual perception (Moondream), end-to-end privacy enforcement across every screenshot path, closing a pageControls privacy gap, and a small set of latency optimizations. It's written for teammates picking up this branch — what changed, why, how it works, how to test it, and what's still open.

---

## 1. Overview

V2 already had a local-first decision cascade (deterministic DOM matching → a small ranking model → cloud). This cycle adds two things on top of that:

1. **A local privacy layer** that redacts sensitive DOM text and screenshot pixels *before* anything is handed to a local model or the cloud.
2. **A local visual-perception tier** (Moondream via Ollama) that sits between the ranking model and the cloud/Qwen fallback, so more goals can be resolved without ever leaving the device or hitting a cloud LLM.

The updated cascade:

```
L1 deterministic DOM match  (DOMMatcher, threshold ≥ 0.85)
  → L2 local UI ranking      (UIGroundingService, threshold ≥ 0.70)
    → L3a Moondream (local visual perception, opt-in local-first mode)
      → L3b local Qwen (text planner, opt-in local-first mode)
        → L3c cloud (Gemini/OpenRouter via the ScreenPilot backend)
```

Every tier that resolves a step wins immediately — no tier below it ever runs (see §4). Privacy sanitization happens *before* any of L3a/L3b/L3c ever sees DOM text or a screenshot, regardless of which tier ends up being used.

---

## 2. Privacy & Security

### Data flow

```
Browser DOM
  → PageStateService.extractPageState()      (reads DOM, builds normalized elements[])
  → PrivacySanitizer.sanitizeElements()       (redacts sensitive text/value → [REDACTED])
  → PrivacySanitizer.getSensitiveRegions()    (bboxes of sensitive elements)
  → sensitiveRegions + devicePixelRatio        (passed alongside the capture request)
  → ScreenshotService.captureVisibleTab()     (masks those regions on the canvas, THEN encodes)
  → redacted screenshot
  → local vision (Moondream) / local Qwen / cloud
```

Text and pixels are sanitized on **two independent tracks** that both have to be clean before anything leaves the page:

- **Text/DOM track**: `extension/lib/privacy-sanitizer.js` (`PrivacySanitizer`) is the single source of truth for "is this field sensitive." `extension/services/page-state-service.js` runs every extracted element through it before returning.
- **Visual track**: `extension/services/screenshot-service.js` masks the bounding boxes PrivacySanitizer identified, directly on the canvas, before JPEG encoding — so an unmasked frame never exists as a captured image.

### PrivacySanitizer (`extension/lib/privacy-sanitizer.js`)

Detection is DOM-signal-based, no ML:

| Signal | Examples |
|---|---|
| Input `type` | `password`, `email`, `tel` |
| `autocomplete` token | `current-password`, `cc-number`, `cc-csc`, `ssn`, `street-address`, `bday`, … |
| Label/placeholder/aria-label keyword | password, passcode, otp, cvv/cvc, card number, ssn/social security, routing/account number, api key, secret key, auth token |
| PII pattern in the field's own text/value | email regex, SSN (`\d{3}-\d{2}-\d{4}`), credit-card-shaped digit runs, phone number |

`isSensitiveElement(el)` returns a boolean; `sanitizeElement(el)` returns a copy with `text`/`value` replaced by `PrivacySanitizer.REDACTED` (`'[REDACTED]'`) **only if sensitive** — non-sensitive fields (including `placeholder`/`ariaLabel`/`region`/`bbox`, which are needed for grounding) pass through untouched. `getSensitiveRegions(elements)` returns just the bounding boxes of the sensitive ones, for the screenshot step.

### Screenshot masking (`extension/services/screenshot-service.js`)

`captureVisibleTab(windowId, sensitiveRegions, devicePixelRatio)` → `compressImage()`:
1. Capture the tab (PNG), decode to a bitmap.
2. Resize to `MAX_WIDTH` (1024px) — this produces a `resizeScale` factor.
3. **`computeRedactionRects(sensitiveRegions, devicePixelRatio × resizeScale, width, height)`** — a pure function that scales each CSS-pixel bbox into the resized canvas's pixel space and clips it to bounds. This is the CSS-coordinate → screenshot-pixel mapping: a bbox from `getBoundingClientRect()` is in CSS pixels; the captured bitmap is in physical pixels (× `devicePixelRatio`) and has since been shrunk (× `resizeScale`) — both factors are required to land on the right rectangle.
4. Fill those rectangles opaque black on the canvas (not blur — simpler and unambiguous).
5. *Then* encode to JPEG/base64.

Both parameters default to "no redaction" (`sensitiveRegions = []`, `devicePixelRatio = 1`), so a caller that forgets to pass them gets the exact old (unredacted) behavior rather than a crash — which is why every call site had to be checked and fixed individually (see below), not just the primitive itself.

### Propagation across every capture path

`sensitiveRegions`/`devicePixelRatio` have to be computed where the DOM is (a content script) and threaded through to where the screenshot is actually taken (the background service worker, which has no DOM access). Four call sites exist; all four now carry this data:

| Path | Where regions are computed | Where they're consumed |
|---|---|---|
| V2 orchestrator (`v2-task.js`) | `PageStateService.extractPageState().sensitiveRegions` | `background.js` → `captureScreenshot()` |
| `ANALYZE_GOAL`/`REANALYZE` (legacy) | `content.js`'s own detection helper (see below) | `background.js` → `runVisionCycle()` |
| `GET_SCREEN_EXPLANATION` | same | `background.js` → `getScreenExplanation()` |
| `ASK_QUESTION` | same | `background.js` → `askQuestion()` |
| Developer playground | `PageStateService.extractPageState()` (playground.js is a real ES module, so it imports the same service v2-task.js uses) | same `background.js` handler as the V2 path |

**Why `content.js` has its own copy instead of importing `PrivacySanitizer`**: `content.js` is loaded as a classic (non-module) content script per `manifest.json` — adding `import`/`export` there would be a parse error at real page load. Its helper (`getSensitiveScreenshotRegions`/`getScreenshotPrivacyContext`) duplicates the same rule categories (input type, autocomplete, label/placeholder/aria-label keywords, PII patterns) across `input, textarea`, but is a separate, smaller implementation — a known, documented divergence, not a bug. `v2-task.js` and `playground.js` are both bundled by esbuild (genuine ES modules), so they import the real `PrivacySanitizer`/`PageStateService` directly — no duplication there.

### Sanitized `pageControls`

`v2-task.js`'s `collectPageControls()` reads visible buttons/links' `innerText`, `aria-label`, `title`, and `img[alt]` directly from the live DOM to give the cloud planner exact, real label strings to ground against. This array is attached to the cloud request (`decision-router.js`'s `cloudContext.pageControls`) **and used to bypass `PrivacySanitizer` entirely** — it was a separate raw-DOM read, independent of `PageStateService.elements`. A page whose static button/link text embeds PII (e.g. an account-switcher button reading "Sign out jane.doe@example.com") could leak it to the cloud.

Fixed: each of the four fields is now checked independently via the real `PrivacySanitizer.isSensitiveElement({ariaLabel: value, text: value})` (passing the same string as both arguments runs *both* of PrivacySanitizer's checks — label-keyword and PII-pattern — in one call, no changes needed to `privacy-sanitizer.js` itself) and replaced with `PrivacySanitizer.REDACTED` only when flagged. Redaction is per-field, not per-control — an ordinary control (`"Search"`) is untouched, and a control with only one sensitive field keeps its other fields/region/tag so it still contributes to grounding.

### What reaches the cloud today

The cloud request (`decision-router.js`'s `cloudRequest`) contains: `goal`, `page.url`/`page.title`, the **redacted** screenshot, and optionally `executionHistory`, `clarifications`, and the now-**sanitized** `pageControls`. It never includes `pageState.elements` at all (that array is only ever used by local Qwen/Moondream's prompts, both fed the sanitized version).

---

## 3. Local Vision / Moondream

### Role: visual perception, not a planner

`extension/providers/local-vision-adapter.js` (`LocalVisionAdapter`) talks to a local Ollama-hosted multimodal model. Its `plan()` method is misleadingly named (to satisfy the shared `BackendAdapter` interface) but returns a **minimal perception result**, not a plan:

```js
{ result: 'OK', elementId: 'el_12'|null, action: 'click'|'type'|..., confidence: 0.91, reason: '...' }
```

It cannot invent selectors, click anything, or produce a multi-step plan — it can only ever name an `elementId` from the candidate list it was given. Turning a validated pick into an executable step is `decision-router.js`'s job, via `_buildPlanFromElement` — **the exact same helper L1/L2 already use** — so there is exactly one place in the codebase that shapes a step from a resolved element, regardless of which tier resolved it.

### Ollama integration

- Endpoint: `http://127.0.0.1:11434/api/generate`, `format: 'json'`, `images: [<sanitized screenshot base64>]`.
- Model: **`moondream`** (default; configurable via constructor `{model}` — e.g. for `qwen2.5vl:3b` as an alternative).
- Requests are proxied through `extension/services/ollama-proxy.js` / `background.js`'s `OLLAMA_GENERATE`/`OLLAMA_CHECK` handlers when running as a real extension (a content-script's direct `fetch()` to a local `http://` endpoint is blocked by Chrome's Private Network Access policy on real `https://` sites), with a direct-`fetch()` fallback for non-extension contexts (unit tests).

### elementId grounding & validation

The prompt explicitly instructs the model: *"elementId MUST be copied exactly from the list above. Never invent, guess, or construct a new id. If none match, return elementId: null."* But the prompt is not trusted on its own — `decision-router.js`'s `_runLayer3` validates the returned `elementId` against the **current** `pageState.elements` list:

```js
const resolvedElement = elements.find((el) => el.id === perception.elementId);
if (!resolvedElement) { /* treated exactly like a failed perception — falls through */ }
```

An invented, stale, or missing id is never trusted or executed — it's handled identically to Moondream being unavailable or throwing.

### Screenshot reuse, not a second capture

Moondream must receive the same already-redacted screenshot the cloud path would use — never a second, independent capture. `_runLayer3` fetches the screenshot lazily via a `getScreenshotOnce()` closure, called at most once per planning cycle, and reused by whichever of Moondream/cloud ends up needing it.

### Fallback behavior

Order (only in local-first mode — see §4): **Moondream → Qwen → cloud**, one attempt per provider, no retries, no bouncing back and forth. Moondream is tried unavailable/failed/unusable-elementId all fall through the same way Qwen's own failure already did.

### Moondream timeout (changed this cycle)

`VISION_GENERATE_TIMEOUT_MS` was originally copied verbatim from Qwen's 15s budget. Qwen's 15s is backed by a real-hardware measurement (qwen2.5-coder:7b, CPU-only: ~11.4s warm, ~22.9s cold — see `local-qwen-adapter.js`'s own comment). Moondream (~1.8B) is a much smaller/faster model than Qwen (7B), so re-using Qwen's budget meant a stuck/slow vision call could block the whole task for up to 15 seconds before Qwen/cloud fallback even started.

**Changed: `15_000` → `8_000` ms.** Not yet benchmarked on real hardware (documented as such in the code) — a deliberately tighter, still-generous budget for a model this size, chosen to degrade to fallback faster rather than stall a live session.

### Candidate reduction: up to 25 → top 10 ranked

`local-vision-adapter.js`'s prompt builder always capped candidates at 25, but in **DOM order**, not relevance order. `decision-router.js` now reuses the ranking L2 already computed a moment earlier (`UIGroundingService.rankElements(goal, elements)` — no extra scoring pass) and passes only the **top 10** (`VISION_CANDIDATE_LIMIT`, exported from `decision-router.js`) ranked elements into Moondream's prompt, falling back to the full list if ranking produced nothing.

Why this helps both latency and correctness:
- **Latency**: a smaller prompt is less for the model to process per inference call.
- **Relevance**: the candidates offered are now the ones L2's own scoring already judged most goal-relevant, instead of whatever happened to appear first in the DOM.

The elementId validation gate still checks against the **full** `elements` array, so this can only narrow what Moondream is *offered* — it can never loosen what a valid response is allowed to reference.

---

## 4. Decision Cascade

```js
// decision-router.js — DecisionRouter.route()
L1 deterministic DOM match        (DOMMatcher-style exact/near-exact text match, score ≥ 0.85)
  → returns immediately if matched
L2 local UI ranking               (UIGroundingService.rankElements, score ≥ 0.70)
  → returns immediately if matched
L3  (only reached if BOTH L1 and L2 miss)
  if executionMode === 'local-qwen':
    a. Moondream (visual perception) — tried FIRST, even if Qwen would succeed
    b. local Qwen (text planner) — tried if Moondream unavailable/failed/unusable
  c. cloud — always the final fallback (also the ONLY tier reached at all when
     executionMode === 'cloud', the default)
```

`executionMode` is the existing local-first toggle (`chrome.storage.local.executionMode`, `'cloud'` default, `'local-qwen'` opt-in via the popup's "Use local AI when available" checkbox). `executionMode === 'cloud'` never contacts Ollama at all — no availability check, no wasted round-trip.

Each tier gets **exactly one attempt** — no tier is ever retried, and no tier is revisited after a later one runs. A tier that resolves a step returns immediately (`layer: 'deterministic'|'ml_grounding'|'local_vision'|'local_qwen'|'cloud'`); this was already true before this cycle and remains true — verified, not something this cycle changed.

---

## 5. Latency Optimizations

Investigation first: existing `[SP:DecisionRouter]`/`[SP:V2:PERF]` logging already timestamps every tier (`layer1Ms`, `layer2Ms`, `qwenMs`, `visionMs`, `cloudMs`, screenshot capture time). Reading those code paths (not a live benchmark — Ollama isn't running in this dev/CI environment) surfaced two concrete, fixable issues and confirmed several things were already fine.

### A. Implemented optimizations

1. **Moondream timeout reduced 15s → 8s** (`local-vision-adapter.js`) — see §3.
2. **Moondream candidate list reduced from up to 25 (DOM order) to top 10 (L2-ranked)** (`decision-router.js`) — see §3. Reuses L2's already-computed ranking instead of a second scoring pass.
3. **Screenshot capture deduplicated to at most once per planning cycle** — this was already implemented in an earlier part of this same development cycle (`getScreenshotOnce()` in `decision-router.js`), confirmed still correct and unchanged.

### B. Investigated, deliberately NOT changed

- **Page-state caching across planning cycles** — not added. `page-state-service.js` is documented as "no caching, so it can never go stale," and this is load-bearing for the stale-plan/dedup guards described in `ARCHITECTURE.md`. Caching DOM state across cycles would risk reintroducing exactly the staleness bugs those guards exist to prevent.
- **L1/L2 confidence thresholds** — not lowered. Both are correctness gates (0.85 / 0.70); lowering them to force more goals through L1/L2 without Moondream would risk incorrect matches. Investigated whether goals like *"Search Wikipedia for artificial intelligence"* should resolve via L1/L2: they legitimately don't, today, because the query payload ("artificial intelligence") isn't expected to appear in the search box's own label, which dilutes L2's token-overlap score below threshold. Fixing that correctly needs goal-segmentation (separating "what to click" from "what to type") — a real feature, not a threshold tweak, and out of scope for this cycle. Making the L3 fallback such goals correctly take (Moondream) faster (via #1/#2 above) was the safe way to reduce their wait instead.
- **Qwen's timeout** — left at 15s; it's backed by an actual hardware measurement with a documented safety margin, and wasn't implicated by the latency investigation.
- **"Don't wait for cloud if local is already valid"** — already true by construction (every tier returns immediately on success); verified, no change was needed.

### C. Metrics

| Metric | Before | After | Status/Notes |
|---|---|---|---|
| Moondream generate timeout | 15,000 ms | 8,000 ms | Code change, confirmed in source and rebuilt bundle. **Not measured** on real hardware — no benchmark exists in this environment (no running Ollama instance here). |
| Moondream candidate count | up to 25, DOM order | up to 10, L2-ranked | Code change, confirmed. **Not measured** for actual inference-time delta. |
| Screenshots captured per planning cycle | 1 (already fixed pre-cycle) | 1 (unchanged) | No regression; confirmed by `decision-router-vision.test.mjs`'s "captured only once" tests. |
| Qwen generate timeout | 15,000 ms | 15,000 ms (unchanged) | Backed by a real measurement (~11.4s warm / ~22.9s cold), not touched. |
| End-to-end task latency (any scenario) | — | — | **Not measured.** No live Ollama/browser benchmark was run as part of this work; do not repeat unverified numbers in the demo. |

---

## 6. Testing & Validation

Numbers below are from actually running the suite in this environment just before writing this document (`node --test extension/tests/*.test.mjs` and targeted subsets), not estimated.

| Suite | Command | Result |
|---|---|---|
| Privacy tests | `node --test extension/tests/privacy-sanitizer.test.mjs extension/tests/screenshot-sanitizer.test.mjs extension/tests/privacy-e2e-integration.test.mjs extension/tests/content-privacy-context.test.mjs extension/tests/playground-privacy-context.test.mjs extension/tests/page-controls-privacy.test.mjs` | **48/48 pass** |
| Decision-router / local-vision tests | `node --test extension/tests/decision-router.test.mjs extension/tests/decision-router-vision.test.mjs extension/tests/local-vision-adapter.test.mjs` | **40/40 pass** |
| Full suite | `node --test extension/tests/*.test.mjs` | **329 tests, 324 pass, 5 fail** |
| `real-browser.test.mjs` | (included above) | **Pass**, when `playwright`/`node_modules` are installed (they are in this environment) |
| Extension build | `npm run build:ext` | **Succeeds** — `extension/dist/v2-task.bundle.js` (180.5kb), `extension/dist/playground.bundle.js` (94.6kb) |

**The 5 known failures are all in `extension/tests/runtime-validation.test.mjs`** ("Ambiguous Qwen" scenarios) — they assert the router resolves to `local_qwen`, but get `cloud` instead, because **no local Ollama server is running in this test environment**. This is a pre-existing, environment-only gap (confirmed unrelated to any change in this cycle by diffing against the state before each change) — it will resolve itself on a machine with Ollama actually running.

---

## 7. Files Changed

| File | Purpose of change |
|---|---|
| `extension/lib/privacy-sanitizer.js` | **New.** Core sensitive-field detection (input type, autocomplete, label keywords, PII patterns) and redaction (`isSensitiveElement`, `sanitizeElement`, `sanitizeElements`, `getSensitiveRegions`). |
| `extension/services/page-state-service.js` | Captures `type`/`autocomplete` on extracted elements; runs every element through `PrivacySanitizer` before returning; exposes `sensitiveRegions` on the page state. |
| `extension/services/screenshot-service.js` | `captureVisibleTab`/`compressImage` accept `sensitiveRegions`/`devicePixelRatio` and mask those regions (opaque black) on the canvas before encoding; added the pure `computeRedactionRects` scaling/clipping helper. |
| `extension/background.js` | All four screenshot-triggering handlers (`captureScreenshot`, `analyzeGoal`→`runVisionCycle`, `getScreenExplanation`, `askQuestion`) now forward `sensitiveRegions`/`devicePixelRatio` into `ScreenshotService.captureVisibleTab`. |
| `extension/content.js` | Added a self-contained (classic-script-safe) privacy helper covering the same detection categories as `PrivacySanitizer`, across `input`/`textarea`; wired into the three legacy message-sending call sites. |
| `extension/playground/playground.js` | Imports `PageStateService`; computes `sensitiveRegions`/`devicePixelRatio` before its `CAPTURE_SCREENSHOT` request. |
| `extension/providers/local-vision-adapter.js` | **New.** `LocalVisionAdapter` — Moondream visual-perception client (see §3). Timeout reduced 15s → 8s this cycle. |
| `extension/services/decision-router.js` | Added the Moondream tier (before Qwen), elementId validation gate, screenshot reuse across tiers, and (this cycle) candidate-list ranking/reduction for Moondream (`VISION_CANDIDATE_LIMIT = 10`). |
| `extension/v2-task.js` | `collectPageControls()` now sanitizes each field (`text`/`ariaLabel`/`title`/`imgAlt`) via `PrivacySanitizer` before the array can reach the cloud request. |
| `extension/dist/v2-task.bundle.js`, `extension/dist/playground.bundle.js` | Regenerated via `npm run build:ext` to reflect all of the above (never hand-edited). |
| `extension/tests/privacy-sanitizer.test.mjs` | **New.** `PrivacySanitizer` unit + `PageStateService` integration tests. |
| `extension/tests/screenshot-sanitizer.test.mjs` | **New.** `computeRedactionRects` geometry tests + API back-compat check. |
| `extension/tests/privacy-e2e-integration.test.mjs` | **New.** Proves the three legacy background.js handlers forward privacy context into screenshot capture. |
| `extension/tests/content-privacy-context.test.mjs` | **New.** Extracts and runs content.js's real privacy helper in a sandbox; static checks that all three message sites use it. |
| `extension/tests/playground-privacy-context.test.mjs` | **New.** Structural checks that playground.js computes and sends privacy context. |
| `extension/tests/page-controls-privacy.test.mjs` | **New.** Extracts and runs the real `collectPageControls`/`sanitizeControlField` source; proves an email embedded in a control label is redacted and an ordinary label ("Search") is untouched. |
| `extension/tests/decision-router-vision.test.mjs` | **New.** Moondream-before-Qwen ordering, elementId validation/rejection, screenshot reuse/no-bypass, fallback behavior. |
| `extension/tests/local-vision-adapter.test.mjs` | **New.** `LocalVisionAdapter` request shape, perception-result shape, failure handling, availability check. |

---

## 8. Runtime Setup

- **Ollama**: required only for the local-first tiers (Moondream + Qwen). Install from [ollama.com](https://ollama.com/), running at the default local endpoint `http://127.0.0.1:11434`.
- **Models**:
  - `ollama pull moondream` — local visual perception (Moondream tier).
  - `ollama pull qwen2.5-coder:7b` — local text planner (Qwen tier).
- **Verify Ollama is reachable**:
  ```bash
  curl http://127.0.0.1:11434/api/tags
  ```
  should return JSON listing your pulled models.
- **No environment variables are required** for local mode — the Ollama URL/model names are hardcoded defaults in `local-vision-adapter.js`/`local-qwen-adapter.js` (both accept constructor overrides if you need a different host/model, e.g. for testing `qwen2.5vl:3b`).
- **Enable local-first mode**: open the extension popup → "AI Processing — Use local AI when available" checkbox (sets `chrome.storage.local.executionMode = 'local-qwen'`). Leaving it off uses cloud only (`executionMode` defaults to `'cloud'`, which never contacts Ollama).
- **Build the extension**:
  ```bash
  npm install        # only if node_modules isn't already present
  npm run build:ext  # rebuilds extension/dist/v2-task.bundle.js and playground.bundle.js
  ```
- **Load/reload in Chrome**:
  1. `chrome://extensions` → enable **Developer mode**.
  2. **Load unpacked** → select the `extension/` directory (first time), or click the reload icon on the existing ScreenPilot card after rebuilding.

---

## 9. How to Test Manually

1. **Normal DOM-grounded task** (should resolve via L1/L2, no Moondream/Qwen/cloud call): on a simple page with an unambiguous, exactly-labeled button (e.g. a page with a "Submit" button), type a goal like `"click submit"`. Check the console for `[SP:DecisionRouter] Layer 1 FAST PATH matched` or `Layer 2 ML GROUNDING matched` — no `Layer 3` log lines should appear.

2. **Visual/ambiguous task** (should escalate to Moondream, local-first mode on): on a page with a less exactly-labeled search box (e.g. a real Wikipedia search box), type `"Search Wikipedia for artificial intelligence"`. With local-first mode enabled, expect `[SP:DecisionRouter] Layer 3 LOCAL VISION succeeded` (or a fallback log if Moondream/Ollama isn't available).

3. **Privacy test with fake sensitive info**: on any page with a login form, type a fake password/email into the fields, then trigger any goal. Take a screenshot of the extension's own captured image (or check the request the local model logs) — the password/email field region should appear as an opaque black rectangle, and any DOM text logged for that field should read `[REDACTED]`, never the fake value you typed.

4. **Multi-step task** (e.g. a GitHub-style flow): try something like `"open the first repository in the list"` followed by a natural next-step goal once there. Watch that each cycle re-extracts page state (no stale element ids reused across a navigation) and that `completedSteps` in the console log grows correctly without repeating the same action.

5. **Inspect performance logs**: open the extension's background service worker console (`chrome://extensions` → ScreenPilot → "service worker" link) and the page's own DevTools console (content-script logs). Look for lines prefixed `[SP:V2:PERF]` and `[SP:DecisionRouter]` — they report `layer1Ms`, `layer2Ms`, `qwenMs`, `visionMs`, `cloudMs`, and `screenshotMs` for every planning cycle.

---

## 10. Known Limitations / Future Improvements

- **Real-browser screenshot redaction is not fully covered by Node unit tests.** `computeRedactionRects`'s CSS-pixel → screenshot-pixel scaling math is unit-tested in isolation (multiple `devicePixelRatio`/resize-scale scenarios, edge clipping), but Node has no `OffscreenCanvas`/`createImageBitmap`, so it has never been exercised against a real captured image in an actual Chromium tab. `real-browser.test.mjs` (Playwright) covers other real-DOM behaviors but not this specific pixel-masking path.
- **Moondream/local Ollama dependency**: the entire local-first vision/Qwen tier is inert without a running Ollama instance with the right models pulled — falls back to cloud automatically, but the "no cloud calls" privacy/cost benefit only holds when Ollama is actually running.
- **5 pre-existing `runtime-validation.test.mjs` failures remain** ("Ambiguous Qwen" scenarios expecting `local_qwen` but getting `cloud`) — these require a live local Ollama server to pass and are not fixable by code changes alone; not caused by this cycle's changes.
- **`content.js`'s privacy detection is narrower than `PrivacySanitizer`** by necessity (classic script, can't import the real module) — it doesn't cover `contenteditable` regions or shadow-DOM traversal the way `PageStateService`'s DOM query implicitly might in some cases. Documented, not a regression.
- **"Search X for Y"-style goals** (site name + query payload in one sentence) are not reliably resolved by L1/L2 today, by design of the current token-overlap scoring — they correctly fall through to Moondream/Qwen/cloud rather than being (incorrectly) forced through L1/L2. A real fix would need goal-segmentation (separating "what to click" from "what to type"), which is out of scope for this cycle.
- **No real-hardware latency benchmark exists** for the Moondream timeout/candidate-count changes in this cycle — the reasoning is sound (smaller model, smaller prompt) but unverified numerically; re-measure once Ollama + Moondream are actually running on demo hardware.

---

## 11. Quick Reference

**Architecture flow**
```
L1 deterministic DOM (≥0.85) → L2 local UI ranking (≥0.70)
  → L3a Moondream (visual perception, local-first mode only)
    → L3b local Qwen (text, local-first mode only)
      → L3c cloud (always the final fallback)
```

**Test commands**
```bash
# Privacy tests
node --test extension/tests/privacy-sanitizer.test.mjs extension/tests/screenshot-sanitizer.test.mjs \
  extension/tests/privacy-e2e-integration.test.mjs extension/tests/content-privacy-context.test.mjs \
  extension/tests/playground-privacy-context.test.mjs extension/tests/page-controls-privacy.test.mjs

# Decision-router / local-vision tests
node --test extension/tests/decision-router.test.mjs extension/tests/decision-router-vision.test.mjs \
  extension/tests/local-vision-adapter.test.mjs

# Full suite
node --test extension/tests/*.test.mjs
```

**Build command**
```bash
npm run build:ext
```

**Important files**
- `extension/lib/privacy-sanitizer.js` — sensitive-field detection/redaction
- `extension/services/page-state-service.js` / `screenshot-service.js` — text/pixel sanitization
- `extension/services/decision-router.js` — the cascade + Moondream tier
- `extension/providers/local-vision-adapter.js` — Moondream client
- `extension/v2-task.js` — orchestrator, `collectPageControls()`

**Key configuration**
- Ollama endpoint: `http://127.0.0.1:11434` (no env var; hardcoded default, overridable via constructor)
- Models: `moondream` (vision), `qwen2.5-coder:7b` (text)
- Local-first toggle: popup checkbox → `chrome.storage.local.executionMode` (`'cloud'` default, `'local-qwen'` opt-in)
- `VISION_GENERATE_TIMEOUT_MS = 8000` (`local-vision-adapter.js`)
- `VISION_CANDIDATE_LIMIT = 10` (`decision-router.js`)

**Current metrics** (measured in this dev environment, not a demo-hardware benchmark)
- Privacy tests: 48/48 pass
- Decision-router/local-vision tests: 40/40 pass
- Full suite: 329 tests, 324 pass, 5 fail (all pre-existing, Ollama-dependent)
- Build: succeeds (`v2-task.bundle.js` 180.5kb, `playground.bundle.js` 94.6kb)
