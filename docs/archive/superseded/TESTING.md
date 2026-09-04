# Testing & Quality Assurance Specification

## 1. Overview
ScreenPilot V2 enforces rigorous unit and integration testing across all layers of the local-first hierarchical architecture.

---

## 2. Test Suites Overview

| Test Suite File | Scope | Target Layer |
| :--- | :--- | :--- |
| `extension/tests/dom-matcher.test.mjs` | DOMMatcher scoring & ranking | Layer 1 |
| `extension/tests/page-state.test.mjs` | Generic page state extraction | State Layer |
| `extension/tests/ui-grounding.test.mjs` | Small ML grounding model | Layer 2 |
| `extension/tests/local-qwen.test.mjs` | Local Qwen provider & JSON parser | Layer 3 |
| `extension/tests/decision-router.test.mjs` | 3-tier routing & threshold fallback | Decision Router |
| `extension/tests/executor-engine.test.mjs` | Action validation & DOM execution | Executor Engine |
| `extension/tests/goal-verifier.test.mjs` | Goal completion signals & early exit | Verifier Layer |
| `extension/tests/optimization.test.mjs` | Stale plan protection, cancellation, multi-site | System Safeguards |
| `extension/tests/state-progression.test.mjs` | Session state transitions | State Machine |
| `extension/tests/workflows.test.mjs` | End-to-end task workflows | Integration |

---

## 3. Running Tests
Run all unit test suites via:
```bash
node --test extension/tests/*.test.mjs
```
All tests must pass (`100% pass rate`) before any release.
