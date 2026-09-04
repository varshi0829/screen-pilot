# ScreenPilot — Phase 8 Series Task Tracker

Companion to [`spec.md`](./spec.md). Tracks the exact state of work for the
top-right control-selection investigation.

Legend: `[x]` done · `[ ]` pending · `[~]` proposed / awaiting approval

---

## Phase 8 — Top-right control selection audit (AUDIT ONLY)

- [x] Trace execution path `matchElement → candidates → scoring → ranking → winner`
- [x] Dump top-right candidates from `collectPageControls()` (real code, headless Chromium)
- [x] Compare avatar vs notification vs create vs search vs hamburger
- [x] Produce score breakdown (base attr / semantic / type affinity / region / total)
- [x] Identify root cause → two mechanisms (A: paraphrase gap; B: wrong exact label)
- [x] Identify smallest fix candidate (add profile/account/avatar synonym group) — **proposed, not applied**
- [x] Self-match status check (`#sp-v2-status-banner` filter verified correct in source)
- [x] Latency analysis (no client timers; vision call dominant by inference)
- [x] OpenRouter 502 preliminary analysis
- No code changes made in this phase (audit only)
- ⚠️ Disclosure: `npm run build:ext` was run during evidence-gathering, which
  overwrote the (already-dirty) `dist/` bundles. Prior dirty state not recoverable.

## Phase 8.1 — Runtime targetElement logging

- [x] Locate entry point → `executor-engine.js` `_resolveElement(step)` (call site line ~326)
- [x] Define smallest logging statement (`[SP:Target]` object dump)
- [x] Show expected output example
- [x] **IMPLEMENT** the `[SP:Target]` log immediately before `matchElement()`
- [x] Build extension (`npm run build:ext` → v2-task.bundle.js 86.1kb, playground 80.0kb)
- [x] Run all tests
- [x] Show exact diff (isolated to the 6-line log insertion)
- Test results:
  - executor-engine: 51 passed, 0 failed
  - session-store / nav-classifier / transitions / dom-matcher: passed, 0 failed
  - orchestrator: 37 passed, **13 failed — PRE-EXISTING** (confirmed via `git stash`;
    unrelated `chrome.storage` stubbing gap, not caused by this change)

## Phase 8.2 — Token budget audit (AUDIT ONLY)

- [x] Locate every `max_tokens` / `maxOutputTokens` (plan ×2 = 4096; analyze = 512/2048)
- [x] Show file / function / line / current value
- [x] Determine source of 4096 (hardcoded literals, not size-derived)
- [x] Measure actual planner JSON size (1-step ~298 tok; 10-step ~1,623 tok)
- [x] Recommend value (2048) — **proposed, not applied**
- No code changes made in this phase (audit only)

---

## Proposed follow-ups (require explicit approval before implementation)

- [~] **Fix A (Mechanism A):** add `['profile', 'account', 'avatar', 'user menu']`
      to `SYNONYM_GROUPS` in `dom-matcher.js`. Single data-only line. Only after
      `[SP:Target]` logs confirm the planner is emitting a paraphrase.
- [~] **Fix B (token budget):** change `plan/route.ts:176` and `:234` from `4096`
      to `2048`.
- [~] **Bundle hygiene:** rebuild + reload unpacked extension before re-testing;
      confirm via console whether `#sp-v2-status-banner` still self-matches.
- [~] **Decide** whether to keep or revert the regenerated `dist/` bundles.

## Blocked / needs live data

- [ ] Disambiguate Mechanism A vs B — needs the `[SP:Target]` console line from a
      real logged-in GitHub run of the avatar/SSH-key workflow.
- [ ] Confirm whether the `top_navigation` 8-cap truncates the avatar on the real
      GitHub header (needs live element count).
