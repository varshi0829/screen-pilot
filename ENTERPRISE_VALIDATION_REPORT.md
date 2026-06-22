# ENTERPRISE_VALIDATION_REPORT.md

Status: TEMPLATE — fill in after running enterprise validation tasks  
Phase: 1–3 — Enterprise UI, Memory, Predictive Navigation  
Date: 2026-06-22

---

## What This Report Validates

1. **Enterprise app detection** — does `EnterpriseContextService.detect()` correctly identify the application, module, workspace, and page type?
2. **Navigation accuracy** — do plan steps succeed more often on enterprise UIs compared to consumer apps?
3. **Recovery effectiveness** — when plan steps fail, does the recovery tree find the element without Gemini?
4. **Memory learning** — after 2+ completions, does the second run avoid the initial Gemini call?
5. **Cost reduction** — what is the Gemini avoidance rate across enterprise tasks vs the baseline?

---

## How to Run Validation

1. Load the extension: `chrome://extensions/ → Load unpacked → select extension/`
2. Open DevTools → Background service worker → Console
3. For each test case:
   - Navigate to the target application
   - Open ScreenPilot (popup → Open ScreenPilot)
   - Enter the goal exactly as written
   - Observe console output: `[Memory]`, `[Plan]`, `[Perf]` log lines
4. After 5+ tasks: popup → Analytics tab → record KPIs
5. For memory validation: run the same goal twice; second run should log `[Memory] Hit`

---

## Enterprise App Detection Validation

Test by opening the app and running in DevTools console:

```javascript
// In the page's DevTools console (not background):
// The enterprise-context-service.js must be injected first via popup
window.EnterpriseContextService.detect()
```

Expected output format:
```json
{
  "application": "Jira",
  "module": "Backlog",
  "workspace": "PROJ",
  "pageType": "list",
  "navigationHierarchy": ["Projects", "PROJ", "Backlog"],
  "confidence": 0.85,
  "detectedAt": 1750000000000
}
```

| App | URL Pattern | Expected application | Expected pageType | Actual application | Actual pageType | Confidence | Pass? |
|---|---|---|---|---|---|---|---|
| SAP Fiori | *.sap.com | SAP | form / list | — | — | — | — |
| Salesforce | *.salesforce.com | Salesforce | list / detail | — | — | — | — |
| ServiceNow | *.service-now.com | ServiceNow | list / form | — | — | — | — |
| Jira | *.atlassian.net | Jira | list / detail | — | — | — | — |
| Confluence | *.atlassian.net/wiki | Confluence | editor / detail | — | — | — | — |
| Azure DevOps | dev.azure.com | Azure DevOps | list / detail | — | — | — | — |
| Microsoft 365 | office.com / teams.microsoft.com | Microsoft 365 | dashboard / editor | — | — | — | — |
| Workday | *.workday.com | Workday | form / list | — | — | — | — |
| Oracle Cloud | *.oraclecloud.com | Oracle Cloud | form / dashboard | — | — | — | — |

---

## Test Cases

### SAP Fiori

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a purchase order | 4–6 | — | — | — | — | — | |
| 2 | Navigate to inventory management | 2–3 | — | — | — | — | — | |
| 3 | Open the user profile settings | 2–3 | — | — | — | — | — | |

---

### Salesforce

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a new contact | 3–5 | — | — | — | — | — | |
| 2 | Find an open opportunity and log a call | 4–6 | — | — | — | — | — | |
| 3 | Change the pipeline stage of a deal | 2–4 | — | — | — | — | — | |

---

### ServiceNow

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a new incident ticket | 4–6 | — | — | — | — | — | |
| 2 | Assign an open ticket to a team | 3–4 | — | — | — | — | — | |
| 3 | Close a resolved incident | 3–5 | — | — | — | — | — | |

---

### Jira

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a new bug issue | 3–5 | — | — | — | — | — | |
| 2 | Move an issue to In Progress | 2–3 | — | — | — | — | — | |
| 3 | Add a label to an existing issue | 3–4 | — | — | — | — | — | |
| 4 | Create a sprint and add issues | 5–7 | — | — | — | — | — | |

---

### Confluence

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a new page in a space | 3–4 | — | — | — | — | — | |
| 2 | Add a comment to a page | 2–3 | — | — | — | — | — | |
| 3 | Share a page with a team | 3–5 | — | — | — | — | — | |

---

### Azure DevOps

| # | Goal | Expected Steps | Plan Generated? | Plan Success Rate | Recovery Used? | Gemini Calls | Completed? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Create a new work item | 3–5 | — | — | — | — | — | |
| 2 | Move a task to In Review | 2–3 | — | — | — | — | — | |
| 3 | Create a new pull request | 4–6 | — | — | — | — | — | |

---

## KPI Summary

Fill in from Analytics popup after running all test cases.

### Navigation Accuracy

| App | Tasks Run | Completed | Plan Success Rate | Avg Gemini / Task | Recovery Rate |
|---|---|---|---|---|---|
| SAP | — | — | — | — | — |
| Salesforce | — | — | — | — | — |
| ServiceNow | — | — | — | — | — |
| Jira | — | — | — | — | — |
| Confluence | — | — | — | — | — |
| Azure DevOps | — | — | — | — | — |

### Memory / Predictive Navigation

| App | First Run Gemini Calls | Second Run Gemini Calls | Memory Hit? | Gemini Saved |
|---|---|---|---|---|
| Jira (Create issue) | — | — | — | — |
| Salesforce (Create contact) | — | — | — | — |
| ServiceNow (Create incident) | — | — | — | — |

---

## Expected Outcomes

| Metric | Target | Notes |
|---|---|---|
| Enterprise detection rate | ≥ 60% on known enterprise apps | Confidence ≥ 0.5 |
| Plan success rate (enterprise) | ≥ 50% | Enterprise UIs have complex DOM |
| Gemini avoidance rate | ≥ 40% | Via plan steps + memory |
| Memory hit rate | ≥ 30% (after 10+ tasks) | Requires 2+ completions per workflow |
| Recovery success rate | ≥ 50% | Alternatives + semantic search |
| Task completion rate | ≥ 60% | Enterprise UIs are harder than consumer |

---

## Failure Analysis

For each plan step failure (`[Plan] Step N not found` in DevTools console):

| App | Step Description | Expected Element | Actual DOM State | Root Cause |
|---|---|---|---|---|
| | | | | |

### Common Enterprise Failure Patterns

- [ ] Dynamic component IDs: element text changes between page loads (Salesforce, ServiceNow)
- [ ] iFrame-embedded content: DOM matching cannot find elements inside iframes
- [ ] Virtual scroll: target element not in DOM until scrolled into view
- [ ] Modal/dialog layering: plan step targets element behind a modal
- [ ] Conditional fields: element only appears after a prior field is filled
- [ ] Session-specific text: element label includes user name or date

---

## Raw Data Export

```jsonc
// Run in background service worker DevTools console:
// chrome.storage.local.get('screenpilot_analytics', d => console.log(JSON.stringify(d, null, 2)))

// Run to check memory:
// chrome.storage.local.get('screenpilot_memory', d => console.log(JSON.stringify(d, null, 2)))
```

---

## Decision Thresholds

After filling in this report:

**Enterprise detection:**
- [ ] ≥ 70% correct on known apps → detection is reliable, keep current registry
- [ ] 40–70% → review body token lists for false negatives
- [ ] < 40% → body snippet is too small or tokens too generic

**Memory navigation:**
- [ ] Memory hit on 2nd run of same goal → memory service working correctly
- [ ] Memory hit but plan steps fail DOM match → element text too volatile, lower confidence threshold
- [ ] No memory hit after 3+ completions → normalization too strict, review `_normalizeGoal()`

**Rate limiter:**
- [ ] Never blocked during normal use → PER_MIN_LIMIT (20) appropriate
- [ ] Frequently blocked → raise limit or investigate runaway reanalysis loop
