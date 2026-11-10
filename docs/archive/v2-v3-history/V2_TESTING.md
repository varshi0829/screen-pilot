# ScreenPilot V2 — Testing Specification

## 1. Overview
ScreenPilot V2 includes comprehensive unit and integration tests covering all components of the local-first hierarchical architecture.

---

## 2. Test Matrix

| Test Suite | File Path | Focus |
| :--- | :--- | :--- |
| **Page State Extraction** | `extension/tests/page-state.test.mjs` | Generic normalized element extraction, ARIA role mapping |
| **Small ML Grounding** | `extension/tests/ui-grounding.test.mjs` | Feature-vector scoring, element ranking |
| **Local Qwen Adapter** | `extension/tests/local-qwen.test.mjs` | Ollama connection, 1-action JSON parser, timeout/abort handling |
| **Decision Router** | `extension/tests/decision-router.test.mjs` | 3-tier routing, confidence thresholds |
| **V2 Integration** | `extension/tests/v2-integration.test.mjs` | End-to-end local cascade, goal verifier exit, malformed response recovery |
| **Safeguards & Optimization** | `extension/tests/optimization.test.mjs` | Stale plan protection, cancellation, multi-site generic verification |
| **State Progression** | `extension/tests/state-progression.test.mjs` | Session state transitions, deduplication |
| **Workflows** | `extension/tests/workflows.test.mjs` | Generic multi-site workflow assertions |

---

## 3. Running All Tests
```bash
node --test extension/tests/*.test.mjs
```
*Current Pass Rate*: **100% (179 / 179 passing)**.
