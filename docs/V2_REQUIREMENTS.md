# ScreenPilot V2 Requirements Document

## 1. Functional Requirements

### 1.1 Local-First Execution
- ScreenPilot V2 MUST execute browser automation tasks locally without requiring cloud API keys or external LLM connections when `PLANNER_MODE = 'local'`.
- Must interface with Ollama running locally at `http://127.0.0.1:11434` using `qwen2.5-coder:7b`.

### 1.2 Website Agnostic Behavior
- The system MUST operate dynamically on arbitrary, unseen websites.
- Hardcoded domain checks (`if (github.com)`), website-specific selectors, site-specific XPaths, or hardcoded button names are strictly prohibited.

### 1.3 3-Tier Decision Hierarchy
- **Tier 1 (Fast Path)**: Deterministic label/role matching via `DOMMatcher` (<5ms).
- **Tier 2 (Small ML Grounding)**: UI element ranking scorer (<15ms).
- **Tier 3 (Local Qwen Fallback)**: Structured 1-action LLM output (~1.5–2.5s).

### 1.4 1-Action-at-a-Time Planning
- The planner MUST generate exactly ONE action per loop iteration (`Observe -> Action -> Execute -> Observe -> Verify`).

### 1.5 Stale Plan & Loop Prevention
- Pre/post page snapshot comparison MUST discard stale in-flight plans if `urlChanged || domChanged`.
- Action deduplication MUST block repeated execution of identical actions when page state is unchanged.

---

## 2. Non-Functional Requirements
- **Latency**: First action <0.5s on Fast Path, <2.5s on Qwen path.
- **RAM Footprint**: Under 5 GB total memory (Ollama quantized GGUF + Chrome extension).
- **Security**: No API keys, credentials, or cookies exposed or printed to logs.
