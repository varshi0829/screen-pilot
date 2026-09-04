# Migration Guide: V1 to V2 Architecture

## 1. Executive Summary
ScreenPilot V2 introduces a local-first, hierarchical browser agent architecture.

To maintain system stability and prevent breaking existing deployments, V2 preserves V1 cloud backend capabilities (`VercelBackendAdapter`) behind a flexible `PLANNER_MODE` provider abstraction.

---

## 2. Configuration & Provider Switching

The active planning mode is controlled via `PLANNER_MODE` in configuration / `SessionStore`:

```javascript
// PLANNER_MODE Options:
// 'local' -> Uses Local-First Hierarchical Decision Cascade (Deterministic -> ML Grounding -> Local Qwen)
// 'cloud' -> Uses V1 Vercel Backend Proxy (/api/plan -> OpenRouter / Gemini)
```

### 2.1 Default Setting
- Default in V2 development: `PLANNER_MODE = 'local'`
- Cloud fallback is preserved for fallback scenarios or remote key usage.

---

## 3. Key Differences: V1 vs V2

| Dimension | V1 (Cloud Architecture) | V2 (Local-First Hierarchical) |
| :--- | :--- | :--- |
| **Inference Location** | Vercel Serverless / OpenRouter | Local Ollama Server (`127.0.0.1:11434`) |
| **Planning Horizon** | Multi-step plan upfront | **1-action-at-a-time** iterative loop |
| **Decision Flow** | Send every page to Cloud LLM | Fast Local Path → ML Scorer → Local Qwen |
| **Payload Size** | Full screenshot + long prompt | Normalized page-state JSON |
| **Latency** | 20–30 seconds | **1.5–3.5 seconds** |
| **Network Reliance** | Required | **Offline-capable** |
