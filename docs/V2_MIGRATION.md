# ScreenPilot V2 — Migration Guide

## 1. Overview
ScreenPilot V2 replaces cloud-dependent Gemini/OpenRouter LLM calls with a **local-first, 3-tier hierarchical decision architecture**.

---

## 2. Architectural Comparison

```
OLD V1 ARCHITECTURE:
Browser → Full Screenshot → Cloud API (Gemini/OpenRouter) → Verbose Multi-Step Plan → Execution → Repeat (20-30s)

NEW V2 ARCHITECTURE:
Browser → DOM Extraction → Fast Decision Layer (Deterministic / Small ML) → Direct Execution (<15ms)
                                                                 ↓ (If Low Confidence)
                                                       Local Qwen (Ollama) → 1-Action JSON (~1.5-2.5s)
                                                                 ↓
                                                       Execute & Verify (150ms condition-based)
```

---

## 3. Key Differences
1. **Zero Cloud Dependency**: Runs completely offline using Ollama + `qwen2.5-coder:7b`.
2. **1-Action Iterative Planning**: Evaluates 1 action per iteration instead of static multi-step plans.
3. **Layered Cascade**: Fast Path & Small ML Grounding handle 40-70% of actions instantly (<15ms).
4. **Warm Model Execution**: Ollama `keep_alive: "5m"` eliminates repeated 9.5s model loading overhead.
