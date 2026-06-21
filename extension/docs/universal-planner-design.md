# ScreenPilot — Universal Planner Design

## Problem Statement

A site-specific planner is a dead end. Every new application requires a new classifier, a new priority table, and new maintenance burden. The goal is a single planning engine that works on any web UI without custom code.

## Architecture

```
Goal (user text)
    │
    ▼
Gemini Vision API  ←── Screenshot + Generic Prompt
    │
    │  Returns: candidates[] with generic action types and region types
    │
    ▼
UniversalPlanner (content script)
    │
    ├── For each candidate → DOMMatcher.matchElement()
    │
    ├── Computes 8 signals per candidate:
    │     geminiConfidence, domMatchScore, clickability,
    │     semanticSimilarity, visibility, actionTypeWeight,
    │     regionWeight, visualProminence
    │
    ├── Weighted score → ranked list
    │
    ▼
Best match → Highlighter (spotlight + ring + arrow + bubble)
```

## Universal Action Model

The planner classifies every UI element into **9 generic action types**. No application names appear anywhere.

| Type | Description | Examples across apps |
|------|-------------|---------------------|
| `primary_action` | Main call-to-action | Submit, Save, Create, Send, Post |
| `secondary_action` | Supporting / undo action | Cancel, Back, Reset, Dismiss |
| `navigation_action` | Moves between pages or sections | Tab, breadcrumb, sidebar link |
| `destructive_action` | Removes content | Delete, Archive, Trash, Remove |
| `menu_action` | Opens dropdown or popover | Any `aria-haspopup` element |
| `content_item` | Selectable data row | List item, card, table row |
| `input_field` | Accepts text input | `<input>`, `<textarea>`, `contenteditable` |
| `filter_control` | Search or filter | Search bar, filter dropdown, sort |
| `settings_control` | Configuration toggle | Checkbox, radio, switch |

## Generic Region Detection

Region detection uses only standard HTML semantics — `<nav>`, `<main>`, `<form>`, ARIA roles. No IDs, class names, or site-specific selectors.

| Region | Detection signal |
|--------|-----------------|
| `modal` | `role="dialog"` or `aria-modal="true"` |
| `form` | `<form>` or `role="form"` |
| `toolbar` | `role="toolbar"` |
| `main_content` | `<main>` or `role="main"` |
| `dropdown` | `role="menu"` or `role="listbox"` |
| `top_navigation` | `<nav>` or `role="navigation"` with left-edge > 160px |
| `side_navigation` | `<aside>`, `role="complementary"`, or left-edge nav ≤ 160px |
| `footer` | `<footer>` or `role="contentinfo"` |

## Planner Signal Weights

Each candidate is scored by a weighted sum of 8 signals. Weights are tuned once and apply everywhere.

| Signal | Weight | Source |
|--------|--------|--------|
| `geminiConfidence` | 0.30 | Gemini's self-reported confidence for this candidate |
| `domMatchScore` | 0.25 | DOMMatcher score (exact=1.0, fuzzy=0.6, synonym=0.8) |
| `clickability` | 0.15 | Element is natively interactive (button, a, input, contenteditable) |
| `semanticSimilarity` | 0.12 | Jaccard token overlap between element text and user goal |
| `visibility` | 0.08 | Element is in the viewport right now |
| `actionTypeWeight` | 0.05 | How likely this action type is to be the right next step |
| `regionWeight` | 0.03 | Modal and form regions rank above footer and side nav |
| `visualProminence` | 0.02 | Element area as fraction of viewport (larger = more prominent) |

**No score is ever hard-coded per application.** Every weight is computed from observable element properties.

## Fallback Chain

```
1. UniversalPlanner.selectBest(candidates[])   ← primary path
       ↓ (if no candidates[] or no DOM match)
2. DOMMatcher.matchElement(targetElement)       ← backward-compat fallback
       ↓ (if score below floor or ambiguous)
3. Error: "Could not locate element"
```

The fallback ensures backward compatibility when Gemini returns the old single-target schema instead of `candidates[]`.

---

## Cross-Application Worked Examples

The same planning engine, unchanged, handles all of these. The examples show what Gemini returns and how the planner scores it.

### YouTube — "Share this video"

**On screen:** Video player with Like, Dislike, Share, Save buttons below the title.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "Share", "actionType": "menu_action", "region": "main_content", "confidence": 0.95 },
    { "text": "Save", "actionType": "menu_action", "region": "main_content", "confidence": 0.40 }
  ]
}
```

**Planner scores "Share":**
- geminiConfidence=0.95, domMatchScore=1.00 (exact), clickability=1.0, semanticSimilarity=1.0 (token "share")
- **Final score: 0.94** → highlight the Share button

**No YouTube-specific code required.** The word "share" matches the goal via generic token similarity.

---

### GitHub — "Create a new issue"

**On screen:** Repository page with Code, Issues, Pull Requests tabs in top navigation.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "Issues", "actionType": "navigation_action", "region": "top_navigation", "confidence": 0.88 },
    { "text": "New issue", "actionType": "primary_action", "region": "main_content", "confidence": 0.92 }
  ]
}
```

**If on the issues list page, "New issue" is visible:**
- Planner scores it: domMatchScore=1.00, geminiConfidence=0.92, semanticSimilarity=0.67 ("new"+"issue" in goal)
- **Wins** → highlight "New issue" button

**If on the repo home page, only "Issues" tab is visible:**
- DOMMatcher finds "Issues" in top nav
- Planner scores it: navigation_action weight=0.75, visibility=1.0
- **Wins** → highlight "Issues" tab → next cycle finds "New issue"

No GitHub-specific routing code.

---

### Jira — "Create a story in the backlog"

**On screen:** Jira board with a "+ Create" button in the top toolbar and a backlog panel.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "Create", "actionType": "primary_action", "region": "toolbar", "confidence": 0.91 }
  ]
}
```

**Planner scores "Create":**
- primary_action weight=1.00, toolbar region weight=0.80, domMatchScore=1.00
- semanticSimilarity: "create" token matches "create a story" goal
- **Final score: 0.89** → highlight the Create button

The word "story" in the goal does not need a Jira classifier. The next step after clicking Create shows a modal form, which Gemini correctly classifies as `modal` + `input_field` elements.

---

### Notion — "Create a new page"

**On screen:** Sidebar with page list, a "+ New page" button at the bottom.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "New page", "actionType": "primary_action", "region": "side_navigation", "confidence": 0.93 },
    { "text": "Add a page", "actionType": "primary_action", "region": "side_navigation", "confidence": 0.75 }
  ]
}
```

**Planner scores "New page":**
- DOMMatcher finds it (exact match), geminiConfidence=0.93, clickability=1.0
- **Wins** → highlight it

If "New page" had a synonym in the SYNONYM_GROUPS table (`new`/`create`), DOMMatcher's synonym matching would also catch "Add a page" as an alternate — no Notion-specific code.

---

### Salesforce — "Create a new lead"

**On screen:** Salesforce Leads list view. "New" button in the toolbar. Table of existing leads below.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "New", "actionType": "primary_action", "region": "toolbar", "confidence": 0.90 },
    { "text": "Acme Corp", "actionType": "content_item", "region": "main_content", "confidence": 0.30 }
  ]
}
```

**Planner scores "New":**
- primary_action weight=1.00, toolbar region weight=0.80, geminiConfidence=0.90
- semanticSimilarity: "new" ∩ {"create","new","lead"} = 1 token → similarity > 0
- content_item "Acme Corp" scores low (actionTypeWeight=0.65, geminiConfidence=0.30)
- **"New" wins** → highlight the New button

Salesforce-specific Lightning component tags are irrelevant — DOMMatcher works on the rendered `<button>` or `[role="button"]` elements, not the web component wrapper.

---

### SAP Fiori — "Approve a purchase order"

**On screen:** SAP List Report with a table of purchase orders. Approve button in the toolbar above the table.

**Gemini returns:**
```json
{
  "candidates": [
    { "text": "Approve", "actionType": "primary_action", "region": "toolbar", "confidence": 0.94 },
    { "text": "PO-2024-001", "actionType": "content_item", "region": "main_content", "confidence": 0.55 }
  ]
}
```

**Planner scores "Approve":**
- primary_action weight=1.00, toolbar weight=0.80, geminiConfidence=0.94
- semanticSimilarity: "approve" ∩ {"approve","purchase","order"} = 1 token
- **Wins** → highlight Approve button

SAP's custom `ui5-button` and `sap-*` tag names don't matter — they render with standard ARIA roles (`role="button"`), which DOMMatcher's selectors already cover.

---

## Why This Works Without Custom Code

| Concern | How it's solved generically |
|---------|-----------------------------|
| "What website is this?" | Irrelevant. Gemini reads the screenshot and classifies by visible content. |
| "What does the Share button look like?" | DOMMatcher finds it by exact/fuzzy/synonym text match on any element with that label. |
| "Jira uses /issues, GitHub uses /issues" | URL routing is never parsed. The screenshot is the only source of truth. |
| "Salesforce Lightning has custom tags" | DOMMatcher queries by ARIA role and visible text, not HTML tag name. |
| "SAP uses German labels" | Gemini understands multiple languages. Token similarity works across languages. |
| "Notion's sidebar is a custom React tree" | Region detection uses `<aside>`/`role="complementary"`, not class names. |

## Signal Calibration

The 8 signal weights were chosen so:

1. **Gemini sees what humans see.** Its confidence (0.30 weight) dominates when it is certain, but DOM evidence (0.25) can override a hallucinated target.
2. **Non-interactive elements are naturally suppressed.** A `<div>` containing the right text scores 0.2 on clickability vs 1.0 for a `<button>`, pushing it below the threshold without any explicit filter.
3. **Modal/form context elevates relevant elements.** A "Submit" button inside a `modal` gets regionWeight=1.00, beating an identically-named button in a `footer` (regionWeight=0.30).
4. **The floor prevents garbage matches.** `MATCH_HARD_FLOOR = 40` (DOM score) rejects elements that only barely match in text.

## Telemetry Emitted

Every planning cycle logs a structured telemetry object for observability:

```javascript
// Universal Planner path
{ source: "universal-planner", actionType, region, score, signals, text }

// Fallback path
{ source: "dom-matcher-fallback", matchScore, matchType, ambiguous, delta, topCandidates, text }
```

This telemetry is sufficient to diagnose failures on any application without adding application-specific instrumentation.
