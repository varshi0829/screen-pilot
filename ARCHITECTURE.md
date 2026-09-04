# ScreenPilot V2 — Architecture

ScreenPilot is a Chrome extension that guides a user through any web app step by step: it observes the live page, decides the single next action toward a stated goal, highlights the target element, waits for the user to act, and re-observes — a closed control loop rather than a chat interface.

V2's defining change from V1 is **where decisions get made**. V1 sent every screenshot to a cloud LLM. V2 routes each decision through a 3-tier local cascade first, only escalating when a cheaper tier isn't confident, so most actions resolve in single-digit milliseconds with zero API cost.

## 1. The decision cascade

```
 USER GOAL + LIVE DOM
         │
         ▼
 PageStateService.extractPageState()      normalized, website-agnostic JSON of visible
         │                                interactive elements — no site-specific code
         ▼
 GoalVerifier.isGoalSatisfied()  ────►  already true? skip planning entirely (no API call)
         │ no
         ▼
 DecisionRouter.route(goal, pageState)
         │
         ├─ L1  DOMMatcher (dom-matcher.js)         deterministic text/role/region scoring
         │      confidence ≥ 0.85 ──────────────────────────────────► execute   (<5ms)
         │
         ├─ L2  UIGroundingService                  feature-vector relevance ranking
         │      confidence ≥ 0.70 ──────────────────────────────────► execute   (<15ms)
         │
         └─ L3  LocalQwenAdapter → Ollama            qwen2.5-coder:7b, 1-action JSON out
                (falls back to VercelBackendAdapter   ─────────────────► execute   (~1.5–2.5s)
                 / cloud only if local is unavailable)
                             │
                             ▼
                    ExecutorEngine resolves + highlights the target element
                             │
                             ▼
                    user acts (real click/keystroke — never simulated)
                             │
                             ▼
                    pre/post DOM snapshot comparison + GoalVerifier
                             │
                    goal complete? ──yes──► done
                             │no
                             └──────────────► re-plan from fresh state (loop)
```

Each cycle plans **one action**, not a multi-step script. This is a deliberate tradeoff: a multi-step plan goes stale the moment the page changes underneath it (a modal opens, a menu appears, a redirect fires), and diagnosing *which* step in a stale plan is still valid is harder than just re-observing and re-deciding. The cost is an extra planning round-trip per step; the benefit is that the system is self-correcting by construction.

## 2. Core components

| Component | File | Responsibility |
|---|---|---|
| **Task orchestrator** | `extension/v2-task.js` | The plan/execute/verify loop; owns session lifecycle, replanning, and all the safety nets described below |
| **Decision router** | `extension/services/decision-router.js` | Tries L1 → L2 → L3 in order, short-circuiting on the first confident match |
| **Deterministic matcher (L1)** | `extension/lib/dom-matcher.js` | Text/ARIA/region scoring against the live DOM — no ML, no network |
| **UI grounding model (L2)** | `extension/services/ui-grounding-service.js` | Lightweight feature-vector scorer for fuzzy matches L1 can't resolve confidently |
| **Local planner (L3)** | `extension/providers/local-qwen-adapter.js`, `extension/services/ollama-proxy.js` | Talks to a locally-hosted `qwen2.5-coder:7b` via Ollama; the proxy exists because a page's own HTTPS context blocks a direct fetch to a local HTTP endpoint (Private Network Access), so the request is relayed through the background script |
| **Cloud fallback (L3)** | `extension/providers/vercel-backend-adapter.js`, `src/app/api/plan/route.ts` | Used only when local mode is off or Ollama is unavailable |
| **Page-state extraction** | `extension/services/page-state-service.js` | Live DOM → normalized JSON (role, text, region, visibility) every planning cycle — no caching, so it can never go stale |
| **Executor** | `extension/services/executor-engine.js` | Resolves the target element, highlights it, and detects the real user action (a genuine DOM click listener, not a simulated event) |
| **Goal verification** | `extension/services/goal-verifier.js` | Two jobs: (a) generic pre-check — is the goal already satisfied before planning even starts; (b) post-action completion gate for goals with an explicit success-signal contract |
| **Navigation classifier** | `extension/services/navigation-classifier.js` | On every content-script bootstrap, classifies why the URL is what it is: the workflow's own navigation, a refresh, back/forward, or unexplained |
| **Session persistence** | `extension/services/session-store.js` | `chrome.storage`-backed session state, survives page reloads/navigation, and owns the stuck-detection budgets |
| **State machine** | `extension/shared/state-machine/transitions.js` | `IDLE → PLANNING → EXECUTING → AWAITING_USER → VALIDATING → COMPLETE` (plus `RECOVERING`, `PAUSED`, `ERROR`) — every transition is table-driven and logged |

## 3. Engineering safeguards

A generic, site-agnostic planner produces failure modes a hardcoded one never would — the system has to defend against its own uncertainty. A few of the mechanisms that exist specifically because a real failure was reproduced and traced to root cause:

- **Stale-plan protection.** A DOM/URL snapshot is taken immediately before and after every planning round-trip; if the page changed mid-flight, the response is discarded rather than acted on against a page it no longer describes.
- **Deduplication guard.** If the planner proposes the same step it already completed, the guard compares the current page against that step's own *post-completion* state (not its pre-click baseline — a sticky effect like an opened menu makes "changed since before the click" true forever, which used to let the same action repeat indefinitely). It also prefers the completed step's actual navigation destination (`urlAfter`) over where it started (`urlBefore`) when judging "is this the same place."
- **Bounded retry budgets, not silent loops.** A fast, cheap 3-attempt cap on repeating the same step, and a separate, larger, cost-scaled budget on total planning calls — sized so a stale-plan discard and a dedup-guard block can't quietly starve each other into burning the expensive budget for what should be a fast failure.
- **Navigation continuation.** After a real page navigation, a fresh content script has to figure out whether that navigation was the workflow's own doing. Ground-truthed from the resolved DOM element when it's a real link (including one sitting inside a non-anchor wrapper), with a conservative same-origin, time-bounded fallback for controls whose destination couldn't be predicted in advance — while still leaving a genuine interruption (an auth redirect, the user browsing away) classified as unexplained rather than silently treated as progress.
- **False-completion guards.** A heading that merely *describes* an action (a marketing headline next to its own unclicked "Get Started" button) is distinguished from a heading that *reports* a state already reached, using structural proximity and phrase-equivalence checks against nearby interactive controls — not keyword lists.

None of this is theoretical: each safeguard exists because a specific, reproduced failure (traced through real-browser testing, not assumption) demanded it, and each is covered by a regression test that fails without the fix.

## 4. Directory map

```
extension/
  v2-task.js                    orchestrator — the plan/execute/verify loop
  content.js                    content-script bootstrap, widget injection
  services/                     decision routing, execution, verification, session state
  providers/                    L3 planner adapters (local Qwen, cloud)
  lib/                          DOM matching + page snapshotting
  shared/                       state machine, shared types
  tests/                        node:test unit + integration suites (252 tests)
  dist/                         built content-script bundles (esbuild)
src/app/api/plan/                Next.js cloud-planning endpoint (L3 fallback)
docs/                            active architecture/spec documents
docs/archive/                    superseded docs, kept for history
.e2e-scratch/                    Playwright-based real-browser test harness (gitignored)
```

## 5. Testing approach

252 tests across `extension/tests/*.test.mjs`, run with Node's built-in test runner (`node --test`) — no test framework dependency. The suite mixes pure unit tests (matcher scoring, classifier logic) with orchestrator-level integration tests that drive the real `_bootstrapSession`/plan-loop code through mocked browser globals (`chrome.storage`, `document`, `window`), so a regression test proves the *actual* control flow, not a reimplementation of it. Several of the safeguards in §3 were only confirmed correct by also reproducing the failure against a real Chromium instance via `.e2e-scratch/` before writing the fix.
