# ScreenPilot V2 — Implementation Plan

**Author:** ScreenPilot Engineering Team  
**Date:** 2026-08-27  
**Architecture:** Local-First, Hierarchical Browser Agent  
**Hardware Profile:** Intel Core i5-1135G7 (8 logical CPUs), 14 GB RAM, Intel Iris Xe Graphics (CPU Inference)

---

## 1. Executive Summary & V1 Audit Findings

### 1.1 V1 Architecture & Problems
The ScreenPilot V1 architecture relied on a cloud-hosted LLM backend (`https://screen-pilot-j1az.vercel.app/api/plan` → OpenRouter / Gemini Direct). While functional, this cloud-centric approach exhibited several critical limitations:
1. **Network Latency & Stale Plans**: Heavy 20–30s round-trips meant web pages often changed state before a plan returned, leading to obsolete instructions.
2. **Cost & Quota Limits**: Multi-step cloud LLM calls rapidly exhausted API quotas and incurred ongoing per-token costs.
3. **Repeated Actions**: Cloud planners generating static multi-step plans occasionally repeated steps when DOM feedback wasn't fed back immediately after each action.
4. **Cloud Dependency**: Complete failure of the browser copilot whenever external APIs were unreachable or throttled.

### 1.2 Audit of Reusable Assets in Repository
Our audit of `~/screen-pilot` revealed high-quality existing components that will be preserved and extended for V2:
- **`extension/services/executor-engine.js`**: Robust action execution engine supporting `click`, `fill_form`, `select`, and `highlight`.
- **`extension/lib/dom-matcher.js`**: Deterministic, site-agnostic UI scoring algorithm that ranks candidate DOM elements by accessible name, role, aria-label, and text.
- **`extension/services/goal-verifier.js`**: Side-effect-free contract evaluator for verifying post-action state transition signals (`url_matches`, `text_present`, `element_present`, `element_absent`).
- **`extension/lib/page-snapshot.js`**: FNV-32a DOM hashing (`_computeDomHash`) and viewport snapshot capture.
- **`extension/services/session-store.js`**: State persistence layer built on `chrome.storage.local`.
- **`extension/services/screenshot-service.js`**: Viewport screenshot capture with canvas resizing (1024px max width, JPEG 0.70 quality).
- **`extension/providers/interface.js`**: Provider abstraction (`BackendAdapter`) supporting `plan()`, `recover()`, and `AbortSignal` cancellation.

### 1.3 Local Runtime Environment Audit
- **Local LLM Server**: **Ollama** running locally on `http://127.0.0.1:11434`.
- **Installed Quantized Models**:
  - `qwen2.5-coder:7b` (7.6B parameters, Q4_K_M, 4.7 GB RAM footprint, JSON mode support).
  - `qwen3:latest` (8.2B parameters, Q4_K_M, 5.2 GB RAM footprint).
  - *Benchmark*: Initial local test returned valid structured JSON in **1.9 seconds** evaluation time on CPU.
- **Runtimes**: Node.js v22.18.0, Python 3.13.7.

---

## 2. Target V2 Hierarchical Architecture

ScreenPilot V2 transitions to a **Local-First, Hierarchical decision cascade**:

```
                         USER GOAL
                             ↓
              PAGE STATE EXTRACTION (Generic Normalized JSON)
                             ↓
               ┌───────────────────────────┐
               │ 1. FAST LOCAL PATH        │
               │ Deterministic DOMMatcher  │
               └─────────────┬─────────────┘
                             ↓
                      Confidence High?
                        /         \
                      YES           NO
                       ↓             ↓
                   [EXECUTE]   ┌───────────────────────────┐
                               │ 2. SMALL UI GROUNDING MODEL│
                               │ Feature/Relevance Ranking │
                               └─────────────┬─────────────┘
                                             ↓
                                      Confidence High?
                                        /         \
                                      YES           NO
                                       ↓             ↓
                                   [EXECUTE]   ┌───────────────────────────┐
                                               │ 3. LOCAL QWEN (Ollama)    │
                                               │ Structured 1-Action LLM   │
                                               └─────────────┬─────────────┘
                                                             ↓
                                                       1-Action JSON
                                                             ↓
                                                    [EXECUTOR ENGINE]
                                                             ↓
                                                    [LIVE BROWSER DOM]
                                                             ↓
                                                    [GOAL VERIFIER]
                                                             ↓
                                                      Goal Satisfied?
                                                        /         \
                                                      YES           NO
                                                       ↓             ↓
                                                    [DONE]      [REPLAN 1-ACTION]
```

### 2.1 Layer Responsibilities
1. **Layer 1 — Fast Local Path (Deterministic)**: Evaluates goal against visible DOM elements using exact label matching, standard input fields, and `DOMMatcher`. Zero latency (<5ms), handles 40–50% of common actions.
2. **Layer 2 — Small ML Grounding Model (Lightweight Scorer)**: Ranks candidate UI elements against natural language intent using feature extraction (text similarity, element role, visibility, region). CPU-friendly (<15ms).
3. **Layer 3 — Local Qwen Planner (Ollama Fallback)**: Evaluates ambiguous pages or multi-step reasoning. Uses `qwen2.5-coder:7b` via local HTTP endpoint `http://127.0.0.1:11434`. Emits **1 structured action at a time** (no verbose multi-step plans).

---

## 3. Detailed Implementation Phases

### Phase 1: Repository Audit & Planning *(COMPLETED)*
- Audit repository structure, package scripts, providers, services, tests, and local Ollama setup.
- Create `docs/V2_IMPLEMENTATION_PLAN.md`.

### Phase 2: Documentation & Architecture Specifications
- Create all core documentation files in `docs/`:
  - `docs/V2_ARCHITECTURE.md`
  - `docs/V2_REQUIREMENTS.md`
  - `docs/LOCAL_QWEN.md`
  - `docs/PAGE_STATE.md`
  - `docs/UI_GROUNDING_MODEL.md`
  - `docs/DECISION_ROUTER.md`
  - `docs/QWEN_PLANNER.md`
  - `docs/EXECUTION_AND_VERIFICATION.md`
  - `docs/GOAL_VERIFICATION.md`
  - `docs/PERFORMANCE.md`
  - `docs/TESTING.md`
  - `docs/MIGRATION_V1_TO_V2.md`
  - `docs/V2_CHANGELOG.md`

### Phase 3: Generic Page-State Representation
- Build a generic, website-independent page state extractor (`extension/services/page-state-service.js`).
- Normalizes interactive DOM elements into lightweight JSON (`id`, `role`, `tag`, `text`, `placeholder`, `ariaLabel`, `visible`, `enabled`, `href`).
- Add unit tests in `extension/tests/page-state.test.mjs`.

### Phase 4: Local Qwen Provider Prototype
- Build `LocalQwenAdapter` in `extension/providers/local-qwen-adapter.js` satisfying `BackendAdapter`.
- Communicates directly with local Ollama (`http://127.0.0.1:11434/api/generate`) using `qwen2.5-coder:7b`.
- Enforces strict JSON output schema (`{ action, elementId, confidence, reason }`).
- Add unit tests in `extension/tests/local-qwen.test.mjs`.

### Phase 5: Structured 1-Action Qwen Planner
- Implement 1-action-at-a-time planning prompt and schema parser.
- Restrict actions to valid types: `click`, `type`, `select`, `scroll`, `navigate`, `wait`, `finish`.
- Prevent arbitrary JavaScript execution or code generation.

### Phase 6: Small UI Grounding / Ranking Model
- Implement lightweight UI element ranker (`extension/services/ui-grounding-service.js`).
- Scores candidate elements using token overlap, semantic weights, accessibility tree attributes, and region relevance.
- Add unit tests in `extension/tests/ui-grounding.test.mjs`.

### Phase 7: Decision Router Layer
- Implement `DecisionRouter` in `extension/services/decision-router.js`.
- Configurable confidence thresholds:
  - `DETERMINISTIC_THRESHOLD`: 0.85
  - `ML_GROUNDING_THRESHOLD`: 0.70
  - Fallback to Local Qwen when confidence < 0.70.
- Add unit tests in `extension/tests/decision-router.test.mjs`.

### Phase 8: Executor & Verifier Integration
- Connect `DecisionRouter` output to `ExecutorEngine` and `GoalVerifier`.
- Condition-based verification loop (max 150ms) checking DOM/URL state transitions.

### Phase 9: Stale-Plan & Loop Prevention
- Enforce pre/post fingerprint comparison (`preSnap` vs `postSnap`).
- Multi-step history Dedup guard preventing action repetitions when page state remains unchanged.
- Immediate termination upon goal completion.

### Phase 10: Extension Integration & Provider Switching
- Add `PLANNER_MODE` setting (`'local'` vs `'cloud'`) in `extension/providers/` and `SessionStore`.
- Update `extension/v2-task.js` to route via `DecisionRouter` when `PLANNER_MODE=local`.
- Rebuild bundles with `npm run build:ext`.

### Phase 11: Performance Benchmarks & Documentation
- Measure real latencies, token consumption, CPU/RAM usage, and completion rates.
- Update `docs/PERFORMANCE.md` and `README.md`.

---

## 4. Verification & Testing Strategy
1. **Existing Test Suite Integrity**: All 164 existing tests must remain 100% passing at every phase.
2. **New Modular Unit Tests**:
   - `page-state.test.mjs`
   - `local-qwen.test.mjs`
   - `ui-grounding.test.mjs`
   - `decision-router.test.mjs`
   - `v2-integration.test.mjs`
3. **Multi-Site Generic Validation**: Test across diverse page structures without website-specific selectors or rules.
4. **Build Verification**: Run `npm run build:ext` and `npm run build` at every milestone.
