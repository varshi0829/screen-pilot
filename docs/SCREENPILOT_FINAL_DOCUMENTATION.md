# ScreenPilot — Final Documentation

Single source of truth for the final implementation. Detailed measured results are in `docs/METRICS.md`. Evaluation methodology is in `eval/README.md`.

---

## 1. Project overview

ScreenPilot is a Chrome extension (Manifest V3) that acts as a **generic, privacy-first browser guide**. The user types a natural-language goal ("Search for artificial intelligence", "Click the button with the warning icon"). ScreenPilot works out the next UI element to act on, highlights it with an instruction bubble, waits for the user to act, verifies the effect, and continues until the goal is complete.

It works on arbitrary websites with no site-specific rules. Reasoning runs locally first, on deterministic grounding plus two local models served by Ollama (Qwen for text reasoning, Moondream for visual perception), with the cloud only as a fallback. Sensitive data is redacted on the device before any screenshot or page description can leave it.

## 2. Problem statement and motivation

People lose time and make mistakes navigating unfamiliar web applications. AI assistants that can "see" a page usually send full screenshots and page text to a cloud model. That leaks passwords, card numbers, contact details and other personal data, adds network latency and cost, and fails offline.

ScreenPilot's aims are:
- Understand arbitrary goals on arbitrary sites generically.
- Keep reasoning on the user's machine wherever possible.
- Guarantee that sensitive content is removed locally before any model or network use.
- Stay fast: avoid unnecessary model calls, clicks and replanning.

## 3. Requirements

- **Generic.** No website-specific selectors, rules, phrases, synonyms or routes. Fixtures and demo pages are only for testing.
- **Semantic.** Separate what the user wants to *do*, *which element* does it, and *which value* the user supplied. UI labels are never treated as user input.
- **Efficient.** Take the shortest valid path, make no exploratory actions, and replan only when verification shows the previous action failed or the page changed.
- **Private.** Sanitize text and redact screenshot pixels locally, before any network request.
- **Local-first.** Deterministic grounding first, then one local model per planning cycle, with cloud only as a fallback.
- **Verified.** Check every step's effect; complete only on evidence.

## 4. Final architecture

```
Goal
 └─► PageStateService ── extract interactive elements (roles, accessible names, bbox, form, required)
        └─ PrivacySanitizer ── redact sensitive text/values; collect sensitive bboxes
 └─► DecisionRouter
        L1  deterministic exact grounding          (score ≥ 0.85)
        L2  generic IDF-weighted lexical grounding (score ≥ 0.70, ambiguity check)
        L3  exactly one local provider per cycle:
              ≥1 text candidate  → Qwen (qwen2.5-coder:7b, text reasoning)
              0 text candidates  → Moondream (visual perception, redacted screenshot)
                                    null pick + exactly one unlabeled control → structural resolution
            local failure → cloud fallback (once)
 └─► ExecutorEngine ── resolve target (text match, or known position for unlabeled targets), highlight, wait for user
 └─► Verify ── step effect (URL / hash / DOM / field value) + goal verifier + goal-consumed check
 └─► Replan only when needed
```

The main files are:
- `extension/v2-task.js`: task loop, verification gate and state machine wiring.
- `extension/services/decision-router.js`
- `extension/services/page-state-service.js`
- `extension/lib/privacy-sanitizer.js`
- `extension/services/screenshot-service.js`
- `extension/services/executor-engine.js`
- `extension/services/goal-verifier.js`
- `extension/providers/local-qwen-adapter.js` and `local-vision-adapter.js`
- `extension/background.js`: screenshot capture and the Ollama proxy.

## 5. End-to-end execution flow

1. **Goal submitted** (overlay → `_startNewTask`): the session is created in `SessionStore` and the state goes `IDLE → PLANNING`.
2. **Verifier gate:** extract the page state and check whether the goal is already satisfied or consumed. If so, the task completes with no model call.
3. **Route:** L1 → L2 → L3, as described in section 4.
4. **Execute:** the executor resolves the target and highlights it (`EXECUTING → AWAITING_USER`).
5. **User acts:** a click, typing (settled after 600 ms of typing idle), or navigation (`VALIDATING`).
6. **Validate** the step's effect and record the completed step with before/after evidence.
7. **Replan or complete:** settled targets are withheld from the next cycle, and the loop continues until the goal is satisfied or consumed (`COMPLETE`). Across page navigations the session resumes from `SessionStore`.

## 6. Page-state extraction

`PageStateService.extractPageState()` walks interactive elements: `button, a, input, select, textarea, [role=button|link|menuitem|tab|textbox], summary`, up to 300. For each one it produces `{id: el_N, role, tag, text, placeholder, ariaLabel, value, href, type, autocomplete, formId, required, region, bbox, visible, enabled}`.
- **Accessible names** come from aria-label, aria-labelledby (multiple IDs), `label[for]`, an ancestor `<label>`, title, and `img[alt]`.
- **ScreenPilot's own UI is excluded** (`sp-*` / `screenpilot-*` IDs, `data-screenpilot`).
- **Unnamed buttons are kept.** A button, or `role="button"`, with no name is still a candidate, because icon-only controls are a standard pattern. Other unnamed elements are dropped.
- **Privacy runs last.** Every element passes through `PrivacySanitizer` before the function returns, and `sensitiveRegions` is returned alongside.

## 7. Privacy architecture

Privacy enforcement happens at the **source**:
- **Text:** no caller (L1/L2, the Qwen prompt, the cloud request) ever receives an unsanitized element.
- **Pixels:** every screenshot is redacted inside the capture step itself, before a JPEG exists that could be serialized.

The Moondream image, the cloud screenshot and the V1 Explain/Ask screenshot all go through the same `CAPTURE_SCREENSHOT` path. Only redacted output ever leaves that path.

## 8. Sensitive-data detection

`PrivacySanitizer.isSensitiveElement` flags an element when any of these hold:
- **Input type:** `password`, `email` or `tel`.
- **Autocomplete token:** a WHATWG sensitive token, such as `cc-number`, `one-time-code`, `new-password`, `bday` or `street-address`.
- **Label keywords:** a whole-word keyword in the placeholder or accessible name (password, OTP, CVV, card number, SSN, API key, and similar).
- **Content patterns:** the element's own value or text matches a PII pattern (email, SSN, 13–19 digit card run, or phone number).

Sensitive elements have their `text`/`value` replaced by `[REDACTED]`. Grounding metadata (role, name, bbox) is kept, so the agent can still target the field without seeing its content. The V1 content-script path (`getSensitiveScreenshotRegions` in `content.js`) applies the same kinds of signals to inputs and textareas, including associated `<label>` text.

## 9. Sensitive-region propagation

`sensitiveRegions` (CSS-pixel bboxes of sensitive elements) is produced in the **same cycle** as the page state. It is carried with it, sent to the background worker in the `CAPTURE_SCREENSHOT` message along with `devicePixelRatio`, and never cached, so the regions always match the page being captured.

## 10. Screenshot capture and redaction

`ScreenshotService.captureVisibleTab` → `compressImage`:
1. Decode the PNG and resize it to at most 1024 px wide.
2. Map CSS boxes to image pixels (`devicePixelRatio × resize scale`, `computeRedactionRects`), clipped to the image.
3. Fill each box solid black.
4. Encode as JPEG (quality 0.70).

The unredacted frame never exists beyond that function. For Moondream, the local-vision adapter downscales its own copy to 512 px and draws candidate markers on it (section 15). The original redacted image is left untouched for the cloud fallback.

## 11. L1 deterministic grounding

`UIGroundingService.findDeterministicMatch` compares the goal against element names. If the score is ≥ `DETERMINISTIC_THRESHOLD` (0.85), the element is used immediately, with no model involved.

The **required-field gate** redirects a submit target to its form's still-empty `required` field. It also extracts a value stated in the goal (`extractRequestedValue`), so the value lands in the field rather than the label.

## 12. L2 generic grounding

`UIGroundingService.rankElements` scores elements by **IDF-weighted token coverage**. Rare goal words count more than common ones. Morphological prefix matching (≥ 4 characters, 0.9 credit) handles "invoice" vs "invoices".

A top score ≥ `ML_GROUNDING_THRESHOLD` (0.70) is used directly, unless the **ambiguity check** fires. That happens when:
- a rival scores within 0.05 of the winner, or
- goal words are unmatched while the runner-up holds ≥ 30% of the winner's score and the lead is below 0.15.

When it fires, the decision is escalated instead of guessed.

**Settled targets** (controls whose completed action still has evidence of its effect) are withheld, so the same goal progresses to the next step. **Action continuations** (for example, the submit after a filled field in the same form) are resolved structurally.

## 13. L3 provider routing

This applies with `executionMode = local-qwen`, the local-first configuration:
- **L2 ranked ≥ 1 text candidate → Qwen.** Semantic reasoning over the top 25 ranked candidates.
- **L2 ranked 0 candidates → Moondream.** Visual perception over the redacted screenshot.

**Exactly one local model runs per planning cycle.** A local failure (unavailable, timeout, invalid output) falls through to the cloud **once**. It never falls back to the other local model. Timeouts: Qwen 45 s, Moondream 30 s, availability check 2.5 s. Ollama is called through the background worker, because Chrome's Private Network Access rules block page-context requests to `127.0.0.1`. Each model is preloaded and kept alive for 5 min.

## 14. Qwen's role

Qwen (`qwen2.5-coder:7b`, Q4_K_M, local) is the **semantic planner** for goals that have text candidates the lexical tiers could not settle, such as paraphrases or intent without exact words.

Its prompt makes it separate three things:
- the **action**;
- the **target**, one of the supplied element IDs;
- the **user-provided value**.

UI labels and placeholders are never treated as values. Its output is validated against the current page state before use.

## 15. Moondream's role as visual perception

Moondream is **not a planner**. It answers one question: which supplied candidate is visually the target? It receives:
- the goal;
- the redacted screenshot, downscaled to 512 px;
- a compact candidate list (id, role, text, and bbox normalized to 0–1);
- temporary candidate markers drawn on its image copy: a coloured dot plus an `[elementId]` label at each candidate.

It must return an ID from the list, or `null`. The router validates the ID against the live page state and builds the step itself. Measured behaviour (section 24):
- Moondream often returns `null` for structured selection.
- The **sole-unlabeled-candidate resolution** handles the common single-icon case deterministically.
- Harder visual choices currently reach the cloud fallback.

## 16. Generic natural-language understanding

Goals are handled semantically, never by phrase rules:
- **Grounding:** IDF-weighted, morphology-aware grounding of the goal's words against element names.
- **Values:** `extractRequestedValue` uses the generic markers "for / to / with / into". It returns an empty string rather than guessing, and never returns the control's own label ("Search Wikipedia" is not the value; "artificial intelligence" is).
- **Clarifications:** clarification answers are added to the grounding intent, never typed as a value.
- **Hard cases:** Qwen handles semantic intent the lexical tiers can't.

## 17. Labelled and unlabelled / icon-only targets

- **Labelled controls** are grounded by their accessible names (L1/L2/Qwen).
- **Icon-only controls** (no text, aria-label or title) are kept by page-state extraction and reach L3 as zero-text-candidate cases:
  1. Moondream is asked.
  2. If it names nothing usable and **exactly one** unlabeled interactive candidate exists (interactive role/tag, no text/name/placeholder/value, valid ID, real bbox), that candidate is resolved structurally.
  3. Two or more such candidates count as genuine ambiguity and go to the cloud.
- **Plan steps for unlabeled targets** carry an **empty** `targetElement.text`, never a goal-derived label, plus the element's `bbox`. The human-readable description still uses the goal.

## 18. Executor and target resolution

`ExecutorEngine` works in **guide mode**. It resolves the target, self-checks it (connected, enabled, visible), highlights it with the instruction, and waits for the real user action: a click, typing, form submit or URL change.
- **Resolution:**
  - Labelled targets are resolved by `DOMMatcher` text/structure scoring, with alternatives and a bounded wait-and-retry for late renders.
  - Targets with empty text are resolved by **known position**: `elementFromPoint` at the centre of the element's bbox.
- **Fills:** a fill settles after 600 ms of typing idle, and the typed value is checked (`valueSatisfies`).

## 19. Verification and replanning

- **`validateStep`** compares the pre-action and post-action snapshots (URL including hash, title, DOM hash).
- **`GoalVerifier.isGoalSatisfied`** checks URL/title evidence for the goal.
- **`isGoalConsumed`** completes the task when at least one step has settled and nothing left on the page still grounds the goal, with no pending continuation.

Replanning happens only after an action. A **dedup guard** blocks re-proposing an action whose effect already holds, and stale-plan protection discards plans for a page that has since changed.

## 20. Local/cloud fallback behaviour

The default execution mode is `cloud`; the local-first mode is `local-qwen`.
- **Cloud fallback:** in local mode the cloud (`VercelBackendAdapter`) is used only after the routed local provider fails, and at most once per cycle.
- **What the cloud receives:** only sanitized elements and redacted screenshots.
- **Failure:** if both fail, the task stops with an error instead of looping.
- **Ambiguous goals:** these pause and ask the user for a clarification.

## 21. Performance and latency

Design choices that reduce latency:
- Deterministic tiers first (measured ~0.1–0.3 s end to end for a deterministic task).
- One model per cycle.
- Page state reused within a cycle.
- The goal checked once per cycle.
- The model preloaded and kept alive.
- Moondream's image downscaled.
- No replanning without an action.
- Completion detected without a model call.

Model inference dominates when a model is needed. First calls after load are much slower than warm calls. Measured figures are in section 24 and `docs/METRICS.md`.

## 22. Client resource utilization

- **Hardware:** a 13th Gen Intel Core i7-13620H laptop with 16 logical cores and 15.7 GB RAM.
- **CPU-only inference:** the only GPU is Intel UHD integrated graphics, and Ollama reports `size_vram = 0` for both models.
- **Memory pressure:** with both models resident, the laptop runs close to its RAM limit.

Measured per-model CPU and RAM are in section 24.

## 23. Evaluation methodology

The evaluation harness is in `eval/`, and its full definitions are in `eval/README.md`. It drives the **unmodified extension** in a real Chromium window through Playwright:
- Goals go in through the extension's own task entry point.
- The harness plays the user.
- Everything is measured from the extension's own logs, its rendered highlight, the JPEG its capture pipeline returns, and Windows process counters.

Ground truth, entered by hand, lives only in `eval/ground-truth/`:
- 13 visual cases;
- 29 labelled privacy elements;
- 3 end-to-end tasks.

The five metrics are:
1. **Visual-context accuracy** = correct first-target identifications / runs. A negative case is correct when nothing is highlighted.
2. **PII precision/recall** per ground-truth element, for both detectors.
3. **Redaction precision** on the real output JPEG:
   - pixel precision, |painted ∩ sensitive| / |painted|;
   - coverage;
   - IoU against ground-truth boxes.
4. **Client resource utilization:** CPU and RAM per process group (Qwen, Moondream, Ollama, browser) and system-wide, over idle / inference / task windows.
5. **End-to-end latency:** goal submitted → verified completion, with a planning / highlight / verification / simulated-user split. The mean, median, min and max are taken over repeated runs after a warm-up.

## 24. Measured evaluation results

All values below were measured on a 13th Gen Intel Core i7-13620H (16 logical cores, 15.7 GB RAM, Windows 11, CPU-only inference) by the harness in `eval/`. Full tables and per-case rows are in `docs/METRICS.md`, and raw data is in `eval/results/*.json`.

**1. Visual-context accuracy.** 20 / 26 runs correct = **76.9%** (13 cases × 2 repetitions). Local-only (no cloud involvement): **61.5%**.

| Category | Correct / runs |
|---|---|
| Labelled | 8/8 (100%) |
| Icon-only | 6/6 (100%) |
| Visual-attribute (colour/size) | 2/6 (33.3%) |
| Negative (target absent) | 4/6 (66.7%) |

By mechanism:
- L1: 2/2
- L2: 4/4
- Structural (sole unlabeled): 4/4
- Qwen: 2/4 (it picked the plain "Delete" over the red one)
- Cloud fallback: 8/12

Moondream itself named no target in any run: every vision-path decision came from the structural resolution or the cloud. Moondream inference was 5,537 ms mean, 1,089 ms median, min 906 ms, max 23,326 ms (the high values are cold first calls). Qwen inference was 15,873 ms mean, 12,559 ms median, 4,067–34,308 ms.

**2. PII precision/recall** (19 sensitive + 10 non-sensitive elements, both detectors identical):

| TP | FP | TN | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| 15 | 1 | 9 | 4 | **93.8%** | **78.9%** | 85.7% |

- **Missed (FN):** full name, Aadhaar number, a field labelled only "PIN", and an email shown as plain page text.
- **False positive:** a 14-digit courier tracking ID.

**3. Redaction precision**, on the real output JPEG of the extension's capture pipeline:
- **Pixel redaction precision: 93.0%** of painted pixels fall on truly sensitive elements. The rest is the tracking-ID false positive: 5,190 px, 1.16% of the non-sensitive area.
- **Mean IoU** of redaction boxes vs ground-truth boxes for detected fields is **0.967**. 100% of detected regions are at IoU ≥ 0.9.
- **Coverage** of all ground-truth sensitive pixels is 80.5%. That's lower because the 4 undetected fields are not redacted.

**4. Client resource utilization.** CPU is expressed as a percentage of the whole machine, sampled about every 1.5 s:

| Window | System CPU avg / peak | Model process CPU avg / peak | Model process RAM (working set) |
|---|---|---|---|
| Idle (models loaded) | 21.1% / 48.0% | ≈0% | Qwen 4,358 MB, Moondream 2,739 MB |
| Qwen inference | 48.1% / 68.0% | Qwen 39.3% / 52.7% | Qwen 4,294 MB |
| Moondream inference | 46.3% / 56.0% | Moondream 22.3% / 27.7% | Moondream 1,362 MB |
| All task activity | 21.2% / 68.0% | — | — |

- **Other processes:** the browser (the extension's Chromium) averaged 0.2–5.2% CPU and 476–740 MB RAM, and the Ollama server about 20 MB.
- **System RAM in use:** 13.3–15.6 GB of 15.7 GB.
- **Ollama-reported model sizes:** Qwen 4,828 MB, Moondream 1,242 MB, VRAM 0 for both. There is no GPU measurement because inference is CPU-only.

**5. End-to-end latency** (goal submitted → verified completion, 3 measured runs after 1 warm-up):

| Task | Completed | Total mean / median / min / max (ms) | System (excl. simulated user) | Cold warm-up |
|---|---|---|---|---|
| Deterministic click (L1) | 3/3 | 131 / 127 / 116 / 150 | 85 / 80 / 73 / 103 | 177 ms |
| Icon-only click (Moondream + structural) | 3/3 | 1,852 / 1,894 / 1,748 / 1,914 | 1,799 / 1,846 / 1,681 / 1,871 | 13,422 ms |
| Two-step search (Qwen) | **0/3** | not measurable, see below | — | — |

The Qwen two-step task did **not** complete in any run, warm-up included. Qwen correctly selected the search field in 5.2–5.3 s warm (22.9 s cold), and the user's text was typed. The second planning cycle then produced no decision within the 180 s timeout. Its end-to-end latency therefore cannot be reported. This is a measured, open defect (section 27).

## 25. Test results

All suites pass with no failures (final run). Counts are tests per suite:

| Suite | Tests | Suite | Tests |
|---|---|---|---|
| decision-router | 60 | executor-engine | 74 |
| decision-router-vision | 25 | goal-verifier | 54 |
| page-state | 30 | orchestrator | 32 |
| privacy-sanitizer | 14 | state-progression | 32 |
| privacy-e2e-integration | 4 | v2-integration | 6 |
| content-privacy-context | 18 | local-vision-adapter | 47 |
| screenshot-sanitizer | 8 | eval harness (eval-lib) | 12 |

That is 416 tests passing across these 14 suites, and `npm run build:ext` succeeds. `runtime-validation.test.mjs` requires a live, uncontended Ollama and is not part of this count.

## 26. Important debugging / root-cause fixes

- **Label vs value.** "Search Wikipedia for artificial intelligence" once typed "Search Wikipedia" (the control's label) and selected "English". Fix: generic value extraction plus separating label from value in the step shape.
- **Repeated actions after navigation.** On GitHub, after clicking "+" the same "+" was proposed again. Fix: effect-evidence settled steps plus withholding settled targets, so the same goal progresses.
- **Submitting before filling a required field.** Fix: a required-field gate based on the form's own `required` attribute.
- **ScreenPilot's widget grounding itself as the target.** Fix: exclude its own UI from the page state.
- **Moondream always timing out.** The 8 s budget was shorter than a measured ~10 s first call. Fix: raise it to 30 s.
- **Label-only sensitive fields left visible in V1 screenshots.** Fix: associated-label detection.
- **Provider error after a successful final click.** Root cause: the goal was never recognised as done. Fix: the `isGoalConsumed` completion check.
- **Icon-only buttons never reaching vision.** The page-state filter dropped unnamed buttons. Fix: keep them.
- **Moondream unable to map pixels to IDs.** Fix: normalized bboxes plus temporary candidate markers on its image copy. Moondream still often returns `null`, which led to the next fix.
- **Null vision answers.** Fix: sole-unlabeled-candidate structural resolution.
- **Unlabeled targets failing with "No element matched".** The step's search text was the goal sentence. Fix: an empty own-label plus position-based resolution by bbox.

## 27. Limitations and trade-offs

- **PII detection is signal-based** (types, autocomplete tokens, label keywords, patterns). It misses:
  - personal names;
  - Indian national IDs such as 12-digit Aadhaar;
  - fields labelled only "PIN";
  - PII shown as plain page text rather than in form controls.

  It also flags long digit runs such as a 14-digit courier tracking ID as card numbers.
- **Redaction trusts `window.devicePixelRatio`** to map boxes onto the capture. That's correct in normal Chrome, including page zoom, but not under DevTools device emulation.
- **Moondream is weak at structured element selection.** It often returns `null`. Choices based on visual attributes (colour, size), or between several icon-only controls, currently depend on the cloud fallback.
- **A two-step Qwen task stalls after the fill.** Measured: after Qwen selected the search field and the value was typed, the second planning cycle produced no decision within 180 s (0/3 completions). This is open; its end-to-end latency is unmeasured.
- **Negative goals can mislead the fallback.** Goals naming a control that doesn't exist can be answered wrongly by the cloud fallback.
- **The highlight ring can hug the inner icon.** For position-resolved icon buttons it surrounds the inner icon rather than the whole button. Clicking still works.
- **Resource and latency limits.** Both local models together take most of a 16 GB machine's RAM, and inference is CPU-only. First (cold) model calls take several to tens of seconds.
- **Temporary debug hooks remain in the code.** Remove them for production use: the Moondream success log in `decision-router.js`, the redacted-preview storage flag in `screenshot-service.js`, and `extension/debug/`.

## 28. Demo scenarios

The demo page is `node_modules/privacy-demo.html`, a student profile containing dummy PII:
1. **Redaction:** capture a screenshot. Name stays visible; email, phone, password and card are blacked out.
2. **Deterministic:** "Click Submit Profile" is grounded at L1, highlighted, clicked, then verified complete via the URL hash.
3. **Icon-only:** "Click the button with the warning icon" goes to L3 vision. Moondream runs, and the sole unlabeled control is resolved and highlighted by position.
4. **Qwen:** "Search for artificial intelligence" on a search page. Qwen selects the search field (measured 5.2 s warm). Continuing to the submit step currently stalls (section 27).

## 29. Repository / file structure

```
extension/
  manifest.json, background.js          service worker: capture, Ollama proxy, messaging
  v2-task.js → dist/v2-task.bundle.js    task loop (content script)
  content.js, lib/dom-matcher.js         widget, highlighter, V1 paths, DOM matching
  lib/privacy-sanitizer.js               sensitive-data detection/sanitization
  services/                              page-state, decision-router, ui-grounding, executor,
                                         goal-verifier, screenshot, session-store, ollama-proxy
  providers/                             local-qwen, local-vision (Moondream), cloud adapters
  shared/state-machine/                  task states and transitions
  tests/                                 unit/integration tests (node --test)
eval/                                    evaluation harness, ground truth, results
docs/                                    this document, METRICS.md, component specs
```

## 30. Setup and run

1. `npm install`, then `npm run build:ext`.
2. Load `extension/` as an unpacked extension (chrome://extensions → Developer mode).
3. Install Ollama and run `ollama pull qwen2.5-coder:7b` and `ollama pull moondream`, with Ollama running on `127.0.0.1:11434`.
4. For local-first mode, set `executionMode` to `local-qwen` in the extension settings/storage.
5. Tests: `node --test extension/tests/<file>.test.mjs`. `executor-engine` and `goal-verifier` use their own runner, via `node extension/tests/<file>.test.mjs`.
6. Evaluation: see `eval/README.md` (`npm run eval:privacy | eval:visual | eval:e2e | eval:report`).

## 31. 30-second explanation

ScreenPilot is a Chrome extension that guides you through any website from a plain-English goal. It reads the page's interactive elements, redacts anything sensitive on your machine, and finds the right control with fast deterministic matching. It escalates to a local Qwen model for semantic goals, or to a local Moondream vision model for icon-only controls, and uses the cloud only as a fallback. It highlights the element, waits for you to act, verifies the result, and continues until the goal is done. It has no site-specific rules, and no raw personal data leaves the device.

## 32. 2-minute explanation

Web agents usually screenshot the page and send everything to a cloud model: slow, costly, and a privacy leak. ScreenPilot inverts that:
- **Privacy at the source.** It first builds a compact page state: each interactive element's role, accessible name, box and form. Every element passes through a local privacy sanitizer that recognises passwords, card numbers, emails, phones, OTPs and similar, so their contents never reach any model. The same sensitive boxes are painted black inside the screenshot capture step itself, so an unredacted image never exists outside that function.
- **Cheapest reasoning first.** Exact matching, then IDF-weighted grounding that understands paraphrases and word forms and refuses to guess when two candidates are too close. Only if those can't decide does ScreenPilot use exactly one local model: Qwen when there are text candidates to reason over, Moondream when the target is purely visual. Moondream is a perception component; it can only name an element ScreenPilot already extracted. If it can't, and there is exactly one unlabeled control, that control is resolved structurally. The cloud is a last resort.
- **Guide, then verify.** The executor highlights the target and waits for the real user action, then verifies the effect (URL, DOM or field value). It remembers which actions already took effect, so the same goal moves to the next step, and it completes as soon as nothing left on the page matches the goal.
- **Measured, not claimed.** Everything is backed by a harness that runs the real extension and reports visual accuracy, PII precision/recall, redaction precision, resource use and end-to-end latency.

## 33. Likely technical questions

- **Why not send the screenshot to a big cloud model?** Privacy, latency and cost. Most steps are solved deterministically in milliseconds, and the cloud only ever sees sanitized, redacted input.
- **How do you avoid site-specific hacks?** All grounding is generic: accessible names, IDF weighting, morphology, roles, form structure and bounding boxes. Demo pages are test fixtures only, and a production-code audit found no site-specific logic.
- **Why two local models?** Qwen reasons over text candidates; Moondream perceives pixels when there is no text. Exactly one runs per cycle, chosen by whether any text candidate exists.
- **What stops the model from clicking something invented?** Both models must return an ID from the supplied candidate list, and the router validates it against the live page before building any step.
- **How is "Search Wikipedia" not typed as the query?** Value extraction takes only what follows generic markers ("for", "to", …) and never returns the control's own label; labels describe the target, never the payload.
- **How is redaction guaranteed?** Boxes are painted onto the canvas before JPEG encoding, inside the capture function, so every consumer gets the redacted bytes.
- **What if Moondream returns nothing?** If exactly one unlabeled interactive control exists, it is resolved structurally. Otherwise the router falls back to the cloud once.
- **How do you know a step worked?** Before/after snapshots (URL, hash, DOM hash, field value), a goal verifier, and a goal-consumed check. Replanning happens only after an action.
- **Is it fast?** Deterministic tasks complete end to end in well under a second. Model-backed steps cost one local inference; see section 24 for measured cold and warm figures.
- **What are the weaknesses?** Signal-based PII detection misses names, national IDs and plain-text PII. Moondream is weak at structured selection. Both models together strain a 16 GB laptop.
