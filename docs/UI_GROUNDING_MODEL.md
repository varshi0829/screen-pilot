# UI Grounding & Ranking Model Specification

## 1. Overview
The **UI Grounding & Ranking Model** serves as Layer 2 in the ScreenPilot V2 decision hierarchy.

Its purpose is **UI element relevance scoring**:
Given a user's natural language intent and a set of candidate webpage elements, compute a confidence score for each candidate to identify the target element without invoking the heavy local LLM.

---

## 2. Model Input & Output

### Input
- `intent`: User target intent (e.g. `"search for laptops"` or `"open cart"`)
- `candidates`: Array of extracted page elements (`elementId`, `tag`, `role`, `text`, `placeholder`, `ariaLabel`, `region`)

### Output
Ranked list of candidate elements with computed confidence scores:

```json
[
  { "elementId": "el_2", "score": 0.94, "reasoning": "Exact keyword match in placeholder 'Search'" },
  { "elementId": "el_5", "score": 0.12, "reasoning": "Low text relevance" }
]
```

---

## 3. Feature Scoring Algorithm

The lightweight grounding scorer evaluates 5 generic feature vectors for each candidate element:

1. **Text & Placeholder Similarity ($S_{text}$)**: Token overlap and edit distance between intent tokens and element text/placeholder (weight: `0.35`).
2. **Accessible Name / ARIA Matching ($S_{aria}$)**: Token match against `aria-label`, `title`, and `img[alt]` (weight: `0.30`).
3. **Role & Action Compatibility ($S_{role}$)**: Compatibility between intent action verb (e.g. `type`, `click`, `select`) and DOM role/tag (weight: `0.15`).
4. **Viewport Visibility & Region Score ($S_{region}$)**: Priority for visible elements in `top_navigation`, `side_navigation`, or active `modal` (weight: `0.10`).
5. **Exact Substring / Synonym Boost ($S_{boost}$)**: Exact keyword match or domain-agnostic verb synonym boost (weight: `0.10`).

$$\text{Confidence Score} = 0.35 S_{text} + 0.30 S_{aria} + 0.15 S_{role} + 0.10 S_{region} + 0.10 S_{boost}$$

---

## 4. Hardware Efficiency & Execution
- **Runtime**: Pure JavaScript / local Node.js / browser environment (<15ms per page).
- **Memory**: <2 MB overhead.
- **CPU Footprint**: Zero heavy tensor allocations; executes on single thread without GPU.
