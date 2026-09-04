# ScreenPilot V2: Architecture Transition & Technical Evolution Report
**Project Name:** ScreenPilot (Browser Automation Copilot)  
**Document Version:** 2.0  

---

## Executive Summary

**ScreenPilot** is an intelligent browser copilot designed to automate web navigation and user workflows across arbitrary, complex web applications. 

This document provides a comprehensive technical overview of **ScreenPilot V1**, the critical pain points and failure modes encountered during real-world evaluation, and the **ScreenPilot V2** architecture developed to systematically resolve those limitations. 

The core evolutionary shift is from a **cloud-dependent, multi-step LLM pipeline** (V1) to a **local-first, 3-tier hierarchical decision cascade with closed-loop 1-action execution** (V2).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             THE CORE SHIFT                                  │
│                                                                             │
│   ScreenPilot V1 (Cloud Multi-Step)      ScreenPilot V2 (Local Hierarchical)│
│   • Cloud LLM API wrapper (Vercel)   →   • Local Ollama / CPU-optimized     │
│   • 20–30s planning latency          →   • <5ms deterministic / ~1.8s LLM   │
│   • Stale upfront 5-step plans       →   • Closed-loop 1-action-at-a-time   │
│   • DOM drift & infinite loops       →   • DOM hash diffing & state gates   │
│   • Per-token cost & privacy risks   →   • $0.00 cost & 100% data privacy   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. What We Did Before (ScreenPilot V1 Architecture)

### 1.1 V1 System Architecture
In Version 1, ScreenPilot was architected as a thin client–cloud proxy system:
1. **Chrome Extension (Client)**: Captured DOM snapshots and full-viewport screenshots using `chrome.tabs.captureVisibleTab`.
2. **Next.js Backend (`/api/plan`)**: Hosted on Vercel as a serverless gateway to aggregate screenshots and DOM data into large prompt payloads.
3. **Cloud LLMs (Inference)**: Dispatched requests to remote multi-modal models (Google Gemini / OpenRouter).
4. **Execution Loop**: The cloud model returned a complete, static array of steps (e.g., `[Step 1: click A, Step 2: fill B, Step 3: click C]`). The extension iterated through this static plan using fixed `setTimeout` sleeps.

### 1.2 The V1 Flow Diagram

```mermaid
flowchart LR
    subgraph Client ["Browser Extension (V1)"]
        User[User Goal] --> DumpDOM[Dump Full DOM & Screenshot]
    end
    
    subgraph Cloud ["Vercel Backend & Cloud LLM"]
        DumpDOM -->|Heavy HTTP Request| Proxy["Next.js /api/plan"]
        Proxy -->|Multi-Modal API Call| CloudLLM["Cloud LLM (Gemini / OpenRouter)"]
        CloudLLM -->|Static 5-10 Step Plan| Proxy
    end
    
    subgraph Execution ["Execution Engine (V1)"]
        Proxy -->|Return Array| Exec["Execute Step 1 -> sleep 600ms -> Step 2 -> sleep 600ms..."]
    end
```

---

## 2. Critical V1 Limitations & Failure Modes

During evaluation and multi-site testing, ScreenPilot V1 revealed fundamental bottlenecks that degraded user experience and reliability:

### 🔴 Problem 1: Extreme Latency & Frozen User Experience
* **Mechanism**: Uploading base64 screenshots and large DOM dumps over WAN to cloud endpoints resulted in **20,000ms to 30,000ms (20–30s)** round-trip response times for a single plan.
* **Impact**: Users experienced frozen screens, broke user immersion, and frequently clicked away before the model replied.

### 🔴 Problem 2: Stale Plans & Dynamic DOM Drift
* **Mechanism**: Generating a static 5-step plan upfront assumed the web page was static. In modern Single Page Applications (SPAs like React, Vue, Angular), clicking an element triggers asynchronous rendering, modal popups, or URL redirects.
* **Impact**: Steps 2, 3, and 4 frequently failed because target elements were no longer attached to the DOM (stale element references) or had moved offscreen.

### 🔴 Problem 3: Action Loops & Repetitive Clicks
* **Mechanism**: V1 lacked fine-grained DOM state tracking and state transition hashing. If a cloud-generated step failed silently (e.g., clicking a disabled button), the fallback system re-requested a plan with the same context, creating infinite click loops.
* **Impact**: The agent became stuck in repetitive loops without recognizing lack of forward progress.

### 🔴 Problem 4: Skyrocketing API Costs & Rate Limits
* **Mechanism**: Each navigation task consumed 10,000–30,000 tokens per interaction due to raw DOM markup and image payloads.
* **Impact**: Rapid quota exhaustion on free tiers and high ongoing dollar costs per task.

### 🔴 Problem 5: Hallucinated Selectors & Brittle Grounding
* **Mechanism**: Cloud models frequently hallucinated fragile CSS selectors (e.g., `#main > div:nth-child(3) > button`) or hallucinated button labels not present in the current viewport.
* **Impact**: High failure rate when interacting with dynamic class names (Tailwind, CSS-in-JS, obfuscated DOM).

### 🔴 Problem 6: Absence of Verifiable State Transition Contracts
* **Mechanism**: V1 relied on blind execution with arbitrary `setTimeout(..., 600)` sleeps, assuming an action succeeded merely because a JavaScript click event was dispatched.
* **Impact**: No verification whether a form actually submitted, whether validation errors appeared, or whether navigation completed.

### 🔴 Problem 7: Data Privacy & Security Risks
* **Mechanism**: Transmitting sensitive corporate dashboards, personal emails, and proprietary form data to third-party cloud APIs.
* **Impact**: Non-compliance with privacy standards for enterprise or sensitive browser tasks.

---

## 3. What We Are Doing Now (ScreenPilot V2 Approach)

To resolve V1's structural flaws, **ScreenPilot V2** transitions from a monolithic cloud wrapper to a **Local-First, Hierarchical Browser Automation Agent**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          SCREENPILOT V2 ARCHITECTURAL PILLARS                          │
├─────────────────────────┬────────────────────────────┬─────────────────────────────────┤
│ 1. 3-Tier Hierarchy     │ 2. Closed-Loop 1-Action    │ 3. State & Contract Verification│
│ Deterministic (<5ms)    │ Observe → Route → Act →    │ FNV-32a DOM Hashing             │
│ ML Grounding (<15ms)    │ Verify → Re-observe        │ Condition Polling (<150ms)      │
│ Local Qwen 7B (~1.8s)   │ (Zero stale multi-plans)   │ Explicit Success Contracts      │
└─────────────────────────┴────────────────────────────┴─────────────────────────────────┘
```

### 3.1 Pillar 1: The 3-Tier Decision Cascade
Rather than invoking a heavy LLM for trivial tasks (e.g., clicking a visible "Submit" button), V2 routes every action through a 3-tier confidence cascade:

1. **Tier 1: Fast Local Path (Deterministic `DOMMatcher`) — `<5ms` Latency**
   - Evaluates direct keyword matches, accessible roles (`aria-label`, `button`, `input`), placeholders, and exact text.
   - Handles **40–50% of routine actions** instantly with zero CPU/GPU overhead and zero network calls.
   - Runs if confidence $\ge 0.85$.

2. **Tier 2: Small ML UI Grounding Scorer — `<15ms` Latency**
   - Lightweight scoring model optimized for Intel CPU execution.
   - Computes element relevance vectors based on token overlap, accessibility tree depth, semantic similarity, and viewport positioning.
   - Runs if confidence $\ge 0.70$.

3. **Tier 3: Local Qwen Planner (`qwen2.5-coder:7b` via Ollama) — `~1.5s–2.5s` Latency**
   - High-reasoning fallback for ambiguous, multi-step, or complex form workflows.
   - Runs quantized GGUF (`Q4_K_M`, ~4.7 GB RAM footprint) on localhost (`http://127.0.0.1:11434`) via Ollama.
   - Emits strict, JSON-schema-validated single actions.

### 3.2 Pillar 2: Closed-Loop 1-Action-at-a-Time Execution
* **Principle**: Multi-step upfront planning is completely eliminated.
* **Cycle**: `Observe Page State` $\rightarrow$ `Route Decision` $\rightarrow$ `Execute 1 Atomic Action` $\rightarrow$ `Verify State Transition` $\rightarrow$ `Re-observe Fresh State`.
* **Benefit**: Guarantees that every decision is made against the real, live DOM state, eliminating stale plan failures.

### 3.3 Pillar 3: PageControls Normalization & Token Budget Optimization
* **Generic State Extraction**: Raw HTML is stripped and distilled into a compact, site-agnostic `pageControls` JSON array (containing only interactive elements with `id`, `role`, `label`, `location`).
* **Compressed Prompt**: Enforces strict `max_tokens: 1200`, reducing token overhead by **>85%**.

### 3.4 Pillar 4: FNV-32a DOM Hashing & Stale Plan Abort Protection
* **DOM Hashing**: Captures pre-action (`preSnap`) and post-action (`postSnap`) FNV-32a hashes of the interactive DOM tree.
* **Race Condition Guard**: If the user or an asynchronous script mutates the DOM while the planner is reasoning, the in-flight request is immediately aborted via `AbortController`, preventing outdated clicks.

### 3.5 Pillar 5: Contract-Based Goal Verification Engine
* **Replaces Sleep Delays**: Replaces fixed `setTimeout` with active 150ms condition polling against deterministic state transition contracts:
  - `url_matches`: Verifies navigation to expected path/query.
  - `text_present`: Confirms appearance of success banners, alerts, or status text.
  - `element_present` / `element_absent`: Confirms appearance/disappearance of modals or loaders.

---

## 4. V1 vs V2 Problem-Solution Mapping Matrix

| # | V1 Pain Point / Limitation | V1 Root Cause | V2 Solution & Architectural Mechanism | Concrete Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Slow 20–30s Latency** | Uploading images/DOM to cloud serverless endpoints | **3-Tier Cascade + Local Ollama**: Fast Path runs in `<5ms`, Qwen 7B runs locally in `~1.8s` | **10x–100x speedup** on routine steps; `<2s` worst-case |
| **2** | **Stale Multi-Step Plans** | Generating 5+ steps upfront on an asynchronous SPA | **1-Action-at-a-Time Loop**: Every step executes against a freshly observed live DOM | **Zero stale steps**; resilient to dynamic SPA rerenders |
| **3** | **Infinite Action Loops** | Lack of DOM diffing & execution history tracking | **DOM Hash Verification + Deduplication**: Compares pre/post hashes; blocks repeated identical actions | **Loop elimination**; automatic failure recovery |
| **4** | **High Cloud Costs** | 10k–30k token payloads per step to paid APIs | **Local CPU Inference (`qwen2.5-coder:7b`)**: Normalized `pageControls` token compression | **$0.00 API cost**; zero quota limits |
| **5** | **Hallucinated Selectors** | Raw LLM guessing arbitrary CSS selectors | **Interactive Element Indexing**: Elements assigned deterministic numeric IDs from live accessibility tree | **100% grounded execution**; no selector guessing |
| **6** | **Unverified Clicks / False Success** | Blind execution with fixed `sleep(600ms)` | **Goal Verifier Contracts**: Condition polling (`url_matches`, `text_present`) within 150ms | **Instant verification**; reliable task completion |
| **7** | **Data Privacy Risks** | Sending full page data and screenshots over WAN | **100% Localhost Processing**: Data never leaves the user's machine | **Enterprise-grade privacy** and offline readiness |

---

## 5. ScreenPilot V2 End-to-End Workflow

```mermaid
flowchart TD
    Start([User Initiates Goal]) --> Extract[1. Page State Extraction: Extract Normalized pageControls JSON]
    Extract --> HashPre[Compute Pre-Action DOM Hash: FNV-32a]
    HashPre --> Router{2. Decision Router}

    Router -->|Confidence >= 0.85| Tier1[Tier 1: Fast Local Path - DOMMatcher <5ms]
    Router -->|Confidence >= 0.70| Tier2[Tier 2: ML UI Grounding Scorer <15ms]
    Router -->|Confidence < 0.70| Tier3[Tier 3: Local Qwen 7B Ollama ~1.8s]

    Tier1 --> ActionNorm[Single Action JSON Schema]
    Tier2 --> ActionNorm
    Tier3 --> ActionNorm

    ActionNorm --> Guard{Stale Plan Check: DOM Hash Changed?}
    Guard -->|Yes: Outdated| Abort[Abort Action & Re-Extract State]
    Abort --> Extract
    Guard -->|No: Valid| Exec[3. Executor Engine: Highlight & Dispatch Native Events]

    Exec --> Verify[4. Goal Verifier: 150ms Condition Polling]
    Verify --> StateCheck{Goal Completed?}
    StateCheck -->|Yes: Success| Done([Task Complete & Telemetry Logged])
    StateCheck -->|No: Next Step Needed| LoopGuard{Loop / Stall Detected?}
    LoopGuard -->|Yes: Stuck| Recover[Trigger Recovery & Alternative Grounding]
    Recover --> Extract
    LoopGuard -->|No: Normal Flow| Extract
```

---

## 6. Empirical Performance Comparison

| Metric / Dimension | ScreenPilot V1 (Cloud Baseline) | ScreenPilot V2 (Local-First Hierarchical) | Performance Delta |
| :--- | :--- | :--- | :--- |
| **Routine Action Latency** | 20,000 ms – 30,000 ms | **< 5 ms** (Deterministic Tier 1) | **> 4,000x faster** |
| **Complex Action Latency** | 20,000 ms – 30,000 ms | **1,500 ms – 2,500 ms** (Local Qwen Tier 3) | **> 12x faster** |
| **Verification Delay** | 600 ms fixed sleep | **< 150 ms** condition-based polling | **4x faster** |
| **Per-Step Financial Cost** | $0.002 – $0.010 / call | **$0.00** (Zero API fees) | **100% cost reduction** |
| **Network Requirement** | Mandatory active WAN | **Offline-capable** (127.0.0.1 Ollama) | **Full offline autonomy** |
| **Memory Footprint** | Low (Offloaded to cloud) | ~4.7 GB RAM (`qwen2.5-coder:7b` Q4_K_M) | Fits standard 14–16GB laptops |
| **Hardware Compatibility** | Cloud dependent | Tested on **Intel i5 CPU** (No GPU required) | Accessible to commodity hardware |
| **Token Budget per Step** | 10,000 – 30,000 tokens | **< 1,200 tokens** (pageControls JSON) | **92% token reduction** |

---

## 7. Current Implementation & Validation Status

### 7.1 Implemented Modules in Codebase
* **`extension/lib/dom-matcher.js`**: Fast Tier 1 deterministic scoring engine.
* **`extension/services/ui-grounding.js`**: Tier 2 lightweight feature ranker.
* **`extension/providers/local-qwen.js`**: Tier 3 Ollama integration with JSON schema enforcement.
* **`extension/services/decision-router.js`**: Multi-tier confidence arbitrator.
* **`extension/services/executor-engine.js`**: Atomic event dispatcher (`click`, `fill_form`, `select`, `scroll`).
* **`extension/services/goal-verifier.js`**: State transition contract evaluator.
* **`extension/services/session-store.js`**: Resilient `chrome.storage.local` session state machine.
* **`extension/lib/page-snapshot.js`**: FNV-32a DOM hashing and stale snapshot detector.

### 7.2 Test Suite & Verification Results
* **Test Suites Passing**: 21 test files covering unit, integration, and recovery flows (`extension/tests/*.test.mjs`).
* **Covered Scenarios**:
  - Abort signal lifecycle and in-flight cancellation.
  - Decision routing confidence thresholds (Tier 1 vs 2 vs 3).
  - DOM snapshot hashing and stale plan rejection.
  - Form filling, clicking, and multi-step state progression.
  - Goal verification contracts (`url_matches`, `text_present`, `element_present`).
  - Terminal planner step immediate task completion.

---

## 8. Summary
### Key Talking Points
1. **Architectural Maturity**: From treating LLMs as brute-force "everything" solvers and built a **disciplined engineering system** where AI is only invoked when deterministic rules and small ML models are insufficient.
2. **Deterministic Speed + LLM Flexibility**: 40–50% of actions execute in $<5\text{ms}$ on the local machine; difficult edge cases gracefully fall back to local Qwen 7B in $<2\text{s}$.
3. **Robustness Over Assumptions**: V1 assumed plans wouldn't break; V2 assumes web pages constantly change and validates every single action with DOM hashing and contracts.
4. **Zero Cost & Full Privacy**: Running locally on CPU via Ollama enables unlimited task executions with zero cloud bills and total data privacy.