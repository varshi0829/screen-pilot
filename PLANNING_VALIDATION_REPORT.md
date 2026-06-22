# PLANNING_VALIDATION_REPORT.md

Status: TEMPLATE — fill in after running validation tasks  
Phase: 1 — Validate Multi-Step Planning  
Date: 2026-06-22

---

## Hypothesis

Multi-step planning (Gemini generates a full plan on the first call; subsequent steps execute via DOM matching) reduces Gemini API calls per task by 60–80% compared to the baseline (one Gemini call per user click).

**Do not claim this until this report is filled in.**

---

## Baseline (Pre-Planning)

> Fill in before running validation. Use git history to check out commit `1ca1433` (before planning was added) and run the same tasks.

| Site | Task | Steps Taken | Gemini Calls | Completed? |
|---|---|---|---|---|
| Gmail | Create and send an email | — | — | — |
| Google Docs | Change the document font size | — | — | — |
| GitHub | Create a new issue | — | — | — |
| Jira | Move a ticket to In Progress | — | — | — |
| Notion | Create a new page | — | — | — |
| LinkedIn | Send a connection request | — | — | — |
| Linear | Create a new issue with a label | — | — | — |
| Unknown site | (your choice) | — | — | — |

**Baseline average Gemini calls per task**: —

---

## Results (With Planning)

> Fill in after running the same tasks with the current extension. The Analytics popup will show exact numbers.

| Site | Task | Plan Steps | Plan Hits | Plan Misses | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|
| Gmail | Create and send an email | — | — | — | — | — | |
| Google Docs | Change the document font size | — | — | — | — | — | |
| GitHub | Create a new issue | — | — | — | — | — | |
| Jira | Move a ticket to In Progress | — | — | — | — | — | |
| Notion | Create a new page | — | — | — | — | — | |
| LinkedIn | Send a connection request | — | — | — | — | — | |
| Linear | Create a new issue with a label | — | — | — | — | — | |
| Unknown site | (your choice) | — | — | — | — | — | |

---

## KPIs (from Analytics popup)

| Metric | Observed | Healthy Threshold | Status |
|---|---|---|---|
| Plan Success Rate | — | ≥ 60% | — |
| Gemini Calls / Task | — | ≤ 2.0 | — |
| Task Completion Rate | — | ≥ 70% | — |
| Cache Hit Rate | — | ≥ 30% | — |
| Fallback Rate | — | ≤ 40% | — |

---

## Actual Gemini Call Reduction

```
Reduction = (baseline - observed) / baseline × 100%
         = (__ - __) / __ × 100%
         = __%
```

---

## Failure Analysis

> For each plan step failure (logged in DevTools as `[Plan] Step N not found`), document:

| Site | Step Description | Expected Element | Actual DOM State | Root Cause |
|---|---|---|---|---|
| | | | | |

---

## Common Failure Patterns

> After running 5+ tasks, look for patterns in failures:

- [ ] SPA navigation: element not yet in DOM when plan tries to match it
- [ ] Gemini hallucinated element text that doesn't match actual DOM text
- [ ] Score threshold (70) too high for elements with slight text variations
- [ ] Plan step ordering wrong (Gemini predicted step 3 before step 2 is possible)
- [ ] Multi-modal elements (icon buttons with no text label)

---

## Risks Identified

> Fill in after validation:

1. (none yet)

---

## Decision

> After filling in this report, answer:

**Does multi-step planning actually reduce Gemini calls?**

- [ ] Yes, by ≥ 50% — proceed to Phase 2 (cost optimisation)
- [ ] Yes, but < 50% — investigate failure patterns before optimising
- [ ] No improvement — audit DOMMatcher scoring and plan prompt quality

**Is the plan quality sufficient?**

- [ ] Plans generated are accurate and match actual DOM flow
- [ ] Plans are too optimistic (predict steps that aren't present)
- [ ] Plans are too conservative (generate only 1–2 steps, no savings)

---

## How to Run Validation

1. Load the extension: `chrome://extensions/ → Load unpacked → select extension/`
2. Open any target site (e.g. GitHub)
3. Click the ScreenPilot icon → type a goal → press Go
4. Watch DevTools console for `[Plan]` log lines
5. After 5–10 tasks, open popup → Analytics tab
6. Screenshot the KPI grid and paste into this report
7. Export raw data (optional): `chrome.storage.local.get('screenpilot_analytics', console.log)` in extension DevTools background page console

---

## Raw Data Export

```jsonc
// Paste output of:
// chrome.storage.local.get('screenpilot_analytics', d => console.log(JSON.stringify(d, null, 2)))
// (run in chrome://extensions/ → background service worker → Console)
```
