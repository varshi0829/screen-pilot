# Goal Verification & Early Termination Specification

## 1. Overview
`GoalVerifier` provides side-effect-free, site-agnostic evaluation of goal completion criteria.

---

## 2. Goal Completion Contracts
When a goal is initialized, a `GoalCompletionCriteria` contract is established:

```json
{
  "goalType": "action",
  "match": "all",
  "requiresEffect": true,
  "successSignals": [
    { "type": "url_matches", "urlPattern": "/dashboard" },
    { "type": "text_present", "text": "Welcome" }
  ]
}
```

---

## 3. Supported Signal Predicates
- `url_matches`: URL contains substring `urlPattern`.
- `url_leaves`: URL no longer contains `urlPattern`.
- `text_present`: Visible inner text contains `text`.
- `element_present`: Accessible DOM element exists with label `text`.
- `element_absent`: Accessible DOM element no longer exists.

---

## 4. Pre-Planner Early Termination Gate
Before dispatching a planning call, `GoalVerifier.shouldComplete(criteria)` evaluates the live page. If all success signals are satisfied, ScreenPilot completes the task immediately without issuing an unnecessary LLM request.
