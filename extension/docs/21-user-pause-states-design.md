# User Pause States — Design Decision

**Status:** Pending UX decision before state machine changes.
**Depends on:** `/api/plan` PlanResponse (`result`, `state` fields)
**Affects:** `shared/state-machine/transitions.js`, orchestrator (Phase 3)

---

## Context

The planner can return three distinct situations that are not plan execution, but also not failure:

1. The goal is **blocked** — something external must change before the extension can act.
2. The path is **ambiguous** — the extension could proceed multiple ways and needs the user to choose.
3. An action is **destructive** — the extension has a clear path but needs explicit consent before proceeding.

The current state machine (`transitions.js`) has no transitions for any of these cases. PLANNING goes to EXECUTING or ERROR — nothing in between. This document defines each concept precisely so the UX decision can be made before the state machine is changed.

---

## Concept 1: BLOCKED

### What it means

The planner determined that a **structural prerequisite** is not met in the current environment — something the extension cannot resolve by taking UI actions. Examples:

- User is not signed in (`"You need to log in to access settings"`)
- User lacks the required permission tier (`"This feature requires a Pro account"`)
- The target resource does not exist or is inaccessible (`"This repository is private"`)
- Required upstream step exists outside the current application (`"Create a Jira project first"`)

Blocked is fundamentally different from "hard navigation step" — it is not a UI element that is hard to find. It is a gate that the extension has no mechanism to open.

### When it occurs

Gemini returns `state: "blocked"` when the screenshot shows an access denial, login wall, upsell screen, or when the goal requires context the current page cannot provide.

### UI recommendation

- Show the blocker text directly in the widget (e.g. `"You need to log in to GitHub to continue"`).
- Do **not** highlight any element and do **not** show a step list.
- Show a single "Got it" or "Restart" button that returns to the goal input.
- No auto-advance. The user must resolve the blocker in the browser, then re-submit.

### What resumes execution

Nothing resumes automatically. The user resolves the blocker externally (logs in, upgrades, requests access), then submits the same goal again from the widget. The new submission goes through PLANNING again from scratch.

### Workflow disposition

**Terminate.** The current plan is discarded. There is no execution to resume. The workflow restarts from IDLE after the user acts.

---

## Concept 2: WAITING_FOR_USER (ambiguous path)

### What it means

The planner determined that **multiple valid execution paths exist** and it cannot safely choose one without input from the user. Examples:

- `"Upload a file"` — there are three upload buttons on screen: "Upload to project", "Upload to messages", "Upload to notes".
- `"Create a new item"` — the app has both "New Task" and "New Document" visible.
- `"Go to settings"` — ambiguous between personal settings and workspace settings.

This is **not** a failure. A plan exists for each path; the extension simply does not know which one the user intends.

### When it occurs

Gemini returns `result: "NEEDS_USER", state: "ambiguous"`. The planner may optionally include multiple plan variants in `extensions.ambiguous_options[]` (a future addition; not currently in the schema).

### UI recommendation

- Show the ambiguity clearly: `"I found multiple ways to do this — which did you mean?"`.
- List the options as **selectable buttons** in the widget, one per path (e.g. `"Upload to project"`, `"Upload to messages"`).
- Do not highlight any element until the user selects an option.
- After selection, re-call `/api/plan` with the user's clarification appended to `goal`.

### What resumes execution

The user taps an option in the widget → the extension re-calls the planner with a refined goal → if the result is `planned`, emit `PLAN_RECEIVED` → EXECUTING.

### Workflow disposition

**Pause.** Execution has not started. The task is in a waiting state between PLANNING and EXECUTING. The workflow continues once a choice is made, without returning to IDLE.

---

## Concept 3: NEEDS_CONFIRMATION (destructive action)

### What it means

The plan is unambiguous and the path is clear, but the **next action is irreversible** (a step with `reversible: false`). Examples:

- `"Delete this branch"` — one clear target, but permanently destructive.
- `"Send this email"` — irreversible after the button is clicked.
- `"Publish this post"` — publicly visible; hard to undo.

The distinction from WAITING_FOR_USER: here the extension knows exactly what to do. It just needs the user to explicitly confirm before acting.

### When it occurs

This is an **executor-level concern**, not a planner-level one. The planner sets `step.reversible = false` on individual steps. The orchestrator (Phase 3) detects this when advancing to that step and pauses before highlighting the element.

Note: the current `PlanResponse.result === "NEEDS_USER"` with `state === "planned"` maps to this case when the entire plan has a destructive first step. But this also arises mid-plan for step N where N > 1 and prior steps were already executed.

### UI recommendation

- Highlight the destructive element in amber/red instead of the normal blue ring.
- Show an explicit confirmation panel in the widget: `"This will permanently delete 'feature/auth'. Are you sure?"`.
- Show `"Confirm"` and `"Cancel"` buttons — **not** just the highlighted element.
- Do **not** allow clicking the highlighted element directly to proceed; require the in-widget confirm button.

### What resumes execution

User clicks **Confirm** in the widget → orchestrator emits `ELEMENT_READY` (or equivalent) and the executor proceeds.
User clicks **Cancel** → orchestrator emits `CANCEL_CLICKED` → IDLE. Steps already completed are not undone.

### Workflow disposition

**Pause at the step level.** Prior steps have already executed. Execution resumes from the destructive step after confirmation, not from the beginning.

---

## Comparison table

| | BLOCKED | WAITING_FOR_USER | NEEDS_CONFIRMATION |
|---|---|---|---|
| **Origin** | Planner (structural gate) | Planner (ambiguous goal) | Executor (irreversible step) |
| **Plan exists?** | No | No (or multiple) | Yes |
| **UI action** | Show message + Restart | Show choices | Show warning + Confirm/Cancel |
| **Highlights element?** | No | No | Yes (in amber/red) |
| **Resumes via** | Re-submit goal | User selects option | In-widget Confirm button |
| **State machine level** | PLANNING → ? | PLANNING → ? | EXECUTING → ? |
| **Workflow disposition** | Terminate | Pause (pre-execution) | Pause (mid-execution) |

---

## Decision required

Before any state machine changes are made, the following must be decided:

**Q1.** Should BLOCKED transition to IDLE immediately, or to a dedicated BLOCKED state that persists until dismissed? (Affects whether the goal is cleared or retained.)

**Q2.** Should WAITING_FOR_USER be a state between PLANNING and EXECUTING, or should it re-enter PLANNING with the refined goal? (A re-plan is simpler but makes a second API call; a new state avoids the round-trip.)

**Q3.** Should NEEDS_CONFIRMATION be handled by the state machine (a new `AWAITING_CONFIRMATION` state between EXECUTING and AWAITING_USER), or by the executor in-band before emitting `ELEMENT_READY`? (In-band is simpler but conflates execution and consent; a new state is more auditable.)

**Q4.** Should WAITING_FOR_USER and NEEDS_CONFIRMATION share one state (`AWAITING_USER` already exists) or be distinct states? They have different UI and different resume paths.
