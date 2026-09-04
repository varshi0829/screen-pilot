# Qwen Structured Planner Specification

## 1. Overview
The Qwen Structured Planner executes as Layer 3 of the ScreenPilot V2 hierarchy.

Instead of outputting long, fragile multi-step plans (e.g. 5–10 steps in advance), the Qwen Structured Planner produces **exactly ONE action per cycle**:

$$\text{Observe} \longrightarrow \text{Reason} \longrightarrow \text{ONE Action} \longrightarrow \text{Execute} \longrightarrow \text{Verify} \longrightarrow \text{Repeat}$$

---

## 2. Input Structure

Qwen receives compact structured JSON containing:
- `goal`: User task
- `page`: Compact normalized page state (`url`, `title`, `elements`)
- `history`: Last 3 completed steps (`action`, `elementId`, `result`)

Raw full HTML and excessive screenshot payloads are omitted during text-based page planning.

---

## 3. Output Schema & Action Types

Qwen is constrained to emit JSON matching the strict schema:

```json
{
  "action": "click",
  "elementId": "el_17",
  "text": "Search",
  "value": null,
  "confidence": 0.92,
  "reason": "Target search input field."
}
```

### Safety Constraints:
- Arbitrary code execution (`eval`, `script`) is prohibited.
- Unrestricted browser actions are blocked.
- Output schema validation rejects any response missing required fields.
