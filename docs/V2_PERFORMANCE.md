# ScreenPilot V2 — Performance & Telemetry Specification

## 1. Performance Objectives

ScreenPilot V2 prioritizes local execution speed, zero cloud dependency, and low latency across the 3-tier hierarchy:

1. **Layer 1 — Fast Local Path**: <5ms
2. **Layer 2 — Small ML Grounding Model**: <15ms
3. **Layer 3 — Local Qwen Fallback (Warm)**: ~1.5s–2.5s (Ollama `qwen2.5-coder:7b`)

---

## 2. Telemetry Format (`[SP:V2:PERF]`)

ScreenPilot V2 logs performance metrics to the console for telemetry tracking:

```
[SP:V2:PERF] domMs=3 decisionMs=1 layer=deterministic totalPlanningMs=4
[SP:V2:PERF] qwenLatencyMs=1850 model=qwen2.5-coder:7b keep_alive=5m
```

---

## 3. Comparative Benchmarks: V1 (Cloud) vs V2 (Local-First)

| Phase | V1 (Cloud LLM) | V2 (Local-First Fast Path) | V2 (Local Qwen Warm) |
| :--- | :--- | :--- | :--- |
| **DOM Extraction** | ~120ms | ~3ms | ~3ms |
| **Planning / LLM Latency** | 20,000ms – 30,000ms | **<1ms** | **1,500ms – 2,500ms** |
| **Post-Action Verification** | 600ms (Fixed sleep) | **<150ms** (Condition-based) | **<150ms** (Condition-based) |
| **Total Action Cycle** | ~21,000ms – 31,000ms | **~150ms – 200ms** | **~1,700ms – 2,800ms** |
| **Cloud API Cost** | $0.002 – $0.01 per step | **$0.00 (Zero)** | **$0.00 (Zero)** |
