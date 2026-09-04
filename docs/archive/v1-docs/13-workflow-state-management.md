# 13. Workflow State Management

## 13.1 State Structure

```javascript
// Workflow state object
{
  "workflowId": "uuid-v4",
  "goal": "Create a GitHub issue about login bug",
  "startTime": 1700000000000,
  "currentStep": 2,
  "steps": [
    {
      "step": 1,
      "action": "Click Issues tab",
      "targetText": "Issues",
      "element": null,  // DOM reference not serializable
      "status": "complete",
      "timestamp": 1700000001000
    },
    {
      "step": 2,
      "action": "Click New Issue button",
      "targetText": "New issue",
      "element": null,
      "status": "pending",
      "timestamp": null
    }
  ],
  "complete": false,
  "aborted": false
}
```

## 13.2 State Transitions

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   IDLE     │────▶│  ACTIVE    │────▶│ COMPLETE  │
│            │     │           │     │           │
│ No active  │     │ In middle  │     │ Goal      │
│ workflow  │     │ of workflow│     │ achieved  │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                   │                   │
       │                   │                   │
       └───────────────────┴───────────────────┘
                    ABORTED
                    (user cancel or error)
```

## 13.3 Persistence Strategy

| Storage | Use Case | Duration |
|--------|--------|----------|
| `chrome.storage.session` | Current workflow state | Until tab closes |
| `chrome.storage.local` | User preferences | Until cleared |
| Memory (JS variable) | Active workflow | Until page unload |