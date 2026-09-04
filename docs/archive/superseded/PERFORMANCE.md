# Performance & Benchmarking Specification

## 1. Overview
ScreenPilot V2 introduces empirical benchmarking to measure execution latency, local LLM evaluation time, token efficiency, and goal completion rates.

---

## 2. Benchmark Metrics

| Metric | Measurement Target | V1 (Cloud Baseline) | V2 (Local-First Target) |
| :--- | :--- | :--- | :--- |
| **First-Action Latency** | Time from task start to 1st action | 20–30s | **<0.5s (Fast) / <2.5s (Qwen)** |
| **Average Action Latency** | Time per execution step | ~12–25s | **<0.2s (Fast) / <2.0s (Qwen)** |
| **Local Qwen Inference** | Local LLM eval duration | N/A (Cloud) | **~1.5–2.5s** |
| **Small ML Grounding Inference** | Local UI element ranking time | N/A | **<15ms** |
| **Verification Delay** | Post-action DOM state check | 600ms sleep | **150ms max condition-based** |
| **Cloud API Calls** | External LLM requests per task | 1–5 calls | **0 calls (Local mode)** |
| **Memory Footprint** | Extension + local runtime RAM | ~80 MB | **~4.8 GB (Ollama + Ext)** |
| **CPU Usage** | Peak CPU utilization during eval | Minimal (Cloud) | **Moderate (~30–55% on i5)** |

---

## 3. Real Benchmark Methodology
Benchmarks are captured via `TelemetryService` and written directly to execution logs without synthetic or fabricated values.
