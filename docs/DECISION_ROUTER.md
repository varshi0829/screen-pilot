# Decision Router Specification

## 1. Overview
The `DecisionRouter` is the control center of ScreenPilot V2. It evaluates incoming tasks against extracted page states and decides which layer of the hierarchy to invoke:

1. **Fast Local Path** (Deterministic Matcher)
2. **Small ML Model** (UI Grounding Scorer)
3. **Local Qwen Planner** (Ollama Fallback)

---

## 2. Decision Cascade & Thresholds

```javascript
const DETERMINISTIC_THRESHOLD = 0.85;
const ML_GROUNDING_THRESHOLD  = 0.70;
```

### Flow Logic:
```
1. Run Fast Local Path (Deterministic DOMMatcher)
   ├── Score >= 0.85 → Route to EXECUTOR immediately (Fast Path)
   └── Score < 0.85  → Proceed to Step 2

2. Run Small ML Grounding Model
   ├── Score >= 0.70 → Route to EXECUTOR (Grounding Path)
   └── Score < 0.70  → Proceed to Step 3

3. Fall back to Local Qwen Planner (Ollama qwen2.5-coder:7b)
   └── Emit 1-Action JSON → Route to EXECUTOR
```

---

## 3. Configurable Parameters

| Parameter | Default Value | Description |
| :--- | :--- | :--- |
| `DETERMINISTIC_THRESHOLD` | `0.85` | Confidence required to bypass ML/LLM entirely |
| `ML_GROUNDING_THRESHOLD` | `0.70` | Confidence required to execute Layer 2 ML grounding |
| `QWEN_TIMEOUT_MS` | `10000` | Abort ceiling for local Qwen inference |
| `MAX_REPLAN_ATTEMPTS` | `12` | Task budget ceiling before declaring stuck |
