# ScreenPilot V2 — Local-First Hierarchical Browser Agent

ScreenPilot is a Chrome extension that guides a user through any web app step by step — it observes the live page, decides the next single action toward a stated goal, and highlights exactly what to click. No chat interface, no per-site configuration, no hardcoded workflows.

V2 evolves the project into a **local-first, hierarchical browser agent**: instead of sending every webpage and interaction to cloud LLM providers, it routes each decision through a 3-tier local cascade — deterministic matching, then a small local ranking model, then a locally-hosted LLM — for zero API cost, instant response times, full privacy, and offline operation, only escalating to cloud when local resolution isn't available.

**→ See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical breakdown** (decision cascade, core components, and the specific failure modes each safeguard exists to prevent).

---

## 🚀 How V2 Local Hierarchy Works

```
                         USER GOAL
                             ↓
              PAGE STATE EXTRACTION (Generic Normalized JSON)
                             ↓
               ┌───────────────────────────┐
               │ 1. FAST LOCAL PATH        │
               │ Deterministic DOMMatcher  │ (<5ms)
               └─────────────┬─────────────┘
                             ↓
                      Confidence High? (>= 0.85)
                        /         \
                      YES           NO
                       ↓             ↓
                   [EXECUTE]   ┌───────────────────────────┐
                               │ 2. SMALL UI GROUNDING MODEL│
                               │ Feature/Relevance Scorer  │ (<15ms)
                               └─────────────┬─────────────┘
                                             ↓
                                      Confidence High? (>= 0.70)
                                        /         \
                                      YES           NO
                                       ↓             ↓
                                   [EXECUTE]   ┌───────────────────────────┐
                                               │ 3. LOCAL QWEN PLANNER     │
                                               │ Ollama qwen2.5-coder:7b   │ (~1.5s–2.5s)
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
                                                      Goal Complete?
                                                        /         \
                                                      YES           NO
                                                       ↓             ↓
                                                    [DONE]      [REPLAN 1-ACTION]
```

---

## 🎯 Core Features of ScreenPilot V2

- **Local-First & Offline Capable**: Runs locally using Ollama (`qwen2.5-coder:7b`) with zero cloud dependencies when `PLANNER_MODE = 'local'`.
- **Website-Agnostic**: Operates dynamically on arbitrary, unseen websites without hardcoded selectors, URLs, or domain rules.
- **1-Action Iterative Planning**: Evaluates 1 action per iteration to prevent stale multi-step plan execution.
- **Stale Plan Protection**: Pre/post DOM snapshot comparison (`preSnap` vs `postSnap`) automatically aborts stale in-flight requests.
- **Condition-Based Verification**: Post-action state verification uses 150ms condition-based polling instead of fixed sleeps.

---

## 🛠 Local Setup & Running

### 1. Prerequisites
- **Node.js**: v18+ (tested on v22.18.0)
- **Local LLM Runtime**: [Ollama](https://ollama.com/) running at `http://127.0.0.1:11434`
- **Downloaded Model**: `ollama pull qwen2.5-coder:7b`

### 2. Build Extension Bundles & Run Tests
```bash
# Install dependencies
npm install

# Run unit test suite (252 tests passing)
node --test extension/tests/*.test.mjs

# Build Chrome Extension bundles
npm run build:ext

# Next.js app build
npm run build
```

### 3. Load the Extension in Chrome
1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory.
3. Click the ScreenPilot icon on any tab, type a goal (e.g. "search for wireless headphones"), and it highlights the next action.

---

## 📚 Documentation Index (`docs/`)

- [Architecture Overview](ARCHITECTURE.md) — start here
- [V2 Architecture Specification](docs/V2_ARCHITECTURE.md)
- [V2 Implementation Plan & Audit Report](docs/V2_IMPLEMENTATION_PLAN.md)
- [V2 Functional Requirements](docs/V2_REQUIREMENTS.md)
- [Local Qwen Integration Guide](docs/V2_LOCAL_QWEN.md)
- [Page State Representation Schema](docs/PAGE_STATE.md)
- [UI Grounding & Ranking Model Specification](docs/UI_GROUNDING_MODEL.md)
- [Decision Router Specification](docs/DECISION_ROUTER.md)
- [Qwen 1-Action Planner Specification](docs/QWEN_PLANNER.md)
- [Execution & Verification Engine Specification](docs/EXECUTION_AND_VERIFICATION.md)
- [Goal Verification & Contract Gate Specification](docs/GOAL_VERIFICATION.md)
- [Performance & Benchmarking Methodology](docs/V2_PERFORMANCE.md)
- [Testing & Quality Assurance Guide](docs/V2_TESTING.md)
- [V1 to V2 Migration Guide](docs/V2_MIGRATION.md)
- [V2 Changelog](docs/V2_CHANGELOG.md)
- [Historical / superseded docs](docs/archive/)
